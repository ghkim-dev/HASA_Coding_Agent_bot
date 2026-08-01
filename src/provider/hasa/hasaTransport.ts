import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "../../protocol/index.ts";
import { HasaClient, type HasaClientOptions } from "../../hasa-client/client.ts";
import type { Logger } from "../../hasa-client/logger.ts";
import type {
  ChatTransport,
  TransportModelRecord,
  TransportRequestOptions,
} from "../openai-compatible/openaiCompatibleProvider.ts";
import { HASA_DEFAULT_BASE_URL, HASA_DEFAULT_TIMEOUT_MS } from "./defaults.ts";

/**
 * Adapter, not a client.
 *
 * `HasaClient` already does authentication, per-attempt timeouts, the HASA error
 * taxonomy, `Retry-After`-aware retries and SSE decoding, and it is covered by
 * its own tests. Reimplementing any of that inside the provider would mean two
 * codebases to keep in step with one gateway. So this file is thirty lines of
 * shape-matching and nothing else.
 */
export class HasaTransport implements ChatTransport {
  readonly client: HasaClient;

  constructor(client: HasaClient) {
    this.client = client;
  }

  get baseUrl(): string {
    return this.client.baseUrl;
  }

  async listModelRecords(opts: TransportRequestOptions = {}): Promise<TransportModelRecord[]> {
    const records = await this.client.listModelRecords(opts);
    return records.map((m) => ({ id: m.id, ownedBy: m.owned_by ?? null }));
  }

  async chat(
    req: ChatCompletionRequest,
    opts: TransportRequestOptions = {},
  ): Promise<ChatCompletionResponse> {
    return this.client.chat(req, opts);
  }

  streamChunks(
    req: ChatCompletionRequest,
    opts: TransportRequestOptions = {},
  ): AsyncIterable<ChatCompletionChunk> {
    return this.client.streamChunks(req, opts);
  }
}

export interface HasaTransportOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  logger?: Logger;
  onRateLimit?: HasaClientOptions["onRateLimit"];
  fetchImpl?: HasaClientOptions["fetchImpl"];
}

export function createHasaTransport(opts: HasaTransportOptions): HasaTransport {
  const clientOptions: HasaClientOptions = {
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl ?? HASA_DEFAULT_BASE_URL,
    timeoutMs: opts.timeoutMs ?? HASA_DEFAULT_TIMEOUT_MS,
  };
  if (opts.maxRetries !== undefined) clientOptions.maxRetries = opts.maxRetries;
  if (opts.logger !== undefined) clientOptions.logger = opts.logger;
  if (opts.onRateLimit !== undefined) clientOptions.onRateLimit = opts.onRateLimit;
  if (opts.fetchImpl !== undefined) clientOptions.fetchImpl = opts.fetchImpl;
  return new HasaTransport(new HasaClient(clientOptions));
}
