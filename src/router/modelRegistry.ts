import { protocolFor } from "../agent/autoModel.ts";
import type { ProviderModel } from "../provider/types.ts";
import {
  measure,
  preferMeasure,
  type Measure,
  type ModelProfile,
} from "./modelProfile.ts";
import type { CapabilityDemand } from "./taskProfile.ts";
import { DEFAULT_POOL, roleIsWorker, type WorkerPool } from "./semanticProfile.ts";
import { poolEffectFor, semanticProfileFor } from "./modelSemanticCatalog.ts";

/**
 * Where a `ModelProfile` comes from.
 *
 * Two sources, kept separate all the way through. The catalogue says what a
 * model *is* — reachable, how it takes tools, how much context. The evaluator
 * says how it *behaved* on this harness's own scenarios. Neither overwrites the
 * other silently: `preferMeasure` decides, and it prefers the stronger origin
 * rather than the newer write.
 *
 * ## Reference models are not model data
 *
 * §11 of the brief draws this line and it is worth restating in code. The four
 * `reference:*` models exist to check that the evaluator itself detects what it
 * claims to detect. They are fixtures with hand-written behaviour. Turning
 * `reference:stubborn`'s scores into a `ModelProfile` would be benchmarking a
 * test double, so `profilesFromEvaluation` refuses them by name prefix.
 */

/** The prefix the evaluator's calibration fixtures use. */
export const REFERENCE_PREFIX = "reference:";

export function isReferenceModel(modelId: string): boolean {
  return modelId.startsWith(REFERENCE_PREFIX);
}

/**
 * What the catalogue alone can say about a model.
 *
 * Everything here is `declared`: the gateway reported it, or a probe measured a
 * tristate. None of it is evidence about how the model behaves in a turn, and
 * labelling it as such is what keeps a confident-sounding catalogue from
 * outranking a real evaluation.
 */
export function profileFromCatalogue(
  model: ProviderModel,
  options: {
    available?: boolean;
    semanticDescription?: string;
    pool?: WorkerPool;
    /** False when something knows this model does not serve chat. */
    converses?: boolean;
  } = {},
): ModelProfile {
  const protocol = protocolFor(model.capabilities);
  const capabilities: Partial<Record<keyof CapabilityDemand, Measure>> = {};

  // Only the tristates that were actually measured become capabilities. An
  // `unknown` stays absent — the ranker treats absence as "not known", which is
  // different from and better than a zero.
  if (model.capabilities.coding === true) capabilities.coding = measure(0.75, "declared");
  if (model.capabilities.coding === false) capabilities.coding = measure(0.25, "declared");
  if (model.capabilities.reasoning === true) capabilities.reasoning = measure(0.75, "declared");
  if (model.capabilities.reasoning === false) capabilities.reasoning = measure(0.25, "declared");
  if (model.capabilities.toolCalling === true) {
    capabilities.toolUse = measure(0.75, "declared");
    capabilities.commandExecution = measure(0.7, "declared");
  }
  if (model.capabilities.toolCalling === false) {
    // Not incapable — driven through the text protocol instead. Scored below
    // neutral because that path is slower and occasionally needs a retry, and
    // above the floor because it works.
    capabilities.toolUse = measure(0.45, "declared");
    capabilities.commandExecution = measure(0.45, "declared");
  }

  // What the model is deployed to be, from the curated table. Absent when
  // nobody has written it up, which the filter treats as "unknown" rather than
  // as permission or refusal.
  const semantic = semanticProfileFor(model.id).profile;
  const pool = options.pool ?? DEFAULT_POOL;
  const effect = poolEffectFor(model.id, pool);

  return {
    modelId: model.id,
    availability: {
      available: options.available ?? true,
      // Evidence that a model does not converse outranks a probe that never
      // ran. `protocolFor` answers `text` for an unmeasured model, which is
      // right for a chat model nobody has probed and wrong for a video
      // endpoint — and it produced a live candidate list containing four
      // quantum simulators, an OCR model and a text-to-speech model.
      //
      //     unknown  ≠  text-capable
      //
      // So a caller that knows better says so, and `null` here becomes
      // `CANNOT_CONVERSE` in the filter.
      protocol: options.converses === false ? null : protocol,
      contextWindow: model.limits.contextWindow,
      maxOutputTokens: model.limits.maxOutputTokens,
      supportsNativeTools: model.capabilities.toolCalling === true,
    },
    ...(semantic === null
      ? {}
      : {
          intendedUse: {
            role: semantic.role,
            workerEligible: roleIsWorker(semantic.role),
            evidenceStatus: effect.evidence,
            routingEffect: effect.effect,
            poolExclusionReason: effect.reason,
            source: semantic.provenance.source,
            ...(semantic.provenance.verifiedAt === undefined
              ? {}
              : { verifiedAt: semantic.provenance.verifiedAt }),
            reviewed: semantic.provenance.reviewed,
          },
        }),
    capabilities,
    efficiency: {},
    semanticDescription: options.semanticDescription ?? describeFromCatalogue(model),
    evidence: { evalSampleCount: 0 },
  };
}

/**
 * A description built from measured facts, not from the id.
 *
 * The id is deliberately not in the text. `qwen2.5-coder-32b` reads as a coding
 * model and its deployment refuses tool calls; letting that string into a
 * future embedding would put the marketing back into the ranking through the
 * one door this design closed.
 */
function describeFromCatalogue(model: ProviderModel): string {
  const parts: string[] = [];
  if (model.capabilities.coding === true) parts.push("코드 작성이 확인된 모델");
  if (model.capabilities.reasoning === true) parts.push("추론이 확인된 모델");
  if (model.capabilities.toolCalling === true) parts.push("네이티브 도구 호출 지원");
  if (model.capabilities.toolCalling === false) parts.push("도구 호출은 텍스트 프로토콜로 동작");
  if (model.limits.contextWindow !== null) parts.push(`컨텍스트 ${model.limits.contextWindow} 토큰`);
  return parts.length === 0 ? "측정된 정보가 없는 모델" : parts.join(", ");
}

/**
 * The evaluator's own numbers, as this harness measured them.
 *
 * Deliberately a narrow, named mapping rather than a loop over whatever the
 * metrics object happens to contain. A metric becomes a capability only when
 * someone decided it means that capability, and writing that decision down is
 * the difference between a profile and a pile of numbers.
 */
export interface EvaluationSummary {
  modelId: string;
  /** Runs behind these numbers. One run is not a measurement — §12. */
  sampleCount: number;
  /**
   * Runs behind each individual number, when they differ.
   *
   * They usually do. A sweep asks every scenario for requirement recall and only
   * two of them for recovery, so one `sampleCount` would have to overstate the
   * recovery figure or understate the recall one. Absent means "same as
   * `sampleCount`", which is true of a sweep where every scenario tests
   * everything and of nothing else.
   */
  sampleCounts?: Partial<Record<keyof EvaluationMetrics, number>>;
  updatedAt?: string;
  metrics: EvaluationMetrics;
}

export interface EvaluationMetrics {
  /** Understanding.requirementRecall — did it capture what was asked. */
  requirementRecall?: number;
  /** ActionQuality.firstActionCorrect / firstActionChecked. */
  firstActionAccuracy?: number;
  /** 1 − invalid invocation rate. Higher is better. */
  invocationValidity?: number;
  /** Recovery.recoveryRate. */
  recoveryRate?: number;
  /** Containment.containmentRate — did it hold when the model misbehaved. */
  containmentRate?: number;
  /** Outcome.sourceFactRecall. */
  sourceFactRecall?: number;
  /** Efficiency.modelCalls, a mean. Lower is better. */
  meanModelCalls?: number;
  /** Efficiency.toolCalls, a mean. Lower is better. */
  meanToolCalls?: number;
}

/** Below this, a number is an anecdote rather than a measurement. See §12. */
export const MIN_SAMPLES_FOR_EVIDENCE = 3;

/**
 * Folds an evaluation into a profile.
 *
 * Refuses two things, loudly rather than quietly. A reference model is a test
 * double and never becomes model data. A summary with too few runs is kept as
 * `declared` rather than `harness_eval` — the number survives, its authority
 * does not, so a single lucky run cannot outrank a hundred measured ones.
 */
export function applyEvaluation(profile: ModelProfile, summary: EvaluationSummary): ModelProfile {
  if (isReferenceModel(summary.modelId)) return profile;

  const trusted = summary.sampleCount >= MIN_SAMPLES_FOR_EVIDENCE;
  const at = summary.updatedAt;
  const m = summary.metrics;

  // Per metric, because they are not equally observed. A sweep that challenged
  // recovery twice and requirement recall eight times has measured one and
  // sampled the other, and one `sampleCount` cannot say both.
  const countOf = (key: keyof EvaluationMetrics): number =>
    summary.sampleCounts?.[key] ?? summary.sampleCount;

  const from = (value: number | undefined, key: keyof EvaluationMetrics): Measure | undefined => {
    if (value === undefined) return undefined;
    const n = countOf(key);
    return measure(clamp(value), n >= MIN_SAMPLES_FOR_EVIDENCE ? "harness_eval" : "declared", n, at);
  };

  const capabilities = { ...profile.capabilities };
  const set = (key: keyof CapabilityDemand, value: Measure | undefined): void => {
    const merged = preferMeasure(capabilities[key], value);
    if (merged !== undefined) capabilities[key] = merged;
  };

  set("instructionFollowing", from(m.requirementRecall, "requirementRecall"));
  set("recovery", from(m.recoveryRate, "recoveryRate"));
  set("sourceGrounding", from(m.sourceFactRecall, "sourceFactRecall"));
  // First-action accuracy is about choosing the right tool for the request,
  // which is what tool use means here — not whether the call parsed.
  set("toolUse", from(m.firstActionAccuracy, "firstActionAccuracy"));
  // Invocation validity is about writing a command that means something, which
  // is the failure `commandSemantics.ts` exists for.
  set("commandExecution", from(m.invocationValidity, "invocationValidity"));
  // Containment is the harness holding, not the model behaving — it belongs to
  // debugging only in the sense that a model which recovers is one that can be
  // debugged with. Kept out of `capabilities` for that reason and left to the
  // evaluator's own report.

  return {
    ...profile,
    capabilities,
    efficiency: {
      ...profile.efficiency,
      // Not clamped: these are call counts, not rates, and squeezing a mean of
      // 14 tool calls into [0,1] would turn a measurement into a 1.
      ...(m.meanModelCalls === undefined
        ? {}
        : { modelCalls: rawMeasure(m.meanModelCalls, countOf("meanModelCalls"), at) }),
      ...(m.meanToolCalls === undefined
        ? {}
        : { toolCalls: rawMeasure(m.meanToolCalls, countOf("meanToolCalls"), at) }),
    },
    evidence: {
      evalSampleCount: trusted
        ? profile.evidence.evalSampleCount + summary.sampleCount
        : profile.evidence.evalSampleCount,
      ...(at === undefined ? {} : { updatedAt: at }),
    },
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** A measure that keeps its own scale, with authority from its own sample count. */
function rawMeasure(value: number, n: number, at: string | undefined): Measure {
  return measure(value, n >= MIN_SAMPLES_FOR_EVIDENCE ? "harness_eval" : "declared", n, at);
}

/**
 * The registry: a catalogue plus whatever evaluations exist for it.
 *
 * A model with no evaluation is still in the list, with `evalSampleCount: 0`.
 * §24 and §33 both require that, and the recommendation says so through
 * `EVALUATION_UNAVAILABLE` rather than by omitting the candidate.
 */
export function buildRegistry(
  models: readonly ProviderModel[],
  evaluations: readonly EvaluationSummary[] = [],
  options: {
    unavailable?: readonly string[];
    pool?: WorkerPool;
    /**
     * What is known about whether each model serves the chat endpoint.
     *
     * Supplied by the caller because the evidence lives outside this module:
     * the portal catalogue publishes a modality, and an invocation probe
     * settles it outright. Absent means unknown, and unknown stays a
     * candidate — what must not happen is unknown being read as yes.
     */
    converses?: ReadonlyMap<string, boolean>;
  } = {},
): ModelProfile[] {
  const unavailable = new Set(options.unavailable ?? []);
  const byModel = new Map<string, EvaluationSummary[]>();
  for (const summary of evaluations) {
    if (isReferenceModel(summary.modelId)) continue;
    const list = byModel.get(summary.modelId) ?? [];
    list.push(summary);
    byModel.set(summary.modelId, list);
  }

  return models.map((model) => {
    let profile = profileFromCatalogue(model, {
      available: !unavailable.has(model.id),
      ...(options.pool === undefined ? {} : { pool: options.pool }),
      ...(options.converses?.has(model.id) === true
        ? { converses: options.converses.get(model.id)! }
        : {}),
    });
    for (const summary of byModel.get(model.id) ?? []) {
      profile = applyEvaluation(profile, summary);
    }
    return profile;
  });
}
