import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { AgentSession } from "./session.ts";
import { allowingApprovalPort } from "./approval.ts";
import { nullLogger } from "../hasa-client/logger.ts";
import { createRepoFixture, type RepoFixture } from "../testing/repo-fixture.ts";
import { TurnRecorder } from "./sessionRecorder.ts";
import { ConversationStore, type ConversationStorePort } from "./conversationStore.ts";
import { completedTurn, restoreEvents, restoreMessages, canBranchFrom } from "./conversationGraph.ts";
import { reduceSession } from "./sessionView.ts";
import type { AgentCompletion, AgentEvent, AgentModel } from "./types.ts";
import type { NormalizedToolCall, ProviderMessage } from "../provider/types.ts";
import type { SessionEvent } from "./sessionEvents.ts";

/**
 * The invariant, end to end.
 *
 * A screen that looks like it went back is not a branch. The model's context has
 * to go back to the same moment, and the only way to know it does is to drive
 * the real session, record with the real recorder, write with the real store,
 * read it back, and compare both halves against a point in the past.
 *
 * The pure graph functions are covered in `conversationGraph.test.ts` and the
 * boundary observation in `turnBoundary.test.ts`. What is proved here is that
 * the pieces, assembled the way the host assembles them, carry the invariant.
 */

const fixtures: RepoFixture[] = [];
after(async () => {
  for (const f of fixtures) await f.dispose().catch(() => {});
});

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

function completion(overrides: Partial<AgentCompletion> = {}): AgentCompletion {
  return { text: "", reasoning: "", toolCalls: [], inputTokens: 1, outputTokens: 1, ...overrides };
}

function call(name: string, id: string): NormalizedToolCall {
  return { id, name, arguments: {}, rawArguments: "{}", argumentsValid: true };
}

/**
 * A conversation driven exactly as the host drives one.
 *
 * Mirrors `AgentHost.run`/`persistTurn`: a recorder per turn, its events kept
 * for that turn, the delta taken from the session afterwards, and the pair
 * handed to `completedTurn` and `appendTurn`.
 */
class Harnessed {
  readonly session: AgentSession;
  readonly id: string;
  readonly store: ConversationStore;
  readonly port = memory();
  private ordinal = 0;

  constructor(session: AgentSession, id = "conv1") {
    this.session = session;
    this.id = id;
    this.store = new ConversationStore({ port: this.port, home: "/home", workspaceId: "wsaaaaaaaaaaaaaaaa" });
  }

  async ask(prompt: string): Promise<string> {
    const turnId = `${this.id}-${this.ordinal++}`;
    const recorder = new TurnRecorder({ turnId });
    const events: SessionEvent[] = [];
    events.push(...recorder.userMessage(prompt, []));

    const forward = (event: AgentEvent): void => {
      events.push(...recorder.record(event));
    };
    this.session.setEventSink(forward);

    const startedAt = this.ordinal * 1000;
    const outcome = await this.session.send(prompt, new AbortController().signal);

    await this.store.appendTurn(
      this.id,
      completedTurn({
        id: turnId,
        startedAt,
        completedAt: startedAt + 500,
        events,
        messageDelta: this.session.takeMessageDelta(),
        reason: outcome.reason,
      }),
      { title: prompt, updatedAt: startedAt + 500 },
    );
    return turnId;
  }
}

async function harness(script: AgentCompletion[]): Promise<Harnessed> {
  const fixture = await createRepoFixture({ "a.ts": "export const a = 1;\n" });
  fixtures.push(fixture);
  let index = 0;
  const model: AgentModel = {
    modelId: "test",
    async complete() {
      return script[index++] ?? completion({ text: "기본 답변" });
    },
  };
  const session = await AgentSession.open({
    workspaceRoot: fixture.root,
    model,
    approvalPort: allowingApprovalPort,
    approvalMode: "auto",
    mode: "code",
    logger: nullLogger,
  });
  return new Harnessed(session);
}

/** Three ordinary turns, the second of which uses a tool. */
function threeTurns(): AgentCompletion[] {
  return [
    completion({ text: "첫 번째 답변입니다." }),
    completion({ toolCalls: [call("read_file", "c1")] }),
    completion({ text: "두 번째 답변입니다." }),
    completion({ text: "세 번째 답변입니다." }),
  ];
}

describe("a saved conversation is the conversation that happened", () => {
  test("what is read back equals the live model history, exactly", async () => {
    const h = await harness(threeTurns());
    await h.ask("첫 질문");
    await h.ask("둘째 질문");
    await h.ask("셋째 질문");

    const live = [...h.session.history()].filter((m) => m.role !== "system");
    const loaded = await h.store.load(h.id);

    assert.deepEqual(loaded?.messages, live);
  });

  test("and the screen it draws is the screen that was drawn", async () => {
    const h = await harness(threeTurns());
    await h.ask("첫 질문");
    await h.ask("둘째 질문");

    const loaded = await h.store.load(h.id);
    const view = reduceSession(loaded?.events ?? []);

    // The view splits each exchange into what the user said and what the agent
    // did, in order.
    assert.deepEqual(
      view.turns.map((t) => [t.turnId, t.role]),
      [
        [`${h.id}-0`, "user"],
        [`${h.id}-0`, "agent"],
        [`${h.id}-1`, "user"],
        [`${h.id}-1`, "agent"],
      ],
    );
    assert.deepEqual(view.turns[0]?.blocks, [{ kind: "text", id: `${h.id}-0-1`, text: "첫 질문" }]);
    assert.deepEqual(view.turns[2]?.blocks, [{ kind: "text", id: `${h.id}-1-1`, text: "둘째 질문" }]);
    // The tool the second exchange used is in the record, not merely its answer.
    assert.ok(JSON.stringify(view.turns[3]?.blocks).includes("read_file"));
  });
});

describe("restoring to a past turn moves both halves to the same point", () => {
  test("the model's context is the context it had then — nothing from later", async () => {
    // The whole phase in one assertion. If the events came back at turn 2 and
    // the messages at turn 3, this is what would catch it.
    const h = await harness(threeTurns());
    const t0 = await h.ask("첫 질문");
    const t1 = await h.ask("둘째 질문");
    await h.ask("셋째 질문");

    const loaded = await h.store.load(h.id);
    const turns = loaded!.turns!;

    const messagesAt1 = restoreMessages(turns, t1);
    const eventsAt1 = restoreEvents(turns, t1);

    // Neither half knows about the third turn.
    const asText = JSON.stringify(messagesAt1);
    assert.ok(!asText.includes("셋째 질문"), "the model would still be holding a question the user unasked");
    assert.ok(!asText.includes("세 번째 답변"), "…and an answer that no longer exists on screen");
    assert.ok(!JSON.stringify(eventsAt1).includes("셋째 질문"));

    // And both stop at the same turn.
    assert.deepEqual([...new Set(eventsAt1.map((e) => e.turnId))], [t0, t1]);
    assert.deepEqual(
      messagesAt1,
      [t0, t1].flatMap((id) => turns.find((t) => t.id === id)!.messageDelta),
    );
  });

  test("a session restored to that point holds exactly those messages", async () => {
    // Not "an array that looks right" — the session's own history after
    // `restore`, which is what the next request is built from.
    const h = await harness(threeTurns());
    await h.ask("첫 질문");
    const t1 = await h.ask("둘째 질문");
    await h.ask("셋째 질문");

    const turns = (await h.store.load(h.id))!.turns!;
    const wanted = restoreMessages(turns, t1);

    h.session.restore(wanted as ProviderMessage[]);
    assert.deepEqual([...h.session.history()].filter((m) => m.role !== "system"), wanted);
  });

  test("the tool call and its result travel together", async () => {
    // Turn 2 is the one with a tool. Restoring to it must not leave a call
    // whose result is on the other side of the cut.
    const h = await harness(threeTurns());
    await h.ask("첫 질문");
    const t1 = await h.ask("둘째 질문");

    const turns = (await h.store.load(h.id))!.turns!;
    const messages = restoreMessages(turns, t1);

    const calls = messages.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []) : []));
    assert.ok(calls.length > 0, "this turn is supposed to use a tool");
    for (const c of calls) {
      assert.ok(
        messages.some((m) => m.role === "tool" && (m as { toolCallId: string }).toolCallId === c.id),
        `${c.name} lost its result across the restore`,
      );
    }
    assert.equal(canBranchFrom(turns, t1).ok, true);
  });

  test("continuing from a restored point appends to that point, not to the abandoned tip", async () => {
    const h = await harness(threeTurns());
    await h.ask("첫 질문");
    const t1 = await h.ask("둘째 질문");
    await h.ask("셋째 질문");

    const turns = (await h.store.load(h.id))!.turns!;
    // Turn 3 is not on the chain to turn 2, and the chain is what a new turn
    // would be built on.
    const chain = restoreEvents(turns, t1).map((e) => e.turnId);
    assert.equal(chain.includes(`${h.id}-2`), false);
    assert.equal(turns.find((t) => t.id === `${h.id}-2`)?.parentTurnId, t1);
  });
});

describe("an abnormal turn survives the round trip", () => {
  test("a turn stopped by a budget is stored with the state it reached", async () => {
    const fixture = await createRepoFixture({ "a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);
    const model: AgentModel = {
      modelId: "greedy",
      async complete() {
        return completion({ toolCalls: [call("read_file", `c${Math.random()}`)] });
      },
    };
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      approvalMode: "auto",
      mode: "code",
      logger: nullLogger,
      budget: { maxSteps: 2, maxRepeatedCalls: 99 },
    });
    const h = new Harnessed(session);
    const turnId = await h.ask("계속 해줘");

    const loaded = await h.store.load(h.id);
    const stored = loaded?.turns?.find((t) => t.id === turnId);

    assert.ok(stored !== undefined, "an abnormal turn is still a turn and is still written");
    assert.notEqual(stored.state, "completed", "it must not be recorded as having completed");
    assert.notEqual(stored.terminationReason, "finished");
    // What the user typed is in it either way.
    assert.ok(JSON.stringify(stored.events).includes("계속 해줘"));
    assert.ok(loaded!.messages.length > 0);
  });
});
