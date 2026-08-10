import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { AgentSession } from "./session.ts";
import { allowingApprovalPort } from "./approval.ts";
import { nullLogger } from "../hasa-client/logger.ts";
import { createRepoFixture, type RepoFixture } from "../testing/repo-fixture.ts";
import {
  activeRequirements,
  emptyContract,
  mergeContract,
  parseTurnContract,
  planCoverage,
  type TaskContract,
  type TurnContract,
} from "./turnContract.ts";
import { allowsTool, describeContract } from "./actionPolicy.ts";
import type { AgentCompletion, AgentEvent, AgentModel } from "./types.ts";
import type { NormalizedToolCall } from "../provider/types.ts";

/**
 * What the user asked for, kept by the runtime rather than by the plan.
 *
 * The previous slice built an accurate record of what *happened* and left the
 * list of what was *wanted* coming from `update_plan` — the model's own account
 * of how it meant to proceed. So a model that never planned to touch Hugging
 * Face produced a task with no Hugging Face requirement, and the runtime
 * tracked its absence perfectly.
 *
 * The question every test here answers is one:
 *
 *   If the model plans badly, is what the user actually asked for still there?
 */

const fixtures: RepoFixture[] = [];
after(async () => {
  for (const f of fixtures) await f.dispose().catch(() => {});
});

/** The real request, from the transcript this was written after. */
const DOG_CAT =
  "개와 고양이를 분류하는 모델을 학습하고, 추론하는 프로젝트를 진행하고 싶어. " +
  "CNN부터 Transformer 계열까지 활용하고, 웹에서 필요한 내용을 보충하고, " +
  "Hugging Face와 open.hasa.re.kr을 활용하고 싶다.";

function contractArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    goal: "개/고양이 분류 프로젝트 구축",
    relation: "new_task",
    intents: "modify\nexecute\nresearch",
    requirements: [
      "개와 고양이 분류",
      "CNN 계열 활용",
      "Transformer 계열 활용",
      "학습",
      "추론",
      "웹에서 내용 보충",
      "Hugging Face 활용",
      "open.hasa.re.kr 활용",
    ].join("\n"),
    deliverables: "실행 가능한 프로젝트\n결과 비교",
    ...overrides,
  };
}

function accept(args: Record<string, unknown>, turnId = "t1"): TurnContract {
  const parsed = parseTurnContract(args, turnId);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.problem.reason);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.contract;
}

describe("24 — the first request survives whatever the plan says", () => {
  const task = mergeContract(emptyContract(), accept(contractArgs()));

  test("every distinct thing the user asked for is recorded", () => {
    const text = activeRequirements(task).map((r) => r.description).join(" | ");
    for (const asked of ["분류", "CNN", "Transformer", "학습", "추론", "Hugging Face", "hasa.re.kr", "웹"]) {
      assert.match(text, new RegExp(asked, "i"), `${asked} was asked for and is not in the contract`);
    }
    void DOG_CAT;
  });

  test("30 — a plan that omits half of them does not remove any", () => {
    // The mutation the brief asks for, as an assertion. The plan is the model's
    // strategy; dropping a requirement because the strategy forgot it is the
    // whole bug.
    const plan = ["CNN 구현", "ViT 구현", "비교"];
    assert.equal(activeRequirements(task).length, 8, "the plan cannot shrink the contract");

    const gaps = planCoverage(task, plan);
    const missing = gaps.map((g) => g.description).join(" | ");
    assert.match(missing, /Hugging Face/);
    assert.match(missing, /hasa\.re\.kr/);
  });

  test("and the gaps are reported rather than acted on", () => {
    const gaps = planCoverage(task, ["CNN 구현", "ViT 구현", "비교"]);
    assert.ok(gaps.length > 0);
    // Nothing about computing coverage changes the contract.
    assert.equal(activeRequirements(task).length, 8);
  });

  test("a plan that covers everything leaves no gap", () => {
    const thorough = [
      "개와 고양이 데이터 준비",
      "CNN 구현",
      "Transformer 구현",
      "학습 실행",
      "추론 실행",
      "웹 검색으로 보충",
      "Hugging Face 모델 가져오기",
      "open.hasa.re.kr 확인",
    ];
    assert.deepEqual(planCoverage(task, thorough), []);
  });

  test("3/5 — each requirement knows which turn asked for it, and whether explicitly", () => {
    for (const requirement of activeRequirements(task)) {
      assert.equal(requirement.provenance.sourceTurnId, "t1");
      assert.equal(requirement.provenance.origin, "explicit");
    }
  });
});

describe("25 — a refinement adds without losing", () => {
  test("the earlier requirements are still there", () => {
    const first = mergeContract(
      emptyContract(),
      accept({ ...contractArgs(), requirements: "CNN 비교\nViT 비교" }, "t1"),
    );
    const refined = mergeContract(
      first,
      accept(
        {
          goal: "오픈소스 모델 추가",
          relation: "refine",
          intents: "research\nmodify",
          requirements: "오픈소스 모델 활용\nHASA 모델 활용",
        },
        "t2",
      ),
    );

    const descriptions = activeRequirements(refined).map((r) => r.description);
    assert.deepEqual(descriptions, ["CNN 비교", "ViT 비교", "오픈소스 모델 활용", "HASA 모델 활용"]);
  });

  test("the same requirement asked twice is not duplicated", () => {
    const first = mergeContract(emptyContract(), accept({ ...contractArgs(), requirements: "CNN 비교" }, "t1"));
    const again = mergeContract(
      first,
      accept({ goal: "추가", relation: "refine", intents: "modify", requirements: "cnn 비교" }, "t2"),
    );
    assert.equal(activeRequirements(again).length, 1);
  });
});

describe("26 — a correction supersedes rather than piling on", () => {
  const executed = mergeContract(
    emptyContract(),
    accept(
      {
        goal: "결과 실행해서 보여주기",
        relation: "new_task",
        intents: "execute",
        requirements: "결과 실행",
        deliverables: "실행 결과",
      },
      "t1",
    ),
  );

  const corrected = mergeContract(
    executed,
    accept(
      {
        goal: "코드를 대화창에 출력",
        relation: "correct",
        intents: "present",
        requirements: "소스 코드를 대화창에 표시",
        deliverables: "소스 코드",
      },
      "t2",
    ),
  );

  test("the intent becomes what the user corrected it to", () => {
    assert.deepEqual(corrected.intents, ["present"]);
    assert.equal(corrected.relation, "correct");
    assert.ok(!corrected.intents.includes("execute"), "the misread intent must not survive");
  });

  test("the deliverable it contradicts is superseded, not deleted", () => {
    // Kept, because a retracted request is a different thing from one that
    // never existed and the history should be readable.
    const old = corrected.deliverables.find((d) => d.description === "실행 결과");
    assert.equal(old?.lifecycle, "superseded");
    assert.equal(old?.supersededBy, "t2");

    const now = corrected.deliverables.filter((d) => d.lifecycle === "active").map((d) => d.description);
    assert.deepEqual(now, ["소스 코드"]);
  });

  test("what the correction asks for is added", () => {
    assert.ok(activeRequirements(corrected).some((r) => r.description.includes("소스 코드")));
  });

  test("8 — the latest correction wins over the earlier reading", () => {
    // Priority, as a test rather than a comment: the guidance the model is
    // given describes presenting, not executing.
    const guidance = describeContract(corrected)!;
    assert.match(guidance, /correct/);
    assert.match(guidance, /파일을 읽어 그 내용을 답변에 그대로 담으십시오/);
    assert.ok(!/실행을 원합니다/.test(guidance));
  });
});

describe("27 — continue adds nothing and loses nothing", () => {
  test("no requirement is invented from 이어서 해줘", () => {
    const task = mergeContract(
      emptyContract(),
      accept({ ...contractArgs(), requirements: "CNN 비교\nViT 비교" }, "t1"),
    );
    const resumed = mergeContract(
      task,
      accept({ goal: "이어서", relation: "continue", intents: "continue" }, "t2"),
    );

    assert.deepEqual(
      activeRequirements(resumed).map((r) => r.description),
      ["CNN 비교", "ViT 비교"],
    );
    assert.equal(resumed.goal, task.goal, "the goal is not rewritten by a continuation");
  });

  test("a continuation may be recorded with no requirements at all", () => {
    const parsed = parseTurnContract({ goal: "이어서", relation: "continue", intents: "continue" }, "t2");
    assert.equal(parsed.ok, true);
  });
});

describe("28 — a question leaves the task alone", () => {
  test("asking why something failed does not reset anything", () => {
    const task = mergeContract(
      emptyContract(),
      accept({ ...contractArgs(), requirements: "CNN 비교\nViT 비교" }, "t1"),
    );
    const asked = mergeContract(
      task,
      accept({ goal: "ViT 오류 원인", relation: "question", intents: "discuss\ninspect" }, "t2"),
    );

    assert.deepEqual(activeRequirements(asked).map((r) => r.description), ["CNN 비교", "ViT 비교"]);
    assert.equal(asked.goal, task.goal);
    assert.deepEqual(asked.intents, ["discuss", "inspect"]);
  });
});

describe("29 — an explicit prohibition is enforced, not remembered", () => {
  const analysing = mergeContract(
    emptyContract(),
    accept(
      {
        goal: "현재 문제 분석",
        relation: "new_task",
        intents: "inspect\ndiscuss",
        requirements: "문제 원인 분석",
        constraints: "no_modify: 코드는 수정하지 말고 현재 문제만 분석해줘",
      },
      "t1",
    ),
  );

  test("writing is refused, and the refusal quotes what it is honouring", () => {
    for (const tool of ["create_file", "apply_patch", "write_file"]) {
      const verdict = allowsTool(analysing.constraints, tool);
      assert.equal(verdict.allowed, false, tool);
      assert.match(String(verdict.reason), /코드는 수정하지 말고/);
    }
  });

  test("reading and searching stay open", () => {
    for (const tool of ["read_file", "search_files", "list_files"]) {
      assert.equal(allowsTool(analysing.constraints, tool).allowed, true, tool);
    }
  });

  test("so does saying that it is stuck", () => {
    // A turn that cannot do what was asked must still be able to say so.
    for (const tool of ["record_request", "update_plan", "report_blocked"]) {
      assert.equal(allowsTool(analysing.constraints, tool).allowed, true, tool);
    }
  });

  test("실행하지 마 stops the command tool and nothing else", () => {
    const noRun = accept(
      {
        goal: "확인",
        relation: "new_task",
        intents: "inspect",
        requirements: "확인",
        constraints: "no_execute: 실행하지 말고",
      },
      "t1",
    ).constraints;
    assert.equal(allowsTool(noRun, "run_command").allowed, false);
    assert.equal(allowsTool(noRun, "create_file").allowed, true);
  });

  test("an unclassified constraint is recorded but enforces nothing", () => {
    // Inventing an enforcement for a prohibition nobody could classify would be
    // guessing at what to forbid.
    const vague = accept(
      { goal: "확인", relation: "new_task", intents: "inspect", requirements: "확인", constraints: "조심해서 해줘" },
      "t1",
    ).constraints;
    assert.equal(vague[0]?.kind, "other");
    assert.equal(allowsTool(vague, "run_command").allowed, true);
  });

  test("a constraint belongs to its turn, not to the conversation", () => {
    // One "실행하지 마" must not disable execution forever.
    const later = mergeContract(
      analysing,
      accept({ goal: "이제 실행해줘", relation: "refine", intents: "execute", requirements: "실행" }, "t2"),
    );
    assert.equal(allowsTool(later.constraints, "create_file").allowed, true);
  });
});

describe("15/16 — what happens when the model sends something unusable", () => {
  test("a contract with no goal is refused", () => {
    const parsed = parseTurnContract({ relation: "new_task", intents: "modify", requirements: "x" }, "t1");
    assert.equal(parsed.ok, false);
  });

  test("an unknown relation is refused rather than guessed", () => {
    const parsed = parseTurnContract(
      { goal: "x", relation: "whatever", intents: "modify", requirements: "x" },
      "t1",
    );
    assert.equal(parsed.ok, false);
  });

  test("a request with no requirements is refused unless it is a continuation", () => {
    assert.equal(parseTurnContract({ goal: "x", relation: "new_task", intents: "modify" }, "t1").ok, false);
    assert.equal(parseTurnContract({ goal: "x", relation: "question", intents: "discuss" }, "t1").ok, true);
  });

  test("nothing recorded means nothing enforced and no contract shown", () => {
    // A turn nobody interpreted gets the behaviour it had before this layer
    // existed, rather than a guess dressed as policy.
    const empty = emptyContract();
    assert.equal(describeContract(empty), null);
    assert.equal(allowsTool(empty.constraints, "run_command").allowed, true);
  });

  test("numbering and bullets the model adds are not part of the requirement", () => {
    const parsed = parseTurnContract(
      { goal: "x", relation: "new_task", intents: "modify", requirements: "1. CNN\n- ViT\n• 비교" },
      "t1",
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.contract.requirements.map((r) => r.description), ["CNN", "ViT", "비교"]);
  });

  test("an intent that is not one of ours is dropped, and an empty set is refused", () => {
    assert.equal(
      parseTurnContract({ goal: "x", relation: "new_task", intents: "vibes", requirements: "x" }, "t1").ok,
      false,
    );
    const mixed = parseTurnContract(
      { goal: "x", relation: "new_task", intents: "vibes modify", requirements: "x" },
      "t1",
    );
    assert.equal(mixed.ok, true);
    if (mixed.ok) assert.deepEqual(mixed.contract.intents, ["modify"]);
  });
});

describe("17 — the contract reaches the loop", () => {
  function completion(overrides: Partial<AgentCompletion> = {}): AgentCompletion {
    return { text: "", reasoning: "", toolCalls: [], inputTokens: 1, outputTokens: 1, ...overrides };
  }
  function call(name: string, id: string, args: Record<string, unknown> = {}): NormalizedToolCall {
    return { id, name, arguments: args, rawArguments: JSON.stringify(args), argumentsValid: true };
  }

  async function run(script: AgentCompletion[]): Promise<{ events: AgentEvent[]; contracts: TurnContract[] }> {
    const fixture = await createRepoFixture({ "a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);
    let index = 0;
    const events: AgentEvent[] = [];
    const contracts: TurnContract[] = [];
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model: {
        modelId: "test",
        async complete() {
          return script[index++] ?? completion({ text: "끝" });
        },
      },
      approvalPort: allowingApprovalPort,
      approvalMode: "auto",
      mode: "code",
      logger: nullLogger,
      onEvent: (event) => events.push(event),
      onContract: (contract) => contracts.push(contract),
    });
    await session.send("코드는 수정하지 말고 분석만 해줘", new AbortController().signal);
    return { events, contracts };
  }

  test("a recorded prohibition stops the tool, in the real loop", async () => {
    const { events, contracts } = await run([
      completion({
        toolCalls: [
          call("record_request", "c1", {
            goal: "문제 분석",
            relation: "new_task",
            intents: "inspect",
            requirements: "현재 문제 분석",
            constraints: "no_modify: 코드는 수정하지 말고",
          }),
        ],
      }),
      completion({ toolCalls: [call("create_file", "c2", { path: "new.ts", content: "x" })] }),
      completion({ text: "수정은 하지 않았습니다." }),
    ]);

    assert.equal(contracts.length, 1);
    const refusal = events.find((e) => e.type === "tool_end" && e.name === "create_file");
    assert.ok(refusal !== undefined && refusal.type === "tool_end");
    assert.equal(refusal.ok, false);
    assert.match(refusal.detail, /코드는 수정하지 말고/);
  });

  test("the refusal happens before approval, so the user is not asked to decline it", async () => {
    // They already said no, in words. Putting it back to them as a modal is
    // asking the same question twice.
    let asked = 0;
    const fixture = await createRepoFixture({ "a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);
    let index = 0;
    const script = [
      completion({
        toolCalls: [
          call("record_request", "c1", {
            goal: "분석",
            relation: "new_task",
            intents: "inspect",
            requirements: "분석",
            constraints: "no_execute: 실행하지 마",
          }),
        ],
      }),
      completion({ toolCalls: [call("run_command", "c2", { command: "ls" })] }),
      completion({ text: "실행하지 않았습니다." }),
    ];
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model: {
        modelId: "test",
        async complete() {
          return script[index++] ?? completion({ text: "끝" });
        },
      },
      approvalPort: {
        async request() {
          asked += 1;
          return true;
        },
      },
      approvalMode: "safe",
      mode: "code",
      logger: nullLogger,
    });

    await session.send("실행하지 말고 봐줘", new AbortController().signal);
    assert.equal(asked, 0, "the user was asked to approve something they had already forbidden");
  });
});
