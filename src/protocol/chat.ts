/**
 * Minimal OpenAI-compatible chat types.
 *
 * Deliberately hand-written rather than pulled from an SDK: HASA's documented
 * surface is a subset of OpenAI's and the whole point of Phase 0 is to find out
 * empirically which parts actually work. A vendor SDK would paper over exactly
 * the differences we are trying to measure.
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatTextPart {
  type: "text";
  text: string;
}

export interface ChatImagePart {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
}

export type ChatContentPart = ChatTextPart | ChatImagePart;

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | ChatContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Some gateways return a separate reasoning channel. Probed, not assumed. */
  reasoning_content?: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | {
      type: "json_schema";
      json_schema: {
        name: string;
        schema: Record<string, unknown>;
        strict?: boolean;
      };
    };

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string[];
  seed?: number;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  parallel_tool_calls?: boolean;
  response_format?: ResponseFormat;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
}

export interface ChatCompletionResponse {
  id?: string;
  object?: string;
  model?: string;
  created?: number;
  choices: ChatChoice[];
  usage?: Usage;
}

/** Streaming delta. `tool_calls` arrive as indexed fragments to be assembled. */
export interface ChatCompletionChunkDelta {
  role?: ChatRole;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }>;
}

export interface ChatCompletionChunk {
  id?: string;
  object?: string;
  model?: string;
  choices: Array<{
    index: number;
    delta: ChatCompletionChunkDelta;
    finish_reason: string | null;
  }>;
  usage?: Usage;
}

/** Result of collapsing a stream back into a single logical message. */
export interface AssembledStream {
  content: string;
  reasoningContent: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  chunkCount: number;
  usage: Usage | null;
}
