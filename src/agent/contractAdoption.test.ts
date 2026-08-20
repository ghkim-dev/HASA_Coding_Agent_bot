import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { nullLogger } from "../hasa-client/logger.ts";
import type { NormalizedToolCall } from "../provider/types.ts";
import { createRepoFixture, type RepoFixture } from "../testing/repo-fixture.ts";
import { allowingApprovalPort } from "./approval.ts";
import { AgentSession } from "./session.ts";
import { decideAction, requiresContract, TURN_CONTRACT_REQUIRED } from "./actionPolicy.ts";
import {
  emptyContract,
  mergeContract,
  researchConflicts,
  resolveResearchConflicts,
  type Constraint,
  type Requirement,
  type TaskContract,
  type TurnContract,
} from "./turnContract.ts";
import { interpretRequest } from "../router/bootstrap.ts";
import { reduceTask } from "./taskReducer.ts";
import type { SessionEvent } from "./sessionEvents.ts";
import type { AgentCompletion, AgentModel } from "./types.ts";

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
  test("the canonical override opens the gate whatever the id vocabulary", () => {
    const task = mergeContract(emptyContract(), contractOf({ turnId: "conv-7" }));
    // The session's own id differs — the exact live mismatch.
    assert.notEqual(task.lastTurnId, "t3");
    assert.equal(requiresContract(task, "web_search", "t3", true), null);
    assert.equal(decideAction(task, "web_search", "t3", { recordedThisTurn: true }).decision, "allow");
  });

  test("without the override the id comparison still governs", () => {
    const task = mergeContract(emptyContract(), contractOf({ turnId: "conv-7" }));
    const decision = decideAction(task, "web_search", "t3");
    assert.equal(decision.decision, "deny");
    assert.equal(decision.code, TURN_CONTRACT_REQUIRED);
    // And the matching id opens it, as it always did.
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

/** The host-side adoption, exactly as `agentHost.send` performs it. */
function adopt(session: AgentSession, hostTurnId: string, contract: TurnContract): void {
  session.restoreContract([{ type: "turn_contract", contract }]);
  session.markNextTurnContractRecorded();
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

  test("even a mismatched id vocabulary cannot close the gate once the host adopted", async () => {
    const fixture = await createRepoFixture({ "src/a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);

    const model = scripted([
      turn({ toolCalls: [call("create_file", { path: "notes/x.md", contents: "x\n" })] }),
      turn({ text: "파일을 만들었습니다라고 기록에 남겼습니다." }),
    ]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
    });
    // Adopted under the host's vocabulary, but send() is *not* given the id —
    // the defence in depth: the flag alone must keep the gate open.
    adopt(session, "conv-9", contractOf({ turnId: "conv-9" }));

    const result = await session.send("작업 진행해줘.", never);
    assert.deepEqual(result.changedFiles, ["notes/x.md"]);
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

describe("research conflicts", () => {
  test("an enforced no_research over an explicit web request is a conflict", () => {
    const conflicted = contractOf({
      requirements: [
        requirement("t1", 0, "Hugging Face에서 자주 쓰는 모델을 웹검색으로 확인"),
        requirement("t1", 1, "segmentation 모델 학습"),
      ],
      constraints: [constraint("no_research", "웹검색 금지")],
    });
    const found = researchConflicts(conflicted);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.constraint.kind, "no_research");
    assert.ok(found[0]!.demandedBy.length > 0);
  });

  test("the live shape: a bare unclassified \"no_research\" over the user's web clause", () => {
    // Neither the goal nor the surviving requirement mentions the web — the
    // extraction dropped that clause. The user's own message is what carries
    // the demand, and it is read.
    const live = contractOf({
      constraints: [constraint("other", "no_research")],
    });
    assert.equal(researchConflicts(live).length, 0, "contract alone cannot see it");
    assert.equal(researchConflicts(live, APPLE_PROMPT).length, 1, "the user's words can");

    const resolved = resolveResearchConflicts(live, APPLE_PROMPT);
    assert.equal(resolved.dropped.length, 1);
    assert.equal(resolved.contract.constraints.length, 0);
  });

  test("a real prohibition is not a conflict", () => {
    // The user forbade the web and asked for nothing web-shaped.
    const genuine = contractOf({
      goal: "로컬 코드만 분석",
      requirements: [requirement("t1", 0, "로컬 저장소 코드 분석")],
      constraints: [constraint("no_research", "웹검색하지 말고 로컬만 봐줘")],
    });
    assert.equal(researchConflicts(genuine, "웹검색하지 말고 로컬 코드만 분석해줘").length, 0);
    const resolved = resolveResearchConflicts(genuine, "웹검색하지 말고 로컬 코드만 분석해줘");
    assert.equal(resolved.dropped.length, 0);
    assert.equal(resolved.contract.constraints.length, 1);
  });

  test("\"웹검색 없이\" in a requirement is not a demand", () => {
    const negated = contractOf({
      requirements: [requirement("t1", 0, "웹검색 없이 로컬 문서로만 정리")],
      constraints: [constraint("no_research", "검색 금지")],
    });
    assert.equal(researchConflicts(negated).length, 0);
  });

  test("unrelated constraints survive resolution untouched", () => {
    const mixed = contractOf({
      requirements: [requirement("t1", 0, "웹검색으로 모델 확인")],
      constraints: [
        constraint("no_research", "no_research"),
        constraint("no_modify", "코드는 수정하지 마"),
      ],
    });
    const resolved = resolveResearchConflicts(mixed);
    assert.deepEqual(
      resolved.contract.constraints.map((c) => c.kind),
      ["no_modify"],
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
    // The caller resolves: the hallucinated ban does not survive into force.
    const resolved = resolveResearchConflicts(result.contract, APPLE_PROMPT);
    assert.equal(resolved.dropped.length, 1);
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
