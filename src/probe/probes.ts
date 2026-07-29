import type {
  CapabilityName,
  CapabilityResult,
  ChatCompletionRequest,
  ToolChoice,
  ToolDefinition,
} from "../protocol/index.ts";
import type { HasaClient } from "../hasa-client/client.ts";
import { HasaError } from "../hasa-client/errors.ts";
import type { Logger } from "../hasa-client/logger.ts";
import { evidence } from "../hasa-client/redact.ts";

export interface ProbeLimits {
  observedContextWindow?: number;
  observedMaxOutputTokens?: number;
  latencyMs?: { p50: number; p95: number };
}

export interface ProbeOutcome {
  status: CapabilityResult["status"];
  evidence?: string;
  httpStatus?: number;
  errorCode?: string;
  limits?: ProbeLimits;
}

export interface ProbeContext {
  client: HasaClient;
  log: Logger;
  signal?: AbortSignal;
  /**
   * Per-model scratch space. The tools probe records which `tool_choice` the
   * gateway actually accepted so the dependent tool probes reuse it instead of
   * rediscovering it (or failing on a value this deployment rejects).
   */
  state: Map<string, unknown>;
}

/**
 * vLLM refuses every tool_choice unless it was launched with
 * `--tool-call-parser` / `--enable-auto-tool-choice`. That is a deployment
 * setting, not a property of the model — recording it as a plain capability
 * failure would permanently mislabel models that are perfectly capable.
 */
const SERVER_TOOLING_DISABLED = /(tool-call-parser|enable-auto-tool-choice)/i;

export const SERVER_TOOLING_DISABLED_CODE = "server_tool_calling_disabled";

function isServerToolingDisabled(err: unknown): boolean {
  return (
    err instanceof HasaError &&
    err.status === 400 &&
    SERVER_TOOLING_DISABLED.test(`${err.message} ${err.bodySnippet ?? ""}`)
  );
}

export interface ProbeDefinition {
  name: CapabilityName;
  description: string;
  /** Skipped unless every listed capability already came back `pass`. */
  requires: CapabilityName[];
  /** Only runs with --deep (slow or token-hungry). */
  deep: boolean;
  /** Only runs when explicitly opted in (e.g. --vision). */
  optIn: boolean;
  run(ctx: ProbeContext, modelId: string): Promise<ProbeOutcome>;
}

/**
 * A failed probe is data, not an exception. The only error that stops the whole
 * run is 401 — a bad key makes every subsequent result meaningless, so it is
 * rethrown rather than recorded.
 */
export function outcomeFromError(err: unknown): ProbeOutcome {
  if (err instanceof HasaError) {
    if (err.kind === "auth") throw err;
    const base = {
      httpStatus: err.status ?? undefined,
      errorCode: err.code,
      evidence: evidence(err.bodySnippet ?? err.message),
    };
    if (err.kind === "forbidden") return { status: "denied", ...base };
    if (err.kind === "rate_limit" || err.kind === "unavailable" || err.kind === "timeout" || err.kind === "network" || err.kind === "server") {
      return { status: "unknown", ...base };
    }
    return { status: "fail", ...base };
  }
  return { status: "unknown", evidence: evidence(String(err)) };
}

async function attempt(fn: () => Promise<ProbeOutcome>): Promise<ProbeOutcome> {
  try {
    return await fn();
  } catch (err) {
    return outcomeFromError(err);
  }
}

function baseRequest(modelId: string, prompt: string, maxTokens = 64): ChatCompletionRequest {
  return {
    model: modelId,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    max_tokens: maxTokens,
  };
}

const WEATHER_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current temperature for a city.",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name, e.g. Seoul" },
      },
      required: ["city"],
      additionalProperties: false,
    },
  },
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text?: unknown }).text ?? "") : ""))
      .join("");
  }
  return "";
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Strips ``` fences some models wrap JSON in, so we test intent not packaging. */
function unfence(text: string): string {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return (m?.[1] ?? text).trim();
}

/**
 * Models present the same value in different typography — an en-dash for the
 * minus sign, markdown emphasis, a non-breaking space before the unit. A probe
 * that string-matches the raw answer reports those as capability failures, so
 * presentation is normalised away before comparison.
 */
function normalizeForMatch(text: string): string {
  return text
    .replace(/[‐-―−﹘﹣－]/g, "-") // dash and minus variants
    .replace(/[*_`~]/g, "") // markdown emphasis
    .replace(/[   ]/g, " ") // non-breaking spaces
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Reasoning-style models spend their first tokens on an internal channel and
 * emit nothing visible, so a tight budget returns 200 with empty content and
 * `finish_reason: "length"`. Probing with one small budget would report those
 * models as broken. The ladder distinguishes "cannot answer" from
 * "was not given room to answer".
 */
const CHAT_BUDGET_LADDER = [256, 1024] as const;

const chatProbe: ProbeDefinition = {
  name: "chat",
  description: "Non-streaming chat completion returns usable content",
  requires: [],
  deep: false,
  optIn: false,
  run: (ctx, modelId) =>
    attempt(async () => {
      let lastFinish = "null";
      let lastBudget = 0;
      for (const budget of CHAT_BUDGET_LADDER) {
        const res = await ctx.client.chat(baseRequest(modelId, "Reply with exactly: OK", budget), {
          signal: ctx.signal,
        });
        const choice = res.choices[0];
        const content = textOf(choice?.message?.content);
        lastFinish = choice?.finish_reason ?? "null";
        lastBudget = budget;
        if (content.trim().length > 0) {
          return {
            status: "pass",
            evidence: evidence(
              `content chars=${content.length}, finish_reason=${lastFinish}, max_tokens=${budget}` +
                (budget === CHAT_BUDGET_LADDER[0] ? "" : " (needed a larger budget)"),
            ),
          };
        }
        // Anything other than truncation means more room will not help.
        if (lastFinish !== "length") break;
      }
      return {
        status: "fail",
        evidence: evidence(
          `200 but empty content at max_tokens=${lastBudget} (finish_reason=${lastFinish})`,
        ),
      };
    }),
};

const streamProbe: ProbeDefinition = {
  name: "stream",
  description: "stream:true yields SSE chunks that reassemble into content",
  requires: ["chat"],
  deep: false,
  optIn: false,
  run: (ctx, modelId) =>
    attempt(async () => {
      const asm = await ctx.client.chatStream(
        baseRequest(modelId, "Count from 1 to 5, separated by spaces.", 64),
        { signal: ctx.signal },
      );
      if (asm.chunkCount === 0) return { status: "fail", evidence: "no SSE chunks received" };
      if (asm.content.trim().length === 0) {
        return { status: "fail", evidence: `${asm.chunkCount} chunks but empty content` };
      }
      return {
        status: "pass",
        evidence: evidence(
          `chunks=${asm.chunkCount}, chars=${asm.content.length}, usage=${asm.usage ? "present" : "absent"}`,
        ),
      };
    }),
};

const TOOL_CHOICE_KEY = "toolChoice";

/**
 * Gateways differ in which `tool_choice` values they enable. Trying only
 * `"auto"` would report a model as tool-incapable when the deployment merely
 * restricts the mode, so the ladder walks from least to most coercive and
 * remembers whichever the server accepted.
 */
const TOOL_CHOICE_LADDER: Array<{ label: string; value: ToolChoice }> = [
  { label: "auto", value: "auto" },
  { label: "required", value: "required" },
  { label: "named", value: { type: "function", function: { name: "get_weather" } } },
];

const toolsProbe: ProbeDefinition = {
  name: "tools",
  description: "Native OpenAI tool calling produces a well-formed tool_call",
  requires: ["chat"],
  deep: false,
  optIn: false,
  run: (ctx, modelId) =>
    attempt(async () => {
      const rejections: string[] = [];
      let serverDisabled = false;

      for (const variant of TOOL_CHOICE_LADDER) {
        let res;
        try {
          res = await ctx.client.chat(
            {
              ...baseRequest(modelId, "What is the temperature in Seoul right now? Use the tool.", 256),
              tools: [WEATHER_TOOL],
              tool_choice: variant.value,
            },
            { signal: ctx.signal },
          );
        } catch (err) {
          if (isServerToolingDisabled(err)) {
            serverDisabled = true;
            rejections.push(`${variant.label}=400`);
            continue;
          }
          if (err instanceof HasaError && err.status === 400) {
            rejections.push(`${variant.label}=400`);
            continue;
          }
          throw err;
        }

        const choice = res.choices[0];
        const calls = choice?.message?.tool_calls ?? [];
        if (calls.length === 0) {
          rejections.push(`${variant.label}=no_tool_calls`);
          continue;
        }
        const call = calls[0];
        if (call?.function?.name !== WEATHER_TOOL.function.name) {
          rejections.push(`${variant.label}=wrong_name(${call?.function?.name})`);
          continue;
        }
        if (!isJson(call.function.arguments || "{}")) {
          rejections.push(`${variant.label}=args_not_json`);
          continue;
        }

        ctx.state.set(TOOL_CHOICE_KEY, variant.value);
        return {
          status: "pass",
          evidence: evidence(
            `tool_choice=${variant.label}, finish_reason=${choice?.finish_reason ?? "null"}, calls=${calls.length}`,
          ),
        };
      }

      if (serverDisabled) {
        // Distinguished deliberately: the operator can fix this by restarting
        // vLLM with the right flags, whereas a model that cannot call tools
        // never will.
        return {
          status: "fail",
          errorCode: SERVER_TOOLING_DISABLED_CODE,
          evidence: evidence(
            "게이트웨이가 tool calling을 비활성화한 상태 (vLLM --tool-call-parser / --enable-auto-tool-choice 미설정). " +
              "모델 능력의 문제가 아니라 배포 설정 문제이므로 운영자 조치로 해결 가능하다.",
            300,
          ),
        };
      }
      return { status: "fail", evidence: evidence(`no usable tool_choice: ${rejections.join(", ")}`) };
    }),
};

function toolChoiceOf(ctx: ProbeContext): ToolChoice {
  return (ctx.state.get(TOOL_CHOICE_KEY) as ToolChoice | undefined) ?? "auto";
}

const toolsMultiProbe: ProbeDefinition = {
  name: "tools_multi",
  description: "More than one tool_call in a single response",
  requires: ["tools"],
  deep: false,
  optIn: false,
  run: (ctx, modelId) =>
    attempt(async () => {
      const res = await ctx.client.chat(
        {
          ...baseRequest(
            modelId,
            "Get the temperature for both Seoul and Busan. Call the tool once per city.",
            512,
          ),
          tools: [WEATHER_TOOL],
          tool_choice: toolChoiceOf(ctx),
        },
        { signal: ctx.signal },
      );
      const calls = res.choices[0]?.message?.tool_calls ?? [];
      return calls.length >= 2
        ? { status: "pass", evidence: `calls=${calls.length}` }
        : { status: "fail", evidence: `calls=${calls.length} (need >= 2)` };
    }),
};

const toolsRoundtripProbe: ProbeDefinition = {
  name: "tools_roundtrip",
  description: "Model consumes a role:tool result and produces a final answer",
  requires: ["tools"],
  deep: false,
  optIn: false,
  run: (ctx, modelId) =>
    attempt(async () => {
      const first = await ctx.client.chat(
        {
          ...baseRequest(modelId, "What is the temperature in Seoul right now? Use the tool.", 256),
          tools: [WEATHER_TOOL],
          tool_choice: toolChoiceOf(ctx),
        },
        { signal: ctx.signal },
      );
      const call = first.choices[0]?.message?.tool_calls?.[0];
      if (!call) return { status: "fail", evidence: "first turn produced no tool_call" };

      // A value no model could guess: if it appears in the answer, the tool
      // result was genuinely read rather than hallucinated. Only the digits are
      // asserted — the sign is rendered as an en-dash by some models, and that
      // is a formatting choice, not a failure to use the tool.
      const marker = "-17.5";
      const digits = "17.5";
      // `tools` is deliberately omitted on the second leg. The model only has
      // to read the tool result and answer, and a gateway that restricts
      // tool_choice rejects any request carrying `tools` — resending them would
      // fail the probe for a reason that has nothing to do with the round-trip.
      const second = await ctx.client.chat(
        {
          model: modelId,
          temperature: 0,
          max_tokens: 256,
          messages: [
            { role: "user", content: "What is the temperature in Seoul right now? Use the tool." },
            { role: "assistant", content: null, tool_calls: [call] },
            {
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({ city: "Seoul", celsius: marker }),
            },
          ],
        },
        { signal: ctx.signal },
      );
      const answer = textOf(second.choices[0]?.message?.content);
      if (normalizeForMatch(answer).includes(digits)) {
        return { status: "pass", evidence: "tool result reflected in final answer" };
      }
      return {
        status: "fail",
        evidence: evidence(
          answer.trim().length === 0
            ? "empty answer after tool result"
            : "answer did not reflect the tool result",
        ),
      };
    }),
};

const toolsStreamProbe: ProbeDefinition = {
  name: "tools_stream",
  description: "tool_calls can be reassembled from a streamed response",
  requires: ["tools", "stream"],
  deep: false,
  optIn: false,
  run: (ctx, modelId) =>
    attempt(async () => {
      const asm = await ctx.client.chatStream(
        {
          ...baseRequest(modelId, "What is the temperature in Seoul right now? Use the tool.", 256),
          tools: [WEATHER_TOOL],
          tool_choice: toolChoiceOf(ctx),
        },
        { signal: ctx.signal },
      );
      if (asm.toolCalls.length === 0) {
        return { status: "fail", evidence: `no tool_calls in stream (chunks=${asm.chunkCount})` };
      }
      const call = asm.toolCalls[0];
      if (!isJson(call?.function.arguments || "{}")) {
        return { status: "fail", evidence: "streamed tool_call arguments did not reassemble to JSON" };
      }
      return { status: "pass", evidence: `calls=${asm.toolCalls.length}, chunks=${asm.chunkCount}` };
    }),
};

const jsonObjectProbe: ProbeDefinition = {
  name: "json_object",
  description: "response_format json_object returns parseable JSON",
  requires: ["chat"],
  deep: false,
  optIn: false,
  run: (ctx, modelId) =>
    attempt(async () => {
      const res = await ctx.client.chat(
        {
          ...baseRequest(
            modelId,
            'Return a JSON object with keys "city" and "country" for Seoul. JSON only.',
            128,
          ),
          response_format: { type: "json_object" },
        },
        { signal: ctx.signal },
      );
      const content = unfence(textOf(res.choices[0]?.message?.content));
      return isJson(content)
        ? { status: "pass", evidence: `parsed JSON, chars=${content.length}` }
        : { status: "fail", evidence: evidence("response was not valid JSON") };
    }),
};

const jsonSchemaProbe: ProbeDefinition = {
  name: "json_schema",
  description: "response_format json_schema is honoured",
  requires: ["chat"],
  deep: false,
  optIn: false,
  run: (ctx, modelId) =>
    attempt(async () => {
      const res = await ctx.client.chat(
        {
          ...baseRequest(modelId, "Describe Seoul using the provided schema.", 128),
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "city_info",
              strict: true,
              schema: {
                type: "object",
                properties: { city: { type: "string" }, country: { type: "string" } },
                required: ["city", "country"],
                additionalProperties: false,
              },
            },
          },
        },
        { signal: ctx.signal },
      );
      const content = unfence(textOf(res.choices[0]?.message?.content));
      if (!isJson(content)) return { status: "fail", evidence: "not valid JSON" };
      const parsed = JSON.parse(content) as Record<string, unknown>;
      return "city" in parsed && "country" in parsed
        ? { status: "pass", evidence: "schema keys present" }
        : { status: "fail", evidence: evidence(`missing keys: ${Object.keys(parsed).join(",")}`) };
    }),
};

const reasoningProbe: ProbeDefinition = {
  name: "reasoning_content",
  description: "Informational: does the gateway expose a separate reasoning channel",
  requires: ["chat"],
  deep: false,
  optIn: false,
  run: (ctx, modelId) =>
    attempt(async () => {
      const res = await ctx.client.chat(
        baseRequest(modelId, "If 3 shirts dry in 1 hour side by side, how long do 9 take? Think first.", 512),
        { signal: ctx.signal },
      );
      const msg = res.choices[0]?.message;
      const present = typeof msg?.reasoning_content === "string" && msg.reasoning_content.length > 0;
      return present
        ? { status: "pass", evidence: `reasoning_content present (${msg?.reasoning_content?.length} chars)` }
        : { status: "fail", evidence: "no reasoning_content field" };
    }),
};

const visionProbe: ProbeDefinition = {
  name: "vision",
  description: "image_url content parts are accepted",
  requires: ["chat"],
  deep: false,
  optIn: true,
  run: (ctx, modelId) =>
    attempt(async () => {
      // 1x1 pure-red PNG. Small enough to be free, unambiguous enough to grade.
      const red =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const res = await ctx.client.chat(
        {
          model: modelId,
          temperature: 0,
          max_tokens: 32,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "What colour is this image? One word." },
                { type: "image_url", image_url: { url: red } },
              ],
            },
          ],
        },
        { signal: ctx.signal },
      );
      const answer = textOf(res.choices[0]?.message?.content).toLowerCase();
      return answer.includes("red")
        ? { status: "pass", evidence: "identified colour" }
        : { status: "fail", evidence: evidence(`accepted image but answered: ${answer.slice(0, 40)}`) };
    }),
};

const MAX_OUTPUT_LADDER = [32768, 16384, 8192, 4096, 2048, 1024] as const;

const maxOutputProbe: ProbeDefinition = {
  name: "max_output",
  description: "Largest max_tokens the server accepts (short generation, cheap)",
  requires: ["chat"],
  deep: false,
  optIn: false,
  run: (ctx, modelId) =>
    attempt(async () => {
      for (const limit of MAX_OUTPUT_LADDER) {
        try {
          await ctx.client.chat(
            { ...baseRequest(modelId, "Reply with exactly: OK", limit) },
            { signal: ctx.signal, maxRetries: 0 },
          );
          return {
            status: "pass",
            evidence: `accepted max_tokens=${limit}`,
            limits: { observedMaxOutputTokens: limit },
          };
        } catch (err) {
          // Only a validation rejection tells us anything about the ceiling;
          // transient faults must not be misread as "the limit is lower".
          if (err instanceof HasaError && err.status === 400) continue;
          throw err;
        }
      }
      return { status: "fail", evidence: "server rejected every max_tokens down to 1024" };
    }),
};

const LONG_CONTEXT_LADDER = [8_000, 32_000, 128_000] as const;

const longContextProbe: ProbeDefinition = {
  name: "long_context",
  description: "Needle-in-haystack retrieval at increasing input sizes",
  requires: ["chat"],
  deep: true,
  optIn: false,
  run: (ctx, modelId) =>
    attempt(async () => {
      const needle = "MAGENTA-7741";
      let best = 0;
      for (const approxTokens of LONG_CONTEXT_LADDER) {
        const filler = "the quick brown fox jumps over the lazy dog. ".repeat(
          Math.ceil((approxTokens * 4) / 45),
        );
        const half = Math.floor(filler.length / 2);
        const haystack = `${filler.slice(0, half)}\nThe access code is ${needle}.\n${filler.slice(half)}`;
        try {
          const res = await ctx.client.chat(
            {
              model: modelId,
              temperature: 0,
              max_tokens: 32,
              messages: [
                { role: "user", content: `${haystack}\n\nWhat is the access code? Answer with the code only.` },
              ],
            },
            { signal: ctx.signal, maxRetries: 0 },
          );
          if (textOf(res.choices[0]?.message?.content).includes(needle)) best = approxTokens;
          else break;
        } catch {
          break;
        }
      }
      return best > 0
        ? {
            status: "pass",
            evidence: `needle recovered at ~${best} tokens`,
            limits: { observedContextWindow: best },
          }
        : { status: "fail", evidence: "needle not recovered at the smallest size" };
    }),
};

const seedProbe: ProbeDefinition = {
  name: "seed",
  description: "Identical seed + temperature 0 reproduces byte-identical output",
  requires: ["chat"],
  deep: true,
  optIn: false,
  run: (ctx, modelId) =>
    attempt(async () => {
      const req: ChatCompletionRequest = {
        ...baseRequest(modelId, "Write one sentence about the sea.", 64),
        seed: 12345,
      };
      const a = await ctx.client.chat(req, { signal: ctx.signal });
      const b = await ctx.client.chat(req, { signal: ctx.signal });
      const same =
        textOf(a.choices[0]?.message?.content) === textOf(b.choices[0]?.message?.content);
      return same
        ? { status: "pass", evidence: "two calls produced identical output" }
        : { status: "fail", evidence: "output differed despite identical seed" };
    }),
};

const latencyProbe: ProbeDefinition = {
  name: "latency",
  description: "Informational: p50/p95 of a trivial completion",
  requires: ["chat"],
  deep: false,
  optIn: false,
  run: (ctx, modelId) =>
    attempt(async () => {
      const samples: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const started = performance.now();
        await ctx.client.chat(baseRequest(modelId, "Reply with exactly: OK", 8), {
          signal: ctx.signal,
        });
        samples.push(performance.now() - started);
      }
      samples.sort((x, y) => x - y);
      const p50 = Math.round(samples[Math.floor(samples.length / 2)] ?? 0);
      const p95 = Math.round(samples[samples.length - 1] ?? 0);
      return { status: "pass", evidence: `p50=${p50}ms p95=${p95}ms`, limits: { latencyMs: { p50, p95 } } };
    }),
};

export const PROBES: ProbeDefinition[] = [
  chatProbe,
  streamProbe,
  toolsProbe,
  toolsMultiProbe,
  toolsRoundtripProbe,
  toolsStreamProbe,
  jsonObjectProbe,
  jsonSchemaProbe,
  reasoningProbe,
  visionProbe,
  maxOutputProbe,
  longContextProbe,
  seedProbe,
  latencyProbe,
];
