import {
  SESSION_SCHEMA_V2,
  SESSION_SCHEMA_VERSION,
  type PersistedSession,
  type SessionEvent,
  type PersistedWorkspace,
  type SessionFileInput,
} from "./sessionEvents.ts";
import {
  MAIN_BRANCH_ID,
  assessRestorable,
  isValidGraphId,
  newBranch,
  restoreEvents,
  restoreMessages,
  type ConversationBranch,
  type ConversationCheckpoint,
  type ConversationTurn,
  type TurnState,
} from "./conversationGraph.ts";
import type { ProviderMessage } from "../provider/types.ts";
import { isValidWorkspaceId } from "./workspaceIdentity.ts";

/**
 * Reading and writing a conversation, across three on-disk generations.
 *
 * v1 stored `{ id, title, createdAt, updatedAt, messages }` where `messages` was
 * the model's own array. It is not wrong — the model's messages are exactly what
 * the model needs next turn — it is just not a record of what the *user* saw,
 * and the projection that read it back dropped even the tool messages it did
 * contain. v2 kept the messages and added an event log beside them.
 *
 * v3 keeps both halves but stops storing them as two flat arrays, because a
 * branch has to move them together and a flat pair cannot say where one turn
 * ended. So the file holds turns, and the flat pair is computed from them on
 * read. One source of truth; no arrangement of the file where the screen and the
 * model's context disagree.
 *
 * Nothing above this module knows which generation a file was written in.
 *
 * ## What migration will and will not invent
 *
 * A v1 file is read as its text and its tool calls and nothing else — no
 * reasoning, no plan, no termination — because those were never written down.
 *
 * A v1 or v2 file becomes **one** turn, not several. Its events carry a `turnId`
 * and its messages do not, so where the model's history divided is not recorded
 * anywhere; splitting on `role: "user"` would be a guess, and a branch taken at
 * a guessed boundary restores a context that never existed. One turn means the
 * conversation resumes exactly as before and cannot be forked at an interior
 * point that was never observed. Refusing to offer that is the honest outcome.
 *
 * The version is checked rather than assumed, following `modelCache.ts` and the
 * capability matrix: a reader that meets a number from the future refuses the
 * file instead of guessing at it.
 */

/** Migration is lossy in one direction only, and the lost parts are named. */
export interface LoadedSession {
  session: PersistedSession;
  /** True when this came from a pre-v3 file whose turns were folded into one. */
  migrated: boolean;
}

/** The id of the single turn a pre-v3 conversation becomes. */
export const LEGACY_TURN_ID = "legacy";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Whether an event is one this build understands.
 *
 * Unknown types are dropped on read rather than rejected with the file. A
 * conversation written by a newer build and opened by an older one should lose
 * the parts it cannot draw, not become unopenable — the user's history is worth
 * more than the strictness.
 */
const KNOWN: ReadonlySet<string> = new Set([
  "user_message",
  "assistant_text",
  "reasoning",
  "plan",
  "tool_started",
  "tool_completed",
  "file_changed",
  "notice",
  "run_completed",
]);

export function readEvents(value: unknown): SessionEvent[] {
  if (!Array.isArray(value)) return [];
  const out: SessionEvent[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const type = raw["type"];
    if (typeof type !== "string" || !KNOWN.has(type)) continue;
    if (typeof raw["id"] !== "string" || typeof raw["turnId"] !== "string") continue;
    out.push({ ...raw, at: num(raw["at"]) } as SessionEvent);
  }
  return out;
}

/**
 * Turns a v1 conversation into the events it implies.
 *
 * Only what the file actually contains. A v1 message array holds user text,
 * assistant text and — the part the old projection threw away — the tool calls
 * and their results. Those become `tool_started`/`tool_completed` pairs so a
 * migrated conversation shows its steps.
 *
 * What it cannot hold is reconstructed as nothing: no reasoning, no plan, no
 * changed files, no termination. A migration that guessed at those would put
 * claims in a user's history that never happened.
 */
export function migrateFromMessages(messages: readonly unknown[], startedAt: number): SessionEvent[] {
  const events: SessionEvent[] = [];
  let turn = 0;
  let seq = 0;
  const id = (): string => `m${turn}-${seq++}`;
  const turnId = (): string => `t${turn}`;

  const textOf = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((p): p is { type: "text"; text: string } => isRecord(p) && p["type"] === "text")
      .map((p) => p.text)
      .join("\n");
  };

  // Tool results arrive as their own message and name only the call they answer,
  // so the call's name is remembered when it goes past.
  const names = new Map<string, string>();

  for (const raw of messages) {
    if (!isRecord(raw)) continue;
    const role = raw["role"];

    if (role === "user") {
      // A user message opens a turn: everything after it belongs to that
      // exchange until the next one.
      turn += 1;
      const text = textOf(raw["content"]);
      if (text.trim().length > 0) {
        events.push({ type: "user_message", id: id(), turnId: turnId(), at: startedAt, text });
      }
      continue;
    }

    if (role === "assistant") {
      const text = textOf(raw["content"]);
      if (text.trim().length > 0) {
        events.push({ type: "assistant_text", id: id(), turnId: turnId(), at: startedAt, text });
      }
      const calls = raw["toolCalls"];
      if (Array.isArray(calls)) {
        for (const call of calls) {
          if (!isRecord(call)) continue;
          const callId = str(call["id"]);
          const toolName = str(call["name"], "tool");
          if (callId.length === 0) continue;
          names.set(callId, toolName);
          events.push({
            type: "tool_started",
            id: id(),
            turnId: turnId(),
            at: startedAt,
            callId,
            toolName,
            risk: "read",
            summary: toolName,
          });
        }
      }
      continue;
    }

    if (role === "tool") {
      const callId = str(raw["toolCallId"]);
      if (callId.length === 0) continue;
      const content = textOf(raw["content"]);
      events.push({
        type: "tool_completed",
        id: id(),
        turnId: turnId(),
        at: startedAt,
        callId,
        toolName: names.get(callId) ?? "tool",
        // A stored result carries no status, and inferring one from the text
        // would be a guess presented as a record.
        status: "success",
        detail: content.slice(0, 200),
      });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// The graph, on disk
// ---------------------------------------------------------------------------

const TURN_STATES: ReadonlySet<string> = new Set(["running", "completed", "aborted", "failed"]);

/**
 * Folds a flat conversation into the one turn it is known to be.
 *
 * Used for both halves of the compatibility story: reading a v1/v2 file, and
 * writing from a caller that only has the flat pair. `state` is `completed`
 * because the file was closed and written; `restorable` is measured from the
 * messages rather than assumed, so a conversation that was cut off between a
 * tool call and its result is marked as such instead of being offered as a fork
 * point that the gateway would reject.
 */
function foldIntoOneTurn(
  events: SessionEvent[],
  messages: unknown[],
  at: number,
  from: 1 | 2 | null,
): ConversationTurn {
  const verdict = assessRestorable(messages as ProviderMessage[]);
  return {
    id: LEGACY_TURN_ID,
    parentTurnId: null,
    state: "completed",
    createdAt: at,
    completedAt: at,
    events,
    messageDelta: messages as ProviderMessage[],
    restorable: verdict.restorable,
    ...(verdict.reason === undefined ? {} : { unrestorableReason: verdict.reason }),
    metadata: {
      // Marked so the branch UI can explain why this conversation has no
      // interior fork points, rather than appearing to have lost them.
      legacy: true,
      ...(from === null ? {} : { migratedFromVersion: from }),
    },
  };
}

/**
 * Validates stored turns.
 *
 * A turn missing either half is dropped, not repaired. Half a turn restores the
 * screen to one point and the model to another, which is the exact condition
 * this format exists to make impossible — keeping it and hoping would be worse
 * than losing it and saying so.
 */
export function readTurns(value: unknown): ConversationTurn[] {
  if (!Array.isArray(value)) return [];
  const out: ConversationTurn[] = [];
  const seen = new Set<string>();

  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const id = str(raw["id"]);
    if (!isValidGraphId(id) || seen.has(id)) continue;

    const parent = raw["parentTurnId"];
    const parentTurnId = typeof parent === "string" && isValidGraphId(parent) ? parent : null;

    const state = str(raw["state"]);
    if (!TURN_STATES.has(state)) continue;

    // Both halves or nothing.
    if (!Array.isArray(raw["messageDelta"])) continue;
    const events = readEvents(raw["events"]);
    const messageDelta = raw["messageDelta"] as ProviderMessage[];
    if (events.length === 0 && messageDelta.length === 0) continue;

    const completedAt = raw["completedAt"];
    const reason = raw["terminationReason"];
    const metadata = isRecord(raw["metadata"]) ? raw["metadata"] : undefined;

    seen.add(id);
    out.push({
      id,
      parentTurnId,
      state: state as TurnState,
      createdAt: num(raw["createdAt"]),
      completedAt: typeof completedAt === "number" ? completedAt : null,
      events,
      messageDelta,
      // Recomputed rather than trusted: the messages are right there, and a
      // stale flag would let a broken chain be offered as a fork point.
      ...assessRestorableFields(messageDelta),
      ...(typeof reason === "string" ? { terminationReason: reason as ConversationTurn["terminationReason"] } : {}),
      ...(metadata === undefined ? {} : { metadata }),
    });
  }

  // A turn whose parent did not survive validation would break every chain
  // through it, so the link is cut and it becomes a root instead.
  return out.map((t) =>
    t.parentTurnId !== null && !seen.has(t.parentTurnId) ? { ...t, parentTurnId: null } : t,
  );
}

function assessRestorableFields(delta: readonly ProviderMessage[]): Pick<
  ConversationTurn,
  "restorable" | "unrestorableReason"
> {
  const verdict = assessRestorable(delta);
  return verdict.reason === undefined
    ? { restorable: verdict.restorable }
    : { restorable: verdict.restorable, unrestorableReason: verdict.reason };
}

export function readBranches(value: unknown, at: number): ConversationBranch[] {
  if (!Array.isArray(value)) return [];
  const out: ConversationBranch[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const id = str(raw["id"]);
    if (!isValidGraphId(id)) continue;
    const head = raw["headTurnId"];
    out.push({
      id,
      name: str(raw["name"], id),
      headTurnId: typeof head === "string" && isValidGraphId(head) ? head : null,
      createdAt: num(raw["createdAt"], at),
      updatedAt: num(raw["updatedAt"], at),
    });
  }
  return out;
}

/**
 * The workspace a conversation says it belongs to.
 *
 * Absent for anything written before workspaces existed, and absent is not
 * "any" — see `ConversationStore.load`, which refuses a conversation whose
 * recorded workspace is a different one and treats an absent one as legacy.
 */
export function readWorkspace(value: unknown): PersistedWorkspace | undefined {
  if (!isRecord(value)) return undefined;
  const id = str(value["id"]);
  if (!isValidWorkspaceId(id)) return undefined;
  const roots = Array.isArray(value["roots"])
    ? value["roots"].filter((r): r is string => typeof r === "string")
    : undefined;
  const boundRoot = str(value["boundRoot"]);
  return {
    id,
    ...(roots === undefined || roots.length === 0 ? {} : { roots }),
    ...(boundRoot.length === 0 ? {} : { boundRoot }),
  };
}

export function readCheckpoints(value: unknown): ConversationCheckpoint[] {
  if (!Array.isArray(value)) return [];
  const out: ConversationCheckpoint[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const id = str(raw["id"]);
    const turnId = str(raw["turnId"]);
    const branchId = str(raw["branchId"]);
    if (!isValidGraphId(id) || !isValidGraphId(turnId) || !isValidGraphId(branchId)) continue;
    out.push({
      id,
      turnId,
      branchId,
      message: str(raw["message"]),
      createdAt: num(raw["createdAt"]),
      ...(isRecord(raw["metadata"]) ? { metadata: raw["metadata"] as ConversationCheckpoint["metadata"] } : {}),
    });
  }
  return out;
}

/**
 * The flat pair, computed from the graph.
 *
 * Both come from the same chain in the same call, which is what makes "the
 * screen and the model moved together" a property of the code rather than of
 * remembering to do it in two places.
 */
function project(
  turns: readonly ConversationTurn[],
  branches: readonly ConversationBranch[],
  activeBranchId: string,
): { events: SessionEvent[]; messages: unknown[] } {
  const active = branches.find((b) => b.id === activeBranchId) ?? branches[0];
  const head = active?.headTurnId ?? null;
  if (head === null) return { events: [], messages: [] };
  try {
    return { events: restoreEvents(turns, head), messages: restoreMessages(turns, head) };
  } catch {
    // A head pointing at a turn that did not survive validation. The
    // conversation is still readable as far as its turns go, in order.
    return {
      events: turns.flatMap((t) => t.events),
      messages: turns.flatMap((t) => t.messageDelta),
    };
  }
}

/**
 * Reads a conversation file of any known generation.
 *
 * Returns null for anything unreadable — a half-written file costs one
 * conversation, and the list skips it rather than failing.
 */
export function readSession(raw: string): LoadedSession | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;

  const id = str(value["id"]);
  if (id.length === 0) return null;
  // A conversation has at least one of the arrays it could have. Without this a
  // file that merely happens to be JSON with an `id` — a stray settings blob,
  // half of a failed write — would list as an empty conversation the user never
  // had.
  if (
    !Array.isArray(value["messages"]) &&
    !Array.isArray(value["events"]) &&
    !Array.isArray(value["turns"])
  ) {
    return null;
  }
  const version = num(value["version"], 1);
  // A file from a future build. Refused rather than half-read: this reader
  // cannot know which of its fields still mean what they used to.
  if (version > SESSION_SCHEMA_VERSION) return null;

  const createdAt = num(value["createdAt"]);
  const updatedAt = num(value["updatedAt"], createdAt);
  const messages = Array.isArray(value["messages"]) ? (value["messages"] as unknown[]) : [];
  const title = str(value["title"], "새 대화");

  // A v3 file with no readable turns is not refused: it falls through to the
  // fold below and comes back as a single turn built from whatever flat arrays
  // it does have. Losing the interior boundaries is a smaller harm than a
  // conversation that will not open.
  const turns = version === SESSION_SCHEMA_VERSION ? readTurns(value["turns"]) : [];

  if (turns.length > 0) {
    const stored = readBranches(value["branches"], createdAt);
    const branches =
      stored.length > 0
        ? stored
        : // A file with turns and no branches: point main at the last one so the
          // conversation is still openable rather than appearing empty.
          [newBranch(MAIN_BRANCH_ID, "main", turns[turns.length - 1]!.id, createdAt)];

    const wanted = str(value["activeBranchId"], MAIN_BRANCH_ID);
    const activeBranchId = branches.some((b) => b.id === wanted) ? wanted : branches[0]!.id;

    return {
      migrated: false,
      session: {
        version: SESSION_SCHEMA_VERSION,
        id,
        title,
        createdAt,
        updatedAt,
        turns,
        branches,
        checkpoints: readCheckpoints(value["checkpoints"]),
        activeBranchId,
        ...(readWorkspace(value["workspace"]) === undefined
          ? {}
          : { workspace: readWorkspace(value["workspace"])! }),
        ...project(turns, branches, activeBranchId),
      },
    };
  }

  // v1, v2, and a v3 file whose turns did not survive. v2 and later already
  // have an event log; v1's is derived from its messages.
  const events =
    version >= SESSION_SCHEMA_V2 && Array.isArray(value["events"])
      ? readEvents(value["events"])
      : migrateFromMessages(messages, createdAt);
  if (events.length === 0 && messages.length === 0) return null;

  const legacy = foldIntoOneTurn(events, messages, createdAt, version >= SESSION_SCHEMA_V2 ? 2 : 1);
  const branches = [newBranch(MAIN_BRANCH_ID, "main", legacy.id, createdAt)];

  return {
    migrated: true,
    session: {
      version: SESSION_SCHEMA_VERSION,
      id,
      title,
      createdAt,
      updatedAt,
      turns: [legacy],
      branches,
      checkpoints: [],
      activeBranchId: MAIN_BRANCH_ID,
      // Not `project`: identity with what was on disk matters more here than
      // going through the graph, and for a single turn they are the same thing.
      events,
      messages,
    },
  };
}

/**
 * Serialises a conversation.
 *
 * `events` and `messages` are deliberately not written: they are the projection
 * of the turns, and a file holding both the graph and a flattened copy of it has
 * somewhere for the two to disagree. A caller that has only the flat pair still
 * gets a valid v3 file — it is folded into the one turn it is known to be.
 */
export function writeSession(session: SessionFileInput): string {
  const turns =
    session.turns !== undefined && session.turns.length > 0
      ? session.turns
      : [foldIntoOneTurn(session.events, session.messages, session.createdAt, null)];

  const branches =
    session.branches !== undefined && session.branches.length > 0
      ? session.branches
      : [newBranch(MAIN_BRANCH_ID, "main", turns[turns.length - 1]!.id, session.createdAt)];

  const wanted = session.activeBranchId ?? MAIN_BRANCH_ID;
  const activeBranchId = branches.some((b) => b.id === wanted) ? wanted : branches[0]!.id;

  return `${JSON.stringify(
    {
      version: SESSION_SCHEMA_VERSION,
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      activeBranchId,
      ...(session.workspace === undefined ? {} : { workspace: session.workspace }),
      branches,
      checkpoints: session.checkpoints ?? [],
      turns,
    },
    null,
    2,
  )}\n`;
}

/** Ids that are unique within a session and stable once written. */
export function newEventId(turnId: string, ordinal: number): string {
  return `${turnId}-${ordinal.toString(36)}`;
}
