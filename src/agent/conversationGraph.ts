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
 * What is said in place of a tool result that was never recorded.
 *
 * Addressed to the model, because the model is who reads it. It says what
 * happened rather than pretending the call succeeded or that it never occurred.
 */
export const INTERRUPTED_TOOL_RESULT =
  "이 도구 호출은 실행이 중단되어 결과가 기록되지 않았습니다. 결과가 필요하면 다시 호출하세요.";

/** A repair the restore had to make, so the panel can say so rather than hide it. */
export interface RepairNote {
  callId: string;
  toolName: string;
}

/**
 * Whether an entry of a stored delta is a message at all.
 *
 * A v1 file's `messages` is whatever was on disk, and a truncated write or a
 * hand-edited file puts `null` in it. Reading `.role` off that threw a
 * `TypeError` out of `readSession`, whose contract is to return null for
 * anything unreadable — so one damaged entry cost the whole call rather than
 * the one conversation. Skipped here instead: an entry that is not a message
 * cannot be holding an unanswered tool call.
 */
function isMessage(value: unknown): value is ProviderMessage {
  return value !== null && typeof value === "object";
}

/**
 * Makes a chain continuable without changing what it says.
 *
 * A turn cut off between a tool call and its result leaves a history every
 * OpenAI-compatible gateway rejects — and once a later turn is appended, the
 * dangling call sits in the middle of the conversation rather than at its end,
 * so the whole conversation becomes unusable rather than just its tip.
 *
 * The missing result is supplied, marked as interrupted, immediately after the
 * call it answers. Three things this deliberately does not do: it does not
 * pretend the tool succeeded, it does not delete the record that a call was
 * attempted, and it does not touch the stored turn. The turn on disk stays the
 * immutable copy of what was observed; this is a reading of it.
 */
export function repairChain(messages: readonly ProviderMessage[]): {
  messages: ProviderMessage[];
  repairs: RepairNote[];
} {
  const answered = new Set<string>();
  for (const message of messages) {
    if (isMessage(message) && message.role === "tool") answered.add(message.toolCallId);
  }

  const out: ProviderMessage[] = [];
  const repairs: RepairNote[] = [];
  for (const message of messages) {
    out.push(message);
    if (!isMessage(message) || message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (answered.has(call.id)) continue;
      // Right after its own call, which is where the protocol expects it.
      out.push({ role: "tool", toolCallId: call.id, content: INTERRUPTED_TOOL_RESULT });
      answered.add(call.id);
      repairs.push({ callId: call.id, toolName: call.name });
    }
  }
  return { messages: out, repairs };
}

/**
 * The model's history as it stood when `turnId` finished.
 *
 * This is the invariant the whole file is for:
 *
 *   historyAfterTurn(T) === restoreMessages(turns, T)
 *
 * …with one qualification, which is `repair`. A chain containing a tool call
 * whose result was never recorded is not a history any gateway will accept, so
 * by default the gap is filled with an interrupted marker. That is a departure
 * from "exactly what the model read", and it is the smallest one available: the
 * alternative is a conversation that cannot be continued at all. Pass
 * `{ repair: false }` for the unaltered chain — tests and inspection want it.
 *
 * The system message is absent, deliberately. `AgentSession.send` re-seeds it
 * from the current mode before every turn, so restoring one from the past would
 * reinstate a prompt for a mode the user may have left.
 */
export function restoreMessages(
  turns: readonly ConversationTurn[],
  turnId: string,
  options: { repair?: boolean } = {},
): ProviderMessage[] {
  const chain = turnChain(turns, turnId).flatMap((t) => t.messageDelta);
  return options.repair === false ? chain : repairChain(chain).messages;
}

/** What the user saw, up to and including `turnId`. */
export function restoreEvents(turns: readonly ConversationTurn[], turnId: string): SessionEvent[] {
  return turnChain(turns, turnId).flatMap((t) => t.events);
}

/**
 * Whether a new turn may be grown from here, and what it will cost.
 *
 * Only two things make a point unusable, and both are structural: the turn is
 * not there, or the graph loops. An incomplete tool call is not one of them —
 * `repairChain` makes that continuable — so this reports it as a repair rather
 * than a refusal.
 *
 * The repairs are returned rather than swallowed because the user should be
 * told. "이어갈 수 있지만 중단된 도구 호출 1건이 표시됩니다" is a different
 * sentence from silence, and only one of them is true.
 */
export function canBranchFrom(
  turns: readonly ConversationTurn[],
  turnId: string,
): { ok: true; repairs: RepairNote[] } | { ok: false; reason: string } {
  let chain: ConversationTurn[];
  try {
    chain = turnChain(turns, turnId);
  } catch (err) {
    return { ok: false, reason: err instanceof GraphError ? err.message : String(err) };
  }
  const { repairs } = repairChain(chain.flatMap((t) => t.messageDelta));
  return { ok: true, repairs };
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
    if (isMessage(message) && message.role === "tool") answered.add(message.toolCallId);
  }
  for (const message of delta) {
    if (!isMessage(message) || message.role !== "assistant") continue;
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
  blocked: "aborted",
  aborted: "aborted",
  timeout: "aborted",
  loop_detected: "aborted",
  no_progress: "aborted",
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

// ---------------------------------------------------------------------------
// Branching
// ---------------------------------------------------------------------------

/**
 * A branch is a name and a place, and nothing else.
 *
 * Worth stating because the word carries baggage from git, and one piece of it
 * must not come along: **a conversation branch does not touch the working
 * tree.** Moving between two lines of a conversation is a change of what the
 * model has read, not a change of what is on disk. A branch switch that quietly
 * ran `git checkout` would discard work the user never offered up, and there is
 * no undo for that. Files are the user's business; this is only the transcript.
 */

/**
 * Forks a branch at a turn.
 *
 * The fork point may be any turn in the graph, including one in the middle of
 * another branch — that is the whole point. What it may not be is a turn that
 * is not there, so the caller's id is checked against the graph rather than
 * trusted.
 */
export function forkBranch(
  turns: readonly ConversationTurn[],
  branches: readonly ConversationBranch[],
  input: { id: string; name: string; fromTurnId: string; at: number },
): { ok: true; branch: ConversationBranch } | { ok: false; reason: string } {
  if (!isValidGraphId(input.id)) return { ok: false, reason: `사용할 수 없는 브랜치 id입니다.` };
  if (!isValidBranchName(input.name)) return { ok: false, reason: "사용할 수 없는 브랜치 이름입니다." };
  if (branches.some((b) => b.id === input.id)) return { ok: false, reason: "이미 있는 브랜치입니다." };
  if (branches.some((b) => b.name.trim() === input.name.trim())) {
    return { ok: false, reason: "같은 이름의 브랜치가 이미 있습니다." };
  }

  const verdict = canBranchFrom(turns, input.fromTurnId);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };

  return { ok: true, branch: newBranch(input.id, input.name.trim(), input.fromTurnId, input.at) };
}

/**
 * Removes a branch.
 *
 * `main` is not removable. It is where a conversation starts and where a
 * deleted branch's user has to end up; a graph with no branch at all has turns
 * nothing points at, which is a conversation that exists and cannot be opened.
 */
export function removeBranch(
  branches: readonly ConversationBranch[],
  branchId: string,
): { ok: true; branches: ConversationBranch[] } | { ok: false; reason: string } {
  if (branchId === MAIN_BRANCH_ID) return { ok: false, reason: "main 브랜치는 삭제할 수 없습니다." };
  if (!branches.some((b) => b.id === branchId)) return { ok: false, reason: "없는 브랜치입니다." };
  return { ok: true, branches: branches.filter((b) => b.id !== branchId) };
}

/**
 * Turns no branch reaches any more.
 *
 * Reported rather than deleted. A turn that only a removed branch pointed at is
 * still a real thing that happened, and this graph is small — a conversation has
 * tens of turns, not millions. Callers that want to reclaim the space can; the
 * default is to keep the record.
 */
export function orphanedTurns(
  turns: readonly ConversationTurn[],
  branches: readonly ConversationBranch[],
): string[] {
  const reachable = reachableTurns(turns, branches);
  return turns.filter((t) => !reachable.has(t.id)).map((t) => t.id);
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

/**
 * A checkpoint is a bookmark on a turn, and only that.
 *
 * The `metadata` may record what the working tree looked like — the git head,
 * the branch, which files had changed — because that is genuinely useful to see
 * later. It is a **note about** the workspace, never a handle on it. Restoring a
 * checkpoint moves the conversation and leaves every file alone: no `git
 * reset`, no `checkout`, no `restore`, and nothing automatic. If a user wants
 * their files back they have git, and they should reach for it deliberately.
 */
export function createCheckpoint(
  turns: readonly ConversationTurn[],
  input: {
    id: string;
    turnId: string;
    branchId: string;
    message: string;
    at: number;
    metadata?: ConversationCheckpoint["metadata"];
  },
): { ok: true; checkpoint: ConversationCheckpoint } | { ok: false; reason: string } {
  if (!isValidGraphId(input.id)) return { ok: false, reason: "사용할 수 없는 체크포인트 id입니다." };
  if (!turns.some((t) => t.id === input.turnId)) return { ok: false, reason: "없는 지점입니다." };

  const message = input.message.trim();
  if (message.length === 0) return { ok: false, reason: "저장 지점에 이름을 붙여주세요." };
  if (message.length > 200) return { ok: false, reason: "이름이 너무 깁니다." };

  return {
    ok: true,
    checkpoint: {
      id: input.id,
      turnId: input.turnId,
      branchId: input.branchId,
      message,
      createdAt: input.at,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    },
  };
}

/** Checkpoints whose turn is gone. Shown as unavailable rather than followed. */
export function danglingCheckpoints(
  turns: readonly ConversationTurn[],
  checkpoints: readonly ConversationCheckpoint[],
): string[] {
  const known = new Set(turns.map((t) => t.id));
  return checkpoints.filter((c) => !known.has(c.turnId)).map((c) => c.id);
}
