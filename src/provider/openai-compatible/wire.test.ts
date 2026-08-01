import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ChatCompletionChunk, ChatCompletionResponse } from "../../protocol/index.ts";
import type { ProviderStreamEvent } from "../types.ts";
import {
  collectStream,
  finishReasonOf,
  fromWireResponse,
  normalizeToolCall,
  streamEvents,
  toWireRequest,
} from "./wire.ts";

async function* iterate(chunks: ChatCompletionChunk[]): AsyncGenerator<ChatCompletionChunk> {
  for (const chunk of chunks) yield chunk;
}

async function drain(chunks: ChatCompletionChunk[]): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = [];
  for await (const event of streamEvents(iterate(chunks))) out.push(event);
  return out;
}

function chunk(delta: ChatCompletionChunk["choices"][number]["delta"], finish: string | null = null): ChatCompletionChunk {
  return { choices: [{ index: 0, delta, finish_reason: finish }] };
}

describe("toWireRequest", () => {
  test("maps the normalised request onto OpenAI field names", () => {
    const wire = toWireRequest(
      {
        modelId: "m/full",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hi" },
        ],
        temperature: 0.2,
        topP: 0.9,
        maxOutputTokens: 512,
        stop: ["END"],
        seed: 7,
      },
      false,
    );

    assert.equal(wire.model, "m/full");
    assert.equal(wire.max_tokens, 512);
    assert.equal(wire.top_p, 0.9);
    assert.equal(wire.temperature, 0.2);
    assert.equal(wire.seed, 7);
    assert.deepEqual(wire.stop, ["END"]);
    assert.equal(wire.stream, false);
  });

  test("omits fields the caller did not set rather than sending undefined", () => {
    const wire = toWireRequest({ modelId: "m", messages: [] }, true);
    assert.deepEqual(Object.keys(wire).sort(), ["messages", "model", "stream"]);
    assert.equal(wire.stream, true);
  });

  test("translates tools and tool choice", () => {
    const wire = toWireRequest(
      {
        modelId: "m",
        messages: [],
        tools: [{ name: "read_file", description: "reads", parameters: { type: "object" } }],
        toolChoice: { name: "read_file" },
      },
      false,
    );
    assert.deepEqual(wire.tools, [
      {
        type: "function",
        function: { name: "read_file", description: "reads", parameters: { type: "object" } },
      },
    ]);
    assert.deepEqual(wire.tool_choice, { type: "function", function: { name: "read_file" } });
  });

  test("an assistant turn replays the model's own argument text byte for byte", () => {
    // Re-serialising `arguments` would normalise whitespace and key order. A
    // gateway that validates its own conversation history rejects that.
    const raw = '{ "path":"src/a.ts",  "line": 1 }';
    const wire = toWireRequest(
      {
        modelId: "m",
        messages: [
          {
            role: "assistant",
            content: null,
            toolCalls: [
              {
                id: "call_1",
                name: "read_file",
                arguments: { path: "src/a.ts", line: 1 },
                rawArguments: raw,
                argumentsValid: true,
              },
            ],
          },
          { role: "tool", toolCallId: "call_1", content: "ok" },
        ],
      },
      false,
    );

    assert.equal(wire.messages[0]?.tool_calls?.[0]?.function.arguments, raw);
    assert.equal(wire.messages[1]?.tool_call_id, "call_1");
    assert.equal(wire.messages[1]?.role, "tool");
  });

  test("image parts become image_url parts", () => {
    const wire = toWireRequest(
      {
        modelId: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what colour?" },
              { type: "image", url: "data:image/png;base64,AAA", detail: "low" },
            ],
          },
        ],
      },
      false,
    );
    assert.deepEqual(wire.messages[0]?.content, [
      { type: "text", text: "what colour?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA", detail: "low" } },
    ]);
  });

  test("json_schema response format keeps its wrapper", () => {
    const wire = toWireRequest(
      {
        modelId: "m",
        messages: [],
        responseFormat: { type: "json_schema", name: "verdict", schema: { type: "object" }, strict: true },
      },
      false,
    );
    assert.deepEqual(wire.response_format, {
      type: "json_schema",
      json_schema: { name: "verdict", schema: { type: "object" }, strict: true },
    });
  });
});

describe("normalizeToolCall", () => {
  test("parses arguments and keeps the raw text", () => {
    const call = normalizeToolCall(
      { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
      0,
    );
    assert.deepEqual(call.arguments, { path: "a.ts" });
    assert.equal(call.rawArguments, '{"path":"a.ts"}');
    assert.equal(call.argumentsValid, true);
  });

  test("malformed arguments are reported, not thrown", () => {
    // The recovery for this is to hand the raw text back to the model, which is
    // impossible if the parse failure became an exception.
    const call = normalizeToolCall(
      { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path": ' } },
      0,
    );
    assert.equal(call.argumentsValid, false);
    assert.deepEqual(call.arguments, {});
    assert.equal(call.rawArguments, '{"path": ');
  });

  test("empty arguments mean an empty object, and that is valid", () => {
    const call = normalizeToolCall({ id: "c", type: "function", function: { name: "finish", arguments: "" } }, 0);
    assert.equal(call.argumentsValid, true);
    assert.deepEqual(call.arguments, {});
  });

  test("a missing id falls back to the index", () => {
    const call = normalizeToolCall({ id: "", type: "function", function: { name: "x", arguments: "{}" } }, 3);
    assert.equal(call.id, "call_3");
  });
});

describe("finishReasonOf", () => {
  test("maps the values gateways actually send", () => {
    assert.equal(finishReasonOf("stop"), "stop");
    assert.equal(finishReasonOf("tool_calls"), "tool_calls");
    assert.equal(finishReasonOf("length"), "length");
    assert.equal(finishReasonOf("content_filter"), "content_filter");
    assert.equal(finishReasonOf(null), "unknown");
    assert.equal(finishReasonOf("something_new"), "unknown");
  });
});

describe("fromWireResponse", () => {
  test("extracts text, reasoning and usage", () => {
    const res: ChatCompletionResponse = {
      model: "m/full",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello", reasoning_content: "thinking" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const out = fromWireResponse(res, "requested");
    assert.equal(out.modelId, "m/full");
    assert.equal(out.text, "hello");
    assert.equal(out.reasoning, "thinking");
    assert.equal(out.finishReason, "stop");
    assert.deepEqual(out.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  test("tool calls win over the gateway's finish_reason", () => {
    // Some gateways return tool calls labelled "stop". The calls are the fact.
    const out = fromWireResponse(
      {
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "c1", type: "function", function: { name: "list_files", arguments: '{"path":"."}' } },
              ],
            },
            finish_reason: "stop",
          },
        ],
      },
      "m",
    );
    assert.equal(out.finishReason, "tool_calls");
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0]?.name, "list_files");
  });

  test("a response with no choices yields an empty answer rather than a crash", () => {
    const out = fromWireResponse({ choices: [] }, "m");
    assert.equal(out.text, "");
    assert.equal(out.finishReason, "unknown");
    assert.equal(out.usage, null);
  });
});

describe("streamEvents", () => {
  test("emits text deltas and exactly one done", async () => {
    const events = await drain([
      chunk({ role: "assistant" }),
      chunk({ content: "he" }),
      chunk({ content: "llo" }),
      chunk({}, "stop"),
    ]);

    assert.deepEqual(
      events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta),
      ["he", "llo"],
    );
    assert.equal(events.filter((e) => e.type === "done").length, 1);
    assert.equal(events.at(-1)?.type, "done");
    assert.deepEqual(events.at(-1), { type: "done", finishReason: "stop" });
  });

  test("a tool call is announced before its arguments finish arriving", async () => {
    const events = await drain([
      chunk({
        tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read_file", arguments: "" } }],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"src/a.ts"}' } }] }),
      chunk({}, "tool_calls"),
    ]);

    const types = events.map((e) => e.type);
    assert.deepEqual(types, ["tool_call_start", "tool_call_delta", "tool_call_delta", "tool_call_end", "done"]);

    const start = events[0] as { name: string; id: string; index: number };
    assert.equal(start.name, "read_file");
    assert.equal(start.id, "c1");

    const end = events[3] as { toolCall: { arguments: unknown; argumentsValid: boolean } };
    assert.deepEqual(end.toolCall.arguments, { path: "src/a.ts" });
    assert.equal(end.toolCall.argumentsValid, true);
  });

  test("parallel tool calls are assembled by index and ended in order", async () => {
    const events = await drain([
      chunk({
        tool_calls: [
          { index: 1, id: "b", type: "function", function: { name: "second", arguments: "" } },
          { index: 0, id: "a", type: "function", function: { name: "first", arguments: "" } },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"n":0}' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: '{"n":1}' } }] }),
      chunk({}, "tool_calls"),
    ]);

    const ends = events.filter((e) => e.type === "tool_call_end") as Array<{
      index: number;
      toolCall: { name: string; arguments: unknown };
    }>;
    assert.deepEqual(ends.map((e) => e.index), [0, 1]);
    assert.deepEqual(ends.map((e) => e.toolCall.name), ["first", "second"]);
    assert.deepEqual(ends.map((e) => e.toolCall.arguments), [{ n: 0 }, { n: 1 }]);
  });

  test("a stream that ends without a finish_reason still reports tool calls", async () => {
    const events = await drain([
      chunk({ tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "x", arguments: "{}" } }] }),
    ]);
    assert.deepEqual(events.at(-1), { type: "done", finishReason: "tool_calls" });
  });

  test("reasoning arrives on its own channel", async () => {
    const events = await drain([chunk({ reasoning_content: "step 1" }), chunk({ content: "answer" }, "stop")]);
    assert.deepEqual(events[0], { type: "reasoning", delta: "step 1" });
    assert.deepEqual(events[1], { type: "text", delta: "answer" });
  });

  test("usage on the final chunk is emitted just before done", async () => {
    const events = await drain([
      chunk({ content: "hi" }),
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
    ]);
    assert.deepEqual(events.at(-2), {
      type: "usage",
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: null },
    });
    assert.equal(events.at(-1)?.type, "done");
  });

  test("empty deltas produce no events", async () => {
    const events = await drain([chunk({ content: "" }), chunk({ reasoning_content: "" }), chunk({}, "stop")]);
    assert.deepEqual(events, [{ type: "done", finishReason: "stop" }]);
  });
});

describe("collectStream", () => {
  test("rebuilds a single response from the event stream", async () => {
    const events = streamEvents(
      iterate([
        chunk({ content: "he" }),
        chunk({ content: "llo" }),
        chunk({ tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "f", arguments: "{}" } }] }),
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { total_tokens: 9 } },
      ]),
    );

    const res = await collectStream(events, "m/full");
    assert.equal(res.text, "hello");
    assert.equal(res.finishReason, "tool_calls");
    assert.equal(res.toolCalls.length, 1);
    assert.equal(res.usage?.totalTokens, 9);
  });
});
