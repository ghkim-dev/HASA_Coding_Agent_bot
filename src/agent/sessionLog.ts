import {
  SESSION_SCHEMA_VERSION,
  type PersistedSession,
  type SessionEvent,
} from "./sessionEvents.ts";

/**
 * Reading and writing a conversation, across two on-disk generations.
 *
 * The old format stored `{ id, title, createdAt, updatedAt, messages }` where
 * `messages` was the model's own array. It is not wrong — the model's messages
 * are exactly what the model needs next turn — it is just not a record of what
 * the *user* saw, and the projection that read it back dropped even the tool
 * messages it did contain.
 *
 * So v2 keeps the messages and adds the events, and this module is the seam.
 * Nothing above it knows which generation a file was written in: a v1 file is
 * migrated on read into the best v2 it can be, which is a conversation with its
 * text and its tool calls and no reasoning, plan or termination — because those
 * were never written down and inventing them would be worse than their absence.
 *
 * The version is checked rather than assumed, following `modelCache.ts` and the
 * capability matrix: a reader that meets a number from the future refuses the
 * file instead of guessing at it.
 */

/** Migration is lossy in one direction only, and the lost parts are named. */
export interface LoadedSession {
  session: PersistedSession;
  /** True when this came from a v1 file and has no event log of its own. */
  migrated: boolean;
}

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
  // A conversation has at least one of the two arrays. Without this a file that
  // merely happens to be JSON with an `id` — a stray settings blob, half of a
  // failed write — would list as an empty conversation the user never had.
  if (!Array.isArray(value["messages"]) && !Array.isArray(value["events"])) return null;
  const version = num(value["version"], 1);
  // A file from a future build. Refused rather than half-read: this reader
  // cannot know which of its fields still mean what they used to.
  if (version > SESSION_SCHEMA_VERSION) return null;

  const createdAt = num(value["createdAt"]);
  const updatedAt = num(value["updatedAt"], createdAt);
  const messages = Array.isArray(value["messages"]) ? (value["messages"] as unknown[]) : [];
  const title = str(value["title"], "새 대화");

  if (version === SESSION_SCHEMA_VERSION) {
    return {
      migrated: false,
      session: {
        version: SESSION_SCHEMA_VERSION,
        id,
        title,
        createdAt,
        updatedAt,
        events: readEvents(value["events"]),
        messages,
      },
    };
  }

  return {
    migrated: true,
    session: {
      version: SESSION_SCHEMA_VERSION,
      id,
      title,
      createdAt,
      updatedAt,
      events: migrateFromMessages(messages, createdAt),
      messages,
    },
  };
}

export function writeSession(session: PersistedSession): string {
  return `${JSON.stringify({ ...session, version: SESSION_SCHEMA_VERSION }, null, 2)}\n`;
}

/** Ids that are unique within a session and stable once written. */
export function newEventId(turnId: string, ordinal: number): string {
  return `${turnId}-${ordinal.toString(36)}`;
}
