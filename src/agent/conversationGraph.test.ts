import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  GraphError,
  INTERRUPTED_TOOL_RESULT,
  MAIN_BRANCH_ID,
  assessRestorable,
  canBranchFrom,
  isUsableHead,
  isValidBranchName,
  isValidGraphId,
  newBranch,
  reachableTurns,
  restoreEvents,
  restoreMessages,
  turnChain,
  turnStateFor,
  type ConversationTurn,
} from "./conversationGraph.ts";
import type { ProviderMessage } from "../provider/types.ts";
import type { RunTerminationReason, SessionEvent } from "./sessionEvents.ts";

/**
 * The graph, on its own.
 *
 * `turnBoundary.test.ts` proves the boundary is observed correctly from a real
 * session. This file proves that what is done with the result is correct — that
 * a chain restores what it should, that a broken one is refused rather than
 * half-restored, and above all that the screen and the model's context can only
 * move together.
 */

function say(turnId: string, text: string): SessionEvent {
  return { type: "assistant_text", id: `${turnId}-e`, turnId, at: 0, text };
}

function turn(
  id: string,
  parentTurnId: string | null,
  delta: ProviderMessage[],
  overrides: Partial<ConversationTurn> = {},
): ConversationTurn {
  const verdict = assessRestorable(delta);
  return {
    id,
    parentTurnId,
    state: "completed",
    createdAt: 0,
    completedAt: 1,
    events: [say(id, `answer for ${id}`)],
    messageDelta: delta,
    restorable: verdict.restorable,
    ...(verdict.reason === undefined ? {} : { unrestorableReason: verdict.reason }),
    ...overrides,
  };
}

/** One ordinary exchange. */
function exchange(n: string): ProviderMessage[] {
  return [
    { role: "user", content: `질문 ${n}` },
    { role: "assistant", content: `답 ${n}`, toolCalls: [] },
  ];
}

const T1 = turn("t1", null, exchange("1"));
const T2 = turn("t2", "t1", exchange("2"));
const T3 = turn("t3", "t2", exchange("3"));
const LINE = [T1, T2, T3];

describe("G1 — a chain restores the history that turn ended with", () => {
  test("the deltas concatenate in order", () => {
    assert.deepEqual(restoreMessages(LINE, "t3"), [...exchange("1"), ...exchange("2"), ...exchange("3")]);
  });

  test("a turn in the middle restores only what came before it", () => {
    assert.deepEqual(restoreMessages(LINE, "t2"), [...exchange("1"), ...exchange("2")]);
  });

  test("chains are root-first regardless of array order", () => {
    // The array is not the order. A branch appended later sits after its own
    // parent in the file but before it in no chain.
    const shuffled = [T3, T1, T2];
    assert.deepEqual(turnChain(shuffled, "t3").map((t) => t.id), ["t1", "t2", "t3"]);
  });
});

describe("G10 — the screen and the model move together", () => {
  test("restoring to a turn takes both halves to the same point", () => {
    // The invariant the whole phase exists for. A restore that put the events at
    // T2 and the messages at T3 would look like a working branch and would send
    // the model a conversation the user cannot see.
    const events = restoreEvents(LINE, "t2");
    const messages = restoreMessages(LINE, "t2");

    const turnsShown = new Set(events.map((e) => e.turnId));
    assert.deepEqual([...turnsShown], ["t1", "t2"]);
    assert.deepEqual(messages, [...exchange("1"), ...exchange("2")]);

    // Stated as the equality it is, so a future change that moves one path and
    // not the other fails here rather than in a user's conversation.
    const chain = turnChain(LINE, "t2").map((t) => t.id);
    assert.deepEqual([...turnsShown], chain);
    assert.deepEqual(messages, chain.flatMap((id) => LINE.find((t) => t.id === id)!.messageDelta));
  });

  test("a fork restores the fork's chain, not the abandoned one", () => {
    // t2b branches from t1. Restoring it must not carry t2's exchange, on
    // either path.
    const t2b = turn("t2b", "t1", exchange("2b"));
    const forked = [...LINE, t2b];

    assert.deepEqual(restoreMessages(forked, "t2b"), [...exchange("1"), ...exchange("2b")]);
    assert.deepEqual(
      restoreEvents(forked, "t2b").map((e) => e.turnId),
      ["t1", "t2b"],
    );
    assert.ok(!JSON.stringify(restoreMessages(forked, "t2b")).includes("질문 2\""));
  });
});

describe("G3/G4 — a damaged graph is refused, not half-restored", () => {
  test("a cycle is reported rather than looped over", () => {
    const a = turn("a", "b", exchange("a"));
    const b = turn("b", "a", exchange("b"));
    assert.throws(() => turnChain([a, b], "a"), (err: unknown) => {
      assert.ok(err instanceof GraphError);
      assert.equal(err.reason, "cycle");
      return true;
    });
  });

  test("a missing ancestor is named", () => {
    const orphan = turn("t9", "gone", exchange("9"));
    assert.throws(() => turnChain([orphan], "t9"), (err: unknown) => {
      assert.ok(err instanceof GraphError);
      assert.equal(err.reason, "unknown_turn");
      return true;
    });
  });
});

describe("G5 — an incomplete history is repaired to continue, never silently", () => {
  const dangling: ProviderMessage[] = [
    { role: "user", content: "실행해줘" },
    {
      role: "assistant",
      content: null,
      toolCalls: [{ id: "x", name: "run_command", arguments: {}, rawArguments: "{}", argumentsValid: true }],
    },
  ];

  test("the turn is still marked as what it is", () => {
    // The fact is about the stored messages and does not change. What changed
    // is what is done about it.
    const broken = turn("b1", null, dangling);
    assert.equal(broken.restorable, false);
    assert.match(String(broken.unrestorableReason), /run_command/);
  });

  test("continuing from it is allowed, and the repair is reported", () => {
    const broken = turn("b1", null, dangling);
    const verdict = canBranchFrom([broken], "b1");
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.ok === true ? verdict.repairs : [], [{ callId: "x", toolName: "run_command" }]);
  });

  test("the restored history is one the gateway will accept", () => {
    const broken = turn("b1", null, dangling);
    const restored = restoreMessages([broken], "b1");

    const result = restored.find((m) => m.role === "tool" && (m as { toolCallId: string }).toolCallId === "x");
    assert.ok(result !== undefined, "the call must have a result");
    assert.equal((result as { content: string }).content, INTERRUPTED_TOOL_RESULT);

    // Immediately after its own call, which is where the protocol expects it.
    const callAt = restored.findIndex((m) => m.role === "assistant");
    assert.equal(restored.indexOf(result), callAt + 1);

    // And it says what happened rather than that the tool succeeded.
    assert.match(INTERRUPTED_TOOL_RESULT, /중단/);
  });

  test("the stored turn is not touched by the repair", () => {
    // C1's invariant: `messageDelta` is the immutable copy of what was
    // observed. The repair is a reading of it, not an edit to it.
    const broken = turn("b1", null, dangling);
    const before = structuredClone(broken.messageDelta) as ProviderMessage[];
    restoreMessages([broken], "b1");
    assert.deepEqual(broken.messageDelta, before);
    assert.equal(broken.messageDelta.filter((m) => m.role === "tool").length, 0);
  });

  test("a dangling call in the middle of a conversation is repaired too", () => {
    // Once a later turn is appended, the gap is no longer at the tip: the
    // history reads assistant(tool_call) → user, which is rejected outright. So
    // the whole conversation would be unusable, not just its end.
    const broken = turn("b1", null, dangling);
    const after = turn("b2", "b1", exchange("2"));
    const restored = restoreMessages([broken, after], "b2");

    const callAt = restored.findIndex((m) => m.role === "assistant" && (m.toolCalls ?? []).length > 0);
    assert.equal(restored[callAt + 1]?.role, "tool", "the result must sit between the call and the next turn");

    const verdict = canBranchFrom([broken, after], "b2");
    assert.deepEqual(verdict.ok === true ? verdict.repairs : null, [{ callId: "x", toolName: "run_command" }]);
  });

  test("a whole chain needs no repair and says so", () => {
    const verdict = canBranchFrom(LINE, "t3");
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.ok === true ? verdict.repairs : null, []);
    // Untouched, byte for byte.
    assert.deepEqual(restoreMessages(LINE, "t3"), restoreMessages(LINE, "t3", { repair: false }));
  });

  test("an unknown turn is still a refusal, not a throw", () => {
    // Called from the UI, where a stale id should grey a button rather than
    // break the panel. Structure is the only thing that can refuse now.
    assert.equal(canBranchFrom(LINE, "nope").ok, false);
  });

  test("so is a cycle", () => {
    const a = turn("a", "b", exchange("a"));
    const b = turn("b", "a", exchange("b"));
    assert.equal(canBranchFrom([a, b], "a").ok, false);
  });
});

describe("G6 — reachability", () => {
  test("turns under any branch head are reachable", () => {
    const t2b = turn("t2b", "t1", exchange("2b"));
    const branches = [
      newBranch(MAIN_BRANCH_ID, "main", "t3", 0),
      newBranch("alt", "alt", "t2b", 0),
    ];
    assert.deepEqual(
      [...reachableTurns([...LINE, t2b], branches)].sort(),
      ["t1", "t2", "t2b", "t3"],
    );
  });

  test("a branch pointing at a turn that is gone does not cost the others theirs", () => {
    const branches = [newBranch(MAIN_BRANCH_ID, "main", "t2", 0), newBranch("alt", "alt", "vanished", 0)];
    assert.deepEqual([...reachableTurns(LINE, branches)].sort(), ["t1", "t2"]);
  });
});

describe("G7 — branch names are not paths", () => {
  test("traversal and separators are refused", () => {
    for (const name of ["..", "../../etc/passwd", "a/b", "a\\b", "C:\\temp", "..\\..\\x"]) {
      assert.equal(isValidBranchName(name), false, name);
    }
  });

  test("control characters are refused", () => {
    assert.equal(isValidBranchName("a\u0000b"), false);
    assert.equal(isValidBranchName("a\nb"), false);
  });

  test("ordinary names, including Korean, are accepted", () => {
    for (const name of ["main", "실험 2", "fix-login", "v1.2"]) {
      assert.equal(isValidBranchName(name), true, name);
    }
  });

  test("empty and overlong are refused", () => {
    assert.equal(isValidBranchName("   "), false);
    assert.equal(isValidBranchName("x".repeat(61)), false);
  });

  test("ids are checked before they are trusted", () => {
    assert.equal(isValidGraphId("t1-0"), true);
    assert.equal(isValidGraphId("../x"), false);
    assert.equal(isValidGraphId(""), false);
    assert.equal(isValidGraphId("-leading"), false);
  });
});

describe("G8 — a turn's state is stated, never inferred into 'completed'", () => {
  test("only a finished run completes", () => {
    assert.equal(turnStateFor("finished"), "completed");
  });

  test("every ceiling and refusal is aborted, not completed", () => {
    const stopped: RunTerminationReason[] = [
      "denied",
      "aborted",
      "timeout",
      "loop_detected",
      // A run that stopped because it was getting nowhere. Aborted, never
      // completed: the requirements it did not meet are still not met, and the
      // next turn has to be able to carry on from them.
      "no_progress",
      "max_steps",
      "max_model_calls",
      "max_tool_calls",
    ];
    for (const reason of stopped) assert.equal(turnStateFor(reason), "aborted", reason);
  });

  test("an error fails", () => {
    assert.equal(turnStateFor("error"), "failed");
  });

  test("an absent or unrecognised reason fails rather than passing as complete", () => {
    assert.equal(turnStateFor(null), "failed");
    assert.equal(turnStateFor(undefined), "failed");
    assert.equal(turnStateFor("something_new" as RunTerminationReason), "failed");
  });
});

describe("G9 — what a branch head may point at", () => {
  test("a running turn is not a head", () => {
    assert.equal(isUsableHead(turn("r", null, exchange("r"), { state: "running" })), false);
  });

  test("an abnormal but complete turn is", () => {
    // Invariant: an aborted turn is a real turn. Its history is whole, so work
    // may continue from it.
    assert.equal(isUsableHead(turn("a", null, exchange("a"), { state: "aborted" })), true);
    assert.equal(isUsableHead(turn("f", null, exchange("f"), { state: "failed" })), true);
  });

  test("a turn whose protocol is incomplete is not", () => {
    const broken = turn("b", null, [
      { role: "user", content: "x" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "1", name: "read_file", arguments: {}, rawArguments: "{}", argumentsValid: true }],
      },
    ]);
    assert.equal(isUsableHead(broken), false);
  });
});

describe("assessRestorable looks at the messages, not at the ending", () => {
  test("an empty turn is restorable", () => {
    assert.equal(assessRestorable([]).restorable, true);
  });

  test("several calls in one message all need results", () => {
    const two: ProviderMessage[] = [
      {
        role: "assistant",
        content: null,
        toolCalls: [
          { id: "1", name: "read_file", arguments: {}, rawArguments: "{}", argumentsValid: true },
          { id: "2", name: "write_file", arguments: {}, rawArguments: "{}", argumentsValid: true },
        ],
      },
      { role: "tool", toolCallId: "1", content: "ok" },
    ];
    const verdict = assessRestorable(two);
    assert.equal(verdict.restorable, false);
    assert.match(String(verdict.reason), /write_file/);
  });

  test("a result arriving in a later turn is not this turn's business", () => {
    // Deltas are assessed one turn at a time, which is the unit a branch moves.
    const first: ProviderMessage[] = [
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "1", name: "read_file", arguments: {}, rawArguments: "{}", argumentsValid: true }],
      },
    ];
    assert.equal(assessRestorable(first).restorable, false);
  });
});
