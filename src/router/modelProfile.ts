import type { CapabilityDemand } from "./taskProfile.ts";

/**
 * What is known about a model, and how well it is known.
 *
 * The distinction this type exists for is between a number and the reason to
 * believe it. `coding: 0.9` measured over 120 runs and `coding: 0.9` written
 * into a config file by hand are the same number and not the same claim, and a
 * ranker that cannot tell them apart will prefer whichever was set most
 * optimistically.
 *
 * So a capability is never a bare number here. It is a `Measure`: a value, an
 * origin, and how much evidence stands behind it.
 *
 * ## Not a marketing description
 *
 * Nothing in this file reads a model's name. `qwen2.5-coder-32b` has "coder" in
 * its id and its gateway refuses tool calls; `granite-guardian` is a guard
 * model that will happily accept a coding request. The catalogue's measured
 * capabilities and the harness's own evaluation are the inputs. The id is a
 * key, not evidence.
 */

/**
 * Where a capability number came from.
 *
 * Ordered by how much the runtime itself stands behind it — see
 * `EVIDENCE_RANK`. A value from a stronger origin is not automatically more
 * *favourable*; it is more *believable*, which is what breaks a tie.
 */
export type EvidenceOrigin =
  /** The provider or gateway says so. Not measured by us. */
  | "declared"
  /** An external benchmark. Says nothing about this harness. */
  | "benchmark"
  /** Measured by `src/eval` against this harness's own scenarios. */
  | "harness_eval"
  /** Seen in real agent usage. */
  | "observed"
  /** Set by a person. Beats everything, because someone chose to. */
  | "manual";

export const EVIDENCE_RANK: Readonly<Record<EvidenceOrigin, number>> = {
  declared: 1,
  benchmark: 2,
  harness_eval: 3,
  observed: 4,
  manual: 5,
};

/**
 * One capability number, with its receipts.
 *
 * `samples` is the count of runs behind the value, and it is not decoration:
 * §25 of the brief is that `coding = 0.85` over 120 samples and `coding = 0.90`
 * over 1 are not the same knowledge. Nothing here turns that into a posterior —
 * the count is carried, and the ranker uses it for confidence and tie-breaking
 * rather than for smoothing.
 */
export interface Measure {
  value: number;
  origin: EvidenceOrigin;
  /** How many evaluation runs produced this. Zero for a declaration. */
  samples: number;
  /** ISO timestamp, when the source recorded one. */
  updatedAt?: string;
}

export function measure(
  value: number,
  origin: EvidenceOrigin,
  samples = 0,
  updatedAt?: string,
): Measure {
  return { value, origin, samples, ...(updatedAt === undefined ? {} : { updatedAt }) };
}

/**
 * Which of two measures of the same capability to keep.
 *
 * A stronger origin wins; within an origin, more samples win. Deliberately not
 * an average: averaging a declaration with an evaluation produces a number that
 * neither source would stand behind, and buries the fact that they disagreed.
 */
export function preferMeasure(a: Measure | undefined, b: Measure | undefined): Measure | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const rankA = EVIDENCE_RANK[a.origin];
  const rankB = EVIDENCE_RANK[b.origin];
  if (rankA !== rankB) return rankA > rankB ? a : b;
  return a.samples >= b.samples ? a : b;
}

/** How a model can be asked to call tools. Mirrors `autoModel.protocolFor`. */
export type ToolProtocol = "native" | "text";

export interface ModelAvailability {
  available: boolean;
  /** Null when the model cannot drive the loop at all — an embedding endpoint. */
  protocol: ToolProtocol | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  /** True only when native tool calling was measured, not assumed. */
  supportsNativeTools: boolean;
}

export interface ModelEfficiency {
  /** Mean model calls per task. Lower is better. From `src/eval` Efficiency. */
  modelCalls?: Measure;
  /** Mean tool calls per task. Lower is better. */
  toolCalls?: Measure;
}

export interface ModelProfile {
  modelId: string;
  availability: ModelAvailability;
  /** Sparse on purpose: an absent capability is unknown, not zero. */
  capabilities: Partial<Record<keyof CapabilityDemand, Measure>>;
  efficiency: ModelEfficiency;
  /** For a future semantic matcher. Never read as evidence of capability. */
  semanticDescription: string;
  evidence: {
    /** Total evaluation runs behind this profile. Zero means cold start. */
    evalSampleCount: number;
    updatedAt?: string;
  };
}

/**
 * How much of what this task needs is actually known about this model.
 *
 * Not a quality score — a coverage one. A model with no evaluation data is a
 * legitimate candidate (§24, §33) and this is how a recommendation says so
 * rather than hiding it behind a number that looks measured.
 */
export function evidenceConfidence(
  profile: ModelProfile,
  needed: readonly (keyof CapabilityDemand)[],
): { known: number; total: number; ratio: number; coldStart: boolean } {
  const total = needed.length;
  const known = needed.filter((key) => profile.capabilities[key] !== undefined).length;
  return {
    known,
    total,
    ratio: total === 0 ? 1 : known / total,
    coldStart: profile.evidence.evalSampleCount === 0,
  };
}
