import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { requirementsView } from "./requirementsView.ts";
import { reduceTask } from "./taskReducer.ts";
import { mergeContract, emptyContract, parseTurnContract } from "./turnContract.ts";
import type { SessionEvent } from "./sessionEvents.ts";
import type { TaskContract } from "./turnContract.ts";

/**
 * Showing the user that their requirements are still being held.
 *
 * The runtime has tracked this since C4.2 and the panel never said so, which
 * made the most valuable thing the control plane knows invisible: not "a tool
 * ran" but "the six things you asked for are still on the list, and this one
 * has fallen out of the plan".
 *
 * The join these tests are about is the hard part. Contract requirements are
 * the user's words; plan steps are the model's; nothing authoritative connects
 * them. `planCoverage` is a loose word overlap, and the view shows which step a
 * requirement was matched to precisely so a wrong match is visible rather than
 * silently colouring a row.
 */

let seq = 0;
function id(): { id: string; turnId: string; at: number } {
  seq += 1;
  return { id: `e${seq}`, turnId: "t0", at: 1_700_000_000_000 + seq };
}

function contractFrom(args: Record<string, unknown>): TaskContract {
  const parsed = parseTurnContract(args, "t0");
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.problem.reason);
  return mergeContract(emptyContract(), parsed.contract);
}

function toolRun(toolName: string, summary: string, ok = true): SessionEvent[] {
  const callId = `c${seq + 1}`;
  return [
    { type: "tool_started", ...id(), callId, toolName, risk: "read", summary },
    {
      type: "tool_completed",
      ...id(),
      callId,
      toolName,
      status: ok ? "success" : "failed",
      detail: ok ? summary : `${summary}: OSError: weights not found`,
    },
  ];
}

const ASKED = {
  goal: "개와 고양이 분류기",
  relation: "new_task",
  intents: "modify\nexecute",
  requirements: "CNN 구현\nTransformer 구현\n학습 실행\nHASA 모델 활용",
};

describe("what the panel is handed", () => {
  test("nothing to show before a contract exists", () => {
    assert.equal(requirementsView(null, emptyContract()), null);
    // An empty section reads as "nothing is being tracked" when the truth is
    // "not yet", which is worse than no section.
  });

  test("each requirement carries the step it was matched to", () => {
    const contract = contractFrom(ASKED);
    const task = reduceTask([
      { type: "user_message", ...id(), text: "개와 고양이 분류기를 만들어줘" },
      { type: "plan", ...id(), steps: ["CNN 구현하기", "Transformer 구현하기", "학습 실행"], current: 0 },
      ...toolRun("create_file", "CNN 모델을 작성합니다"),
    ]);

    const view = requirementsView(task, contract);
    assert.ok(view !== null);
    assert.equal(view.goal, "개와 고양이 분류기");
    assert.equal(view.requirements.length, 4);

    const cnn = view.requirements.find((r) => r.text === "CNN 구현");
    assert.equal(cnn?.progress, "done", "a create_file settled the step covering it");
    assert.equal(cnn?.step, "CNN 구현하기", "and the panel says which step, so a wrong join is visible");
  });

  test("a requirement the plan never mentions is shown as exactly that", () => {
    // The case the whole layer exists for, and the most useful thing on the
    // panel: the runtime is still holding "HASA 모델 활용" and the model's plan
    // has no step for it. Visible while there is still time to act on it.
    const contract = contractFrom(ASKED);
    const task = reduceTask([
      { type: "user_message", ...id(), text: "개와 고양이 분류기를 만들어줘" },
      { type: "plan", ...id(), steps: ["CNN 구현하기", "Transformer 구현하기", "학습 실행"], current: 0 },
    ]);

    const view = requirementsView(task, contract);
    const hasa = view?.requirements.find((r) => r.text.includes("HASA"));
    assert.equal(hasa?.progress, "unplanned");
    assert.equal(hasa?.step, undefined, "there is no step to name");
  });

  test("the count is of what still stands, not of what was ever said", () => {
    const contract = contractFrom(ASKED);
    const task = reduceTask([
      { type: "user_message", ...id(), text: "만들어줘" },
      { type: "plan", ...id(), steps: ["CNN 구현하기", "Transformer 구현하기"], current: 0 },
      ...toolRun("create_file", "CNN 작성"),
      ...toolRun("create_file", "Transformer 작성"),
    ]);

    const view = requirementsView(task, contract);
    assert.ok(view !== null);
    assert.equal(view.total, 4);
    assert.equal(view.done, 2);
    assert.equal(view.disposition, "partial");
  });

  test("a failure is shown against the requirement, with the error", () => {
    const contract = contractFrom({ ...ASKED, requirements: "ViT 학습" });
    const task = reduceTask([
      { type: "user_message", ...id(), text: "학습시켜줘" },
      { type: "plan", ...id(), steps: ["ViT 학습 실행"], current: 0 },
      ...toolRun("run_command", "python vit.py", false),
    ]);

    const view = requirementsView(task, contract);
    const row = view?.requirements[0];
    assert.equal(row?.progress, "failed");
    // The error, not a paraphrase. It is the only thing on the panel a user can
    // act on or search for.
    assert.match(view?.openIssues[0]?.detail ?? "", /OSError/);
  });
});

describe("the parts the transcript cannot show", () => {
  test("a constraint says whether it is enforced or only recorded", () => {
    const contract = contractFrom({
      goal: "코드만 보여줘",
      relation: "new_task",
      intents: "present",
      requirements: "코드 보여주기",
      constraints: "no_execute: 실행하지 마\nother: 되도록 짧게",
    });

    const view = requirementsView(reduceTask([{ type: "user_message", ...id(), text: "보여줘" }]), contract);
    assert.deepEqual(
      view?.constraints.map((c) => [c.kind, c.enforced]),
      [
        ["no_execute", true],
        ["other", false],
      ],
    );
  });

  test("a page the user named, and whether it was read", () => {
    const contract = contractFrom({
      goal: "모델 확인",
      relation: "new_task",
      intents: "research",
      requirements: "모델 목록 확인",
    });
    const task = reduceTask([
      { type: "user_message", ...id(), text: "https://open.hasa.re.kr/models 확인해줘" },
    ]);

    const view = requirementsView(task, contract);
    assert.deepEqual(view?.sources, [
      { url: "https://open.hasa.re.kr/models", status: "pending" },
    ]);
  });

  test("a run that stopped is not a task that finished", () => {
    const contract = contractFrom({ ...ASKED, requirements: "CNN 구현" });
    const task = reduceTask([
      { type: "user_message", ...id(), text: "만들어줘" },
      { type: "plan", ...id(), steps: ["CNN 구현하기"], current: 0 },
    ]);

    assert.equal(requirementsView(task, contract, "no_progress")?.disposition, "aborted");
    assert.equal(requirementsView(task, contract, "finished")?.disposition, "active");
  });

  test("a superseded requirement stays visible, marked", () => {
    // A correction retires a requirement rather than deleting it. The history
    // is the point: "you asked for this, then said not to" is a different thing
    // from "you never asked".
    const first = parseTurnContract(
      { goal: "실행해줘", relation: "new_task", intents: "execute", requirements: "main.py 실행" },
      "t0",
    );
    const second = parseTurnContract(
      {
        goal: "아니 보여줘",
        relation: "correct",
        intents: "present",
        requirements: "main.py 코드 보여주기",
        deliverables: "코드",
      },
      "t1",
    );
    assert.ok(first.ok && second.ok);
    const contract = mergeContract(mergeContract(emptyContract(), first.contract), second.contract);

    const view = requirementsView(
      reduceTask([{ type: "user_message", ...id(), text: "보여줘" }]),
      contract,
    );
    assert.ok(view !== null);
    assert.ok(view.requirements.length >= 2, "both are shown");
    assert.ok(
      view.total < view.requirements.length || view.requirements.every((r) => !r.superseded),
      "and the count only includes what still stands",
    );
  });
});

describe("noise the panel must not draw as a restriction", () => {
  test('a constraint of "없음" is not a constraint', () => {
    // Models fill the field rather than leave it out. Drawn as written, the
    // panel told a user they had forbidden something when they had not — seen
    // in a live run against `exaone-4.0-32b`, which recorded `constraints: 없음`.
    for (const text of ["없음", "None", "n/a", "-", "해당 없음", "nothing"]) {
      const contract = contractFrom({
        goal: "만들어줘",
        relation: "new_task",
        intents: "modify",
        requirements: "파일 작성",
        constraints: text,
      });
      assert.deepEqual(contract.constraints, [], text);
    }
  });

  test("a real constraint still survives beside one", () => {
    const contract = contractFrom({
      goal: "보여줘",
      relation: "new_task",
      intents: "present",
      requirements: "코드 보여주기",
      constraints: "없음\nno_execute: 실행하지 마",
    });
    assert.deepEqual(
      contract.constraints.map((c) => c.kind),
      ["no_execute"],
    );
  });
});
