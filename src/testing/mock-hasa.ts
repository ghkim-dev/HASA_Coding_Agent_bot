import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ToolCall,
} from "../protocol/index.ts";

/**
 * In-process stand-in for the HASA gateway.
 *
 * Exists so the entire probe and orchestrator can be tested without a key, a
 * network, or a GPU — and, more importantly, so we can force error paths (403,
 * 429 with Retry-After, 503) that a healthy real service will not produce on
 * demand.
 */

export type MockBehavior =
  | "ok"
  | "forbidden" // 403 on every inference call
  | "not_found" // 404
  | "rate_limit_once" // 429 + Retry-After, then succeeds
  | "unavailable"; // 503 always

export interface MockModelProfile {
  id: string;
  behavior?: MockBehavior;
  /** Native OpenAI tool calling. "none" means the model ignores `tools`. */
  tools?: "native" | "none";
  multiTool?: boolean;
  streaming?: boolean;
  jsonObject?: boolean;
  jsonSchema?: boolean;
  reasoning?: boolean;
  vision?: boolean;
  /** Requests above this get a 400, which is how the ladder finds the ceiling. */
  maxTokensLimit?: number;
  /** Fixed reply used by the response-compare tests. */
  cannedReply?: string;
  /** When false, two identical seeded calls differ. */
  seedStable?: boolean;
  /**
   * Renders the tool result with an en-dash minus and markdown emphasis, the
   * way several real models do. Purely a presentation difference.
   */
  typographicOutput?: boolean;
  /**
   * Turns the model into a deterministic pairwise judge: it returns a verdict
   * for whichever submission contains this marker. Content-based rather than
   * position-based, so a correct pipeline produces a stable AB/BA result.
   */
  judgePrefers?: string;
  /** Always picks this presentation slot — simulates pure position bias. */
  judgeAlwaysPicksSlot?: 1 | 2;
  /**
   * Answers against `judgePrefers` for this many calls, then normally.
   *
   * Reproduces a judge that is noisy rather than biased: the first reading of a
   * pair disagrees with itself, and repetition converges. Without it there is
   * no way to test that S2 distinguishes one bad draw from a genuinely
   * inseparable pair, which is the entire justification for the rung.
   */
  judgeContrarianCalls?: number;
  /** Emits unparseable output this many times before answering properly. */
  judgeGarbageTimes?: number;
  /**
   * Below this max_tokens the judge answer comes back truncated (or empty),
   * reproducing a reasoning-style model that spends its budget before emitting
   * anything parseable.
   */
  judgeNeedsTokens?: number;
  /**
   * Scripted agent behaviour: on the Nth turn, emit the Nth tool call. Lets the
   * real tool-calling runner be driven deterministically without a live model.
   */
  agentScript?: Array<{ name: string; args: Record<string, unknown> }>;
  /** Reply used by patch-mode candidates. */
  patchReply?: string;
  /**
   * Reproduces vLLM launched without `--tool-call-parser`: every tools request
   * is rejected regardless of tool_choice.
   */
  toolsServerDisabled?: boolean;
  /** Rejects `tool_choice: "auto"` but honours the more coercive modes. */
  toolsRejectAuto?: boolean;
  /**
   * Below this budget the model burns its tokens without emitting content and
   * returns `finish_reason: "length"` — the reasoning-model failure mode.
   */
  minTokensForContent?: number;
}

export interface MockStats {
  requests: number;
  byModel: Map<string, number>;
  rateLimited: Map<string, number>;
  lastRequestBody: ChatCompletionRequest | null;
  /** Wall-clock gaps between consecutive calls, used to assert backoff waits. */
  gapsMs: number[];
}

export interface MockHasaServer {
  url: string;
  apiKey: string;
  stats: MockStats;
  close(): Promise<void>;
}

interface MockOptions {
  models: MockModelProfile[];
  apiKey?: string;
  /** Unknown model ids 404 by default, matching the documented behaviour. */
  hideModelsEndpoint?: boolean;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => ("text" in p ? p.text : "")).join(" ");
  }
  return "";
}

function hasImage(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"),
  );
}

interface Reply {
  content: string | null;
  toolCalls: ToolCall[];
  reasoning: string | null;
}

function between(text: string, open: string, close: string): string {
  const start = text.indexOf(open);
  const end = text.indexOf(close);
  return start === -1 || end === -1 || end < start ? "" : text.slice(start + open.length, end);
}

const judgeGarbageSeen = new Map<string, number>();
const judgeContrarianSeen = new Map<string, number>();

function buildReply(profile: MockModelProfile, body: ChatCompletionRequest, counter: number): Reply {
  const messages = body.messages ?? [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const prompt = textOf(lastUser?.content ?? "");
  const conversation = messages.map((m) => textOf(m.content)).join("\n");
  const toolResult = messages.find((m) => m.role === "tool");

  // Judge behaviour is keyed off the submission markers so it survives the
  // retry turns, where the last user message is the corrective instruction.
  const isJudgeCall = conversation.includes("<<<SUBMISSION_1>>>");
  if (isJudgeCall) {
    if (
      typeof profile.judgeNeedsTokens === "number" &&
      typeof body.max_tokens === "number" &&
      body.max_tokens < profile.judgeNeedsTokens
    ) {
      // Cut off mid-JSON, exactly as a real gateway does when the ceiling hits.
      return { content: '{"winner": 1, "confidence": 0.9, "reasons": ["cut off her', toolCalls: [], reasoning: null };
    }
    const seen = judgeGarbageSeen.get(profile.id) ?? 0;
    if (seen < (profile.judgeGarbageTimes ?? 0)) {
      judgeGarbageSeen.set(profile.id, seen + 1);
      return { content: "제 생각에는 첫 번째가 더 좋습니다.", toolCalls: [], reasoning: null };
    }
    if (profile.judgeAlwaysPicksSlot) {
      return {
        content: JSON.stringify({
          winner: profile.judgeAlwaysPicksSlot,
          confidence: 0.9,
          reasons: ["always picks the same slot"],
        }),
        toolCalls: [],
        reasoning: null,
      };
    }
    const s1 = between(conversation, "<<<SUBMISSION_1>>>", "<<<END_SUBMISSION_1>>>");
    const s2 = between(conversation, "<<<SUBMISSION_2>>>", "<<<END_SUBMISSION_2>>>");
    const marker = profile.judgePrefers;
    const preferred = marker === undefined ? null : s1.includes(marker) ? 1 : s2.includes(marker) ? 2 : null;

    const contrarianBudget = profile.judgeContrarianCalls ?? 0;
    const contrarianSeen = judgeContrarianSeen.get(profile.id) ?? 0;
    const contrarian = contrarianSeen < contrarianBudget;
    if (contrarianBudget > 0) judgeContrarianSeen.set(profile.id, contrarianSeen + 1);

    const winner = contrarian && preferred !== null ? (preferred === 1 ? 2 : 1) : preferred;
    return {
      content: JSON.stringify({
        winner,
        confidence: winner === null ? 0.5 : 0.8,
        reasons: [winner === null ? "no preference" : "contains the preferred marker"],
      }),
      toolCalls: [],
      reasoning: null,
    };
  }

  if (hasImage(messages)) {
    return { content: profile.vision ? "Red" : "I cannot see images.", toolCalls: [], reasoning: null };
  }

  // Second leg of the tool round-trip: echo whatever the tool reported.
  // Scripted agents have their own turn-by-turn behaviour and must not be
  // hijacked by this branch once their first tool result comes back.
  if (toolResult && !profile.agentScript) {
    let celsius = "unknown";
    try {
      const parsed = JSON.parse(textOf(toolResult.content)) as { celsius?: unknown };
      if (parsed.celsius !== undefined) celsius = String(parsed.celsius);
    } catch {
      /* leave as unknown */
    }
    if (profile.typographicOutput === true) {
      return {
        content: `The current temperature in Seoul is **${celsius.replace(/-/g, "–")} °C**.`,
        toolCalls: [],
        reasoning: null,
      };
    }
    return { content: `It is ${celsius}°C in Seoul.`, toolCalls: [], reasoning: null };
  }

  // Scripted agent: the turn index is the number of assistant messages so far,
  // so the script advances exactly once per model call.
  if (profile.agentScript && body.tools?.length) {
    const turn = messages.filter((m) => m.role === "assistant").length;
    const step = profile.agentScript[turn];
    if (!step) {
      return { content: "no further steps", toolCalls: [], reasoning: null };
    }
    return {
      content: null,
      toolCalls: [
        {
          id: `call_${turn}`,
          type: "function",
          function: { name: step.name, arguments: JSON.stringify(step.args) },
        },
      ],
      reasoning: null,
    };
  }

  if (profile.patchReply !== undefined && !body.tools?.length && /unified diff/i.test(conversation)) {
    return { content: profile.patchReply, toolCalls: [], reasoning: null };
  }

  if (body.tools?.length && profile.tools === "native") {
    const wantsTwo = profile.multiTool === true && /busan/i.test(prompt);
    const calls: ToolCall[] = [
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: JSON.stringify({ city: "Seoul" }) },
      },
    ];
    if (wantsTwo) {
      calls.push({
        id: "call_2",
        type: "function",
        function: { name: "get_weather", arguments: JSON.stringify({ city: "Busan" }) },
      });
    }
    return { content: null, toolCalls: calls, reasoning: null };
  }

  if (body.response_format?.type === "json_schema") {
    return profile.jsonSchema
      ? { content: JSON.stringify({ city: "Seoul", country: "South Korea" }), toolCalls: [], reasoning: null }
      : { content: "Seoul is in South Korea.", toolCalls: [], reasoning: null };
  }
  if (body.response_format?.type === "json_object") {
    return profile.jsonObject
      ? { content: JSON.stringify({ city: "Seoul", country: "South Korea" }), toolCalls: [], reasoning: null }
      : { content: "Seoul is in South Korea.", toolCalls: [], reasoning: null };
  }

  if (/access code/i.test(prompt)) {
    const m = /access code is ([A-Z0-9-]+)/i.exec(prompt);
    return { content: m?.[1] ?? "unknown", toolCalls: [], reasoning: null };
  }
  if (/reply with exactly: OK/i.test(prompt)) {
    return { content: "OK", toolCalls: [], reasoning: null };
  }
  if (/count from 1 to 5/i.test(prompt)) {
    return { content: "1 2 3 4 5", toolCalls: [], reasoning: null };
  }
  if (body.seed !== undefined && profile.seedStable === false) {
    return { content: `The sea is calm today (${counter}).`, toolCalls: [], reasoning: null };
  }

  const content = profile.cannedReply ?? `[${profile.id}] ${prompt.slice(0, 120)}`;
  return {
    content,
    toolCalls: [],
    reasoning: profile.reasoning ? "Let me think about this step by step." : null,
  };
}

function completionBody(profile: MockModelProfile, reply: Reply): ChatCompletionResponse {
  const message: ChatMessage = { role: "assistant", content: reply.content };
  if (reply.toolCalls.length > 0) message.tool_calls = reply.toolCalls;
  if (reply.reasoning) message.reasoning_content = reply.reasoning;
  return {
    id: `chatcmpl-mock-${profile.id}`,
    object: "chat.completion",
    model: profile.id,
    choices: [
      {
        index: 0,
        message,
        finish_reason: reply.toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function writeSse(res: ServerResponse, profile: MockModelProfile, reply: Reply): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (payload: unknown): void => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const base = { id: `chatcmpl-mock-${profile.id}`, object: "chat.completion.chunk", model: profile.id };

  send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });

  if (reply.toolCalls.length > 0) {
    // Split each call across two frames so the assembler's index handling is
    // genuinely exercised rather than trivially satisfied.
    reply.toolCalls.forEach((call, index) => {
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index, id: call.id, type: "function", function: { name: call.function.name, arguments: "" } },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index, function: { arguments: call.function.arguments } }] },
            finish_reason: null,
          },
        ],
      });
    });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  } else {
    const text = reply.content ?? "";
    const step = Math.max(1, Math.ceil(text.length / 4));
    for (let i = 0; i < text.length; i += step) {
      send({
        ...base,
        choices: [{ index: 0, delta: { content: text.slice(i, i + step) }, finish_reason: null }],
      });
    }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

export async function startMockHasa(opts: MockOptions): Promise<MockHasaServer> {
  const apiKey = opts.apiKey ?? "mock-key-0123456789abcdef";
  const profiles = new Map(opts.models.map((m) => [m.id, m]));
  const rateLimitSeen = new Map<string, number>();
  let lastAt = 0;

  const stats: MockStats = {
    requests: 0,
    byModel: new Map(),
    rateLimited: new Map(),
    lastRequestBody: null,
    gapsMs: [],
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const auth = req.headers["authorization"];

      if (url.pathname === "/v1/models" && req.method === "GET") {
        if (opts.hideModelsEndpoint) {
          json(res, 404, { error: { message: "not found" } });
          return;
        }
        json(res, 200, {
          object: "list",
          data: opts.models.map((m) => ({ id: m.id, object: "model", owned_by: "mock" })),
        });
        return;
      }

      if (url.pathname !== "/v1/chat/completions" || req.method !== "POST") {
        json(res, 404, { error: { message: "unknown route" } });
        return;
      }

      if (auth !== `Bearer ${apiKey}`) {
        json(res, 401, { error: { message: "invalid api key" } });
        return;
      }

      const body = (await readBody(req)) as ChatCompletionRequest;
      stats.requests += 1;
      stats.lastRequestBody = body;
      const now = Date.now();
      if (lastAt !== 0) stats.gapsMs.push(now - lastAt);
      lastAt = now;

      const profile = profiles.get(body.model);
      if (!profile) {
        json(res, 404, { error: { message: `model ${body.model} is not registered` } });
        return;
      }
      stats.byModel.set(profile.id, (stats.byModel.get(profile.id) ?? 0) + 1);

      const behavior = profile.behavior ?? "ok";
      if (behavior === "forbidden") {
        json(res, 403, { error: { message: "model access denied for this key" } });
        return;
      }
      if (behavior === "not_found") {
        json(res, 404, { error: { message: "unregistered model" } });
        return;
      }
      if (behavior === "unavailable") {
        json(res, 503, { error: { message: "GPU backend unavailable" } });
        return;
      }
      if (behavior === "rate_limit_once") {
        const seen = rateLimitSeen.get(profile.id) ?? 0;
        if (seen === 0) {
          rateLimitSeen.set(profile.id, 1);
          stats.rateLimited.set(profile.id, (stats.rateLimited.get(profile.id) ?? 0) + 1);
          json(res, 429, { error: { message: "rate limit exceeded" } }, { "retry-after": "1" });
          return;
        }
      }

      const limit = profile.maxTokensLimit ?? 8192;
      if (typeof body.max_tokens === "number" && body.max_tokens > limit) {
        json(res, 400, {
          error: { message: `max_tokens ${body.max_tokens} exceeds model limit ${limit}` },
        });
        return;
      }

      if (body.tools?.length) {
        if (profile.toolsServerDisabled === true) {
          json(res, 400, {
            error: {
              message:
                body.tool_choice === undefined || body.tool_choice === "auto"
                  ? '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set'
                  : 'tool_choice="required" requires --tool-call-parser to be set',
              type: "BadRequestError",
              code: 400,
            },
          });
          return;
        }
        if (
          profile.toolsRejectAuto === true &&
          (body.tool_choice === undefined || body.tool_choice === "auto")
        ) {
          json(res, 400, {
            error: {
              message: '"auto" tool choice requires --enable-auto-tool-choice to be set',
              type: "BadRequestError",
              code: 400,
            },
          });
          return;
        }
      }

      if (
        typeof profile.minTokensForContent === "number" &&
        typeof body.max_tokens === "number" &&
        body.max_tokens < profile.minTokensForContent
      ) {
        json(res, 200, {
          id: `chatcmpl-mock-${profile.id}`,
          object: "chat.completion",
          model: profile.id,
          choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "length" }],
          usage: { prompt_tokens: 10, completion_tokens: body.max_tokens, total_tokens: 10 + body.max_tokens },
        });
        return;
      }

      const reply = buildReply(profile, body, stats.requests);
      if (body.stream === true) {
        if (profile.streaming === false) {
          json(res, 400, { error: { message: "streaming is not supported for this model" } });
          return;
        }
        writeSse(res, profile, reply);
        return;
      }
      json(res, 200, completionBody(profile, reply));
    })().catch(() => {
      if (!res.headersSent) json(res, 500, { error: { message: "mock server failure" } });
      else res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    apiKey,
    stats,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
