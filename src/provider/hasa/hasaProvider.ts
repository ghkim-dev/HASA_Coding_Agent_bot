import { fingerprint, registerSecret } from "../../hasa-client/redact.ts";
import { nullLogger, type Logger } from "../../hasa-client/logger.ts";
import type { ModelCacheStore } from "../modelCache.ts";
import { OpenAiCompatibleProvider, type ChatTransport } from "../openai-compatible/openaiCompatibleProvider.ts";
import { assertUsableApiKey } from "../credentials.ts";
import type { ProviderError } from "../errors.ts";
import type {
  ModelListOptions,
  ModelListing,
  ProviderModel,
  ProviderRequestOptions,
  ProviderValidation,
  Tristate,
} from "../types.ts";
import {
  HASA_DISPLAY_NAME,
  HASA_PROVIDER_ID,
  HASA_VALIDATION_MODEL_ATTEMPTS,
  HASA_VALIDATION_TIMEOUT_MS,
} from "./defaults.ts";
import { HasaCapabilityProbe, emptyCapabilityProbe } from "./hasaCapabilityProbe.ts";
import { mapHasaError, mapHasaErrorDetailed } from "./hasaErrorMapper.ts";
import { HasaModelRegistry } from "./hasaModelRegistry.ts";
import { createHasaTransport, type HasaTransportOptions } from "./hasaTransport.ts";

/**
 * HASA as a first-class provider.
 *
 * The user connects with one API key. Base URL, endpoint paths, auth scheme and
 * the model catalogue are the provider's business, not theirs — which is the
 * difference between this and pointing a generic "OpenAI-compatible" provider at
 * a URL and hoping. See §8 of the product brief.
 */

export interface HasaProviderOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injected in tests. Otherwise built from `apiKey` over `HasaClient`. */
  transport?: ChatTransport;
  cache?: ModelCacheStore;
  capabilities?: HasaCapabilityProbe;
  modelCacheTtlMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  logger?: Logger;
  now?: () => number;
  fetchImpl?: HasaTransportOptions["fetchImpl"];
}

export class HasaProvider extends OpenAiCompatibleProvider {
  readonly keyFingerprint: string;
  readonly capabilities: HasaCapabilityProbe;
  private readonly registry: HasaModelRegistry;
  private readonly log: Logger;

  constructor(opts: HasaProviderOptions) {
    const apiKey = assertUsableApiKey(opts.apiKey);
    // Registering before the first request means every later log line, error
    // message and body snippet has the key stripped, whoever writes it.
    registerSecret(apiKey);

    const transport =
      opts.transport ??
      createHasaTransport({
        apiKey,
        ...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
        ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
        ...(opts.maxRetries === undefined ? {} : { maxRetries: opts.maxRetries }),
        ...(opts.logger === undefined ? {} : { logger: opts.logger }),
        ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
      });

    super({ id: HASA_PROVIDER_ID, displayName: HASA_DISPLAY_NAME, transport });

    this.keyFingerprint = fingerprint(apiKey);
    this.capabilities = opts.capabilities ?? emptyCapabilityProbe();
    this.log = opts.logger ?? nullLogger;
    this.registry = new HasaModelRegistry({
      transport,
      keyFingerprint: this.keyFingerprint,
      ...(opts.cache === undefined ? {} : { cache: opts.cache }),
      ...(opts.modelCacheTtlMs === undefined ? {} : { ttlMs: opts.modelCacheTtlMs }),
      ...(opts.now === undefined ? {} : { now: opts.now }),
      logger: this.log,
    });
  }

  async listModels(opts: ModelListOptions = {}): Promise<ModelListing> {
    const listing = await this.registry.list(opts);
    // Capabilities are attached here rather than inside the registry so that a
    // cached list and a fresh one are annotated identically, and so the registry
    // stays a catalogue rather than a judge of what models are good for.
    const models = await Promise.all(
      listing.models.map(async (model) => ({
        ...model,
        capabilities: await this.capabilities.capabilitiesOf(model.id),
        limits: await this.capabilities.limitsOf(model.id),
      })),
    );
    return { ...listing, models };
  }

  /** Drops cached model lists so the next `listModels` goes to the network. */
  invalidateModels(): void {
    this.registry.invalidate();
  }

  protected mapError(err: unknown): ProviderError {
    return mapHasaError(err);
  }

  /**
   * Answers two questions, separately.
   *
   *   1. Can we reach the gateway?  → `GET /v1/models`
   *   2. Does this key work?        → an authenticated request
   *
   * They have to be separate because HASA's model list is a *public* endpoint.
   * A provider that stopped after step 1 would report "connected" for a typo'd
   * key and the user would discover the truth on their first real request.
   *
   * Step 2 then has to read the response the way HASA means it:
   *
   *   200 → the key works.
   *   401 → the key does not.
   *   403 → **the key works.** It authenticated; it simply lacks access to this
   *         model, and the body says which models it does have. Treating this
   *         as an auth failure marks a perfectly good key invalid.
   *   404 → the model is not routed. Says nothing about the key — try another.
   *   429 → the key works; the gateway is throttling.
   *   400 → the key works; the request was malformed for that model.
   *   503 / network / timeout → nothing was learned. `unknown`, not `false`.
   */
  async validate(opts: ProviderRequestOptions = {}): Promise<ProviderValidation> {
    const requestOpts: ProviderRequestOptions = {
      timeoutMs: opts.timeoutMs ?? HASA_VALIDATION_TIMEOUT_MS,
      // Validation is interactive. A user watching a spinner should not wait
      // through a retry ladder to be told their key is wrong.
      maxRetries: opts.maxRetries ?? 0,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    };

    let listing: ModelListing;
    try {
      listing = await this.listModels({ ...requestOpts, refresh: true });
    } catch (err) {
      const error = mapHasaError(err);
      return {
        endpointReachable: false,
        // A 401 from the *models* endpoint would be unusual (it is public), but
        // if a deployment does require auth there, it is still a real answer.
        credentialValid: error.code === "unauthorized" ? false : "unknown",
        modelCount: 0,
        probedModelId: null,
        allowedModels: null,
        detail: error.userMessage,
        error: error.toJSON(),
      };
    }

    if (listing.models.length === 0) {
      return {
        endpointReachable: true,
        credentialValid: "unknown",
        modelCount: 0,
        probedModelId: null,
        allowedModels: null,
        detail: "모델 목록이 비어 있어 API Key를 확인하지 못했습니다.",
        error: null,
      };
    }

    return this.probeCredential(listing, requestOpts);
  }

  private async probeCredential(
    listing: ModelListing,
    opts: ProviderRequestOptions,
  ): Promise<ProviderValidation> {
    const candidates = orderValidationCandidates(listing.models).slice(
      0,
      HASA_VALIDATION_MODEL_ATTEMPTS,
    );
    const base = {
      endpointReachable: true,
      modelCount: listing.models.length,
    };

    let lastError: ProviderError | null = null;
    let lastModelId: string | null = null;

    for (const model of candidates) {
      lastModelId = model.id;
      try {
        await this.chat(
          {
            modelId: model.id,
            messages: [{ role: "user", content: "ping" }],
            maxOutputTokens: 1,
            temperature: 0,
          },
          opts,
        );
        return {
          ...base,
          credentialValid: true,
          probedModelId: model.id,
          allowedModels: null,
          detail: `연결되었습니다. 모델 ${listing.models.length}개를 사용할 수 있습니다.`,
          error: null,
        };
      } catch (err) {
        const { error, allowedModels } = mapHasaErrorDetailed(err);
        lastError = error;

        if (error.code === "aborted") throw error;

        if (error.code === "unauthorized") {
          return {
            ...base,
            credentialValid: false,
            probedModelId: model.id,
            allowedModels: null,
            detail: error.userMessage,
            error: error.toJSON(),
          };
        }

        // Authenticated, just not for this model — which is a *pass* for the
        // credential, and the most informative outcome we get: the gateway
        // tells us which models this key may actually call.
        if (error.code === "forbidden") {
          return {
            ...base,
            credentialValid: true,
            probedModelId: model.id,
            allowedModels,
            detail:
              allowedModels === null
                ? "연결되었습니다. 일부 모델은 이 키로 사용할 수 없습니다."
                : `연결되었습니다. 사용 가능한 모델: ${allowedModels.join(", ")}`,
            error: null,
          };
        }

        if (error.code === "rate_limited" || error.code === "bad_request") {
          return {
            ...base,
            credentialValid: true,
            probedModelId: model.id,
            allowedModels: null,
            detail: "연결되었습니다.",
            error: null,
          };
        }

        // 404 means this model is not routed; another one may be. Anything else
        // (503, network, timeout) taught us nothing, and trying the next model
        // is the cheapest way to find out whether it was model-specific.
        this.log.warn("credential probe inconclusive", { model: model.id, code: error.code });
      }
    }

    return {
      ...base,
      credentialValid: "unknown",
      probedModelId: lastModelId,
      allowedModels: null,
      detail:
        lastError === null
          ? "API Key를 확인하지 못했습니다."
          : `API Key를 확인하지 못했습니다. ${lastError.userMessage}`,
      error: lastError === null ? null : lastError.toJSON(),
    };
  }
}

/**
 * Which models to spend a validation request on.
 *
 * Models already measured as chat-capable come first: they are the ones most
 * likely to answer 200, and a 200 ends the probe in one request. Models
 * measured as *not* chat-capable go last — an embedding model answers 404 on
 * `/chat/completions`, which is a wasted round trip that proves nothing.
 */
export function orderValidationCandidates(models: ProviderModel[]): ProviderModel[] {
  const rank = (state: Tristate): number => (state === true ? 0 : state === "unknown" ? 1 : 2);
  return [...models].sort((a, b) => rank(a.capabilities.chat) - rank(b.capabilities.chat));
}
