import { measure, type Measure } from "../router/modelProfile.ts";
import { MIN_SAMPLES_FOR_EVIDENCE } from "../router/modelRegistry.ts";
import type { CapabilityDemand } from "../router/taskProfile.ts";
import type { ProposerMeasurement, ProposerScore } from "./proposerMetrics.ts";

/**
 * Turns a proposer sweep into evidence the router can actually rank on.
 *
 * The router already knows how to choose a model for a task: twelve capability
 * axes, four independent scores, a five-tier evidence hierarchy. What it has
 * never had, on this gateway, is anything above tier one. `modelRegistry` turns
 * a boolean capability flag into `measure(0.75, "declared")`, and the ranker's
 * own comment says what follows — on a gateway nobody has evaluated, every
 * model scores the same default and sort order decides the winner. That is the
 * failure `modelProposer` documents about itself, one layer up.
 *
 * `proposerSweep` produced the first `harness_eval`-grade numbers for these
 * models. This is the bridge.
 *
 * ## Two capabilities, not twelve
 *
 * The sweep asks one thing: read a consulting paragraph and point at the
 * passages that state a requirement, in a fixed JSON shape. That evidences
 * `sourceGrounding` and `instructionFollowing`. It says nothing about
 * `coding`, `debugging`, `recovery`, `multiTurnContinuity` or the rest, and
 * those stay **absent** rather than being filled with a default — the router
 * treats an absent capability as unknown, which is different from and better
 * than a zero. A bridge that quietly scored ten more axes would be laundering
 * one measurement into twelve claims.
 *
 * ## Why the budget travels with the evidence
 *
 * This is the part the router cannot currently say, and the reason it needs to.
 * `glm-4.7-flash` scores 16/16 at a 6000-token output budget and 0/16 at 800,
 * because it reasons first and the budget runs out before it writes. Both
 * numbers are true. A recommendation that names the model without naming the
 * budget it needs is therefore not a weaker recommendation — it is one that
 * will silently produce nothing, and `modelProposer` ships 800.
 *
 * So a model's capability evidence and its budget floor are one object here.
 * They were never two facts.
 */

/**
 * What a sweep establishes about one model, budget included.
 */
export interface ProposerEvidence {
  modelId: string;
  /**
   * Only the axes the sweep actually evidences. Sparse on purpose.
   *
   * Shaped to drop straight into `ModelProfile.capabilities`.
   */
  capabilities: Partial<Record<keyof CapabilityDemand, Measure>>;
  budget: BudgetFloor;
  /** Cases behind the numbers — what `Measure.samples` was set from. */
  samples: number;
  /**
   * How finely this corpus can tell two models apart on `sourceGrounding`.
   *
   * The standard error of the proportion, over the number of requirements the
   * corpus states. It exists because the router uses `samples` only to break a
   * tie and never to widen one — its tie tolerance is calibrated for its own
   * arithmetic, where a real difference does show in the third decimal, and a
   * sixteen-requirement corpus does not earn that. Handing over 0.871 and 0.865
   * as though they were an ordering is exactly the "authority the number had
   * not earned" that `modelProposer` refused to repeat.
   *
   * So the number is carried rather than the precision being faked away.
   * `indistinguishable` is what a caller uses to avoid reporting a rank the
   * corpus cannot support; nothing here silently rounds, because a rounded
   * value would still arrive at the router looking exact.
   */
  resolution: number;
}

/**
 * The smallest output budget at which this model answered at all.
 *
 * A floor, not a threshold. Two sweeps at 800 and 6000 cannot locate the point
 * between them, and pretending otherwise would put a made-up number where a
 * measured one is expected. `measured` is carried so a reader can see what a
 * `null` was tested against — "never answered" means nothing without it.
 */
export interface BudgetFloor {
  /** Smallest measured budget that produced any usable answer. Null if none did. */
  tokens: number | null;
  /** Budgets swept, ascending. */
  measured: readonly number[];
  /** Answers cut off mid-write at `tokens`. Residual risk, not a failure. */
  truncatedAtFloor: number;
}

/**
 * Precision and recall of the same extraction, as one number.
 *
 * The harmonic mean, not the arithmetic one, and not `named` alone. A model
 * that finds every requirement and invents half as many again is not as good as
 * its recall suggests, and averaging would let a high recall carry a bad
 * precision. `midm-2.0-base` is exactly that case in the first sweep: recall
 * 10/16 with 39% of its proposals grounded in nothing.
 *
 * Null when either side has no denominator — a model that produced no
 * proposals has no precision, and inventing one would be scoring silence.
 */
function groundingScore(score: ProposerScore): number | null {
  const recall = score.named.value;
  const invented = score.invented.value;
  if (recall === null || invented === null) return null;
  const precision = 1 - invented;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * Whether the answer took the required form.
 *
 * `shape` alone. `transcribed` is a violation of the same instructions and is
 * deliberately **not** folded in, because the sweep shows the models that copy
 * the span are the ones that locate it best — `nemotron-omni-30b` transcribes
 * 83% and has the highest `pointed` of the field. Folding it in would score a
 * real capability down for a behaviour these instructions provoke, and would
 * bury the prompt defect inside a model number.
 */
function instructionScore(score: ProposerScore): number | null {
  return score.shape.value;
}

/**
 * Evidence from one or more sweeps of the same corpus at different budgets.
 *
 * Capabilities are read from the **largest** budget swept. That is not
 * flattering the models: at a budget that starves them the numbers measure the
 * budget, and a capability axis is supposed to be about the model. The budget
 * they need is carried separately, where a caller has to look at it.
 *
 * Throws on an empty list rather than returning nothing, because "no evidence"
 * and "evidence that nobody supplied" reach the router as the same absence and
 * only one of them is a mistake.
 */
export function evidenceFrom(
  measurements: readonly ProposerMeasurement[],
): readonly ProposerEvidence[] {
  if (measurements.length === 0) {
    throw new Error("실측이 하나도 없습니다 — 증거를 만들 수 없습니다.");
  }
  const budgets = [...new Set(measurements.map((m) => m.maxTokens))].sort((a, b) => a - b);
  const byBudget = new Map(measurements.map((m) => [m.maxTokens, m]));
  const richest = byBudget.get(budgets[budgets.length - 1] ?? 0);
  if (richest === undefined) throw new Error("가장 큰 예산의 실측을 찾지 못했습니다.");

  const out: ProposerEvidence[] = [];
  for (const score of richest.scores) {
    const samples = score.outcomes.length;
    const origin = samples >= MIN_SAMPLES_FOR_EVIDENCE ? "harness_eval" : "declared";
    const capabilities: Partial<Record<keyof CapabilityDemand, Measure>> = {};

    const grounding = groundingScore(score);
    if (grounding !== null) {
      capabilities.sourceGrounding = measure(round(grounding), origin, samples);
    }
    const following = instructionScore(score);
    if (following !== null) {
      capabilities.instructionFollowing = measure(round(following), origin, samples);
    }

    out.push({
      modelId: score.modelId,
      capabilities,
      budget: floorFor(score.modelId, budgets, byBudget),
      samples,
      resolution: standardError(grounding, score.named.of),
    });
  }
  return out;
}

/**
 * How far apart two proportions have to be before the difference is real.
 *
 * `sqrt(p(1-p)/n)` — one standard error, not two, because this is used to
 * refuse a claim rather than to make one, and the stricter band would let a
 * caller present a ranking it cannot defend. Falls back to the widest possible
 * band when there is no value or no denominator: unknown precision has to read
 * as *no* precision, or an absent measurement becomes an exact one.
 */
function standardError(value: number | null, denominator: number): number {
  if (value === null || denominator <= 0) return 1;
  const p = Math.min(1, Math.max(0, value));
  return Math.sqrt((p * (1 - p)) / denominator);
}

/**
 * The models this corpus cannot rank apart from the best one.
 *
 * Returns them in the order given, best first, and always includes the best
 * itself — a group of one is the honest answer when the field really is
 * separated, and returning an empty list for that case would make "nothing is
 * distinguishable" and "everything is" look the same to a caller.
 */
export function indistinguishable(
  evidence: readonly ProposerEvidence[],
): readonly ProposerEvidence[] {
  const scored = evidence.filter((e) => e.capabilities.sourceGrounding !== undefined);
  if (scored.length === 0) return [];
  const ranked = [...scored].sort(
    (a, b) =>
      (b.capabilities.sourceGrounding?.value ?? 0) - (a.capabilities.sourceGrounding?.value ?? 0),
  );
  const best = ranked[0];
  if (best === undefined) return [];
  const top = best.capabilities.sourceGrounding?.value ?? 0;
  // The wider of the two bands, so a noisy candidate is not excluded by a
  // confident leader's narrow one. Being generous here costs a longer list;
  // being strict costs a rank nobody can defend.
  return ranked.filter((e) => {
    const value = e.capabilities.sourceGrounding?.value ?? 0;
    return top - value <= Math.max(best.resolution, e.resolution);
  });
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

function floorFor(
  modelId: string,
  budgets: readonly number[],
  byBudget: ReadonlyMap<number, ProposerMeasurement>,
): BudgetFloor {
  for (const tokens of budgets) {
    const score = byBudget.get(tokens)?.scores.find((s) => s.modelId === modelId);
    // `shape.hit` rather than a ratio: one parseable answer is the difference
    // between "usable here" and "returns nothing", and a ratio would round the
    // difference away on a ten-case corpus.
    if (score !== undefined && score.shape.hit > 0) {
      return { tokens, measured: budgets, truncatedAtFloor: score.truncated };
    }
  }
  return { tokens: null, measured: budgets, truncatedAtFloor: 0 };
}

/**
 * Models a harness must not be handed at this budget.
 *
 * Separate from the ranking on purpose. A budget floor is not a weak score to
 * be outvoted by three other terms — it is the difference between an answer and
 * an empty string, so it belongs where `eligibility` lives rather than where
 * weights live.
 *
 * A `null` floor **is** excluded, and that is not a contradiction of the rule
 * that unmeasured is not disqualified: `null` means the sweep asked at every
 * budget it had and got nothing back, which is a measurement. A model nobody
 * swept is absent from `evidence` entirely and so is never named here — that is
 * where "unmeasured is not disqualified" lives, and it lives there by the
 * caller keeping such a model in its candidate list rather than by this
 * function saying anything about it.
 */
export function starvedAt(
  budget: number,
  evidence: readonly ProposerEvidence[],
): readonly { modelId: string; needs: number | null; measured: readonly number[] }[] {
  return evidence
    .filter((e) => e.budget.tokens === null || e.budget.tokens > budget)
    .map((e) => ({ modelId: e.modelId, needs: e.budget.tokens, measured: e.budget.measured }));
}
