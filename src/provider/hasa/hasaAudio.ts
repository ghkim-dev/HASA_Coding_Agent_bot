/**
 * Speech to text.
 *
 * `POST /v1/audio/transcriptions`, multipart, the OpenAI shape. Like the media
 * endpoints in `hasaMedia.ts` it is absent from the published `/docs`, so it was
 * found by probing and then confirmed against the live service — a route that
 * answers 200 with the expected body is not an invented one.
 *
 * This is how the agent listens. A chat model cannot hear, so an attached
 * recording becomes a transcript here and is inlined like any other text; every
 * model on the key can then read it, not only the one that could transcribe.
 *
 * One thing worth knowing before reading the error handling: this deployment
 * normalises audio with ffmpeg, and on 2026-08-03 it did not have ffmpeg. A
 * 16 kHz mono WAV goes straight through; everything else — mp3, m4a, mp4, webm
 * — comes back `503 stt_ffmpeg_required`. That is an operator's problem, not a
 * user's, and it is reported as one for the same reason
 * `server_tool_calling_disabled` is: a deployment flag misread as a missing
 * feature is a bug nobody goes and fixes.
 */

export class TranscriptionUnavailable extends Error {
  readonly reason: "too_large" | "unsupported_format" | "needs_ffmpeg" | "forbidden" | "failed";
  /** Shown to the user, in their language. */
  readonly userMessage: string;
  /** True when a gateway operator, not the user, is the one who can fix it. */
  readonly operatorAction: boolean;

  constructor(
    reason: TranscriptionUnavailable["reason"],
    userMessage: string,
    opts: { operatorAction?: boolean; detail?: string } = {},
  ) {
    super(opts.detail ?? userMessage);
    this.name = "TranscriptionUnavailable";
    this.reason = reason;
    this.userMessage = userMessage;
    this.operatorAction = opts.operatorAction ?? false;
  }
}

export interface TranscriptionResult {
  text: string;
  /** Duration, when the gateway reported it. */
  seconds: number | null;
}

export interface AudioTransport {
  /** POSTs multipart form data and returns parsed JSON, with the status. */
  postForm: (path: string, form: FormData, signal?: AbortSignal) => Promise<{ status: number; body: unknown }>;
}

/**
 * Formats the gateway accepts without normalising first.
 *
 * WAV only, and not because WAV is special: it is the one container the service
 * can read when ffmpeg is missing. Kept as data rather than as a comment
 * because the check below reads better as a list than as a special case, and
 * because the list grows the moment the deployment is fixed.
 */
const NO_CONVERSION_NEEDED: ReadonlySet<string> = new Set(["wav"]);

/** Every container worth offering in a file picker, once the gateway can convert. */
export const AUDIO_EXTENSIONS: readonly string[] = [
  "wav",
  "mp3",
  "m4a",
  "flac",
  "ogg",
  "opus",
  "aac",
  "webm",
];

export function isAudioFile(name: string): boolean {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  return AUDIO_EXTENSIONS.includes(extension);
}

export function needsConversion(name: string): boolean {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  return !NO_CONVERSION_NEEDED.has(extension);
}

/** The gateway's own ceiling, echoed in every response as `gitc_stt.max_file_mb`. */
export const DEFAULT_MAX_AUDIO_MB = 25;

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Reads the gateway's refusal closely enough to say who can fix it.
 *
 * The distinction that matters is `stt_ffmpeg_required`. It arrives as a 503,
 * which reads as "try again later", and trying again later will fail in exactly
 * the same way until somebody installs a binary on the server.
 */
function refusalFor(status: number, body: unknown, name: string, sizeMb: number): TranscriptionUnavailable {
  const detail = (body as { detail?: unknown } | null)?.detail;
  const error = typeof detail === "object" && detail !== null ? (detail as { error?: unknown }).error : null;

  if (error === "stt_ffmpeg_required") {
    return new TranscriptionUnavailable(
      "needs_ffmpeg",
      `${name} 은(는) 게이트웨이가 변환하지 못했습니다. 이 서버에 ffmpeg가 설치되어 있지 않아 ` +
        "16kHz mono WAV 외의 형식은 처리할 수 없습니다. WAV로 변환해 다시 첨부하시거나, " +
        "게이트웨이 운영자에게 ffmpeg 설치를 요청해 주세요.",
      { operatorAction: true, detail: "gateway reported stt_ffmpeg_required" },
    );
  }
  if (status === 403) {
    return new TranscriptionUnavailable(
      "forbidden",
      "이 API Key에는 음성 인식 모델 권한이 없습니다.",
      { detail: `403 for ${name}` },
    );
  }
  if (status === 413) {
    return new TranscriptionUnavailable(
      "too_large",
      `${name} 이(가) 너무 큽니다 (${sizeMb.toFixed(1)}MB). 최대 ${DEFAULT_MAX_AUDIO_MB}MB 입니다.`,
    );
  }
  return new TranscriptionUnavailable(
    "failed",
    `${name} 을(를) 전사하지 못했습니다 (HTTP ${status}).`,
    { detail: JSON.stringify(body).slice(0, 300) },
  );
}

export interface TranscribeRequest {
  model: string;
  name: string;
  bytes: Uint8Array;
  /** BCP-47-ish hint. Omitted lets the model detect. */
  language?: string;
  maxBytes?: number;
}

/** Transcribes one recording, or explains why it could not. */
export async function transcribeAudio(
  transport: AudioTransport,
  request: TranscribeRequest,
  signal?: AbortSignal,
): Promise<TranscriptionResult> {
  const limit = request.maxBytes ?? DEFAULT_MAX_AUDIO_MB * 1024 * 1024;
  const sizeMb = request.bytes.byteLength / 1024 / 1024;
  if (request.bytes.byteLength > limit) {
    // Refused here rather than uploaded and refused there: the upload is the
    // expensive part and the answer is already known.
    throw new TranscriptionUnavailable(
      "too_large",
      `${request.name} 이(가) 너무 큽니다 (${sizeMb.toFixed(1)}MB). 최대 ${Math.round(limit / 1024 / 1024)}MB 입니다.`,
    );
  }

  const form = new FormData();
  form.append("file", new Blob([request.bytes]), request.name);
  form.append("model", request.model);
  if (request.language !== undefined) form.append("language", request.language);

  const { status, body } = await transport.postForm("/v1/audio/transcriptions", form, signal);
  if (status < 200 || status >= 300) throw refusalFor(status, body, request.name, sizeMb);

  const payload = (body ?? {}) as Record<string, unknown>;
  const text = typeof payload["text"] === "string" ? payload["text"].trim() : "";
  if (text.length === 0) {
    // A 200 with nothing in it. Silence, or speech the model could not make out;
    // either way the user must not be told their file was read.
    throw new TranscriptionUnavailable(
      "failed",
      `${request.name} 에서 말소리를 찾지 못했습니다. 무음이거나 인식하지 못한 녹음입니다.`,
    );
  }

  const stt = payload["gitc_stt"];
  const seconds =
    typeof stt === "object" && stt !== null
      ? readNumber((stt as Record<string, unknown>)["duration_sec"])
      : null;
  return { text, seconds };
}
