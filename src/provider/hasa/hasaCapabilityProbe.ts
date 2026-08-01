import type {
  CapabilityMatrix,
  CapabilityStatus,
  Eligibility,
  ModelReport,
} from "../../protocol/index.ts";
import type { CapabilityState, ModelCapabilities, ModelLimits } from "../types.ts";
import { unknownCapabilities } from "../types.ts";

/**
 * Capability lookup: lazy, cached, and never a guess.
 *
 * Two rules from the product brief meet here.
 *
 * §11 — capabilities are not inferred from model names. A catalogue mixes chat,
 * coding, embedding, reranking and vision models, and `qwen2.5-coder-32b` looks
 * like the ideal agent model right up until the gateway rejects every
 * `tool_choice` because vLLM was started without `--tool-call-parser`
 * (docs/compatibility-matrix.md §8.3). The name was never the evidence.
 *
 * §12 — the probe is lazy. Extension startup must not fire an inference request
 * at every model in the catalogue; that is 19 requests against shared GPUs to
 * populate a dropdown. So `capabilitiesOf` only ever reads what has already
 * been measured, and `ensure` is the explicit, per-model escalation.
 *
 * The measuring itself is not reimplemented here — `src/probe/` already does it
 * and is what produced the recorded matrix. This class is the cache in front.
 */

/** Runs the real probe. Injected so this file stays free of HTTP concerns. */
export type CapabilityProbeFn = (
  modelIds: string[],
  signal?: AbortSignal,
) => Promise<CapabilityMatrix>;

export interface HasaCapabilityProbeOptions {
  /** Reads the stored matrix. Returning null simply means "nothing measured". */
  load: () => Promise<CapabilityMatrix | null>;
  probe?: CapabilityProbeFn;
  /** Persists a freshly probed matrix. Absent means probe results are in-memory. */
  save?: (matrix: CapabilityMatrix) => Promise<void>;
}

/**
 * `pass` is the only thing that proves a capability, and `fail` the only thing
 * that disproves one.
 *
 * `denied` is a 403 — the key cannot reach the model, so nothing was learned
 * about it. `skipped` means a prerequisite probe failed. `unknown` means the
 * request never completed. Folding any of those into `false` would record a
 * permission or an outage as a model deficiency, permanently.
 */
export function stateOf(status: CapabilityStatus | undefined): CapabilityState {
  if (status === "pass") return true;
  if (status === "fail") return false;
  return "unknown";
}

function and(...states: CapabilityState[]): CapabilityState {
  if (states.some((s) => s === false)) return false;
  if (states.some((s) => s === "unknown")) return "unknown";
  return true;
}

export function capabilitiesFromReport(report: ModelReport): ModelCapabilities {
  const caps = report.capabilities;
  const chat = stateOf(caps["chat"]?.status);
  const streaming = stateOf(caps["stream"]?.status);
  const toolCalling = stateOf(caps["tools"]?.status);
  const roundtrip = stateOf(caps["tools_roundtrip"]?.status);
  return {
    chat,
    streaming,
    toolCalling,
    // "Can drive an agent loop", not "was trained on code". A model that cannot
    // consume a tool result cannot take a second step, whatever its name says.
    coding: and(chat, streaming, toolCalling, roundtrip),
    reasoning: stateOf(caps["reasoning_content"]?.status),
    vision: stateOf(caps["vision"]?.status),
    // The probe never calls /v1/embeddings or /rerank, so it has no opinion.
    embedding: "unknown",
    reranking: "unknown",
  };
}

export function limitsFromReport(report: ModelReport): ModelLimits {
  return {
    maxOutputTokens: report.limits.observedMaxOutputTokens,
    contextWindow: report.limits.observedContextWindow,
  };
}

export class HasaCapabilityProbe {
  private readonly opts: HasaCapabilityProbeOptions;
  private matrix: CapabilityMatrix | null = null;
  private loaded = false;
  private loading: Promise<CapabilityMatrix | null> | null = null;

  constructor(opts: HasaCapabilityProbeOptions) {
    this.opts = opts;
  }

  private async matrixOnce(): Promise<CapabilityMatrix | null> {
    if (this.loaded) return this.matrix;
    if (this.loading === null) {
      this.loading = this.opts
        .load()
        .catch(() => null)
        .then((matrix) => {
          this.matrix = matrix;
          this.loaded = true;
          this.loading = null;
          return matrix;
        });
    }
    return this.loading;
  }

  private reportOf(matrix: CapabilityMatrix | null, modelId: string): ModelReport | null {
    return matrix?.models.find((m) => m.modelId === modelId) ?? null;
  }

  /** Reads measured capabilities. Never sends a request. */
  async capabilitiesOf(modelId: string): Promise<ModelCapabilities> {
    const report = this.reportOf(await this.matrixOnce(), modelId);
    return report === null ? unknownCapabilities() : capabilitiesFromReport(report);
  }

  async limitsOf(modelId: string): Promise<ModelLimits> {
    const report = this.reportOf(await this.matrixOnce(), modelId);
    return report === null
      ? { maxOutputTokens: null, contextWindow: null }
      : limitsFromReport(report);
  }

  async eligibilityOf(modelId: string): Promise<Eligibility | null> {
    return this.reportOf(await this.matrixOnce(), modelId)?.eligibility ?? null;
  }

  /**
   * Measures a model, but only if it has not been measured and a probe exists.
   *
   * This is the escalation path: one model, on demand, because something is
   * about to use it. Calling it for a whole catalogue is possible and is exactly
   * what §12 forbids doing at startup.
   */
  async ensure(modelId: string, signal?: AbortSignal): Promise<ModelCapabilities> {
    const existing = this.reportOf(await this.matrixOnce(), modelId);
    if (existing !== null) return capabilitiesFromReport(existing);
    if (this.opts.probe === undefined) return unknownCapabilities();

    const probed = await this.opts.probe([modelId], signal);
    this.merge(probed);
    // Persisting is a convenience; failing to persist must not lose the result
    // we just paid a live request for.
    await this.opts.save?.(probed).catch(() => {});
    const report = this.reportOf(this.matrix, modelId);
    return report === null ? unknownCapabilities() : capabilitiesFromReport(report);
  }

  /** Replaces reports for the probed models, keeping everything else. */
  private merge(probed: CapabilityMatrix): void {
    if (this.matrix === null) {
      this.matrix = probed;
      this.loaded = true;
      return;
    }
    const byId = new Map(this.matrix.models.map((m) => [m.modelId, m]));
    for (const report of probed.models) byId.set(report.modelId, report);
    this.matrix = { ...probed, models: [...byId.values()] };
    this.loaded = true;
  }

  invalidate(): void {
    this.matrix = null;
    this.loaded = false;
    this.loading = null;
  }
}

/** A probe that has measured nothing. Every model comes back `unknown`. */
export function emptyCapabilityProbe(): HasaCapabilityProbe {
  return new HasaCapabilityProbe({ load: async () => null });
}
