import type { ProviderMessage } from "../provider/types.ts";
import type { RunTerminationReason, SessionEvent } from "./sessionEvents.ts";

/**
 * A conversation as a graph of turns.
 *
 * The thing this exists to make impossible is a branch where the screen went
 * back and the model did not. A turn owns both halves — what the user saw and
 * what the model read — so restoring one restores the other, and there is no
 * arrangement of the data where they can disagree.
 *
 * ## What a turn is, and is not
 *
 * A turn is one user interaction. It is created where the user actually
 * interacts — `AgentSession.send` — and never inferred from the messages.
 *
 * That distinction is load-bearing and was found the hard way. `role: "user"`
 * is an LLM protocol role, not a claim about a human: the loop pushes one
 * itself when a model announces work it did not do, and a Harness would push
 * more for reviewer feedback and corrections. A turn boundary read off `role`
 * would split one interaction into several, and every branch taken at one of
 * those false boundaries would restore a model context that never existed.
 *
 * So: the interaction layer owns turn identity; the protocol layer owns roles;
 * nothing translates between them.
 *
 * ## Deltas, not snapshots
 *
 * A turn stores what it *added* to the model's history. The whole history at
 * that point is the concatenation of the deltas from the root down. Storing a
 * full snapshot per turn would be O(n²) in a conversation's own length, which a
 * long session reaches quickly.
 */

/**
 * Whether a turn finished, and how.
 *
 * `running` exists because a turn is written before it ends — a crash mid-turn
 * should leave a turn that is visibly incomplete rather than one that looks
 * finished. Nothing ambiguous is recorded as `completed`.
 */
export type TurnState = "running" | "completed" | "aborted" | "failed";

/**
 * Room for what a Harness will need, without deciding it now.
 *
 * Left open on purpose: a turn will eventually hold several runs — a primary, a
 * reviewer, an Arena comparison — and the shape of that is not settled. What
 * matters today is that adding it later does not need another migration.
 */
export interface TurnMetadata {
  strategy?: string;
  primaryModelId?: string;
  reviewerModelIds?: string[];
  arenaRunId?: string;
  confidence?: string;
  [key: string]: unknown;
}

export interface ConversationTurn {
  id: string;
  /** Null for the first turn of a conversation. */
  parentTurnId: string | null;
  state: TurnState;
  createdAt: number;
  completedAt: number | null;

  /** What the user saw. Projected by `reduceSession`. */
  events: SessionEvent[];

  /**
   * What the model additionally read because of this turn.
   *
   * Observed from the real history across the turn, never rebuilt from the
   * events — the two are not interconvertible, and a reconstruction would be a
   * guess presented as a record. Includes the loop's own internal messages,
   * because the model read those too.
   *
   * Never contains the system message: that is re-seeded per turn from the
   * current mode, and restoring a stale one would put a prompt from another
   * mode into a branch.
   */
  messageDelta: ProviderMessage[];

  /**
   * Whether this turn's history is fit to continue from.
   *
   * False when the turn ended somewhere that left the protocol incomplete — a
   * tool call with no result, because the model was cut off between them. Such
   * a turn is still kept and still shown; it just cannot be the point a new
   * branch grows from, and saying so is better than resuming into a request the
   * gateway will reject.
   */
  restorable: boolean;
  /** Why, when `restorable` is false. Shown to the user. */
  unrestorableReason?: string;

  terminationReason?: RunTerminationReason;
  metadata?: TurnMetadata;
}

export interface ConversationBranch {
  id: string;
  name: string;
  /** The turn this branch is at. Null before its first turn. */
  headTurnId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationCheckpoint {
  id: string;
  turnId: string;
  branchId: string;
  /** What the user called this moment. */
  message: string;
  createdAt: number;
  metadata?: {
    gitHead?: string | null;
    gitBranch?: string | null;
    changedFiles?: string[];
    agentCheckpointId?: string | null;
    mode?: string;
    modelId?: string;
  };
}

export const MAIN_BRANCH_ID = "main";

export function newBranch(id: string, name: string, headTurnId: string | null, at: number): ConversationBranch {
  return { id, name, headTurnId, createdAt: at, updatedAt: at };
}

// ---------------------------------------------------------------------------
// Reading the graph
// ---------------------------------------------------------------------------

export class GraphError extends Error {
  readonly reason: "unknown_turn" | "cycle" | "not_restorable";
  constructor(reason: GraphError["reason"], message: string) {
    super(message);
    this.name = "GraphError";
    this.reason = reason;
  }
}

function index(turns: readonly ConversationTurn[]): Map<string, ConversationTurn> {
  return new Map(turns.map((t) => [t.id, t]));
}

/**
 * Root to `turnId`, in order.
 *
 * Guards against a cycle rather than trusting the data: this graph is written
 * by one process but read after a crash, an edit, or a migration, and an
 * infinite loop in a getter is a hang with no explanation.
 */
export function turnChain(turns: readonly ConversationTurn[], turnId: string): ConversationTurn[] {
  const byId = index(turns);
  const chain: ConversationTurn[] = [];
  const seen = new Set<string>();
  let current: string | null = turnId;

  while (current !== null) {
    if (seen.has(current)) throw new GraphError("cycle", `turn ${current} is its own ancestor`);
    seen.add(current);
    const turn: ConversationTurn | undefined = byId.get(current);
    if (turn === undefined) throw new GraphError("unknown_turn", `no turn ${current}`);
    chain.push(turn);
    current = turn.parentTurnId;
  }
  return chain.reverse();
}

/**
 * The model's history as it stood when `turnId` finished.
 *
 * This is the invariant the whole file is for:
 *
 *   historyAfterTurn(T) === restoreMessages(turns, T)
 *
 * The system message is absent, deliberately. `AgentSession.send` re-seeds it
 * from the current mode before every turn, so restoring one from the past would
 * reinstate a prompt for a mode the user may have left.
 */
export function restoreMessages(turns: readonly ConversationTurn[], turnId: string): ProviderMessage[] {
  return turnChain(turns, turnId).flatMap((t) => t.messageDelta);
}

/** What the user saw, up to and including `turnId`. */
export function restoreEvents(turns: readonly ConversationTurn[], turnId: string): SessionEvent[] {
  return turnChain(turns, turnId).flatMap((t) => t.events);
}

/**
 * Whether a new turn may be grown from here.
 *
 * Every turn on the way down has to be restorable, not just the last: the model
 * is given the whole chain, so one broken link anywhere in it produces a
 * request the gateway refuses.
 */
export function canBranchFrom(
  turns: readonly ConversationTurn[],
  turnId: string,
): { ok: true } | { ok: false; reason: string } {
  let chain: ConversationTurn[];
  try {
    chain = turnChain(turns, turnId);
  } catch (err) {
    return { ok: false, reason: err instanceof GraphError ? err.message : String(err) };
  }
  const broken = chain.find((t) => !t.restorable);
  if (broken !== undefined) {
    return {
      ok: false,
      reason: broken.unrestorableReason ?? "이 시점의 모델 기록이 완전하지 않아 정확히 이어갈 수 없습니다.",
    };
  }
  return { ok: true };
}

/** Turns reachable from any branch head. Used to decide what is still needed. */
export function reachableTurns(
  turns: readonly ConversationTurn[],
  branches: readonly ConversationBranch[],
): Set<string> {
  const reachable = new Set<string>();
  for (const branch of branches) {
    if (branch.headTurnId === null) continue;
    try {
      for (const turn of turnChain(turns, branch.headTurnId)) reachable.add(turn.id);
    } catch {
      // A branch pointing at a turn that is gone is a broken ref, not a reason
      // to lose the turns other branches still reach.
      continue;
    }
  }
  return reachable;
}

// ---------------------------------------------------------------------------
// Writing the graph
// ---------------------------------------------------------------------------

/**
 * Whether a turn's messages can be continued from.
 *
 * One rule, and it is the protocol's rather than ours: every tool call the
 * assistant made must have a result. A turn cut off between the two — a
 * timeout, an abort, a budget — leaves a history that every OpenAI-compatible
 * gateway rejects, so it is marked here rather than discovered on the next
 * request.
 */
export function assessRestorable(delta: readonly ProviderMessage[]): {
  restorable: boolean;
  reason?: string;
} {
  const answered = new Set<string>();
  for (const message of delta) {
    if (message.role === "tool") answered.add(message.toolCallId);
  }
  for (const message of delta) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (!answered.has(call.id)) {
        return {
          restorable: false,
          reason: `도구 호출 ${call.name} 의 결과가 기록되지 않아 이 시점에서는 정확히 이어갈 수 없습니다.`,
        };
      }
    }
  }
  return { restorable: true };
}

/**
 * How a turn ended, from why the run stopped.
 *
 * A table rather than a condition, for the same reason `terminationView` is one:
 * a new reason should be a line here, and a reason nobody mapped should be
 * visible as such rather than defaulting into `completed`. Only a run that
 * actually finished is `completed` — a turn stopped by a budget or a refusal did
 * real work and is kept, but calling it complete would be a small lie in the
 * user's own history.
 */
const TURN_STATE: Readonly<Record<RunTerminationReason, TurnState>> = {
  finished: "completed",
  denied: "aborted",
  aborted: "aborted",
  timeout: "aborted",
  loop_detected: "aborted",
  max_steps: "aborted",
  max_model_calls: "aborted",
  max_tool_calls: "aborted",
  error: "failed",
};

/** `failed` for an absent or unrecognised reason: never a silent `completed`. */
export function turnStateFor(reason: RunTerminationReason | null | undefined): TurnState {
  if (reason === null || reason === undefined) return "failed";
  return TURN_STATE[reason] ?? "failed";
}

/**
 * Assembles a finished turn from the two halves that were observed.
 *
 * Here rather than in the host so that the rules — a state from the table, a
 * restorability measured from the messages, both halves present or neither —
 * are one piece of code with one set of tests, instead of a procedure the host
 * happens to follow correctly today.
 *
 * `parentTurnId` is not an argument. Where a turn attaches is the store's to
 * know, because the store is what holds the branch head; a caller that had
 * drifted could otherwise write a turn whose parent is wrong, and a wrong parent
 * is a restore into a history that never happened.
 */
export function completedTurn(input: {
  id: string;
  startedAt: number;
  completedAt: number;
  events: SessionEvent[];
  messageDelta: ProviderMessage[];
  reason: RunTerminationReason | null;
  metadata?: TurnMetadata;
}): Omit<ConversationTurn, "parentTurnId"> {
  const verdict = assessRestorable(input.messageDelta);
  return {
    id: input.id,
    state: turnStateFor(input.reason),
    createdAt: input.startedAt,
    completedAt: input.completedAt,
    events: input.events,
    messageDelta: input.messageDelta,
    restorable: verdict.restorable,
    ...(verdict.reason === undefined ? {} : { unrestorableReason: verdict.reason }),
    ...(input.reason === null ? {} : { terminationReason: input.reason }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  };
}

/** The states a branch head may point at. Abnormal endings still count. */
export function isUsableHead(turn: ConversationTurn): boolean {
  return turn.state !== "running" && turn.restorable;
}

/**
 * Names a user may give a branch.
 *
 * Branch names never become path components — a branch is a record in one file
 * — but the check is here anyway, because "it is not used as a path today" is a
 * property of today. Refusing traversal at the point the name is accepted costs
 * nothing and does not depend on the storage layout staying as it is.
 */
export function isValidBranchName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 60) return false;
  if (trimmed.includes("..")) return false;
  if (/[/\\]/.test(trimmed)) return false;
  if (/^[a-zA-Z]:/.test(trimmed)) return false;
  // Control characters, written as escapes rather than as themselves: a
  // literal one in source is invisible to review and easy to lose to an editor.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return false;
  return true;
}

/** Ids are ours and are checked before they are trusted anywhere. */
export function isValidGraphId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/i.test(id);
}
