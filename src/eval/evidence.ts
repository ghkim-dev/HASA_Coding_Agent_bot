import type { EvaluationSummary } from "../router/modelRegistry.ts";
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
 * The evidence one model's runs support.
 *
 * Runs that broke a harness invariant are excluded before anything is pooled.
 * A run where the harness itself misbehaved measured the harness, not the
 * model, and letting it score the model would attribute a bug here to a model
 * out there.
 */
export function evidenceForModel(
  modelId: string,
  allResults: readonly ScenarioResult[],
  updatedAt?: string,
): EvaluationSummary | null {
  const results = allResults.filter(
    (r) => r.metrics.model === modelId && r.harness.length === 0,
  );
  if (results.length === 0) return null;

  const metrics: EvaluationSummary["metrics"] = {};
  const sampleCounts: NonNullable<EvaluationSummary["sampleCounts"]> = {};

  const put = (key: keyof EvaluationSummary["metrics"], pooled: Pooled | undefined): void => {
    if (pooled === undefined) return;
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

  if (Object.keys(metrics).length === 0) return null;

  return {
    modelId,
    sampleCount: results.length,
    sampleCounts,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    metrics,
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
