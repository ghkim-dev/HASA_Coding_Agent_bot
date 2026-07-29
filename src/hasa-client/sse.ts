import type {
  AssembledStream,
  ChatCompletionChunk,
  ToolCall,
  Usage,
} from "../protocol/chat.ts";
import { HasaError } from "./errors.ts";

export interface SseFrame {
  event: string | null;
  data: string;
}

/**
 * Minimal SSE reader.
 *
 * Written by hand rather than pulled from a library because HASA's exact frame
 * shape is one of the things Phase 0 is measuring — `[DONE]` sentinel, whether
 * `usage` rides on the final chunk, CRLF vs LF. A parser we own reports those
 * differences instead of silently normalising them away.
 */
export async function* iterateSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");

      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const frame = parseFrame(raw);
        if (frame) yield frame;
        sep = buffer.indexOf("\n\n");
      }
    }
    const tail = parseFrame(buffer.replace(/\r\n/g, "\n"));
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
    // Best-effort: a consumer that breaks early should not leak the socket.
    void body.cancel().catch(() => {});
  }
}

function parseFrame(raw: string): SseFrame | null {
  const lines = raw.split("\n");
  const dataLines: string[] = [];
  let event: string | null = null;
  for (const line of lines) {
    if (line === "" || line.startsWith(":")) continue;
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    let val = idx === -1 ? "" : line.slice(idx + 1);
    if (val.startsWith(" ")) val = val.slice(1);
    if (field === "data") dataLines.push(val);
    else if (field === "event") event = val;
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  args: string;
}

/**
 * Collapses a chunk stream into one logical message.
 *
 * Tool-call fragments are keyed by `index`, which is the OpenAI convention;
 * whether HASA follows it is exactly what the `tools_stream` probe checks.
 */
export async function assembleStream(
  chunks: AsyncIterable<ChatCompletionChunk>,
): Promise<AssembledStream> {
  let content = "";
  let reasoningContent = "";
  let finishReason: string | null = null;
  let chunkCount = 0;
  let usage: Usage | null = null;
  const toolAcc = new Map<number, ToolCallAccumulator>();

  for await (const chunk of chunks) {
    chunkCount += 1;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") content += delta.content;
    if (typeof delta.reasoning_content === "string") reasoningContent += delta.reasoning_content;
    for (const frag of delta.tool_calls ?? []) {
      const key = frag.index ?? 0;
      const acc = toolAcc.get(key) ?? { id: "", name: "", args: "" };
      if (frag.id) acc.id = frag.id;
      if (frag.function?.name) acc.name = frag.function.name;
      if (frag.function?.arguments) acc.args += frag.function.arguments;
      toolAcc.set(key, acc);
    }
  }

  const toolCalls: ToolCall[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, acc]) => ({
      id: acc.id || `call_${index}`,
      type: "function",
      function: { name: acc.name, arguments: acc.args },
    }));

  return { content, reasoningContent, toolCalls, finishReason, chunkCount, usage };
}

export function parseChunk(data: string): ChatCompletionChunk | null {
  if (data === "[DONE]") return null;
  try {
    return JSON.parse(data) as ChatCompletionChunk;
  } catch (cause) {
    throw new HasaError({
      message: "malformed SSE chunk (not JSON)",
      kind: "protocol",
      retryable: false,
      terminal: false,
      cause,
    });
  }
}
