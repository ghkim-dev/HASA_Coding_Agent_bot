import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { emptyContract, mergeContract, parseTurnContract } from "../agent/turnContract.ts";
import { allowsTool, decideAction } from "../agent/actionPolicy.ts";
import { projectTaskProfile, hardConstraintsFrom } from "./taskProfile.ts";
import { interpretRequest } from "./bootstrap.ts";
import type { AgentCompletion, AgentModel } from "../agent/types.ts";

/**
 * A constraint the user stated, all the way to the gate that enforces it.
 *
 * The live failure this closes was not an omission. Asked "실행하거나 수정하지
 * 말고 …", the interpreter *did* record the restriction — as `other`. And
 * `other` is deliberately unenforceable: `hardConstraintsFrom` has no branch
 * for it, because enforcing a restriction nobody classified means guessing what
 * to forbid. So the contract carried the user's words, `TaskProfile.constraints`
 * came out `{}`, and a check that asked only "is there constraint text"
 * answered yes.
 *
 *     text present  ≠  coverage complete
 *
 * The fix is not a Korean regex and not a second parser. The model already did
 * the interpreting; it is asked, once, to finish it — and if it still will not,
 * the caller is told rather than left to discover an `other` that does nothing.
 */

function scripted(answers: ReadonlyArray<Partial<AgentCompletion>>): AgentModel & { calls: number } {
  let index = 0;
  const model = {
    modelId: "boot",
    calls: 0,
    async complete(): Promise<AgentCompletion> {
      const answer = answers[Math.min(index, answers.length - 1)] ?? {};
      index += 1;
      model.calls += 1;
      return { text: "", reasoning: "", toolCalls: [], inputTokens: 0, outputTokens: 0, ...answer };
    },
  };
  return model;
}

function call(constraints: string): AgentCompletion["toolCalls"][number] {
  const args = {
    goal: "아키텍처만 분석",
    relation: "new_task",
    intents: "inspect",
    requirements: "이 저장소의 아키텍처를 분석한다",
    constraints,
  };
  return {
    id: "c1",
    name: "record_request",
    arguments: args,
    rawArguments: JSON.stringify(args),
    argumentsValid: true,
  };
}

const CANONICAL = "no_execute: 실행하지 마\nno_modify: 수정하지 마";
const UNCLASSIFIED = "실행하거나 수정하지 말고";

// ---------------------------------------------------------------------------

describe("constraint coverage · a stated prohibition reaches the gate", () => {
  test("A — canonical kinds project into the task's hard set", async () => {
    const result = await interpretRequest({
      model: scripted([{ toolCalls: [call(CANONICAL)] }]),
      prompt: "실행하거나 수정하지 말고 분석만 해줘",
      turnId: "t1",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.constraintCoverage, "complete");

    const profile = projectTaskProfile(mergeContract(emptyContract(), result.contract));
    assert.equal(profile.constraints.noExecute, true);
    assert.equal(profile.constraints.noModify, true);
  });

  test("B — an unclassified restriction is sent back once, not accepted", async () => {
    const model = scripted([
      { toolCalls: [call(UNCLASSIFIED)] },
      { toolCalls: [call(CANONICAL)] },
    ]);
    const result = await interpretRequest({
      model,
      prompt: "실행하거나 수정하지 말고 분석만 해줘",
      turnId: "t1",
      maxAttempts: 2,
    });
    assert.equal(model.calls, 2, "the interpreter was asked to finish classifying");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.constraintCoverage, "complete");
    assert.equal(result.contract.constraints.map((c) => c.kind).sort().join(","), "no_execute,no_modify");
  });

  test("B — and only one contract comes out of it", async () => {
    const result = await interpretRequest({
      model: scripted([{ toolCalls: [call(UNCLASSIFIED)] }, { toolCalls: [call(CANONICAL)] }]),
      prompt: "x",
      turnId: "t1",
      maxAttempts: 2,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // One `TurnContract`, so one `turn_contract` event. The correction is a
    // retry of the reading, not a second reading kept beside the first.
    assert.equal(result.contract.turnId, "t1");
    assert.equal(result.contract.constraints.length, 2);
  });

  test("B — a model that will not classify yields an honest incomplete", async () => {
    const result = await interpretRequest({
      model: scripted([{ toolCalls: [call(UNCLASSIFIED)] }]),
      prompt: "x",
      turnId: "t1",
      maxAttempts: 2,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.constraintCoverage, "unclassified_remain");
    assert.deepEqual(result.unclassified, [UNCLASSIFIED]);
  });

  test("text present is not coverage complete", async () => {
    const result = await interpretRequest({
      model: scripted([{ toolCalls: [call(UNCLASSIFIED)] }]),
      prompt: "x",
      turnId: "t1",
      maxAttempts: 1,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // The old check: "there is constraint text, so extraction worked."
    assert.ok(result.contract.constraints.length > 0);
    // What is actually true.
    assert.equal(result.constraintCoverage, "unclassified_remain");
    const profile = projectTaskProfile(mergeContract(emptyContract(), result.contract));
    assert.deepEqual(profile.constraints, {}, "an `other` enforces nothing, which is the point");
  });

  test("a genuinely non-canonical restriction is allowed to stay `other`", async () => {
    const polite = "other: 가능하면 오늘 안에 부탁드립니다";
    const model = scripted([{ toolCalls: [call(polite)] }]);
    const result = await interpretRequest({ model, prompt: "x", turnId: "t1", maxAttempts: 2 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Still asked once — the runtime cannot tell a deadline from a prohibition —
    // and accepted when the model says it is `other` again.
    assert.equal(model.calls, 2);
    assert.equal(result.constraintCoverage, "unclassified_remain");
  });

  test("C — a canonical constraint survives the projection", () => {
    const parsed = parseTurnContract(
      {
        goal: "g",
        relation: "new_task",
        intents: "inspect",
        requirements: "r",
        constraints: CANONICAL,
      },
      "t1",
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const hard = hardConstraintsFrom(parsed.contract.constraints);
    assert.equal(hard.noExecute, true);
    assert.equal(hard.noModify, true);
    // And through the full projection, which is where it was being lost.
    const profile = projectTaskProfile(mergeContract(emptyContract(), parsed.contract));
    assert.equal(profile.constraints.noExecute, true);
    assert.equal(profile.constraints.noModify, true);
  });

  const FORBIDDEN: ReadonlyArray<{ tool: string; name: string }> = [
    { tool: "run_command", name: "D — a command" },
    { tool: "create_file", name: "E — a write" },
    { tool: "apply_patch", name: "E — a patch" },
  ];

  for (const scenario of FORBIDDEN) {
    test(`${scenario.name} is denied before approval, not after`, async () => {
      const result = await interpretRequest({
        model: scripted([{ toolCalls: [call(CANONICAL)] }]),
        prompt: "실행하거나 수정하지 말고",
        turnId: "t1",
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      const task = mergeContract(emptyContract(), result.contract);

      const verdict = allowsTool(task.constraints, scenario.tool);
      assert.equal(verdict.allowed, false, `${scenario.tool} should be refused`);

      const decision = decideAction(task, scenario.tool, "t1");
      assert.equal(decision.decision, "deny");
      assert.match(decision.code ?? "", /DENIED_BY_CONSTRAINT/);
      assert.ok((decision.reason?.length ?? 0) > 0);
    });
  }

  test("reading is still allowed under both prohibitions", async () => {
    const result = await interpretRequest({
      model: scripted([{ toolCalls: [call(CANONICAL)] }]),
      prompt: "x",
      turnId: "t1",
    });
    if (!result.ok) return;
    const task = mergeContract(emptyContract(), result.contract);
    for (const tool of ["read_file", "search_files", "list_files"]) {
      assert.equal(allowsTool(task.constraints, tool).allowed, true, tool);
    }
  });

  test("F — the correction does not produce a second contract for the turn", async () => {
    const result = await interpretRequest({
      model: scripted([{ toolCalls: [call(UNCLASSIFIED)] }, { toolCalls: [call(CANONICAL)] }]),
      prompt: "x",
      turnId: "t1",
      maxAttempts: 2,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // The caller records one event from one returned contract; there is no
    // second contract to record, by construction.
    assert.equal(Array.isArray(result.contract.constraints), true);
    assert.equal(result.attempts, 2, "two model calls, one contract");
  });

  test("a request with no restriction is complete without a second call", async () => {
    const args = {
      goal: "g",
      relation: "new_task",
      intents: "modify",
      requirements: "고친다",
    };
    const model = scripted([
      {
        toolCalls: [
          { id: "c", name: "record_request", arguments: args, rawArguments: "{}", argumentsValid: true },
        ],
      },
    ]);
    const result = await interpretRequest({ model, prompt: "고쳐줘", turnId: "t1", maxAttempts: 2 });
    assert.equal(model.calls, 1, "nothing to correct, so nothing is asked");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.constraintCoverage, "complete");
  });
});
