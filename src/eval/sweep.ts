import { runScenario } from "./runner.ts";
import { evaluate, summarize, type ModelSummary, type ScenarioResult } from "./report.ts";
import type { EvalScenario } from "./scenario.ts";
import type { AgentModel } from "../agent/types.ts";
import { escapeRecordsFor, type CompletionEscapeRecord } from "./escapeRecord.ts";

/**
 * Every model against every scenario, N times each.
 *
 * `runs` is not decoration. A language model is not deterministic, and a
 * comparison built on one sample per cell reports whichever run happened —
 * which is how a model that succeeds two times in three and one that succeeds
 * three times in three end up looking identical. What is reported per cell is
 * the rate, and the worst case is kept beside it because the worst case is what
 * a user will eventually see.
 *
 * Runs are sequential. A parallel sweep would be quicker and would also share
 * one temporary directory tree and one rate limit between concurrent sessions,
 * which is a way to make results depend on scheduling.
 */

export interface ModelUnderTest {
  id: string;
  /** Built fresh per run, so nothing carries between them. */
  create: (scenario: EvalScenario) => AgentModel;
  /** Set when the model could not be built — no credential, not in the catalogue. */
  unavailable?: string;
}

export interface SweepOptions {
  scenarios: readonly EvalScenario[];
  models: readonly ModelUnderTest[];
  runs?: number;
  maxSteps?: number;
  turnTimeoutMs?: number;
  onProgress?: (line: string) => void;
}

export interface SweepResult {
  results: ScenarioResult[];
  summaries: ModelSummary[];
  skipped: Array<{ model: string; reason: string }>;
  /** Runs that broke a harness invariant. Reported first, whatever the scores say. */
  harnessFailures: ScenarioResult[];
  /**
   * What each containment failure actually looked like.
   *
   * Kept because a count of seventeen escapes is not a defect report. Redacted
   * at the point of capture, never a transcript.
   */
  escapes: CompletionEscapeRecord[];
  startedAt: number;
  finishedAt: number;
}

export async function sweep(opts: SweepOptions): Promise<SweepResult> {
  const runs = Math.max(1, opts.runs ?? 1);
  const results: ScenarioResult[] = [];
  const skipped: Array<{ model: string; reason: string }> = [];
  const escapes: CompletionEscapeRecord[] = [];
  const startedAt = Date.now();

  for (const model of opts.models) {
    if (model.unavailable !== undefined) {
      // Recorded as skipped, never as a zero. A model that could not be reached
      // has not scored badly; reporting it as a low score would be inventing a
      // measurement.
      skipped.push({ model: model.id, reason: model.unavailable });
      continue;
    }
    for (const scenario of opts.scenarios) {
      for (let run = 1; run <= runs; run += 1) {
        opts.onProgress?.(`${model.id} · ${scenario.id} · run ${run}/${runs}`);
        const trace = await runScenario({
          scenario,
          model: () => model.create(scenario),
          run,
          ...(opts.maxSteps === undefined ? {} : { maxSteps: opts.maxSteps }),
          ...(opts.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: opts.turnTimeoutMs }),
        });
        const evaluated = evaluate(scenario, trace);
        results.push(evaluated);
        escapes.push(...escapeRecordsFor(evaluated, trace));
      }
    }
  }

  const summaries = [...new Set(results.map((r) => r.metrics.model))].map((id) =>
    summarize(
      id,
      results.filter((r) => r.metrics.model === id),
    ),
  );

  return {
    results,
    summaries,
    skipped,
    escapes,
    harnessFailures: results.filter((r) => r.harness.length > 0),
    startedAt,
    finishedAt: Date.now(),
  };
}

/**
 * The sweep as JSON, with nothing in it that should not be written down.
 *
 * Traces are deliberately absent: they carry page bodies, command output and
 * whatever a fixture happened to contain, and an artifact committed to a
 * repository is a place all of that would live forever. Numbers and failure
 * names are enough to compare models; the trace is for the run that produced
 * them and stays in memory.
 */
export function serializeSweep(result: SweepResult): string {
  return JSON.stringify(
    {
      startedAt: new Date(result.startedAt).toISOString(),
      durationMs: result.finishedAt - result.startedAt,
      summaries: result.summaries,
      skipped: result.skipped,
      escapes: result.escapes,
      runs: result.results.map((r) => ({
        scenario: r.scenario.id,
        model: r.metrics.model,
        run: r.metrics.run,
        verdict: r.verdict,
        modelFailures: r.model,
        harnessFailures: r.harness,
        understanding: r.metrics.understanding,
        actions: r.metrics.actions,
        containment: r.metrics.containment,
        recovery: r.metrics.recovery,
        outcome: r.metrics.outcome,
        efficiency: r.metrics.efficiency,
      })),
    },
    null,
    2,
  );
}
