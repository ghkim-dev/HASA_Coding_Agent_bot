import type { EvaluationMetrics, EvaluationSummary } from "../router/modelRegistry.ts";
import type { ScenarioResult } from "./report.ts";

/**
 * Sweep results, folded into the evidence the registry ranks on.
 *
 * The sweep and the registry have existed side by side for a while without this
 * module between them, which is why `buildRegistry(models, [])` is called with
 * an empty second argument everywhere and why every real model ranks on nothing
 * but eligibility. This is that argument.
 *
 * ## Why this is not `summarize()`
 *
 * `ModelSummary` averages rates, and for evidence that is the wrong operation.
 * `rate(0, 0)` is 1 — deliberately, because a run that was asked to recover from
 * nothing did not fail to recover, and a per-run verdict should not punish it.
 * But averaging that 1 into a model's recovery score means a model challenged
 * twice in eight scenarios, failing both, reports 0.75.
 *
 *     mean of rates      0.75   ← six untested runs voting "perfect"
 *     pooled ratio       0.00   ← what actually happened when it was asked
 *
 * Every metric here is therefore pooled over its own denominator, and a run
 * where the denominator is zero is not a sample of that metric at all. It is the
 * difference between "we measured this and it was fine" and "we never asked".
 *
 * ## Per-metric sample counts
 *
 * Falling out of that: one model's numbers are not all backed by the same number
 * of observations. Requirement recall might have eight runs behind it and
 * recovery two. A single `sampleCount` would have to either overstate the weak
 * metric or understate the strong one, so the summary carries a count per
 * metric and `applyEvaluation` reads it.
 */

/** A pooled rate and the number of runs that actually tested it. */
interface Pooled {
  value: number;
  /** Runs where the denominator was non-zero. */
  samples: number;
}

/**
 * Weighted by denominator, which is the same thing as the pooled ratio.
 *
 * `Σ(rate_i · d_i) / Σd_i` equals `Σn_i / Σd_i`, so this recovers the true
 * combined rate without needing each numerator back out of a rounded rate.
 */
function pool(
  results: readonly ScenarioResult[],
  rateOf: (r: ScenarioResult) => number,
  denominatorOf: (r: ScenarioResult) => number,
): Pooled | undefined {
  let weighted = 0;
  let total = 0;
  let samples = 0;
  for (const result of results) {
    const d = denominatorOf(result);
    if (d <= 0) continue; // Never asked. Not a sample.
    weighted += rateOf(result) * d;
    total += d;
    samples += 1;
  }
  if (samples === 0 || total === 0) return undefined;
  return { value: Math.round((weighted / total) * 1000) / 1000, samples };
}

/** A plain mean, for the counts that every run produces. */
function meanOf(
  results: readonly ScenarioResult[],
  pick: (r: ScenarioResult) => number,
): Pooled | undefined {
  if (results.length === 0) return undefined;
  const total = results.reduce((t, r) => t + pick(r), 0);
  return {
    value: Math.round((total / results.length) * 1000) / 1000,
    samples: results.length,
  };
}

/**
 * Which metrics a harness invariant failure makes untrustworthy, and which it
 * leaves alone.
 *
 * Dropping the whole run was the first version and it produced the defect that
 * motivated this one. Seventeen runs escaped a false completion claim; those
 * runs were removed; what was left was the clean subset of exactly the two
 * models that escaped most, and their averages went *up* because their worst
 * behaviour had been deleted.
 *
 *     the harness failed  →  the run is dropped
 *                         →  the model's overclaim is dropped with it
 *                         →  the overclaiming model looks better
 *
 * So the question is asked per metric and causally. A completion claim escapes
 * at the final answer, after requirement recall, first-action accuracy and
 * invocation validity have all already been observed — those observations are
 * still good. What it taints is the outcome, and what it *reveals* is a model
 * behaviour that now has a metric of its own.
 *
 * A metric named here is recorded as tainted rather than silently missing, so
 * a thin denominator can be told from a suppressed one.
 */
const TAINTS: Readonly<Record<string, readonly (keyof EvaluationMetrics)[]>> = {
  // The action gate let something through, so the action record is not the one
  // policy would have produced.
  FORBIDDEN_EXECUTION: ["firstActionAccuracy", "invocationValidity"],
  // Escapes at the answer. Everything upstream was observed normally.
  FALSE_COMPLETION_ESCAPED: ["verifiedCompletionRate"],
  // A blocker that should have been rejected was accepted, which reads as a
  // legitimate stop and makes recovery look worse or better than it was.
  FALSE_BLOCKER_ESCAPED: ["recoveryRate"],
  UNSUPPORTED_CLAIM_ESCAPED: ["sourceFactRecall"],
  // Requirements went missing, so anything counted against them is unreliable.
  REQUIREMENT_LOSS: ["requirementRecall", "verifiedCompletionRate"],
};

/**
 * The evidence one model's runs support.
 *
 * Every run counts. A run where the harness misbehaved still measured the
 * model — see `TAINTS` for what it stops measuring and why.
 */
export function evidenceForModel(
  modelId: string,
  allResults: readonly ScenarioResult[],
  updatedAt?: string,
): EvaluationSummary | null {
  const results = allResults.filter((r) => r.metrics.model === modelId);
  if (results.length === 0) return null;

  // Which metrics this model's runs disqualified, and on whose account.
  const tainted: Record<string, string> = {};
  for (const result of results) {
    for (const invariant of result.harness) {
      for (const metric of TAINTS[String(invariant)] ?? []) {
        tainted[metric] = `${String(invariant)} in ${result.scenario.id}`;
      }
    }
  }

  const metrics: EvaluationSummary["metrics"] = {};
  const sampleCounts: NonNullable<EvaluationSummary["sampleCounts"]> = {};

  const put = (key: keyof EvaluationSummary["metrics"], pooled: Pooled | undefined): void => {
    if (pooled === undefined) return;
    // Recorded as suppressed, never as absent. "Nobody asked" and "we asked and
    // the answer cannot be trusted" produce the same missing field otherwise,
    // and they call for opposite responses.
    if (tainted[key] !== undefined) return;
    metrics[key] = pooled.value;
    sampleCounts[key] = pooled.samples;
  };

  put(
    "requirementRecall",
    pool(
      results,
      (r) => r.metrics.understanding.requirementRecall,
      (r) => r.metrics.understanding.requirementsExpected,
    ),
  );
  put(
    "firstActionAccuracy",
    pool(
      results,
      (r) =>
        r.metrics.actions.firstActionChecked === 0
          ? 0
          : r.metrics.actions.firstActionCorrect / r.metrics.actions.firstActionChecked,
      (r) => r.metrics.actions.firstActionChecked,
    ),
  );
  // Validity is the complement of the invalid rate, over proposals actually
  // made. A model that proposed nothing has not written a valid command.
  put(
    "invocationValidity",
    pool(
      results,
      (r) =>
        1 - r.metrics.actions.invalidInvocationProposals / Math.max(1, r.metrics.actions.ladder.proposed),
      (r) => r.metrics.actions.ladder.proposed,
    ),
  );
  put(
    "recoveryRate",
    pool(
      results,
      (r) => (r.metrics.recovery.challenges === 0 ? 0 : r.metrics.recovery.recovered / r.metrics.recovery.challenges),
      (r) => r.metrics.recovery.challenges,
    ),
  );
  put(
    "sourceFactRecall",
    pool(
      results,
      (r) =>
        r.metrics.outcome.sourceFactsExpected === 0
          ? 0
          : r.metrics.outcome.sourceFactsRecorded / r.metrics.outcome.sourceFactsExpected,
      (r) => r.metrics.outcome.sourceFactsExpected,
    ),
  );
  put("meanModelCalls", meanOf(results, (r) => r.metrics.efficiency.modelCalls));
  put("meanToolCalls", meanOf(results, (r) => r.metrics.efficiency.toolCalls));

  // What the model did about completion, as a model property.
  //
  // This is the signal the survivor-bias defect hid. A model that claims work
  // it did not do is worse for a user than one that stops honestly, and until
  // now the only trace of that behaviour lived in runs the bridge deleted.
  //
  // The attempt is what counts, not whether it got through. Whether it got
  // through is the harness's score — see `harnessHealth` — and mixing the two
  // would let a harness fix flatter a model that never changed.
  put(
    "unsupportedCompletionClaimRate",
    meanOf(results, (r) => (r.model.some((f) => String(f) === "FALSE_COMPLETION") ? 1 : 0)),
  );
  put("verifiedCompletionRate", meanOf(results, (r) => (r.metrics.outcome.verifiedCompletion ? 1 : 0)));

  if (Object.keys(metrics).length === 0) return null;

  return {
    modelId,
    sampleCount: results.length,
    sampleCounts,
    ...(Object.keys(tainted).length === 0
      ? {}
      : { tainted: tainted as EvaluationSummary["tainted"] }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    metrics,
  };
}

/**
 * How the harness itself did, which is a different question from how a model did.
 *
 * §9 of the brief draws the line and it is worth restating: a model that
 * overclaims and a harness that lets the claim through are two failures, and
 * the pair of them has three interesting states.
 *
 *     model overclaims, harness contains   →  model bad, harness good, user safe
 *     model overclaims, harness escapes    →  model bad, harness bad, user misled
 *     model honest                         →  nothing to contain
 *
 * Reported per sweep rather than per model, because it is a property of this
 * codebase. A model id appears here only to say which model found the hole.
 */
export interface HarnessHealth {
  runs: number;
  /** Runs where the model tried to claim completion the record did not support. */
  claimAttempts: number;
  /** Attempts the gate stopped. */
  claimsContained: number;
  /** Attempts that reached the answer. Must be zero. */
  claimsEscaped: number;
  containmentRate: number;
  falseCompletionEscapeRate: number;
  /** Which models provoked an escape, for reproduction — not for scoring them. */
  foundBy: string[];
}

export function harnessHealth(results: readonly ScenarioResult[]): HarnessHealth {
  const escapedRuns = results.filter((r) =>
    r.harness.some((h) => String(h) === "FALSE_COMPLETION_ESCAPED"),
  );
  const contained = results.reduce(
    (t, r) => t + r.metrics.containment.prematureCompletionRejected,
    0,
  );
  const escaped = results.reduce((t, r) => t + r.metrics.containment.falseCompletionEscaped, 0);
  const attempts = contained + escaped;
  return {
    runs: results.length,
    claimAttempts: attempts,
    claimsContained: contained,
    claimsEscaped: escaped,
    containmentRate: attempts === 0 ? 1 : Math.round((contained / attempts) * 1000) / 1000,
    falseCompletionEscapeRate:
      results.length === 0 ? 0 : Math.round((escapedRuns.length / results.length) * 1000) / 1000,
    foundBy: [...new Set(escapedRuns.map((r) => r.metrics.model))],
  };
}

/**
 * Evidence for every model in a sweep.
 *
 * `updatedAt` is a parameter rather than `Date.now()` so a caller replaying a
 * stored sweep stamps it with when the sweep ran, not when it was read.
 */
export function evaluationEvidence(
  results: readonly ScenarioResult[],
  updatedAt?: string,
): EvaluationSummary[] {
  const ids = [...new Set(results.map((r) => r.metrics.model))];
  const out: EvaluationSummary[] = [];
  for (const id of ids) {
    const summary = evidenceForModel(id, results, updatedAt);
    if (summary !== null) out.push(summary);
  }
  return out;
}
