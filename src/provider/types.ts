/**
 * Provider contract.
 *
 * This file is the boundary the Coding Agent is allowed to see. Nothing below
 * it — `choices[0].delta.tool_calls`, `finish_reason`, SSE frames, HTTP status
 * codes — appears in any type declared here.
 *
 * The reason is not tidiness. An agent loop that reads OpenAI wire shapes
 * directly acquires a second job (knowing what a gateway returns) on top of its
 * real one (deciding what to do next), and the two get edited together forever
 * after. Keeping the wire format inside `openai-compatible/` means a HASA
 * response-shape change is a one-file change.
 *
 * See docs/hasa-coding-agent-architecture.md §7.3.
 */

export type ProviderId = "hasa";

/**
 * Three states, not two.
 *
 * `unknown` is load-bearing: the 2026-07-29 probe left
 * `granite-guardian-3.1-8b` unmeasured because the GPU backend was down, and
 * collapsing that into `false` would record a gateway outage as a permanent
 * model deficiency. See docs/compatibility-matrix.md §8.1.
 */
export type Tristate = boolean | "unknown";

export type CapabilityState = Tristate;

/**
 * What a model can actually do — measured, never inferred from its name.
 *
 * A model list mixes chat, coding, embedding, reranking and vision models. The
 * only honest default for every field is `unknown`; a probe result is what
 * turns one into a boolean.
 */
export interface ModelCapabilities {
  chat: CapabilityState;
  streaming: CapabilityState;
  toolCalling: CapabilityState;
  coding: CapabilityState;
  reasoning: CapabilityState;
  vision: CapabilityState;
  embedding: CapabilityState;
  reranking: CapabilityState;
}

export function unknownCapabilities(): ModelCapabilities {
  return {
    chat: "unknown",
    streaming: "unknown",
    toolCalling: "unknown",
    coding: "unknown",
    reasoning: "unknown",
    vision: "unknown",
    embedding: "unknown",
    reranking: "unknown",
  };
}

export interface ModelLimits {
  maxOutputTokens: number | null;
  contextWindow: number | null;
}

export interface ProviderModel {
  id: string;
  /** From the gateway's own listing. Null when it does not say. */
  ownedBy: string | null;
  capabilities: ModelCapabilities;
  limits: ModelLimits;
}

/**
 * A model list, plus where it came from.
 *
 * `source` and `stale` are part of the contract rather than an implementation
 * detail: a picker showing a cached list after a failed refresh has to be able
 * to say so, and "the list is empty" and "the refresh failed" are different
 * things a user needs told apart.
 */
export interface ModelListing {
  models: ProviderModel[];
  source: "network" | "cache";
  /** ISO timestamp of the fetch that produced these entries. */
  fetchedAt: string;
  stale: boolean;
  /** Set when a refresh failed and a cached list was served instead. */
  warning: string | null;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface ProviderTextPart {
  type: "text";
  text: string;
}

export interface ProviderImagePart {
  type: "image";
  /** URL or data URI. Never logged — see hasa-client/redact.ts. */
  url: string;
  detail?: "auto" | "low" | "high";
}

export type ProviderContentPart = ProviderTextPart | ProviderImagePart;

export interface ProviderSystemMessage {
  role: "system";
  content: string;
}

export interface ProviderUserMessage {
  role: "user";
  content: string | ProviderContentPart[];
}

export interface ProviderAssistantMessage {
  role: "assistant";
  content: string | null;
  toolCalls?: NormalizedToolCall[];
}

export interface ProviderToolMessage {
  role: "tool";
  toolCallId: string;
  content: string;
}

export type ProviderMessage =
  | ProviderSystemMessage
  | ProviderUserMessage
  | ProviderAssistantMessage
  | ProviderToolMessage;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ProviderTool {
  name: string;
  description?: string;
  /** JSON Schema. Passed through untouched. */
  parameters: Record<string, unknown>;
}

export type ProviderToolChoice = "auto" | "none" | "required" | { name: string };

/**
 * One tool call, normalised.
 *
 * `arguments` is the parsed value, but `rawArguments` is kept because models do
 * emit malformed JSON and the only useful recovery is to hand the raw text back
 * to the model as a tool result. Throwing it away turns a recoverable turn into
 * a dead one.
 */
export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: unknown;
  rawArguments: string;
  argumentsValid: boolean;
}

// ---------------------------------------------------------------------------
// Requests and responses
// ---------------------------------------------------------------------------

export type ProviderResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | {
      type: "json_schema";
      name: string;
      schema: Record<string, unknown>;
      strict?: boolean;
    };

export interface ProviderChatRequest {
  modelId: string;
  messages: ProviderMessage[];
  tools?: ProviderTool[];
  toolChoice?: ProviderToolChoice;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  stop?: string[];
  seed?: number;
  responseFormat?: ProviderResponseFormat;
}

export type FinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter"
  | "unknown";

export interface NormalizedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface ProviderChatResponse {
  modelId: string;
  text: string;
  /** Separate reasoning channel when the gateway exposes one; "" otherwise. */
  reasoning: string;
  toolCalls: NormalizedToolCall[];
  finishReason: FinishReason;
  usage: NormalizedUsage | null;
}

/**
 * The streaming contract.
 *
 * Tool calls arrive as start → delta* → end rather than as a single blob, so a
 * UI can show "calling read_file…" before the arguments have finished
 * arriving. `done` is emitted exactly once, last.
 */
export type ProviderStreamEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_delta"; index: number; argumentsDelta: string }
  | { type: "tool_call_end"; index: number; toolCall: NormalizedToolCall }
  | { type: "usage"; usage: NormalizedUsage }
  | { type: "done"; finishReason: FinishReason };

export interface ProviderRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface ModelListOptions extends ProviderRequestOptions {
  /** Bypass the cache and go to the network. */
  refresh?: boolean;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Why this is not a boolean.
 *
 * HASA's `GET /v1/models` is public: it answers without a key. A provider that
 * treated a successful model list as proof of a working credential would report
 * "connected" for a typo'd key, and the user would only find out on their first
 * real request. So reachability and credential validity are measured separately
 * and reported separately.
 *
 * `403` is the other trap: it means the key authenticated and simply lacks
 * access to that model. Reading it as an auth failure marks a working key
 * invalid. See docs/hasa-coding-agent-architecture.md §3.2.
 */
export interface ProviderValidation {
  /** `GET /v1/models` answered. Says nothing about the key. */
  endpointReachable: boolean;
  credentialValid: Tristate;
  modelCount: number;
  /** Which model the authenticated probe used, if it got that far. */
  probedModelId: string | null;
  /**
   * A model this key was *proven* able to call, or null.
   *
   * Distinct from `probedModelId`, which is only what we tried. The gateway
   * orders its catalogue, and its first entry is routinely one the key cannot
   * touch — probing it returns 403, which proves the credential and leaves the
   * caller holding an id that fails on first use.
   */
  usableModelId: string | null;
  /** Models the gateway says this key may call, when it volunteers them. */
  allowedModels: string[] | null;
  /** Short, user-facing Korean summary. Never contains key material. */
  detail: string;
  error: ProviderErrorLike | null;
}

/** Structural view of ProviderError, so this file stays dependency-free. */
export interface ProviderErrorLike {
  code: string;
  httpStatus: number | null;
  retryable: boolean;
  terminal: boolean;
  userMessage: string;
}

// ---------------------------------------------------------------------------
// The provider itself
// ---------------------------------------------------------------------------

export interface LlmProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly baseUrl: string;

  listModels(opts?: ModelListOptions): Promise<ModelListing>;
  chat(req: ProviderChatRequest, opts?: ProviderRequestOptions): Promise<ProviderChatResponse>;
  stream(
    req: ProviderChatRequest,
    opts?: ProviderRequestOptions,
  ): AsyncGenerator<ProviderStreamEvent>;
  validate(opts?: ProviderRequestOptions): Promise<ProviderValidation>;
}
