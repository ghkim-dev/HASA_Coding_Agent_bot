import { fingerprint } from "../../hasa-client/redact.ts";
import type { Logger } from "../../hasa-client/logger.ts";
import { assertUsableApiKey } from "../credentials.ts";
import type { ModelCacheStore } from "../modelCache.ts";
import { createLiveHasaCapabilityProbe } from "./hasaLiveProbe.ts";
import { HasaProvider } from "./hasaProvider.ts";
import { createHasaTransport } from "./hasaTransport.ts";

/**
 * A provider that can measure what it does not know.
 *
 * The pieces fit together in exactly one way — the capability probe needs the
 * same HTTP client the provider uses, and the matrix has to be scoped to the
 * same key and gateway — so the assembly lives here rather than at each call
 * site. A caller that has to reach into `provider.transport.client` to build
 * its own probe is a caller that will get the scoping wrong.
 */

export interface CreateHasaProviderOptions {
  apiKey: string;
  baseUrl?: string;
  /** Where the model list is remembered. Omit for memory-only. */
  cache?: ModelCacheStore;
  /** Where measured capabilities are remembered between sessions. */
  matrixPath?: string;
  logger?: Logger;
  timeoutMs?: number;
  maxRetries?: number;
  modelCacheTtlMs?: number;
}

export function createHasaProvider(opts: CreateHasaProviderOptions): HasaProvider {
  const apiKey = assertUsableApiKey(opts.apiKey);
  const transport = createHasaTransport({
    apiKey,
    ...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.maxRetries === undefined ? {} : { maxRetries: opts.maxRetries }),
    ...(opts.logger === undefined ? {} : { logger: opts.logger }),
  });

  const capabilities = createLiveHasaCapabilityProbe({
    client: transport.client,
    apiKey,
    // The matrix is only trusted when it was measured with this key against
    // this gateway; both come from the transport that will do the measuring.
    keyFingerprint: fingerprint(apiKey),
    baseUrl: transport.baseUrl,
    ...(opts.matrixPath === undefined ? {} : { path: opts.matrixPath }),
    ...(opts.logger === undefined ? {} : { logger: opts.logger }),
  });

  return new HasaProvider({
    apiKey,
    transport,
    capabilities,
    ...(opts.cache === undefined ? {} : { cache: opts.cache }),
    ...(opts.modelCacheTtlMs === undefined ? {} : { modelCacheTtlMs: opts.modelCacheTtlMs }),
    ...(opts.logger === undefined ? {} : { logger: opts.logger }),
  });
}
