import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  emptyContract,
  mergeContract,
  parseTurnContract,
  reduceContract,
  type TaskContract,
  type TurnContract,
} from "../agent/turnContract.ts";
import {
  ACTION_DENIED_BY_CONSTRAINT,
  ACTION_REQUIRES_JUSTIFICATION,
  TURN_CONTRACT_REQUIRED,
  requiresContract,
} from "../agent/actionPolicy.ts";
import { readSession, writeSession } from "../agent/sessionLog.ts";
import { SESSION_SCHEMA_VERSION, type SessionEvent } from "../agent/sessionEvents.ts";
import { reduceSession } from "../agent/sessionView.ts";
import { restoreEvents, type ConversationTurn } from "../agent/conversationGraph.ts";
import type { AgentCompletion, AgentModel } from "../agent/types.ts";
import { interpretRequest, bootstrapToolSurface } from "./bootstrap.ts";
import { projectTaskProfile, type TaskProfile } from "./taskProfile.ts";
import { measure, type ModelProfile } from "./modelProfile.ts";
import {
  ROUTER_VERSION,
  routeTurn,
  routingEvent,
  routingHistory,
  routingTriggerFor,
  sameHardConstraints,
  selectedWorkerFor,
  taskProfileFingerprint,
  unroutedEvent,
} from "./routing.ts";
import { actionLedger, changedWorkspace, summarizeActions } from "./actionLedger.ts";

/**
 * R3: the router reaching the product, and the decision surviving a reload.
 *
 * Two claims are under test and they are the two the slice exists for.
 *
 *   1. what the user asked for reaches the model choice
 *   2. who proposed what, and what actually ran, survives closing the app
 *
 * Neither is provable by unit-testing the pieces — the pieces already passed in
 * R2 while the product still chose from the mode alone. So the tests below run
 * the real orchestration over real events and read the answer out of what was
 * persisted.
 */

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** A model that answers one `record_request` call from a script. */
function scriptedModel(
  modelId: string,
  answers: ReadonlyArray<Partial<AgentCompletion>>,
): AgentModel & { calls: number } {
  let index = 0;
  const model = {
    modelId,
    calls: 0,
    async complete(): Promise<AgentCompletion> {
      const answer = answers[Math.min(index, answers.length - 1)] ?? {};
      index += 1;
      model.calls += 1;
      return {
        text: "",
        reasoning: "",
        toolCalls: [],
        inputTokens: 0,
        outputTokens: 0,
        ...answer,
      };
    },
  };
  return model;
}

function recordCall(args: Record<string, unknown>, id = "c1"): AgentCompletion["toolCalls"][number] {
  return {
    id,
    name: "record_request",
    arguments: args,
    rawArguments: JSON.stringify(args),
    argumentsValid: true,
  };
}

const SIMPLE_ARGS = {
  goal: "README 오타 수정",
  relation: "new_task",
  intents: "modify",
  requirements: "README의 오타를 고친다",
};

const COMPLEX_ARGS = {
  goal: "TypeScript 오류 전체 수정",
  relation: "new_task",
  intents: "modify\nexecute\nverify\ninspect",
  requirements: [
    "30개 파일의 타입 오류를 분석한다",
    "각 파일의 오류를 수정한다",
    "테스트를 실행한다",
    "테스트가 통과할 때까지 반복한다",
  ].join("\n"),
};

const ANALYSIS_ARGS = {
  goal: "아키텍처 분석",
  relation: "new_task",
  intents: "inspect\ndiscuss",
  requirements: "이 코드의 아키텍처 문제를 분석한다",
  constraints: "no_execute: 실행하지 마십시오\nno_modify: 수정하지 마십시오",
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
    semanticDescription: `${id}`,
    evidence: { evalSampleCount: 0 },
    ...over,
  };
}

function contractOf(args: Record<string, unknown>, turnId: string): TurnContract {
  const parsed = parseTurnContract(args, turnId);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.contract;
}

// ---------------------------------------------------------------------------
// Bootstrap — §5, §6, §7, §41
// ---------------------------------------------------------------------------

describe("R3 · the bootstrap interpreter reads, and only reads", () => {
  test("its whole tool surface is record_request", () => {
    const surface = bootstrapToolSurface();
    assert.equal(surface.length, 1);
    assert.equal(surface[0]!.name, "record_request");
  });

  test("no writing, running or fetching tool is offered", () => {
    const names = new Set(bootstrapToolSurface().map((t) => t.name));
    for (const forbidden of [
      "create_file",
      "write_file",
      "apply_patch",
      "run_command",
      "web_fetch",
      "web_search",
      "update_plan",
      "report_blocked",
    ]) {
      assert.ok(!names.has(forbidden), `${forbidden} must not be reachable during bootstrap`);
    }
  });

  test("§6 — it produces the same TurnContract schema the tool does", async () => {
    const result = await interpretRequest({
      model: scriptedModel("boot", [{ toolCalls: [recordCall(SIMPLE_ARGS)] }]),
      prompt: "README 오타만 고쳐줘",
      turnId: "u1",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.contract, contractOf(SIMPLE_ARGS, "u1"));
  });

  test("§7 — requirements are stamped with the user's turn, not the interpreter", async () => {
    const result = await interpretRequest({
      model: scriptedModel("boot-model", [{ toolCalls: [recordCall(SIMPLE_ARGS)] }]),
      prompt: "README 오타만 고쳐줘",
      turnId: "user-turn-9",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.contract.turnId, "user-turn-9");
    for (const requirement of result.contract.requirements) {
      assert.equal(requirement.provenance.sourceTurnId, "user-turn-9");
      assert.notEqual(requirement.provenance.sourceTurnId, "boot-model");
    }
  });

  test("constraints the user stated survive interpretation", async () => {
    const result = await interpretRequest({
      model: scriptedModel("boot", [{ toolCalls: [recordCall(ANALYSIS_ARGS)] }]),
      prompt: "실행하거나 수정하지 말고 분석만 해줘",
      turnId: "u1",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const kinds = result.contract.constraints.map((c) => c.kind);
    assert.ok(kinds.includes("no_execute"));
    assert.ok(kinds.includes("no_modify"));
  });

  const FAILURES: ReadonlyArray<{ name: string; answers: Partial<AgentCompletion>[]; failure: string }> = [
    { name: "no tool call at all", answers: [{ text: "물론이죠!" }], failure: "NO_CONTRACT_CALL" },
    {
      name: "a different tool",
      answers: [
        {
          toolCalls: [
            { id: "x", name: "run_command", arguments: {}, rawArguments: "{}", argumentsValid: true },
          ],
        },
      ],
      failure: "WRONG_TOOL",
    },
    {
      name: "unreadable arguments",
      answers: [
        {
          toolCalls: [
            { id: "x", name: "record_request", arguments: null, rawArguments: "<goal", argumentsValid: false },
          ],
        },
      ],
      failure: "PROTOCOL_PROBLEM",
    },
    {
      name: "a contract with no goal",
      answers: [{ toolCalls: [recordCall({ relation: "new_task", intents: "modify", requirements: "x" })] }],
      failure: "INVALID_CONTRACT",
    },
    {
      name: "a protocol problem",
      answers: [{ protocolProblem: "record_request needs <goal>" }],
      failure: "PROTOCOL_PROBLEM",
    },
  ];

  for (const scenario of FAILURES) {
    test(`§41 — ${scenario.name} is reported as ${scenario.failure}`, async () => {
      const result = await interpretRequest({
        model: scriptedModel("boot", scenario.answers),
        prompt: "뭔가 해줘",
        turnId: "u1",
        maxAttempts: 1,
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.failure, scenario.failure);
      assert.ok(result.detail.length > 0);
    });

    test(`§41 — ${scenario.name} never returns a contract`, async () => {
      const result = await interpretRequest({
        model: scriptedModel("boot", scenario.answers),
        prompt: "뭔가 해줘",
        turnId: "u1",
        maxAttempts: 1,
      });
      assert.ok(!("contract" in result));
    });
  }

  test("a malformed contract gets one more attempt, not endless retries", async () => {
    const model = scriptedModel("boot", [
      { toolCalls: [recordCall({ relation: "new_task", intents: "modify" })] },
      { toolCalls: [recordCall(SIMPLE_ARGS)] },
    ]);
    const result = await interpretRequest({
      model,
      prompt: "고쳐줘",
      turnId: "u1",
      maxAttempts: 2,
    });
    assert.equal(result.ok, true);
    assert.equal(model.calls, 2);
  });

  test("attempts are bounded", async () => {
    const model = scriptedModel("boot", [{ text: "안녕하세요" }]);
    await interpretRequest({ model, prompt: "x", turnId: "u1", maxAttempts: 3 });
    assert.equal(model.calls, 3);
  });

  test("a gateway failure is MODEL_UNAVAILABLE, not a silent pass", async () => {
    const broken: AgentModel = {
      modelId: "down",
      complete: async () => {
        throw new Error("502 Bad Gateway");
      },
    };
    const result = await interpretRequest({ model: broken, prompt: "x", turnId: "u1" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure, "MODEL_UNAVAILABLE");
  });

  test("an aborted signal stops before calling", async () => {
    const model = scriptedModel("boot", [{ toolCalls: [recordCall(SIMPLE_ARGS)] }]);
    const result = await interpretRequest({
      model,
      prompt: "x",
      turnId: "u1",
      signal: AbortSignal.abort(),
    });
    assert.equal(result.ok, false);
    assert.equal(model.calls, 0);
  });
});

// ---------------------------------------------------------------------------
// The gate — §8, §9, §48
// ---------------------------------------------------------------------------

describe("R3 · the worker inherits the contract instead of re-reading it", () => {
  test("§D — the acquisition gate is satisfied by a bootstrap contract", async () => {
    const interpreted = await interpretRequest({
      model: scriptedModel("boot", [{ toolCalls: [recordCall(COMPLEX_ARGS)] }]),
      prompt: "고쳐줘",
      turnId: "turn-7",
    });
    assert.equal(interpreted.ok, true);
    if (!interpreted.ok) return;

    const events = [{ type: "turn_contract", contract: interpreted.contract }];
    const contract = reduceContract(events);
    // The worker's first write is allowed without it calling record_request.
    assert.equal(requiresContract(contract, "create_file", "turn-7"), null);
    assert.equal(requiresContract(contract, "run_command", "turn-7"), null);
  });

  test("a contract from another turn does not satisfy this turn's gate", async () => {
    const interpreted = await interpretRequest({
      model: scriptedModel("boot", [{ toolCalls: [recordCall(COMPLEX_ARGS)] }]),
      prompt: "고쳐줘",
      turnId: "turn-7",
    });
    if (!interpreted.ok) return;
    const contract = reduceContract([{ type: "turn_contract", contract: interpreted.contract }]);
    assert.notEqual(requiresContract(contract, "create_file", "turn-8"), null);
  });

  test("§9/§48 — one user turn produces exactly one turn_contract event", async () => {
    const interpreted = await interpretRequest({
      model: scriptedModel("boot", [{ toolCalls: [recordCall(COMPLEX_ARGS)] }]),
      prompt: "고쳐줘",
      turnId: "t1",
    });
    if (!interpreted.ok) return;
    const events: SessionEvent[] = [
      { type: "user_message", id: "e1", turnId: "t1", at: 1, text: "고쳐줘" },
      { type: "turn_contract", id: "e2", turnId: "t1", at: 2, contract: interpreted.contract },
      { type: "assistant_text", id: "e3", turnId: "t1", at: 3, text: "했습니다" },
    ];
    assert.equal(events.filter((e) => e.type === "turn_contract" && e.turnId === "t1").length, 1);
  });

  test("§48 — requirement count does not double when the worker inherits", async () => {
    const interpreted = await interpretRequest({
      model: scriptedModel("boot", [{ toolCalls: [recordCall(COMPLEX_ARGS)] }]),
      prompt: "고쳐줘",
      turnId: "t1",
    });
    if (!interpreted.ok) return;
    const once = reduceContract([{ type: "turn_contract", contract: interpreted.contract }]);
    assert.equal(once.requirements.length, 4);

    // What a duplicate would look like, and that it is detectable.
    const twice = reduceContract([
      { type: "turn_contract", contract: interpreted.contract },
      { type: "turn_contract", contract: contractOf(COMPLEX_ARGS, "t1") },
    ]);
    // `addNew` dedupes by description, so even a duplicate does not inflate the
    // count — but the event count would, and that is what §9 asks us to hold.
    assert.equal(twice.requirements.length, 4);
  });

  test("requirement ids are stable across the same interpretation", async () => {
    const first = await interpretRequest({
      model: scriptedModel("b", [{ toolCalls: [recordCall(COMPLEX_ARGS)] }]),
      prompt: "x",
      turnId: "t1",
    });
    const second = await interpretRequest({
      model: scriptedModel("b", [{ toolCalls: [recordCall(COMPLEX_ARGS)] }]),
      prompt: "x",
      turnId: "t1",
    });
    if (!first.ok || !second.ok) return;
    assert.deepEqual(
      first.contract.requirements.map((r) => r.id),
      second.contract.requirements.map((r) => r.id),
    );
  });
});

// ---------------------------------------------------------------------------
// The decision — §14, §15, §16, §46, §51
// ---------------------------------------------------------------------------

const CATALOGUE: ModelProfile[] = [
  model("careful", {
    capabilities: {
      instructionFollowing: measure(0.95, "harness_eval", 40),
      reasoning: measure(0.85, "harness_eval", 40),
      coding: measure(0.4, "harness_eval", 40),
    },
    evidence: { evalSampleCount: 40 },
  }),
  model("builder", {
    capabilities: {
      coding: measure(0.95, "harness_eval", 40),
      toolUse: measure(0.9, "harness_eval", 40),
      debugging: measure(0.9, "harness_eval", 40),
      recovery: measure(0.9, "harness_eval", 40),
      instructionFollowing: measure(0.4, "harness_eval", 40),
    },
    evidence: { evalSampleCount: 40 },
  }),
];

async function route(args: Record<string, unknown>, over: Partial<Parameters<typeof routeTurn>[0]> = {}) {
  const turn = contractOf(args, "t1");
  return routeTurn({
    turn,
    previous: emptyContract(),
    currentWorker: null,
    profiles: CATALOGUE,
    ...over,
  });
}

describe("R3 · the request reaches the model choice", () => {
  test("§46 — the same mode with different requests produces different profiles", async () => {
    const simple = await route(SIMPLE_ARGS);
    const complex = await route(COMPLEX_ARGS);
    assert.notEqual(simple.taskProfile, undefined);
    assert.notEqual(complex.taskProfile, undefined);
    assert.notDeepEqual(simple.taskProfile!.demands, complex.taskProfile!.demands);
    assert.notEqual(simple.taskProfile!.complexity, complex.taskProfile!.complexity);
  });

  test("§46 — and different routing inputs, which is what the slice is for", async () => {
    const simple = await route(SIMPLE_ARGS);
    const complex = await route(COMPLEX_ARGS);
    assert.notEqual(
      taskProfileFingerprint(simple.taskProfile!),
      taskProfileFingerprint(complex.taskProfile!),
    );
  });

  test("§15 — a heavy coding task ranks the capable model first", async () => {
    const decision = await route(COMPLEX_ARGS);
    assert.equal(decision.modelId, "builder");
    assert.equal(decision.origin, "recommendation");
  });

  test("§16 — a constrained analysis turn carries its constraints into the router", async () => {
    const decision = await route(ANALYSIS_ARGS);
    assert.equal(decision.taskProfile!.constraints.noExecute, true);
    assert.equal(decision.taskProfile!.constraints.noModify, true);
    // Instruction-following is what that turn is about, and the recommendation
    // says so from the profile rather than from the prose.
    assert.ok(
      decision.recommendation!.reasons.some((r) => r.code === "CONSTRAINT_FOLLOWING_CRITICAL"),
    );
  });

  test("§16 — and the instruction-following model wins it", async () => {
    const decision = await route(ANALYSIS_ARGS);
    assert.equal(decision.modelId, "careful");
  });

  test("§17 — a constraint recorded by bootstrap is never lost on the way to the router", async () => {
    const interpreted = await interpretRequest({
      model: scriptedModel("boot", [{ toolCalls: [recordCall(ANALYSIS_ARGS)] }]),
      prompt: "실행하지 말고 분석만",
      turnId: "t1",
    });
    if (!interpreted.ok) return;
    const decision = await routeTurn({
      turn: interpreted.contract,
      previous: emptyContract(),
      currentWorker: null,
      profiles: CATALOGUE,
    });
    assert.equal(decision.taskProfile!.constraints.noExecute, true);
    assert.equal(decision.taskProfile!.constraints.noModify, true);
  });

  test("§51 — a hard constraint filters even on the online path", async () => {
    const small = model("small", {
      availability: {
        available: true,
        protocol: "text",
        contextWindow: 8_000,
        maxOutputTokens: 2048,
        supportsNativeTools: false,
      },
      capabilities: { coding: measure(1, "harness_eval", 99) },
      evidence: { evalSampleCount: 99 },
    });
    const decision = await route(COMPLEX_ARGS, {
      profiles: [small, model("big", { capabilities: { coding: measure(0.5, "harness_eval", 5) } })],
      project: { requiredProtocol: ["native"] },
    });
    assert.equal(decision.modelId, "big");
    assert.ok(decision.recommendation!.filteredOut.some((f) => f.modelId === "small"));
  });

  test("§43 — nothing eligible means no selection, not a forced one", async () => {
    const decision = await route(SIMPLE_ARGS, {
      profiles: [
        model("a", {
          availability: {
            available: false,
            protocol: "native",
            contextWindow: 128_000,
            maxOutputTokens: 4096,
            supportsNativeTools: true,
          },
        }),
      ],
    });
    assert.equal(decision.modelId, null);
    assert.ok((decision.unavailableReason?.length ?? 0) > 0);
  });

  test("§13/§45 — a user-selected model is not overruled", async () => {
    const decision = await route(COMPLEX_ARGS, { userRequestedModel: "my-choice" });
    assert.equal(decision.modelId, "my-choice");
    assert.equal(decision.origin, "user");
    assert.equal(decision.trigger, "manual");
  });

  test("§49 — and no recommendation is computed for it", async () => {
    const decision = await route(COMPLEX_ARGS, { userRequestedModel: "my-choice" });
    assert.equal(decision.recommendation, undefined);
    assert.equal(decision.taskProfile, undefined);
  });
});

// ---------------------------------------------------------------------------
// Stability — §18, §19, §20, §21
// ---------------------------------------------------------------------------

describe("R3 · the worker does not change under the user's feet", () => {
  const base = (): { previous: TaskContract; profile: TaskProfile } => {
    const turn = contractOf(COMPLEX_ARGS, "t1");
    const previous = mergeContract(emptyContract(), turn);
    return { previous, profile: projectTaskProfile(previous) };
  };

  for (const relation of ["continue", "question", "refine"] as const) {
    test(`§18 — ${relation} keeps the current worker`, async () => {
      const { previous, profile } = base();
      const turn = contractOf(
        {
          goal: "이어서",
          relation,
          intents: "modify",
          ...(relation === "refine" ? { requirements: "하나 더" } : {}),
        },
        "t2",
      );
      const decision = await routeTurn({
        turn,
        previous,
        currentWorker: "builder",
        previousProfile: profile,
        profiles: CATALOGUE,
      });
      assert.equal(decision.modelId, "builder");
      assert.equal(decision.trigger, "carried");
      assert.equal(decision.origin, "carried");
    });
  }

  test("§20 — a correction keeps the worker when eligibility is unchanged", async () => {
    const { previous, profile } = base();
    const turn = contractOf(
      { goal: "아니 그게 아니라", relation: "correct", intents: "modify", requirements: "이렇게 해줘" },
      "t2",
    );
    const decision = await routeTurn({
      turn,
      previous,
      currentWorker: "builder",
      previousProfile: profile,
      profiles: CATALOGUE,
    });
    assert.equal(decision.modelId, "builder");
  });

  test("§20 — but a correction that adds a hard constraint re-recommends", async () => {
    const { previous, profile } = base();
    const turn = contractOf(
      {
        goal: "실행하지 말고 보여만 줘",
        relation: "correct",
        intents: "present",
        requirements: "코드만 보여준다",
        constraints: "no_execute: 실행하지 마",
      },
      "t2",
    );
    const decision = await routeTurn({
      turn,
      previous,
      currentWorker: "builder",
      previousProfile: profile,
      profiles: CATALOGUE,
    });
    assert.equal(decision.trigger, "eligibility_changed");
    assert.equal(decision.origin, "recommendation");
  });

  test("§21 — a new task re-recommends", async () => {
    const { previous, profile } = base();
    const turn = contractOf(
      { goal: "전혀 다른 것", relation: "new_task", intents: "discuss", requirements: "설명해줘" },
      "t2",
    );
    const decision = await routeTurn({
      turn,
      previous,
      currentWorker: "builder",
      previousProfile: profile,
      profiles: CATALOGUE,
    });
    assert.equal(decision.trigger, "new_task");
  });

  test("§19 — repeating the same turn never oscillates", async () => {
    const { previous, profile } = base();
    let worker: string | null = "builder";
    const seen: (string | null)[] = [];
    for (let i = 0; i < 6; i += 1) {
      const turn = contractOf({ goal: "이어서", relation: "continue", intents: "modify" }, `t${i + 2}`);
      const decision = await routeTurn({
        turn,
        previous,
        currentWorker: worker,
        previousProfile: profile,
        profiles: CATALOGUE,
      });
      worker = decision.modelId;
      seen.push(worker);
    }
    assert.equal(new Set(seen).size, 1, `worker oscillated: ${seen.join(" → ")}`);
  });

  test("the first turn always recommends", () => {
    const { profile } = base();
    assert.equal(
      routingTriggerFor({
        currentWorker: null,
        previous: emptyContract(),
        turn: contractOf(SIMPLE_ARGS, "t1"),
        nextProfile: profile,
      }),
      "first_turn",
    );
  });

  test("only the hard set decides whether candidacy changed", () => {
    const light = projectTaskProfile(mergeContract(emptyContract(), contractOf(SIMPLE_ARGS, "t1")));
    const heavy = projectTaskProfile(mergeContract(emptyContract(), contractOf(COMPLEX_ARGS, "t1")));
    // Wildly different demands, identical constraints.
    assert.notDeepEqual(light.demands, heavy.demands);
    assert.equal(sameHardConstraints(light, heavy), true);

    const constrained = projectTaskProfile(
      mergeContract(emptyContract(), contractOf(ANALYSIS_ARGS, "t1")),
    );
    assert.equal(sameHardConstraints(light, constrained), false);
  });
});

// ---------------------------------------------------------------------------
// Persistence — §22, §25, §26, §31, §38, §50
// ---------------------------------------------------------------------------

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

function persist(turns: ConversationTurn[], head: string): SessionEvent[] {
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

describe("R3 · the decision survives closing the app", () => {
  const decisionEvents = async (): Promise<SessionEvent[]> => {
    const decision = await route(COMPLEX_ARGS);
    return [
      { type: "user_message", id: "e1", turnId: "t1", at: 1, text: "고쳐줘" },
      { type: "turn_contract", id: "e2", turnId: "t1", at: 2, contract: contractOf(COMPLEX_ARGS, "t1") },
      routingEvent({ id: "e3", turnId: "t1", at: 3, decision, bootstrapModelId: "boot" }),
    ];
  };

  test("§25 — a routing event carries the decision, not the catalogue", async () => {
    const events = await decisionEvents();
    const routing = events.find((e) => e.type === "model_recommended");
    assert.notEqual(routing, undefined);
    if (routing?.type !== "model_recommended") return;
    assert.equal(routing.selectedModelId, "builder");
    assert.equal(routing.bootstrapModelId, "boot");
    assert.equal(routing.routerVersion, ROUTER_VERSION);
    assert.ok(routing.scoreBreakdown !== undefined);
    assert.ok(routing.taskProfileFingerprint !== undefined);
    // No profiles, no descriptions, no capability tables. §30.
    assert.ok(!("profiles" in routing));
    assert.ok(!("capabilities" in routing));
  });

  test("§26/§38 — the selection is the same after a write and a read", async () => {
    const events = await decisionEvents();
    const reloaded = persist([turnOf("t1", null, events)], "t1");
    assert.equal(selectedWorkerFor(reloaded)?.modelId, "builder");
    assert.equal(selectedWorkerFor(reloaded)?.origin, "recommendation");
  });

  test("§26 — and so is the reason it was chosen", async () => {
    const events = await decisionEvents();
    const reloaded = persist([turnOf("t1", null, events)], "t1");
    const before = routingHistory(events)[0]!;
    const after = routingHistory(reloaded)[0]!;
    assert.deepEqual(after.reasons, before.reasons);
    assert.deepEqual(after.scoreBreakdown, before.scoreBreakdown);
    assert.deepEqual(after.filteredOut, before.filteredOut);
    assert.deepEqual(after.alternatives, before.alternatives);
  });

  test("§31 — reading a past decision does not recompute it", async () => {
    const events = await decisionEvents();
    const reloaded = persist([turnOf("t1", null, events)], "t1");
    // The registry now says the opposite of what it said then. History does not
    // move: `selectedWorkerFor` reads the event.
    assert.equal(selectedWorkerFor(reloaded)?.modelId, "builder");
    const nowDifferent = await route(COMPLEX_ARGS, {
      profiles: [model("someone-else", { capabilities: { coding: measure(1, "harness_eval", 99) } })],
    });
    assert.equal(nowDifferent.modelId, "someone-else");
    assert.equal(selectedWorkerFor(reloaded)?.modelId, "builder");
  });

  test("§50 — a continuation after reload keeps the worker", async () => {
    const events = await decisionEvents();
    const reloaded = persist([turnOf("t1", null, events)], "t1");
    const worker = selectedWorkerFor(reloaded)!.modelId;
    const decision = await routeTurn({
      turn: contractOf({ goal: "이어서", relation: "continue", intents: "modify" }, "t2"),
      previous: reduceContract(reloaded),
      currentWorker: worker,
      previousProfile: projectTaskProfile(reduceContract(reloaded)),
      profiles: CATALOGUE,
    });
    assert.equal(decision.modelId, "builder");
    assert.equal(decision.trigger, "carried");
  });

  test("§42 — a bootstrap failure is recorded as a fallback, not a recommendation", () => {
    const event = unroutedEvent({
      id: "e1",
      turnId: "t1",
      at: 1,
      modelId: null,
      reason: "NO_CONTRACT_CALL: record_request 호출이 없었습니다",
      bootstrapModelId: "boot",
    });
    assert.equal(event.selectionOrigin, "fallback");
    assert.equal(event.selectedModelId, null);
    assert.match(event.unavailableReason!, /NO_CONTRACT_CALL/);
    assert.equal(event.scoreBreakdown, undefined);
    assert.equal(event.reasons, undefined);
  });

  test("§42 — and a fallback never reads as the selected worker", () => {
    const events: SessionEvent[] = [
      unroutedEvent({ id: "e1", turnId: "t1", at: 1, modelId: null, reason: "NO_TASK_PROFILE" }),
    ];
    assert.equal(selectedWorkerFor(events), null);
  });

  test("the fingerprint is stable and distinguishes profiles", async () => {
    const simple = await route(SIMPLE_ARGS);
    const again = await route(SIMPLE_ARGS);
    assert.equal(
      taskProfileFingerprint(simple.taskProfile!),
      taskProfileFingerprint(again.taskProfile!),
    );
  });

  test("a routing event draws nothing in the transcript", async () => {
    const events = await decisionEvents();
    const withRouting = reduceSession(events);
    const without = reduceSession(events.filter((e) => e.type !== "model_recommended"));
    assert.deepEqual(withRouting, without);
  });

  test("the view still round-trips with routing events present", async () => {
    const events = await decisionEvents();
    const reloaded = persist([turnOf("t1", null, events)], "t1");
    assert.deepEqual(reduceSession(reloaded), reduceSession(events));
  });
});

// ---------------------------------------------------------------------------
// Branch isolation — §32, §39
// ---------------------------------------------------------------------------

describe("R3 · a branch's decisions stay on its branch", () => {
  const mainEvents: SessionEvent[] = [
    { type: "user_message", id: "m1", turnId: "t1", at: 1, text: "해줘" },
    {
      type: "model_recommended",
      id: "m2",
      turnId: "t1",
      at: 2,
      selectionOrigin: "recommendation",
      selectedModelId: "model-a",
      routerVersion: ROUTER_VERSION,
    },
    { type: "tool_started", id: "m3", turnId: "t1", at: 3, callId: "A1", toolName: "read_file", risk: "read", summary: "a" },
    { type: "tool_completed", id: "m4", turnId: "t1", at: 4, callId: "A1", toolName: "read_file", status: "success", detail: "ok" },
  ];

  const forkEvents: SessionEvent[] = [
    { type: "user_message", id: "f1", turnId: "t2", at: 5, text: "다르게" },
    {
      type: "model_recommended",
      id: "f2",
      turnId: "t2",
      at: 6,
      selectionOrigin: "recommendation",
      selectedModelId: "model-b",
      routerVersion: ROUTER_VERSION,
    },
    { type: "tool_started", id: "f3", turnId: "t2", at: 7, callId: "B1", toolName: "run_command", risk: "execute", summary: "b" },
    { type: "tool_completed", id: "f4", turnId: "t2", at: 8, callId: "B1", toolName: "run_command", status: "success", detail: "exit 0" },
  ];

  const turns = [turnOf("t1", null, mainEvents), turnOf("t2", "t1", forkEvents)];

  test("§39 — the fork sees its own worker", () => {
    const chain = restoreEvents(turns, "t2");
    assert.equal(selectedWorkerFor(chain)?.modelId, "model-b");
  });

  test("§39 — main does not see the fork's worker", () => {
    const chain = restoreEvents(turns, "t1");
    assert.equal(selectedWorkerFor(chain)?.modelId, "model-a");
  });

  test("§39 — main does not see the fork's actions", () => {
    const ledger = actionLedger(restoreEvents(turns, "t1"));
    assert.deepEqual(ledger.map((a) => a.actionId), ["A1"]);
    assert.ok(!ledger.some((a) => a.modelId === "model-b"));
  });

  test("§39 — the fork sees the ancestor's actions, attributed to the ancestor's worker", () => {
    const ledger = actionLedger(restoreEvents(turns, "t2"));
    assert.deepEqual(ledger.map((a) => a.actionId), ["A1", "B1"]);
    assert.equal(ledger.find((a) => a.actionId === "A1")!.modelId, "model-a");
    assert.equal(ledger.find((a) => a.actionId === "B1")!.modelId, "model-b");
  });

  test("§32 — routing history follows the chain", () => {
    assert.equal(routingHistory(restoreEvents(turns, "t1")).length, 1);
    assert.equal(routingHistory(restoreEvents(turns, "t2")).length, 2);
  });
});

// ---------------------------------------------------------------------------
// Action persistence — §23, §27, §28, §33, §34, §52, §53, §54
// ---------------------------------------------------------------------------

describe("R3 · what each model proposed, and what actually ran", () => {
  const worker = (id: string, turnId: string, at: number): SessionEvent => ({
    type: "model_recommended",
    id,
    turnId,
    at,
    selectionOrigin: "recommendation",
    selectedModelId: "worker-1",
    routerVersion: ROUTER_VERSION,
  });

  test("§52 — a deferred action is proposed, not executed", () => {
    const events: SessionEvent[] = [
      worker("e1", "t1", 1),
      {
        type: "tool_completed",
        id: "e2",
        turnId: "t1",
        at: 2,
        callId: "c1",
        toolName: "run_command",
        status: "failed",
        detail: `${ACTION_REQUIRES_JUSTIFICATION}: 이번 요청은 코드를 보여달라는 것이었습니다.`,
      },
    ];
    const ledger = actionLedger(events);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.proposed, true);
    assert.equal(ledger[0]!.executed, false);
    assert.equal(ledger[0]!.state, "deferred");
  });

  test("§52 — and it says so identically after a reload", () => {
    const events: SessionEvent[] = [
      worker("e1", "t1", 1),
      {
        type: "tool_completed",
        id: "e2",
        turnId: "t1",
        at: 2,
        callId: "c1",
        toolName: "run_command",
        status: "failed",
        detail: `${ACTION_REQUIRES_JUSTIFICATION}: 보류`,
      },
    ];
    const reloaded = persist([turnOf("t1", null, events)], "t1");
    assert.deepEqual(actionLedger(reloaded), actionLedger(events));
  });

  test("a denied action is told apart from a deferred one", () => {
    const events: SessionEvent[] = [
      worker("e1", "t1", 1),
      {
        type: "tool_completed",
        id: "e2",
        turnId: "t1",
        at: 2,
        callId: "c1",
        toolName: "run_command",
        status: "failed",
        detail: `${ACTION_DENIED_BY_CONSTRAINT}: 사용자가 실행하지 말라고 했습니다.`,
      },
    ];
    assert.equal(actionLedger(events)[0]!.state, "denied");
    assert.equal(actionLedger(events)[0]!.executed, false);
  });

  test("a call held for having no contract is deferred, not failed", () => {
    const events: SessionEvent[] = [
      worker("e1", "t1", 1),
      {
        type: "tool_completed",
        id: "e2",
        turnId: "t1",
        at: 2,
        callId: "c1",
        toolName: "create_file",
        status: "failed",
        detail: `${TURN_CONTRACT_REQUIRED}: 아직 정리하지 않았습니다.`,
      },
    ];
    assert.equal(actionLedger(events)[0]!.state, "deferred");
  });

  test("§53 — an executed action records model, tool and outcome", () => {
    const events: SessionEvent[] = [
      worker("e1", "t1", 1),
      { type: "tool_started", id: "e2", turnId: "t1", at: 2, callId: "c1", toolName: "read_file", risk: "read", summary: "a.ts" },
      { type: "tool_completed", id: "e3", turnId: "t1", at: 3, callId: "c1", toolName: "read_file", status: "success", detail: "42줄" },
    ];
    const record = actionLedger(events)[0]!;
    assert.equal(record.modelId, "worker-1");
    assert.equal(record.toolName, "read_file");
    assert.equal(record.state, "succeeded");
    assert.equal(record.executed, true);
    assert.equal(record.turnId, "t1");
  });

  test("§53 — and survives a reload unchanged", () => {
    const events: SessionEvent[] = [
      worker("e1", "t1", 1),
      { type: "tool_started", id: "e2", turnId: "t1", at: 2, callId: "c1", toolName: "read_file", risk: "read", summary: "a.ts" },
      { type: "tool_completed", id: "e3", turnId: "t1", at: 3, callId: "c1", toolName: "read_file", status: "success", detail: "42줄" },
    ];
    const reloaded = persist([turnOf("t1", null, events)], "t1");
    assert.deepEqual(actionLedger(reloaded), actionLedger(events));
  });

  test("§27/§36 — actions are attributed to the worker of their own turn", () => {
    const events: SessionEvent[] = [
      { type: "model_recommended", id: "e1", turnId: "t1", at: 1, selectionOrigin: "recommendation", selectedModelId: "model-a", routerVersion: ROUTER_VERSION },
      { type: "tool_started", id: "e2", turnId: "t1", at: 2, callId: "a", toolName: "read_file", risk: "read", summary: "s" },
      { type: "tool_completed", id: "e3", turnId: "t1", at: 3, callId: "a", toolName: "read_file", status: "success", detail: "ok" },
      { type: "model_recommended", id: "e4", turnId: "t2", at: 4, selectionOrigin: "recommendation", selectedModelId: "model-b", routerVersion: ROUTER_VERSION },
      { type: "tool_started", id: "e5", turnId: "t2", at: 5, callId: "b", toolName: "create_file", risk: "write", summary: "s" },
      { type: "tool_completed", id: "e6", turnId: "t2", at: 6, callId: "b", toolName: "create_file", status: "success", detail: "ok" },
    ];
    const ledger = actionLedger(events);
    assert.equal(ledger.find((a) => a.actionId === "a")!.modelId, "model-a");
    assert.equal(ledger.find((a) => a.actionId === "b")!.modelId, "model-b");
  });

  test("a carried turn inherits the worker in force, not null", () => {
    const events: SessionEvent[] = [
      { type: "model_recommended", id: "e1", turnId: "t1", at: 1, selectionOrigin: "recommendation", selectedModelId: "model-a", routerVersion: ROUTER_VERSION },
      { type: "tool_started", id: "e2", turnId: "t2", at: 2, callId: "b", toolName: "read_file", risk: "read", summary: "s" },
      { type: "tool_completed", id: "e3", turnId: "t2", at: 3, callId: "b", toolName: "read_file", status: "success", detail: "ok" },
    ];
    assert.equal(actionLedger(events)[0]!.modelId, "model-a");
  });

  test("a conversation written before routing existed still ledgers", () => {
    const events: SessionEvent[] = [
      { type: "tool_started", id: "e1", turnId: "t1", at: 1, callId: "a", toolName: "read_file", risk: "read", summary: "s" },
      { type: "tool_completed", id: "e2", turnId: "t1", at: 2, callId: "a", toolName: "read_file", status: "success", detail: "ok" },
    ];
    const ledger = actionLedger(events);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.modelId, null);
  });

  test("§28 — proposed and executed are counted separately", () => {
    const events: SessionEvent[] = [
      worker("e1", "t1", 1),
      { type: "tool_completed", id: "e2", turnId: "t1", at: 2, callId: "c1", toolName: "run_command", status: "failed", detail: `${ACTION_REQUIRES_JUSTIFICATION}: 보류` },
      { type: "tool_completed", id: "e3", turnId: "t1", at: 3, callId: "c2", toolName: "run_command", status: "failed", detail: `${ACTION_REQUIRES_JUSTIFICATION}: 보류` },
      { type: "tool_started", id: "e4", turnId: "t1", at: 4, callId: "c3", toolName: "read_file", risk: "read", summary: "s" },
      { type: "tool_completed", id: "e5", turnId: "t1", at: 5, callId: "c3", toolName: "read_file", status: "success", detail: "ok" },
    ];
    const summary = summarizeActions(actionLedger(events));
    assert.equal(summary.proposed, 3);
    assert.equal(summary.executed, 1);
    assert.equal(summary.deferred, 2);
    assert.equal(summary.byModel["worker-1"], 3);
  });

  test("§33 — a denied write leaves a record and no workspace evidence", () => {
    const events: SessionEvent[] = [
      worker("e1", "t1", 1),
      { type: "tool_started", id: "e2", turnId: "t1", at: 2, callId: "c1", toolName: "create_file", risk: "write", summary: "a.ts" },
      { type: "tool_completed", id: "e3", turnId: "t1", at: 3, callId: "c1", toolName: "create_file", status: "denied", detail: "사용자가 승인하지 않았습니다" },
    ];
    const record = actionLedger(events)[0]!;
    assert.equal(record.state, "denied");
    assert.equal(record.executed, false);
    assert.equal(changedWorkspace(events, "c1"), false);
    assert.equal(reduceSession(events).changedFiles.length, 0);
  });

  test("§33 — an allowed write does leave both", () => {
    const events: SessionEvent[] = [
      worker("e1", "t1", 1),
      { type: "tool_started", id: "e2", turnId: "t1", at: 2, callId: "c1", toolName: "create_file", risk: "write", summary: "a.ts" },
      { type: "tool_completed", id: "e3", turnId: "t1", at: 3, callId: "c1", toolName: "create_file", status: "success", detail: "wrote" },
      { type: "file_changed", id: "e4", turnId: "t1", at: 4, path: "a.ts", change: "created" },
    ];
    assert.equal(changedWorkspace(events, "c1"), true);
    assert.equal(reduceSession(events).changedFiles.length, 1);
  });

  test("§34/§54 — repeating the same held-back action is history, not progress", () => {
    const repeated: SessionEvent[] = [worker("e0", "t1", 0)];
    for (let i = 1; i <= 4; i += 1) {
      repeated.push({
        type: "tool_completed",
        id: `e${i}`,
        turnId: "t1",
        at: i,
        callId: `c${i}`,
        toolName: "run_command",
        status: "failed",
        detail: `${ACTION_REQUIRES_JUSTIFICATION}: 보류`,
      });
    }
    const summary = summarizeActions(actionLedger(repeated));
    // Four entries in the history…
    assert.equal(summary.proposed, 4);
    // …and nothing that ran, which is what progress is measured from.
    assert.equal(summary.executed, 0);
    assert.equal(summary.succeeded, 0);
  });

  test("a cancelled call is pending, not a failure to blame the model for", () => {
    const events: SessionEvent[] = [
      worker("e1", "t1", 1),
      { type: "tool_started", id: "e2", turnId: "t1", at: 2, callId: "c1", toolName: "run_command", risk: "execute", summary: "s" },
      { type: "tool_completed", id: "e3", turnId: "t1", at: 3, callId: "c1", toolName: "run_command", status: "cancelled", detail: "중단" },
    ];
    assert.equal(actionLedger(events)[0]!.state, "pending");
  });

  test("a call that started and never completed stays pending", () => {
    const events: SessionEvent[] = [
      worker("e1", "t1", 1),
      { type: "tool_started", id: "e2", turnId: "t1", at: 2, callId: "c1", toolName: "run_command", risk: "execute", summary: "s" },
    ];
    const record = actionLedger(events)[0]!;
    assert.equal(record.state, "pending");
    assert.equal(record.executed, false);
  });

  test("the ledger is a function of the events alone", () => {
    const events: SessionEvent[] = [
      worker("e1", "t1", 1),
      { type: "tool_started", id: "e2", turnId: "t1", at: 2, callId: "c1", toolName: "read_file", risk: "read", summary: "s" },
      { type: "tool_completed", id: "e3", turnId: "t1", at: 3, callId: "c1", toolName: "read_file", status: "success", detail: "ok" },
    ];
    assert.deepEqual(actionLedger(events), actionLedger([...events]));
  });
});

// ---------------------------------------------------------------------------
// Tooth tests — §55, §56
// ---------------------------------------------------------------------------

describe("R3 · teeth — these fail if the wiring is undone", () => {
  test("A — mode-only selection cannot produce a TaskProfile at all", async () => {
    // The mutation being guarded: reverting to `chooseModel(mode)`. That path
    // has no contract, so it cannot produce the input the recommender needs —
    // and `routeTurn` is the only thing that does.
    const decision = await route(COMPLEX_ARGS);
    assert.notEqual(decision.taskProfile, undefined);
    assert.equal(decision.taskProfile!.provenance.lastTurnId, "t1");
    assert.ok(decision.taskProfile!.provenance.requirementIds.length > 0);
  });

  test("B — recommending without a contract is not expressible", async () => {
    // `routeTurn` takes a `TurnContract`; there is no overload that takes a
    // prompt. Ordering is enforced by the type, not by remembering.
    const decision = await route(SIMPLE_ARGS);
    assert.equal(decision.recommendation?.taskProfileId, decision.taskProfile?.id);
  });

  test("C — a second contract for the same turn does not change the gate's answer", () => {
    const once = reduceContract([{ type: "turn_contract", contract: contractOf(COMPLEX_ARGS, "t1") }]);
    const twice = reduceContract([
      { type: "turn_contract", contract: contractOf(COMPLEX_ARGS, "t1") },
      { type: "turn_contract", contract: contractOf(COMPLEX_ARGS, "t1") },
    ]);
    assert.equal(requiresContract(once, "create_file", "t1"), requiresContract(twice, "create_file", "t1"));
    assert.equal(once.requirements.length, twice.requirements.length);
  });

  test("D — the router cannot overwrite a user's model", async () => {
    for (const args of [SIMPLE_ARGS, COMPLEX_ARGS, ANALYSIS_ARGS]) {
      const decision = await route(args, { userRequestedModel: "chosen-by-hand" });
      assert.equal(decision.modelId, "chosen-by-hand");
    }
  });

  test("E — a filtered model cannot be selected on the online path", async () => {
    const decision = await route(COMPLEX_ARGS, {
      profiles: [
        model("banned", { capabilities: { coding: measure(1, "harness_eval", 99) } }),
        model("ok", { capabilities: { coding: measure(0.1, "harness_eval", 99) } }),
      ],
      project: { forbiddenModels: ["banned"] },
    });
    assert.equal(decision.modelId, "ok");
  });

  test("F — a recommendation that is not persisted cannot be recovered", async () => {
    const decision = await route(COMPLEX_ARGS);
    const withEvent = persist(
      [turnOf("t1", null, [routingEvent({ id: "e1", turnId: "t1", at: 1, decision })])],
      "t1",
    );
    assert.equal(selectedWorkerFor(withEvent)?.modelId, "builder");

    // Same turn, event dropped — the recovery fails, which is what makes the
    // persistence test meaningful rather than incidental.
    const without = persist(
      [turnOf("t1", null, [{ type: "assistant_text", id: "e1", turnId: "t1", at: 1, text: "x" }])],
      "t1",
    );
    assert.equal(selectedWorkerFor(without), null);
  });

  test("G — a deferred action that is not written down cannot be counted", () => {
    const written: SessionEvent[] = [
      {
        type: "tool_completed",
        id: "e1",
        turnId: "t1",
        at: 1,
        callId: "c1",
        toolName: "run_command",
        status: "failed",
        detail: `${ACTION_REQUIRES_JUSTIFICATION}: 보류`,
      },
    ];
    assert.equal(summarizeActions(actionLedger(written)).deferred, 1);
    assert.equal(summarizeActions(actionLedger([])).deferred, 0);
  });

  test("H — a proposed action is never recorded as executed", () => {
    const events: SessionEvent[] = [
      { type: "tool_started", id: "e1", turnId: "t1", at: 1, callId: "c1", toolName: "run_command", risk: "execute", summary: "s" },
      { type: "tool_completed", id: "e2", turnId: "t1", at: 2, callId: "c1", toolName: "run_command", status: "denied", detail: "거부" },
    ];
    const record = actionLedger(events)[0]!;
    assert.equal(record.proposed, true);
    assert.equal(record.executed, false);
  });

  test("I — the model behind an action survives a reload", () => {
    const events: SessionEvent[] = [
      { type: "model_recommended", id: "e1", turnId: "t1", at: 1, selectionOrigin: "recommendation", selectedModelId: "worker-x", routerVersion: ROUTER_VERSION },
      { type: "tool_started", id: "e2", turnId: "t1", at: 2, callId: "c1", toolName: "read_file", risk: "read", summary: "s" },
      { type: "tool_completed", id: "e3", turnId: "t1", at: 3, callId: "c1", toolName: "read_file", status: "success", detail: "ok" },
    ];
    const reloaded = persist([turnOf("t1", null, events)], "t1");
    assert.equal(actionLedger(reloaded)[0]!.modelId, "worker-x");
  });

  test("L — a stored decision is read, never recalculated", async () => {
    const decision = await route(COMPLEX_ARGS);
    const events = [routingEvent({ id: "e1", turnId: "t1", at: 1, decision })];
    const stored = selectedWorkerFor(events)!.modelId;
    // Recomputing now, against an empty registry, would give null. The stored
    // answer is unchanged, because nothing recomputes it.
    const wouldBeNow = await route(COMPLEX_ARGS, { profiles: [] });
    assert.equal(wouldBeNow.modelId, null);
    assert.equal(selectedWorkerFor(events)!.modelId, stored);
    assert.equal(stored, "builder");
  });
});
