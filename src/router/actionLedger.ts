import type { SessionEvent } from "../agent/sessionEvents.ts";
import {
  ACTION_DENIED_BY_CONSTRAINT,
  ACTION_REQUIRES_JUSTIFICATION,
  TURN_CONTRACT_REQUIRED,
} from "../agent/actionPolicy.ts";
import { selectedWorkerFor } from "./routing.ts";

/**
 * What each model actually did, projected from the events that already exist.
 *
 * The brief asks for an action history that survives a reload and says which
 * worker proposed what. The tempting shape is a second log — an
 * `action-history.json` beside the conversation — and it is the wrong one for
 * the reason the brief gives in §24 and this codebase has already paid for
 * once: two records of the same fact diverge exactly on the path where it
 * matters.
 *
 * So nothing new is stored. Everything below is a *reading* of `tool_started`,
 * `tool_completed` and `model_recommended`, which are already persisted, and
 * the reading is the same live and on replay because it is the same function
 * over the same events.
 *
 * ## Where the lifecycle actually comes from
 *
 * A held-back call is subtle and worth naming. `loop.ts` emits `tool_end` with
 * `ok: false` and *no* `tool_start` — the call never reached the registry — so
 * the recorder writes one `tool_completed` with status `failed`. Three
 * different things therefore arrive wearing the same status:
 *
 *   a command that ran and exited non-zero
 *   a command held back for not answering the request
 *   a command refused because the user forbade it
 *
 * They are told apart by the code the runtime put in `detail`, which is
 * persisted. That is why `proposed` and `executed` are different fields here
 * rather than one — the distinction the harness already enforces at runtime
 * would otherwise be lost the moment the conversation was reopened.
 */

export type ActionState =
  /** Proposed and held back before anything ran. */
  | "deferred"
  /** Refused because the user forbade it in words. */
  | "denied"
  /** Ran and succeeded. */
  | "succeeded"
  /** Ran and failed. */
  | "failed"
  /** Proposed, and the turn ended before it resolved. */
  | "pending";

export interface ActionRecord {
  /** Stable within a conversation: the tool call's own id. */
  actionId: string;
  turnId: string;
  toolName: string;
  /** The worker that proposed it, resolved from the turn's routing event. */
  modelId: string | null;
  state: ActionState;
  /** True when the model asked for it — always, by construction. */
  proposed: true;
  /** True only when it reached the tool and ran. */
  executed: boolean;
  detail: string;
  at: number;
}

/** Prefixes the runtime puts on a held-back call. Order matters: denial first. */
function heldBackState(detail: string): ActionState | null {
  if (detail.startsWith(ACTION_DENIED_BY_CONSTRAINT)) return "denied";
  if (detail.startsWith(ACTION_REQUIRES_JUSTIFICATION)) return "deferred";
  if (detail.startsWith(TURN_CONTRACT_REQUIRED)) return "deferred";
  return null;
}

/**
 * Every action on a chain, in order, attributed to the model that proposed it.
 *
 * Attribution is derived rather than stamped. A turn has exactly one worker, so
 * turnId to routing event to selected model is exact, and copying the id onto
 * every tool event would be the second copy this file exists to avoid.
 *
 * Pass the chain's events — the ones `restoreEvents` produced for a branch —
 * and the ledger is that branch's. Events from a sibling branch are not in the
 * chain, so they cannot appear here; branch isolation is a property of the
 * input rather than a rule this has to remember.
 */
export function actionLedger(events: readonly SessionEvent[]): ActionRecord[] {
  const workerByTurn = new Map<string, string | null>();
  for (const event of events) {
    if (event.type === "model_recommended") workerByTurn.set(event.turnId, event.selectedModelId);
  }
  // A turn with no routing event of its own inherits the worker in force at
  // that point — the carried case, and every conversation written before
  // routing existed.
  const workerFor = (turnId: string, upto: number): string | null => {
    const own = workerByTurn.get(turnId);
    if (own !== undefined) return own;
    return selectedWorkerFor(events.slice(0, upto))?.modelId ?? null;
  };

  const records: ActionRecord[] = [];
  const byCallId = new Map<string, ActionRecord>();

  for (const [index, event] of events.entries()) {
    if (event.type === "tool_started") {
      const record: ActionRecord = {
        actionId: event.callId,
        turnId: event.turnId,
        toolName: event.toolName,
        modelId: workerFor(event.turnId, index),
        state: "pending",
        proposed: true,
        executed: false,
        detail: event.summary,
        at: event.at,
      };
      records.push(record);
      byCallId.set(event.callId, record);
      continue;
    }

    if (event.type !== "tool_completed") continue;

    const held = heldBackState(event.detail);
    const existing = byCallId.get(event.callId);

    if (existing === undefined) {
      // No start: a call the runtime stopped before the registry saw it. This
      // is the deferral path, and it is the reason `executed` exists.
      const record: ActionRecord = {
        actionId: event.callId,
        turnId: event.turnId,
        toolName: event.toolName,
        modelId: workerFor(event.turnId, index),
        state: held ?? stateFromStatus(event.status),
        proposed: true,
        executed: held === null && event.status !== "denied" && event.status !== "blocked",
        detail: event.detail,
        at: event.at,
      };
      records.push(record);
      byCallId.set(event.callId, record);
      continue;
    }

    existing.state = held ?? stateFromStatus(event.status);
    // A call that started reached the tool. Denial and blocking are decided
    // before that, so they are the two that did not run.
    existing.executed = held === null && event.status !== "denied" && event.status !== "blocked";
    existing.detail = event.detail;
  }

  return records;
}

function stateFromStatus(status: string): ActionState {
  if (status === "success") return "succeeded";
  if (status === "denied") return "denied";
  if (status === "blocked") return "deferred";
  if (status === "cancelled") return "pending";
  return "failed";
}

export interface ActionSummary {
  proposed: number;
  executed: number;
  deferred: number;
  denied: number;
  succeeded: number;
  failed: number;
  /** Actions per model, so a run can become `observed` profile data later. */
  byModel: Record<string, number>;
}

/**
 * Counts, for audit and for a future `observed` signal.
 *
 * `proposed` and `executed` are separate counts and that is the whole point —
 * the brief's §28 and the harness's own evaluator draw the same line. A model
 * that proposed nine commands and had eight held back did not do eight things.
 */
export function summarizeActions(records: readonly ActionRecord[]): ActionSummary {
  const summary: ActionSummary = {
    proposed: records.length,
    executed: 0,
    deferred: 0,
    denied: 0,
    succeeded: 0,
    failed: 0,
    byModel: {},
  };
  for (const record of records) {
    if (record.executed) summary.executed += 1;
    if (record.state === "deferred") summary.deferred += 1;
    if (record.state === "denied") summary.denied += 1;
    if (record.state === "succeeded") summary.succeeded += 1;
    if (record.state === "failed") summary.failed += 1;
    const key = record.modelId ?? "unknown";
    summary.byModel[key] = (summary.byModel[key] ?? 0) + 1;
  }
  return summary;
}

/**
 * Whether an action changed anything in the workspace.
 *
 * An action being in the history does not mean the workspace moved. A
 * `write_file` that was denied is a real record of a real proposal and no
 * evidence of a change, and the two must not be read as one.
 */
export function changedWorkspace(events: readonly SessionEvent[], actionId: string): boolean {
  const completed = events.find(
    (e): e is Extract<SessionEvent, { type: "tool_completed" }> =>
      e.type === "tool_completed" && e.callId === actionId,
  );
  if (completed === undefined || completed.status !== "success") return false;
  return events.some((e) => e.type === "file_changed" && e.turnId === completed.turnId);
}
