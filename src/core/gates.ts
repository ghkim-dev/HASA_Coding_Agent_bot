import {
  HARD_GATES,
  type CandidateArtifacts,
  type CodeTaskSpec,
  type CommandSpec,
  type GateName,
  type GateResult,
} from "../protocol/index.ts";
import type { CommandOutcome } from "./commands.ts";

/**
 * Objective gates.
 *
 * Ordered cheapest-and-most-decisive first, and short-circuited on the first
 * hard failure: there is no point type-checking a candidate whose build is
 * broken, and running the expensive stages anyway would only add noise to the
 * score.
 *
 * The LLM judge never sees these results and cannot overturn them.
 * See docs/evaluation-protocol.md §2.
 */

export interface BaselineMeasurement {
  /** Gate → exit code at the run's base commit. */
  exitCodes: Map<string, number | null>;
  /** Gates that failed on the untouched tree; those cannot be blamed on a candidate. */
  brokenAtBase: Set<string>;
}

export interface GateInput {
  taskSpec: CodeTaskSpec;
  artifacts: CandidateArtifacts;
  baseline: BaselineMeasurement;
  /** Runs a declared command in the candidate's worktree. */
  run: (spec: CommandSpec) => Promise<CommandOutcome>;
  /** Secret patterns found in the candidate's diff, from `scanDiffForSecrets`. */
  diffSecrets: string[];
  onGate?: (result: GateResult) => void;
  signal: AbortSignal;
}

export interface GateEvaluation {
  results: GateResult[];
  survived: boolean;
  failedHardGate: GateName | null;
  commandOutcomes: CommandOutcome[];
}

function gateResult(
  gate: GateName,
  passed: boolean,
  detail: string,
  durationMs: number,
  flaky = false,
): GateResult {
  return { gate, passed, hard: HARD_GATES.includes(gate), detail, durationMs, flaky };
}

/** Secrets a candidate must not introduce. Matches the diff, not the whole file. */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "aws access key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "bearer token literal", re: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
  { name: "assigned api key", re: /(api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{16,}["']/i },
];

export function scanDiffForSecrets(diff: string): string[] {
  const added = diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .join("\n");
  return SECRET_PATTERNS.filter((p) => p.re.test(added)).map((p) => p.name);
}

/**
 * A failing test is a candidate's death sentence, so a single flaky run must not
 * be enough to impose it. One retry; a gate that only passes the second time is
 * marked flaky and penalised rather than silently accepted.
 */
async function runWithRetry(
  spec: CommandSpec,
  run: GateInput["run"],
): Promise<{ outcome: CommandOutcome; flaky: boolean }> {
  const first = await run(spec);
  if (first.exitCode === 0) return { outcome: first, flaky: false };
  const second = await run(spec);
  return { outcome: second, flaky: second.exitCode === 0 };
}

export async function evaluateGates(input: GateInput): Promise<GateEvaluation> {
  const { taskSpec, artifacts, baseline, signal } = input;
  const results: GateResult[] = [];
  const commandOutcomes: CommandOutcome[] = [];
  let failedHardGate: GateName | null = null;

  const record = (result: GateResult): void => {
    results.push(result);
    input.onGate?.(result);
    if (!result.passed && result.hard && failedHardGate === null) failedHardGate = result.gate;
  };

  // G0 — did the candidate do anything at all
  record(
    gateResult(
      "no_change",
      artifacts.changedFiles.length > 0,
      artifacts.changedFiles.length > 0
        ? `${artifacts.changedFiles.length} file(s) changed`
        : "no files changed",
      0,
    ),
  );
  if (failedHardGate) return { results, survived: false, failedHardGate, commandOutcomes };

  // G1 — the diff we captured must be reapplicable, or "apply winner" is a lie
  record(
    gateResult(
      "patch_applies",
      artifacts.diffLines > 0,
      artifacts.diffLines > 0 ? `${artifacts.diffLines} diff lines` : "empty diff",
      0,
    ),
  );
  if (failedHardGate) return { results, survived: false, failedHardGate, commandOutcomes };

  // G2-G6 — only the commands the task specification declared
  for (const command of taskSpec.acceptanceCommands) {
    if (signal.aborted) break;
    if (failedHardGate) break;

    const { outcome, flaky } = await runWithRetry(command, input.run);
    commandOutcomes.push(outcome);

    // A regression check that was already red at the base commit says nothing
    // about this candidate. An acceptance check is *supposed* to be red at the
    // base — excusing it there would hand the gate to a candidate that did
    // nothing.
    const excused = command.kind === "regression" && baseline.brokenAtBase.has(command.gate);
    const passed = outcome.exitCode === 0 || excused;
    const detail = excused
      ? `exit=${outcome.exitCode} but this regression check already failed at the base commit — not attributed to the candidate`
      : `exit=${outcome.exitCode}${outcome.timedOut ? " (timed out)" : ""} [${command.kind}]`;

    record(gateResult(command.gate as GateName, passed, detail, outcome.durationMs, flaky));
  }
  if (failedHardGate) return { results, survived: false, failedHardGate, commandOutcomes };

  // G7 — a candidate that commits a secret is disqualified regardless of tests
  const secrets = input.diffSecrets;
  record(
    gateResult(
      "security",
      secrets.length === 0,
      secrets.length === 0 ? "no secret patterns in the diff" : `introduced: ${secrets.join(", ")}`,
      0,
    ),
  );

  // G8/G9 — informational, folded into the score rather than pass/fail
  record(
    gateResult(
      "diff_size",
      true,
      `${artifacts.diffLines} lines across ${artifacts.changedFiles.length} files` +
        (artifacts.outOfScopeFiles.length > 0
          ? `, ${artifacts.outOfScopeFiles.length} outside the declared scope`
          : ""),
      0,
    ),
  );
  record(
    gateResult("cost", true, `${artifacts.toolCalls} tool calls, ${artifacts.commands.length} commands`, 0),
  );

  return {
    results,
    survived: failedHardGate === null,
    failedHardGate,
    commandOutcomes,
  };
}

export interface ScoreInput {
  artifacts: CandidateArtifacts;
  results: GateResult[];
  expectedDiffLines: number;
  medianDiffLines: number;
  medianTokens: number;
  tokens: number;
}

const clamp = (min: number, max: number, value: number): number => Math.min(max, Math.max(min, value));

/**
 * Ranking score for candidates that already cleared every hard gate.
 *
 * Relative rather than absolute where it can be — comparing a candidate's diff
 * size to the field's median says something, comparing it to a constant does
 * not. Coefficients are a starting point; changing them means bumping
 * `scoringVersion` so old runs stay interpretable.
 */
export const SCORING_VERSION = "scoring-v1";

export function scoreCandidate(input: ScoreInput): { score: number; breakdown: Record<string, number> } {
  const { artifacts, results } = input;
  const flakyCount = results.filter((r) => r.flaky).length;

  const expected = input.expectedDiffLines > 0 ? input.expectedDiffLines : input.medianDiffLines || 1;
  const sizePenalty =
    clamp(0, 20, 2 * Math.log2(1 + artifacts.diffLines / expected)) + 5 * artifacts.outOfScopeFiles.length;

  const costPenalty =
    input.medianTokens > 0 ? clamp(0, 5, 3 * (input.tokens / input.medianTokens - 1)) : 0;

  const flakyPenalty = 5 * flakyCount;

  const breakdown = { sizePenalty, costPenalty, flakyPenalty };
  const score = 100 - sizePenalty - costPenalty - flakyPenalty;
  return { score: Math.round(score * 100) / 100, breakdown };
}
