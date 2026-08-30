import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { nullLogger } from "../hasa-client/logger.ts";
import type { NormalizedToolCall } from "../provider/types.ts";
import { createRepoFixture, type RepoFixture } from "../testing/repo-fixture.ts";
import { allowingApprovalPort } from "./approval.ts";
import { AgentSession, CONTROL_PLANE_CONTRACT_STATE_MISMATCH } from "./session.ts";
import {
  ACTION_DENIED_BY_CONSTRAINT,
  allowsTool,
  decideAction,
  requiresContract,
  TURN_CONTRACT_REQUIRED,
} from "./actionPolicy.ts";
import {
  adoptResearchDecision,
  decideResearch,
  reduceContract,
  describeResearchDecision,
  emptyContract,
  mergeContract,
  researchAllowed,
  type Constraint,
  type Requirement,
  type TaskContract,
  type TurnContract,
} from "./turnContract.ts";
import { prohibitionsIn } from "./statedProhibitions.ts";
import { interpretRequest } from "../router/bootstrap.ts";
import { reduceTask } from "./taskReducer.ts";
import type { SessionEvent } from "./sessionEvents.ts";
import type { AgentCompletion, AgentEvent, AgentModel } from "./types.ts";

/**
 * C4.10 — the turn that could neither record nor act.
 *
 * From a live run: the host's bootstrap interpreted the request and adopted the
 * contract into the session, so `record_request` was refused as already
 * recorded — while the action gate, comparing the contract's turn id (the
 * host's vocabulary) with the session's own (`t3`), refused every substantive
 * tool for having no contract. The worker looped between the two refusals,
 * tried `report_blocked`, was rightly refused there too, and the run died
 * NO_PROGRESS with zero executed actions.
 *
 *   duplicate check   →  contract exists
 *   acquisition gate  →  contract missing
 *
 * Both answers about one turn. The tests below pin the invariant that they can
 * never disagree again, at every layer that computes either.
 */

const APPLE_PROMPT =
  "빨간색 사과와 파란색 사과가 같이 있는 경우 각각을 분할하는 과제(segmentation task)를 학습하는 " +
  "모델과 그리고 추론한 성능을 각 모델별로 비교해줘. 사용할 모델은 CNN계열 부터 Transformer계열까지 " +
  "Huggingface에서 자주쓰는 모델로다가 웹검색을 통해서 확인 이후에 프로젝트를 진행해줘. " +
  "학습부터 추론까지 완료한 이후에 리포트 형태로 정리해줘.";

function requirement(turnId: string, index: number, description: string): Requirement {
  return {
    id: `${turnId}-r${index + 1}`,
    description,
    required: true,
    provenance: { sourceTurnId: turnId, origin: "explicit" },
    lifecycle: "active",
  };
}

function constraint(kind: Constraint["kind"], text: string, turnId = "t1"): Constraint {
  return { kind, text, sourceTurnId: turnId };
}

function contractOf(over: Partial<TurnContract> = {}): TurnContract {
  return {
    turnId: "t1",
    relation: "new_task",
    goal: "사과 segmentation 프로젝트",
    intents: ["execute"],
    requirements: [requirement("t1", 0, "segmentation 모델 학습")],
    deliverables: [],
    constraints: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The gate and the duplicate check must share one truth
// ---------------------------------------------------------------------------

describe("one answer to \"was this turn's request recorded\"", () => {
  test("one comparison decides it, and the host's vocabulary is the one used", () => {
    const task = mergeContract(emptyContract(), contractOf({ turnId: "conv-7" }));
    // The live mismatch: a contract recorded under the host's id, a gate asked
    // about the session's. There is now one id, so this is the "wrong turn"
    // case and it is refused — the fix is that the host passes `conv-7` in.
    assert.equal(requiresContract(task, "web_search", "t3") !== null, true);
    assert.equal(decideAction(task, "web_search", "t3").code, TURN_CONTRACT_REQUIRED);
    assert.equal(decideAction(task, "web_search", "conv-7").decision, "allow");
  });

  test("no contract recorded anywhere: the gate stays closed and recording stays open", () => {
    const empty = emptyContract();
    assert.equal(decideAction(empty, "web_search", "t1").decision, "deny");
    // record_request is ALWAYS_ALLOWED — the way out of a closed gate must
    // itself never be gated.
    assert.equal(decideAction(empty, "record_request", "t1").decision, "allow");
  });
});

// ---------------------------------------------------------------------------
// End to end: the attached transcript, replayed against the fix
// ---------------------------------------------------------------------------

const fixtures: RepoFixture[] = [];
after(async () => {
  for (const fixture of fixtures) await fixture.dispose();
});

function call(name: string, args: Record<string, unknown>): NormalizedToolCall {
  const raw = JSON.stringify(args);
  return { id: `c_${name}_${Math.abs(raw.length)}`, name, arguments: args, rawArguments: raw, argumentsValid: true };
}

function turn(overrides: Partial<AgentCompletion> = {}): AgentCompletion {
  return { text: "", reasoning: "", toolCalls: [], inputTokens: 1, outputTokens: 1, ...overrides };
}

function scripted(script: AgentCompletion[]): AgentModel & { seen: unknown[] } {
  const model = {
    modelId: "test-model",
    seen: [] as unknown[],
    calls: 0,
    async complete(request: unknown): Promise<AgentCompletion> {
      model.seen.push(request);
      const step = script[model.calls] ?? turn({ text: "끝났습니다라고 말할 수는 없고, 여기까지 했습니다." });
      model.calls += 1;
      return step;
    },
  };
  return model;
}

const never = new AbortController().signal;

/** Every tool result the scripted model was shown, across the turn. */
function toolResultsOf(model: { seen: unknown[] }): string[] {
  return model.seen.flatMap((r) =>
    ((r as { messages: Array<{ role: string; content: unknown }> }).messages ?? [])
      .filter((m) => m.role === "tool")
      .map((m) => String(m.content)),
  );
}

/** The host-side adoption, exactly as `agentHost.send` performs it. */
function adopt(session: AgentSession, hostTurnId: string, contract: TurnContract): void {
  session.restoreContract([{ type: "turn_contract", contract }]);
  session.markTurnContractRecorded(hostTurnId);
}

describe("the deadlock, end to end", () => {
  test("a host-adopted contract lets the very first substantive tool run", async () => {
    const fixture = await createRepoFixture({ "src/a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);

    const hostTurnId = "conv-3";
    // The worker does what the live one did: tries to record (refused), then
    // reaches for a substantive tool. Before the fix the second call was
    // refused too, and the turn had nowhere to go.
    const model = scripted([
      turn({
        toolCalls: [
          call("record_request", {
            goal: "사과 segmentation",
            relation: "new_task",
            intents: "execute",
            requirements: "segmentation 모델 학습",
          }),
        ],
      }),
      turn({ toolCalls: [call("create_file", { path: "notes/plan.md", contents: "# plan\n" })] }),
      turn({ text: "파일을 만들었고, 다음 단계로 넘어갈 준비가 되었습니다." }),
    ]);

    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
    });
    adopt(session, hostTurnId, contractOf({ turnId: hostTurnId, goal: "사과 segmentation 프로젝트" }));

    const result = await session.send(APPLE_PROMPT, never, [], { turnId: hostTurnId });

    assert.equal(result.reason, "finished");
    assert.deepEqual(result.changedFiles, ["notes/plan.md"]);

    // The record_request result was the duplicate refusal, not a re-record.
    const toolResults = model.seen.flatMap((r) =>
      ((r as { messages: Array<{ role: string; content: unknown }> }).messages ?? [])
        .filter((m) => m.role === "tool")
        .map((m) => String(m.content)),
    );
    assert.ok(toolResults.some((content) => /런타임이 이미 기록했습니다/.test(content)));
    // And no tool result ever said the contract was missing — that pair of
    // sentences in one turn is the impossible state.
    assert.ok(!toolResults.some((content) => content.includes(TURN_CONTRACT_REQUIRED)));
  });

  test("a marker for another turn opens nothing, and the turn recovers by recording", async () => {
    const fixture = await createRepoFixture({ "src/a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);

    // This test used to assert the opposite — that the marker alone kept the
    // gate open "as defence in depth". That was the leak: a marker naming one
    // turn authorised another, and a turn abandoned before `send` handed its
    // authority to whatever came next. Failing closed is the invariant now, and
    // the escape stays open so a closed gate is never a dead end.
    const model = scripted([
      turn({ toolCalls: [call("create_file", { path: "notes/x.md", contents: "x\n" })] }),
      turn({
        toolCalls: [
          call("record_request", {
            goal: "메모 작성",
            relation: "new_task",
            intents: "modify",
            requirements: "메모 파일을 만든다",
          }),
        ],
      }),
      turn({ toolCalls: [call("create_file", { path: "notes/x.md", contents: "x\n" })] }),
      turn({ text: "파일을 만들었습니다." }),
    ]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
    });
    // Adopted under a turn id this send will not use.
    adopt(session, "conv-9", contractOf({ turnId: "conv-9" }));

    const result = await session.send("작업 진행해줘.", never, [], { turnId: "conv-10" });

    const results = toolResultsOf(model);
    assert.ok(
      results.some((c) => c.includes(TURN_CONTRACT_REQUIRED)),
      "another turn's marker opened the gate",
    );
    assert.ok(
      !results.some((c) => /런타임이 이미 기록했습니다/.test(c)),
      "the escape was closed as well — the deadlock",
    );
    assert.deepEqual(result.changedFiles, ["notes/x.md"], "the turn never recovered");
    assert.equal(session.taskContract.lastTurnId, "conv-10");
  });

  test("bootstrap failed: nothing adopted, the gate closes, and recording reopens it", async () => {
    const fixture = await createRepoFixture({ "src/a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);

    const model = scripted([
      // Reaches for the tool first — refused, with the contract named as why.
      turn({ toolCalls: [call("create_file", { path: "notes/y.md", contents: "y\n" })] }),
      // Records, as told.
      turn({
        toolCalls: [
          call("record_request", {
            goal: "메모 작성",
            relation: "new_task",
            intents: "modify",
            requirements: "y 메모 파일 작성",
          }),
        ],
      }),
      // And now it may act.
      turn({ toolCalls: [call("create_file", { path: "notes/y.md", contents: "y\n" })] }),
      turn({ text: "메모 파일을 만들었습니다라는 기록이 남았습니다." }),
    ]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
    });

    const result = await session.send("y 메모 파일을 만들어줘.", never);
    assert.deepEqual(result.changedFiles, ["notes/y.md"]);
  });
});

// ---------------------------------------------------------------------------
// A contract that forbids its own requirements
// ---------------------------------------------------------------------------

describe("who may say the user forbade research", () => {
  // The invariant this whole block exists for:
  //
  //   A model-authored goal, requirement, constraint or internal state may not
  //   release a prohibition the user stated in their own words.
  //
  // The first version of this code deleted the constraint whenever the model's
  // goal mentioned the web, which inverted exactly that.

  const decide = (contract: TurnContract, userText: string) =>
    decideResearch(contract, { userText });

  test("A — a model-authored research goal cannot erase the user's explicit ban", () => {
    const banned = "웹검색하지 마. 로컬 코드만 분석해줘.";
    const contract = contractOf({
      // Exactly the hallucination that motivated this: the model writes a goal
      // asking for the web over a message that forbade it.
      goal: "웹검색으로 최신 모델 확인",
      requirements: [requirement("t1", 0, "웹검색으로 최신 모델을 확인한다")],
      constraints: [constraint("no_research", "웹검색하지 마")],
    });

    const decision = decide(contract, banned);
    assert.equal(decision.verdict, "user_forbids");
    assert.equal(researchAllowed(decision), false);

    // Nothing is deleted and nothing is quarantined.
    const adopted = adoptResearchDecision(contract, { userText: banned });
    assert.equal(adopted.contract.constraints.length, 1);
    assert.equal(adopted.contract.constraints[0]?.quarantined, undefined);

    // And the gate refuses the web tools on the constraint alone.
    assert.equal(allowsTool(adopted.contract.constraints, "web_search").allowed, false);
    assert.equal(allowsTool(adopted.contract.constraints, "web_fetch").allowed, false);
  });

  test("A — the ban holds even when the runtime's own patterns miss the sentence", () => {
    // `userForbids` false, but the constraint quotes the user. Two independent
    // signals, either of which is enough: a missed pattern must never downgrade
    // a real prohibition.
    const odd = "이번에는 바깥 자료를 참고하지 않았으면 합니다";
    const contract = contractOf({
      goal: "웹검색으로 확인",
      constraints: [constraint("no_research", "바깥 자료를 참고하지 않았으면")],
    });
    assert.equal(prohibitionsIn(odd).has("research"), false, "the pattern layer misses this");
    assert.equal(decide(contract, odd).verdict, "user_forbids", "the quote still grounds it");
  });

  test("B — a model-hallucinated ban does not block what the user asked for", () => {
    const asked =
      "Huggingface에서 자주 쓰는 모델로다가 웹검색을 통해서 확인 이후에 진행해줘.";
    const contract = contractOf({ constraints: [constraint("other", "no_research")] });

    const decision = decide(contract, asked);
    assert.equal(decision.verdict, "model_only");
    assert.equal(researchAllowed(decision), true);

    // Quarantined, not deleted: the record still shows the model invented it.
    const adopted = adoptResearchDecision(contract, { userText: asked });
    assert.equal(adopted.contract.constraints.length, 1, "the constraint is still on the record");
    assert.equal(adopted.contract.constraints[0]?.quarantined, true);
    assert.equal(allowsTool(adopted.contract.constraints, "web_search").allowed, true);
  });

  test("B — an enforced-kind hallucination is quarantined the same way", () => {
    const asked = "웹검색해서 최신 모델을 확인해줘.";
    const contract = contractOf({ constraints: [constraint("no_research", "no_research")] });
    const adopted = adoptResearchDecision(contract, { userText: asked });
    assert.equal(adopted.decision.verdict, "model_only");
    assert.equal(allowsTool(adopted.contract.constraints, "web_search").allowed, true);
  });

  test("C — a user who both asks and forbids gets neither, and is asked", () => {
    const both = "웹검색하지 말고 최신 내용을 웹에서 확인해줘.";
    const contract = contractOf({ constraints: [constraint("no_research", "웹검색하지 말고")] });

    const decision = decide(contract, both);
    assert.equal(decision.verdict, "needs_clarification");
    assert.equal(researchAllowed(decision), false, "nothing runs while it is ambiguous");
    const note = describeResearchDecision(decision);
    assert.match(note ?? "", /어긋납니다/);
    // Both halves are quoted back, so the user can see what was contradictory.
    assert.ok((decision.demandedBy ?? "").length > 0);
    assert.ok((decision.forbiddenBy ?? "").length > 0);

    // Nothing is quarantined in this state.
    const adopted = adoptResearchDecision(contract, { userText: both });
    assert.equal(adopted.contract.constraints[0]?.quarantined, undefined);
  });

  test("D — model goal against model constraint, with the user silent, fails closed", () => {
    // The user said nothing about the web either way. Two model-authored halves
    // disagree, and the runtime has no authority to settle it.
    const silent = "이 저장소의 구조를 정리해줘.";
    const contract = contractOf({
      goal: "웹검색으로 최신 자료 확인",
      constraints: [constraint("no_research", "no_research")],
    });

    const decision = decide(contract, silent);
    assert.equal(decision.verdict, "unresolved");
    assert.equal(researchAllowed(decision), false);
    assert.match(describeResearchDecision(decision) ?? "", /안전하게/);

    const adopted = adoptResearchDecision(contract, { userText: silent });
    assert.equal(adopted.contract.constraints.length, 1, "nothing is deleted");
    assert.equal(adopted.contract.constraints[0]?.quarantined, undefined);
  });

  test("no research constraint at all is not a decision", () => {
    const contract = contractOf({ constraints: [constraint("no_modify", "수정하지 마")] });
    const decision = decide(contract, "웹검색해서 확인해줘");
    assert.equal(decision.verdict, "none");
    assert.equal(researchAllowed(decision), true);
    assert.equal(describeResearchDecision(decision), null);
  });

  test("unrelated constraints are never touched by any verdict", () => {
    const asked = "웹검색해서 최신 모델을 확인해줘.";
    const mixed = contractOf({
      constraints: [
        constraint("no_research", "no_research"),
        constraint("no_modify", "코드는 수정하지 마"),
      ],
    });
    const adopted = adoptResearchDecision(mixed, { userText: asked });
    assert.deepEqual(
      adopted.contract.constraints.map((c) => c.kind),
      ["no_research", "no_modify"],
      "every constraint survives",
    );
    // The modify ban still bites.
    assert.equal(allowsTool(adopted.contract.constraints, "write_file").allowed, false);
    assert.equal(allowsTool(adopted.contract.constraints, "web_search").allowed, true);
  });

  test("the live apple prompt: the ban is the model's, and the web opens", () => {
    const contract = contractOf({ constraints: [constraint("other", "no_research")] });
    const adopted = adoptResearchDecision(contract, { userText: APPLE_PROMPT });
    assert.equal(adopted.decision.verdict, "model_only");
    assert.equal(allowsTool(adopted.contract.constraints, "web_search").allowed, true);
  });
});

describe("the user's raw words are a second line the contract cannot open", () => {
  test("a forbidden turn refuses the web even with an empty contract", async () => {
    const fixture = await createRepoFixture({ "src/a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);

    // The model records the request and writes *no* constraint at all — the
    // transcription failure `statedProhibitions` exists for. Then it reaches
    // for the web.
    const model = scripted([
      turn({
        toolCalls: [
          call("record_request", {
            goal: "로컬 코드 분석",
            relation: "new_task",
            intents: "inspect research",
            requirements: "저장소 코드를 분석한다",
          }),
        ],
      }),
      turn({ toolCalls: [call("web_search", { query: "torch segmentation" })] }),
      turn({ text: "로컬 파일만 읽고 정리했습니다." }),
    ]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
    });

    await session.send("웹검색하지 마. 로컬 코드만 분석해줘.", never, [], { turnId: "u1" });

    const toolResults = model.seen.flatMap((r) =>
      ((r as { messages: Array<{ role: string; content: unknown }> }).messages ?? [])
        .filter((m) => m.role === "tool")
        .map((m) => String(m.content)),
    );
    assert.ok(
      toolResults.some((c) => c.includes(ACTION_DENIED_BY_CONSTRAINT)),
      `web_search was not refused: ${JSON.stringify(toolResults)}`,
    );
  });

  test("a user who asked for the web gets it, even when the model bans it", async () => {
    const fixture = await createRepoFixture({ "src/a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);

    const model = scripted([
      turn({
        toolCalls: [
          call("record_request", {
            goal: "최신 모델 확인",
            relation: "new_task",
            intents: "research",
            requirements: "웹검색으로 최신 모델을 확인한다",
            // The hallucination, in the same call.
            constraints: "no_research: no_research",
          }),
        ],
      }),
      turn({ toolCalls: [call("web_search", { query: "huggingface segmentation models" })] }),
      turn({ text: "검색 결과를 정리했습니다." }),
    ]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
      web: { enabled: true },
    });

    await session.send("웹검색해서 최신 모델을 확인해줘.", never, [], { turnId: "u1" });

    const toolResults = model.seen.flatMap((r) =>
      ((r as { messages: Array<{ role: string; content: unknown }> }).messages ?? [])
        .filter((m) => m.role === "tool")
        .map((m) => String(m.content)),
    );
    // Whatever the search itself returned, it must not have been refused by the
    // constraint layer.
    assert.ok(
      !toolResults.some((c) => c.includes(ACTION_DENIED_BY_CONSTRAINT)),
      `the hallucinated ban blocked the user's request: ${JSON.stringify(toolResults)}`,
    );
    // And the tool told the model the truth about it.
    assert.ok(
      toolResults.some((c) => c.includes("격리된 제약")),
      "record_request did not report the quarantine",
    );
  });

  test("record_request never calls a quarantined constraint enforced", async () => {
    const fixture = await createRepoFixture({ "src/a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);

    const model = scripted([
      turn({
        toolCalls: [
          call("record_request", {
            goal: "최신 모델 확인",
            relation: "new_task",
            intents: "research",
            requirements: "웹검색으로 확인한다",
            constraints: "no_research: no_research",
          }),
        ],
      }),
      turn({ text: "정리했습니다." }),
    ]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
    });
    await session.send("웹검색해서 최신 모델을 확인해줘.", never, [], { turnId: "u1" });

    const toolResults = model.seen.flatMap((r) =>
      ((r as { messages: Array<{ role: string; content: unknown }> }).messages ?? [])
        .filter((m) => m.role === "tool")
        .map((m) => String(m.content)),
    );
    const recorded = toolResults.find((c) => c.includes("기록했습니다")) ?? "";
    assert.ok(recorded.length > 0, "record_request produced no result");
    assert.ok(
      !/런타임이 강제하는 제약[^.]*no_research/.test(recorded),
      `a quarantined constraint was described as enforced: ${recorded}`,
    );
  });
});

// ---------------------------------------------------------------------------
// The bootstrap's bounded corrections
// ---------------------------------------------------------------------------

/** A bootstrap-shaped scripted model: returns record_request calls in order. */
function bootstrapModel(argsList: Array<Record<string, unknown>>): AgentModel & { prompts: string[] } {
  let calls = 0;
  const model = {
    modelId: "bootstrap-test",
    prompts: [] as string[],
    async complete(request: { messages: Array<{ role: string; content: string }> }): Promise<AgentCompletion> {
      model.prompts.push(request.messages.map((m) => `${m.role}: ${m.content}`).join("\n"));
      const args = argsList[Math.min(calls, argsList.length - 1)]!;
      calls += 1;
      return {
        text: "",
        reasoning: "",
        toolCalls: [call("record_request", args)],
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
  return model as unknown as AgentModel & { prompts: string[] };
}

describe("bootstrap correction rounds", () => {
  const badArgs = {
    goal: "사과 segmentation 모델 학습과 성능 비교",
    relation: "new_task",
    intents: "execute",
    requirements: "빨간색 사과와 파란색 사과가 같이 있는 경우 각각을 분할하는 과제를 학습하는 모델",
    constraints: "no_research",
  };
  const goodArgs = {
    goal: "사과 segmentation 모델 학습과 성능 비교",
    relation: "new_task",
    intents: "execute\nresearch\nverify",
    requirements:
      "빨간색 사과와 파란색 사과를 각각 분할하는 segmentation 모델 학습\n" +
      "CNN 계열과 Transformer 계열 모델 사용\n" +
      "Huggingface에서 자주 쓰는 모델을 웹검색으로 확인\n" +
      "학습부터 추론까지 완료\n" +
      "모델별 추론 성능 비교\n" +
      "리포트 형태로 정리",
  };

  test("a self-contradicting, under-extracted contract is sent back once and fixed", async () => {
    const model = bootstrapModel([badArgs, goodArgs]);
    const result = await interpretRequest({ model, prompt: APPLE_PROMPT, turnId: "u1" });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.attempts, 2);
    assert.equal(result.conflicts, undefined);
    assert.equal(result.coverageGaps, undefined);
    assert.ok(result.contract.requirements.length >= 5);
    // The correction named both problems in one message.
    const correction = model.prompts[1] ?? "";
    assert.match(correction, /CONTRACT_CONFLICT_WEB_RESEARCH/);
    assert.match(correction, /REQUIREMENT_COVERAGE_GAP/);
  });

  test("a model that never fixes it still returns, with the flags raised", async () => {
    const model = bootstrapModel([badArgs, badArgs]);
    const result = await interpretRequest({ model, prompt: APPLE_PROMPT, turnId: "u1" });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok((result.conflicts ?? []).length > 0, "the conflict is reported, not swallowed");
    assert.ok((result.coverageGaps ?? []).length > 0, "the gaps are reported, not swallowed");
    // The caller resolves: the hallucinated ban is quarantined rather than
    // enforced, and the record still carries it.
    const adopted = adoptResearchDecision(result.contract, { userText: APPLE_PROMPT });
    assert.equal(adopted.decision.verdict, "model_only");
    assert.equal(adopted.contract.constraints.length, 1);
    assert.equal(adopted.contract.constraints[0]?.quarantined, true);
    assert.equal(allowsTool(adopted.contract.constraints, "web_search").allowed, true);
  });

  test("a clean contract passes on the first attempt with no flags", async () => {
    const model = bootstrapModel([goodArgs]);
    const result = await interpretRequest({ model, prompt: APPLE_PROMPT, turnId: "u1" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.attempts, 1);
    assert.equal(result.conflicts, undefined);
    assert.equal(result.coverageGaps, undefined);
  });
});

// ---------------------------------------------------------------------------
// The same failure is one issue, counted
// ---------------------------------------------------------------------------

let ordinal = 0;
function ev(turnId: string, at: number): { id: string; turnId: string; at: number } {
  ordinal += 1;
  return { id: `e${ordinal}`, turnId, at };
}

describe("issue dedupe", () => {
  test("three identical refusals are one issue with a count", () => {
    const failure = (at: number): SessionEvent => ({
      type: "tool_completed",
      ...ev("t1", at),
      callId: `c${at}`,
      toolName: "web_search",
      status: "failed",
      disposition: "executed_failure",
      detail: "TURN_CONTRACT_REQUIRED: web_search을(를) 실행하지 않았습니다.",
    });
    const started = (at: number): SessionEvent => ({
      type: "tool_started",
      ...ev("t1", at),
      callId: `c${at + 1}`,
      toolName: "web_search",
      risk: "read",
      summary: "웹 검색",
    });
    const events: SessionEvent[] = [
      { type: "user_message", ...ev("t1", 1), text: APPLE_PROMPT },
      started(1),
      failure(2),
      started(3),
      failure(4),
      started(5),
      failure(6),
    ];
    const task = reduceTask(events);
    const open = (task?.issues ?? []).filter((i) => i.status === "open");
    assert.equal(open.length, 1);
    assert.equal(open[0]?.count, 3);
  });

  test("a different failure is its own issue", () => {
    const make = (at: number, detail: string): SessionEvent => ({
      type: "tool_completed",
      ...ev("t1", at),
      callId: `c${at}`,
      toolName: "run_command",
      status: "failed",
      disposition: "executed_failure",
      detail,
    });
    const events: SessionEvent[] = [
      { type: "user_message", ...ev("t1", 1), text: "테스트 고쳐줘" },
      make(2, "ModuleNotFoundError: torch"),
      make(3, "SyntaxError: invalid syntax"),
    ];
    const task = reduceTask(events);
    assert.equal((task?.issues ?? []).length, 2);
  });
});

describe("constraints do not leak across turns or tasks", () => {
  test("a new task does not inherit the previous task's prohibition", () => {
    const first = mergeContract(
      emptyContract(),
      contractOf({
        turnId: "t1",
        constraints: [constraint("no_research", "웹검색하지 마", "t1")],
      }),
    );
    assert.equal(first.constraints.length, 1);

    const second = mergeContract(
      first,
      contractOf({
        turnId: "t2",
        relation: "new_task",
        goal: "완전히 다른 작업",
        requirements: [requirement("t2", 0, "README 오타 수정")],
        constraints: [],
      }),
    );
    assert.equal(second.constraints.length, 0, "t1's prohibition leaked into t2");
  });

  test("a continuation does not resurrect a spent constraint either", () => {
    const first = mergeContract(
      emptyContract(),
      contractOf({ turnId: "t1", constraints: [constraint("no_execute", "실행하지 마", "t1")] }),
    );
    const resumed = mergeContract(first, {
      ...contractOf({ turnId: "t2", relation: "continue", requirements: [] }),
      constraints: [],
    });
    assert.equal(resumed.constraints.length, 0);
  });

  test("every constraint names the turn it came from", () => {
    const merged = mergeContract(
      emptyContract(),
      contractOf({ turnId: "t9", constraints: [constraint("no_modify", "수정하지 마", "t9")] }),
    );
    assert.equal(merged.constraints[0]?.sourceTurnId, "t9");
  });
});

describe("the host's turn id is adopted, not translated", () => {
  test("a worker-recorded contract carries the id the host passed in", async () => {
    const fixture = await createRepoFixture({ "src/a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);

    // Bootstrap failed: nothing adopted, the worker records for itself — and
    // what it records must live under the host's vocabulary, or the next
    // consumer of `lastTurnId` is back to comparing two languages.
    const model = scripted([
      turn({
        toolCalls: [
          call("record_request", {
            goal: "메모 작성",
            relation: "new_task",
            intents: "modify",
            requirements: "메모 파일 작성",
          }),
        ],
      }),
      turn({ text: "기록만 하고 멈춥니다." }),
    ]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
    });

    await session.send("메모 파일을 만들어줘.", never, [], { turnId: "conv-42" });
    assert.equal(session.taskContract.lastTurnId, "conv-42");
    assert.equal(session.taskContract.requirements[0]?.provenance.sourceTurnId, "conv-42");
  });
});

describe("clause coverage thresholds", () => {
  test("one shared stem does not make a clause covered", async () => {
    // Pinned after a mutation sweep: relaxing the two-stem requirement to one
    // survived every fixture, because their gap clauses shared zero stems with
    // the recorded requirement. This clause shares exactly one — 학습 — and one
    // stem in common is how "리포트로 정리해줘" once read as covered by a
    // training requirement.
    const { contractCoverageGaps } = await import("./continuity.ts");
    const contract = {
      requirements: [
        { description: "학습 데이터 준비", lifecycle: "active" },
        { description: "모델을 구성한다", lifecycle: "active" },
      ],
    };
    const text = "학습 데이터를 준비해줘. 학습이 끝나면 리포트 형태로 정리해줘.";
    const gaps = contractCoverageGaps(contract, text).map((g) => g.clause);
    assert.ok(
      gaps.some((clause) => clause.includes("리포트")),
      `the report clause must stay a gap: ${JSON.stringify(gaps)}`,
    );
    assert.equal(gaps.length, 1, "the first clause is genuinely covered");
  });
});

describe("a marker for one turn cannot authorise another", () => {
  // The flag used to be a boolean consumed by the next `send`. A turn that
  // never reached `send` — a setup timeout, the user pressing stop — left it
  // set, and the *following* turn consumed a marker meant for a turn that never
  // ran. That turn was then told its request was already recorded while the
  // contract governing it belonged to the previous one: no way to record, and
  // the previous turn's constraints deciding this turn's actions.

  /** A worker that records, then reaches for a substantive tool. */
  function recordThenWrite(path: string): AgentCompletion[] {
    return [
      turn({
        toolCalls: [
          call("record_request", {
            goal: "메모 작성",
            relation: "new_task",
            intents: "modify",
            requirements: "메모 파일을 만든다",
          }),
        ],
      }),
      turn({ toolCalls: [call("create_file", { path, contents: "x\n" })] }),
      turn({ text: "메모를 만들었습니다." }),
    ];
  }

  test("normal adoption: the worker is refused a duplicate and may still act", async () => {
    const fixture = await createRepoFixture({ "src/a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);
    const model = scripted([
      turn({
        toolCalls: [
          call("record_request", {
            goal: "사과 segmentation",
            relation: "new_task",
            intents: "execute",
            requirements: "segmentation 모델 학습",
          }),
        ],
      }),
      turn({ toolCalls: [call("create_file", { path: "notes/a.md", contents: "a\n" })] }),
      turn({ text: "만들었습니다." }),
    ]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
    });
    adopt(session, "t1", contractOf({ turnId: "t1" }));

    const result = await session.send("작업 진행해줘.", never, [], { turnId: "t1" });
    assert.deepEqual(result.changedFiles, ["notes/a.md"]);
    assert.ok(
      toolResultsOf(model).some((c) => /런타임이 이미 기록했습니다/.test(c)),
      "the duplicate was not refused",
    );
    assert.ok(
      !toolResultsOf(model).some((c) => c.includes(TURN_CONTRACT_REQUIRED)),
      "the gate was closed on an adopted turn",
    );
  });

  test("an aborted pre-recorded turn cannot authorize the next turn", async () => {
    const fixture = await createRepoFixture({ "src/a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);
    const model = scripted(recordThenWrite("notes/b.md"));
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
    });
    // t1 was interpreted and adopted, and then never ran — the setup timed out
    // or the user stopped it, so `send` was never called for t1.
    adopt(session, "t1", contractOf({ turnId: "t1", constraints: [constraint("no_modify", "수정하지 마", "t1")] }));

    // t2 is a fresh turn the host did not adopt anything for.
    const result = await session.send("메모 파일을 만들어줘.", never, [], { turnId: "t2" });

    const results = toolResultsOf(model);
    // t2 could record its own request…
    assert.ok(
      !results.some((c) => /런타임이 이미 기록했습니다/.test(c)),
      "t2 was refused its own record_request by t1's marker",
    );
    // …and t1's constraint did not decide t2's actions.
    assert.ok(
      !results.some((c) => c.includes(ACTION_DENIED_BY_CONSTRAINT)),
      `t1's constraint governed t2: ${JSON.stringify(results)}`,
    );
    assert.deepEqual(result.changedFiles, ["notes/b.md"]);
    assert.equal(session.taskContract.lastTurnId, "t2");
  });

  test("a marker whose turn id never runs stays inert across several turns", async () => {
    const fixture = await createRepoFixture({ "src/a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);
    const model = scripted([
      ...recordThenWrite("notes/c1.md"),
      ...recordThenWrite("notes/c2.md"),
    ]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
    });
    adopt(session, "ghost", contractOf({ turnId: "ghost" }));

    await session.send("첫 번째.", never, [], { turnId: "t2" });
    await session.send("두 번째.", never, [], { turnId: "t3" });
    assert.equal(session.taskContract.lastTurnId, "t3");
  });

  test("a mismatched id fails closed and leaves record_request open", async () => {
    const fixture = await createRepoFixture({ "src/a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);
    // The worker reaches for a substantive tool *before* recording, so the gate
    // is asked while the mismatch stands.
    const model = scripted([
      turn({ toolCalls: [call("create_file", { path: "notes/d.md", contents: "d\n" })] }),
      turn({
        toolCalls: [
          call("record_request", {
            goal: "메모 작성",
            relation: "new_task",
            intents: "modify",
            requirements: "메모 파일을 만든다",
          }),
        ],
      }),
      turn({ toolCalls: [call("create_file", { path: "notes/d.md", contents: "d\n" })] }),
      turn({ text: "만들었습니다." }),
    ]);
    const events: AgentEvent[] = [];
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
      onEvent: (e) => events.push(e),
    });
    // The host claims it adopted a contract for t2, but the contract on the
    // record belongs to t1. The impossible state, forced.
    session.restoreContract([{ type: "turn_contract", contract: contractOf({ turnId: "t1" }) }]);
    session.markTurnContractRecorded("t2");

    const result = await session.send("메모 파일을 만들어줘.", never, [], { turnId: "t2" });

    const results = toolResultsOf(model);
    // Fail closed: the first create_file was held for having no contract.
    assert.ok(
      results.some((c) => c.includes(TURN_CONTRACT_REQUIRED)),
      "a substantive action ran under a mismatched contract state",
    );
    // And the escape stayed open — record_request was not refused as duplicate.
    assert.ok(
      !results.some((c) => /런타임이 이미 기록했습니다/.test(c)),
      "record_request was refused while the gate was also closed — the deadlock",
    );
    // The mismatch is a runtime failure, raised where it can be seen.
    assert.ok(
      events.some(
        (e) => e.type === "error" && e.code === CONTROL_PLANE_CONTRACT_STATE_MISMATCH,
      ),
      "the control-plane mismatch was not raised",
    );
    assert.deepEqual(result.changedFiles, ["notes/d.md"], "the turn still recovered");
  });

  test("host adoption and a worker recording agree on one answer", async () => {
    // The invariant: a duplicate refusal and a closed gate can never describe
    // the same turn. Asserted directly over the two consumers.
    const fixture = await createRepoFixture({ "src/a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);
    const model = scripted([
      turn({ toolCalls: [call("web_search", { query: "x" })] }),
      turn({ text: "끝." }),
    ]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
    });
    adopt(session, "t1", contractOf({ turnId: "t1", intents: ["research"] }));
    await session.send("웹에서 확인해줘.", never, [], { turnId: "t1" });

    const results = toolResultsOf(model);
    const refusedAsDuplicate = results.some((c) => /런타임이 이미 기록했습니다/.test(c));
    const refusedForNoContract = results.some((c) => c.includes(TURN_CONTRACT_REQUIRED));
    assert.ok(
      !(refusedAsDuplicate && refusedForNoContract),
      "one turn was told both that its request was recorded and that it was not",
    );
  });
});

describe("a conversation's messages and contract move together", () => {
  // `applyPendingRestore` restores both halves — the model's messages from the
  // conversation being opened, and the contract folded from `this.recorded`.
  // The host used to call it *before* replacing `this.recorded`, so a live
  // session could end up holding conversation B's messages under conversation
  // A's contract, and A's constraints would govern B's first turn.
  //
  // The host's ordering is exercised in the extension; what is asserted here is
  // the session-side invariant it depends on: restoring a chain replaces the
  // contract wholesale, including back to nothing.

  function contractEventFor(turnId: string, goal: string, constraints: Constraint[]): {
    type: string;
    contract: TurnContract;
  } {
    return {
      type: "turn_contract",
      contract: contractOf({
        turnId,
        goal,
        constraints,
        requirements: [requirement(turnId, 0, `${goal} 요구사항`)],
      }),
    };
  }

  test("restoring conversation B leaves nothing of conversation A's contract", async () => {
    const fixture = await createRepoFixture({ "src/a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model: scripted([turn({ text: "ok" })]),
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
    });

    // Conversation A: forbids execution.
    session.restoreContract([
      contractEventFor("a1", "파일 수정", [constraint("no_execute", "실행하지 마", "a1")]),
    ]);
    assert.equal(session.taskContract.goal, "파일 수정");
    assert.equal(allowsTool(session.taskContract.constraints, "run_command").allowed, false);

    // Conversation B: forbids modification instead.
    session.restoreContract([
      contractEventFor("b1", "테스트 실행", [constraint("no_modify", "수정하지 마", "b1")]),
    ]);

    const contract = session.taskContract;
    assert.equal(contract.goal, "테스트 실행", "A's goal survived into B");
    assert.deepEqual(
      contract.constraints.map((c) => c.kind),
      ["no_modify"],
      "A's constraint survived into B",
    );
    // The gate now reflects B and only B.
    assert.equal(allowsTool(contract.constraints, "run_command").allowed, true, "A still forbids execution in B");
    assert.equal(allowsTool(contract.constraints, "write_file").allowed, false);
    assert.ok(
      contract.requirements.every((r) => r.provenance.sourceTurnId === "b1"),
      "A's requirements survived into B",
    );
  });

  test("restoring a conversation with no contract clears the previous one", async () => {
    const fixture = await createRepoFixture({ "src/a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model: scripted([turn({ text: "ok" })]),
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
    });
    session.restoreContract([
      contractEventFor("a1", "파일 수정", [constraint("no_execute", "실행하지 마", "a1")]),
    ]);
    // A fresh conversation with nothing recorded yet.
    session.restoreContract([]);

    assert.equal(session.taskContract.lastTurnId, "");
    assert.equal(session.taskContract.constraints.length, 0);
    assert.equal(allowsTool(session.taskContract.constraints, "run_command").allowed, true);
  });

  test("a host marker does not survive a move to another conversation", async () => {
    const fixture = await createRepoFixture({ "src/a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);
    // The worker records for itself; if a stale marker survived the move it
    // would be refused as a duplicate and the turn would have nowhere to go.
    const model = scripted([
      turn({
        toolCalls: [
          call("record_request", {
            goal: "B 작업",
            relation: "new_task",
            intents: "modify",
            requirements: "B 파일을 만든다",
          }),
        ],
      }),
      turn({ toolCalls: [call("create_file", { path: "notes/b.md", contents: "b\n" })] }),
      turn({ text: "만들었습니다." }),
    ]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
    });

    // Conversation A adopted a contract for turn "shared".
    adopt(session, "shared", contractOf({ turnId: "shared", goal: "A 작업" }));
    // Then the user opens conversation B, which happens to use the same id.
    session.restoreContract([]);

    const result = await session.send("B 파일을 만들어줘.", never, [], { turnId: "shared" });

    assert.ok(
      !toolResultsOf(model).some((c) => /런타임이 이미 기록했습니다/.test(c)),
      "a marker from the previous conversation refused B's own record_request",
    );
    assert.deepEqual(result.changedFiles, ["notes/b.md"]);
    assert.equal(session.taskContract.goal, "B 작업");
  });
});

describe("the research decision is a gate of its own", () => {
  // Isolated on purpose. In the ordinary case three layers refuse a web tool —
  // the constraint list, the user's raw words, and the research decision — so
  // removing any one of them changes nothing observable. This is the case only
  // the decision can catch: an *unclassified* ban (so `allowsTool` has no
  // branch for it) that the user's sentence neither states nor contradicts (so
  // the raw-words layer is silent). Failing closed there is the whole of
  // "unresolved", and nothing else in the runtime enforces it.

  test("an unresolved conflict stops the web with nothing else objecting", async () => {
    const fixture = await createRepoFixture({ "src/a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);

    const model = scripted([
      turn({
        toolCalls: [
          call("record_request", {
            goal: "웹검색으로 최신 자료 확인",
            relation: "new_task",
            intents: "research",
            requirements: "최신 자료를 확인한다",
            // `other`, so the constraint list will not act on it.
            constraints: "other: no_research",
          }),
        ],
      }),
      turn({ toolCalls: [call("web_search", { query: "torch" })] }),
      turn({ text: "확인하지 못했습니다." }),
    ]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
      web: { enabled: true },
    });

    // The user's message says nothing about the web either way.
    const text = "이 저장소의 구조를 정리해줘.";
    assert.equal(prohibitionsIn(text).has("research"), false, "the raw-words layer must be silent");
    await session.send(text, never, [], { turnId: "u1" });

    // The unclassified ban really is inert in the constraint list…
    assert.equal(allowsTool(session.taskContract.constraints, "web_search").allowed, true);
    // …and the web tool was still refused.
    assert.ok(
      toolResultsOf(model).some((c) => c.includes(ACTION_DENIED_BY_CONSTRAINT)),
      `an unresolved research conflict let a web tool run: ${JSON.stringify(toolResultsOf(model))}`,
    );
  });
});

describe("a stale marker is inert, not noisy", () => {
  // The marker names a turn, so a marker left behind by an abandoned turn
  // matches nothing. Two things must both hold: it must not authorise the next
  // turn (asserted above), and it must not make the next turn *look* like a
  // control-plane failure — a false CONTROL_PLANE_CONTRACT_STATE_MISMATCH
  // would show the user a scary error about a turn that is perfectly fine.

  test("a marker from an abandoned turn raises no control-plane error", async () => {
    const fixture = await createRepoFixture({ "src/a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);
    const model = scripted([
      turn({
        toolCalls: [
          call("record_request", {
            goal: "메모 작성",
            relation: "new_task",
            intents: "modify",
            requirements: "메모 파일을 만든다",
          }),
        ],
      }),
      turn({ toolCalls: [call("create_file", { path: "notes/e.md", contents: "e\n" })] }),
      turn({ text: "만들었습니다." }),
    ]);
    const events: AgentEvent[] = [];
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
      onEvent: (e) => events.push(e),
    });
    // t1 was adopted and never ran.
    adopt(session, "t1", contractOf({ turnId: "t1" }));

    await session.send("메모 파일을 만들어줘.", never, [], { turnId: "t2" });

    assert.ok(
      !events.some(
        (e) => e.type === "error" && e.code === CONTROL_PLANE_CONTRACT_STATE_MISMATCH,
      ),
      "an abandoned marker reported a control-plane failure on an ordinary turn",
    );
  });

  test("a marker left by another conversation raises no control-plane error", async () => {
    const fixture = await createRepoFixture({ "src/a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);
    const model = scripted([
      turn({
        toolCalls: [
          call("record_request", {
            goal: "B 작업",
            relation: "new_task",
            intents: "modify",
            requirements: "B 파일을 만든다",
          }),
        ],
      }),
      turn({ toolCalls: [call("create_file", { path: "notes/f.md", contents: "f\n" })] }),
      turn({ text: "만들었습니다." }),
    ]);
    const events: AgentEvent[] = [];
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
      onEvent: (e) => events.push(e),
    });
    adopt(session, "shared", contractOf({ turnId: "shared", goal: "A 작업" }));
    // Moving to another conversation retires the marker with the contract.
    session.restoreContract([]);

    await session.send("B 파일을 만들어줘.", never, [], { turnId: "shared" });

    assert.ok(
      !events.some(
        (e) => e.type === "error" && e.code === CONTROL_PLANE_CONTRACT_STATE_MISMATCH,
      ),
      "a marker from the previous conversation reported a failure in this one",
    );
  });
});

describe("a missed phrasing must not become an inversion", () => {
  // The deepest defect an adversarial review found in this pass. `decideResearch`
  // read the forbid side from the whole message and the demand side clause by
  // clause, and it skipped a clause only when the pattern layer *recognised* a
  // ban in it. So any phrasing the patterns missed was not merely unrecognised:
  // the web noun sat inside the prohibition, the demand pattern matched it, and
  // the user's own ban became the evidence for quarantining itself.
  //
  //   deny  ->  allow, and the user's words filed as the model's invention
  //
  // `statedProhibitions` has always been asymmetric on purpose — a miss leaves
  // the existing behaviour unchanged. These pin the same asymmetry here.

  const decide = (contract: TurnContract, userText: string) =>
    decideResearch(contract, { userText });

  const BAN = () =>
    contractOf({
      goal: "웹검색으로 최신 자료 확인",
      constraints: [constraint("no_research", "no_research")],
    });

  // Every one of these is a prohibition. A paraphrased constraint means
  // `quotesUser` cannot help, so the verdict rests entirely on reading the
  // user's sentence.
  const BANS: ReadonlyArray<[string, string]> = [
    ["a polite interrogative tail", "웹검색하지 말고 로컬 코드만 봐줄래?"],
    ["a formal interrogative tail", "웹검색하지 말고 저장소 코드만 정리해 주시겠어요?"],
    ["a request to refrain", "웹검색은 하지 말아주실 수 있을까요?"],
    ["a place-negation with a tail", "웹에서 찾지 말고 저장소에서 찾아줄래?"],
    ["a bare noun + 말고", "웹검색 말고 저장소에서 찾아줘"],
    ["a bare noun + 대신", "웹검색 대신 로컬 코드를 봐줘"],
    ["an exclusion", "인터넷 검색은 빼고 정리해줄래?"],
    ["a plain ban", "웹검색하지 마. 로컬 코드만 분석해줘."],
  ];

  for (const [name, text] of BANS) {
    test(`${name} is never read as a demand for the web`, () => {
      const decision = decide(BAN(), text);
      assert.notEqual(
        decision.verdict,
        "model_only",
        `the user's own ban was filed as the model's invention: ${JSON.stringify(decision)}`,
      );
      assert.equal(
        researchAllowed(decision),
        false,
        `a web tool would have run against "${text}"`,
      );
    });

    test(`${name} is never quarantined`, () => {
      const adopted = adoptResearchDecision(BAN(), { userText: text });
      assert.equal(
        adopted.contract.constraints[0]?.quarantined,
        undefined,
        "the user's own prohibition was quarantined",
      );
      assert.equal(allowsTool(adopted.contract.constraints, "web_search").allowed, false);
    });
  }

  test("one question mark cannot flip a refusal into an allow", () => {
    // The measured inversion: the same sentence, plus `?`.
    const plain = decide(BAN(), "웹검색하지 말고 최신 내용을 웹에서 확인해줘.");
    const asked = decide(BAN(), "웹검색하지 말고 최신 내용을 웹에서 확인해줄래?");
    assert.equal(researchAllowed(plain), false);
    assert.equal(researchAllowed(asked), false, "a question mark opened the web");
    assert.equal(plain.verdict, asked.verdict, "punctuation changed the verdict");
  });

  test("the research class is not more permissive than execute or modify", () => {
    // The asymmetry that exposed the guard: structurally identical sentences.
    const tail = "말고 코드만 보여줄래?";
    assert.equal(prohibitionsIn(`실행하지 ${tail}`).has("execute"), true);
    assert.equal(prohibitionsIn(`수정하지 ${tail}`).has("modify"), true);
    assert.equal(
      prohibitionsIn(`웹검색하지 ${tail}`).has("research"),
      true,
      "research was disarmed by a tail the other classes tolerate",
    );
  });

  test("a genuine request for the web still opens it", () => {
    // The counter-direction. Widening the ban patterns must not swallow this.
    for (const text of [
      "웹검색해서 최신 모델을 확인해줘.",
      "인터넷에서 관련 자료를 조사해줘.",
      "Search the web for the latest documentation.",
    ]) {
      const decision = decide(BAN(), text);
      assert.equal(decision.verdict, "model_only", `refused a clear request: ${text}`);
      assert.equal(researchAllowed(decision), true);
    }
  });
});

describe("a quarantine survives the record", () => {
  test("the flag is carried through the fold", () => {
    // `reduceContract` re-reads every contract event from the record, so a flag
    // the reader dropped lasted exactly as long as the object that set it —
    // and the host path, which folds before every turn, re-enforced the ban the
    // runtime had just disarmed.
    const quarantined: TurnContract = {
      ...contractOf({ constraints: [constraint("no_research", "no_research")] }),
    };
    const adopted = adoptResearchDecision(quarantined, {
      userText: "웹검색해서 최신 모델을 확인해줘.",
    });
    assert.equal(adopted.contract.constraints[0]?.quarantined, true);

    const folded = reduceContract([{ type: "turn_contract", contract: adopted.contract }]);
    assert.equal(
      folded.constraints[0]?.quarantined,
      true,
      "the quarantine was lost on the fold, so the ban came back enforced",
    );
    assert.equal(allowsTool(folded.constraints, "web_search").allowed, true);
  });

  test("an ordinary constraint is not quarantined by the fold", () => {
    const plain = contractOf({ constraints: [constraint("no_modify", "수정하지 마")] });
    const folded = reduceContract([{ type: "turn_contract", contract: plain }]);
    assert.equal(folded.constraints[0]?.quarantined, undefined);
    assert.equal(allowsTool(folded.constraints, "write_file").allowed, false);
  });
});

describe("the shape of a ban is the last line", () => {
  // `prohibitionsIn` recognises verbs; a user can forbid the web with a verb it
  // has never seen. When that happens the pattern layer says nothing, and
  // without a fallback the demand side would read the sentence as a request —
  // the inversion this pass exists to end. So a clause that is negative *by
  // shape* and mentions the web at all keeps the web shut, whatever verb it uses.

  const UNSEEN_VERBS = [
    "웹은 손대지 마",
    "인터넷은 만지지 말고 로컬만 봐줘",
    "웹은 아예 뒤지지 말아줘",
  ];

  for (const text of UNSEEN_VERBS) {
    test(`a verb the patterns do not know still shuts the web: ${text}`, () => {
      // The premise: the pattern layer really does miss this one.
      assert.equal(
        prohibitionsIn(text).has("research"),
        false,
        "this phrasing is now recognised — pick another for this test",
      );
      const decision = decideResearch(
        contractOf({ constraints: [constraint("no_research", "no_research")] }),
        { userText: text },
      );
      assert.equal(researchAllowed(decision), false, "an unrecognised ban opened the web");
      assert.notEqual(decision.verdict, "model_only", "the user's ban was filed as the model's");
    });
  }

  test("a negative clause about something else does not shut the web", () => {
    // The shape check is coarse on purpose, but it still requires the web to be
    // named in the negative clause.
    const decision = decideResearch(
      contractOf({ constraints: [constraint("no_research", "no_research")] }),
      { userText: "테스트는 건드리지 말고 웹검색으로 최신 자료를 확인해줘." },
    );
    assert.equal(decision.verdict, "model_only");
    assert.equal(researchAllowed(decision), true);
  });
});

describe("a ban in one clause outranks a demand in another", () => {
  test("the shape check settles what neither pattern nor quote can", () => {
    // Every other signal is silent here. The ban uses a verb the pattern layer
    // does not know, so `prohibitionsIn` finds nothing; the constraint the
    // model wrote is a bare code, so `quotesUser` finds nothing; and the demand
    // in the second clause is real. Without the shape check the design reads
    // the second clause as permission to ignore the first.
    const text = "웹은 손대지 마. 최신 자료를 웹에서 찾아줘.";
    assert.equal(
      prohibitionsIn(text).has("research"),
      false,
      "this phrasing is now recognised — pick another verb for this test",
    );
    const contract = contractOf({ constraints: [constraint("no_research", "no_research")] });
    const decision = decideResearch(contract, { userText: text });
    assert.equal(researchAllowed(decision), false, "a later demand overrode an earlier ban");
    assert.notEqual(decision.verdict, "model_only", "the user's ban was filed as the model's");
  });
});
