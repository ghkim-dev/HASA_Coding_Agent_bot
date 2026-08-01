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
  /**
   * The matrix, keyed for lookup.
   *
   * Scanning the array per model made `listModels` quadratic: a catalogue and a
   * matrix of the same size cost n² comparisons, and the picker does two
   * lookups per entry. Measured at 4 000 models: 112 ms, against 9 ms at 1 000.
   * HASA lists 19 today, so this is prevention rather than repair — but the
   * path runs every time a panel opens.
   */
  private index: Map<string, ModelReport> | null = null;
  private loaded = false;
  private loading: Promise<CapabilityMatrix | null> | null = null;
  /** Bumped by `invalidate`, so a load in flight cannot land on top of it. */
  private generation = 0;
  /** One live probe per model, however many callers are waiting on it. */
  private readonly probing = new Map<string, Promise<ModelCapabilities>>();

  constructor(opts: HasaCapabilityProbeOptions) {
    this.opts = opts;
  }

  private async matrixOnce(): Promise<CapabilityMatrix | null> {
    if (this.loaded) return this.matrix;
    if (this.loading === null) {
      const generation = this.generation;
      this.loading = this.opts
        .load()
        .catch(() => null)
        .then((matrix) => {
          // `invalidate` ran while this load was outstanding. Storing the
          // result now would resurrect the matrix the caller just discarded —
          // and the caller discarded it because they knew it was wrong.
          if (generation !== this.generation) return matrix;
          this.setMatrix(matrix);
          this.loading = null;
          return matrix;
        });
    }
    return this.loading;
  }

  /** Stores a matrix and rebuilds its index. The only writer of either. */
  private setMatrix(matrix: CapabilityMatrix | null): void {
    this.matrix = matrix;
    this.loaded = true;
    if (matrix === null) {
      this.index = null;
      return;
    }
    const index = new Map<string, ModelReport>();
    // First entry wins, matching what a linear scan would have found. A matrix
    // with a repeated model is malformed either way; changing which duplicate
    // is believed would be a silent behaviour change.
    for (const report of matrix.models) {
      if (!index.has(report.modelId)) index.set(report.modelId, report);
    }
    this.index = index;
  }

  private reportOf(matrix: CapabilityMatrix | null, modelId: string): ModelReport | null {
    if (matrix === null) return null;
    // A matrix handed in from outside the cache (mid-invalidate) has no index.
    if (matrix !== this.matrix || this.index === null) {
      return matrix.models.find((m) => m.modelId === modelId) ?? null;
    }
    return this.index.get(modelId) ?? null;
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

    const probe = this.opts.probe;
    if (probe === undefined) return unknownCapabilities();

    // Every probe is a live inference request against a shared GPU backend. Ten
    // components asking about the same model as a panel opens must not become
    // ten requests.
    const inFlight = this.probing.get(modelId);
    if (inFlight !== undefined) return inFlight;

    const run = (async (): Promise<ModelCapabilities> => {
      const probed = await probe([modelId], signal);
      this.merge(probed);
      try {
        // Persisting is a convenience; failing to persist must not lose the
        // result we just paid a live request for. The try covers a synchronous
        // throw as well as a rejection — a `.catch` alone would miss the former.
        await this.opts.save?.(probed);
      } catch {
        /* the measurement is already merged in memory */
      }
      const report = this.reportOf(this.matrix, modelId);
      return report === null ? unknownCapabilities() : capabilitiesFromReport(report);
    })();

    this.probing.set(modelId, run);
    try {
      return await run;
    } finally {
      // Removed on failure too: an outage during one probe must not mark the
      // model permanently unmeasurable.
      this.probing.delete(modelId);
    }
  }

  /** Replaces reports for the probed models, keeping everything else. */
  private merge(probed: CapabilityMatrix): void {
    if (this.matrix === null) {
      this.setMatrix(probed);
      return;
    }
    const byId = new Map(this.matrix.models.map((m) => [m.modelId, m]));
    for (const report of probed.models) byId.set(report.modelId, report);
    this.setMatrix({ ...probed, models: [...byId.values()] });
  }

  invalidate(): void {
    this.generation += 1;
    this.matrix = null;
    this.index = null;
    this.loaded = false;
    this.loading = null;
  }
}

/** A probe that has measured nothing. Every model comes back `unknown`. */
export function emptyCapabilityProbe(): HasaCapabilityProbe {
  return new HasaCapabilityProbe({ load: async () => null });
}
