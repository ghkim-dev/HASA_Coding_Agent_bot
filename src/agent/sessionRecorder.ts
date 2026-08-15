import { newEventId } from "./sessionLog.ts";
import type {
  ActionDisposition,
  FileChangeKind,
  SessionEvent,
  ToolCallStatus,
} from "./sessionEvents.ts";
import type { AgentEvent, ApprovalOutcome } from "./types.ts";

/**
 * The seam where a running turn becomes a record of one.
 *
 * `AgentEvent` is the runtime's language and is right for driving a panel: it
 * has steps, phases and deltas, most of which stop mattering the moment they
 * stop moving. `SessionEvent` is what a conversation is made of afterwards.
 * This translates, and the translation is where the decision about what is
 * worth keeping actually lives — so it is one file, in `src/`, with tests,
 * rather than a condition scattered through the extension.
 *
 * What is dropped, and why:
 *
 *   step      — a counter for a spinner
 *   phase     — a label for a spinner
 *   checkpoint— an undo affordance, valid only while the workspace is
 *   changed    — superseded: file changes are recorded per tool call, so a
 *               summary event would double-count and would still be missing in
 *               a workspace that is not a repository
 *
 * Everything else is kept.
 */

export interface RecorderOptions {
  turnId: string;
  now?: () => number;
}

/**
 * Collects one turn's events.
 *
 * Stateful because two runtime events make one persisted one — a tool's
 * approval outcome decides the status its completion is recorded with, and the
 * approval arrives between the start and the end.
 */
export class TurnRecorder {
  private readonly turnId: string;
  private readonly now: () => number;
  private ordinal = 0;
  private readonly events: SessionEvent[] = [];
  /** Approval outcomes seen this turn, so a completion can be classified. */
  private readonly outcomes = new Map<string, ApprovalOutcome>();

  constructor(opts: RecorderOptions) {
    this.turnId = opts.turnId;
    this.now = opts.now ?? Date.now;
  }

  /** Everything recorded so far, in order. */
  drain(): SessionEvent[] {
    return [...this.events];
  }

  private next(): { id: string; turnId: string; at: number } {
    this.ordinal += 1;
    return { id: newEventId(this.turnId, this.ordinal), turnId: this.turnId, at: this.now() };
  }

  /** The user's own message, which no `AgentEvent` carries. */
  userMessage(text: string, attachments: ReadonlyArray<{ name: string; kind: string }> = []): SessionEvent[] {
    if (text.trim().length === 0 && attachments.length === 0) return [];
    const event: SessionEvent = {
      type: "user_message",
      ...this.next(),
      text,
      ...(attachments.length === 0 ? {} : { attachments: [...attachments] }),
    };
    this.events.push(event);
    return [event];
  }

  /** A notice raised by the host rather than by the loop. */
  notice(level: "info" | "warning" | "error", text: string): SessionEvent[] {
    const event: SessionEvent = { type: "notice", ...this.next(), level, text };
    this.events.push(event);
    return [event];
  }

  /**
   * Translates one runtime event. Returns what was recorded, which may be
   * nothing — the caller forwards these to the panel, so a transient event
   * still reaches the UI even though it is not kept.
   */
  record(event: AgentEvent): SessionEvent[] {
    const produced = this.translate(event);
    this.events.push(...produced);
    return produced;
  }

  private translate(event: AgentEvent): SessionEvent[] {
    switch (event.type) {
      case "text":
        return event.delta.trim().length === 0
          ? []
          : [{ type: "assistant_text", ...this.next(), text: event.delta }];

      case "reasoning":
        // A summary, never the raw stream — see `sessionEvents.ts`. The provider
        // layer is what decides a model's reasoning is fit to show; this only
        // records what it was handed.
        return event.delta.trim().length === 0
          ? []
          : [{ type: "reasoning", ...this.next(), summary: event.delta }];

      case "plan":
        return [{ type: "plan", ...this.next(), steps: [...event.steps], current: event.current }];

      // Already checked against the page it names, and the page is not kept.
      // Dropping this would leave a reopened conversation knowing which sites
      // were read and nothing about what was on them.
      case "source_fact":
        return [{ type: "source_fact", ...this.next(), fact: event.fact }];

      // Kept, and kept whole. It is what the user asked for, and folding these
      // back is how a reopened conversation still knows.
      case "contract":
        return [{ type: "turn_contract", ...this.next(), contract: event.contract }];

      case "tool_start":
        return [
          {
            type: "tool_started",
            ...this.next(),
            callId: event.callId,
            toolName: event.name,
            risk: event.risk,
            summary: event.summary,
          },
        ];

      case "tool_approval":
        // Not an event of its own: it is how the completion is classified, and
        // a separate line for "the user said yes" is noise in a history.
        this.outcomes.set(event.callId, event.outcome);
        return [];

      case "tool_end": {
        const outcome = this.outcomes.get(event.callId);
        const completed: SessionEvent = {
          type: "tool_completed",
          ...this.next(),
          callId: event.callId,
          toolName: event.name,
          status: statusFor(event.ok, outcome),
          // The loop's own word when it held the call back, and the approval
          // outcome otherwise. Never re-derived from `detail`: that string is
          // written for a person, and a metric that depends on its wording
          // breaks the day someone improves the sentence.
          disposition: event.disposition ?? dispositionFor(event.ok, outcome),
          detail: event.detail,
          ...(event.output === undefined ? {} : { output: event.output }),
          ...(event.meta === undefined ? {} : { meta: event.meta }),
          ...(event.sources === undefined ? {} : { sources: event.sources }),
        };
        const changes = (event.changedFiles ?? []).map(
          (change): SessionEvent => ({
            type: "file_changed",
            ...this.next(),
            path: change.path,
            change: change.change,
            ...(change.previousPath === undefined ? {} : { previousPath: change.previousPath }),
          }),
        );
        return [completed, ...changes];
      }

      case "error":
        return [{ type: "notice", ...this.next(), level: "error", text: event.message }];

      case "done":
        return [
          {
            type: "run_completed",
            ...this.next(),
            reason: event.reason,
            summary: event.summary,
            ...(event.detail === undefined ? {} : { detail: event.detail }),
          },
        ];

      // Transient: a spinner's counter, a spinner's label, an undo affordance,
      // and a summary superseded by per-call file changes.
      case "step":
      case "phase":
      case "checkpoint":
      case "changed":
        return [];
    }
  }
}

/**
 * How a call ended, from what the loop said about it.
 *
 * `denied` and `blocked` are recorded as themselves rather than folded into
 * `failed`: the user saying no and a policy ceiling are not tool failures, and
 * a history that calls them one cannot be read honestly later.
 */
export function statusFor(ok: boolean, outcome: ApprovalOutcome | undefined): ToolCallStatus {
  if (outcome === "denied") return "denied";
  if (outcome === "blocked") return "blocked";
  return ok ? "success" : "failed";
}

/**
 * Whether a call that reached the recorder actually ran.
 *
 * Only for calls the loop did not already classify. A denial or a block was
 * decided before the tool was reached, so neither is an execution that failed;
 * everything else here did run, and `ok` is then a fact about the work rather
 * than about the policy.
 */
export function dispositionFor(
  ok: boolean,
  outcome: ApprovalOutcome | undefined,
): ActionDisposition {
  if (outcome === "denied" || outcome === "blocked") return "denied";
  return ok ? "executed_success" : "executed_failure";
}

/** Types re-exported so callers do not reach past this seam. */
export type { FileChangeKind };
