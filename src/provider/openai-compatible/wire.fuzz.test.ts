import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ChatCompletionChunk } from "../../protocol/index.ts";
import { forEachSeed, forEachSeedAsync, fuzzIterations, type Rng } from "../../testing/fuzz.ts";
import type { ProviderChatRequest, ProviderMessage, ProviderStreamEvent } from "../types.ts";
import { collectStream, normalizeToolCall, streamEvents, toWireRequest } from "./wire.ts";

/**
 * Properties of the wire layer, checked over generated input.
 *
 * The value of this file is not that it covers more cases than
 * `wire.edge.test.ts` — it is that the cases were not chosen by the person who
 * wrote the code. Two of the three bugs the edge tests found were shapes nobody
 * had thought to write down; these properties are the net for the next one.
 */

interface ToolSpec {
  index: number;
  id: string;
  name: string;
  args: string;
  /** Reproduces a gateway that never commits to a name. */
  nameless: boolean;
}

interface StreamSpec {
  text: string;
  reasoning: string;
  tools: ToolSpec[];
  finishReason: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

type Fragment = NonNullable<ChatCompletionChunk["choices"][number]["delta"]["tool_calls"]>[number];

/** One unit of stream output, before it is grouped into chunks. */
type Op = { kind: "text"; value: string } | { kind: "reasoning"; value: string } | { kind: "tool"; fragment: Fragment };

function splitRandomly(rng: Rng, value: string, maxPieces: number): string[] {
  if (value.length === 0) return [];
  const pieces = rng.int(1, Math.max(1, Math.min(maxPieces, value.length)));
  const cuts = new Set<number>();
  for (let i = 0; i < pieces - 1; i += 1) cuts.add(rng.int(1, value.length - 1));
  const sorted = [...cuts].sort((a, b) => a - b);
  const out: string[] = [];
  let start = 0;
  for (const cut of sorted) {
    out.push(value.slice(start, cut));
    start = cut;
  }
  out.push(value.slice(start));
  return out.filter((p) => p.length > 0);
}

function generateSpec(rng: Rng): StreamSpec {
  const toolCount = rng.int(0, 4);
  const usedIndexes = rng.shuffle(Array.from({ length: 8 }, (_, i) => i)).slice(0, toolCount);
  return {
    text: rng.bool(0.7) ? rng.string(60) : "",
    reasoning: rng.bool(0.3) ? rng.string(30) : "",
    tools: usedIndexes.map((index) => ({
      index,
      id: rng.bool(0.85) ? `call_${index}_${rng.int(0, 999)}` : "",
      name: `tool_${rng.int(0, 20)}`,
      args: rng.pick(["", "{}", '{"a":1}', `{"s":${JSON.stringify(rng.string(20))}}`, '{"trunc":']),
      nameless: rng.bool(0.1),
    })),
    finishReason: rng.pick(["stop", "tool_calls", "length", null, "content_filter", "weird_new_reason"]),
    usage: rng.bool(0.5) ? { prompt_tokens: rng.int(0, 999), total_tokens: rng.int(0, 999) } : null,
  };
}

/** Turns a spec into a chunk stream, splitting and interleaving at random. */
function encode(rng: Rng, spec: StreamSpec): ChatCompletionChunk[] {
  const queues: Op[][] = [];

  // One queue per channel, not one per piece: a gateway interleaves *channels*
  // freely but never reorders a channel's own bytes.
  const textPieces = splitRandomly(rng, spec.text, 6);
  if (textPieces.length > 0) {
    queues.push(textPieces.map((value) => ({ kind: "text", value })));
  }
  const reasoningPieces = splitRandomly(rng, spec.reasoning, 3);
  if (reasoningPieces.length > 0) {
    queues.push(reasoningPieces.map((value) => ({ kind: "reasoning", value })));
  }

  for (const tool of spec.tools) {
    const fragments: Fragment[] = [];
    const argPieces = splitRandomly(rng, tool.args, 4);

    // Sometimes the identifying fragment leads, sometimes argument bytes arrive
    // before the gateway has committed to a name. Both have been observed.
    const metaFirst = rng.bool(0.75);
    const meta: Fragment = { index: tool.index };
    if (tool.id.length > 0) meta.id = tool.id;
    if (!tool.nameless) meta.function = { name: tool.name };

    if (metaFirst) fragments.push(meta);
    for (const piece of argPieces) fragments.push({ index: tool.index, function: { arguments: piece } });
    if (!metaFirst) fragments.splice(rng.int(0, fragments.length), 0, meta);

    queues.push(fragments.map((fragment) => ({ kind: "tool", fragment })));
  }

  // Drain the queues in a random order while preserving order within each: the
  // gateway may interleave two tool calls, but never reorders one call's own
  // fragments.
  const ops: Op[] = [];
  const live = queues.filter((q) => q.length > 0);
  while (live.length > 0) {
    const which = rng.int(0, live.length - 1);
    const queue = live[which] as Op[];
    ops.push(queue.shift() as Op);
    if (queue.length === 0) live.splice(which, 1);
  }

  const chunks: ChatCompletionChunk[] = [];
  let i = 0;
  while (i < ops.length) {
    const delta: ChatCompletionChunk["choices"][number]["delta"] = {};
    const fragments: Fragment[] = [];
    let taken = 0;
    const want = rng.int(1, 3);
    while (i < ops.length && taken < want) {
      const op = ops[i] as Op;
      if (op.kind === "text") {
        if (delta.content !== undefined) break;
        delta.content = op.value;
      } else if (op.kind === "reasoning") {
        if (delta.reasoning_content !== undefined) break;
        delta.reasoning_content = op.value;
      } else {
        fragments.push(op.fragment);
      }
      i += 1;
      taken += 1;
    }
    if (fragments.length > 0) delta.tool_calls = fragments;
    chunks.push({ choices: [{ index: 0, delta, finish_reason: null }] });

    // Gateways emit keepalives and role-only frames. They must change nothing.
    if (rng.bool(0.15)) chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: null }] });
    if (rng.bool(0.1)) chunks.push({ choices: [] });
  }

  const last: ChatCompletionChunk = {
    choices: [{ index: 0, delta: {}, finish_reason: spec.finishReason }],
  };
  if (spec.usage !== null) last.usage = spec.usage;
  chunks.push(last);
  return chunks;
}

async function* iterate(chunks: ChatCompletionChunk[]): AsyncGenerator<ChatCompletionChunk> {
  for (const chunk of chunks) yield chunk;
}

async function drain(chunks: ChatCompletionChunk[]): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = [];
  for await (const event of streamEvents(iterate(chunks))) out.push(event);
  return out;
}

function assertStreamInvariants(spec: StreamSpec, events: ProviderStreamEvent[]): void {
  // 1. Exactly one terminator, and it is last.
  const dones = events.filter((e) => e.type === "done");
  assert.equal(dones.length, 1, "exactly one done event");
  assert.equal(events.at(-1)?.type, "done", "done must be the final event");

  // 2. Text and reasoning are preserved byte for byte.
  const joined = (type: "text" | "reasoning"): string =>
    events
      .filter((e) => e.type === type)
      .map((e) => (e as { delta: string }).delta)
      .join("");
  assert.equal(joined("text"), spec.text, "text deltas must concatenate to the original");
  assert.equal(joined("reasoning"), spec.reasoning, "reasoning deltas must concatenate to the original");

  // 3. Usage, if reported at all, is reported once and immediately before done.
  const usageEvents = events.filter((e) => e.type === "usage");
  assert.ok(usageEvents.length <= 1, "usage is reported at most once");
  if (spec.usage === null) assert.equal(usageEvents.length, 0, "no usage was sent, none may be reported");
  else assert.equal(events.at(-2)?.type, "usage", "usage belongs directly before done");

  // 4. Every tool call opens before it closes, closes once, and closes in order.
  const started = new Map<number, number>();
  const ended = new Map<number, number>();
  const deltasByIndex = new Map<number, string[]>();
  const endOrder: number[] = [];

  events.forEach((event, position) => {
    if (event.type === "tool_call_start") {
      assert.ok(!started.has(event.index), `index ${event.index} opened twice`);
      started.set(event.index, position);
    } else if (event.type === "tool_call_delta") {
      const open = started.get(event.index);
      assert.ok(open !== undefined && open < position, `delta for ${event.index} before its start`);
      assert.ok(!ended.has(event.index), `delta for ${event.index} after its end`);
      deltasByIndex.set(event.index, [...(deltasByIndex.get(event.index) ?? []), event.argumentsDelta]);
    } else if (event.type === "tool_call_end") {
      const open = started.get(event.index);
      assert.ok(open !== undefined && open < position, `end for ${event.index} without a start`);
      assert.ok(!ended.has(event.index), `index ${event.index} closed twice`);
      ended.set(event.index, position);
      endOrder.push(event.index);
    }
  });

  assert.deepEqual(endOrder, [...endOrder].sort((a, b) => a - b), "tool calls close in index order");
  assert.deepEqual(
    [...ended.keys()].sort((a, b) => a - b),
    spec.tools.map((t) => t.index).sort((a, b) => a - b),
    "every tool call in the stream is reported, and no others",
  );

  // 5. The bytes a UI could have rendered add up to the bytes the agent gets.
  //    This is the invariant that caught arguments buffered before a name.
  for (const event of events) {
    if (event.type !== "tool_call_end") continue;
    const spelled = (deltasByIndex.get(event.index) ?? []).join("");
    assert.equal(
      spelled,
      event.toolCall.rawArguments,
      `deltas for index ${event.index} must concatenate to its arguments`,
    );
  }

  // 6. Each call carries what the spec put in it.
  const bySpec = new Map(spec.tools.map((t) => [t.index, t]));
  for (const event of events) {
    if (event.type !== "tool_call_end") continue;
    const source = bySpec.get(event.index);
    assert.ok(source !== undefined);
    assert.equal(event.toolCall.rawArguments, source.args, "arguments survive splitting");
    assert.equal(event.toolCall.name, source.nameless ? "" : source.name);
    assert.equal(event.toolCall.id, source.id.length > 0 ? source.id : `call_${source.index}`);
    assert.ok(event.toolCall.id.length > 0, "every call gets an id, even an invented one");
  }

  // 7. A stream carrying tool calls always finishes as a tool-call turn,
  //    whatever label the gateway attached.
  const done = events.at(-1) as { finishReason: string };
  if (spec.tools.length > 0) assert.equal(done.finishReason, "tool_calls");
}

describe("streamEvents — properties over generated streams", () => {
  test(`holds for ${fuzzIterations()} generated streams`, async () => {
    await forEachSeedAsync(async (rng) => {
      const spec = generateSpec(rng);
      assertStreamInvariants(spec, await drain(encode(rng, spec)));
    });
  });

  test("collectStream agrees with the events it consumed", async () => {
    await forEachSeedAsync(async (rng) => {
      const spec = generateSpec(rng);
      const chunks = encode(rng, spec);
      const events = await drain(chunks);
      const collected = await collectStream(streamEvents(iterate(chunks)), "m");

      assert.equal(collected.text, spec.text);
      assert.equal(collected.reasoning, spec.reasoning);
      assert.equal(collected.toolCalls.length, spec.tools.length);
      assert.deepEqual(
        collected.toolCalls.map((c) => c.rawArguments),
        events
          .filter((e) => e.type === "tool_call_end")
          .map((e) => (e as { toolCall: { rawArguments: string } }).toolCall.rawArguments),
      );
    }, Math.max(1, Math.floor(fuzzIterations() / 2)));
  });
});

describe("normalizeToolCall — properties over generated argument blobs", () => {
  test("never throws, never loses the raw text, always yields an object", () => {
    forEachSeed((rng) => {
      const raw = rng.pick([
        rng.string(40),
        JSON.stringify({ a: rng.int(0, 9), b: rng.string(10) }),
        JSON.stringify([rng.int(0, 9)]),
        JSON.stringify(rng.int(0, 9)),
        JSON.stringify(null),
        `{"unterminated": ${JSON.stringify(rng.string(10))}`,
        " ".repeat(rng.int(0, 5)),
      ]);

      const call = normalizeToolCall(
        { id: rng.bool() ? rng.string(8) : "", type: "function", function: { name: rng.string(8), arguments: raw } },
        rng.int(0, 5),
      );

      assert.equal(call.rawArguments, raw, "raw text is preserved verbatim");
      assert.ok(call.id.length > 0, "an id is always produced");
      assert.ok(
        call.arguments !== null && typeof call.arguments === "object" && !Array.isArray(call.arguments),
        "arguments is always an object a tool can be called with",
      );
      if (call.argumentsValid) {
        // A valid parse must round-trip to the same value.
        assert.deepEqual(call.arguments, JSON.parse(raw.trim().length === 0 ? "{}" : raw));
      }
    });
  });
});

describe("toWireRequest — properties over generated requests", () => {
  function generateMessages(rng: Rng): ProviderMessage[] {
    const count = rng.int(0, 6);
    return Array.from({ length: count }, (): ProviderMessage => {
      switch (rng.int(0, 3)) {
        case 0:
          return { role: "system", content: rng.string(30) };
        case 1:
          return rng.bool(0.7)
            ? { role: "user", content: rng.string(30) }
            : {
                role: "user",
                content: Array.from({ length: rng.int(0, 3) }, () =>
                  rng.bool(0.7)
                    ? ({ type: "text", text: rng.string(15) } as const)
                    : ({ type: "image", url: `data:${rng.string(8)}` } as const),
                ),
              };
        case 2:
          return {
            role: "assistant",
            content: rng.bool(0.5) ? rng.string(20) : null,
            toolCalls: Array.from({ length: rng.int(0, 2) }, (_, i) => ({
              id: `c${i}`,
              name: `t${i}`,
              arguments: {},
              rawArguments: rng.string(20),
              argumentsValid: rng.bool(),
            })),
          };
        default:
          return { role: "tool", toolCallId: rng.string(8), content: rng.string(20) };
      }
    });
  }

  test("emits no undefined values and preserves every message", () => {
    forEachSeed((rng) => {
      const req: ProviderChatRequest = { modelId: rng.string(12), messages: generateMessages(rng) };
      if (rng.bool()) req.temperature = rng.pick([0, 0.2, 1, 2]);
      if (rng.bool()) req.topP = rng.pick([0, 0.5, 1]);
      if (rng.bool()) req.maxOutputTokens = rng.pick([0, 1, 32768]);
      if (rng.bool()) req.seed = rng.pick([0, 42]);
      if (rng.bool()) req.stop = Array.from({ length: rng.int(0, 2) }, () => rng.string(4));
      if (rng.bool(0.4)) {
        req.tools = Array.from({ length: rng.int(0, 3) }, (_, i) => ({
          name: `tool${i}`,
          parameters: { type: "object" },
        }));
      }
      if (rng.bool(0.3)) req.toolChoice = rng.pick(["auto", "none", "required", { name: "tool0" }]);

      const wire = toWireRequest(req, rng.bool());

      // `exactOptionalPropertyTypes` is not on, so an explicit `undefined` would
      // typecheck and then be serialised as `"field": null` by JSON.stringify.
      for (const [key, value] of Object.entries(wire)) {
        assert.notEqual(value, undefined, `${key} was emitted as undefined`);
      }
      assert.equal(wire.model, req.modelId);
      assert.equal(wire.messages.length, req.messages.length);
      req.messages.forEach((message, i) => {
        assert.equal(wire.messages[i]?.role, message.role);
      });
      assert.ok(JSON.stringify(wire).length > 0, "the request must be serialisable");

      // An empty tool list must not reach a gateway that would then demand a
      // tool_choice for a request with no tools.
      if (req.tools !== undefined && req.tools.length === 0) assert.ok(!("tools" in wire));
    });
  });

  test("an assistant tool call round-trips its raw argument text", () => {
    forEachSeed((rng) => {
      const rawArguments = rng.string(40);
      const wire = toWireRequest(
        {
          modelId: "m",
          messages: [
            {
              role: "assistant",
              content: null,
              toolCalls: [{ id: "c", name: "f", arguments: {}, rawArguments, argumentsValid: false }],
            },
          ],
        },
        false,
      );
      assert.equal(wire.messages[0]?.tool_calls?.[0]?.function.arguments, rawArguments);
    });
  });
});
