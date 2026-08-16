import type { SessionEvent, ToolCallStatus } from "./sessionEvents.ts";
import {
  emptyTask,
  evidenceFrom,
  type Evidence,
  type RequirementState,
  type RuntimeIssue,
  type TaskState,
} from "./taskState.ts";
import { exactSourcesIn, hostMatches } from "./sourceProvenance.ts";
import { factKey } from "./sourceFacts.ts";

/**
 * The record, rebuilt from the events that were already being written.
 *
 * Deliberately a projection rather than a stored object, for the reason
 * continuation exists at all: a run that times out has already written its
 * events, so replaying them gives back exactly the state the run was in. The
 * same replay is what a reload does, and what switching to a branch does — and
 * on a branch it gives the state *that branch* was in, because the events after
 * the fork are not in its chain.
 *
 * A separate snapshot file would be a second source of truth, and the two would
 * disagree on precisely those paths.
 *
 * ## Where each part comes from
 *
 * - the goal, from the first thing the user said
 * - requirements, from `plan` — the model's own list of what it set out to do
 * - status, from what the tools actually reported
 * - issues, from tool calls that failed
 * - evidence, from tool completions and nowhere else
 *
 * The last is the load-bearing one. `assistant_text` contributes nothing here,
 * so a model that writes "테스트를 통과했습니다" produces no test evidence and
 * cannot move a requirement to `passed`.
 */

/** How a plan step is matched to a tool that might satisfy it. */
const STEP_KEYWORDS: ReadonlyArray<{ match: RegExp; tools: readonly string[] }> = [
  { match: /테스트|test|검증|verify/i, tools: ["run_command"] },
  { match: /실행|run|execute/i, tools: ["run_command"] },
  { match: /설치|install/i, tools: ["run_command"] },
  { match: /작성|구현|만들|생성|write|create|implement/i, tools: ["create_file", "apply_patch", "write_file"] },
  { match: /수정|고치|patch|fix|modify/i, tools: ["apply_patch", "create_file", "write_file"] },
  { match: /읽|확인|조사|read|inspect|search/i, tools: ["read_file", "search_files", "list_files"] },
  { match: /검색|찾아|search|웹|web/i, tools: ["web_search", "web_fetch"] },
];

function toolsForStep(step: string): readonly string[] {
  for (const entry of STEP_KEYWORDS) {
    if (entry.match.test(step)) return entry.tools;
  }
  return [];
}

/**
 * Builds the task from a conversation's events.
 *
 * `taskId` is the conversation's, because a conversation is one line of work.
 * Several tasks per conversation is a real thing and is not modelled here — the
 * failure this was written for is losing the one task, not distinguishing two.
 */
export function reduceTask(events: readonly SessionEvent[], taskId = "task"): TaskState | null {
  const first = events.find((e) => e.type === "user_message");
  if (first === undefined) return null;

  const task = emptyTask(taskId, first.text.trim(), first.at);

  /** Tool calls in flight, so a completion can find the call it answers. */
  const started = new Map<string, { toolName: string; summary: string; at: number }>();
  /** The command a `run_command` call was given, for `verifierFor`. */
  const commands = new Map<string, string>();

  for (const event of events) {
    task.updatedAt = Math.max(task.updatedAt, event.at);

    switch (event.type) {
      case "user_message": {
        // A URL the user typed is a fact about the request, and it is one of
        // the few the runtime can read without interpreting anything. What it
        // means — whether it must be opened — is decided in `assessCompletion`,
        // from what the turn went on to do.
        for (const source of exactSourcesIn(event.text)) {
          if (task.sources.some((s) => s.url === source.url)) continue;
          task.sources.push({ ...source, status: "pending", evidence: [] });
        }
        break;
      }

      case "source_fact": {
        // Joined to its observation by content, not by an id nobody had at the
        // time. See `GroundedFact`.
        if (task.facts.some((f) => factKey(f) === factKey(event.fact))) break;
        const evidence = task.evidence.find((e) =>
          (e.sources ?? []).some(
            (s) => s.contentFingerprint === event.fact.sourceFingerprint && hostMatches(s.hostname, event.fact.hostname),
          ),
        );
        task.facts.push({ ...event.fact, sourceEvidenceId: evidence?.id ?? null });
        break;
      }

      case "plan": {
        applyPlan(task, event.steps, event.at);
        break;
      }

      case "tool_started": {
        started.set(event.callId, { toolName: event.toolName, summary: event.summary, at: event.at });
        // The tool's own sentence carries the command for `run_command`, which
        // is what tells a verifier from an `echo`.
        if (event.toolName === "run_command") commands.set(event.callId, event.summary);
        break;
      }

      case "tool_completed": {
        const call = started.get(event.callId);
        const evidence = evidenceFrom(event, commands.get(event.callId));
        if (evidence !== null) task.evidence.push(evidence);

        if (event.status === "failed" || event.status === "blocked") {
          raise(task, {
            id: `issue-${event.id}`,
            summary: `${event.toolName}: ${call?.summary ?? ""}`.trim(),
            detail: event.detail,
            at: event.at,
            status: "open",
          });
        }
        settleSources(task, evidence);
        settleRequirements(task, event.toolName, event.status, evidence);
        break;
      }

      case "file_changed": {
        if (!task.changedFiles.includes(event.path)) task.changedFiles.push(event.path);
        // The clock every later observation is measured against.
        if (event.at > task.lastChangeAt) task.lastChangeAt = event.at;
        break;
      }

      case "run_completed": {
        // A run ending is not a task ending. `timeout` in particular leaves the
        // task exactly where it was, which is what makes "이어서 해줘" possible.
        if (event.reason === "denied" || event.reason === "aborted") task.status = "active";
        if (event.reason === "blocked") task.status = "blocked";
        break;
      }

      default:
        break;
    }
  }

  return task;
}

/**
 * The plan becomes the requirement list, once.
 *
 * Re-planning updates descriptions and adds new steps but never resets a status
 * that evidence established. A model that revises its plan after a failure must
 * not thereby erase the failure — which is exactly what happened in the
 * transcript this was written for.
 */
function applyPlan(task: TaskState, steps: readonly string[], at: number): void {
  steps.forEach((description, index) => {
    const id = `r${index + 1}`;
    const existing = task.requirements.find((r) => r.id === id);
    if (existing === undefined) {
      task.requirements.push({ id, description, status: "pending", required: true, evidence: [] });
      return;
    }
    // The description may be reworded; the status is the record's.
    existing.description = description;
  });
  void at;
}

/**
 * Marks a named source read, and only when it was read.
 *
 * The three ways this refuses to advance, each of which was the whole bug in
 * one of the transcripts:
 *
 * - A search that returned the host is `search_discovery`. A search engine
 *   saying the page exists is not the page.
 * - A fetch of a *different* host does not count, whatever it was searching
 *   for. `hostMatches` compares on a dot boundary, so
 *   `open.hasa.re.kr.evil.example.com` is somebody else.
 * - A fetch that failed is `attempted`, not `fetched`. Trying is not reading,
 *   and the final answer has to say which one happened.
 */
function settleSources(task: TaskState, evidence: Evidence | null): void {
  if (evidence === null) return;
  for (const source of evidence.sources ?? []) {
    for (const required of task.sources) {
      if (!hostMatches(source.hostname, required.hostname)) continue;
      if (source.retrieval !== "fetched") continue;
      if (evidence.status !== "passed") {
        if (required.status === "pending") required.status = "attempted";
        continue;
      }
      required.status = "fetched";
      if (!required.evidence.includes(evidence.id)) required.evidence.push(evidence.id);
    }
  }
  // A fetch that failed produces no provenance at all — the tool threw before
  // it had a page. The URL it was given is still what it tried, and that is the
  // difference between "not read" and "could not be read".
  if (evidence.kind === "web_source" && evidence.status !== "passed") {
    for (const required of task.sources) {
      if (required.status === "pending" && evidence.observation.includes(required.hostname)) {
        required.status = "attempted";
      }
    }
  }
}

function raise(task: TaskState, issue: RuntimeIssue): void {
  // One issue per failing call. A retry of the same thing raises its own, and
  // the successful one resolves whichever it can.
  if (task.issues.some((i) => i.id === issue.id)) return;
  task.issues.push(issue);
}

/**
 * Moves requirements on what the tools reported.
 *
 * Conservative in one direction and not the other. A successful call advances
 * only the *first* unsettled requirement whose words point at that kind of tool;
 * a failed one marks it failed. Nothing here can mark a requirement `passed`
 * without a tool having succeeded, which is the property that matters.
 *
 * This is a heuristic and is meant to be. The alternative — asking the model
 * which requirement its call was for — puts the model back in charge of the
 * record, and the record is the one thing it must not author.
 */
function settleRequirements(
  task: TaskState,
  toolName: string,
  status: ToolCallStatus,
  evidence: Evidence | null,
): void {
  const target = task.requirements.find(
    (r) => (r.status === "pending" || r.status === "in_progress") && toolsForStep(r.description).includes(toolName),
  );
  if (target === undefined) return;

  // The line the failing transcript walked straight through.
  //
  // "open.hasa.re.kr에서 모델 찾아줘" becomes a plan step containing 찾아, which
  // matches the web keywords, which meant *any* successful `web_search` marked
  // it passed — including one whose every result came from another site. A
  // search cannot settle a step about looking something up while a page the
  // user named is still unread. `web_fetch` can, and that is the difference.
  if (toolName === "web_search" && task.sources.some((s) => s.status !== "fetched")) return;

  if (status === "success") {
    target.status = "passed";
    if (evidence !== null) target.evidence.push(evidence.id);
    return;
  }
  if (status === "denied" || status === "blocked") {
    target.status = "blocked";
    return;
  }
  if (status === "failed") {
    target.status = "failed";
    if (evidence !== null) target.evidence.push(evidence.id);
  }
}

/**
 * Marks issues that a later success has answered.
 *
 * Called separately from the reduction because "the error is fixed" is a claim
 * about two observations — the failure, and a later success of the same thing —
 * and only the caller knows they are the same thing. Editing a file does not
 * resolve anything; re-running it and having it work does.
 */
export function resolveIssuesBy(task: TaskState, evidence: Evidence, matches: (issue: RuntimeIssue) => boolean): void {
  if (evidence.status !== "passed") return;
  for (const issue of task.issues) {
    if (issue.status === "open" && matches(issue)) {
      issue.status = "resolved";
      issue.resolvedBy = evidence.id;
    }
  }
}

/** The requirements a continuation should pick up. */
export function outstandingWork(task: TaskState): RequirementState[] {
  return task.requirements.filter(
    (r) => r.required && (r.status === "pending" || r.status === "in_progress" || r.status === "failed"),
  );
}
