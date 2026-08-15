import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  emptyContract,
  mergeContract,
  parseTurnContract,
  reduceContract,
  type TurnContract,
} from "../agent/turnContract.ts";
import {
  ACTION_DENIED_BY_CONSTRAINT,
  ACTION_REQUIRES_JUSTIFICATION,
} from "../agent/actionPolicy.ts";
import { readSession, writeSession } from "../agent/sessionLog.ts";
import {
  SESSION_SCHEMA_VERSION,
  type ActionDisposition,
  type SessionEvent,
} from "../agent/sessionEvents.ts";
import { TurnRecorder, dispositionFor } from "../agent/sessionRecorder.ts";
import { restoreEvents, type ConversationTurn } from "../agent/conversationGraph.ts";
import { projectTaskProfile, type TaskProfile } from "./taskProfile.ts";
import { measure, type ModelProfile } from "./modelProfile.ts";
import {
  ROUTER_VERSION,
  previousProfileFrom,
  routeTurn,
  routingEvent,
  selectedWorkerFor,
} from "./routing.ts";
import { actionLedger, summarizeActions } from "./actionLedger.ts";

/**
 * R3.1: the three places the record was thinner than it looked.
 *
 * Each of these passed its own tests in R3 and was still wrong across a process
 * boundary, which is the only boundary that matters for a record:
 *
 *   worker affinity lived in a field, so a reload re-chose
 *   action attribution assumed a recommendation, so manual turns had none
 *   the lifecycle was recovered from a sentence, so rewording moved the metrics
 *
 * The tests below all cross that boundary — they write, read, and then ask.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function contractOf(args: Record<string, unknown>, turnId: string): TurnContract {
  const parsed = parseTurnContract(args, turnId);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.contract;
}

const COMPLEX = {
  goal: "TypeScript 오류 전체 수정",
  relation: "new_task",
  intents: "modify\nexecute\nverify",
  requirements: ["오류를 분석한다", "각 파일을 수정한다", "테스트를 실행한다", "통과할 때까지 반복한다"].join("\n"),
};

const CONTINUE = { goal: "이어서", relation: "continue", intents: "modify" };
const QUESTION = { goal: "왜 실패했나", relation: "question", intents: "discuss" };
const CORRECT_SOFT = {
  goal: "이렇게 말고 저렇게",
  relation: "correct",
  intents: "modify",
  requirements: "다르게 고친다",
};
const CORRECT_HARD = {
  goal: "실행하지 말고 코드만",
  relation: "correct",
  intents: "present",
  requirements: "코드만 보여준다",
  constraints: "no_execute: 실행하지 마",
};
const NEW_TASK = {
  goal: "새 Python API 서버",
  relation: "new_task",
  intents: "modify",
  requirements: "FastAPI 서버를 만든다",
};

function model(id: string, over: Partial<ModelProfile> = {}): ModelProfile {
  return {
    modelId: id,
    availability: {
      available: true,
      protocol: "native",
      contextWindow: 128_000,
      maxOutputTokens: 8192,
      supportsNativeTools: true,
    },
    capabilities: {},
    efficiency: {},
    semanticDescription: id,
    evidence: { evalSampleCount: 0 },
    ...over,
  };
}

const CATALOGUE = [
  model("model-a", {
    capabilities: { coding: measure(0.9, "harness_eval", 40), toolUse: measure(0.9, "harness_eval", 40) },
    evidence: { evalSampleCount: 40 },
  }),
  model("model-b", {
    capabilities: { instructionFollowing: measure(0.95, "harness_eval", 40) },
    evidence: { evalSampleCount: 40 },
  }),
];

function turnOf(id: string, parent: string | null, events: SessionEvent[]): ConversationTurn {
  return {
    id,
    parentTurnId: parent,
    state: "completed",
    createdAt: 1000,
    completedAt: 1100,
    events,
    messageDelta: [{ role: "user", content: "x" }] as never,
    restorable: true,
  };
}

/** Write to disk and read back — the boundary every test here crosses. */
function reload(turns: ConversationTurn[], head: string): SessionEvent[] {
  const file = writeSession({
    version: SESSION_SCHEMA_VERSION,
    id: "conv",
    title: "t",
    createdAt: 1,
    updatedAt: 2,
    turns,
    branches: [{ id: "main", name: "main", headTurnId: head, createdAt: 1, updatedAt: 2 }],
    checkpoints: [],
    activeBranchId: "main",
    events: [],
    messages: [],
  });
  const loaded = readSession(file);
  assert.notEqual(loaded, null);
  return loaded!.session.events;
}

/** A first turn that chose `model-a` and did some work. */
async function firstTurnEvents(): Promise<SessionEvent[]> {
  const turn = contractOf(COMPLEX, "t1");
  const decision = await routeTurn({
    turn,
    previous: emptyContract(),
    currentWorker: null,
    profiles: CATALOGUE,
  });
  assert.equal(decision.modelId, "model-a");
  return [
    { type: "user_message", id: "e1", turnId: "t1", at: 1, text: "고쳐줘" },
    { type: "turn_contract", id: "e2", turnId: "t1", at: 2, contract: turn },
    routingEvent({ id: "e3", turnId: "t1", at: 3, decision, bootstrapModelId: "boot", bootstrapModelCalls: 1 }),
    { type: "tool_started", id: "e4", turnId: "t1", at: 4, callId: "a1", toolName: "read_file", risk: "read", summary: "s" },
    {
      type: "tool_completed",
      id: "e5",
      turnId: "t1",
      at: 5,
      callId: "a1",
      toolName: "read_file",
      status: "success",
      disposition: "executed_success",
      detail: "ok",
    },
  ];
}

// ---------------------------------------------------------------------------
// Gap 1 — reload affinity (§3, §6, §7, §8, §9)
// ---------------------------------------------------------------------------

describe("R3.1 · a reload does not re-choose a worker for the same task", () => {
  test("the previous profile is derived from persisted events, not remembered", async () => {
    const reloaded = reload([turnOf("t1", null, await firstTurnEvents())], "t1");
    const derived = previousProfileFrom(reloaded);
    assert.notEqual(derived, undefined);
    // Identical to projecting the contract the events fold to — no field needed.
    assert.deepEqual(derived, projectTaskProfile(reduceContract(reloaded)));
  });

  test("an empty history has no previous profile, rather than a fabricated one", () => {
    assert.equal(previousProfileFrom([]), undefined);
  });

  const AFFINITY: ReadonlyArray<{ name: string; args: Record<string, unknown>; keeps: boolean }> = [
    { name: "§6 continue", args: CONTINUE, keeps: true },
    { name: "§7 question", args: QUESTION, keeps: true },
    { name: "§8 correction with no new hard constraint", args: CORRECT_SOFT, keeps: true },
    { name: "§8 correction that adds one", args: CORRECT_HARD, keeps: false },
    { name: "§9 a genuinely new task", args: NEW_TASK, keeps: false },
  ];

  for (const scenario of AFFINITY) {
    test(`${scenario.name} — ${scenario.keeps ? "keeps" : "re-chooses"} the worker after a reload`, async () => {
      const reloaded = reload([turnOf("t1", null, await firstTurnEvents())], "t1");
      const decision = await routeTurn({
        turn: contractOf(scenario.args, "t2"),
        previous: reduceContract(reloaded),
        currentWorker: selectedWorkerFor(reloaded)!.modelId,
        currentWorkerRestored: true,
        previousProfile: previousProfileFrom(reloaded),
        profiles: CATALOGUE,
      });
      if (scenario.keeps) {
        assert.equal(decision.modelId, "model-a");
        assert.equal(decision.recommendation, undefined, "no recommendation should have been run");
      } else {
        assert.notEqual(decision.recommendation, undefined, "a recommendation should have been run");
      }
    });

    test(`${scenario.name} — the trigger says why`, async () => {
      const reloaded = reload([turnOf("t1", null, await firstTurnEvents())], "t1");
      const decision = await routeTurn({
        turn: contractOf(scenario.args, "t2"),
        previous: reduceContract(reloaded),
        currentWorker: selectedWorkerFor(reloaded)!.modelId,
        currentWorkerRestored: true,
        previousProfile: previousProfileFrom(reloaded),
        profiles: CATALOGUE,
      });
      assert.equal(decision.trigger === "carried", scenario.keeps);
    });
  }

  test("§6 — a restored carry is named `restored`, not `carried`", async () => {
    const reloaded = reload([turnOf("t1", null, await firstTurnEvents())], "t1");
    const decision = await routeTurn({
      turn: contractOf(CONTINUE, "t2"),
      previous: reduceContract(reloaded),
      currentWorker: "model-a",
      currentWorkerRestored: true,
      previousProfile: previousProfileFrom(reloaded),
      profiles: CATALOGUE,
    });
    assert.equal(decision.origin, "restored");
  });

  test("a carry inside a live session is still `carried`", async () => {
    const reloaded = reload([turnOf("t1", null, await firstTurnEvents())], "t1");
    const decision = await routeTurn({
      turn: contractOf(CONTINUE, "t2"),
      previous: reduceContract(reloaded),
      currentWorker: "model-a",
      previousProfile: previousProfileFrom(reloaded),
      profiles: CATALOGUE,
    });
    assert.equal(decision.origin, "carried");
  });

  test("§9 — reload does not forbid recommending, it only preserves affinity", async () => {
    const reloaded = reload([turnOf("t1", null, await firstTurnEvents())], "t1");
    const decision = await routeTurn({
      turn: contractOf(NEW_TASK, "t2"),
      previous: reduceContract(reloaded),
      currentWorker: "model-a",
      currentWorkerRestored: true,
      previousProfile: previousProfileFrom(reloaded),
      profiles: CATALOGUE,
    });
    assert.equal(decision.trigger, "new_task");
    assert.notEqual(decision.recommendation, undefined);
  });

  test("§4/§28 — a changed registry does not rewrite the stored selection", async () => {
    const reloaded = reload([turnOf("t1", null, await firstTurnEvents())], "t1");
    // model-b is now far better at everything the task wants.
    const changed = [
      model("model-a", { capabilities: { coding: measure(0.1, "harness_eval", 99) } }),
      model("model-b", {
        capabilities: { coding: measure(0.99, "harness_eval", 99), toolUse: measure(0.99, "harness_eval", 99) },
        evidence: { evalSampleCount: 99 },
      }),
    ];
    // The history says what it said.
    assert.equal(selectedWorkerFor(reloaded)!.modelId, "model-a");
    // And a continuation still runs on it, because affinity is not a ranking.
    const decision = await routeTurn({
      turn: contractOf(CONTINUE, "t2"),
      previous: reduceContract(reloaded),
      currentWorker: selectedWorkerFor(reloaded)!.modelId,
      currentWorkerRestored: true,
      previousProfile: previousProfileFrom(reloaded),
      profiles: changed,
    });
    assert.equal(decision.modelId, "model-a");
    assert.equal(selectedWorkerFor(reloaded)!.modelId, "model-a");
  });

  test("§4 — but a new task does use the current registry", async () => {
    const reloaded = reload([turnOf("t1", null, await firstTurnEvents())], "t1");
    const changed = [
      model("model-a", { capabilities: { coding: measure(0.1, "harness_eval", 99) } }),
      model("model-b", {
        capabilities: { coding: measure(0.99, "harness_eval", 99), toolUse: measure(0.99, "harness_eval", 99) },
        evidence: { evalSampleCount: 99 },
      }),
    ];
    const decision = await routeTurn({
      turn: contractOf(NEW_TASK, "t2"),
      previous: reduceContract(reloaded),
      currentWorker: "model-a",
      currentWorkerRestored: true,
      previousProfile: previousProfileFrom(reloaded),
      profiles: changed,
    });
    assert.equal(decision.modelId, "model-b");
  });
});

// ---------------------------------------------------------------------------
// Gap 2 — manual attribution (§10, §11, §13, §14)
// ---------------------------------------------------------------------------

describe("R3.1 · a manually chosen worker owns its actions too", () => {
  const manualEvents: SessionEvent[] = [
    { type: "user_message", id: "e1", turnId: "t1", at: 1, text: "이걸로 해줘" },
    {
      type: "worker_selected",
      id: "e2",
      turnId: "t1",
      at: 2,
      selectionOrigin: "user_manual",
      selectedModelId: "hand-picked",
      routerVersion: ROUTER_VERSION,
    },
    { type: "tool_started", id: "e3", turnId: "t1", at: 3, callId: "m1", toolName: "run_command", risk: "execute", summary: "s" },
    {
      type: "tool_completed",
      id: "e4",
      turnId: "t1",
      at: 4,
      callId: "m1",
      toolName: "run_command",
      status: "success",
      disposition: "executed_success",
      detail: "exit 0",
    },
  ];

  test("§13 — the action is attributed to the manual model", () => {
    const record = actionLedger(manualEvents)[0]!;
    assert.equal(record.modelId, "hand-picked");
    assert.equal(record.executed, true);
  });

  test("§13 — and the record says a person chose it", () => {
    assert.equal(selectedWorkerFor(manualEvents)?.origin, "user_manual");
  });

  test("§14 — attribution survives a reload", () => {
    const reloaded = reload([turnOf("t1", null, manualEvents)], "t1");
    assert.equal(actionLedger(reloaded)[0]!.modelId, "hand-picked");
    assert.equal(selectedWorkerFor(reloaded)?.origin, "user_manual");
  });

  test("§11 — attribution does not care which origin chose the worker", () => {
    const origins = ["auto_recommendation", "user_manual", "carried", "restored"] as const;
    for (const origin of origins) {
      const events: SessionEvent[] = [
        {
          type: "worker_selected",
          id: "e1",
          turnId: "t1",
          at: 1,
          selectionOrigin: origin,
          selectedModelId: `via-${origin}`,
          routerVersion: ROUTER_VERSION,
        },
        { type: "tool_started", id: "e2", turnId: "t1", at: 2, callId: "c", toolName: "read_file", risk: "read", summary: "s" },
        {
          type: "tool_completed",
          id: "e3",
          turnId: "t1",
          at: 3,
          callId: "c",
          toolName: "read_file",
          status: "success",
          disposition: "executed_success",
          detail: "ok",
        },
      ];
      assert.equal(actionLedger(events)[0]!.modelId, `via-${origin}`);
    }
  });

  test("§12 — there is exactly one place a worker id is written", () => {
    // Not on the action events, not in session metadata. If this stops being
    // true, two records of the same fact can disagree.
    for (const event of manualEvents) {
      if (event.type === "tool_started" || event.type === "tool_completed") {
        assert.ok(!("modelId" in event), "a tool event must not carry its own worker id");
      }
    }
  });

  test("§10C — a manual worker's actions do not leak across a branch", () => {
    const forkEvents: SessionEvent[] = [
      {
        type: "worker_selected",
        id: "f1",
        turnId: "t2",
        at: 5,
        selectionOrigin: "user_manual",
        selectedModelId: "other-hand-picked",
        routerVersion: ROUTER_VERSION,
      },
      { type: "tool_started", id: "f2", turnId: "t2", at: 6, callId: "m2", toolName: "read_file", risk: "read", summary: "s" },
      {
        type: "tool_completed",
        id: "f3",
        turnId: "t2",
        at: 7,
        callId: "m2",
        toolName: "read_file",
        status: "success",
        disposition: "executed_success",
        detail: "ok",
      },
    ];
    const turns = [turnOf("t1", null, manualEvents), turnOf("t2", "t1", forkEvents)];
    const main = actionLedger(restoreEvents(turns, "t1"));
    assert.deepEqual(main.map((a) => a.modelId), ["hand-picked"]);
    const fork = actionLedger(restoreEvents(turns, "t2"));
    assert.deepEqual(fork.map((a) => a.modelId), ["hand-picked", "other-hand-picked"]);
  });

  test("a manual selection is never reported as a recommendation", async () => {
    const decision = await routeTurn({
      turn: contractOf(COMPLEX, "t1"),
      previous: emptyContract(),
      currentWorker: null,
      profiles: CATALOGUE,
      userRequestedModel: "hand-picked",
    });
    assert.equal(decision.origin, "user_manual");
    assert.equal(decision.recommendation, undefined);
    const event = routingEvent({ id: "e", turnId: "t1", at: 1, decision });
    assert.equal(event.selectionOrigin, "user_manual");
    assert.equal(event.scoreBreakdown, undefined);
  });
});

// ---------------------------------------------------------------------------
// Gap 3 — structured lifecycle (§15–§24)
// ---------------------------------------------------------------------------

describe("R3.1 · the outcome is a field, not a sentence", () => {
  const completed = (
    disposition: ActionDisposition,
    status: "success" | "failed" | "denied" | "blocked" | "cancelled",
    detail: string,
    callId = "c1",
    id = "e2",
  ): SessionEvent => ({
    type: "tool_completed",
    id,
    turnId: "t1",
    at: 2,
    callId,
    toolName: "run_command",
    status,
    disposition,
    detail,
  });

  const CASES: ReadonlyArray<{
    name: string;
    disposition: ActionDisposition;
    status: "success" | "failed" | "denied" | "blocked" | "cancelled";
    state: string;
    executed: boolean;
  }> = [
    { name: "§20 deferred", disposition: "deferred", status: "failed", state: "deferred", executed: false },
    { name: "§21 denied", disposition: "denied", status: "failed", state: "denied", executed: false },
    { name: "§22 ran and failed", disposition: "executed_failure", status: "failed", state: "failed", executed: true },
    { name: "§23 ran and succeeded", disposition: "executed_success", status: "success", state: "succeeded", executed: true },
    { name: "cancelled", disposition: "cancelled", status: "cancelled", state: "pending", executed: false },
  ];

  for (const scenario of CASES) {
    test(`${scenario.name} — state is ${scenario.state}, executed is ${scenario.executed}`, () => {
      const record = actionLedger([completed(scenario.disposition, scenario.status, "무슨 일이 있었다")])[0]!;
      assert.equal(record.state, scenario.state);
      assert.equal(record.executed, scenario.executed);
      assert.equal(record.proposed, true);
    });

    test(`${scenario.name} — the wording of detail changes nothing`, () => {
      const a = actionLedger([completed(scenario.disposition, scenario.status, "첫 번째 표현")])[0]!;
      const b = actionLedger([
        completed(scenario.disposition, scenario.status, "완전히 다르게 고쳐 쓴 문장입니다"),
      ])[0]!;
      assert.equal(a.state, b.state);
      assert.equal(a.executed, b.executed);
    });

    test(`${scenario.name} — it survives a reload`, () => {
      const events = [completed(scenario.disposition, scenario.status, "d")];
      const reloaded = reload([turnOf("t1", null, events)], "t1");
      assert.equal(actionLedger(reloaded)[0]!.state, scenario.state);
      assert.equal(actionLedger(reloaded)[0]!.executed, scenario.executed);
    });
  }

  test("§18 — deferred is not an execution failure", () => {
    const deferred = actionLedger([completed("deferred", "failed", "x")])[0]!;
    const failed = actionLedger([completed("executed_failure", "failed", "x")])[0]!;
    assert.notEqual(deferred.state, failed.state);
    assert.notEqual(deferred.executed, failed.executed);
  });

  test("§18 — denied is not an execution failure", () => {
    const denied = actionLedger([completed("denied", "failed", "x")])[0]!;
    const failed = actionLedger([completed("executed_failure", "failed", "x")])[0]!;
    assert.notEqual(denied.state, failed.state);
    assert.notEqual(denied.executed, failed.executed);
  });

  test("§18 — proposed is not executed", () => {
    for (const scenario of CASES) {
      const record = actionLedger([completed(scenario.disposition, scenario.status, "x")])[0]!;
      assert.equal(record.proposed, true);
      if (!scenario.executed) assert.equal(record.executed, false);
    }
  });

  test("§24 — every observed metric is computable without parsing prose", () => {
    const events: SessionEvent[] = [
      completed("deferred", "failed", "aaa", "c1", "e2"),
      completed("denied", "failed", "bbb", "c2", "e3"),
      completed("executed_failure", "failed", "ccc", "c3", "e4"),
      completed("executed_success", "success", "ddd", "c4", "e5"),
      completed("executed_success", "success", "eee", "c5", "e6"),
    ];
    const summary = summarizeActions(actionLedger(events));
    assert.equal(summary.proposed, 5);
    assert.equal(summary.deferred, 1);
    assert.equal(summary.denied, 1);
    assert.equal(summary.executed, 3);
    assert.equal(summary.succeeded, 2);
    assert.equal(summary.failed, 1);
  });

  test("§19 — detail is carried for a person, and is not what decided anything", () => {
    const record = actionLedger([completed("deferred", "failed", "사람이 읽을 문장")])[0]!;
    assert.equal(record.detail, "사람이 읽을 문장");
    assert.equal(record.state, "deferred");
  });

  test("the recorder sets a disposition on every completion", () => {
    const recorder = new TurnRecorder({ turnId: "t1" });
    recorder.record({ type: "tool_start", callId: "c", name: "read_file", risk: "read", summary: "s" });
    const produced = recorder.record({
      type: "tool_end",
      callId: "c",
      name: "read_file",
      ok: true,
      detail: "ok",
    });
    const completedEvent = produced.find((e) => e.type === "tool_completed");
    assert.equal(completedEvent?.type === "tool_completed" && completedEvent.disposition, "executed_success");
  });

  test("the loop's own verdict wins over the recorder's inference", () => {
    const recorder = new TurnRecorder({ turnId: "t1" });
    const produced = recorder.record({
      type: "tool_end",
      callId: "c",
      name: "run_command",
      ok: false,
      detail: "held back",
      disposition: "deferred",
    });
    const completedEvent = produced.find((e) => e.type === "tool_completed");
    // Not `executed_failure`, which is what `ok: false` alone would have said.
    assert.equal(completedEvent?.type === "tool_completed" && completedEvent.disposition, "deferred");
  });

  test("an approval denial is recorded as denied rather than as a failure", () => {
    const recorder = new TurnRecorder({ turnId: "t1" });
    recorder.record({ type: "tool_approval", callId: "c", name: "create_file", outcome: "denied" });
    const produced = recorder.record({
      type: "tool_end",
      callId: "c",
      name: "create_file",
      ok: false,
      detail: "사용자가 승인하지 않았습니다",
    });
    const completedEvent = produced.find((e) => e.type === "tool_completed");
    assert.equal(completedEvent?.type === "tool_completed" && completedEvent.disposition, "denied");
  });

  test("dispositionFor never calls a policy refusal an execution", () => {
    assert.equal(dispositionFor(false, "denied"), "denied");
    assert.equal(dispositionFor(false, "blocked"), "denied");
    assert.equal(dispositionFor(true, undefined), "executed_success");
    assert.equal(dispositionFor(false, undefined), "executed_failure");
  });
});

// ---------------------------------------------------------------------------
// Migration — old files still open and still mean the same thing
// ---------------------------------------------------------------------------

describe("R3.1 · records written before this slice still read", () => {
  test("a `model_recommended` event is read as `worker_selected`", () => {
    const raw = JSON.stringify({
      version: SESSION_SCHEMA_VERSION,
      id: "conv",
      title: "t",
      createdAt: 1,
      updatedAt: 2,
      activeBranchId: "main",
      branches: [{ id: "main", name: "main", headTurnId: "t1", createdAt: 1, updatedAt: 2 }],
      checkpoints: [],
      turns: [
        {
          id: "t1",
          parentTurnId: null,
          state: "completed",
          createdAt: 1,
          completedAt: 2,
          messageDelta: [{ role: "user", content: "x" }],
          events: [
            {
              type: "model_recommended",
              id: "e1",
              turnId: "t1",
              at: 1,
              selectionOrigin: "recommendation",
              selectedModelId: "old-worker",
              routerVersion: "r3.1",
            },
          ],
        },
      ],
    });
    const loaded = readSession(raw);
    assert.notEqual(loaded, null);
    const event = loaded!.session.events[0]!;
    assert.equal(event.type, "worker_selected");
    assert.equal(selectedWorkerFor(loaded!.session.events)?.modelId, "old-worker");
  });

  test("its origin is renamed too, so the record still reads as one thing", () => {
    const raw = JSON.stringify({
      version: SESSION_SCHEMA_VERSION,
      id: "conv",
      createdAt: 1,
      activeBranchId: "main",
      branches: [{ id: "main", name: "main", headTurnId: "t1" }],
      turns: [
        {
          id: "t1",
          parentTurnId: null,
          state: "completed",
          messageDelta: [{ role: "user", content: "x" }],
          events: [
            { type: "model_recommended", id: "e1", turnId: "t1", at: 1, selectionOrigin: "user", selectedModelId: "m", routerVersion: "r3.1" },
          ],
        },
      ],
    });
    const loaded = readSession(raw);
    assert.equal(selectedWorkerFor(loaded!.session.events)?.origin, "user_manual");
  });

  test("a completion with no disposition still classifies from what it has", () => {
    const legacyDeferred: SessionEvent = {
      type: "tool_completed",
      id: "e1",
      turnId: "t1",
      at: 1,
      callId: "c1",
      toolName: "run_command",
      status: "failed",
      detail: `${ACTION_REQUIRES_JUSTIFICATION}: 보류했습니다`,
    };
    const record = actionLedger([legacyDeferred])[0]!;
    assert.equal(record.state, "deferred");
    assert.equal(record.executed, false);
  });

  test("a legacy denial is still a denial", () => {
    const legacy: SessionEvent = {
      type: "tool_completed",
      id: "e1",
      turnId: "t1",
      at: 1,
      callId: "c1",
      toolName: "run_command",
      status: "failed",
      detail: `${ACTION_DENIED_BY_CONSTRAINT}: 금지했습니다`,
    };
    assert.equal(actionLedger([legacy])[0]!.state, "denied");
  });

  test("a legacy ordinary failure is an execution failure", () => {
    const legacy: SessionEvent = {
      type: "tool_completed",
      id: "e1",
      turnId: "t1",
      at: 1,
      callId: "c1",
      toolName: "run_command",
      status: "failed",
      detail: "exit 1",
    };
    const record = actionLedger([legacy])[0]!;
    assert.equal(record.state, "failed");
    assert.equal(record.executed, true);
  });
});

// ---------------------------------------------------------------------------
// Teeth — §29–§34
// ---------------------------------------------------------------------------

describe("R3.1 · teeth", () => {
  test("A — re-recommending on a reloaded continuation would change the answer", async () => {
    const reloaded = reload([turnOf("t1", null, await firstTurnEvents())], "t1");
    const withProfile = await routeTurn({
      turn: contractOf(CONTINUE, "t2"),
      previous: reduceContract(reloaded),
      currentWorker: "model-a",
      previousProfile: previousProfileFrom(reloaded),
      profiles: CATALOGUE,
    });
    // Without the derived profile — the R3 behaviour — it re-recommends.
    const withoutProfile = await routeTurn({
      turn: contractOf(CONTINUE, "t2"),
      previous: reduceContract(reloaded),
      currentWorker: "model-a",
      profiles: CATALOGUE,
    });
    assert.equal(withProfile.recommendation, undefined);
    assert.notEqual(withoutProfile.recommendation, undefined);
  });

  test("B — attribution that required a recommendation would lose manual turns", () => {
    const events: SessionEvent[] = [
      {
        type: "worker_selected",
        id: "e1",
        turnId: "t1",
        at: 1,
        selectionOrigin: "user_manual",
        selectedModelId: "hand-picked",
        routerVersion: ROUTER_VERSION,
      },
      { type: "tool_started", id: "e2", turnId: "t1", at: 2, callId: "c", toolName: "read_file", risk: "read", summary: "s" },
      { type: "tool_completed", id: "e3", turnId: "t1", at: 3, callId: "c", toolName: "read_file", status: "success", disposition: "executed_success", detail: "ok" },
    ];
    assert.equal(actionLedger(events)[0]!.modelId, "hand-picked");
    // The same events without the selection record: attribution is honestly
    // unknown rather than wrong.
    assert.equal(actionLedger(events.slice(1))[0]!.modelId, null);
  });

  test("C — counting deferrals as execution failures would move every metric", () => {
    const events: SessionEvent[] = [
      {
        type: "tool_completed",
        id: "e1",
        turnId: "t1",
        at: 1,
        callId: "c1",
        toolName: "run_command",
        status: "failed",
        disposition: "deferred",
        detail: "x",
      },
    ];
    const summary = summarizeActions(actionLedger(events));
    assert.equal(summary.deferred, 1);
    assert.equal(summary.failed, 0);
    assert.equal(summary.executed, 0);
  });

  test("D — a detail-parsing ledger would misread a reworded deferral", () => {
    // The disposition says deferred; the detail says nothing recognisable.
    // A parser would call this an execution failure. The field does not.
    const events: SessionEvent[] = [
      {
        type: "tool_completed",
        id: "e1",
        turnId: "t1",
        at: 1,
        callId: "c1",
        toolName: "run_command",
        status: "failed",
        disposition: "deferred",
        detail: "이 명령은 이번 요청이 부탁한 일이 아니라서 실행을 미뤘습니다.",
      },
    ];
    assert.equal(actionLedger(events)[0]!.state, "deferred");
    assert.equal(actionLedger(events)[0]!.executed, false);
  });

  test("E — recomputing history against the current registry would change it", async () => {
    const events = await firstTurnEvents();
    const stored = selectedWorkerFor(events)!.modelId;
    const recomputed = await routeTurn({
      turn: contractOf(COMPLEX, "t1"),
      previous: emptyContract(),
      currentWorker: null,
      profiles: [model("model-b", { capabilities: { coding: measure(1, "harness_eval", 99) } })],
    });
    assert.equal(stored, "model-a");
    assert.equal(recomputed.modelId, "model-b");
    assert.equal(selectedWorkerFor(events)!.modelId, "model-a");
  });

  test("F — a sibling branch's worker never reaches this one", async () => {
    const main = await firstTurnEvents();
    const fork: SessionEvent[] = [
      {
        type: "worker_selected",
        id: "f1",
        turnId: "t2",
        at: 9,
        selectionOrigin: "auto_recommendation",
        selectedModelId: "model-b",
        routerVersion: ROUTER_VERSION,
      },
    ];
    const turns = [turnOf("t1", null, main), turnOf("t2", "t1", fork)];
    assert.equal(selectedWorkerFor(restoreEvents(turns, "t1"))!.modelId, "model-a");
    assert.equal(selectedWorkerFor(restoreEvents(turns, "t2"))!.modelId, "model-b");
  });
});

// ---------------------------------------------------------------------------
// Bootstrap cost (§25, §26)
// ---------------------------------------------------------------------------

describe("R3.1 · interpretation is not charged to the worker", () => {
  test("§25 — the bootstrap's calls are recorded separately", async () => {
    const events = await firstTurnEvents();
    const selection = events.find((e) => e.type === "worker_selected");
    assert.ok(selection?.type === "worker_selected");
    if (selection?.type !== "worker_selected") return;
    assert.equal(selection.bootstrapModelId, "boot");
    assert.equal(selection.bootstrapModelCalls, 1);
    assert.notEqual(selection.selectedModelId, selection.bootstrapModelId);
  });

  test("§25 — and survive a reload", async () => {
    const reloaded = reload([turnOf("t1", null, await firstTurnEvents())], "t1");
    const selection = reloaded.find((e) => e.type === "worker_selected");
    assert.ok(selection?.type === "worker_selected");
    if (selection?.type !== "worker_selected") return;
    assert.equal(selection.bootstrapModelCalls, 1);
  });

  test("§26 — the bootstrap proposes no actions, so the ledger has none of its own", async () => {
    const events = await firstTurnEvents();
    const ledger = actionLedger(events);
    for (const record of ledger) {
      assert.notEqual(record.modelId, "boot", "the interpreter must not own any action");
    }
  });
});
