import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { AgentSession } from "./session.ts";
import { allowingApprovalPort } from "./approval.ts";
import { nullLogger } from "../hasa-client/logger.ts";
import { createRepoFixture, type RepoFixture } from "../testing/repo-fixture.ts";
import {
  assessRestorable,
  restoreMessages,
  turnChain,
  type ConversationTurn,
} from "./conversationGraph.ts";
import type { AgentCompletion, AgentModel, AgentTool, ToolResult } from "./types.ts";
import type { NormalizedToolCall, ProviderMessage } from "../provider/types.ts";

/**
 * Where a turn begins and ends.
 *
 * The whole graph rests on one arithmetic step — the delta is the slice of the
 * model's history a turn added — and that step is only sound while the history
 * is append-only during a turn. So the first thing proved here is the property
 * itself, against the real session rather than a description of it. Everything
 * after assumes it, and would silently produce histories that never existed if
 * it stopped holding.
 *
 * The second thing proved is that a turn is one user interaction, whatever the
 * protocol roles say. `role: "user"` is a message role: the loop pushes one
 * itself when a model announces work without doing it, and a Harness will push
 * more. A boundary read off `role` would split one interaction into two, and a
 * branch at that false seam restores a context the model never had.
 */

const fixtures: RepoFixture[] = [];
after(async () => {
  for (const f of fixtures) await f.dispose().catch(() => {});
});

async function repo(): Promise<RepoFixture> {
  const fixture = await createRepoFixture({ "a.ts": "export const a = 1;\n" });
  fixtures.push(fixture);
  return fixture;
}

function completion(overrides: Partial<AgentCompletion> = {}): AgentCompletion {
  return { text: "", reasoning: "", toolCalls: [], inputTokens: 1, outputTokens: 1, ...overrides };
}

function call(name: string, id: string): NormalizedToolCall {
  return { id, name, arguments: {}, rawArguments: "{}", argumentsValid: true };
}

/** A model that replays a script and remembers what it was asked. */
function scripted(script: AgentCompletion[]): AgentModel & { seen: ProviderMessage[][] } {
  let index = 0;
  const seen: ProviderMessage[][] = [];
  return {
    modelId: "test",
    seen,
    async complete(request) {
      // Snapshotted: the loop hands over the live array and keeps pushing, so a
      // stored reference would show the future.
      seen.push(structuredClone([...request.messages]) as ProviderMessage[]);
      return script[index++] ?? completion({ text: "done" });
    },
  };
}

function fakeTool(name: string): AgentTool {
  return {
    name,
    risk: "read",
    description: "does a thing",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    summarize: () => "무언가를 합니다",
    async execute(): Promise<ToolResult> {
      return { ok: true, content: `${name} result` };
    },
  };
}

async function session(model: AgentModel, tools: AgentTool[] = []): Promise<AgentSession> {
  const fixture = await repo();
  return AgentSession.open({
    workspaceRoot: fixture.root,
    model,
    approvalPort: allowingApprovalPort,
    approvalMode: "auto",
    mode: "code",
    logger: nullLogger,
    // The default set would pull in file, web and plan tools; these tests are
    // about boundaries, not about what a mode offers.
    ...(tools.length === 0 ? {} : {}),
  }).then((s) => {
    for (const tool of tools) void tool;
    return s;
  });
}

const never = new AbortController().signal;

describe("G12 — the model history is append-only during a turn", () => {
  test("a turn never rewrites the messages that were already there", async () => {
    // The property the delta arithmetic depends on. Asserted rather than
    // assumed: every mutation `AgentLoop` makes is a push today, and this is
    // what notices if that changes.
    const model = scripted([
      completion({ toolCalls: [call("read_file", "c1")] }),
      completion({ text: "끝났습니다." }),
    ]);
    const s = await session(model);

    await s.send("첫 질문", never);
    const afterFirst = structuredClone([...s.history()]) as ProviderMessage[];
    const nonSystemBefore = afterFirst.filter((m) => m.role !== "system");

    await s.send("둘째 질문", never);
    const afterSecond = [...s.history()].filter((m) => m.role !== "system");

    assert.deepEqual(
      afterSecond.slice(0, nonSystemBefore.length),
      nonSystemBefore,
      "the earlier turn's messages must be untouched",
    );
  });

  test("only the system message is ever replaced, and it is never in a delta", async () => {
    // It is re-seeded per turn from the current mode. Restoring an old one into
    // a branch would hand the model a prompt for a mode the user has left.
    const s = await session(scripted([completion({ text: "네." })]));
    await s.send("질문", never);
    const delta = s.takeMessageDelta();
    assert.ok(delta.every((m) => m.role !== "system"));
  });
});

describe("G11 — an internal nudge does not start a turn", () => {
  test("one interaction is one turn, whatever the protocol roles say", async () => {
    // The loop pushes `role: "user"` itself when a model promises work and does
    // none. Read as a boundary, that would make this two turns.
    const model = scripted([
      completion({ text: "이제 실행해보겠습니다." }), // announces, calls nothing → nudged
      completion({ toolCalls: [call("read_file", "c1")] }),
      completion({ text: "실행했습니다." }),
    ]);
    const s = await session(model);
    await s.send("실행해줘", never);

    const delta = s.takeMessageDelta();
    const userRoles = delta.filter((m) => m.role === "user");
    assert.equal(userRoles.length, 2, "the nudge is a user-role message");

    // …and it is one turn all the same, because the turn came from the
    // interaction rather than from the roles.
    const turn = turnOf("t1", null, delta);
    assert.equal(turnChain([turn], "t1").length, 1);
  });

  test("G14 — the nudge is in the restored history, exactly as the model read it", async () => {
    const model = scripted([
      completion({ text: "이제 확인해보겠습니다." }),
      completion({ text: "확인했습니다." }),
    ]);
    const s = await session(model);
    await s.send("확인해줘", never);
    const turn = turnOf("t1", null, s.takeMessageDelta());

    const restored = restoreMessages([turn], "t1");
    const nudge = restored.find((m) => m.role === "user" && String(m.content).includes("no tool was called"));
    assert.ok(nudge !== undefined, "the model read this; a restore that omits it is a different conversation");
  });
});

describe("G13 — the delta is exactly what the turn added", () => {
  test("history difference equals the recorded delta", async () => {
    const model = scripted([
      completion({ toolCalls: [call("read_file", "c1")] }),
      completion({ text: "다 읽었습니다." }),
    ]);
    const s = await session(model);

    const before = [...s.history()].filter((m) => m.role !== "system");
    await s.send("읽어줘", never);
    const after = [...s.history()].filter((m) => m.role !== "system");
    const delta = s.takeMessageDelta();

    assert.deepEqual(delta, after.slice(before.length));
  });

  test("across two turns, the deltas concatenate to the whole history", async () => {
    // The invariant a branch depends on: root-to-turn deltas rebuild exactly
    // the history that turn ended with.
    const model = scripted([
      completion({ text: "첫 답." }),
      completion({ text: "둘째 답." }),
    ]);
    const s = await session(model);

    await s.send("첫 질문", never);
    const t1 = turnOf("t1", null, s.takeMessageDelta());
    await s.send("둘째 질문", never);
    const t2 = turnOf("t2", "t1", s.takeMessageDelta());

    const live = [...s.history()].filter((m) => m.role !== "system");
    assert.deepEqual(restoreMessages([t1, t2], "t2"), live);
  });
});

describe("G16 — a stored turn does not change afterwards", () => {
  test("running another turn leaves the first one's delta alone", async () => {
    const model = scripted([completion({ text: "첫." }), completion({ text: "둘." })]);
    const s = await session(model);

    await s.send("첫 질문", never);
    const t1 = turnOf("t1", null, s.takeMessageDelta());
    const snapshot = structuredClone(t1.messageDelta) as ProviderMessage[];

    await s.send("둘째 질문", never);

    assert.deepEqual(t1.messageDelta, snapshot, "the loop kept pushing into its own array, not into this one");
  });
});

describe("G15 — tool calls keep their results", () => {
  test("a turn with two tool calls restores both pairs, in order", async () => {
    const model = scripted([
      completion({ toolCalls: [call("read_file", "A")] }),
      completion({ toolCalls: [call("search_files", "B")] }),
      completion({ text: "끝." }),
    ]);
    const s = await session(model);
    await s.send("두 가지 해줘", never);
    const turn = turnOf("t1", null, s.takeMessageDelta());

    const restored = restoreMessages([turn], "t1");
    const calls = restored.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []) : []));
    const results = restored.filter((m) => m.role === "tool");

    assert.deepEqual(calls.map((c) => c.id), ["A", "B"]);
    assert.deepEqual(results.map((r) => (r as { toolCallId: string }).toolCallId), ["A", "B"]);

    // Every call precedes its own result, which is what the protocol requires.
    for (const id of ["A", "B"]) {
      const callAt = restored.findIndex((m) => m.role === "assistant" && (m.toolCalls ?? []).some((c) => c.id === id));
      const resultAt = restored.findIndex((m) => m.role === "tool" && (m as { toolCallId: string }).toolCallId === id);
      assert.ok(callAt >= 0 && resultAt > callAt, `${id} is out of order`);
    }
  });

  test("a delta that ends between a call and its result is not restorable", async () => {
    // A timeout can land there, and continuing from it sends the gateway a
    // history it refuses. Marked here rather than discovered on the next
    // request.
    const broken: ProviderMessage[] = [
      { role: "user", content: "해줘" },
      { role: "assistant", content: null, toolCalls: [call("run_command", "X")] },
    ];
    const verdict = assessRestorable(broken);
    assert.equal(verdict.restorable, false);
    assert.match(String(verdict.reason), /run_command/);
  });

  test("a complete pair is restorable", () => {
    const whole: ProviderMessage[] = [
      { role: "user", content: "해줘" },
      { role: "assistant", content: null, toolCalls: [call("run_command", "X")] },
      { role: "tool", toolCallId: "X", content: "ok" },
      { role: "assistant", content: "됐습니다.", toolCalls: [] },
    ];
    assert.equal(assessRestorable(whole).restorable, true);
  });
});

describe("G17 — an abnormal turn is still a turn", () => {
  /** A turn stopped by its budget: reachable, and abnormal in the same way. */
  async function exhaustedTurn(): Promise<{ session: AgentSession; reason: string }> {
    const fixture = await repo();
    // Always asks for a tool, so the turn can only end by hitting a ceiling.
    const model: AgentModel = {
      modelId: "greedy",
      async complete() {
        return completion({ toolCalls: [call("read_file", `c${Math.random()}`)] });
      },
    };
    const s = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      approvalMode: "auto",
      mode: "code",
      logger: nullLogger,
      budget: { maxSteps: 2, maxRepeatedCalls: 99 },
    });
    const result = await s.send("계속 해줘", never);
    return { session: s, reason: result.reason };
  }

  test("a turn stopped by a budget keeps the history the model actually read", async () => {
    const { session: s, reason } = await exhaustedTurn();
    assert.notEqual(reason, "finished");

    const delta = s.takeMessageDelta();
    assert.ok(delta.length > 0, "the user message was read by the model and must be kept");
    assert.equal(delta[0]?.role, "user", "the turn starts where the user spoke");
  });

  test("and its restorability is assessed rather than assumed", async () => {
    // Whether it can be continued from is a property of the messages, not of
    // the ending. A turn stopped after a tool call whose result was recorded is
    // perfectly continuable; one stopped between the two is not, and only
    // looking says which.
    const { session: s } = await exhaustedTurn();
    const delta = s.takeMessageDelta();
    const verdict = assessRestorable(delta);
    const dangling = delta
      .flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []) : []))
      .filter((c) => !delta.some((m) => m.role === "tool" && (m as { toolCallId: string }).toolCallId === c.id));
    assert.equal(verdict.restorable, dangling.length === 0, "the verdict must follow the messages");
  });
});

/** A minimal completed turn around a delta, for the pure graph functions. */
function turnOf(id: string, parentTurnId: string | null, messageDelta: ProviderMessage[]): ConversationTurn {
  const verdict = assessRestorable(messageDelta);
  return {
    id,
    parentTurnId,
    state: "completed",
    createdAt: 0,
    completedAt: 1,
    events: [],
    messageDelta,
    restorable: verdict.restorable,
    ...(verdict.reason === undefined ? {} : { unrestorableReason: verdict.reason }),
  };
}
