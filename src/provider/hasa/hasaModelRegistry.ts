import { nullLogger, type Logger } from "../../hasa-client/logger.ts";
import { MODEL_CACHE_VERSION, cacheScope, type CachedModelList, type ModelCacheStore } from "../modelCache.ts";
import type {
  ChatTransport,
  TransportModelRecord,
} from "../openai-compatible/openaiCompatibleProvider.ts";
import type { ModelCapabilities, ModelListOptions, ModelListing, ProviderModel } from "../types.ts";
import { unknownCapabilities } from "../types.ts";
import { mapHasaError } from "./hasaErrorMapper.ts";
import { HASA_MODEL_CACHE_TTL_MS } from "./defaults.ts";

/**
 * The model catalogue, fetched rather than declared.
 *
 * A hardcoded list is wrong for three separate reasons here, and only the first
 * is obvious. It goes stale when HASA adds or withdraws a model, which needs an
 * extension release to fix. It is also *per key*: the 2026-07-29 probe found
 * `GET /v1/models` returning 19 models while the key in hand could call 6 of
 * them. And it hides the gateway from the user — someone who cannot find
 * `qwen3-coder` in a picker has no way to learn whether the model is gone or
 * simply not on their key.
 *
 * The caching design follows Zoo Code's `fetchers/modelCache.ts`
 * (docs/hasa-coding-agent-architecture.md §4.2): memory over disk, requests
 * deduplicated while one is in flight, and a failed refresh degrading to the
 * last good list rather than to an empty picker.
 */

export interface HasaModelRegistryOptions {
  transport: ChatTransport;
  /** `sha256(key)` prefix. Scopes the cache without storing the key. */
  keyFingerprint: string;
  cache?: ModelCacheStore;
  ttlMs?: number;
  now?: () => number;
  logger?: Logger;
  /** Supplies measured capabilities. Defaults to "unknown" for every field. */
  capabilitiesOf?: (modelId: string) => ModelCapabilities;
}

interface MemoryEntry {
  models: ProviderModel[];
  fetchedAtMs: number;
  fetchedAt: string;
}

/**
 * What a picker is allowed to be shown.
 *
 * A blank id addresses nothing and would render as an empty row; a duplicate is
 * a gateway misconfiguration, but a list showing the same model twice is our
 * bug rather than theirs. Ids are filtered, never rewritten — trimming one
 * would produce an id that does not resolve.
 */
function usable(records: readonly TransportModelRecord[]): TransportModelRecord[] {
  const seen = new Set<string>();
  const out: TransportModelRecord[] = [];
  for (const record of records) {
    if (record.id.trim().length === 0 || seen.has(record.id)) continue;
    seen.add(record.id);
    out.push(record);
  }
  return out;
}

export class HasaModelRegistry {
  private readonly transport: ChatTransport;
  private readonly scope: string;
  private readonly cache: ModelCacheStore | null;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly capabilitiesOf: (modelId: string) => ModelCapabilities;

  private memory: MemoryEntry | null = null;
  /** One refresh at a time. Ten pickers opening at once make one request. */
  private inFlight: Promise<ProviderModel[]> | null = null;

  constructor(opts: HasaModelRegistryOptions) {
    this.transport = opts.transport;
    this.scope = cacheScope(opts.transport.baseUrl, opts.keyFingerprint);
    this.cache = opts.cache ?? null;
    this.ttlMs = opts.ttlMs ?? HASA_MODEL_CACHE_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.logger ?? nullLogger;
    this.capabilitiesOf = opts.capabilitiesOf ?? ((): ModelCapabilities => unknownCapabilities());
  }

  private toModel(record: TransportModelRecord): ProviderModel {
    return {
      id: record.id,
      ownedBy: record.ownedBy,
      capabilities: this.capabilitiesOf(record.id),
      limits: { maxOutputTokens: null, contextWindow: null },
    };
  }

  private fromCache(entry: CachedModelList): ProviderModel[] {
    return usable(entry.models).map((m) => this.toModel(m));
  }

  async list(opts: ModelListOptions = {}): Promise<ModelListing> {
    // A negative age means the clock moved backwards — an NTP correction, or a
    // laptop waking up. Reading that as "very fresh" would pin a stale
    // catalogue for as long as the skew lasts, so it counts as expired.
    const age = this.memory === null ? Number.NaN : this.now() - this.memory.fetchedAtMs;
    const fresh = this.memory !== null && age >= 0 && age < this.ttlMs && !opts.refresh;
    if (fresh && this.memory !== null) {
      return {
        models: this.memory.models,
        source: "cache",
        fetchedAt: this.memory.fetchedAt,
        stale: false,
        warning: null,
      };
    }

    try {
      const models = await this.refresh(opts);
      const fetchedAt = this.memory?.fetchedAt ?? new Date(this.now()).toISOString();
      return { models, source: "network", fetchedAt, stale: false, warning: null };
    } catch (err) {
      const error = mapHasaError(err);
      // An abort is the caller's decision, not an outage. Serving a stale list
      // in its place would answer a question nobody is still asking.
      if (error.code === "aborted") throw error;

      const fallback = await this.readCache();
      if (fallback === null) {
        this.log.warn("model list failed with no cache to fall back on", { code: error.code });
        throw error;
      }
      this.log.warn("serving cached model list", { code: error.code, count: fallback.models.length });
      return {
        models: this.fromCache(fallback),
        source: "cache",
        fetchedAt: fallback.fetchedAt,
        stale: true,
        warning: error.userMessage,
      };
    }
  }

  /** Drops the memory entry so the next `list` goes to the network. */
  invalidate(): void {
    this.memory = null;
  }

  private async refresh(opts: ModelListOptions): Promise<ProviderModel[]> {
    if (this.inFlight !== null) return this.inFlight;

    const request = (async (): Promise<ProviderModel[]> => {
      const transportOpts: { signal?: AbortSignal; timeoutMs?: number; maxRetries?: number } = {};
      if (opts.signal !== undefined) transportOpts.signal = opts.signal;
      if (opts.timeoutMs !== undefined) transportOpts.timeoutMs = opts.timeoutMs;
      if (opts.maxRetries !== undefined) transportOpts.maxRetries = opts.maxRetries;

      const records = usable(await this.transport.listModelRecords(transportOpts));
      const models = records.map((r) => this.toModel(r));
      const nowMs = this.now();
      const fetchedAt = new Date(nowMs).toISOString();
      this.memory = { models, fetchedAtMs: nowMs, fetchedAt };

      // An empty catalogue is reported as empty, but never written over a good
      // cache: a gateway that briefly answers `{"data": []}` would otherwise
      // erase the only list the user has left when it goes down for real.
      if (this.cache !== null && models.length > 0) {
        const entry: CachedModelList = {
          version: MODEL_CACHE_VERSION,
          scope: this.scope,
          fetchedAt,
          // Ids and owners only. There is no field here that could hold a key.
          models: records.map((r) => ({ id: r.id, ownedBy: r.ownedBy })),
        };
        // The cache is an optimisation and a fallback. A store that cannot
        // write — a full disk, a read-only volume — must not turn a successful
        // model list into a failed one.
        try {
          await this.cache.write(entry);
        } catch {
          this.log.warn("could not persist the model list", { count: models.length });
        }
      }
      return models;
    })();

    this.inFlight = request;
    try {
      return await request;
    } finally {
      this.inFlight = null;
    }
  }

  private async readCache(): Promise<CachedModelList | null> {
    if (this.cache === null) return null;
    try {
      return await this.cache.read(this.scope);
    } catch {
      return null;
    }
  }
}
