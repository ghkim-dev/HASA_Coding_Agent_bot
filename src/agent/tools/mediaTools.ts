import { Sandbox } from "../../core/sandbox.ts";
import type { CatalogEntry, VideoSpec } from "../../provider/hasa/hasaCatalog.ts";
import {
  MediaUnavailable,
  estimateSeconds,
  framesFor,
  generateImage,
  generateVideo,
  type MediaTransport,
  type VideoJob,
} from "../../provider/hasa/hasaMedia.ts";
import type { AgentTool, ToolResult } from "../types.ts";

/**
 * Making pictures and video part of the work, not a separate errand.
 *
 * The gateway hosts `Qwen-Image`, `Wan2.x-T2V` and `LTX-2` beside the chat
 * models, and a developer who needs a placeholder icon, a diagram or a demo
 * clip currently leaves the editor to get one. These tools keep them here: the
 * result lands in the workspace as a file, which is the form the rest of the
 * agent already deals in — a file can be committed, referenced from an `<img>`,
 * and undone by the same checkpoint as any other change.
 *
 * Both are `write` risk, so approval happens before anything is generated
 * rather than after the GPU time is spent.
 *
 * The models are not named here. Which model can make an image is read from the
 * gateway's catalogue at run time, so a model added next month works without an
 * extension release — §14, the same rule the chat side follows.
 */

const MAX_PROMPT = 2000;

function str(args: Record<string, unknown>, key: string, fallback = ""): string {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

function num(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface MediaToolOptions {
  sandbox: Sandbox;
  transport: MediaTransport;
  /** Callable image models, from the catalogue. Empty means no image tool. */
  imageModels: CatalogEntry[];
  /** Callable video models, from the catalogue. Empty means no video tool. */
  videoModels: CatalogEntry[];
  /** The gateway's generation limits for a video model. */
  videoSpecFor: (modelId: string) => Promise<VideoSpec | null>;
  /** Where generated files go, relative to the workspace root. */
  outputDir?: string;
  onProgress?: (job: VideoJob) => void;
}

const DEFAULT_OUTPUT_DIR = "assets/generated";

/**
 * Only the tools that can actually work here.
 *
 * A catalogue with no image model means no image tool, for the reason
 * `createShellTools` gives: an offered tool that always refuses costs a turn
 * every time the model reaches for it.
 */
export function createMediaTools(opts: MediaToolOptions): AgentTool[] {
  const tools: AgentTool[] = [];
  if (opts.imageModels.length > 0) tools.push(imageTool(opts));
  if (opts.videoModels.length > 0) tools.push(videoTool(opts));
  return tools;
}

/**
 * Where a generated file ended up, read back out of the tool's own result.
 *
 * The panel needs the path so it can show the picture, and the only channel
 * between a tool and the UI is the result string the model reads. So the format
 * is a contract, and it lives here with the code that writes it rather than as
 * a regex in the extension that nobody would think to update. Getting this
 * wrong does not break the generation — it just silently stops showing it,
 * which is the kind of bug that survives for months.
 */
const SAVED = /^Saved (\S+) \(/;

const MEDIA_EXTENSIONS: Readonly<Record<string, "image" | "video">> = {
  png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image",
  webm: "video", mp4: "video",
};

export interface SavedArtifact {
  path: string;
  kind: "image" | "video";
}

export function parseSavedArtifact(content: string): SavedArtifact | null {
  const path = SAVED.exec(content)?.[1];
  // A path is workspace-relative by construction; anything else is not
  // something to hand to a URI builder.
  if (path === undefined || path.includes("..") || /^([a-zA-Z]:|[/\\])/.test(path)) return null;

  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
  const kind = MEDIA_EXTENSIONS[extension];
  return kind === undefined ? null : { path, kind };
}

/**
 * A filename from the prompt.
 *
 * Named after what was asked for rather than numbered, because a folder of
 * `image_1.png` … `image_7.png` is one nobody can navigate a week later.
 */
export function fileNameFor(prompt: string, extension: string, taken: (name: string) => boolean): string {
  const stem =
    prompt
      .toLowerCase()
      // Keeping Hangul and CJK: a Korean prompt should not produce a file
      // called `untitled`.
      .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "") || "generated";

  let candidate = `${stem}.${extension}`;
  for (let n = 2; taken(candidate); n += 1) candidate = `${stem}-${n}.${extension}`;
  return candidate;
}

function pickModel(requested: string, available: CatalogEntry[]): CatalogEntry | null {
  if (requested.length > 0) return available.find((m) => m.id === requested) ?? null;
  return available[0] ?? null;
}

function imageTool(opts: MediaToolOptions): AgentTool {
  const dir = opts.outputDir ?? DEFAULT_OUTPUT_DIR;
  const ids = opts.imageModels.map((m) => m.id);

  return {
    name: "generate_image",
    risk: "write",
    description:
      `Generate an image from a description and save it into the workspace under ${dir}/. ` +
      `Available models: ${ids.join(", ")}. ` +
      "Use it when the user asks for a picture, icon, illustration, placeholder or mockup. " +
      "Describe the subject in English — these models were trained on English prompts and " +
      "follow them more closely, whatever language the user is speaking. " +
      "The saved path can be referenced from HTML, Markdown or CSS like any other file.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "What to draw. English, concrete, one or two sentences.",
        },
        model: { type: "string", enum: ids, description: "Which image model. Omit for the default." },
        size: { type: "string", description: "WIDTHxHEIGHT, e.g. 1024x1024. Omit for the default." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    summarize: (args) => `이미지를 생성해 ${dir}/ 에 저장합니다: "${str(args, "prompt").slice(0, 60)}"`,

    async execute(args, ctx): Promise<ToolResult> {
      const prompt = str(args, "prompt").trim();
      if (prompt.length === 0) return { ok: false, content: "prompt is required." };
      if (prompt.length > MAX_PROMPT) {
        return { ok: false, content: `prompt is ${prompt.length} characters (limit ${MAX_PROMPT}).` };
      }

      const model = pickModel(str(args, "model"), opts.imageModels);
      if (model === null) {
        return { ok: false, content: `no such image model. Available: ${ids.join(", ")}` };
      }

      const size = str(args, "size");
      try {
        const image = await generateImage(
          opts.transport,
          { model: model.id, prompt, ...(size.length > 0 ? { size } : {}) },
          ctx.signal,
        );

        const existing = new Set<string>();
        const name = fileNameFor(prompt, image.extension, (candidate) => existing.has(candidate));
        let path = `${dir}/${name}`;
        // Checked against the real directory rather than a set, because a file
        // from a previous turn is on disk and not in this process.
        for (let n = 2; await opts.sandbox.exists(path); n += 1) {
          path = `${dir}/${name.replace(/(\.[^.]+)$/, `-${n}$1`)}`;
        }

        await opts.sandbox.writeBytes(path, image.data);
        const kb = Math.round(image.data.length / 1024);
        return {
          ok: true,
          content:
            `Saved ${path} (${kb} KB, ${model.id}` +
            `${image.seconds === null ? "" : `, ${image.seconds}s`}).\n` +
            "Reference it by that path. Do not describe what it looks like — you have not seen it.",
        };
      } catch (err) {
        return { ok: false, content: describeFailure(err) };
      }
    },
  };
}

function videoTool(opts: MediaToolOptions): AgentTool {
  const dir = opts.outputDir ?? DEFAULT_OUTPUT_DIR;
  const ids = opts.videoModels.map((m) => m.id);

  return {
    name: "generate_video",
    risk: "write",
    description:
      `Generate a short video clip from a description. Available models: ${ids.join(", ")}. ` +
      "This takes tens of seconds to minutes of GPU time for a clip of a few seconds, so use it " +
      "only when the user actually asked for video. Describe the scene in English. " +
      "Note that the gateway does not always hand the finished file back over the API; when that " +
      "happens you will be told the job id, and you should pass it on rather than claim failure.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The scene to animate. English, one or two sentences." },
        model: { type: "string", enum: ids, description: "Which video model. Omit for the default." },
        seconds: { type: "number", description: "Clip length in seconds. Kept short unless asked." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    summarize: (args) => {
      const seconds = num(args, "seconds");
      return (
        `동영상을 생성합니다${seconds === null ? "" : ` (${seconds}초)`}: ` +
        `"${str(args, "prompt").slice(0, 50)}" — GPU 시간이 오래 걸립니다`
      );
    },

    async execute(args, ctx): Promise<ToolResult> {
      const prompt = str(args, "prompt").trim();
      if (prompt.length === 0) return { ok: false, content: "prompt is required." };

      const model = pickModel(str(args, "model"), opts.videoModels);
      if (model === null) {
        return { ok: false, content: `no such video model. Available: ${ids.join(", ")}` };
      }

      const spec = await opts.videoSpecFor(model.id);
      const seconds = num(args, "seconds") ?? spec?.defaultSeconds ?? 2;
      const frames = spec === null ? undefined : framesFor(spec, seconds);
      const size = spec?.sizes[0];

      try {
        const result = await generateVideo(opts.transport, {
          model: model.id,
          prompt,
          ...(size === undefined ? {} : { size }),
          ...(frames === undefined ? {} : { length: frames }),
        }, {
          signal: ctx.signal,
          ...(opts.onProgress === undefined ? {} : { onProgress: opts.onProgress }),
        });

        const took = spec !== null && frames !== undefined ? estimateSeconds(spec, frames) : null;

        if (result.artifact === null) {
          // The job really did finish. Saying "failed" here would be a lie the
          // user could check, and they would be right and we would be wrong.
          return {
            ok: false,
            content:
              `The video was generated (job ${result.job.jobId}, ${result.job.seconds ?? "?"}s of footage) ` +
              "but the gateway would not serve the file to an API key, so it could not be saved. " +
              "Tell the user the job id and that the clip is retrievable from the HASA playground in a browser. " +
              "Do not retry — a second attempt costs the same GPU time and hits the same wall.",
          };
        }

        const name = fileNameFor(prompt, result.extension, () => false);
        let path = `${dir}/${name}`;
        for (let n = 2; await opts.sandbox.exists(path); n += 1) {
          path = `${dir}/${name.replace(/(\.[^.]+)$/, `-${n}$1`)}`;
        }
        await opts.sandbox.writeBytes(path, result.artifact);

        const kb = Math.round(result.artifact.length / 1024);
        return {
          ok: true,
          content:
            `Saved ${path} (${kb} KB, ${model.id}` +
            `${took === null ? "" : `, about ${took}s of GPU time`}).`,
        };
      } catch (err) {
        return { ok: false, content: describeFailure(err) };
      }
    },
  };
}

/** A refusal the model can act on, rather than a stack trace. */
function describeFailure(err: unknown): string {
  if (err instanceof MediaUnavailable) {
    if (err.reason === "cancelled") return "the user cancelled this generation.";
    if (err.reason === "failed") return `the gateway could not generate it: ${err.message}. Do not retry blindly.`;
    return err.message;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `generation failed: ${message}`;
}
