import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ConversationStore, type ConversationStorePort } from "./conversationStore.ts";
import { MAIN_BRANCH_ID, restoreEvents, restoreMessages, type ConversationTurn } from "./conversationGraph.ts";
import type { ProviderMessage } from "../provider/types.ts";
import type { SessionEvent } from "./sessionEvents.ts";

/**
 * Branches and checkpoints, through the file.
 *
 * `conversationBranch.test.ts` proves the operations. This proves they survive
 * being written down and read back, and that two of them running at once do not
 * eat each other — which they did, because every write here is a
 * read-modify-write over one whole file.
 */

/**
 * A filesystem that takes time, on both ends.
 *
 * The delay on `writeFile` matters as much as the one on `readFile`, and
 * leaving it out is how this test first came out green against a store with no
 * serialisation at all: an instant write completes in the same microtask as the
 * read that preceded it, so the operations serialise themselves by accident and
 * the race never happens. With both slowed, eight concurrent turns lose seven.
 */
function memory(delayMs = 0): ConversationStorePort & { files: Map<string, string>; writes: number } {
  const wait = (): Promise<void> =>
    delayMs > 0 ? new Promise((r) => setTimeout(r, delayMs)) : Promise.resolve();
  const files = new Map<string, string>();
  const port = {
    files,
    writes: 0,
    async listFiles(dir: string) {
      return [...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1));
    },
    async readFile(path: string) {
      await wait();
      const found = files.get(path);
      if (found === undefined) throw new Error(`ENOENT ${path}`);
      return found;
    },
    async writeFile(path: string, contents: string) {
      await wait();
      port.writes += 1;
      files.set(path, contents);
    },
    async remove(path: string) {
      files.delete(path);
    },
  };
  return port;
}

function store(port: ConversationStorePort): ConversationStore {
  return new ConversationStore({ port, home: "/home", apiKey: "k" });
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

/** Three turns on main. */
async function threeTurns(s: ConversationStore): Promise<void> {
  await s.appendTurn("c1", turnAt("t0", 100, "1"));
  await s.appendTurn("c1", turnAt("t1", 200, "2"));
  await s.appendTurn("c1", turnAt("t2", 300, "3"));
}

describe("a branch survives the round trip", () => {
  test("forking from the middle, then reading it back", async () => {
    const s = store(memory());
    await threeTurns(s);

    const forked = await s.createBranch("c1", { branchId: "alt", name: "다른 방향", fromTurnId: "t0", at: 400 });
    assert.equal(forked.ok, true);

    const loaded = await s.load("c1");
    assert.deepEqual(loaded?.branches?.map((b) => [b.id, b.headTurnId]), [
      [MAIN_BRANCH_ID, "t2"],
      ["alt", "t0"],
    ]);
    assert.equal(loaded?.activeBranchId, "alt", "creating a branch moves onto it");

    // The projected halves follow the active branch, together.
    assert.deepEqual(loaded?.messages, exchange("1"));
    assert.deepEqual(loaded?.events?.map((e) => e.turnId), ["t0"]);
  });

  test("a turn appended after forking extends the fork, not main", async () => {
    const s = store(memory());
    await threeTurns(s);
    await s.createBranch("c1", { branchId: "alt", name: "다른 방향", fromTurnId: "t0", at: 400 });
    await s.appendTurn("c1", turnAt("t3", 500, "새"));

    const loaded = await s.load("c1");
    assert.equal(loaded?.turns?.find((t) => t.id === "t3")?.parentTurnId, "t0");
    assert.equal(loaded?.branches?.find((b) => b.id === "alt")?.headTurnId, "t3");
    assert.equal(loaded?.branches?.find((b) => b.id === MAIN_BRANCH_ID)?.headTurnId, "t2", "main did not move");

    // And the abandoned line is in neither half of what the user now sees.
    assert.deepEqual(loaded?.messages, [...exchange("1"), ...exchange("새")]);
    assert.ok(!JSON.stringify(loaded?.events).includes("답 2"));
  });

  test("switching back shows the other line, on both paths", async () => {
    const s = store(memory());
    await threeTurns(s);
    await s.createBranch("c1", { branchId: "alt", name: "다른 방향", fromTurnId: "t0", at: 400 });
    await s.appendTurn("c1", turnAt("t3", 500, "새"));

    assert.equal(await s.switchBranch("c1", MAIN_BRANCH_ID, 600), true);
    const loaded = await s.load("c1");

    assert.deepEqual(loaded?.messages, [...exchange("1"), ...exchange("2"), ...exchange("3")]);
    assert.deepEqual(loaded?.events?.map((e) => e.turnId), ["t0", "t1", "t2"]);
    // Both halves came from one traversal of one chain.
    assert.deepEqual(loaded?.messages, restoreMessages(loaded!.turns!, "t2"));
    assert.deepEqual(loaded?.events, restoreEvents(loaded!.turns!, "t2"));
  });

  test("switching to a branch that is not there is refused", async () => {
    const s = store(memory());
    await threeTurns(s);
    assert.equal(await s.switchBranch("c1", "nope", 400), false);
    assert.equal((await s.load("c1"))?.activeBranchId, MAIN_BRANCH_ID);
  });

  test("deleting a branch keeps its turns and moves off it", async () => {
    const s = store(memory());
    await threeTurns(s);
    await s.createBranch("c1", { branchId: "alt", name: "다른 방향", fromTurnId: "t0", at: 400 });
    await s.appendTurn("c1", turnAt("t3", 500, "새"));

    assert.deepEqual(await s.deleteBranch("c1", "alt", 600), { ok: true });
    const loaded = await s.load("c1");

    assert.equal(loaded?.activeBranchId, MAIN_BRANCH_ID, "standing on a removed branch is not a place to be");
    assert.ok(loaded?.turns?.some((t) => t.id === "t3"), "the work is still there");
    assert.deepEqual(loaded?.messages, [...exchange("1"), ...exchange("2"), ...exchange("3")]);
  });

  test("main cannot be deleted", async () => {
    const s = store(memory());
    await threeTurns(s);
    const result = await s.deleteBranch("c1", MAIN_BRANCH_ID, 400);
    assert.equal(result.ok, false);
    assert.equal((await s.load("c1"))?.branches?.length, 1);
  });
});

describe("checkpoints survive the round trip", () => {
  test("added, read back, and removed", async () => {
    const s = store(memory());
    await threeTurns(s);

    const added = await s.addCheckpoint("c1", {
      checkpointId: "cp1",
      turnId: "t1",
      branchId: MAIN_BRANCH_ID,
      message: "여기까지 잘 됨",
      at: 400,
      metadata: { gitHead: "abc1234", changedFiles: ["src/a.ts"] },
    });
    assert.equal(added.ok, true);

    const loaded = await s.load("c1");
    assert.deepEqual(loaded?.checkpoints?.map((c) => [c.id, c.turnId, c.message]), [
      ["cp1", "t1", "여기까지 잘 됨"],
    ]);
    assert.equal(loaded?.checkpoints?.[0]?.metadata?.gitHead, "abc1234");

    assert.equal(await s.deleteCheckpoint("c1", "cp1", 500), true);
    assert.deepEqual((await s.load("c1"))?.checkpoints, []);
  });

  test("a duplicate id is refused", async () => {
    const s = store(memory());
    await threeTurns(s);
    const input = {
      checkpointId: "cp1",
      turnId: "t1",
      branchId: MAIN_BRANCH_ID,
      message: "저장",
      at: 400,
    };
    assert.equal((await s.addCheckpoint("c1", input)).ok, true);
    assert.equal((await s.addCheckpoint("c1", input)).ok, false);
    assert.equal((await s.load("c1"))?.checkpoints?.length, 1);
  });

  test("restoring one moves the conversation and reports no file work", async () => {
    // The subtraction the whole feature is shaped by. What comes back is a
    // conversation. There is no path, command or revision in it to act on.
    const s = store(memory());
    await threeTurns(s);
    await s.addCheckpoint("c1", {
      checkpointId: "cp1",
      turnId: "t1",
      branchId: MAIN_BRANCH_ID,
      message: "저장",
      at: 400,
      metadata: { gitHead: "abc1234", changedFiles: ["src/a.ts"] },
    });

    const loaded = await s.load("c1");
    const cp = loaded!.checkpoints![0]!;
    assert.deepEqual(restoreMessages(loaded!.turns!, cp.turnId), [...exchange("1"), ...exchange("2")]);

    // The workspace note is data, and nothing in the store consumes it.
    assert.equal(cp.metadata?.gitHead, "abc1234");
  });
});

describe("two writers do not eat each other", () => {
  test("a turn and a branch landing together keep both", async () => {
    // Without serialising, both read the same conversation, both write a whole
    // file, and whichever finishes second erases the other. The delay makes
    // that overlap certain rather than occasional.
    const s = store(memory(5));
    await threeTurns(s);

    await Promise.all([
      s.appendTurn("c1", turnAt("t3", 400, "새")),
      s.createBranch("c1", { branchId: "alt", name: "다른 방향", fromTurnId: "t0", at: 400 }),
      s.addCheckpoint("c1", {
        checkpointId: "cp1",
        turnId: "t1",
        branchId: MAIN_BRANCH_ID,
        message: "저장",
        at: 400,
      }),
    ]);

    const loaded = await s.load("c1");
    assert.ok(loaded?.turns?.some((t) => t.id === "t3"), "the turn was lost");
    assert.ok(loaded?.branches?.some((b) => b.id === "alt"), "the branch was lost");
    assert.equal(loaded?.checkpoints?.length, 1, "the checkpoint was lost");
  });

  test("many turns at once all land, in order, each parented to the last", async () => {
    const s = store(memory(2));
    await s.appendTurn("c1", turnAt("t0", 100, "1"));

    await Promise.all(
      Array.from({ length: 8 }, (_, i) => s.appendTurn("c1", turnAt(`t${i + 1}`, 200 + i, `${i + 1}`))),
    );

    const loaded = await s.load("c1");
    assert.equal(loaded?.turns?.length, 9, "every turn must be there");

    // A single chain, not a fan of siblings: each parent is the turn written
    // before it, whatever order they were requested in.
    const byId = new Map(loaded!.turns!.map((t) => [t.id, t]));
    let seen = 0;
    let cursor = loaded!.branches![0]!.headTurnId;
    while (cursor !== null) {
      seen += 1;
      cursor = byId.get(cursor)?.parentTurnId ?? null;
    }
    assert.equal(seen, 9, "the chain from the head must reach every turn");
  });

  test("a failed write does not wedge the ones behind it", async () => {
    const port = memory();
    const s = store(port);
    await threeTurns(s);

    // `createConversation` on an existing id throws. Anything queued after it
    // must still run.
    const failing = s.createConversation({ id: "c1", title: "x", createdAt: 0, turn: turnAt("dup", 0) });
    const after = s.appendTurn("c1", turnAt("t3", 400, "새"));

    await assert.rejects(() => failing);
    await after;
    assert.ok((await s.load("c1"))?.turns?.some((t) => t.id === "t3"));
  });
});
