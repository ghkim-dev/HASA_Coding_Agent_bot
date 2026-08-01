import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatContentPart,
  ChatMessage,
  ResponseFormat,
  ToolCall,
  ToolChoice,
  ToolDefinition,
  Usage,
} from "../../protocol/index.ts";
import type {
  FinishReason,
  NormalizedToolCall,
  NormalizedUsage,
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderContentPart,
  ProviderMessage,
  ProviderStreamEvent,
  ProviderTool,
  ProviderToolChoice,
} from "../types.ts";

/**
 * The only place in the codebase that knows the OpenAI wire format.
 *
 * Everything above `provider/` speaks `ProviderChatRequest` /
 * `ProviderStreamEvent`; everything below speaks `choices[0].delta`. This file
 * is the seam, and it is deliberately dull — no retries, no HTTP, no policy,
 * just two translations and a stream assembler.
 */

// ---------------------------------------------------------------------------
// Normalised → wire
// ---------------------------------------------------------------------------

function contentPartToWire(part: ProviderContentPart): ChatContentPart {
  if (part.type === "text") return { type: "text", text: part.text };
  return {
    type: "image_url",
    image_url: part.detail === undefined ? { url: part.url } : { url: part.url, detail: part.detail },
  };
}

function toolCallToWire(call: NormalizedToolCall): ToolCall {
  return {
    id: call.id,
    type: "function",
    // `rawArguments`, not `JSON.stringify(arguments)`: the assistant turn we
    // echo back must be byte-identical to what the model produced, or a gateway
    // that validates its own history will reject the follow-up.
    function: { name: call.name, arguments: call.rawArguments },
  };
}

export function messageToWire(message: ProviderMessage): ChatMessage {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return {
        role: "user",
        content:
          typeof message.content === "string"
            ? message.content
            : message.content.map(contentPartToWire),
      };
    case "assistant": {
      const wire: ChatMessage = { role: "assistant", content: message.content };
      if (message.toolCalls && message.toolCalls.length > 0) {
        wire.tool_calls = message.toolCalls.map(toolCallToWire);
      }
      return wire;
    }
    case "tool":
      return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
  }
}

function toolToWire(tool: ProviderTool): ToolDefinition {
  return {
    type: "function",
    function:
      tool.description === undefined
        ? { name: tool.name, parameters: tool.parameters }
        : { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

function toolChoiceToWire(choice: ProviderToolChoice): ToolChoice {
  if (typeof choice === "string") return choice;
  return { type: "function", function: { name: choice.name } };
}

function responseFormatToWire(
  format: NonNullable<ProviderChatRequest["responseFormat"]>,
): ResponseFormat {
  if (format.type === "json_schema") {
    return {
      type: "json_schema",
      json_schema:
        format.strict === undefined
          ? { name: format.name, schema: format.schema }
          : { name: format.name, schema: format.schema, strict: format.strict },
    };
  }
  return { type: format.type };
}

export function toWireRequest(req: ProviderChatRequest, stream: boolean): ChatCompletionRequest {
  const wire: ChatCompletionRequest = {
    model: req.modelId,
    messages: req.messages.map(messageToWire),
    stream,
  };
  if (req.temperature !== undefined) wire.temperature = req.temperature;
  if (req.topP !== undefined) wire.top_p = req.topP;
  if (req.maxOutputTokens !== undefined) wire.max_tokens = req.maxOutputTokens;
  if (req.stop !== undefined) wire.stop = req.stop;
  if (req.seed !== undefined) wire.seed = req.seed;
  if (req.tools !== undefined && req.tools.length > 0) wire.tools = req.tools.map(toolToWire);
  if (req.toolChoice !== undefined) wire.tool_choice = toolChoiceToWire(req.toolChoice);
  if (req.responseFormat !== undefined) {
    wire.response_format = responseFormatToWire(req.responseFormat);
  }
  return wire;
}

// ---------------------------------------------------------------------------
// Wire → normalised
// ---------------------------------------------------------------------------

export function normalizeToolCall(raw: ToolCall, fallbackIndex: number): NormalizedToolCall {
  const rawArguments = raw.function?.arguments ?? "";
  let parsed: unknown = {};
  let valid = true;
  try {
    // An absent argument object and `{}` are the same thing to a tool; an
    // unparseable one is not, and the caller has to be able to tell.
    parsed = rawArguments.trim().length === 0 ? {} : JSON.parse(rawArguments);
  } catch {
    parsed = {};
    valid = false;
  }
  return {
    id: raw.id && raw.id.length > 0 ? raw.id : `call_${fallbackIndex}`,
    name: raw.function?.name ?? "",
    arguments: parsed,
    rawArguments,
    argumentsValid: valid,
  };
}

export function finishReasonOf(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case "stop":
    case "end_turn":
      return "stop";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "length":
    case "max_tokens":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return "unknown";
  }
}

export function usageOf(usage: Usage | undefined | null): NormalizedUsage | null {
  if (!usage) return null;
  return {
    inputTokens: usage.prompt_tokens ?? null,
    outputTokens: usage.completion_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
  };
}

function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part.type === "text" ? part.text : "")).join("");
  }
  return "";
}

export function fromWireResponse(
  res: ChatCompletionResponse,
  requestedModelId: string,
): ProviderChatResponse {
  const choice = res.choices[0];
  const message = choice?.message;
  const toolCalls = (message?.tool_calls ?? []).map(normalizeToolCall);
  return {
    modelId: res.model ?? requestedModelId,
    text: textOf(message?.content ?? null),
    reasoning: message?.reasoning_content ?? "",
    toolCalls,
    // Some gateways return tool calls with `finish_reason: "stop"`. The
    // presence of calls is the fact; the label is the gateway's opinion.
    finishReason:
      toolCalls.length > 0 ? "tool_calls" : finishReasonOf(choice?.finish_reason ?? null),
    usage: usageOf(res.usage),
  };
}

// ---------------------------------------------------------------------------
// Stream assembly
// ---------------------------------------------------------------------------

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
  started: boolean;
}

/**
 * Turns a chunk stream into the provider event stream.
 *
 * Tool-call fragments are keyed by `index`, the OpenAI convention that HASA was
 * measured to follow (`tools_stream: pass`, docs/compatibility-matrix.md §2.3).
 * `tool_call_start` is emitted as soon as a name is known so a UI can say
 * "reading src/app.ts…" while the arguments are still arriving, and
 * `tool_call_end` only once the stream has finished — arguments can be split
 * across any number of frames.
 *
 * `done` is emitted exactly once, at the end, whatever the gateway sent.
 */
export async function* streamEvents(
  chunks: AsyncIterable<ChatCompletionChunk>,
): AsyncGenerator<ProviderStreamEvent> {
  const pending = new Map<number, PendingToolCall>();
  let finishReason: FinishReason = "unknown";
  let sawToolCall = false;
  let usage: NormalizedUsage | null = null;

  for await (const chunk of chunks) {
    if (chunk.usage) usage = usageOf(chunk.usage);
    const choice = chunk.choices?.[0];
    if (!choice) continue;

    if (choice.finish_reason) finishReason = finishReasonOf(choice.finish_reason);

    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content.length > 0) {
      yield { type: "text", delta: delta.content };
    }
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      yield { type: "reasoning", delta: delta.reasoning_content };
    }

    for (const fragment of delta.tool_calls ?? []) {
      const index = fragment.index ?? 0;
      const acc = pending.get(index) ?? { id: "", name: "", args: "", started: false };
      if (fragment.id) acc.id = fragment.id;
      if (fragment.function?.name) acc.name = fragment.function.name;

      if (!acc.started && acc.name.length > 0) {
        acc.started = true;
        sawToolCall = true;
        pending.set(index, acc);
        yield { type: "tool_call_start", index, id: acc.id || `call_${index}`, name: acc.name };
      }

      const argsDelta = fragment.function?.arguments;
      if (typeof argsDelta === "string" && argsDelta.length > 0) {
        acc.args += argsDelta;
        pending.set(index, acc);
        if (acc.started) yield { type: "tool_call_delta", index, argumentsDelta: argsDelta };
      }
      pending.set(index, acc);
    }
  }

  for (const [index, acc] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
    // A fragment stream that never carried a name produces no usable call; it
    // is reported as an unnamed one rather than silently dropped, because a
    // vanished tool call looks to the agent like the model chose not to act.
    if (!acc.started) {
      yield { type: "tool_call_start", index, id: acc.id || `call_${index}`, name: acc.name };
      sawToolCall = true;
    }
    yield {
      type: "tool_call_end",
      index,
      toolCall: normalizeToolCall(
        { id: acc.id, type: "function", function: { name: acc.name, arguments: acc.args } },
        index,
      ),
    };
  }

  if (usage !== null) yield { type: "usage", usage };
  yield { type: "done", finishReason: sawToolCall ? "tool_calls" : finishReason };
}

/** Collapses the event stream back into a single response. */
export async function collectStream(
  events: AsyncIterable<ProviderStreamEvent>,
  modelId: string,
): Promise<ProviderChatResponse> {
  let text = "";
  let reasoning = "";
  let finishReason: FinishReason = "unknown";
  let usage: NormalizedUsage | null = null;
  const toolCalls: NormalizedToolCall[] = [];

  for await (const event of events) {
    switch (event.type) {
      case "text":
        text += event.delta;
        break;
      case "reasoning":
        reasoning += event.delta;
        break;
      case "tool_call_end":
        toolCalls.push(event.toolCall);
        break;
      case "usage":
        usage = event.usage;
        break;
      case "done":
        finishReason = event.finishReason;
        break;
      case "tool_call_start":
      case "tool_call_delta":
        break;
    }
  }

  return { modelId, text, reasoning, toolCalls, finishReason, usage };
}
