import type { SessionEvent, ToolCallStatus } from "./sessionEvents.ts";

/**
 * What has actually happened, as opposed to what was said about it.
 *
 * The failure this exists to end, from a real transcript: the agent wrote a
 * classifier, failed to load the model, ran `python -c "print('모든 코드가
 * 정상적으로 작동합니다')"`, and reported that everything worked. Every step of
 * that was available to the runtime as fact — a tool call that failed, a command
 * whose only output was a sentence it had written itself — and none of it was
 * kept. The only record was the model's prose, and prose is where the claim came
 * from.
 *
 * So the rule underneath this file:
 *
 *   The model proposes. The runtime records. A claim in text cannot change
 *   what the record says.
 *
 * ## Why this is a projection, not a store
 *
 * `TaskState` is derived from `SessionEvent`s, the same way `SessionView` is.
 * That is not tidiness — it is what makes continuation work. A turn that timed
 * out has already written its events; reloading a conversation replays them;
 * switching to a branch replays that branch's chain. The state comes back for
 * free and comes back *right*, including on a branch where the events after the
 * fork never happened.
 *
 * A separate file holding a snapshot would be a second source of truth, and the
 * two would disagree on exactly the paths that matter — after a crash, after a
 * branch switch, after a reload.
 */

/**
 * How far along one requirement is.
 *
 * `passed` and `failed` are separate from "the file exists". Writing a
 * Transformer implementation and running it are two requirements, and the real
 * transcript had the first succeed and the second fail — reported as one
 * success.
 */
export type RequirementStatus =
  | "pending"
  | "in_progress"
  | "passed"
  | "failed"
  | "blocked"
  | "skipped";

/** Statuses that mean the work is finished, one way or another. */
const SETTLED: ReadonlySet<RequirementStatus> = new Set(["passed", "failed", "blocked", "skipped"]);

/** Statuses a caller may claim as done without qualification. */
const DONE: ReadonlySet<RequirementStatus> = new Set(["passed", "skipped"]);

export interface RequirementState {
  id: string;
  /** What the user asked for, in their terms. */
  description: string;
  status: RequirementStatus;
  /** False for something the agent added on its own initiative. */
  required: boolean;
  /** Evidence ids that put it in its current status. */
  evidence: string[];
  /** Why, when the status is `failed` or `blocked`. */
  detail?: string;
}

/**
 * Something that went wrong and has not been shown to be fixed.
 *
 * Kept until it is resolved, superseded or explicitly skipped. Writing another
 * file does not make a failed model load go away, and the transcript this came
 * from did exactly that — the error scrolled past and the final report did not
 * mention it.
 */
export interface RuntimeIssue {
  id: string;
  /** What failed, in a sentence. */
  summary: string;
  /** The error as it arrived. Not a paraphrase. */
  detail: string;
  at: number;
  status: "open" | "resolved" | "superseded" | "skipped";
  /** The evidence that closed it. Present only when `resolved`. */
  resolvedBy?: string;
}

/**
 * Where a claim can come from.
 *
 * All of these originate in a tool observation. None can be produced from model
 * text, which is the whole point — see `evidenceFrom`.
 */
export type EvidenceKind =
  | "command_result"
  | "test_result"
  | "build_result"
  | "file_read"
  | "file_change"
  | "web_source"
  | "tool_result";

/** What an observation says about the thing it observed. */
export type VerificationStatus = "passed" | "failed" | "partial" | "not_run" | "blocked";

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  /** The tool call this came from. */
  source: string;
  status: VerificationStatus;
  /** A short description of what was observed. Never a conclusion drawn from it. */
  observation: string;
  at: number;
}

export type TaskStatus = "active" | "blocked" | "completed" | "cancelled";

export interface TaskState {
  taskId: string;
  goal: string;
  status: TaskStatus;
  requirements: RequirementState[];
  issues: RuntimeIssue[];
  evidence: Evidence[];
  /** Files this task has changed, as reported by the tools that changed them. */
  changedFiles: string[];
  startedAt: number;
  updatedAt: number;
}

export function emptyTask(taskId: string, goal: string, at: number): TaskState {
  return {
    taskId,
    goal,
    status: "active",
    requirements: [],
    issues: [],
    evidence: [],
    changedFiles: [],
    startedAt: at,
    updatedAt: at,
  };
}

// ---------------------------------------------------------------------------
// Evidence, and where it may come from
// ---------------------------------------------------------------------------

/**
 * Commands whose exit status means something about correctness.
 *
 * A test runner exiting 0 is a fact about the tests. `echo` exiting 0 is a fact
 * about `echo`. The difference is the whole of `verifierFor`, and without it
 * `python -c "print('all tests passed')"` is a passing test — which is what the
 * transcript this was written after actually contained.
 */
const VERIFIERS: ReadonlyArray<{ match: RegExp; kind: EvidenceKind; what: string }> = [
  { match: /\bpytest\b|\bpython\s+-m\s+pytest\b|\bunittest\b/, kind: "test_result", what: "테스트" },
  { match: /\bnpm\s+(run\s+)?test\b|\bpnpm\s+(run\s+)?test\b|\byarn\s+test\b|node\s+--test\b/, kind: "test_result", what: "테스트" },
  { match: /\bgo\s+test\b|\bcargo\s+test\b|\bdotnet\s+test\b|\bmvn\s+test\b/, kind: "test_result", what: "테스트" },
  { match: /\btsc\b|\bmypy\b|\bruff\b|\beslint\b/, kind: "build_result", what: "정적 검사" },
  { match: /\bnpm\s+run\s+build\b|\bpnpm\s+(run\s+)?build\b|\bmake\b|\bcargo\s+build\b/, kind: "build_result", what: "빌드" },
];

/**
 * A command that only prints what it was told to print.
 *
 * Its exit status says the interpreter ran. It says nothing about the sentence
 * inside it, and treating it as verification is how "모든 코드가 정상적으로
 * 작동합니다" became a verified fact.
 */
export function isSelfAuthoredOutput(command: string): boolean {
  const text = command.trim();
  if (/^echo\b/.test(text)) return true;
  // `python -c "print(...)"` and friends: a one-liner whose body is only a
  // print. A real one-liner that imports and calls something is not this.
  const oneLiner = /^\S*(python|python3|node|ruby|perl)\S*\s+(-c|-e|--eval)\s+(.*)$/s.exec(text);
  if (oneLiner === null) return false;
  const body = oneLiner[3] ?? "";
  return /^["'`]?\s*(print|console\.log|puts)\s*\(/.test(body.trim()) && !/\bimport\b|\brequire\b/.test(body);
}

/** What kind of verification a command can supply, if any. */
export function verifierFor(command: string): { kind: EvidenceKind; what: string } | null {
  if (isSelfAuthoredOutput(command)) return null;
  for (const verifier of VERIFIERS) {
    if (verifier.match.test(command)) return { kind: verifier.kind, what: verifier.what };
  }
  return null;
}

function statusOf(toolStatus: ToolCallStatus): VerificationStatus {
  if (toolStatus === "success") return "passed";
  if (toolStatus === "denied" || toolStatus === "blocked") return "blocked";
  if (toolStatus === "cancelled") return "not_run";
  return "failed";
}

/**
 * Turns one completed tool call into evidence, or into nothing.
 *
 * The only door evidence comes through. There is deliberately no path from
 * assistant text to here: a model that says "테스트를 통과했습니다" produces no
 * evidence, and the completion gate therefore cannot see a test.
 */
export function evidenceFrom(
  event: Extract<SessionEvent, { type: "tool_completed" }>,
  command?: string,
): Evidence | null {
  const base = { id: `ev-${event.id}`, source: event.callId, at: event.at };

  if (event.toolName === "run_command") {
    const verifier = command === undefined ? null : verifierFor(command);
    return {
      ...base,
      // A command that is not a verifier is still a fact about the command. It
      // just cannot answer "did the tests pass".
      kind: verifier?.kind ?? "command_result",
      status: statusOf(event.status),
      observation: verifier === null ? event.detail : `${verifier.what}: ${event.detail}`,
    };
  }

  if (event.toolName === "web_fetch" || event.toolName === "web_search") {
    return { ...base, kind: "web_source", status: statusOf(event.status), observation: event.detail };
  }
  if (event.toolName === "read_file" || event.toolName === "search_files" || event.toolName === "list_files") {
    return { ...base, kind: "file_read", status: statusOf(event.status), observation: event.detail };
  }
  // Tools whose whole purpose is to say something rather than do something —
  // the plan, a blocked report — are not observations of the workspace.
  if (event.toolName === "update_plan" || event.toolName === "report_blocked") return null;

  return { ...base, kind: "tool_result", status: statusOf(event.status), observation: event.detail };
}

// ---------------------------------------------------------------------------
// What may be claimed
// ---------------------------------------------------------------------------

/** Whether the task may be described as finished, and what to say if not. */
export interface CompletionVerdict {
  /** True only when every required requirement is `passed` or `skipped`. */
  complete: boolean;
  /** True when some required work is settled and some is not. */
  partial: boolean;
  outstanding: RequirementState[];
  failed: RequirementState[];
  openIssues: RuntimeIssue[];
}

/**
 * Whether the work is done, decided from the record rather than from a summary.
 *
 * The gate the transcript needed. Every required requirement must be `passed`
 * or explicitly skipped; anything `failed`, `blocked`, `pending` or
 * `in_progress` means it is not complete, whatever the model would like to say.
 *
 * A task with no requirements is not "complete" — it is a task nobody described,
 * and calling that finished would let the whole mechanism be bypassed by never
 * recording a requirement.
 */
export function assessCompletion(task: TaskState): CompletionVerdict {
  const required = task.requirements.filter((r) => r.required);
  const outstanding = required.filter((r) => !DONE.has(r.status));
  const failed = required.filter((r) => r.status === "failed");
  const openIssues = task.issues.filter((i) => i.status === "open");

  return {
    complete: required.length > 0 && outstanding.length === 0 && openIssues.length === 0,
    partial: required.some((r) => DONE.has(r.status)) && outstanding.length > 0,
    outstanding,
    failed,
    openIssues,
  };
}

/** Whether a requirement has settled, for progress detection. */
export function isSettled(status: RequirementStatus): boolean {
  return SETTLED.has(status);
}

/**
 * What the runtime knows, in the words a final answer has to agree with.
 *
 * Built from the record and handed to the model *before* it writes its answer,
 * rather than checked afterwards. Correcting a finished claim means rewriting
 * someone's prose around a fact they did not have; giving them the fact first
 * means they never write the sentence.
 */
export function describeTask(task: TaskState): string {
  const verdict = assessCompletion(task);
  const lines: string[] = [`목표: ${task.goal}`];

  const by = (status: RequirementStatus): string[] =>
    task.requirements.filter((r) => r.status === status).map((r) => r.description);

  const section = (label: string, items: string[]): void => {
    if (items.length > 0) lines.push(`${label}: ${items.join(", ")}`);
  };

  section("완료", by("passed"));
  section("실패", by("failed"));
  section("막힘", by("blocked"));
  section("아직 실행 안 함", [...by("pending"), ...by("in_progress")]);
  section("건너뜀", by("skipped"));

  if (verdict.openIssues.length > 0) {
    // The detail, not just the summary. "run_command: python vit.py" says
    // something failed; the error is what a next turn can act on, and
    // resuming from an unresolved failure is the whole point of keeping it.
    lines.push(
      `미해결 오류: ${verdict.openIssues.map((i) => `${i.summary} — ${i.detail}`).join("; ")}`,
    );
  }
  if (task.changedFiles.length > 0) {
    lines.push(`변경한 파일: ${task.changedFiles.join(", ")}`);
  }

  lines.push(
    verdict.complete
      ? "이 기록상 요구사항이 모두 확인되었습니다."
      : verdict.outstanding.length > 0
        ? "확인되지 않은 요구사항이 남아 있으므로 전체 완료라고 말하지 마십시오. " +
          "무엇을 했고 무엇이 남았는지 그대로 적으십시오."
        : "요구사항이 기록되지 않았습니다. 완료를 주장하지 마십시오.",
  );
  return lines.join("\n");
}
