import type { SessionEvent } from "./sessionEvents.ts";
import { activeRequirements, type TaskContract } from "./turnContract.ts";
import { reduceTask } from "./taskReducer.ts";
import type { TaskState } from "./taskState.ts";
import { taskDisposition } from "./finalClaims.ts";
import { stateContradictions } from "./continuity.ts";

/**
 * Where the work stands, derived from the events that already exist.
 *
 * The panel had one status and it was `TaskDisposition`, which answers "may the
 * user be told this is done". That is a different question from "what is
 * happening right now", and reading the first as the second produced the screen
 * this module was written for: a turn that had *ended* — the model's unreadable
 * tool call became the answer after two repair attempts — displayed as
 * `진행 중`, because `finished` is not one of `taskDisposition`'s unfinished run
 * endings and an unmet requirement is not `partial`. Nothing was running. The
 * badge said otherwise for as long as the panel stayed open.
 *
 * ## Derived, never stored
 *
 * Everything here is a fold over `SessionEvent[]` — the same array the
 * transcript, the requirements card and the conversation store already read.
 * There is no progress record to keep in step, nothing to migrate, and a replay
 * produces exactly what the live run produced. That is also why `now` is a
 * parameter: a projection that read the clock would make a replayed turn look
 * like a running one.
 *
 * ## What it will not do
 *
 * No percentage from an activity count — twelve events is not 60% of anything.
 * No invented heartbeat: `lastActivityAt` moves only when an event does. No
 * chain-of-thought: every string here is the user's own words, a tool's own
 * summary, or a sentence this file writes about an observed fact.
 */

/**
 * The phases a turn passes through, as far as the record can tell.
 *
 * Each is reachable from events alone. `selecting_worker` and `contract_ready`
 * are different states rather than two names for waiting: a turn with no worker
 * anywhere in its history has routing still to do, and a turn whose worker was
 * carried from the previous turn does not.
 */
export type AgentProgressPhase =
  /** A request is in, and nothing has read it into a contract yet. */
  | "interpreting"
  /** The contract exists and this turn already has a worker to use. */
  | "contract_ready"
  /** The contract exists and no worker has been chosen yet. */
  | "selecting_worker"
  /** A worker is chosen and has produced neither a plan nor an action. */
  | "worker_selected"
  /** A plan exists and nothing has been proposed from it yet. */
  | "planning"
  /** An action is in flight, or one has run and the turn continues. */
  | "executing"
  /** The most recent settled action produced verification evidence. */
  | "verifying"
  | "completed"
  | "partial"
  | "blocked"
  | "failed"
  /** No terminal ending, and nothing has happened for longer than a person waits. */
  | "stalled";

/** Why there is no plan, when there is no plan. Never "empty" without a reason. */
export type PlanAbsence =
  /** No worker yet: routing has not produced one. */
  | "waiting_for_worker"
  /** A worker is chosen and the turn is waiting on its first output. */
  | "worker_streaming"
  /** Actions are running without a plan step — legitimate for a short request. */
  | "direct_execution_strategy"
  /** The model's tool call could not be read, repeatedly. */
  | "protocol_error"
  /** The worker or the provider failed. */
  | "worker_error"
  /** Nothing has moved for longer than a person waits. */
  | "stalled";

/**
 * What became of one proposed action.
 *
 * Read from `ToolCompletedEvent.disposition` and `status` — the structured
 * fields — and never from `detail`. Three different things arrive as `failed`,
 * and telling them apart by reading a sentence is what made every count
 * downstream depend on wording.
 */
export type ActionState =
  | "PROPOSED"
  | "DEFERRED"
  | "DENIED"
  | "EXECUTING"
  | "SUCCEEDED"
  | "FAILED";

export interface ProgressAction {
  /** The tool call id. Stable across a reload. */
  id: string;
  /** The tool's name, for a caller that wants to group. Not shown raw. */
  type: string;
  /** The tool's own sentence, already written for a person. */
  summary: string;
  state: ActionState;
  /** When it was proposed. */
  at: number;
  /** When it resolved, when it has. */
  endedAt?: number;
}

export type TimelineKind =
  | "request"
  | "interpreted"
  | "worker"
  | "plan"
  | "action"
  | "evidence"
  | "notice"
  | "terminal";

export interface TimelineEntry {
  /** The event id this came from. The dedupe key — see below. */
  id: string;
  at: number;
  kind: TimelineKind;
  /** A sentence for a person. Never an internal event or tool name. */
  text: string;
}

export interface AgentProgress {
  phase: AgentProgressPhase;
  /** The first event of the current turn. */
  startedAt: number;
  /** The most recent event of the current turn. Only events move this. */
  lastActivityAt: number;
  /** `now - startedAt`, from the caller's clock. */
  elapsedMs: number;
  /** How long nothing has happened. The heartbeat, without a heartbeat. */
  idleMs: number;
  currentTurnId: string;
  currentTaskId: string;
  workerModelId: string | null;
  currentActionId: string | null;
  currentActionType: string | null;
  /** Requirements the plan settled. */
  completedRequirementCount: number;
  /** Requirements the user stated. Active ones only. */
  totalRequirementCount: number;
  /** Settled *and* backed by a tool observation. */
  verifiedRequirementCount: number;
  /** The run's own ending, when it has one. */
  terminalReason: string | null;
  /** Set exactly when there is no plan. */
  planAbsence: PlanAbsence | null;
  /**
   * The plan, with two cursors that are two different facts.
   *
   * `claimedCurrent` is the model's own account of where it is — `update_plan`
   * is its narration and stays so. `groundedCurrent` is the first step the
   * record has not seen settled, counted from requirement statuses, which only
   * tool observations move. The transcript this distinguishes them for showed
   * `current: 2` over a task in which nothing had ever run; the claim is still
   * shown, but as a claim, next to what the record supports.
   */
  plan: { steps: string[]; claimedCurrent: number; groundedCurrent: number } | null;
  /**
   * Turn-to-turn reversals in the model's own story, with no evidence between.
   *
   * Counted, never acted on: prose cannot move state in either direction, so a
   * contradiction is a fact about the narration worth surfacing, not a state
   * change to undo. See `stateContradictions`.
   */
  stateContradictionCount: number;
  /** Newest last, at most one entry per event. */
  timeline: TimelineEntry[];
  /** Newest last. One entry per proposed action. */
  actions: ProgressAction[];
}

/**
 * How long without an event before the panel says so.
 *
 * A display threshold and nothing more. `progress.ts` decides whether a *run*
 * is getting anywhere, and it counts actions rather than seconds precisely
 * because a slow model is not a stalled one. This number must never end a task:
 * it changes a label, and `terminalReason` stays null underneath it.
 */
export const STALL_DISPLAY_MS = 90_000;

/** Long enough that "still waiting" is worth saying out loud. */
export const SLOW_DISPLAY_MS = 15_000;

/** Evidence kinds that mean something was actually verified. */
const VERIFYING_EVIDENCE: ReadonlySet<string> = new Set(["test_result", "build_result"]);

/**
 * The events belonging to the turn in progress, plus that turn's id.
 *
 * A turn is one user message and everything after it. Branch isolation comes
 * for free: the caller passes one branch's chain, and a sibling's events are
 * not in it.
 */
function currentTurn(events: readonly SessionEvent[]): { turnId: string; events: SessionEvent[] } {
  const lastUser = [...events].reverse().find((e) => e.type === "user_message");
  if (lastUser === undefined) return { turnId: "", events: [] };
  return { turnId: lastUser.turnId, events: events.slice(events.indexOf(lastUser)) };
}

/**
 * The structured outcome, and only the structured outcome.
 *
 * `disposition` when the record has it; `status` otherwise, which is what a
 * conversation written before that field existed carries. `detail` is not read
 * here and must not be: a deferral and a failed command say different things in
 * the same field.
 */
function stateOf(event: Extract<SessionEvent, { type: "tool_completed" }>): ActionState {
  switch (event.disposition) {
    case "deferred":
      return "DEFERRED";
    case "denied":
      return "DENIED";
    case "executed_success":
      return "SUCCEEDED";
    case "executed_failure":
      return "FAILED";
    case "cancelled":
      return "DEFERRED";
    default:
      break;
  }
  switch (event.status) {
    case "success":
      return "SUCCEEDED";
    case "denied":
    case "blocked":
      return "DENIED";
    case "cancelled":
      return "DEFERRED";
    default:
      return "FAILED";
  }
}

function actionsFrom(events: readonly SessionEvent[]): ProgressAction[] {
  const byCall = new Map<string, ProgressAction>();
  for (const event of events) {
    if (event.type === "tool_started") {
      byCall.set(event.callId, {
        id: event.callId,
        type: event.toolName,
        summary: event.summary,
        // In flight until something says otherwise. `PROPOSED` is for a call
        // the record shows was never reached.
        state: "EXECUTING",
        at: event.at,
      });
      continue;
    }
    if (event.type !== "tool_completed") continue;
    const existing = byCall.get(event.callId);
    const base: ProgressAction = existing ?? {
      id: event.callId,
      type: event.toolName,
      summary: event.toolName,
      state: "PROPOSED",
      at: event.at,
    };
    byCall.set(event.callId, { ...base, state: stateOf(event), endedAt: event.at });
  }
  return [...byCall.values()].sort((a, b) => a.at - b.at);
}

function terminalText(reason: string): string {
  switch (reason) {
    case "finished":
      return "턴이 끝났습니다";
    case "blocked":
      return "막혀서 중단했습니다";
    case "denied":
      return "사용자가 중단했습니다";
    case "aborted":
      return "취소했습니다";
    case "timeout":
      return "시간이 초과됐습니다";
    case "protocol_error":
      return "도구 호출을 읽지 못해 중단했습니다";
    case "no_progress":
      return "진전이 없어 중단했습니다";
    case "loop_detected":
      return "같은 동작이 반복돼 중단했습니다";
    case "error":
      return "오류로 중단했습니다";
    default:
      return `중단했습니다 (${reason})`;
  }
}

/** The user-facing sentence for one event, or null when it is not worth a line. */
function timelineText(
  event: SessionEvent,
  actions: ReadonlyMap<string, ProgressAction>,
): { kind: TimelineKind; text: string } | null {
  switch (event.type) {
    case "user_message":
      return { kind: "request", text: "요청을 받았습니다" };
    case "turn_contract":
      return { kind: "interpreted", text: "요청 분석 완료" };
    case "worker_selected":
      return {
        kind: "worker",
        text:
          event.selectedModelId === null
            ? "사용할 수 있는 모델을 찾지 못했습니다"
            : `모델 선택 완료 — ${event.selectedModelId}`,
      };
    case "plan":
      return { kind: "plan", text: `계획 ${event.steps.length}단계를 세웠습니다` };
    case "tool_started":
      // The tool's own sentence, already written for a person — "`pytest -q`
      // 을(를) 실행합니다". The internal tool name is not shown.
      return { kind: "action", text: `실행 중 — ${event.summary}` };
    case "tool_completed": {
      const summary = actions.get(event.callId)?.summary ?? "";
      const label = summary.length > 0 ? ` — ${summary}` : "";
      switch (stateOf(event)) {
        case "SUCCEEDED":
          return { kind: "action", text: `완료${label}` };
        case "DEFERRED":
          return { kind: "action", text: `승인 대기${label}` };
        case "DENIED":
          return { kind: "action", text: `거부됨${label}` };
        default:
          return { kind: "action", text: `실패${label}` };
      }
    }
    case "file_changed":
      return { kind: "evidence", text: `파일 변경 — ${event.path}` };
    case "notice":
      return { kind: "notice", text: event.text };
    case "run_completed":
      return { kind: "terminal", text: terminalText(event.reason) };
    default:
      // `assistant_text`, `reasoning` and `source_fact` are the model's own
      // words or its private working. The transcript already shows the first; a
      // timeline that repeated it would be a second answer, and the other two
      // are not observations of work happening.
      return null;
  }
}

/** Whether the record shows the model's tool call could not be read. */
function hadProtocolProblem(events: readonly SessionEvent[]): boolean {
  return events.some(
    (e) => e.type === "notice" && e.level !== "info" && /형식|프로토콜|읽지 못|protocol/i.test(e.text),
  );
}

function hadWorkerError(events: readonly SessionEvent[]): boolean {
  return events.some((e) => e.type === "notice" && e.level === "error");
}

/**
 * Where the work stands.
 *
 * `contract` is passed in rather than re-folded, so the panel and this share one
 * answer about what the user asked for. `now` is the caller's clock: a replayed
 * conversation passes the last event's time and gets the state that turn ended
 * in, rather than a running turn that has been idle for three days.
 */
export function progressView(input: {
  events: readonly SessionEvent[];
  contract: TaskContract;
  now: number;
  taskId?: string;
}): AgentProgress | null {
  const turn = currentTurn(input.events);
  if (turn.events.length === 0) return null;

  const startedAt = turn.events[0]?.at ?? 0;
  const lastActivityAt = turn.events.reduce((latest, e) => Math.max(latest, e.at), startedAt);
  const idleMs = Math.max(0, input.now - lastActivityAt);

  const task: TaskState | null = reduceTask(input.events, input.taskId ?? "task");
  const actions = actionsFrom(turn.events);
  const byCall = new Map(actions.map((a) => [a.id, a]));
  const running = actions.find((a) => a.state === "EXECUTING") ?? null;

  const terminal = turn.events.find((e) => e.type === "run_completed");
  const terminalReason = terminal === undefined ? null : terminal.reason;

  // `worker_selected` is written once per turn that routes. A carried worker
  // shows up in an earlier turn, which is why history is consulted for the
  // fallback rather than only this turn.
  const workerHere = [...turn.events].reverse().find((e) => e.type === "worker_selected");
  const workerEver = [...input.events].reverse().find((e) => e.type === "worker_selected");
  const workerModelId = workerHere?.selectedModelId ?? workerEver?.selectedModelId ?? null;

  const hasContract = turn.events.some((e) => e.type === "turn_contract");
  const plan = [...turn.events].reverse().find((e) => e.type === "plan");
  const verifying =
    (task?.evidence ?? []).some((e) => VERIFYING_EVIDENCE.has(e.kind)) && running === null;

  // Grounded cursor: the first plan step whose requirement the record has not
  // settled. `reduceTask` maps plan step n to requirement `r{n}`, so the plan
  // and the statuses share an index. All settled → the cursor sits on the last
  // step rather than one past it, because a cursor is a place in the plan.
  const planView =
    plan === undefined
      ? null
      : {
          steps: [...plan.steps],
          claimedCurrent: plan.current,
          groundedCurrent: groundedCursor(plan.steps, task),
        };

  const totalRequirementCount = activeRequirements(input.contract).length;
  const completedRequirementCount = (task?.requirements ?? []).filter(
    (r) => r.status === "passed" || r.status === "skipped",
  ).length;
  // Settled *and* observed. A requirement the plan called done with nothing to
  // show for it is counted on the line above and not on this one.
  const verifiedRequirementCount = (task?.requirements ?? []).filter(
    (r) => r.status === "passed" && r.evidence.length > 0,
  ).length;

  const timeline: TimelineEntry[] = [];
  const seen = new Set<string>();
  for (const event of turn.events) {
    // One line per event id. The same event arriving twice — a live post and a
    // transcript replay of the same array — must not draw two lines.
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const line = timelineText(event, byCall);
    if (line === null) continue;
    timeline.push({ id: event.id, at: event.at, kind: line.kind, text: line.text });
  }

  return {
    phase: phaseOf({
      terminalReason,
      task,
      hasContract,
      workerHere: workerHere !== undefined,
      workerModelId,
      hasPlan: plan !== undefined,
      actionCount: actions.length,
      running: running !== null,
      verifying,
      idleMs,
    }),
    startedAt,
    lastActivityAt,
    elapsedMs: Math.max(0, input.now - startedAt),
    idleMs,
    currentTurnId: turn.turnId,
    currentTaskId: input.taskId ?? "task",
    workerModelId,
    currentActionId: running?.id ?? null,
    currentActionType: running?.type ?? null,
    completedRequirementCount,
    totalRequirementCount,
    verifiedRequirementCount,
    plan: planView,
    stateContradictionCount: stateContradictions(input.events).length,
    terminalReason,
    planAbsence:
      plan !== undefined
        ? null
        : planAbsenceOf({
            terminalReason,
            workerModelId,
            actionCount: actions.length,
            turnEvents: turn.events,
            idleMs,
          }),
    timeline,
    actions,
  };
}

/** The first step the record has not seen settled, 1-based. */
function groundedCursor(steps: readonly string[], task: TaskState | null): number {
  for (let i = 0; i < steps.length; i += 1) {
    const requirement = task?.requirements.find((r) => r.id === `r${i + 1}`);
    const settled =
      requirement !== undefined && (requirement.status === "passed" || requirement.status === "skipped");
    if (!settled) return i + 1;
  }
  return Math.max(1, steps.length);
}

function phaseOf(input: {
  terminalReason: string | null;
  task: TaskState | null;
  hasContract: boolean;
  workerHere: boolean;
  workerModelId: string | null;
  hasPlan: boolean;
  actionCount: number;
  running: boolean;
  verifying: boolean;
  idleMs: number;
}): AgentProgressPhase {
  // A turn that ended is never "in progress", whatever it managed to settle.
  // This is the defect the module exists for: `finished` with an unmet
  // requirement used to fall through to `active`, and the badge never cleared.
  if (input.terminalReason !== null) {
    switch (taskDisposition(input.task, input.terminalReason)) {
      case "completed":
        return "completed";
      case "blocked":
        return "blocked";
      case "partial":
        return "partial";
      case "aborted":
        return "failed";
      default:
        // `active` from a finished run means nothing was settled — a turn that
        // ended without doing the work, not a turn still doing it.
        return input.terminalReason === "finished" ? "partial" : "failed";
    }
  }

  if (input.idleMs > STALL_DISPLAY_MS) return "stalled";
  if (input.running) return "executing";
  if (input.verifying) return "verifying";
  if (input.actionCount > 0) return "executing";
  if (input.hasPlan) return "planning";
  if (input.workerHere) return "worker_selected";
  if (input.hasContract) return input.workerModelId === null ? "selecting_worker" : "contract_ready";
  return "interpreting";
}

function planAbsenceOf(input: {
  terminalReason: string | null;
  workerModelId: string | null;
  actionCount: number;
  turnEvents: readonly SessionEvent[];
  idleMs: number;
}): PlanAbsence {
  if (hadProtocolProblem(input.turnEvents)) return "protocol_error";
  if (input.terminalReason !== null && input.terminalReason !== "finished") return "worker_error";
  if (hadWorkerError(input.turnEvents)) return "worker_error";
  if (input.actionCount > 0) return "direct_execution_strategy";
  if (input.workerModelId === null) return "waiting_for_worker";
  if (input.idleMs > STALL_DISPLAY_MS) return "stalled";
  return "worker_streaming";
}

/** What to say about a phase, in one line. Never an enum name. */
export function describePhase(phase: AgentProgressPhase): string {
  switch (phase) {
    case "interpreting":
      return "요청 분석 중";
    case "contract_ready":
      return "요청 분석 완료";
    case "selecting_worker":
      return "모델 선택 중";
    case "worker_selected":
      return "모델 응답 대기 중";
    case "planning":
      return "계획 수립 중";
    case "executing":
      return "작업 실행 중";
    case "verifying":
      return "검증 중";
    case "completed":
      return "완료";
    case "partial":
      return "일부만 완료";
    case "blocked":
      return "막힘";
    case "failed":
      return "중단됨";
    case "stalled":
      return "응답 없음";
  }
}

/** Why there is no plan, in one line a user can act on. */
export function describePlanAbsence(absence: PlanAbsence): string {
  switch (absence) {
    case "waiting_for_worker":
      return "아직 모델을 선택하는 중입니다";
    case "worker_streaming":
      return "모델 응답을 기다리는 중입니다";
    case "direct_execution_strategy":
      return "계획 없이 바로 실행하고 있습니다";
    case "protocol_error":
      return "모델이 보낸 도구 호출을 읽지 못했습니다";
    case "worker_error":
      return "모델 또는 게이트웨이 오류로 계획을 받지 못했습니다";
    case "stalled":
      return "응답이 멈춘 상태입니다";
  }
}
