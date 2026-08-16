import type { SessionEvent, ToolCallStatus } from "./sessionEvents.ts";
import { hostMatches, type SourceRequirement, type WebSourceProvenance } from "./sourceProvenance.ts";
import { describeSources } from "./claimGrounding.ts";
import type { SourceFact } from "./sourceFacts.ts";

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
  /**
   * Where it was read from, when it was read from outside the workspace.
   *
   * `kind: "web_source"` says a web tool produced this. It does not say which
   * site, or whether the page was read at all rather than listed by a search
   * engine — and those are the two facts a claim about a service stands on. See
   * `sourceProvenance.ts`.
   */
  sources?: WebSourceProvenance[];
}

/**
 * A recorded fact, joined to the observation it came out of.
 *
 * The link is resolved here rather than carried on the event, because the event
 * is written while the fetch is still in flight as far as ids are concerned —
 * an `Evidence` id exists only once the completion has been reduced. Content
 * addressing does the join: the fact carries the fingerprint of the body it was
 * read from, and exactly one piece of evidence has provenance with that
 * fingerprint.
 *
 * `sourceEvidenceId` is null for a fact whose evidence is not in this chain,
 * which is what a branch looks like from the inside.
 */
export interface GroundedFact extends SourceFact {
  sourceEvidenceId: string | null;
}

/**
 * A source the user named, and how far the agent got with it.
 *
 * Held on the task rather than derived at the end, so a turn can be asked "did
 * you read what they pointed at" while it still has time to.
 */
export interface SourceRequirementState extends SourceRequirement {
  /** `fetched` only when something was actually read from that host. */
  status: "pending" | "attempted" | "fetched";
  evidence: string[];
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
  /**
   * When the workspace last changed, so evidence can be told fresh from stale.
   *
   * A passing test run is evidence about the tree it ran against. Edit a source
   * file afterwards and the run still sits in `evidence` with `status: passed`,
   * describing a tree that no longer exists — and a completion gate reading it
   * would accept "tests pass" for code nobody has tested.
   *
   *     exit 0  →  edit  →  exit 0 is now a claim about the past
   *
   * Zero when nothing has changed, which makes every observation fresh.
   */
  lastChangeAt: number;
  /** URLs the user named, and whether any of them was actually read. */
  sources: SourceRequirementState[];
  /**
   * What the pages that were read were recorded as carrying.
   *
   * Distinct from `evidence`, which says a page was read. This says what was on
   * it, per entity, and it is the difference between "the agent visited the
   * catalog" and "the catalog has this model in it".
   */
  facts: GroundedFact[];
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
    lastChangeAt: 0,
    sources: [],
    facts: [],
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
  const base = {
    id: `ev-${event.id}`,
    source: event.callId,
    at: event.at,
    // Carried onto every kind, not only `web_source`. A tool that reads from
    // outside the workspace has said where, and dropping that here would put it
    // back where it was: a fact the runtime had and did not keep.
    ...(event.sources === undefined || event.sources.length === 0 ? {} : { sources: event.sources }),
  };

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
  /** Named sources the agent went to the web without ever reading. */
  unreadSources: SourceRequirementState[];
}

/**
 * Whether an unread named source counts against completeness.
 *
 * Only once the turn has been to the web at all. A user who pastes a repository
 * URL and asks for a commit has named a source they never asked anyone to read,
 * and holding the task open for it would be the runtime inventing a
 * requirement — the exact thing `turnContract.ts` exists to stop.
 *
 * When the agent *did* search or fetch, the question is live: it went looking
 * for something on the web while the user had already said where to look, and a
 * generic search is not that place. That is the failure this slice is for, and
 * it is decided from what happened rather than from anyone's reading of the
 * request.
 */
function sourcesAreLive(task: TaskState): boolean {
  return task.evidence.some((e) => e.kind === "web_source");
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
  const unreadSources = sourcesAreLive(task) ? task.sources.filter((s) => s.status !== "fetched") : [];

  return {
    // A named page nobody opened is outstanding work, not a detail. The
    // transcript this comes from ended with a confident answer about a service
    // whose site was never visited.
    complete:
      required.length > 0 && outstanding.length === 0 && openIssues.length === 0 && unreadSources.length === 0,
    partial: required.some((r) => DONE.has(r.status)) && outstanding.length > 0,
    outstanding,
    failed,
    openIssues,
    unreadSources,
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

  // What each site was actually shown to be. Placed before the verdict because
  // it is the fact most likely to be overstated in the sentence that follows.
  const sources = describeSources(task.evidence, task.sources, task.facts);
  if (sources !== null) lines.push(sources);

  for (const unread of verdict.unreadSources) {
    const attempted = unread.status === "attempted";
    lines.push(
      attempted
        ? `${unread.url} 은(는) 가져오지 못했습니다. 직접 확인했다고 쓰지 말고, ` +
          "가져오지 못했다는 것과 대신 무엇을 봤는지 적으십시오."
        : `사용자가 지정한 ${unread.url} 을(를) 아직 읽지 않았습니다. ` +
          "검색 결과는 이 페이지를 대신하지 못합니다. web_fetch로 직접 읽으십시오.",
    );
  }

  lines.push(
    verdict.complete
      ? "이 기록상 요구사항이 모두 확인되었습니다."
      : verdict.outstanding.length > 0 || verdict.unreadSources.length > 0
        ? "확인되지 않은 요구사항이 남아 있으므로 전체 완료라고 말하지 마십시오. " +
          "무엇을 했고 무엇이 남았는지 그대로 적으십시오."
        : "요구사항이 기록되지 않았습니다. 완료를 주장하지 마십시오.",
  );
  return lines.join("\n");
}
