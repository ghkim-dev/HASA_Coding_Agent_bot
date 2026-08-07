import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MAIN_BRANCH_ID,
  canBranchFrom,
  createCheckpoint,
  danglingCheckpoints,
  forkBranch,
  newBranch,
  orphanedTurns,
  removeBranch,
  restoreEvents,
  restoreMessages,
  type ConversationBranch,
  type ConversationTurn,
} from "./conversationGraph.ts";
import type { ProviderMessage } from "../provider/types.ts";
import type { SessionEvent } from "./sessionEvents.ts";

/**
 * Branches and checkpoints, as operations on the graph.
 *
 * The rule these are all shaped by is a subtraction: **a conversation branch
 * does not touch the working tree.** The word arrives from git carrying the
 * expectation that switching moves your files, and that expectation must not
 * come with it. Moving between two lines of a conversation changes what the
 * model has read. Nothing else.
 */

function say(turnId: string, text: string): SessionEvent {
  return { type: "assistant_text", id: `${turnId}-e`, turnId, at: 0, text };
}

function exchange(n: string): ProviderMessage[] {
  return [
    { role: "user", content: `질문 ${n}` },
    { role: "assistant", content: `답 ${n}`, toolCalls: [] },
  ];
}

function turn(id: string, parentTurnId: string | null, n = id): ConversationTurn {
  return {
    id,
    parentTurnId,
    state: "completed",
    createdAt: 0,
    completedAt: 1,
    events: [say(id, `답 ${n}`)],
    messageDelta: exchange(n),
    restorable: true,
  };
}

const T1 = turn("t1", null, "1");
const T2 = turn("t2", "t1", "2");
const T3 = turn("t3", "t2", "3");
const LINE = [T1, T2, T3];
const MAIN = newBranch(MAIN_BRANCH_ID, "main", "t3", 0);

describe("forking", () => {
  test("a branch may start from the middle of another", () => {
    // The point of the feature. Anything else is just renaming the tip.
    const result = forkBranch(LINE, [MAIN], { id: "alt", name: "다른 방향", fromTurnId: "t1", at: 100 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.branch.headTurnId, "t1");
    assert.equal(result.branch.name, "다른 방향");
    assert.equal(result.branch.createdAt, 100);
  });

  test("the fork restores its own chain, on both paths", () => {
    const t2b = turn("t2b", "t1", "2b");
    const forked = [...LINE, t2b];

    assert.deepEqual(restoreMessages(forked, "t2b"), [...exchange("1"), ...exchange("2b")]);
    assert.deepEqual(restoreEvents(forked, "t2b").map((e) => e.turnId), ["t1", "t2b"]);
    // The abandoned line is not in either half.
    assert.ok(!JSON.stringify(restoreMessages(forked, "t2b")).includes("질문 2\""));
  });

  test("a turn that is not there is refused", () => {
    const result = forkBranch(LINE, [MAIN], { id: "alt", name: "x", fromTurnId: "gone", at: 0 });
    assert.equal(result.ok, false);
  });

  test("names that are paths are refused", () => {
    for (const name of ["../escape", "a/b", "..", "C:\\temp"]) {
      const result = forkBranch(LINE, [MAIN], { id: "alt", name, fromTurnId: "t1", at: 0 });
      assert.equal(result.ok, false, name);
    }
  });

  test("a duplicate id or name is refused", () => {
    const withAlt = [MAIN, newBranch("alt", "다른 방향", "t1", 0)];
    assert.equal(forkBranch(LINE, withAlt, { id: "alt", name: "새 이름", fromTurnId: "t1", at: 0 }).ok, false);
    assert.equal(forkBranch(LINE, withAlt, { id: "alt2", name: "다른 방향", fromTurnId: "t1", at: 0 }).ok, false);
    // …and the same name with different spacing is the same name.
    assert.equal(forkBranch(LINE, withAlt, { id: "alt3", name: "  다른 방향  ", fromTurnId: "t1", at: 0 }).ok, false);
  });

  test("forking from an interrupted point is allowed, with the repair named", () => {
    const cut: ConversationTurn = {
      ...turn("cut", "t1"),
      messageDelta: [
        { role: "user", content: "실행해줘" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "x", name: "run_command", arguments: {}, rawArguments: "{}", argumentsValid: true }],
        },
      ],
      restorable: false,
    };
    const graph = [T1, cut];
    const result = forkBranch(graph, [MAIN], { id: "alt", name: "재시도", fromTurnId: "cut", at: 0 });
    assert.equal(result.ok, true);

    const verdict = canBranchFrom(graph, "cut");
    assert.deepEqual(verdict.ok === true ? verdict.repairs : null, [{ callId: "x", toolName: "run_command" }]);
  });
});

describe("removing a branch", () => {
  test("main is not removable", () => {
    // A conversation with no branch has turns nothing points at, which is a
    // conversation that exists and cannot be opened.
    assert.equal(removeBranch([MAIN], MAIN_BRANCH_ID).ok, false);
  });

  test("another branch is", () => {
    const alt = newBranch("alt", "다른 방향", "t1", 0);
    const result = removeBranch([MAIN, alt], "alt");
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok === true ? result.branches.map((b) => b.id) : null, [MAIN_BRANCH_ID]);
  });

  test("its turns are reported as orphaned rather than deleted", () => {
    // They are still things that happened, and this graph is tens of turns, not
    // millions. Losing the record to reclaim nothing is a bad trade.
    const t2b = turn("t2b", "t1", "2b");
    const graph = [...LINE, t2b];
    assert.deepEqual(orphanedTurns(graph, [MAIN]), ["t2b"]);
    assert.deepEqual(orphanedTurns(graph, [MAIN, newBranch("alt", "alt", "t2b", 0)]), []);
  });
});

describe("checkpoints", () => {
  const at = 500;

  test("a checkpoint is a bookmark on a turn", () => {
    const result = createCheckpoint(LINE, {
      id: "cp1",
      turnId: "t2",
      branchId: MAIN_BRANCH_ID,
      message: "여기까지 잘 됨",
      at,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.checkpoint.turnId, "t2");
    assert.equal(result.checkpoint.message, "여기까지 잘 됨");
    assert.equal(result.checkpoint.createdAt, at);
  });

  test("it may note what the workspace looked like, as a note", () => {
    // Useful to see later. Never a handle on the files — see the restore test
    // below, which is the one that matters.
    const result = createCheckpoint(LINE, {
      id: "cp1",
      turnId: "t2",
      branchId: MAIN_BRANCH_ID,
      message: "저장",
      at,
      metadata: { gitHead: "abc1234", gitBranch: "main", changedFiles: ["src/a.ts"], mode: "code" },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.checkpoint.metadata?.gitHead, "abc1234");
    assert.deepEqual(result.checkpoint.metadata?.changedFiles, ["src/a.ts"]);
  });

  test("restoring one yields a conversation and nothing else", () => {
    // The subtraction, stated as a test. A checkpoint restore produces messages
    // and events. There is no file operation available to it — the graph module
    // imports no filesystem, runs no command, and returns no instruction to.
    const cp = createCheckpoint(LINE, {
      id: "cp1",
      turnId: "t2",
      branchId: MAIN_BRANCH_ID,
      message: "저장",
      at,
      metadata: { gitHead: "abc1234", changedFiles: ["src/a.ts"] },
    });
    assert.equal(cp.ok, true);
    if (!cp.ok) return;

    const messages = restoreMessages(LINE, cp.checkpoint.turnId);
    const events = restoreEvents(LINE, cp.checkpoint.turnId);
    assert.deepEqual(messages, [...exchange("1"), ...exchange("2")]);
    assert.deepEqual([...new Set(events.map((e) => e.turnId))], ["t1", "t2"]);

    // The recorded git head is data the user can read, not something acted on.
    assert.equal(typeof cp.checkpoint.metadata?.gitHead, "string");
  });

  test("a nameless checkpoint is refused", () => {
    for (const message of ["", "   "]) {
      assert.equal(
        createCheckpoint(LINE, { id: "cp1", turnId: "t2", branchId: MAIN_BRANCH_ID, message, at }).ok,
        false,
        JSON.stringify(message),
      );
    }
  });

  test("a checkpoint on a turn that is not there is refused", () => {
    assert.equal(
      createCheckpoint(LINE, { id: "cp1", turnId: "gone", branchId: MAIN_BRANCH_ID, message: "x", at }).ok,
      false,
    );
  });

  test("one whose turn later disappears is reported, not followed", () => {
    const cp = createCheckpoint(LINE, {
      id: "cp1",
      turnId: "t3",
      branchId: MAIN_BRANCH_ID,
      message: "저장",
      at,
    });
    assert.equal(cp.ok, true);
    if (!cp.ok) return;
    assert.deepEqual(danglingCheckpoints([T1, T2], [cp.checkpoint]), ["cp1"]);
    assert.deepEqual(danglingCheckpoints(LINE, [cp.checkpoint]), []);
  });
});

describe("the graph module cannot touch the working tree", () => {
  test("it imports nothing that could", async () => {
    // Asserted rather than intended. A future edit that reaches for `node:fs`
    // or a git helper to "restore the files too" fails here, which is where the
    // reason is written down.
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./conversationGraph.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);

    assert.deepEqual(imports, ["../provider/types.ts", "./sessionEvents.ts"]);
    for (const forbidden of ["node:fs", "node:child_process", "./git", "node:os"]) {
      assert.ok(!source.includes(forbidden), `conversationGraph must not reach for ${forbidden}`);
    }
  });

  test("no branch or checkpoint operation returns a file instruction", () => {
    // Every result is a conversation object. Nothing carries a path to write,
    // a command to run, or a revision to check out.
    const fork = forkBranch(LINE, [MAIN], { id: "alt", name: "x", fromTurnId: "t1", at: 0 });
    const cp = createCheckpoint(LINE, {
      id: "cp1",
      turnId: "t1",
      branchId: MAIN_BRANCH_ID,
      message: "x",
      at: 0,
      metadata: { gitHead: "abc" },
    });
    assert.equal(fork.ok, true);
    assert.equal(cp.ok, true);
    if (!fork.ok || !cp.ok) return;

    assert.deepEqual(Object.keys(fork.branch).sort(), ["createdAt", "headTurnId", "id", "name", "updatedAt"]);
    // The checkpoint's only workspace-shaped field is `metadata`, and it is a
    // record of what was, not an instruction about what should be.
    const keys = Object.keys(cp.checkpoint).sort();
    assert.deepEqual(keys, ["branchId", "createdAt", "id", "message", "metadata", "turnId"]);
  });
});

/** Kept honest: the branch type has no field a file operation could hide in. */
const _shape: ConversationBranch = MAIN;
void _shape;
