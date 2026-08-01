import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "../../protocol/index.ts";
import type { ProviderError } from "../errors.ts";
import type {
  LlmProvider,
  ModelListOptions,
  ModelListing,
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderId,
  ProviderRequestOptions,
  ProviderStreamEvent,
  ProviderValidation,
} from "../types.ts";
import { fromWireResponse, streamEvents, toWireRequest } from "./wire.ts";

/**
 * What a gateway has to offer for this base class to drive it.
 *
 * Narrow on purpose. `HasaClient` already satisfies almost all of it, which is
 * the point: the provider layer adds a contract, not a second HTTP client.
 * See docs/hasa-coding-agent-architecture.md §9.2.
 */
export interface TransportRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface TransportModelRecord {
  id: string;
  ownedBy: string | null;
}

export interface ChatTransport {
  readonly baseUrl: string;
  listModelRecords(opts?: TransportRequestOptions): Promise<TransportModelRecord[]>;
  chat(
    req: ChatCompletionRequest,
    opts?: TransportRequestOptions,
  ): Promise<ChatCompletionResponse>;
  streamChunks(
    req: ChatCompletionRequest,
    opts?: TransportRequestOptions,
  ): AsyncIterable<ChatCompletionChunk>;
}

export interface OpenAiCompatibleProviderInit {
  id: ProviderId;
  displayName: string;
  transport: ChatTransport;
}

/**
 * Everything an OpenAI-compatible gateway shares.
 *
 * Zoo Code arrived at the same shape (`BaseOpenAiCompatibleProvider`, 40-odd
 * subclasses) and the reason holds here: chat and streaming are identical
 * across such gateways, and what actually differs is the base URL, the model
 * catalogue, how errors are worded, and what "the credential works" means. Those
 * four are the abstract members below.
 */
export abstract class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  protected readonly transport: ChatTransport;

  protected constructor(init: OpenAiCompatibleProviderInit) {
    this.id = init.id;
    this.displayName = init.displayName;
    this.transport = init.transport;
  }

  get baseUrl(): string {
    return this.transport.baseUrl;
  }

  abstract listModels(opts?: ModelListOptions): Promise<ModelListing>;

  abstract validate(opts?: ProviderRequestOptions): Promise<ProviderValidation>;

  /** Gateway-specific error interpretation. Must never return a raw Error. */
  protected abstract mapError(err: unknown): ProviderError;

  protected transportOptions(opts: ProviderRequestOptions): TransportRequestOptions {
    const out: TransportRequestOptions = {};
    if (opts.signal !== undefined) out.signal = opts.signal;
    if (opts.timeoutMs !== undefined) out.timeoutMs = opts.timeoutMs;
    if (opts.maxRetries !== undefined) out.maxRetries = opts.maxRetries;
    return out;
  }

  async chat(
    req: ProviderChatRequest,
    opts: ProviderRequestOptions = {},
  ): Promise<ProviderChatResponse> {
    try {
      const res = await this.transport.chat(
        toWireRequest(req, false),
        this.transportOptions(opts),
      );
      return fromWireResponse(res, req.modelId);
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /**
   * Streams normalised events.
   *
   * The mapping sits around the iteration rather than around the call because a
   * transport built on an async generator does not fail until it is pulled —
   * wrapping only the call would let a 503 escape as a `HasaError`.
   */
  async *stream(
    req: ProviderChatRequest,
    opts: ProviderRequestOptions = {},
  ): AsyncGenerator<ProviderStreamEvent> {
    try {
      const chunks = this.transport.streamChunks(
        toWireRequest(req, true),
        this.transportOptions(opts),
      );
      yield* streamEvents(chunks);
    } catch (err) {
      throw this.mapError(err);
    }
  }
}
