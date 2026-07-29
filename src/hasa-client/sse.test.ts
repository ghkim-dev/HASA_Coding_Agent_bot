import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ChatCompletionChunk } from "../protocol/index.ts";
import { assembleStream, iterateSse, parseChunk } from "./sse.ts";
import { HasaError } from "./errors.ts";

function streamOf(text: string, splitEvery = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + splitEvery));
      offset += splitEvery;
    },
  });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe("iterateSse", () => {
  test("splits frames across arbitrary chunk boundaries", async () => {
    const frames = await collect(iterateSse(streamOf('data: {"a":1}\n\ndata: {"a":2}\n\n', 3)));
    assert.deepEqual(
      frames.map((f) => f.data),
      ['{"a":1}', '{"a":2}'],
    );
  });

  test("handles CRLF line endings", async () => {
    const frames = await collect(iterateSse(streamOf("data: one\r\n\r\ndata: two\r\n\r\n")));
    assert.deepEqual(
      frames.map((f) => f.data),
      ["one", "two"],
    );
  });

  test("ignores comments and keeps named events", async () => {
    const frames = await collect(iterateSse(streamOf(": keepalive\n\nevent: ping\ndata: hi\n\n")));
    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.event, "ping");
    assert.equal(frames[0]?.data, "hi");
  });

  test("joins multi-line data fields", async () => {
    const frames = await collect(iterateSse(streamOf("data: a\ndata: b\n\n")));
    assert.equal(frames[0]?.data, "a\nb");
  });

  test("emits a trailing frame that was never terminated", async () => {
    const frames = await collect(iterateSse(streamOf("data: last\n")));
    assert.equal(frames[0]?.data, "last");
  });
});

describe("parseChunk", () => {
  test("[DONE] is a sentinel, not data", () => {
    assert.equal(parseChunk("[DONE]"), null);
  });

  test("malformed JSON becomes a protocol error rather than silent loss", () => {
    assert.throws(() => parseChunk("{not json"), (e: unknown) => e instanceof HasaError && e.kind === "protocol");
  });
});

function chunk(delta: ChatCompletionChunk["choices"][number]["delta"], finish: string | null = null): ChatCompletionChunk {
  return { choices: [{ index: 0, delta, finish_reason: finish }] };
}

describe("assembleStream", () => {
  test("concatenates content and records the finish reason", async () => {
    const asm = await assembleStream(
      (async function* () {
        yield chunk({ role: "assistant" });
        yield chunk({ content: "Hel" });
        yield chunk({ content: "lo" });
        yield chunk({}, "stop");
      })(),
    );
    assert.equal(asm.content, "Hello");
    assert.equal(asm.finishReason, "stop");
    assert.equal(asm.chunkCount, 4);
  });

  test("reassembles tool calls from indexed fragments", async () => {
    const asm = await assembleStream(
      (async function* () {
        yield chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "get_weather", arguments: '{"ci' } }] });
        yield chunk({ tool_calls: [{ index: 0, function: { arguments: 'ty":"Seoul"}' } }] });
        yield chunk({}, "tool_calls");
      })(),
    );
    assert.equal(asm.toolCalls.length, 1);
    assert.equal(asm.toolCalls[0]?.function.name, "get_weather");
    assert.deepEqual(JSON.parse(asm.toolCalls[0]?.function.arguments ?? "{}"), { city: "Seoul" });
  });

  test("keeps parallel tool calls separate and ordered by index", async () => {
    const asm = await assembleStream(
      (async function* () {
        yield chunk({ tool_calls: [{ index: 1, id: "b", function: { name: "second", arguments: "{}" } }] });
        yield chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "first", arguments: "{}" } }] });
      })(),
    );
    assert.deepEqual(
      asm.toolCalls.map((c) => c.function.name),
      ["first", "second"],
    );
  });

  test("captures a usage block delivered on the final chunk", async () => {
    const asm = await assembleStream(
      (async function* () {
        yield chunk({ content: "x" });
        yield { choices: [], usage: { total_tokens: 42 } };
      })(),
    );
    assert.equal(asm.usage?.total_tokens, 42);
  });

  test("separates reasoning_content from the answer", async () => {
    const asm = await assembleStream(
      (async function* () {
        yield chunk({ reasoning_content: "thinking" });
        yield chunk({ content: "answer" });
      })(),
    );
    assert.equal(asm.reasoningContent, "thinking");
    assert.equal(asm.content, "answer");
  });
});
