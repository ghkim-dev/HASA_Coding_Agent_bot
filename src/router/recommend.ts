import { filterEligible, type FilteredModel } from "./eligibility.ts";
import { evidenceConfidence, type ModelProfile } from "./modelProfile.ts";
import { CAPABILITY_KEYS, type CapabilityDemand, type TaskProfile } from "./taskProfile.ts";

/**
 * Which model should do this task, and why.
 *
 * Four scores, kept apart on purpose. The brief's §40 asks for a breakdown
 * rather than one opaque number, and the reason is the question §17 has to be
 * able to answer: *why did B lose?* "Its score was 0.71" is not an answer.
 * "Its recovery evaluation was weaker, and this task needs recovery" is.
 *
 * So nothing here collapses until the last step, and the parts survive into the
 * result.
 *
 *   Final = w1·semantic + w2·capability + w3·evaluation + w4·efficiency
 *
 * Embedding similarity is *one of four*, never the answer. A model that reads
 * as a perfect textual match for a task it cannot execute should lose, and it
 * does — its capability and evaluation terms are what carry that.
 *
 * ## What this is not
 *
 * This is not a production ranking. The weights are a starting calibration and
 * the semantic term is a stub until the next slice supplies a real matcher.
 * What is settled is the *shape*: the terms, their independence, the breakdown,
 * and the determinism. Those are what the next slice plugs into.
 */

/** Replaceable, so the next slice can supply embeddings without touching this. */
export interface SemanticMatcher {
  score(task: TaskProfile, model: ModelProfile): Promise<number>;
}

/**
 * The matcher used when none is supplied.
 *
 * Returns a constant rather than a keyword overlap. A lexical stand-in would
 * produce a number that moves with the wording of a description and looks like
 * a measurement of fit — and every test written against it would then encode
 * that accident. A constant is visibly not an answer, which is the honest state
 * until there is an embedding space.
 */
export const NEUTRAL_SEMANTIC_SCORE = 0.5;

export const neutralMatcher: SemanticMatcher = {
  score: async () => NEUTRAL_SEMANTIC_SCORE,
};

export interface ScoreBreakdown {
  /** How well the model's description matches the task's. Stubbed for now. */
  semantic: number;
  /** Demanded capabilities against measured ones, weighted by demand. */
  capability: number;
  /** What this harness's own scenarios measured, on the capabilities that matter. */
  evaluation: number;
  /** Fewer model calls for the same work, when speed or cost is preferred. */
  efficiency: number;
  /** Weighted sum of the four. */
  total: number;
}

export interface RankedModel {
  modelId: string;
  score: number;
  breakdown: ScoreBreakdown;
  /** How much of what this task needs is actually known about this model. */
  confidence: {
    known: number;
    total: number;
    ratio: number;
    coldStart: boolean;
  };
}

export interface RecommendationReason {
  /** Machine-readable, so an event can carry it and a test can assert on it. */
  code:
    | "HIGH_DEMAND_MET"
    | "HIGH_DEMAND_UNMET"
    | "EVALUATION_ADVANTAGE"
    | "EVALUATION_UNAVAILABLE"
    | "EFFICIENCY_PREFERRED"
    | "CONSTRAINT_FOLLOWING_CRITICAL"
    | "ONLY_CANDIDATE";
  /** The capability or constraint this is about, when it is about one. */
  subject?: string;
  detail: string;
}

export interface ModelRecommendation {
  selected: RankedModel | null;
  /**
   * Candidates the score cannot separate from the selected one.
   *
   * Present only when there are any. A tie is a fact about the evidence, not a
   * defect in the ranker — on a gateway nobody has evaluated, every model
   * scores the same default and the winner is decided by sort order. A caller
   * that shows the pick without showing this is reporting an arbitrary choice
   * as a finding.
   */
  tiedWith?: string[];
  /** Everything else that survived the filter, in rank order. */
  alternatives: RankedModel[];
  taskProfileId: string;
  reasons: RecommendationReason[];
  filteredOut: FilteredModel[];
  /** Which weighting produced this ranking. Stored with the decision. */
  policyId: string;
  /** Set when nothing survived, so a caller can say why rather than "none". */
  unavailableReason?: string;
}

/**
 * How close two scores must be to count as the same.
 *
 * Small, because the scores are sums of weighted measures in [0,1] and a real
 * difference is visible in the third decimal. This is not a smoothing
 * parameter: it exists to catch scores that are equal, including the ones that
 * arrive equal through different arithmetic.
 */
const TIE_EPSILON = 1e-9;

/** How the four terms combine. Named so a test can state which one it varies. */
export interface RouterWeights {
  semantic: number;
  capability: number;
  evaluation: number;
  efficiency: number;
}

/**
 * The weights in force when no policy is named.
 *
 * Kept as a value rather than as literals inside the sum, and mirrored by
 * `policy.ts`, which owns the versioned form. The version is what gets stored
 * with a decision — see `RouterPolicy` for why an unnamed constant makes a past
 * recommendation unexplainable.
 */
export const DEFAULT_WEIGHTS: RouterWeights = {
  semantic: 0.15,
  capability: 0.4,
  evaluation: 0.3,
  efficiency: 0.15,
};

// ---------------------------------------------------------------------------
// The terms
// ---------------------------------------------------------------------------

/** Capabilities this task actually cares about, strongest demand first. */
export function demandedCapabilities(task: TaskProfile): (keyof CapabilityDemand)[] {
  return CAPABILITY_KEYS.filter((key) => task.demands[key] > 0).sort(
    (a, b) => task.demands[b] - task.demands[a] || a.localeCompare(b),
  );
}

/**
 * Demand met by measured capability, weighted by how much it is demanded.
 *
 * An unknown capability contributes the neutral 0.5 rather than 0. Scoring
 * silence as incapacity would rank a cold-start model below one measured as
 * bad, which §24 and §33 both forbid — an unevaluated model is a candidate.
 */
function capabilityScore(task: TaskProfile, model: ModelProfile): number {
  let weighted = 0;
  let weight = 0;
  for (const key of CAPABILITY_KEYS) {
    const demand = task.demands[key];
    if (demand <= 0) continue;
    const known = model.capabilities[key];
    weighted += demand * (known?.value ?? 0.5);
    weight += demand;
  }
  return weight === 0 ? 0.5 : weighted / weight;
}

/**
 * The same question, restricted to what this harness measured itself.
 *
 * Separate from `capabilityScore` because the brief asks for evaluation to be
 * its own signal: two models can have identical declared capabilities and
 * differ entirely in what the scenarios found, and §32 requires that difference
 * to move the ranking. Only `harness_eval` and `observed` count here — a
 * declaration is not an evaluation.
 */
function evaluationScore(task: TaskProfile, model: ModelProfile): number {
  let weighted = 0;
  let weight = 0;
  for (const key of CAPABILITY_KEYS) {
    const demand = task.demands[key];
    if (demand <= 0) continue;
    const known = model.capabilities[key];
    if (known === undefined) continue;
    if (known.origin !== "harness_eval" && known.origin !== "observed") continue;
    weighted += demand * known.value;
    weight += demand;
  }
  // No evaluation on any demanded capability is neutral, not bad. The reason
  // list says so separately, which is where a cold start belongs.
  return weight === 0 ? 0.5 : weighted / weight;
}

/**
 * Whether this model does the same work in fewer calls, when that is preferred.
 *
 * Scaled by the task's own priorities: on a high-complexity task speed and cost
 * are weighted near zero, so a frugal-but-weak model cannot win on being cheap.
 */
function efficiencyScore(task: TaskProfile, model: ModelProfile): number {
  const preference = Math.max(task.priorities.speed, task.priorities.cost);
  const calls = model.efficiency.modelCalls?.value;
  if (calls === undefined) return 0.5;
  // Ten model calls is the point at which a turn is doing a lot of round
  // trips; below that scales linearly, above it floors. A calibration, and the
  // tests assert ordering rather than this constant.
  const frugality = Math.max(0, Math.min(1, 1 - calls / 10));
  return 0.5 + (frugality - 0.5) * preference;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export interface RecommendOptions {
  matcher?: SemanticMatcher;
  weights?: RouterWeights;
  /** The policy these weights came from, carried into the record. */
  policyId?: string;
}

/**
 * Ranks the eligible models and picks the first.
 *
 * Deterministic by construction: the terms are pure functions of the two
 * profiles, and ties are broken by a declared order rather than by whatever
 * `sort` happened to do. §23 asks for that explicitly, and it is also what
 * makes a recommendation replayable — the same inputs must give the same answer
 * a week later or the stored reason is fiction.
 *
 * Tie-break order, after the score:
 *   1. more of the demanded capabilities actually known
 *   2. more evaluation runs behind the profile
 *   3. the model id, so the last resort is stable rather than arbitrary
 */
export async function recommendModel(
  task: TaskProfile,
  profiles: readonly ModelProfile[],
  options: RecommendOptions = {},
): Promise<ModelRecommendation> {
  const matcher = options.matcher ?? neutralMatcher;
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const policyId = options.policyId ?? "requirement-router-v1";
  const { eligible, filteredOut } = filterEligible(profiles, task);

  if (eligible.length === 0) {
    return {
      selected: null,
      alternatives: [],
      taskProfileId: task.id,
      reasons: [],
      filteredOut,
      policyId,
      unavailableReason:
        profiles.length === 0
          ? "사용할 수 있는 모델 목록이 비어 있습니다."
          : "요구 조건을 만족하는 모델이 없습니다.",
    };
  }

  const needed = demandedCapabilities(task);
  const ranked: RankedModel[] = [];

  for (const profile of eligible) {
    const semantic = await matcher.score(task, profile);
    const capability = capabilityScore(task, profile);
    const evaluation = evaluationScore(task, profile);
    const efficiency = efficiencyScore(task, profile);
    const total =
      weights.semantic * semantic +
      weights.capability * capability +
      weights.evaluation * evaluation +
      weights.efficiency * efficiency;

    ranked.push({
      modelId: profile.modelId,
      score: total,
      breakdown: { semantic, capability, evaluation, efficiency, total },
      confidence: evidenceConfidence(profile, needed),
    });
  }

  const byId = new Map(eligible.map((p) => [p.modelId, p]));
  ranked.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.confidence.known !== b.confidence.known) return b.confidence.known - a.confidence.known;
    const samplesA = byId.get(a.modelId)?.evidence.evalSampleCount ?? 0;
    const samplesB = byId.get(b.modelId)?.evidence.evalSampleCount ?? 0;
    if (samplesA !== samplesB) return samplesB - samplesA;
    return a.modelId.localeCompare(b.modelId);
  });

  const selected = ranked[0]!;
  // Models the evidence cannot tell apart from the winner.
  //
  // On a fresh gateway every candidate is a cold start, every score is the same
  // default, and `ranked[0]` is whichever model id happened to sort first —
  // presented, with no further word, as a recommendation. Naming the tie is the
  // difference between "this one fits your work" and "nothing here
  // distinguishes these, and one had to go first".
  const tiedWith = ranked
    .slice(1)
    .filter((m) => Math.abs(m.score - selected.score) < TIE_EPSILON)
    .map((m) => m.modelId);

  return {
    selected,
    alternatives: ranked.slice(1),
    taskProfileId: task.id,
    reasons: reasonsFor(task, selected, byId.get(selected.modelId)!, ranked.length),
    filteredOut,
    policyId,
    ...(tiedWith.length === 0 ? {} : { tiedWith }),
  };
}

/**
 * Why this one.
 *
 * Built from the task's own signals rather than from the score, so a reason
 * always names something the user asked for. §35 makes this testable: a reason
 * must reference an actual `TaskProfile` signal, which is enforceable only if
 * reasons are derived from the profile rather than written as prose.
 */
function reasonsFor(
  task: TaskProfile,
  selected: RankedModel,
  profile: ModelProfile,
  candidateCount: number,
): RecommendationReason[] {
  const reasons: RecommendationReason[] = [];

  if (candidateCount === 1) {
    reasons.push({
      code: "ONLY_CANDIDATE",
      detail: "조건을 만족하는 모델이 이것 하나였습니다.",
    });
  }

  for (const key of demandedCapabilities(task)) {
    if (task.demands[key] < 0.7) continue;
    const known = profile.capabilities[key];
    if (known === undefined) continue;
    if (known.value >= 0.7) {
      reasons.push({
        code: "HIGH_DEMAND_MET",
        subject: key,
        detail: `이 작업은 ${key} 요구가 높고, 이 모델은 그 항목이 ${known.value.toFixed(2)} 입니다 (${known.origin}, ${known.samples}회).`,
      });
    } else if (known.value < 0.4) {
      reasons.push({
        code: "HIGH_DEMAND_UNMET",
        subject: key,
        detail: `이 작업은 ${key} 요구가 높은데 이 모델은 ${known.value.toFixed(2)} 입니다. 남은 후보 중에서는 최선입니다.`,
      });
    }
  }

  if (selected.breakdown.evaluation > 0.5 && !selected.confidence.coldStart) {
    reasons.push({
      code: "EVALUATION_ADVANTAGE",
      detail: `이 하네스의 시나리오 평가에서 필요한 항목들이 우세했습니다 (${profile.evidence.evalSampleCount}회 측정).`,
    });
  }
  if (selected.confidence.coldStart) {
    reasons.push({
      code: "EVALUATION_UNAVAILABLE",
      detail: "이 모델에 대한 하네스 평가 기록이 없습니다. 선언된 능력만으로 후보가 되었습니다.",
    });
  }

  // A constraint the user stated is worth naming as a reason: it is the part of
  // the request that a wrong model choice would visibly violate.
  if (task.constraints.noExecute === true || task.constraints.noModify === true) {
    reasons.push({
      code: "CONSTRAINT_FOLLOWING_CRITICAL",
      subject: "instructionFollowing",
      detail: "사용자가 하지 말라고 한 것이 있어, 지시 준수가 이 턴에서 특히 중요합니다.",
    });
  }

  if (Math.max(task.priorities.speed, task.priorities.cost) >= 0.8) {
    reasons.push({
      code: "EFFICIENCY_PREFERRED",
      detail: "작업이 가볍기 때문에 빠르고 저렴한 쪽을 우선했습니다.",
    });
  }

  return reasons;
}
