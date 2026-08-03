import type { ProviderContentPart, ProviderUserMessage } from "../provider/types.ts";
import type { Tristate } from "../provider/types.ts";
import { documentKindFor, extractDocument, UnreadableDocument } from "./documents.ts";

/**
 * Files the user attaches to a message.
 *
 * Two kinds, because they reach the model by different routes. Text is inlined
 * into the prompt, which every model can read. An image becomes an `image_url`
 * content part, which only a vision model can, and §14's rule applies: whether
 * this model has vision is measured, never assumed from its name.
 *
 * The rule that shapes everything here is that an attachment must never be
 * silently dropped. A user who attaches a screenshot and gets an answer that
 * ignores it has been misled twice — once by the answer, and once by the
 * interface that accepted the file. So anything that cannot be sent is reported
 * back as a refusal the user can act on, and the message is not sent as though
 * it had never been attached.
 */

export interface TextAttachment {
  kind: "text";
  /** Shown to the model, so it can refer to the file by name. */
  name: string;
  text: string;
}

export interface ImageAttachment {
  kind: "image";
  name: string;
  /** `image/png`, `image/jpeg`, `image/webp`, `image/gif`. */
  mediaType: string;
  base64: string;
}

export type Attachment = TextAttachment | ImageAttachment | AudioAttachment;

export interface AttachmentLimits {
  /** Per text file, after which it is truncated with a visible marker. */
  maxTextChars: number;
  /** Per image. Beyond this the gateway will refuse it anyway. */
  maxImageBytes: number;
  /** Across all attachments on one message. */
  maxTotalChars: number;
}

export const DEFAULT_LIMITS: AttachmentLimits = {
  // Roughly 25k tokens of source, which leaves room for the conversation on a
  // 32k-output model rather than filling the window with one file.
  maxTextChars: 100_000,
  maxImageBytes: 8 * 1024 * 1024,
  maxTotalChars: 200_000,
};

const IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/**
 * Files whose contents are a credential rather than a document.
 *
 * The workspace picker already refuses these — `core/sandbox.ts` forbids them
 * outright. This exists for the other door: "upload from computer" is the user
 * choosing any file on their disk, outside the sandbox entirely, and the
 * easiest mistake to make there is `.env`. Attaching one sends it to the
 * gateway, so it is worth one question first.
 *
 * A warning rather than a refusal. It is their file and they may have a reason;
 * what they must not do is send it without noticing.
 */
const SENSITIVE = [
  /(^|[/\\])\.env(\.|$)/i,
  /(^|[/\\])\.npmrc$/i,
  /(^|[/\\])\.netrc$/i,
  /(^|[/\\])id_[a-z0-9]+$/i,
  /\.(pem|key|pfx|p12|keystore)$/i,
  /(^|[/\\])credentials?(\.|$)/i,
  /(^|[/\\])\.git-credentials$/i,
  /(^|[/\\])\.aws([/\\]|$)/i,
];

export function looksSensitive(path: string): boolean {
  return SENSITIVE.some((pattern) => pattern.test(path));
}

/** Whether a file is worth attaching as an image rather than as text. */
export function isImageType(mediaType: string): boolean {
  return IMAGE_TYPES.has(mediaType.toLowerCase());
}

/** Media type from a file name, or null when it is not an image we can send. */
export function imageTypeFor(name: string): string | null {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  switch (extension) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    default: return null;
  }
}

/**
 * Sound the user attached, with what the gateway made of it.
 *
 * The transcript is the attachment: a chat model cannot hear, so what reaches
 * it is text either way. The file name and duration ride along because "the
 * recording says X" is a claim about a file, and the model should be able to
 * name which one.
 */
export interface AudioAttachment {
  kind: "audio";
  name: string;
  transcript: string;
  /** Seconds, when the gateway reported them. */
  seconds: number | null;
}

export type AttachmentOutcome =
  | { ok: true; attachment: Attachment; note: string }
  | { ok: false; reason: string };

/**
 * What a file becomes when it is attached.
 *
 * Four routes, decided by the bytes rather than by the extension where they
 * disagree: an image goes as an image, a document is extracted to text, sound
 * is transcribed elsewhere and arrives here already text, and everything else
 * is read as text and refused if it turns out not to be.
 *
 * The decision lives here rather than in the extension for the reason the whole
 * `src/` boundary exists — `pnpm test` can reach this, and it cannot reach a
 * VS Code host. See `docs/hasa-coding-agent-architecture.md` §22.
 */
export function attachmentFor(name: string, bytes: Uint8Array): AttachmentOutcome {
  const mediaType = imageTypeFor(name);
  if (mediaType !== null) {
    return {
      ok: true,
      note: `${Math.max(1, Math.round(bytes.byteLength / 1024))} KB`,
      attachment: {
        kind: "image",
        name,
        mediaType,
        base64: Buffer.from(bytes).toString("base64"),
      },
    };
  }

  if (documentKindFor(name) !== null) {
    try {
      const document = extractDocument(name, Buffer.from(bytes));
      const lines = document.text.split("\n").length;
      return {
        ok: true,
        note: document.note === null ? `${lines}줄` : `${lines}줄 · ${document.note}`,
        attachment: { kind: "text", name, text: document.text },
      };
    } catch (err) {
      if (err instanceof UnreadableDocument) return { ok: false, reason: err.userMessage };
      throw err;
    }
  }

  const text = Buffer.from(bytes).toString("utf8");
  // A file full of replacement characters is a binary the model cannot read;
  // inlining it would spend the context window on noise.
  const replacements = (text.match(/�/g) ?? []).length;
  if (replacements > text.length / 100) {
    return { ok: false, reason: `${name} 은(는) 텍스트 파일이 아니라 첨부하지 않았습니다.` };
  }
  return { ok: true, note: `${text.split("\n").length}줄`, attachment: { kind: "text", name, text } };
}

export interface ComposeOptions {
  /** Whether the chosen model was *measured* to accept images. */
  vision?: Tristate;
  limits?: Partial<AttachmentLimits>;
}

export interface ComposedMessage {
  message: ProviderUserMessage;
  /** Attachments that could not be sent, and why. Shown to the user. */
  rejected: Array<{ name: string; reason: string }>;
  /** Attachments that were sent but shortened. */
  truncated: string[];
}

function fence(name: string, text: string): string {
  // A fence long enough not to be closed by the file's own backticks. Without
  // this, a Markdown file containing ``` ends the block early and the rest of
  // it reads as instructions rather than as content.
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const rail = "`".repeat(Math.max(3, longest + 1));
  return `${name}:\n${rail}\n${text}\n${rail}`;
}

/**
 * Builds the user message from what was typed and what was attached.
 *
 * Text goes first and the prompt goes last, so the question the user asked is
 * the most recent thing the model read.
 */
export function composeUserMessage(
  prompt: string,
  attachments: readonly Attachment[],
  opts: ComposeOptions = {},
): ComposedMessage {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const rejected: ComposedMessage["rejected"] = [];
  const truncated: string[] = [];

  const texts: string[] = [];
  const images: ProviderContentPart[] = [];
  let budget = limits.maxTotalChars;

  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      if (opts.vision === false) {
        // Measured as having no vision. Sending the part anyway wastes a request
        // and returns an answer about nothing.
        rejected.push({
          name: attachment.name,
          reason: "이 모델은 이미지를 읽지 못합니다. 비전 모델을 고르거나 ✨ Auto 로 두세요.",
        });
        continue;
      }
      if (!isImageType(attachment.mediaType)) {
        rejected.push({ name: attachment.name, reason: `${attachment.mediaType} 형식은 보낼 수 없습니다.` });
        continue;
      }
      // base64 is 4 characters per 3 bytes.
      const bytes = Math.floor((attachment.base64.length * 3) / 4);
      if (bytes > limits.maxImageBytes) {
        rejected.push({
          name: attachment.name,
          reason: `이미지가 너무 큽니다 (${Math.round(bytes / 1024 / 1024)}MB, 최대 ${Math.round(limits.maxImageBytes / 1024 / 1024)}MB).`,
        });
        continue;
      }
      // `image`, not `image_url`: that spelling is the wire's and belongs in
      // openai-compatible/wire.ts, which is the only file allowed to know it.
      images.push({
        type: "image",
        url: `data:${attachment.mediaType};base64,${attachment.base64}`,
      });
      continue;
    }

    if (budget <= 0) {
      rejected.push({ name: attachment.name, reason: "첨부 용량 한도를 넘어 보내지 못했습니다." });
      continue;
    }

    const cap = Math.min(limits.maxTextChars, budget);
    // Sound arrives as its transcript, labelled so the model does not quote it
    // as if it were a written document. Everything after this point is text and
    // is treated identically, which is the point of transcribing at attach time.
    let text =
      attachment.kind === "audio"
        ? `[음성 전사${attachment.seconds === null ? "" : `, ${Math.round(attachment.seconds)}초`}]\n${attachment.transcript}`
        : attachment.text;
    if (text.length > cap) {
      // Cut with a marker rather than silently: the model must know it is
      // reading part of a file, or it will reason about code that is not there.
      text = `${text.slice(0, cap)}\n…[${attachment.name} truncated at ${cap} of ${text.length} characters]`;
      truncated.push(attachment.name);
    }
    budget -= text.length;
    texts.push(fence(attachment.name, text));
  }

  const body = texts.length === 0 ? prompt : `${texts.join("\n\n")}\n\n${prompt}`;

  // A plain string when there is nothing but text: the array form is valid but
  // more shapes on the wire is more that can go wrong at a gateway.
  if (images.length === 0) {
    return { message: { role: "user", content: body }, rejected, truncated };
  }
  return {
    message: { role: "user", content: [...images, { type: "text", text: body }] },
    rejected,
    truncated,
  };
}

/** One sentence about what was left out, or null when nothing was. */
export function describeAttachmentProblems(result: ComposedMessage): string | null {
  const parts: string[] = [];
  for (const { name, reason } of result.rejected) parts.push(`${name}: ${reason}`);
  if (result.truncated.length > 0) {
    parts.push(`${result.truncated.join(", ")} 은(는) 너무 길어 일부만 보냈습니다.`);
  }
  return parts.length === 0 ? null : parts.join("\n");
}
