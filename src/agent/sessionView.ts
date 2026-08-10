import type {
  FileChangeKind,
  ReasoningPhase,
  RunTerminationReason,
  SessionEvent,
  ToolCallStatus,
  TruncationMeta,
} from "./sessionEvents.ts";

/**
 * Events in, something renderable out.
 *
 * One function, used twice: the panel folds live events into it as they arrive,
 * and folds a loaded session into it on reopen. That is the whole reason it
 * exists. Before, a live turn was drawn by incremental DOM code and a reopened
 * one by a different function that read the model's message array — so the two
 * disagreed about what a conversation contains, and the reopened one was
 * missing every tool step, every plan and every result. Two renderers cannot be
 * kept in agreement by care; one renderer does not need to be.
 *
 * Nothing here touches the DOM or knows what VS Code is. It is data, so
 * `pnpm test` can assert the invariant that matters:
 *
 *   reduce(events) === reduce(JSON.parse(JSON.stringify(events)))
 *
 * The view model is deliberately flat and ordered. A block is a thing that was
 * shown, in the order it was shown, and rendering is then a loop rather than a
 * reconstruction.
 */

export interface TextBlock {
  kind: "text";
  id: string;
  /** Markdown, rendered by the panel. */
  text: string;
}

export interface ReasoningBlock {
  kind: "reasoning";
  id: string;
  summary: string;
  phase?: ReasoningPhase;
}

export interface PlanBlock {
  kind: "plan";
  id: string;
  /** Every step, always. What is displayed is decided at render time. */
  steps: string[];
  current: number;
}

export interface ToolBlock {
  kind: "tool";
  id: string;
  callId: string;
  toolName: string;
  summary: string;
  /** Absent while the call is still running. */
  status?: ToolCallStatus;
  detail?: string;
  output?: string;
  meta?: TruncationMeta;
}

export interface NoticeBlock {
  kind: "notice";
  id: string;
  level: "info" | "warning" | "error";
  text: string;
}

export type Block = TextBlock | ReasoningBlock | PlanBlock | ToolBlock | NoticeBlock;

/**
 * How a run ended, as fields rather than a string to compare.
 *
 * The UI renders `tone`, `label` and `detail`; it never sees `reason` except to
 * pass it back. That is the rule that keeps termination handling out of the
 * webview — a new reason changes this table and nothing else.
 */
export interface TerminationView {
  reason: RunTerminationReason;
  tone: "ok" | "warning" | "error";
  label: string;
  detail?: string;
}

export interface TurnView {
  turnId: string;
  role: "user" | "agent";
  blocks: Block[];
  /** Present once the run for this turn has ended. */
  termination?: TerminationView;
}

export interface FileChangeView {
  path: string;
  change: FileChangeKind;
  previousPath?: string;
}

export interface SessionView {
  turns: TurnView[];
  /**
   * Every file the agent touched this session, newest state per path.
   *
   * Built from what the tools reported, not from git — a workspace that is not
   * a repository still has files, and still has an agent writing to them.
   */
  changedFiles: FileChangeView[];
}

/**
 * What each ending means, in one place.
 *
 * `finished` is the only `ok`. Everything else is a run that did not do what
 * was asked, and saying so plainly is the point: a turn stopped for looping
 * used to look exactly like one that succeeded.
 */
const TERMINATION: Readonly<Record<RunTerminationReason, { tone: TerminationView["tone"]; label: string }>> = {
  finished: { tone: "ok", label: "작업 완료" },
  denied: { tone: "warning", label: "승인하지 않으셔서 중단했습니다" },
  // Warning, deliberately not "ok". The whole point is that this does not look
  // like the turn succeeded, because it did not.
  blocked: { tone: "warning", label: "요청하신 것을 완료하지 못했습니다" },
  aborted: { tone: "warning", label: "작업을 취소했습니다" },
  timeout: { tone: "warning", label: "실행 시간 제한을 넘어 중단했습니다" },
  loop_detected: { tone: "warning", label: "같은 행동을 반복해 중단했습니다" },
  no_progress: { tone: "warning", label: "진전이 없어 중단했습니다" },
  max_steps: { tone: "warning", label: "한 번에 처리할 수 있는 단계 수를 넘었습니다" },
  max_model_calls: { tone: "warning", label: "모델 호출 예산을 소진했습니다" },
  max_tool_calls: { tone: "warning", label: "도구 호출 예산을 소진했습니다" },
  error: { tone: "error", label: "오류로 중단했습니다" },
};

export function terminationView(reason: RunTerminationReason, detail?: string): TerminationView {
  const entry = TERMINATION[reason] ?? TERMINATION.error;
  return { reason, tone: entry.tone, label: entry.label, ...(detail === undefined ? {} : { detail }) };
}

/** Whether an ending is worth interrupting the reader about. */
export function isAbnormal(reason: RunTerminationReason): boolean {
  return reason !== "finished";
}

/**
 * Folds one event into a view.
 *
 * Mutates and returns the same object: the panel folds hundreds of these during
 * a turn, and a fresh copy each time would be a copy of the whole transcript
 * each time. Callers that want immutability can clone once, at the edge.
 */
export function applyEvent(view: SessionView, event: SessionEvent): SessionView {
  const role: TurnView["role"] = event.type === "user_message" ? "user" : "agent";
  let turn = view.turns.find((t) => t.turnId === event.turnId && t.role === role);
  if (turn === undefined) {
    turn = { turnId: event.turnId, role, blocks: [] };
    view.turns.push(turn);
  }

  switch (event.type) {
    case "user_message":
      turn.blocks.push({ kind: "text", id: event.id, text: event.text });
      break;

    case "assistant_text": {
      // Consecutive text is one block. The runtime emits a delta per model call,
      // and three paragraphs in a row are three deltas but one thing said.
      const previous = turn.blocks[turn.blocks.length - 1];
      if (previous !== undefined && previous.kind === "text") previous.text += event.text;
      else turn.blocks.push({ kind: "text", id: event.id, text: event.text });
      break;
    }

    case "reasoning":
      turn.blocks.push({
        kind: "reasoning",
        id: event.id,
        summary: event.summary,
        ...(event.phase === undefined ? {} : { phase: event.phase }),
      });
      break;

    case "plan": {
      // A plan is state, not a log: the model sends the whole list each time and
      // the latest one replaces the last. Keeping every revision would show the
      // user a stack of plans, most of them wrong.
      const existing = turn.blocks.find((b): b is PlanBlock => b.kind === "plan");
      if (existing !== undefined) {
        existing.steps = event.steps;
        existing.current = event.current;
      } else {
        turn.blocks.push({ kind: "plan", id: event.id, steps: event.steps, current: event.current });
      }
      break;
    }

    case "tool_started":
      turn.blocks.push({
        kind: "tool",
        id: event.id,
        callId: event.callId,
        toolName: event.toolName,
        summary: event.summary,
      });
      break;

    case "tool_completed": {
      // Matched by callId rather than by position: tools can be requested in a
      // batch and complete out of order.
      const started = turn.blocks.find((b): b is ToolBlock => b.kind === "tool" && b.callId === event.callId);
      const target =
        started ??
        (() => {
          // A completion with no start — a refusal raised before the call ran.
          // Shown rather than dropped, which is what used to happen.
          const block: ToolBlock = {
            kind: "tool",
            id: event.id,
            callId: event.callId,
            toolName: event.toolName,
            summary: event.toolName,
          };
          turn!.blocks.push(block);
          return block;
        })();
      target.status = event.status;
      target.detail = event.detail;
      if (event.output !== undefined) target.output = event.output;
      if (event.meta !== undefined) target.meta = event.meta;
      break;
    }

    case "file_changed": {
      const existing = view.changedFiles.find((f) => f.path === event.path);
      if (existing === undefined) {
        view.changedFiles.push({
          path: event.path,
          change: event.change,
          ...(event.previousPath === undefined ? {} : { previousPath: event.previousPath }),
        });
      } else if (existing.change !== "created") {
        // A file created and then edited is still created, from the user's
        // point of view. Anything else takes the latest verdict.
        existing.change = event.change;
      }
      break;
    }

    case "notice":
      turn.blocks.push({ kind: "notice", id: event.id, level: event.level, text: event.text });
      break;

    case "run_completed":
      turn.termination = terminationView(event.reason, event.detail);
      // The model's closing words, when the turn produced none of its own —
      // otherwise the summary would repeat what is already above it.
      if (event.summary.trim().length > 0 && !turn.blocks.some((b) => b.kind === "text")) {
        turn.blocks.push({ kind: "text", id: `${event.id}-summary`, text: event.summary });
      }
      break;
  }

  return view;
}

export function emptyView(): SessionView {
  return { turns: [], changedFiles: [] };
}

/** The whole conversation, from the whole log. */
export function reduceSession(events: readonly SessionEvent[]): SessionView {
  const view = emptyView();
  for (const event of events) applyEvent(view, event);
  return view;
}
