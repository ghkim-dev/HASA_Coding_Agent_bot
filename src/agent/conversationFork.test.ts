import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentSession } from "./session.ts";
import { allowingApprovalPort } from "./approval.ts";
import { nullLogger } from "../hasa-client/logger.ts";
import { createRepoFixture, type RepoFixture } from "../testing/repo-fixture.ts";
import { TurnRecorder } from "./sessionRecorder.ts";
import { ConversationStore, type ConversationStorePort } from "./conversationStore.ts";
import { MAIN_BRANCH_ID, completedTurn, restoreEvents, restoreMessages } from "./conversationGraph.ts";
import { reduceSession } from "./sessionView.ts";
import type { AgentCompletion, AgentEvent, AgentModel } from "./types.ts";
import type { ProviderMessage } from "../provider/types.ts";
import type { SessionEvent } from "./sessionEvents.ts";

/**
 * Forking a real conversation, and continuing on the fork.
 *
 * The pure operations are covered in `conversationBranch.test.ts` and the store
 * in `conversationBranchStore.test.ts`. What is left, and what this is for, is
 * the claim the whole phase rests on:
 *
 *   A branch is not a branch until the model's context moves too.
 *
 * So this drives a real `AgentSession`, records with the real `TurnRecorder`,
 * writes through the real `ConversationStore`, forks at a turn in the middle,
 * runs another real turn on the fork, and then checks what the model was
 * actually handed — not what the graph says it would be handed.
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

/**
 * A conversation driven the way the host drives one.
 *
 * Mirrors `AgentHost.run` / `persistTurn` / `adopt`: a recorder per turn, the
 * delta taken from the session afterwards, the pair handed to `appendTurn`, and
 * — the part under test — both halves put back from one `store.load`.
 */
class Driver {
  readonly store: ConversationStore;
  readonly port = memory();
  readonly id = "conv1";
  readonly seen: ProviderMessage[][] = [];
  private ordinal = 0;
  private session: AgentSession;
  private events: SessionEvent[] = [];

  constructor(session: AgentSession, seen: ProviderMessage[][]) {
    this.session = session;
    this.seen = seen;
    this.store = new ConversationStore({ port: this.port, home: "/home", apiKey: "k" });
  }

  /** What the panel would draw right now. */
  transcript(): SessionEvent[] {
    return this.events;
  }

  async ask(prompt: string): Promise<string> {
    const turnId = `${this.id}-${this.ordinal++}`;
    const recorder = new TurnRecorder({ turnId });
    const turnEvents: SessionEvent[] = [];
    const keep = (list: readonly SessionEvent[]): void => {
      turnEvents.push(...list);
      this.events.push(...list);
    };
    keep(recorder.userMessage(prompt, []));
    this.session.setEventSink((event: AgentEvent) => keep(recorder.record(event)));

    const at = this.ordinal * 1000;
    const outcome = await this.session.send(prompt, new AbortController().signal);
    await this.store.appendTurn(
      this.id,
      completedTurn({
        id: turnId,
        startedAt: at,
        completedAt: at + 500,
        events: turnEvents,
        messageDelta: this.session.takeMessageDelta(),
        reason: outcome.reason,
      }),
      { title: prompt, updatedAt: at + 500 },
    );
    return turnId;
  }

  /** Both halves, from one load. The thing `AgentHost.adopt` does. */
  async adopt(): Promise<void> {
    const stored = await this.store.load(this.id);
    assert.ok(stored !== null);
    this.session.restore(stored.messages);
    this.events = [...(stored.events ?? [])];
    this.ordinal = stored.turns?.length ?? this.ordinal;
  }

  /**
   * `branchId` is ours and is a slug; `name` is the user's and may be any text.
   * The store refuses a non-slug id, which is where this test first went wrong.
   */
  async fork(branchId: string, name: string, fromTurnId: string): Promise<void> {
    const result = await this.store.createBranch(this.id, {
      branchId,
      name,
      fromTurnId,
      at: 9000,
      activate: true,
    });
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    await this.adopt();
  }

  async switchTo(branchId: string): Promise<void> {
    assert.equal(await this.store.switchBranch(this.id, branchId, 9500), true);
    await this.adopt();
  }
}

async function driver(script: AgentCompletion[]): Promise<Driver> {
  const fixture = await createRepoFixture({ "a.ts": "export const a = 1;\n" });
  fixtures.push(fixture);
  let index = 0;
  const seen: ProviderMessage[][] = [];
  const model: AgentModel = {
    modelId: "test",
    async complete(request) {
      // Snapshotted: the loop keeps pushing into the array it hands over, so a
      // stored reference would show the future rather than what was sent.
      seen.push(structuredClone([...request.messages]) as ProviderMessage[]);
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
  return new Driver(session, seen);
}

const ANSWERS = [
  completion({ text: "첫 번째 답변." }),
  completion({ text: "두 번째 답변." }),
  completion({ text: "세 번째 답변." }),
  completion({ text: "분기 후 답변." }),
  completion({ text: "또 다른 답변." }),
];

describe("a fork moves the model's context, not only the screen", () => {
  test("the turn after a fork is sent the fork's history and nothing later", async () => {
    // The assertion the whole phase exists for, made against what the model was
    // actually handed rather than against the graph's account of it.
    const d = await driver(ANSWERS);
    const t0 = await d.ask("첫 질문");
    const t1 = await d.ask("둘째 질문");
    await d.ask("셋째 질문");

    await d.fork("alt", "다른 방향", t1);
    await d.ask("분기에서 묻는 질문");

    const sent = d.seen.at(-1);
    assert.ok(sent !== undefined);
    const text = JSON.stringify(sent.filter((m) => m.role !== "system"));

    assert.match(text, /첫 질문/, "the fork keeps what came before it");
    assert.match(text, /둘째 질문/, "…including the turn it forked at");
    assert.ok(!text.includes("셋째 질문"), "the model is still holding a question the user left behind");
    assert.ok(!text.includes("세 번째 답변"), "…and an answer that is no longer on screen");
    assert.match(text, /분기에서 묻는 질문/, "and the new turn itself");

    void t0;
  });

  test("the screen and the model stop at the same turn", async () => {
    const d = await driver(ANSWERS);
    await d.ask("첫 질문");
    const t1 = await d.ask("둘째 질문");
    await d.ask("셋째 질문");
    await d.fork("alt", "다른 방향", t1);

    const stored = await d.store.load(d.id);
    const head = stored!.branches!.find((b) => b.id === "alt")!.headTurnId!;

    // Both from the same chain, compared to each other rather than to a
    // hand-written expectation.
    const chain = restoreEvents(stored!.turns!, head).map((e) => e.turnId);
    assert.deepEqual([...new Set(d.transcript().map((e) => e.turnId))], [...new Set(chain)]);
    assert.deepEqual(stored!.messages, restoreMessages(stored!.turns!, head));

    // And what the panel would draw has no trace of the abandoned turn.
    const view = reduceSession(d.transcript());
    assert.ok(!JSON.stringify(view.turns).includes("셋째 질문"));
  });

  test("the abandoned line is still there, and switching back restores it whole", async () => {
    const d = await driver(ANSWERS);
    await d.ask("첫 질문");
    const t1 = await d.ask("둘째 질문");
    await d.ask("셋째 질문");
    await d.fork("alt", "다른 방향", t1);
    await d.ask("분기에서 묻는 질문");

    await d.switchTo(MAIN_BRANCH_ID);
    const back = JSON.stringify(d.transcript());
    assert.match(back, /셋째 질문/, "the work on main was not lost");
    assert.ok(!back.includes("분기에서 묻는 질문"), "and the fork's work is not on main");

    // The next turn on main is sent main's history.
    await d.ask("main에서 이어서");
    const sent = JSON.stringify(d.seen.at(-1)!.filter((m) => m.role !== "system"));
    assert.match(sent, /셋째 질문/);
    assert.ok(!sent.includes("분기에서 묻는 질문"));
  });

  test("a turn on the fork does not move main", async () => {
    const d = await driver(ANSWERS);
    await d.ask("첫 질문");
    const t1 = await d.ask("둘째 질문");
    const t2 = await d.ask("셋째 질문");
    await d.fork("alt", "다른 방향", t1);
    const forked = await d.ask("분기에서 묻는 질문");

    const stored = await d.store.load(d.id);
    assert.equal(stored!.branches!.find((b) => b.id === MAIN_BRANCH_ID)!.headTurnId, t2);
    assert.equal(stored!.branches!.find((b) => b.id === "alt")!.headTurnId, forked);
    assert.equal(stored!.turns!.find((t) => t.id === forked)!.parentTurnId, t1);
  });

  test("turn ids stay unique across a fork", async () => {
    // The ordinal counts turns rather than the branch's length. Counting the
    // branch would hand the fork's first turn an id the abandoned line already
    // used, and `appendTurn` would replace that turn instead of adding one.
    const d = await driver(ANSWERS);
    await d.ask("첫 질문");
    const t1 = await d.ask("둘째 질문");
    await d.ask("셋째 질문");
    await d.fork("alt", "다른 방향", t1);
    await d.ask("분기에서 묻는 질문");
    await d.ask("한 번 더");

    const stored = await d.store.load(d.id);
    const ids = stored!.turns!.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate turn id: ${ids.join(", ")}`);
    assert.equal(ids.length, 5);
  });
});

describe("a conversation branch leaves the files alone", () => {
  test("forking and switching changes no file in the workspace", async () => {
    // Stated against a real workspace rather than against the type. The word
    // "branch" arrives from git carrying the expectation that switching moves
    // your files; if that ever creeps in, this is where it is caught.
    const fixture = await createRepoFixture({ "a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);
    let index = 0;
    const seen: ProviderMessage[][] = [];
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model: {
        modelId: "test",
        async complete(request) {
          seen.push(structuredClone([...request.messages]) as ProviderMessage[]);
          return ANSWERS[index++] ?? completion({ text: "기본" });
        },
      },
      approvalPort: allowingApprovalPort,
      approvalMode: "auto",
      mode: "code",
      logger: nullLogger,
    });
    const d = new Driver(session, seen);

    await d.ask("첫 질문");
    const t1 = await d.ask("둘째 질문");
    await d.ask("셋째 질문");

    // The user's own edit, uncommitted, of the kind a git checkout would eat.
    const path = join(fixture.root, "a.ts");
    await writeFile(path, "export const a = 2; // 작업 중\n", "utf8");
    const before = await readFile(path, "utf8");

    await d.fork("alt", "다른 방향", t1);
    await d.ask("분기에서 묻는 질문");
    await d.switchTo(MAIN_BRANCH_ID);

    assert.equal(await readFile(path, "utf8"), before, "a conversation branch must not touch the workspace");
  });
});
