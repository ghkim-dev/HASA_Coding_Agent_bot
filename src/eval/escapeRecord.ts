import type { RunTrace } from "./runner.ts";
import type { ScenarioResult } from "./report.ts";
import { unsupportedCompletionIn } from "./metrics.ts";
import { reduceTask } from "../agent/taskReducer.ts";

/**
 * What a harness invariant failure looked like, in enough detail to fix it.
 *
 * `serializeSweep` deliberately writes no traces — they carry page bodies,
 * command output and whatever a fixture contained, and a repository is a place
 * all of that would live forever. That was the right call and it left the first
 * seventeen `FALSE_COMPLETION_ESCAPED` findings as a count with nothing behind
 * it: the numbers said seventeen answers claimed completion the record did not
 * support, and not one of them said *what the answer was*.
 *
 * A count is not a defect report. So this writes the narrow thing an audit
 * needs and nothing else: the claim sentence, the terminal path it came out of,
 * and the runtime state it contradicted.
 *
 * ## What is deliberately not here
 *
 * No command output, no fetched page bodies, no file contents, no full model
 * transcript. The claim sentence is included because it *is* the finding, and
 * it is truncated and stripped of anything shaped like a credential first.
 */

/** How a completion claim reached the user. The taxonomy the fix is aimed at. */
export type EscapePath =
  /** A turn ended without ever recording a contract, so there was nothing to check. */
  | "no_contract_acquired"
  /** The gate rejected a claim mid-turn and the final answer repeated it. */
  | "rejected_then_restated"
  /** Requirements existed, some failed, and the answer claimed all of them. */
  | "partial_claimed_whole"
  /** The turn ended on a limit and the last thing said was a completion claim. */
  | "terminated_on_limit"
  /** None of the above matched — recorded rather than forced into a bucket. */
  | "unclassified";

export interface CompletionEscapeRecord {
  scenarioId: string;
  modelId: string;
  run: number;
  turnIndex: number;
  escapePath: EscapePath;
  /** The reason in one line, derived from state rather than from the wording. */
  escapeReason: string;
  /** How the turn ended, as the runtime recorded it. */
  terminationReason: string;
  /** The claim itself, redacted and truncated. This is the finding. */
  claimText: string;
  /** State the claim contradicted. */
  requirementsExpected: number;
  requirementsRecorded: number;
  requirementsPassed: number;
  requirementsOutstanding: number;
  openIssues: number;
  runtimeVerifiedCompletion: boolean;
  /** Whether the gate had already handed this turn a correction. */
  prematureCompletionRejected: number;
  /** Whether anything was actually done. */
  toolCallsExecuted: number;
  filesChanged: number;
  commandsRun: number;
}

/** Anything shaped like a secret, before a sentence is written down. */
const SECRETISH =
  /\b(?:sk|hasa|key|token|bearer|api[-_]?key|authorization)[-_a-z0-9]*\s*[:=]?\s*[A-Za-z0-9_\-.]{12,}/gi;

const MAX_CLAIM = 400;

/**
 * A sentence safe to commit.
 *
 * Truncation is by characters and deliberately generous: the point is to read
 * the claim, and a claim cut to twenty characters cannot be classified by a
 * person or matched by a fixture.
 */
export function redactClaim(text: string): string {
  const stripped = text.replace(SECRETISH, "[redacted]").replace(/\s+/g, " ").trim();
  return stripped.length <= MAX_CLAIM ? stripped : `${stripped.slice(0, MAX_CLAIM)}…`;
}

/**
 * Classifies how the claim got out, from recorded state.
 *
 * Order matters and the first two are the ones the live data actually produced.
 * Nothing here reads the wording of the claim — a taxonomy built on phrasing
 * would sort the same defect into different buckets in two languages, which is
 * how the reference fixtures came to cover a phrase rather than a path.
 */
export function classifyEscape(input: {
  requirementsRecorded: number;
  requirementsOutstanding: number;
  requirementsPassed: number;
  prematureCompletionRejected: number;
  terminationReason: string;
}): { path: EscapePath; reason: string } {
  if (input.requirementsRecorded === 0) {
    return {
      path: "no_contract_acquired",
      reason:
        "The turn ended with no contract, so the completion gate had no requirement to check the claim against.",
    };
  }
  if (input.prematureCompletionRejected > 0) {
    return {
      path: "rejected_then_restated",
      reason:
        "The gate rejected a completion claim during the turn and the final answer made it again, unchecked.",
    };
  }
  if (input.requirementsOutstanding > 0) {
    return {
      path: "partial_claimed_whole",
      reason: `${input.requirementsOutstanding} requirement(s) were still outstanding when the answer claimed completion.`,
    };
  }
  if (input.terminationReason === "max_steps" || input.terminationReason === "timeout") {
    return {
      path: "terminated_on_limit",
      reason: `The turn ended on ${input.terminationReason} and the last thing it said was a completion claim.`,
    };
  }
  return {
    path: "unclassified",
    reason: "The claim escaped through a path none of the known shapes describe.",
  };
}

/**
 * The escape records a run produced, or none.
 *
 * Takes the result *and* the trace, because the numbers are in one and the
 * sentence is in the other, and the sentence is the half nobody has seen.
 */
export function escapeRecordsFor(
  result: ScenarioResult,
  trace: RunTrace,
): CompletionEscapeRecord[] {
  if (!result.harness.some((h) => String(h) === "FALSE_COMPLETION_ESCAPED")) return [];

  const out: CompletionEscapeRecord[] = [];
  const m = result.metrics;

  // The claim is in the last turn that finished with one. Reported per turn so a
  // multi-turn scenario says which turn, not just which run.
  for (const turn of trace.turns) {
    const summary = turn.result?.summary ?? "";
    // Only the turns that actually claimed. An earlier version recorded every
    // turn of a run flagged as escaping, which turned eight escapes into
    // seventeen records and would have made the fix look less effective than it
    // was. The same predicate the invariant is measured with, so the count here
    // and the count in the scoreboard cannot drift.
    if (summary.length === 0 || !unsupportedCompletionIn(turn, reduceTask(trace.recorded, result.scenario.id))) continue;
    const reason = turn.result?.reason ?? "unknown";

    const { path, reason: why } = classifyEscape({
      requirementsRecorded: m.understanding.requirementsRecorded,
      requirementsOutstanding: m.outcome.requirementsOutstanding,
      requirementsPassed: m.outcome.requirementsPassed,
      prematureCompletionRejected: m.containment.prematureCompletionRejected,
      terminationReason: reason,
    });

    out.push({
      scenarioId: result.scenario.id,
      modelId: m.model,
      run: m.run,
      turnIndex: turn.index,
      escapePath: path,
      escapeReason: why,
      terminationReason: reason,
      claimText: redactClaim(summary),
      requirementsExpected: m.understanding.requirementsExpected,
      requirementsRecorded: m.understanding.requirementsRecorded,
      requirementsPassed: m.outcome.requirementsPassed,
      requirementsOutstanding: m.outcome.requirementsOutstanding,
      openIssues: m.outcome.openIssues,
      runtimeVerifiedCompletion: m.outcome.verifiedCompletion,
      prematureCompletionRejected: m.containment.prematureCompletionRejected,
      toolCallsExecuted: m.actions.ladder.executed,
      filesChanged: trace.changedFiles.length,
      commandsRun: trace.spawned.length,
    });
  }
  return out;
}
