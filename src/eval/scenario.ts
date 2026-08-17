import type { TurnRelation } from "../agent/turnContract.ts";

/**
 * What a model is asked to do, and what counts as having done it.
 *
 * The rule that shapes every field here: **the answer key is not written by a
 * model.** A fixture states, in a person's words, what the user explicitly
 * asked for and what must never happen; the evaluator compares that against
 * runtime events, not against the model's prose. Nothing in this file is scored
 * by another language model.
 *
 * ## What is measured, and what is deliberately not
 *
 * Not exact wording. Two correct answers phrased differently are both correct,
 * and a benchmark that cannot say so measures style.
 *
 * What is measured is the record the runtime already keeps: which relation the
 * contract carried, which tools were proposed, which of those were held back
 * before running, which requirements the evidence settled, whether a claim
 * survived the gate. All of it deterministic, all of it already written for
 * other reasons.
 *
 * ## Why the separation matters more than the score
 *
 * A scenario reports two different things and must never merge them:
 *
 *     the model proposed a forbidden command      → model quality
 *     the runtime executed a forbidden command    → harness failure
 *
 * The first is a number that varies by model and is the point of comparing
 * them. The second is a bug, in this repository, and it is a red build whoever
 * was driving. See `harnessInvariants`.
 */

/** One thing the user says, and what the runtime should make of it. */
export interface EvalTurn {
  user: string;
  /** How this message relates to the last. Compared against the contract. */
  expectedRelation?: TurnRelation;
  /**
   * Tools that would be a sensible *first* substantive action here.
   *
   * A set rather than one name: "코드를 보여줘" is answered by `read_file` and
   * would also be answered by `search_files` first. What it is not answered by
   * is `run_command`, and that is what this catches.
   */
  expectedFirstAction?: string[];
  /** Risk classes this turn's words forbid. Any execution of them is a harness failure. */
  forbids?: Array<"execute" | "modify">;
  /** Requirements the user states here, in their own terms. Used for recall. */
  requirements?: string[];
  /** URLs the user names here. The runtime should track them as exact sources. */
  exactSources?: string[];
}

/** Entities a fixture page really carries, for `record_source_fact` recall. */
export type EntityIndex = Record<string, string[]>;

/**
 * Things that must be true of every run, whatever model produced it.
 *
 * Zero-valued on purpose. These are not targets to improve; they are the
 * properties the previous six slices exist to hold, and a run that breaks one
 * is reported as a harness failure rather than as a low score.
 */
export interface HarnessOracle {
  /** Commands or writes that ran despite the user forbidding them. */
  forbiddenExecutions: 0;
  /** A "finished" claim the completion gate should have refused. */
  falseCompletionEscaped: 0;
  /** A blocked report resting only on the agent's own mistakes. */
  falseBlockerEscaped: 0;
  /** A sentence about a source the record does not support. */
  unsupportedClaimEscaped: 0;
  /** Requirements the user stated that the task lost after recording them. */
  requirementLoss: 0;
}

export const CLEAN: HarnessOracle = {
  forbiddenExecutions: 0,
  falseCompletionEscaped: 0,
  falseBlockerEscaped: 0,
  unsupportedClaimEscaped: 0,
  requirementLoss: 0,
};

/** A page the controlled world serves. */
export interface WorldPage {
  body: string;
  contentType?: string;
  status?: number;
  /** The fetch does not answer. For the exact-source-failure scenario. */
  timeout?: boolean;
}

/** What one command does, in a world where nothing is really spawned. */
export interface WorldCommand {
  /** Matched against `executable + " " + args.join(" ")`. */
  match: string;
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface WorldSpec {
  /** Files the workspace starts with. */
  files?: Record<string, string>;
  /** Keyed by a substring of the URL. */
  pages?: Record<string, WorldPage>;
  /** Keyed by a substring of the query. */
  search?: Record<string, Array<{ title: string; url: string; snippet: string }>>;
  commands?: WorldCommand[];
  /** Commands the workspace declares, so `run_command` is offered at all. */
  declared?: Array<{ cmd: string; args: string[] }>;
}

export interface EvalScenario {
  id: string;
  title: string;
  /** What this scenario is for, in one line. Printed in the breakdown. */
  about: string;
  turns: EvalTurn[];
  world?: WorldSpec;
  /** Entities each fixture page really carries. The answer key for fact recall. */
  entities?: EntityIndex;
  /** Requirements that must survive to the end. Defaults to the union of turn requirements. */
  standingRequirements?: string[];
  /** Evidence kinds the task must end with, when the request needed running something. */
  requiredEvidence?: Array<
    "command_result" | "test_result" | "build_result" | "web_source" | "file_change"
  >;
  /** How the run should end, when the scenario is about the ending. */
  expectedTermination?: string[];
  /** True when finishing is not the point — a stall scenario, for instance. */
  completionExpected?: boolean;
  oracle: HarnessOracle;
}
