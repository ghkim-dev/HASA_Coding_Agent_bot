import { isSelfAuthoredOutput, verifierFor } from "./taskState.ts";

/**
 * Whether the agent is getting anywhere, as opposed to being busy.
 *
 * The failure this is for, from the transcript that started all of this:
 *
 *     python -c "print('프로젝트 완료')"
 *     python -c "print('프로젝트 최종 완료')"
 *     python -c "print('모든 구성 요소 정상')"
 *
 * Every one of those is a different string, so the existing detector — a hash
 * of the tool name and its raw arguments — saw three unrelated calls. Every one
 * produced a tool result, so anything counting events saw progress. And none of
 * them verified anything, changed anything, or moved the task one step.
 *
 *   New event ≠ new evidence ≠ progress.
 *
 * ## Three levels, and why the third is the one that matters
 *
 * LEVEL 1 is the existing exact-repetition check and stays where it is: it is
 * cheap and it catches the simplest loop immediately.
 *
 * LEVEL 2 is here — the *shape* of an operation rather than its text, so the
 * three commands above are one repeated action. On its own it is only a
 * suspicion: `pytest test_a.py` and `pytest test_b.py` share a shape and are
 * perfectly reasonable.
 *
 * LEVEL 3 is the judgement. A repeated shape that also moves no requirement,
 * verifies nothing new, resolves no issue, changes no file and observes nothing
 * novel is a stall. Either half alone produces false positives; together they
 * do not.
 *
 * ## Why this is not a second task tracker
 *
 * It reads the same vocabulary the rest of the runtime uses — `verifierFor` and
 * `isSelfAuthoredOutput` from `taskState.ts` decide what counts as
 * verification here too — and it holds no state the task does not already have.
 * What it adds is *novelty*: whether this observation is one the turn has
 * already made.
 */

/** What the loop saw happen, per proposed action. */
export interface ActionObservation {
  toolName: string;
  args: Record<string, unknown>;
  /** Whether the call ran, and how it ended. */
  outcome: "executed" | "failed" | "deferred" | "denied";
  /** The result, or the error, or the policy challenge. */
  detail: string;
  changedFiles: readonly string[];
  /** Present when the runtime held the call back. */
  policyCode?: string;
}

/**
 * How much this action moved things.
 *
 * `weak` exists because investigation is real work. Reading three files nobody
 * has read yet is not a stall even though no requirement changed, and a
 * detector that could not say so would stop the agent every time it was
 * thinking.
 */
export type ProgressClass = "strong" | "weak" | "none";

/**
 * How many actions may pass with nothing to show before the model is told.
 *
 * Three rather than two: a plan, a read and a command is a normal opening for a
 * turn, and interrupting it would be noise. Rather than five, because the
 * failure this exists for produced four identical-in-substance calls and the
 * user watched all of them.
 */
export const STALL_WARNING_AT = 3;

/**
 * How many more after the warning before the run stops.
 *
 * Small, because the warning already said what was wrong and named what to do
 * instead. A model that answers it with more of the same is not going to
 * answer a second one differently.
 */
export const STALL_TERMINATE_AFTER = 2;

// ---------------------------------------------------------------------------
// Shape, rather than text
// ---------------------------------------------------------------------------

/** What a command is for, as far as can be told without running it. */
export type CommandShape = "print_only" | "verifier" | "other";

function commandOf(args: Record<string, unknown>): string {
  const value = args["command"] ?? args["cmd"] ?? args["script"];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Classifies a command by what it does, not what it says.
 *
 * `unknown` is deliberately absent: anything not recognised falls to `other`,
 * which is treated as capable of real work. Guessing that an unfamiliar command
 * does nothing is the mistake that would stop a working agent, and guessing the
 * other way only costs a stall being noticed one action later.
 */
export function commandShape(command: string): CommandShape {
  if (command.length === 0) return "other";
  if (isSelfAuthoredOutput(command)) return "print_only";
  return verifierFor(command) === null ? "other" : "verifier";
}

/**
 * The shape of an operation, for LEVEL 2.
 *
 * Coarse on purpose for the cases that repeat — every print-only one-liner is
 * one shape, whatever it prints — and specific where the target is what makes
 * two calls different, as for a file read.
 */
export function structuralKey(observation: ActionObservation): string {
  const { toolName, args } = observation;

  if (toolName === "run_command") {
    const command = commandOf(args);
    const shape = commandShape(command);
    // A print-only command carries no target worth distinguishing: the whole
    // point is that its text is the only thing that varies.
    if (shape === "print_only") return "run_command:print_only";
    const executable = /^\S*?([\w.-]+?)(?:\.exe)?(?:\s|$)/.exec(command)?.[1] ?? "";
    return `run_command:${shape}:${executable}:${firstTarget(command)}`;
  }

  if (toolName === "read_file") {
    return `read_file:${String(args["path"] ?? "")}:${String(args["startLine"] ?? "")}`;
  }
  if (toolName === "search_files") {
    return `search_files:${String(args["query"] ?? args["pattern"] ?? "")}`;
  }
  if (toolName === "web_search" || toolName === "web_fetch") {
    return `${toolName}:${String(args["query"] ?? args["url"] ?? "")}`;
  }
  // A plan or a contract is one shape regardless of content: rewriting either
  // is the same move, and rewriting it repeatedly is the churn this catches.
  if (toolName === "update_plan" || toolName === "record_request") return toolName;

  return `${toolName}:${JSON.stringify(args)}`;
}

/** The first argument that looks like a target — a path, a module, a test file. */
function firstTarget(command: string): string {
  const parts = command.split(/\s+/).slice(1);
  return parts.find((p) => !p.startsWith("-") && p.length > 0) ?? "";
}

/**
 * What an observation *told us*, for novelty.
 *
 * Deliberately not a hash of the output. Two runs of the same failing test
 * print slightly different timings and would look like two discoveries; two
 * prints of different celebratory sentences would look like two verifications.
 * The subject and the outcome are what carry meaning.
 */
export function observationKey(observation: ActionObservation): string {
  return `${structuralKey(observation)}|${observation.outcome}|${errorGist(observation.detail)}`;
}

/**
 * The part of a result that identifies *which* problem it is.
 *
 * Numbers, paths with line numbers and hex addresses are stripped, so the same
 * failure reported twice is one failure and a genuinely different error is a
 * new one.
 */
export function errorGist(detail: string): string {
  return detail
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, "")
    .replace(/\d+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

// ---------------------------------------------------------------------------
// The tracker
// ---------------------------------------------------------------------------

export interface ProgressState {
  /** Consecutive actions that moved nothing. */
  streak: number;
  /** Whether the model has already been told once this epoch. */
  challenged: boolean;
  /** Everything the turn has already observed. */
  seen: Set<string>;
  /** Structural shapes, newest last, for cycle detection. */
  recent: string[];
  /** Files whose content this turn has already written once. */
  written: Map<string, string>;
  meaningful: number;
}

export function newProgressState(): ProgressState {
  return { streak: 0, challenged: false, seen: new Set(), recent: [], written: new Map(), meaningful: 0 };
}

const RECENT_WINDOW = 8;

/**
 * Folds one action into the progress state and says what it was worth.
 *
 * The rules, in the order they are asked:
 *
 * 1. A call the runtime held back moved nothing, by construction. This is the
 *    loop f4b4a30 created — a present-only turn whose model keeps proposing a
 *    command gets a challenge each time and would otherwise run to `maxSteps`.
 * 2. A file whose content actually changed is strong progress. Writing the same
 *    bytes again, or flipping a file back to something it already was, is not.
 * 3. A verifier that passed on something not yet verified is strong.
 * 4. A failure nobody has seen before is *weak* — finding out what is wrong is
 *    how it gets fixed. The same failure again is nothing, unless a file
 *    changed in between, which makes it a legitimate retry.
 * 5. An observation nobody has made before is weak.
 * 6. Everything else is nothing.
 */
export function observeAction(state: ProgressState, observation: ActionObservation): ProgressClass {
  const key = observationKey(observation);
  const shape = structuralKey(observation);
  state.recent.push(shape);
  if (state.recent.length > RECENT_WINDOW) state.recent.shift();

  const result = classify(state, observation, key);

  if (result === "none") {
    state.streak += 1;
  } else {
    state.streak = 0;
    state.challenged = false;
    state.meaningful += 1;
  }
  state.seen.add(key);
  return result;
}

function classify(
  state: ProgressState,
  observation: ActionObservation,
  key: string,
): ProgressClass {
  // 1. Held back before it ran.
  if (observation.outcome === "deferred" || observation.outcome === "denied") return "none";

  // 2. A real change to a file.
  const changed = observation.changedFiles.filter((path) => {
    const previous = state.written.get(path);
    const now = errorGist(observation.detail);
    if (previous === now) return false;
    state.written.set(path, now);
    return true;
  });
  if (changed.length > 0) return "strong";

  const command = commandOf(observation.args);
  const shape = observation.toolName === "run_command" ? commandShape(command) : "other";

  // 3. A verifier that passed, on something not verified before.
  if (observation.outcome === "executed" && shape === "verifier" && !state.seen.has(key)) return "strong";

  // A command whose only output is a sentence it was told to print verifies
  // nothing, however new the sentence is.
  if (shape === "print_only") return "none";

  // 4. A failure. New ones are worth having; repeats are not, unless something
  //    changed in between that could plausibly have fixed it.
  if (observation.outcome === "failed") {
    if (!state.seen.has(key)) return "weak";
    return "none";
  }

  // 5. Something nobody has looked at yet.
  if (!state.seen.has(key)) {
    // Rewriting the plan is not looking at anything.
    if (observation.toolName === "update_plan") return "none";
    return "weak";
  }

  return "none";
}

/**
 * A short cycle in what has been proposed, of any period up to three.
 *
 * Reported rather than acted on alone. `A B A B` is suspicious and `pytest a`
 * then `pytest b` then `pytest a` then `pytest b` while fixing both is not, so
 * this only sharpens a judgement the streak has already made.
 */
export function cyclePeriod(recent: readonly string[]): number | null {
  for (const period of [1, 2, 3]) {
    const needed = period * 2;
    if (recent.length < needed) continue;
    const tail = recent.slice(-needed);
    if (tail.slice(0, period).every((value, i) => value === tail[period + i])) return period;
  }
  return null;
}

/** Whether the model should be told, and whether the run should stop. */
export function stallVerdict(state: ProgressState): "ok" | "warn" | "stop" {
  if (state.challenged && state.streak >= STALL_WARNING_AT + STALL_TERMINATE_AFTER) return "stop";
  if (!state.challenged && state.streak >= STALL_WARNING_AT) return "warn";
  return "ok";
}

export const NO_PROGRESS_DETECTED = "NO_PROGRESS_DETECTED";

/**
 * What the model is told when it has stopped getting anywhere.
 *
 * Names the pattern rather than scolding: a model that can see it repeated the
 * same shape four times without verifying anything has something to act on. The
 * three ways out are spelled because "do something else" is not an instruction.
 */
export function describeStall(state: ProgressState, outstanding: readonly string[]): string {
  const period = cyclePeriod(state.recent);
  const lines = [
    `${NO_PROGRESS_DETECTED}: 최근 ${state.streak}개 행동이 아무것도 진전시키지 못했습니다.`,
    period === null ? "" : `같은 행동을 ${period === 1 ? "" : `${period}개씩 번갈아 `}반복하고 있습니다.`,
    "새로 검증된 것도, 바뀐 파일도, 해결된 오류도, 처음 보는 관측도 없습니다.",
    outstanding.length === 0 ? "" : `아직 남은 요구사항: ${outstanding.join(", ")}.`,
    "다음 중 하나를 하십시오 — 실질적으로 다른 방법을 시도하거나, " +
      "막힌 이유를 report_blocked로 알리거나, 지금까지 된 것과 안 된 것을 사용자에게 그대로 보고하십시오. " +
      "계획만 다시 쓰는 것은 진전이 아닙니다.",
  ];
  return lines.filter((line) => line.length > 0).join(" ");
}
