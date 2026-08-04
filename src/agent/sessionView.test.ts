import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SESSION_SCHEMA_VERSION, type SessionEvent } from "./sessionEvents.ts";
import { migrateFromMessages, readSession, writeSession } from "./sessionLog.ts";
import { reduceSession, terminationView } from "./sessionView.ts";
import { TurnRecorder } from "./sessionRecorder.ts";
import type { AgentEvent } from "./types.ts";

/**
 * The invariant this whole model exists for.
 *
 *   what the user saw live === what they see when they open it again
 *
 * It did not hold, and the reason was structural rather than a bug anyone could
 * have spotted in the renderer: a live turn was drawn from `AgentEvent`s that
 * were never written down, and a reopened one was rebuilt from the model's
 * prompt array, which has no room for a plan, a reasoning summary, a file
 * change or the reason a run stopped. Two different inputs, two different
 * renderers, one of them missing most of the conversation.
 *
 * These tests assert the pipeline end to end — runtime events in, disk in the
 * middle, the same view out — because that is the only place the invariant is
 * visible.
 */

const NOW = 1_700_000_000_000;

function recorded(events: AgentEvent[], turnId = "t1"): SessionEvent[] {
  const recorder = new TurnRecorder({ turnId, now: () => NOW });
  recorder.userMessage("파일 두 개를 고치고 테스트 돌려줘");
  for (const event of events) recorder.record(event);
  return recorder.drain();
}

/** A full turn: plan, reasoning, two writes, a command, an ending. */
const TURN: AgentEvent[] = [
  { type: "step", step: 1 },
  { type: "phase", label: "생각하는 중" },
  { type: "reasoning", delta: "인증 흐름부터 확인합니다" },
  { type: "plan", steps: ["파일을 고친다", "테스트를 돌린다"], current: 1 },
  { type: "text", delta: "먼저 두 파일을 고치겠습니다." },
  { type: "tool_start", callId: "c1", name: "create_file", risk: "write", summary: "src/a.ts 파일을 작성합니다" },
  { type: "tool_approval", callId: "c1", name: "create_file", outcome: "granted" },
  {
    type: "tool_end",
    callId: "c1",
    name: "create_file",
    ok: true,
    detail: "wrote src/a.ts",
    changedFiles: [{ path: "src/a.ts", change: "created" }],
  },
  { type: "tool_start", callId: "c2", name: "run_command", risk: "execute", summary: "`pnpm test` 을(를) 실행합니다" },
  {
    type: "tool_end",
    callId: "c2",
    name: "run_command",
    ok: false,
    detail: "exit 1",
    output: "$ pnpm test\nexit 1\n1 failed",
    meta: { truncated: true, originalLength: 9000, returnedLength: 8000, reason: "max_chars" },
  },
  { type: "changed", files: ["src/a.ts"] },
  { type: "done", reason: "loop_detected", summary: "", detail: "read_file 을(를) 4번 호출했습니다." },
];

describe("the same events give the same view, live or reloaded", () => {
  test("a round trip through disk changes nothing a user would see", () => {
    const events = recorded(TURN);
    const live = reduceSession(events);

    const onDisk = writeSession({
      version: SESSION_SCHEMA_VERSION,
      id: "abc",
      title: "t",
      createdAt: NOW,
      updatedAt: NOW,
      events,
      messages: [],
    });
    const loaded = readSession(onDisk);
    assert.ok(loaded !== null);
    const replayed = reduceSession(loaded.session.events);

    assert.deepEqual(replayed, live);
  });

  test("and the view actually contains what the turn produced", () => {
    // A round trip of nothing is also equal to a round trip of nothing, so the
    // equality above is only worth what the view holds.
    const view = reduceSession(recorded(TURN));
    const agent = view.turns.find((t) => t.role === "agent");
    assert.ok(agent !== undefined);

    const kinds = agent.blocks.map((b) => b.kind);
    assert.ok(kinds.includes("reasoning"), "reasoning survived");
    assert.ok(kinds.includes("plan"), "the plan survived");
    assert.ok(kinds.includes("text"), "the prose survived");
    assert.equal(agent.blocks.filter((b) => b.kind === "tool").length, 2, "both tool calls survived");
    assert.deepEqual(view.changedFiles, [{ path: "src/a.ts", change: "created" }]);
    assert.equal(agent.termination?.reason, "loop_detected");
  });

  test("the user's own message is in the view too", () => {
    const view = reduceSession(recorded(TURN));
    const user = view.turns.find((t) => t.role === "user");
    assert.match(String(user?.blocks[0]?.kind === "text" ? user.blocks[0].text : ""), /파일 두 개/);
  });
});

describe("what each event becomes", () => {
  test("a failed command keeps its output and its truncation", () => {
    const view = reduceSession(recorded(TURN));
    const tool = view.turns
      .flatMap((t) => t.blocks)
      .find((b) => b.kind === "tool" && b.toolName === "run_command");
    assert.ok(tool?.kind === "tool");
    assert.equal(tool.status, "failed");
    assert.match(String(tool.output), /1 failed/);
    assert.equal(tool.meta?.truncated, true);
    assert.equal(tool.meta?.originalLength, 9000);
  });

  test("a denied call is denied, not failed", () => {
    // The user saying no is not a tool failure, and a history that calls it one
    // cannot be read honestly later.
    const events = recorded([
      { type: "tool_start", callId: "c1", name: "run_command", risk: "execute", summary: "실행합니다" },
      { type: "tool_approval", callId: "c1", name: "run_command", outcome: "denied" },
      { type: "tool_end", callId: "c1", name: "run_command", ok: false, detail: "denied" },
    ]);
    const tool = reduceSession(events).turns.flatMap((t) => t.blocks).find((b) => b.kind === "tool");
    assert.ok(tool?.kind === "tool");
    assert.equal(tool.status, "denied");
  });

  test("a plan is replaced, not stacked", () => {
    const events = recorded([
      { type: "plan", steps: ["a", "b"], current: 1 },
      { type: "plan", steps: ["a", "b", "c"], current: 2 },
    ]);
    const plans = reduceSession(events).turns.flatMap((t) => t.blocks).filter((b) => b.kind === "plan");
    assert.equal(plans.length, 1);
    assert.ok(plans[0]?.kind === "plan");
    assert.deepEqual(plans[0].steps, ["a", "b", "c"]);
    assert.equal(plans[0].current, 2);
  });

  test("a long plan keeps every step in the data", () => {
    // The display may show fewer. The data layer dropping them is what made a
    // step past the limit unrecoverable rather than merely hidden.
    const steps = Array.from({ length: 30 }, (_, i) => `step ${i + 1}`);
    const events = recorded([{ type: "plan", steps, current: 20 }]);
    const plan = reduceSession(events).turns.flatMap((t) => t.blocks).find((b) => b.kind === "plan");
    assert.ok(plan?.kind === "plan");
    assert.equal(plan.steps.length, 30);
    assert.equal(plan.current, 20);
  });

  test("spinner events are not part of a conversation", () => {
    // Steps, phases and checkpoints drive a progress line and mean nothing once
    // it stops moving. Keeping them would make a reopened conversation a log.
    const events = recorded([
      { type: "step", step: 3 },
      { type: "phase", label: "준비하는 중" },
      { type: "checkpoint", ref: "stash@{0}", detail: "보관했습니다" },
    ]);
    assert.deepEqual(
      events.filter((e) => e.type !== "user_message"),
      [],
    );
  });

  test("consecutive prose is one block, not three", () => {
    const events = recorded([
      { type: "text", delta: "첫 문단." },
      { type: "text", delta: " 이어지는 문장." },
    ]);
    const texts = reduceSession(events).turns
      .filter((t) => t.role === "agent")
      .flatMap((t) => t.blocks)
      .filter((b) => b.kind === "text");
    assert.equal(texts.length, 1);
  });
});

describe("how a run ended", () => {
  test("every reason has a label and a tone, and only success is ok", () => {
    const reasons = [
      "finished",
      "denied",
      "aborted",
      "timeout",
      "loop_detected",
      "max_steps",
      "max_model_calls",
      "max_tool_calls",
      "error",
    ] as const;
    for (const reason of reasons) {
      const view = terminationView(reason);
      assert.ok(view.label.length > 0, reason);
      assert.equal(view.tone === "ok", reason === "finished", reason);
    }
  });

  test("the four abnormal endings are distinguishable, not one blur", () => {
    // The complaint this answers: a turn stopped for looping looked exactly
    // like one that finished.
    const labels = new Set(
      (["finished", "timeout", "loop_detected", "max_model_calls"] as const).map((r) => terminationView(r).label),
    );
    assert.equal(labels.size, 4);
  });

  test("the detail rides along and survives the disk", () => {
    const events = recorded(TURN);
    const disk = readSession(
      writeSession({
        version: SESSION_SCHEMA_VERSION,
        id: "a",
        title: "t",
        createdAt: NOW,
        updatedAt: NOW,
        events,
        messages: [],
      }),
    );
    const turn = reduceSession(disk!.session.events).turns.find((t) => t.termination !== undefined);
    assert.match(String(turn?.termination?.detail), /read_file/);
  });
});

describe("older conversations still open", () => {
  const V1 = JSON.stringify({
    id: "old-1",
    title: "예전 대화",
    createdAt: 1,
    updatedAt: 2,
    messages: [
      { role: "user", content: "이 파일 읽어줘" },
      { role: "assistant", content: "읽겠습니다", toolCalls: [{ id: "c1", name: "read_file" }] },
      { role: "tool", toolCallId: "c1", content: "file contents" },
      { role: "assistant", content: "다 읽었습니다." },
    ],
  });

  test("a v1 file loads and is migrated rather than refused", () => {
    const loaded = readSession(V1);
    assert.ok(loaded !== null);
    assert.equal(loaded.migrated, true);
    assert.equal(loaded.session.version, SESSION_SCHEMA_VERSION);
    assert.equal(loaded.session.title, "예전 대화");
  });

  test("its messages are untouched, because the model still needs them", () => {
    const loaded = readSession(V1);
    assert.equal(loaded?.session.messages.length, 4);
  });

  test("its tool calls come back, which the old reader dropped entirely", () => {
    const view = reduceSession(readSession(V1)!.session.events);
    const tool = view.turns.flatMap((t) => t.blocks).find((b) => b.kind === "tool");
    assert.ok(tool?.kind === "tool");
    assert.equal(tool.toolName, "read_file");
    assert.equal(tool.status, "success");
  });

  test("nothing is invented for what v1 never stored", () => {
    // A migration that guessed at a plan or a termination would put claims in a
    // user's history that never happened.
    const view = reduceSession(readSession(V1)!.session.events);
    const kinds = new Set(view.turns.flatMap((t) => t.blocks).map((b) => b.kind));
    assert.ok(!kinds.has("plan"));
    assert.ok(!kinds.has("reasoning"));
    assert.deepEqual(view.changedFiles, []);
    assert.ok(view.turns.every((t) => t.termination === undefined));
  });

  test("a file from a future version is refused rather than half-read", () => {
    const future = JSON.stringify({ version: 99, id: "x", messages: [], events: [] });
    assert.equal(readSession(future), null);
  });

  test("something that is not a conversation is not one", () => {
    for (const raw of ['{"id":"y"}', "{}", "not json", "[]"]) {
      assert.equal(readSession(raw), null, raw);
    }
  });

  test("an unknown event type is dropped, not fatal", () => {
    // A conversation written by a newer build should lose the parts this one
    // cannot draw, rather than become unopenable.
    const mixed = JSON.stringify({
      version: SESSION_SCHEMA_VERSION,
      id: "m",
      title: "t",
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      events: [
        { type: "assistant_text", id: "a", turnId: "t1", at: 1, text: "hello" },
        { type: "something_new", id: "b", turnId: "t1", at: 1 },
      ],
    });
    const loaded = readSession(mixed);
    assert.equal(loaded?.session.events.length, 1);
  });
});

describe("migration reads only what is there", () => {
  test("a turn boundary is a user message", () => {
    const events = migrateFromMessages(
      [
        { role: "user", content: "첫 질문" },
        { role: "assistant", content: "첫 답" },
        { role: "user", content: "둘째 질문" },
        { role: "assistant", content: "둘째 답" },
      ],
      0,
    );
    assert.equal(new Set(events.map((e) => e.turnId)).size, 2);
  });

  test("array content is flattened to its text", () => {
    const events = migrateFromMessages(
      [{ role: "user", content: [{ type: "image", url: "x" }, { type: "text", text: "이 그림 설명해줘" }] }],
      0,
    );
    assert.equal(events.length, 1);
    assert.ok(events[0]?.type === "user_message");
    assert.equal(events[0].text, "이 그림 설명해줘");
  });

  test("an empty history migrates to nothing rather than to a blank turn", () => {
    assert.deepEqual(migrateFromMessages([], 0), []);
  });
});
