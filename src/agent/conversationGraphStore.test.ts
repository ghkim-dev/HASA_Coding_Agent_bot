import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ConversationStore, type ConversationStorePort } from "./conversationStore.ts";
import { LEGACY_TURN_ID, readSession, writeSession } from "./sessionLog.ts";
import { SESSION_SCHEMA_VERSION } from "./sessionEvents.ts";
import { MAIN_BRANCH_ID, restoreMessages, type ConversationTurn } from "./conversationGraph.ts";
import type { ProviderMessage } from "../provider/types.ts";
import type { SessionEvent } from "./sessionEvents.ts";

/**
 * The conversation file: what it keeps, what it refuses to lose, and what it
 * refuses to invent.
 *
 * Two things are proved here. First, that `createdAt` is the moment a
 * conversation began and stays that way — it did not, and every conversation in
 * the list claimed to be seconds old. Second, that files written by earlier
 * builds still open, and open as what they actually contained rather than as a
 * reconstruction of what they might have contained.
 */

/** A workspace id of the shape `workspaceIdentity` produces. */
const WS = "wsaaaaaaaaaaaaaaaa";
/** Never a real key. Searched for verbatim in everything that gets written. */
const FAKE_SECRET = "HASA_SECRET_MUST_NOT_APPEAR_123456";

function memory(): ConversationStorePort & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async listFiles(dir) {
      return [...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1));
    },
    async readFile(path) {
      const found = files.get(path);
      if (found === undefined) throw new Error(`ENOENT ${path}`);
      return found;
    },
    async writeFile(path, contents) {
      files.set(path, contents);
    },
    async remove(path) {
      files.delete(path);
    },
  };
}

function store(port: ConversationStorePort): ConversationStore {
  return new ConversationStore({ port, home: "/home", workspaceId: WS });
}

function exchange(n: string): ProviderMessage[] {
  return [
    { role: "user", content: `질문 ${n}` },
    { role: "assistant", content: `답 ${n}`, toolCalls: [] },
  ];
}

function turnAt(id: string, at: number, n = id): Omit<ConversationTurn, "parentTurnId"> {
  return {
    id,
    state: "completed",
    createdAt: at,
    completedAt: at + 10,
    events: [{ type: "assistant_text", id: `${id}-e`, turnId: id, at, text: `답 ${n}` } as SessionEvent],
    messageDelta: exchange(n),
    restorable: true,
  };
}

describe("T1 — createdAt is when the conversation began", () => {
  test("a later turn does not move it", () => {
    // The bug: `persist` passed `Date.now()` as `createdAt` on every save, so a
    // month-old conversation reported having started moments ago and the history
    // list could not be ordered by anything meaningful.
    const port = memory();
    const s = store(port);

    return (async () => {
      await s.appendTurn("c1", turnAt("t0", 1_000));
      await s.appendTurn("c1", turnAt("t1", 9_000));

      const loaded = await s.load("c1");
      assert.equal(loaded?.createdAt, 1_000);
      assert.equal(loaded?.updatedAt, 9_010);
    })();
  });

  test("there is no argument to appendTurn that can move it", async () => {
    // Not merely "the host passes the right value now" — the method takes no
    // `createdAt` at all, which is what stops the mistake being made twice.
    const port = memory();
    const s = store(port);
    await s.appendTurn("c1", turnAt("t0", 1_000));

    // A turn claiming to predate the conversation still does not rewrite it.
    await s.appendTurn("c1", turnAt("t1", 5), { title: "제목" });
    const loaded = await s.load("c1");
    assert.equal(loaded?.createdAt, 1_000);
    assert.equal(loaded?.title, "제목");
  });

  test("save() keeps the stored date even when handed a new one", async () => {
    // The old entry point stays for callers holding a whole conversation. It no
    // longer honours a `createdAt` for a conversation that already has one.
    const port = memory();
    const s = store(port);
    await s.save({ id: "c1", title: "t", createdAt: 1_000, updatedAt: 1_000, messages: exchange("1") });
    await s.save({ id: "c1", title: "t", createdAt: 9_999, updatedAt: 9_999, messages: exchange("2") });

    assert.equal((await s.load("c1"))?.createdAt, 1_000);
  });
});

describe("T2 — a conversation is created once", () => {
  test("creating over an existing one is refused", async () => {
    const port = memory();
    const s = store(port);
    await s.createConversation({ id: "c1", title: "첫", createdAt: 100, turn: turnAt("t0", 100) });
    await assert.rejects(
      () => s.createConversation({ id: "c1", title: "덮어쓰기", createdAt: 500, turn: turnAt("t9", 500) }),
      /already exists/,
    );
    assert.equal((await s.load("c1"))?.title, "첫");
  });

  test("appendTurn creates when there is nothing there", async () => {
    const port = memory();
    const s = store(port);
    await s.appendTurn("c1", turnAt("t0", 100), { title: "첫" });
    const loaded = await s.load("c1");
    assert.equal(loaded?.createdAt, 100);
    assert.equal(loaded?.turns?.length, 1);
    assert.equal(loaded?.turns?.[0]?.parentTurnId, null);
  });

  test("updateConversation cannot touch it either", async () => {
    const port = memory();
    const s = store(port);
    await s.appendTurn("c1", turnAt("t0", 100));
    await s.updateConversation("c1", { title: "새 제목", updatedAt: 777 });

    const loaded = await s.load("c1");
    assert.equal(loaded?.createdAt, 100);
    assert.equal(loaded?.title, "새 제목");
    assert.equal(loaded?.updatedAt, 777);
    assert.equal(loaded?.turns?.length, 1, "the graph survives a title change");
  });
});

describe("T3 — the parent is the branch head, not the caller's opinion", () => {
  test("turns chain in the order they were appended", async () => {
    const port = memory();
    const s = store(port);
    await s.appendTurn("c1", turnAt("t0", 100));
    await s.appendTurn("c1", turnAt("t1", 200));
    await s.appendTurn("c1", turnAt("t2", 300));

    const loaded = await s.load("c1");
    assert.deepEqual(loaded?.turns?.map((t) => [t.id, t.parentTurnId]), [
      ["t0", null],
      ["t1", "t0"],
      ["t2", "t1"],
    ]);
    assert.equal(loaded?.branches?.[0]?.headTurnId, "t2");
    assert.equal(loaded?.activeBranchId, MAIN_BRANCH_ID);
  });

  test("the projected messages are the chain, exactly", async () => {
    const port = memory();
    const s = store(port);
    await s.appendTurn("c1", turnAt("t0", 100, "1"));
    await s.appendTurn("c1", turnAt("t1", 200, "2"));

    const loaded = await s.load("c1");
    assert.deepEqual(loaded?.messages, [...exchange("1"), ...exchange("2")]);
    assert.deepEqual(loaded?.messages, restoreMessages(loaded!.turns!, "t1"));
  });

  test("writing the same turn twice leaves one turn and does not reparent it", async () => {
    // A retried save after an interrupted write. Appending blindly would make
    // the turn its own parent's sibling and duplicate the whole exchange.
    const port = memory();
    const s = store(port);
    await s.appendTurn("c1", turnAt("t0", 100));
    await s.appendTurn("c1", turnAt("t1", 200));
    await s.appendTurn("c1", turnAt("t1", 200));

    const loaded = await s.load("c1");
    assert.deepEqual(loaded?.turns?.map((t) => t.id), ["t0", "t1"]);
    assert.equal(loaded?.turns?.[1]?.parentTurnId, "t0");
  });
});

describe("M1/M2 — older conversations open as what they were", () => {
  const V1 = JSON.stringify({
    id: "old1",
    title: "옛 대화",
    createdAt: 500,
    updatedAt: 600,
    messages: [
      { role: "user", content: "안녕" },
      { role: "assistant", content: "반가워요", toolCalls: [] },
    ],
  });

  const V2 = JSON.stringify({
    version: 2,
    id: "old2",
    title: "v2 대화",
    createdAt: 500,
    updatedAt: 600,
    messages: [
      { role: "user", content: "계획 세워줘" },
      { role: "assistant", content: "했습니다", toolCalls: [] },
    ],
    events: [
      { type: "user_message", id: "e1", turnId: "t1", at: 500, text: "계획 세워줘" },
      { type: "plan", id: "e2", turnId: "t1", at: 501, steps: ["읽기", "쓰기"], current: 1 },
      { type: "run_completed", id: "e3", turnId: "t1", at: 502, reason: "finished", summary: "했습니다" },
    ],
  });

  test("M1 — a v1 file keeps its messages byte for byte", () => {
    const loaded = readSession(V1);
    assert.equal(loaded?.migrated, true);
    assert.deepEqual(loaded?.session.messages, JSON.parse(V1).messages);
    assert.equal(loaded?.session.createdAt, 500);
  });

  test("M2 — a v2 file keeps its events exactly, and invents none", () => {
    const loaded = readSession(V2);
    assert.deepEqual(loaded?.session.events, JSON.parse(V2).events);
    assert.deepEqual(loaded?.session.messages, JSON.parse(V2).messages);
  });

  test("M3 — it becomes one turn, because where it divided was never recorded", () => {
    // The conservative rule. A v2 file's messages carry no turn boundaries, so
    // splitting them would be a guess, and a branch taken at a guessed boundary
    // restores a context that never existed. One turn resumes correctly and
    // offers no interior fork point — which is the truth about the file.
    const loaded = readSession(V2);
    assert.equal(loaded?.session.turns.length, 1);
    const only = loaded!.session.turns[0]!;
    assert.equal(only.id, LEGACY_TURN_ID);
    assert.equal(only.parentTurnId, null);
    assert.equal(only.metadata?.["legacy"], true);
    assert.equal(only.metadata?.["migratedFromVersion"], 2);

    // Both halves are present, which is what makes it a valid turn at all.
    assert.ok(only.events.length > 0);
    assert.ok(only.messageDelta.length > 0);
    assert.equal(loaded?.session.branches[0]?.headTurnId, LEGACY_TURN_ID);
  });

  test("M4 — a migrated conversation can be continued, and the next turn chains onto it", async () => {
    const port = memory();
    port.files.set(`${store(port).directory}/old2.json`, V2);
    const s = store(port);

    await s.appendTurn("old2", turnAt("new0", 900, "새"));
    const loaded = await s.load("old2");

    assert.equal(loaded?.createdAt, 500, "migration does not restart the clock either");
    assert.deepEqual(loaded?.turns?.map((t) => [t.id, t.parentTurnId]), [
      [LEGACY_TURN_ID, null],
      ["new0", LEGACY_TURN_ID],
    ]);
    // The model's history is the old conversation plus the new turn, in order.
    assert.deepEqual(loaded?.messages, [...JSON.parse(V2).messages, ...exchange("새")]);
  });

  test("M5 — a file from a future build is refused, not half-read", () => {
    const future = JSON.stringify({ ...JSON.parse(V2), version: SESSION_SCHEMA_VERSION + 1 });
    assert.equal(readSession(future), null);
  });

  test("a v1 conversation cut off mid-tool-call is marked, not offered as a fork point", () => {
    const cutOff = JSON.stringify({
      id: "cut",
      title: "중단",
      createdAt: 1,
      updatedAt: 1,
      messages: [
        { role: "user", content: "실행해줘" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "x", name: "run_command", arguments: {}, rawArguments: "{}", argumentsValid: true }],
        },
      ],
    });
    const loaded = readSession(cutOff);
    assert.equal(loaded?.session.turns[0]?.restorable, false);
    assert.match(String(loaded?.session.turns[0]?.unrestorableReason), /run_command/);
  });
});

describe("the file holds the graph, and only the graph", () => {
  test("a round trip through disk preserves both halves", async () => {
    const port = memory();
    const s = store(port);
    await s.appendTurn("c1", turnAt("t0", 100, "1"));
    await s.appendTurn("c1", turnAt("t1", 200, "2"));

    const raw = port.files.get(`${s.directory}/c1.json`)!;
    const loaded = readSession(raw)!;
    assert.equal(loaded.migrated, false);
    assert.deepEqual(loaded.session.messages, [...exchange("1"), ...exchange("2")]);
    assert.deepEqual(loaded.session.events.map((e) => e.turnId), ["t0", "t1"]);
  });

  test("the flat arrays are not stored beside the turns", () => {
    // Two copies of the same conversation is somewhere for them to disagree.
    // The flat pair is computed on read; only the graph is written.
    const raw = writeSession({
      version: SESSION_SCHEMA_VERSION,
      id: "c1",
      title: "t",
      createdAt: 1,
      updatedAt: 1,
      events: [],
      messages: exchange("1"),
    });
    const parsed = JSON.parse(raw);
    assert.equal(parsed.events, undefined);
    assert.equal(parsed.messages, undefined);
    assert.equal(parsed.turns.length, 1);
    // …and it still reads back as the conversation it was.
    assert.deepEqual(readSession(raw)?.session.messages, exchange("1"));
  });

  test("half a turn is dropped rather than repaired", () => {
    // A turn with events and no delta would restore the screen to one point and
    // the model to another — the exact failure the graph exists to prevent.
    const raw = JSON.stringify({
      version: SESSION_SCHEMA_VERSION,
      id: "c1",
      title: "t",
      createdAt: 1,
      updatedAt: 1,
      activeBranchId: MAIN_BRANCH_ID,
      branches: [{ id: MAIN_BRANCH_ID, name: "main", headTurnId: "good", createdAt: 1, updatedAt: 1 }],
      turns: [
        { id: "half", parentTurnId: null, state: "completed", createdAt: 1, completedAt: 1, events: [] },
        {
          id: "good",
          parentTurnId: null,
          state: "completed",
          createdAt: 1,
          completedAt: 1,
          events: [],
          messageDelta: exchange("1"),
        },
      ],
    });
    const loaded = readSession(raw);
    assert.deepEqual(loaded?.session.turns.map((t) => t.id), ["good"]);
  });

  test("a stored restorable flag is recomputed rather than believed", () => {
    // Otherwise an edited or stale file could offer a broken chain as a fork
    // point and the refusal would arrive from the gateway instead.
    const raw = JSON.stringify({
      version: SESSION_SCHEMA_VERSION,
      id: "c1",
      title: "t",
      createdAt: 1,
      updatedAt: 1,
      activeBranchId: MAIN_BRANCH_ID,
      branches: [{ id: MAIN_BRANCH_ID, name: "main", headTurnId: "t0", createdAt: 1, updatedAt: 1 }],
      turns: [
        {
          id: "t0",
          parentTurnId: null,
          state: "completed",
          createdAt: 1,
          completedAt: 1,
          events: [],
          restorable: true,
          messageDelta: [
            {
              role: "assistant",
              content: null,
              toolCalls: [{ id: "x", name: "run_command", arguments: {}, rawArguments: "{}", argumentsValid: true }],
            },
          ],
        },
      ],
    });
    assert.equal(readSession(raw)?.session.turns[0]?.restorable, false);
  });
});

describe("the key never reaches the file", () => {
  test("no part of a written conversation contains it", async () => {
    const port = memory();
    const s = new ConversationStore({ port, home: "/home", workspaceId: "wsbbbbbbbbbbbbbbbb" });

    await s.appendTurn("c1", {
      ...turnAt("t0", 100),
      metadata: { primaryModelId: "some-model" },
    });
    await s.updateConversation("c1", {
      checkpoints: [
        {
          id: "cp1",
          turnId: "t0",
          branchId: MAIN_BRANCH_ID,
          message: "저장 지점",
          createdAt: 100,
          metadata: { gitBranch: "main", mode: "code", modelId: "some-model" },
        },
      ],
    });

    for (const [path, contents] of port.files) {
      assert.ok(!path.includes(FAKE_SECRET), `key in a path: ${path}`);
      assert.ok(!contents.includes(FAKE_SECRET), `key in ${path}`);
    }
    // The directory is a digest of the key, which is not reversible into it.
    assert.ok(!s.directory.includes(FAKE_SECRET));
  });
});
