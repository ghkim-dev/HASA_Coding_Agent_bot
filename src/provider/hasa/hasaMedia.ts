import type { VideoSpec } from "./hasaCatalog.ts";

/**
 * Image and video generation.
 *
 * The endpoints are `POST /v1/images/generations`, `POST /v1/videos/generations`
 * and `GET /v1/jobs/{id}`. None of them appear in the published `/docs`, which
 * lists only chat, embeddings, rerank and agent — so they were read off the
 * gateway's own portal code and then verified against the live service, which
 * is the only reason they are here. §14 of the brief forbids inventing an
 * endpoint, and a route confirmed by a 200 with the expected body is not
 * invented.
 *
 * Images come back inline as base64 and are done in one request. Video is a
 * job: submit, poll until a terminal status, then fetch the artifact — and the
 * last of those three does not currently work for an API key, which
 * `VideoResult.artifact` reports rather than hides.
 *
 * This file is the only place that knows these wire shapes, for the same reason
 * `openai-compatible/wire.ts` is the only place that knows chat's.
 */

export interface MediaTransport {
  postJson: (path: string, body: unknown, signal?: AbortSignal) => Promise<unknown>;
  getJson: (path: string, signal?: AbortSignal) => Promise<unknown>;
  /** Fetches an artifact. Resolves to null when the gateway will not serve it. */
  getBinary: (path: string, signal?: AbortSignal) => Promise<Uint8Array | null>;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export interface ImageRequest {
  model: string;
  prompt: string;
  /** `WIDTHxHEIGHT`. The gateway rejects sizes a model does not support. */
  size?: string;
  steps?: number;
}

export interface ImageResult {
  /** Decoded bytes, ready to write to a file. */
  data: Uint8Array;
  /** From the magic number, not from the request — the gateway picks. */
  extension: "png" | "jpg" | "webp";
  seconds: number | null;
}

const DEFAULT_IMAGE_SIZE = "1024x1024";
const DEFAULT_STEPS = 20;

/** Sniffs the container so the file is written with a name that opens. */
export function imageExtension(bytes: Uint8Array): "png" | "jpg" | "webp" {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "webp";
  }
  // PNG is what this gateway has returned every time; guessing it keeps the
  // file openable when a future model returns something unrecognised.
  return "png";
}

function decodeBase64(text: string): Uint8Array {
  // `atob` is not in every runtime this file targets, and Buffer is not in the
  // webview. Node has both; this picks whichever exists.
  const globalBuffer = (globalThis as { Buffer?: { from(s: string, e: string): Uint8Array } }).Buffer;
  if (globalBuffer !== undefined) return globalBuffer.from(text, "base64");
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export class MediaUnavailable extends Error {
  readonly reason: "no_image" | "no_job" | "failed" | "cancelled" | "artifact_unreachable";
  constructor(reason: MediaUnavailable["reason"], message: string) {
    super(message);
    this.name = "MediaUnavailable";
    this.reason = reason;
  }
}

/** One image, in one request. */
export async function generateImage(
  transport: MediaTransport,
  request: ImageRequest,
  signal?: AbortSignal,
): Promise<ImageResult> {
  const payload = await transport.postJson(
    "/v1/images/generations",
    {
      model: request.model,
      prompt: request.prompt,
      size: request.size ?? DEFAULT_IMAGE_SIZE,
      steps: request.steps ?? DEFAULT_STEPS,
      // Base64 rather than a URL: a URL would be another authenticated fetch
      // against a gateway that does not serve artifacts to API keys, which is
      // exactly the wall the video path hits.
      response_format: "b64_json",
      n: 1,
    },
    signal,
  );

  const body = (payload ?? {}) as Record<string, unknown>;
  // `?? null` matters: an empty `data` array yields undefined, and a bare
  // `!== null` check would let it through to a property read that throws.
  const first = Array.isArray(body["data"])
    ? ((body["data"][0] as Record<string, unknown> | undefined) ?? null)
    : null;
  const b64 = first !== null && typeof first["b64_json"] === "string" ? first["b64_json"] : null;
  if (b64 === null || b64.length === 0) {
    throw new MediaUnavailable("no_image", "the gateway returned no image data");
  }

  const data = decodeBase64(b64);
  const seconds = typeof body["gen_seconds"] === "number" ? body["gen_seconds"] : null;
  return { data, extension: imageExtension(data), seconds };
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

export type JobStatus =
  | "QUEUED"
  | "LOADING"
  | "GENERATING"
  | "DECODING"
  | "ENCODING"
  | "MODERATING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | string;

const TERMINAL: ReadonlySet<string> = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.has(status);
}

export interface VideoJob {
  jobId: string;
  status: JobStatus;
  progress: number;
  artifactUrl: string | null;
  seconds: number | null;
  error: string | null;
}

export interface VideoRequest {
  model: string;
  prompt: string;
  size?: string;
  /** Output length in frames. Use `framesFor` to turn seconds into a legal count. */
  length?: number;
  steps?: number;
}

export interface VideoResult {
  job: VideoJob;
  /**
   * The bytes, when the gateway served them.
   *
   * Null with a completed job is the observed case today: `/files/{name}`
   * answers 200 with `{"detail":"not found"}` for an API key, whether the file
   * exists or not. Reporting that as null rather than throwing lets the caller
   * tell the user their video was made and where it is, instead of claiming the
   * generation failed when it did not.
   */
  artifact: Uint8Array | null;
  extension: string;
}

export function readJob(payload: unknown): VideoJob | null {
  if (payload === null || typeof payload !== "object") return null;
  const raw = payload as Record<string, unknown>;
  const jobId = typeof raw["job_id"] === "string" ? raw["job_id"] : null;
  if (jobId === null || jobId.length === 0) return null;

  return {
    jobId,
    status: typeof raw["status"] === "string" ? raw["status"] : "QUEUED",
    progress: typeof raw["progress"] === "number" ? raw["progress"] : 0,
    artifactUrl: typeof raw["artifact_url"] === "string" ? raw["artifact_url"] : null,
    seconds: typeof raw["seconds"] === "number" ? raw["seconds"] : null,
    error: typeof raw["error"] === "string" ? raw["error"] : null,
  };
}

/**
 * A frame count this model will accept.
 *
 * The gateway rejects counts off its alignment, so seconds are rounded to the
 * nearest legal frame rather than passed through and refused.
 */
export function framesFor(spec: VideoSpec, seconds: number): number {
  const wanted = Math.round(seconds * spec.fps);
  const aligned = Math.max(spec.frameAlign, Math.round(wanted / spec.frameAlign) * spec.frameAlign);
  return Math.min(aligned, spec.maxFrames);
}

/** Roughly how long this will take, for a message rather than for a timeout. */
export function estimateSeconds(spec: VideoSpec, frames: number): number {
  return Math.max(1, Math.round((frames / spec.fps) * spec.genTimePerSecond));
}

export interface VideoOptions {
  pollIntervalMs?: number;
  /** Called on every poll, for a progress bar. */
  onProgress?: (job: VideoJob) => void;
  signal?: AbortSignal;
  /** Injected so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_MS = 2000;

/** Submits a video job and waits for it to finish. */
export async function generateVideo(
  transport: MediaTransport,
  request: VideoRequest,
  opts: VideoOptions = {},
): Promise<VideoResult> {
  const submitted = readJob(
    await transport.postJson(
      "/v1/videos/generations",
      {
        model: request.model,
        prompt: request.prompt,
        ...(request.size === undefined ? {} : { size: request.size }),
        ...(request.length === undefined ? {} : { length: request.length }),
        steps: request.steps ?? DEFAULT_STEPS,
      },
      opts.signal,
    ),
  );
  if (submitted === null) {
    throw new MediaUnavailable("no_job", "the gateway accepted the request but returned no job id");
  }

  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let job = submitted;
  opts.onProgress?.(job);

  while (!isTerminal(job.status)) {
    if (opts.signal?.aborted === true) throw new MediaUnavailable("cancelled", "cancelled");
    await sleep(opts.pollIntervalMs ?? DEFAULT_POLL_MS);
    const polled = readJob(
      await transport.getJson(`/v1/jobs/${encodeURIComponent(job.jobId)}`, opts.signal),
    );
    // A poll that comes back unreadable is a blip, not a verdict; the previous
    // job state stands and the next poll decides.
    if (polled !== null) job = polled;
    opts.onProgress?.(job);
  }

  if (job.status === "FAILED") {
    throw new MediaUnavailable("failed", job.error ?? "the gateway reported the job as failed");
  }
  if (job.status === "CANCELLED") throw new MediaUnavailable("cancelled", "the job was cancelled");

  const extension = job.artifactUrl !== null ? extensionOf(job.artifactUrl) : "webm";
  if (job.artifactUrl === null) return { job, artifact: null, extension };

  const artifact = await transport.getBinary(job.artifactUrl, opts.signal).catch(() => null);
  return { job, artifact, extension };
}

function extensionOf(url: string): string {
  const match = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(url);
  return match?.[1]?.toLowerCase() ?? "webm";
}
