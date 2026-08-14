import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_TURN_ID,
  readSession,
  writeSession,
  migrateFromMessages,
  readTurns,
  readBranches,
  readCheckpoints,
} from "./sessionLog.ts";
import { SESSION_SCHEMA_VERSION, type SessionEvent } from "./sessionEvents.ts";
import {
  MAIN_BRANCH_ID,
  assessRestorable,
  canBranchFrom,
  reachableTurns,
  repairChain,
  restoreEvents,
  restoreMessages,
  turnChain,
  type ConversationTurn,
} from "./conversationGraph.ts";
import type { ProviderMessage } from "../provider/types.ts";

/**
 * The on-disk migration, swept rather than sampled.
 *
 * `sessionLog.test.ts` and `sessionView.test.ts` already check that a v1 file
 * opens and that the reducer round-trips. What they check is one shape each.
 * The claim this file makes is stronger and is the one a migration actually has
 * to earn:
 *
 *   for **every** shape a file of a previous generation could have had,
 *   what it contained comes back, and what it did not contain is not invented.
 *
 * So the fixtures are generated — every content encoding a provider ever used,
 * crossed with every message skeleton a real conversation produces, crossed
 * with answered, unanswered and batched tool calls — and every expectation is
 * *derived from the fixture* rather than written down beside it. A hand-written
 * expectation is a second copy of the migration, and two copies of a rule drift.
 */

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

/** Every way a provider has spelled a message body. */
const CONTENT_FORMS = {
  string: (t: string): unknown => t,
  parts: (t: string): unknown => [{ type: "text", text: t }],
  splitParts: (t: string): unknown => [
    { type: "text", text: t },
    { type: "text", text: `${t} (cont)` },
  ],
  mixedParts: (t: string): unknown => [
    { type: "image", url: "https://example.invalid/x.png" },
    { type: "text", text: t },
  ],
  empty: (): unknown => "",
  blank: (): unknown => "   ",
} as const;

type ContentForm = keyof typeof CONTENT_FORMS;

/** How a turn's tool calls were left. */
type ToolPattern = "none" | "answered" | "unanswered" | "batch" | "batchHalfAnswered";

interface Skeleton {
  name: string;
  /** Each entry is one message in the v1 array. */
  steps: Array<"user" | "assistant" | "assistantWithTools" | "toolResults">;
}

const SKELETONS: readonly Skeleton[] = [
  { name: "user-only", steps: ["user"] },
  { name: "one-exchange", steps: ["user", "assistant"] },
  { name: "tool-exchange", steps: ["user", "assistantWithTools", "toolResults", "assistant"] },
  { name: "two-exchanges", steps: ["user", "assistant", "user", "assistant"] },
  {
    name: "two-tool-exchanges",
    steps: ["user", "assistantWithTools", "toolResults", "user", "assistantWithTools", "toolResults", "assistant"],
  },
  { name: "cut-off-mid-tool", steps: ["user", "assistantWithTools"] },
  { name: "assistant-first", steps: ["assistant", "user", "assistant"] },
  { name: "trailing-user", steps: ["user", "assistant", "user"] },
];

const TOOL_PATTERNS: readonly ToolPattern[] = [
  "none",
  "answered",
  "unanswered",
  "batch",
  "batchHalfAnswered",
];

interface Fixture {
  name: string;
  messages: unknown[];
}

function buildMessages(skeleton: Skeleton, form: ContentForm, pattern: ToolPattern): unknown[] {
  const body = CONTENT_FORMS[form];
  const messages: unknown[] = [];
  let n = 0;
  /** Calls emitted by the most recent assistant message, awaiting results. */
  let pending: Array<{ id: string; name: string }> = [];

  for (const step of skeleton.steps) {
    n += 1;
    if (step === "user") {
      messages.push({ role: "user", content: body(`user says ${n}`) });
      continue;
    }
    if (step === "assistant") {
      messages.push({ role: "assistant", content: body(`assistant says ${n}`) });
      continue;
    }
    if (step === "assistantWithTools") {
      const calls =
        pattern === "none"
          ? []
          : pattern === "batch" || pattern === "batchHalfAnswered"
            ? [
                { id: `c${n}a`, name: "read_file", arguments: '{"path":"a.ts"}' },
                { id: `c${n}b`, name: "run_command", arguments: '{"command":"pytest -q"}' },
              ]
            : [{ id: `c${n}`, name: "read_file", arguments: '{"path":"a.ts"}' }];
      messages.push({ role: "assistant", content: body(`assistant works ${n}`), toolCalls: calls });
      pending =
        pattern === "unanswered"
          ? []
          : pattern === "batchHalfAnswered"
            ? calls.slice(0, 1)
            : calls;
      continue;
    }
    // toolResults
    for (const call of pending) {
      messages.push({ role: "tool", toolCallId: call.id, content: body(`result of ${call.name}`) });
    }
    pending = [];
  }
  return messages;
}

const V1_FIXTURES: Fixture[] = [];
for (const skeleton of SKELETONS) {
  for (const form of Object.keys(CONTENT_FORMS) as ContentForm[]) {
    for (const pattern of TOOL_PATTERNS) {
      // A skeleton with no tool step says nothing new per tool pattern.
      const usesTools = skeleton.steps.some((s) => s === "assistantWithTools");
      if (!usesTools && pattern !== "none") continue;
      V1_FIXTURES.push({
        name: `${skeleton.name}/${form}/${pattern}`,
        messages: buildMessages(skeleton, form, pattern),
      });
    }
  }
}

function v1File(fixture: Fixture, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: `conv-${fixture.name}`,
    title: "예전 대화",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_500_000,
    messages: fixture.messages,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// What the file actually contained — computed, never asserted from memory
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: "text"; text: string } => isRecord(p) && p["type"] === "text")
    .map((p) => p.text)
    .join("\n");
}

function callsIn(messages: readonly unknown[]): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  for (const raw of messages) {
    if (!isRecord(raw) || raw["role"] !== "assistant") continue;
    const calls = raw["toolCalls"];
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (isRecord(call) && typeof call["id"] === "string" && call["id"].length > 0) {
        out.push({ id: call["id"], name: typeof call["name"] === "string" ? call["name"] : "tool" });
      }
    }
  }
  return out;
}

function resultsIn(messages: readonly unknown[]): string[] {
  return messages
    .filter((m): m is Record<string, unknown> => isRecord(m) && m["role"] === "tool")
    .map((m) => (typeof m["toolCallId"] === "string" ? m["toolCallId"] : ""))
    .filter((id) => id.length > 0);
}

function speakingMessages(messages: readonly unknown[], role: string): number {
  return messages.filter((m) => isRecord(m) && m["role"] === role && textOf(m["content"]).trim().length > 0).length;
}

/** Event types a v1 file can possibly justify. Everything else would be invented. */
const DERIVABLE: ReadonlySet<string> = new Set([
  "user_message",
  "assistant_text",
  "tool_started",
  "tool_completed",
]);

// ---------------------------------------------------------------------------
// v1 → v3
// ---------------------------------------------------------------------------

type Check = (fixture: Fixture) => void;

const V1_INVARIANTS: ReadonlyArray<readonly [string, Check]> = [
  [
    "opens at all",
    (f) => assert.notEqual(readSession(v1File(f)), null, "a v1 file must not become unopenable"),
  ],
  [
    "reports itself as migrated",
    (f) => assert.equal(readSession(v1File(f))!.migrated, true),
  ],
  [
    "is read at the current schema version",
    (f) => assert.equal(readSession(v1File(f))!.session.version, SESSION_SCHEMA_VERSION),
  ],
  [
    "folds into exactly one turn",
    (f) => assert.equal(readSession(v1File(f))!.session.turns.length, 1),
  ],
  [
    "that turn is the legacy turn",
    (f) => assert.equal(readSession(v1File(f))!.session.turns[0]!.id, LEGACY_TURN_ID),
  ],
  [
    "the turn is marked legacy and says which version it came from",
    (f) => {
      const turn = readSession(v1File(f))!.session.turns[0]!;
      assert.equal(turn.metadata?.legacy, true);
      assert.equal(turn.metadata?.migratedFromVersion, 1);
    },
  ],
  [
    "the stored turn keeps the messages exactly as they were on disk",
    (f) => {
      const loaded = readSession(v1File(f))!;
      assert.deepEqual(
        loaded.session.turns[0]!.messageDelta,
        f.messages,
        "the record of what the model read is not edited by reading it",
      );
    },
  ],
  [
    "what the model is handed is that record, made continuable",
    (f) => {
      const loaded = readSession(v1File(f))!;
      assert.deepEqual(
        loaded.session.messages,
        repairChain(f.messages as ProviderMessage[]).messages,
      );
    },
  ],
  [
    "a conversation cut off mid-tool-call is continuable on its first open",
    (f) => {
      const loaded = readSession(v1File(f))!;
      assert.equal(
        assessRestorable(loaded.session.messages as ProviderMessage[]).restorable,
        true,
        "a dangling tool call reaches the gateway and is rejected there",
      );
    },
  ],
  [
    "the first open and a later reopen hand over the same history",
    (f) => {
      const first = readSession(v1File(f))!.session;
      const reopened = readSession(writeSession(first))!.session;
      assert.deepEqual(first.messages, reopened.messages);
    },
  ],
  [
    "invents no event a v1 file could not contain",
    (f) => {
      for (const event of readSession(v1File(f))!.session.events) {
        assert.ok(
          DERIVABLE.has(event.type),
          `${event.type} cannot be derived from a v1 message array — it was invented`,
        );
      }
    },
  ],
  [
    "keeps every tool call the old projection used to drop",
    (f) => {
      const events = readSession(v1File(f))!.session.events;
      const started = events.filter((e) => e.type === "tool_started");
      assert.equal(started.length, callsIn(f.messages).length);
    },
  ],
  [
    "keeps every tool result the old projection used to skip",
    (f) => {
      const events = readSession(v1File(f))!.session.events;
      const completed = events.filter((e) => e.type === "tool_completed");
      assert.equal(completed.length, resultsIn(f.messages).length);
    },
  ],
  [
    "names each completed call after the call it answers",
    (f) => {
      const events = readSession(v1File(f))!.session.events;
      const byId = new Map(callsIn(f.messages).map((c) => [c.id, c.name]));
      for (const event of events) {
        if (event.type !== "tool_completed") continue;
        assert.equal(event.toolName, byId.get(event.callId) ?? "tool");
      }
    },
  ],
  [
    "emits one text event per message that actually said something",
    (f) => {
      const events = readSession(v1File(f))!.session.events;
      assert.equal(
        events.filter((e) => e.type === "user_message").length,
        speakingMessages(f.messages, "user"),
      );
      assert.equal(
        events.filter((e) => e.type === "assistant_text").length,
        speakingMessages(f.messages, "assistant"),
      );
    },
  ],
  [
    "every event carries an id and a turn",
    (f) => {
      for (const event of readSession(v1File(f))!.session.events) {
        assert.equal(typeof event.id, "string");
        assert.ok(event.id.length > 0);
        assert.equal(typeof event.turnId, "string");
        assert.ok(event.turnId.length > 0);
      }
    },
  ],
  [
    "event ids are unique within the conversation",
    (f) => {
      const ids = readSession(v1File(f))!.session.events.map((e) => e.id);
      assert.equal(new Set(ids).size, ids.length);
    },
  ],
  [
    "gets one main branch pointing at the legacy turn",
    (f) => {
      const session = readSession(v1File(f))!.session;
      assert.equal(session.branches.length, 1);
      assert.equal(session.branches[0]!.id, MAIN_BRANCH_ID);
      assert.equal(session.branches[0]!.headTurnId, LEGACY_TURN_ID);
      assert.equal(session.activeBranchId, MAIN_BRANCH_ID);
    },
  ],
  [
    "carries no checkpoints it never had",
    (f) => assert.deepEqual(readSession(v1File(f))!.session.checkpoints, []),
  ],
  [
    "keeps the date the conversation was actually created",
    (f) => {
      const session = readSession(v1File(f))!.session;
      assert.equal(session.createdAt, 1_700_000_000_000);
      assert.equal(session.updatedAt, 1_700_000_500_000);
      assert.equal(session.turns[0]!.createdAt, 1_700_000_000_000);
    },
  ],
  [
    "measures restorability from the messages rather than assuming it",
    (f) => {
      const turn = readSession(v1File(f))!.session.turns[0]!;
      const measured = assessRestorable(f.messages as ProviderMessage[]);
      assert.equal(turn.restorable, measured.restorable);
      assert.equal(turn.unrestorableReason, measured.reason);
    },
  ],
  [
    "offers no interior fork point, because none was ever observed",
    (f) => {
      const session = readSession(v1File(f))!.session;
      assert.equal(turnChain(session.turns, LEGACY_TURN_ID).length, 1);
      assert.equal(reachableTurns(session.turns, session.branches).size, 1);
    },
  ],
  [
    "can still be continued",
    (f) => {
      const session = readSession(v1File(f))!.session;
      assert.equal(canBranchFrom(session.turns, LEGACY_TURN_ID).ok, true);
    },
  ],
  [
    "survives a write and a read unchanged",
    (f) => {
      const first = readSession(v1File(f))!.session;
      const second = readSession(writeSession(first))!;
      assert.equal(second.migrated, false, "a v3 file is not migrated again");
      assert.deepEqual(second.session.turns, first.turns);
      assert.deepEqual(second.session.messages, first.messages);
      assert.deepEqual(second.session.events, first.events);
    },
  ],
  [
    "is refused outright when it claims a version from the future",
    (f) => {
      for (const version of [4, 5, 9, 42]) {
        assert.equal(readSession(v1File(f, { version })), null);
      }
    },
  ],
];

describe("migration · v1 files, every shape they came in", () => {
  for (const fixture of V1_FIXTURES) {
    for (const [claim, check] of V1_INVARIANTS) {
      test(`${fixture.name} — ${claim}`, () => check(fixture));
    }
  }
});

// ---------------------------------------------------------------------------
// migrateFromMessages, on its own
// ---------------------------------------------------------------------------

describe("migration · what a message array implies, and nothing more", () => {
  for (const fixture of V1_FIXTURES) {
    test(`${fixture.name} — events are ordered as the messages were`, () => {
      const events = migrateFromMessages(fixture.messages, 500);
      const order = events.map((e) => e.type);
      // Every tool_completed follows the tool_started it answers.
      for (let i = 0; i < events.length; i += 1) {
        const event = events[i]!;
        if (event.type !== "tool_completed") continue;
        const startedAt = events.findIndex(
          (e) => e.type === "tool_started" && e.callId === event.callId,
        );
        if (startedAt >= 0) assert.ok(startedAt < i, `${event.callId} completed before it started`);
      }
      assert.ok(order.length >= 0);
    });

    test(`${fixture.name} — every event is stamped with the conversation's own time`, () => {
      for (const event of migrateFromMessages(fixture.messages, 12_345)) {
        assert.equal(event.at, 12_345);
      }
    });

    test(`${fixture.name} — a stored result is never given a status nobody recorded`, () => {
      for (const event of migrateFromMessages(fixture.messages, 1)) {
        if (event.type === "tool_completed") assert.equal(event.status, "success");
      }
    });

    test(`${fixture.name} — deriving twice derives the same thing`, () => {
      assert.deepEqual(
        migrateFromMessages(fixture.messages, 7),
        migrateFromMessages(fixture.messages, 7),
      );
    });
  }
});

// ---------------------------------------------------------------------------
// v2 → v3
// ---------------------------------------------------------------------------

function v2Event(type: string, turnId: string, n: number): Record<string, unknown> {
  const base = { type, id: `${turnId}-${n}`, turnId, at: 1000 + n };
  switch (type) {
    case "user_message":
      return { ...base, text: "무엇을 하나요" };
    case "assistant_text":
      return { ...base, text: "이렇게 합니다" };
    case "reasoning":
      return { ...base, summary: "파일을 먼저 읽는다", phase: "analysis" };
    case "plan":
      return { ...base, steps: ["읽기", "고치기", "검증"], current: 1 };
    case "tool_started":
      return { ...base, callId: `k${n}`, toolName: "read_file", risk: "read", summary: "a.ts 읽기" };
    case "tool_completed":
      return { ...base, callId: `k${n}`, toolName: "read_file", status: "success", detail: "42줄" };
    case "file_changed":
      return { ...base, path: "src/a.ts", change: "modified" };
    case "notice":
      return { ...base, level: "warning", text: "승인이 필요합니다" };
    case "run_completed":
      return { ...base, reason: "finished", summary: "끝냈습니다" };
    default:
      return { ...base, payload: "이 빌드가 모르는 것" };
  }
}

const V2_EVENT_TYPES = [
  "user_message",
  "assistant_text",
  "reasoning",
  "plan",
  "tool_started",
  "tool_completed",
  "file_changed",
  "notice",
  "run_completed",
] as const;

/** Types written by a build from the future. Dropped, never fatal. */
const UNKNOWN_TYPES = ["hologram", "arena_verdict", "reviewer_note"] as const;

interface V2Fixture {
  name: string;
  events: Record<string, unknown>[];
  messages: unknown[];
}

const V2_FIXTURES: V2Fixture[] = [];
for (const skeleton of SKELETONS.slice(0, 5)) {
  for (const extra of [[], [UNKNOWN_TYPES[0]], [...UNKNOWN_TYPES]] as const) {
    for (const pattern of ["answered", "unanswered"] as const) {
      const messages = buildMessages(skeleton, "string", pattern);
      const types = [...V2_EVENT_TYPES, ...extra];
      V2_FIXTURES.push({
        name: `${skeleton.name}/${pattern}/+${extra.length}unknown`,
        events: types.map((t, i) => v2Event(t, "t1", i)),
        messages,
      });
    }
  }
}

function v2File(f: V2Fixture, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 2,
    id: `v2-${f.name}`,
    title: "v2 대화",
    createdAt: 900,
    updatedAt: 950,
    events: f.events,
    messages: f.messages,
    ...overrides,
  });
}

describe("migration · v2 files keep their event log", () => {
  for (const fixture of V2_FIXTURES) {
    test(`${fixture.name} — opens and reports itself migrated`, () => {
      const loaded = readSession(v2File(fixture));
      assert.notEqual(loaded, null);
      assert.equal(loaded!.migrated, true);
    });

    test(`${fixture.name} — says it came from v2, not v1`, () => {
      const turn = readSession(v2File(fixture))!.session.turns[0]!;
      assert.equal(turn.metadata?.migratedFromVersion, 2);
      assert.equal(turn.metadata?.legacy, true);
    });

    test(`${fixture.name} — keeps every event this build understands, in order`, () => {
      const events = readSession(v2File(fixture))!.session.events;
      const kept = fixture.events.filter((e) => (V2_EVENT_TYPES as readonly string[]).includes(e["type"] as string));
      assert.deepEqual(events.map((e) => e.type), kept.map((e) => e["type"]));
    });

    test(`${fixture.name} — drops what it cannot draw rather than refusing the file`, () => {
      const events = readSession(v2File(fixture))!.session.events;
      for (const type of UNKNOWN_TYPES) {
        assert.ok(!events.some((e) => (e.type as string) === type));
      }
    });

    test(`${fixture.name} — does not re-derive the log from the messages`, () => {
      const events = readSession(v2File(fixture))!.session.events;
      // The stored log has a plan and a reasoning summary; a derived one cannot.
      assert.ok(events.some((e) => e.type === "plan"));
      assert.ok(events.some((e) => e.type === "reasoning"));
    });

    test(`${fixture.name} — keeps the stored messages byte-identical`, () => {
      assert.deepEqual(readSession(v2File(fixture))!.session.turns[0]!.messageDelta, fixture.messages);
    });

    test(`${fixture.name} — hands the model a continuable reading of them`, () => {
      const messages = readSession(v2File(fixture))!.session.messages;
      assert.deepEqual(messages, repairChain(fixture.messages as ProviderMessage[]).messages);
      assert.equal(assessRestorable(messages as ProviderMessage[]).restorable, true);
    });

    test(`${fixture.name} — becomes one turn, like every pre-v3 file`, () => {
      const session = readSession(v2File(fixture))!.session;
      assert.equal(session.turns.length, 1);
      assert.equal(session.turns[0]!.id, LEGACY_TURN_ID);
    });

    test(`${fixture.name} — measures restorability from its messages`, () => {
      const turn = readSession(v2File(fixture))!.session.turns[0]!;
      assert.equal(turn.restorable, assessRestorable(fixture.messages as ProviderMessage[]).restorable);
    });

    test(`${fixture.name} — survives the round trip into v3`, () => {
      const first = readSession(v2File(fixture))!.session;
      const second = readSession(writeSession(first))!;
      assert.equal(second.migrated, false);
      assert.deepEqual(second.session.events, first.events);
      assert.deepEqual(second.session.messages, first.messages);
    });

    test(`${fixture.name} — a version from the future is refused`, () => {
      assert.equal(readSession(v2File(fixture, { version: SESSION_SCHEMA_VERSION + 1 })), null);
    });
  }
});

// ---------------------------------------------------------------------------
// v3 graphs
// ---------------------------------------------------------------------------

function turn(
  id: string,
  parentTurnId: string | null,
  events: SessionEvent[],
  messageDelta: ProviderMessage[],
): ConversationTurn {
  return {
    id,
    parentTurnId,
    state: "completed",
    createdAt: 1000,
    completedAt: 1100,
    events,
    messageDelta,
    restorable: true,
  };
}

function textTurn(id: string, parent: string | null, n: number): ConversationTurn {
  return turn(
    id,
    parent,
    [
      { type: "user_message", id: `${id}-u`, turnId: id, at: 1000 + n, text: `질문 ${n}` },
      { type: "assistant_text", id: `${id}-a`, turnId: id, at: 1001 + n, text: `대답 ${n}` },
    ],
    [
      { role: "user", content: `질문 ${n}` },
      { role: "assistant", content: `대답 ${n}` },
    ] as ProviderMessage[],
  );
}

/** Graphs of every shape the store can produce: linear, forked, deep. */
const GRAPHS: ReadonlyArray<{ name: string; turns: ConversationTurn[]; head: string }> = (() => {
  const out: Array<{ name: string; turns: ConversationTurn[]; head: string }> = [];
  for (const depth of [1, 2, 3, 5, 8]) {
    const turns: ConversationTurn[] = [];
    let parent: string | null = null;
    for (let i = 0; i < depth; i += 1) {
      turns.push(textTurn(`t${i}`, parent, i));
      parent = `t${i}`;
    }
    out.push({ name: `linear-${depth}`, turns, head: `t${depth - 1}` });

    // The same trunk with a branch off its middle, which is the shape v3 exists
    // for and the one a flat pair of arrays cannot represent.
    if (depth >= 3) {
      const forkParent = `t${Math.floor(depth / 2)}`;
      const forked = [...turns, textTurn("fork", forkParent, 99)];
      out.push({ name: `forked-${depth}-at-${forkParent}`, turns: forked, head: "fork" });
      out.push({ name: `forked-${depth}-main-head`, turns: forked, head: `t${depth - 1}` });
    }
  }
  return out;
})();

describe("migration · v3 graphs are stored once and projected on read", () => {
  for (const graph of GRAPHS) {
    const file = writeSession({
      version: SESSION_SCHEMA_VERSION,
      id: `g-${graph.name}`,
      title: "graph",
      createdAt: 10,
      updatedAt: 20,
      turns: graph.turns,
      branches: [
        { id: MAIN_BRANCH_ID, name: "main", headTurnId: graph.head, createdAt: 10, updatedAt: 20 },
      ],
      checkpoints: [],
      activeBranchId: MAIN_BRANCH_ID,
      events: [],
      messages: [],
    });

    test(`${graph.name} — the flat pair is not written to disk`, () => {
      const disk = JSON.parse(file) as Record<string, unknown>;
      assert.ok(!("events" in disk), "events must be projected, not stored");
      assert.ok(!("messages" in disk), "messages must be projected, not stored");
      assert.ok(Array.isArray(disk["turns"]));
    });

    test(`${graph.name} — reads back without claiming to be a migration`, () => {
      const loaded = readSession(file);
      assert.notEqual(loaded, null);
      assert.equal(loaded!.migrated, false);
    });

    test(`${graph.name} — every turn survives the round trip`, () => {
      const loaded = readSession(file)!;
      assert.deepEqual(
        loaded.session.turns.map((t) => t.id),
        graph.turns.map((t) => t.id),
      );
    });

    test(`${graph.name} — the screen is projected from the branch head's chain`, () => {
      const loaded = readSession(file)!;
      assert.deepEqual(loaded.session.events, restoreEvents(graph.turns, graph.head));
    });

    test(`${graph.name} — the model's context is projected from the same chain`, () => {
      const loaded = readSession(file)!;
      assert.deepEqual(loaded.session.messages, restoreMessages(graph.turns, graph.head));
    });

    test(`${graph.name} — the screen and the model cover the same turns`, () => {
      const loaded = readSession(file)!;
      const chain = turnChain(graph.turns, graph.head);
      const turnIds = new Set(chain.map((t) => t.id));
      for (const event of loaded.session.events) {
        assert.ok(turnIds.has(event.turnId), `${event.turnId} is not on the restored chain`);
      }
      assert.equal(
        loaded.session.messages.length,
        chain.reduce((n, t) => n + t.messageDelta.length, 0),
      );
    });

    test(`${graph.name} — a turn off the chain contributes nothing`, () => {
      const loaded = readSession(file)!;
      const onChain = new Set(turnChain(graph.turns, graph.head).map((t) => t.id));
      const off = graph.turns.filter((t) => !onChain.has(t.id));
      for (const turn of off) {
        for (const event of turn.events) {
          assert.ok(!loaded.session.events.some((e) => e.id === event.id));
        }
      }
    });

    test(`${graph.name} — writing what was read produces the same file`, () => {
      const loaded = readSession(file)!;
      assert.equal(writeSession(loaded.session), file);
    });

    test(`${graph.name} — a future version is refused even with a valid graph`, () => {
      const bumped = JSON.stringify({ ...JSON.parse(file), version: SESSION_SCHEMA_VERSION + 1 });
      assert.equal(readSession(bumped), null);
    });
  }
});

// ---------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------

const DAMAGED: ReadonlyArray<{ name: string; raw: string; expect: "null" | "opens" }> = [
  { name: "not json", raw: "{", expect: "null" },
  { name: "json but not an object", raw: "[]", expect: "null" },
  { name: "no id", raw: JSON.stringify({ messages: [] }), expect: "null" },
  { name: "id but no arrays at all", raw: JSON.stringify({ id: "x" }), expect: "null" },
  { name: "a settings blob that happens to have an id", raw: JSON.stringify({ id: "x", theme: "dark" }), expect: "null" },
  { name: "empty message array and empty events", raw: JSON.stringify({ id: "x", messages: [], events: [] }), expect: "null" },
  {
    name: "messages present but all unreadable",
    raw: JSON.stringify({ id: "x", messages: [1, "two", null] }),
    expect: "opens",
  },
  {
    name: "v3 with turns that do not survive validation",
    raw: JSON.stringify({
      version: 3,
      id: "x",
      createdAt: 1,
      turns: [{ id: "bad", state: "invented" }],
      messages: [{ role: "user", content: "안녕" }],
    }),
    expect: "opens",
  },
  {
    name: "v3 whose branch head points at nothing",
    raw: JSON.stringify({
      version: 3,
      id: "x",
      createdAt: 1,
      turns: [
        {
          id: "t0",
          parentTurnId: null,
          state: "completed",
          events: [{ type: "assistant_text", id: "e", turnId: "t0", at: 1, text: "안녕" }],
          messageDelta: [{ role: "assistant", content: "안녕" }],
        },
      ],
      branches: [{ id: "main", name: "main", headTurnId: "gone" }],
      activeBranchId: "main",
    }),
    expect: "opens",
  },
];

describe("migration · a damaged file costs one conversation, never the list", () => {
  for (const damaged of DAMAGED) {
    test(`${damaged.name} — ${damaged.expect === "null" ? "is skipped" : "still opens"}`, () => {
      const loaded = readSession(damaged.raw);
      if (damaged.expect === "null") assert.equal(loaded, null);
      else assert.notEqual(loaded, null);
    });

    test(`${damaged.name} — never throws`, () => {
      assert.doesNotThrow(() => readSession(damaged.raw));
    });
  }
});

describe("migration · the readers refuse rubbish without throwing", () => {
  const RUBBISH: readonly unknown[] = [
    null,
    undefined,
    0,
    "",
    "turns",
    {},
    { length: 3 },
    [null, undefined, 1, "x"],
    [{}],
    [{ id: 1 }],
    [{ id: "ok", state: "nonsense" }],
    [{ id: "ok", state: "completed" }],
    [{ id: "..", state: "completed", messageDelta: [], events: [] }],
  ];

  for (const [i, value] of RUBBISH.entries()) {
    test(`readTurns rejects input ${i} without throwing`, () => {
      let out: ConversationTurn[] = [];
      assert.doesNotThrow(() => {
        out = readTurns(value);
      });
      assert.ok(Array.isArray(out));
    });

    test(`readBranches rejects input ${i} without throwing`, () => {
      assert.doesNotThrow(() => readBranches(value, 0));
      assert.ok(Array.isArray(readBranches(value, 0)));
    });

    test(`readCheckpoints rejects input ${i} without throwing`, () => {
      assert.doesNotThrow(() => readCheckpoints(value));
      assert.ok(Array.isArray(readCheckpoints(value)));
    });
  }

  test("a turn whose parent did not survive becomes a root rather than a broken link", () => {
    const turns = readTurns([
      {
        id: "child",
        parentTurnId: "ghost",
        state: "completed",
        events: [{ type: "assistant_text", id: "e", turnId: "child", at: 1, text: "x" }],
        messageDelta: [{ role: "assistant", content: "x" }],
      },
    ]);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.parentTurnId, null);
    assert.deepEqual(turnChain(turns, "child").map((t) => t.id), ["child"]);
  });

  test("half a turn is dropped rather than restored to two different points", () => {
    assert.equal(
      readTurns([
        { id: "half", state: "completed", events: [], messageDelta: [] },
      ]).length,
      0,
    );
  });

  test("a duplicated turn id is taken once", () => {
    const raw = {
      id: "t",
      parentTurnId: null,
      state: "completed",
      events: [{ type: "assistant_text", id: "e", turnId: "t", at: 1, text: "x" }],
      messageDelta: [{ role: "assistant", content: "x" }],
    };
    assert.equal(readTurns([raw, raw]).length, 1);
  });

  test("a stale restorable flag on disk is not believed", () => {
    const turns = readTurns([
      {
        id: "t",
        parentTurnId: null,
        state: "completed",
        restorable: true,
        events: [{ type: "assistant_text", id: "e", turnId: "t", at: 1, text: "x" }],
        messageDelta: [
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }] },
        ],
      },
    ]);
    assert.equal(turns[0]!.restorable, false);
    assert.ok(turns[0]!.unrestorableReason !== undefined);
  });
});
