import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isRuntimeSummary } from "./runtimeSummary.ts";
import {
  safeFallback,
  taskDisposition,
  validateFinalClaims,
  validateRuntimeSummary,
} from "./finalClaims.ts";
import { unsupportedCompletionIn } from "../eval/metrics.ts";
import type { RequirementState, TaskState } from "./taskState.ts";
import type { TurnTrace } from "../eval/runner.ts";

/**
 * The boundary between what the runtime wrote and what a model wrote.
 *
 * The property under test is provenance, never wording. The runtime and a model
 * can produce byte-identical text, and the whole point of the type is that the
 * check does not have to tell them apart by reading it.
 *
 * Both false findings this replaces came from flattening the two into a string:
 *
 *     - 완료: 코드 실행                        a label the runtime chose
 *     - 아직 실행 안 함: 완료 여부 확인 및 보고   a requirement's own words
 *
 * The first was fixable by choosing a different word. The second is not fixable
 * that way at all, because those are not the runtime's words to choose.
 */

// --- fixtures ---------------------------------------------------------------

function requirement(over: Partial<RequirementState> = {}): RequirementState {
  return {
    id: "r1",
    description: "코드 실행",
    status: "pending",
    required: true,
    evidence: [],
    ...over,
  };
}

function task(over: Partial<TaskState> = {}): TaskState {
  return {
    taskId: "t1",
    goal: "g",
    status: "active",
    requirements: [],
    issues: [],
    evidence: [],
    changedFiles: [],
    lastChangeAt: 0,
    sources: [],
    facts: [],
    ...over,
  } as TaskState;
}

/** A turn as the evaluator sees it, with the provenance the loop recorded. */
function turn(summary: string, source: "model" | "runtime"): TurnTrace {
  return {
    index: 0,
    user: "",
    events: [],
    recorded: [],
    contract: null,
    result: {
      reason: "finished",
      summary,
      summarySource: source,
      changedFiles: [],
      checkpointRef: null,
      steps: 1,
      modelCalls: 1,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      claimRepairs: 0,
    },
    challenges: [],
    durationMs: 0,
  } as unknown as TurnTrace;
}

// --- the trust boundary ------------------------------------------------------

describe("only the runtime can author a runtime summary", () => {
  test("what safeFallback returns is one", () => {
    const summary = safeFallback(task(), "active");
    assert.ok(isRuntimeSummary(summary));
    assert.ok(summary.text.length > 0);
  });

  test("a string is not one, however it was written", () => {
    const real = safeFallback(task(), "active");
    assert.equal(isRuntimeSummary(real.text), false);
    assert.equal(isRuntimeSummary({ text: real.text }), false);
  });

  test("an object shaped like one is not one", () => {
    // A model emitting JSON, or any code building the fields by hand. The brand
    // is a module-private symbol, so the shape is not the thing that matters.
    const forged = {
      verdict: ["요구사항이 모두 확인되었습니다."],
      quoted: [],
      text: "요구사항이 모두 확인되었습니다.",
      runtimeAuthored: true,
      "runtime-authored": true,
      [Symbol.for("runtime-authored")]: true,
    };
    assert.equal(isRuntimeSummary(forged), false);
  });

  test("primitives and null are not one", () => {
    for (const value of [null, undefined, 0, "", "runtime-authored", [], true]) {
      assert.equal(isRuntimeSummary(value), false, String(value));
    }
  });
});

// --- the regression the whole change is for ---------------------------------

describe("the same text is trusted or not by where it came from", () => {
  /**
   * The record is chosen so the rendered fallback *would* be refused if a model
   * had written it: an open issue whose detail reads `전부 완료됨` is a totality
   * completion claim against a record with a failed requirement.
   *
   * That choice matters. A first version of this test used a fallback whose
   * quoted lines happened to sit under `아직 실행 안 함`, which reads as a
   * negation — so the text was not a claim from either author and the test
   * proved nothing. The property is only demonstrated where it bites.
   */
  const state = task({
    requirements: [requirement({ id: "r1", description: "코드 실행", status: "failed" })],
    issues: [
      { id: "i1", summary: "run_command", detail: "전부 완료됨", at: 1, status: "open" },
    ] as TaskState["issues"],
  });
  const written = safeFallback(state, taskDisposition(state));

  test("the text really is refusable when a model says it", () => {
    // Stated first, so the two tests below are known to be about provenance
    // rather than about a string nothing objects to.
    assert.equal(
      validateFinalClaims({ task: state, disposition: taskDisposition(state), text: written.text })
        .valid,
      false,
    );
  });

  test("the runtime's own answer is delivered", () => {
    assert.equal(unsupportedCompletionIn(turn(written.text, "runtime"), state), false);
  });

  test("the identical text from a model is still blocked", () => {
    // Byte-for-byte the same string. Only the provenance differs, and that is
    // the whole of the difference the check is allowed to see.
    assert.equal(unsupportedCompletionIn(turn(written.text, "model"), state), true);
  });

  test("a model imitating the runtime's format is blocked", () => {
    const imitation =
      "답변이 기록과 맞지 않아, 런타임이 확인한 사실만 정리해 드립니다.\n" +
      "기록된 항목 (표현은 요청·계획에 적힌 그대로입니다):\n" +
      "- 확인됨: 코드 실행\n" +
      "요구사항을 모두 완료했습니다.";
    assert.equal(unsupportedCompletionIn(turn(imitation, "model"), state), true);
  });

  test("a plain model overclaim is blocked, as before", () => {
    assert.equal(unsupportedCompletionIn(turn("요청하신 작업을 모두 완료했습니다.", "model"), state), true);
  });

  test("an honest model answer is not blocked, as before", () => {
    assert.equal(
      unsupportedCompletionIn(turn("아직 완료되지 않았습니다. 다음은 pytest 입니다.", "model"), state),
      false,
    );
  });
});

// --- quoted data is not an assertion ----------------------------------------

describe("what is quoted is not promoted to a runtime claim", () => {
  test("a requirement whose own text says 완료 stays in the quoted half", () => {
    const state = task({
      requirements: [
        requirement({ id: "r1", description: "완료 여부 확인 및 보고", status: "pending" }),
        requirement({ id: "r2", description: "코드 실행", status: "passed" }),
      ],
    });
    const summary = safeFallback(state, taskDisposition(state));

    assert.ok(
      summary.quoted.some((s) => s.items.includes("완료 여부 확인 및 보고")),
      "the requirement text is quoted",
    );
    assert.ok(
      !summary.verdict.some((line) => line.includes("완료 여부 확인 및 보고")),
      "and is not among the runtime's assertions",
    );
    // The live escape: this exact shape was counted as a false completion claim.
    assert.equal(
      validateRuntimeSummary(summary, { task: state, disposition: taskDisposition(state) }).valid,
      true,
    );
  });

  test("issue detail and file names are quoted too", () => {
    const state = task({
      requirements: [requirement({ status: "failed" })],
      issues: [
        { id: "i1", summary: "run_command", detail: "전부 완료됨", at: 1, status: "open" },
      ] as TaskState["issues"],
      changedFiles: ["완료.py"],
    });
    const summary = safeFallback(state, taskDisposition(state));
    assert.ok(!summary.verdict.join("\n").includes("전부 완료됨"));
    assert.ok(!summary.verdict.join("\n").includes("완료.py"));
    assert.equal(
      validateRuntimeSummary(summary, { task: state, disposition: taskDisposition(state) }).valid,
      true,
    );
  });

  test("the rendered text marks the quoted block for a reader as well", () => {
    const state = task({ requirements: [requirement({ status: "passed" })] });
    const summary = safeFallback(state, taskDisposition(state));
    assert.match(summary.text, /기록된 항목/);
  });

  test("nothing to quote leaves the block out entirely", () => {
    const summary = safeFallback(task(), "active");
    assert.equal(summary.quoted.length, 0);
    assert.ok(!summary.text.includes("기록된 항목"));
  });
});

// --- every task shape ------------------------------------------------------

describe("the runtime's assertions pass its own gate, whatever the record", () => {
  const shapes: Array<{ name: string; state: TaskState; termination?: string }> = [
    { name: "empty", state: task() },
    {
      name: "blocked",
      state: task({ status: "blocked", requirements: [requirement({ status: "blocked" })] }),
    },
    { name: "failed", state: task({ requirements: [requirement({ status: "failed" })] }) },
    { name: "pending", state: task({ requirements: [requirement({ status: "pending" })] }) },
    {
      name: "no_progress",
      state: task({ requirements: [requirement({ status: "passed" })] }),
      termination: "no_progress",
    },
    {
      name: "mixed, with quoted text containing completion words",
      state: task({
        requirements: [
          requirement({ id: "r1", description: "학습 완료 확인", status: "passed" }),
          requirement({ id: "r2", description: "모든 테스트 통과 확인", status: "pending" }),
        ],
      }),
    },
  ];

  for (const { name, state, termination } of shapes) {
    test(name, () => {
      const disposition = taskDisposition(state, termination);
      const summary = safeFallback(state, disposition, termination);
      const result = validateRuntimeSummary(summary, {
        task: state,
        disposition,
        ...(termination === undefined ? {} : { termination }),
      });
      assert.equal(
        result.valid,
        true,
        `refused its own words: ${result.violations.map((v) => `${v.kind} @ ${v.sentence}`).join(" | ")}`,
      );
    });
  }

  test("a null task still produces a deliverable summary", () => {
    const summary = safeFallback(null, "active");
    assert.ok(isRuntimeSummary(summary));
    assert.equal(validateRuntimeSummary(summary, { task: null, disposition: "active" }).valid, true);
  });
});

// --- no regression on the ordinary path -------------------------------------

describe("the model path is unchanged", () => {
  const state = task({ requirements: [requirement({ status: "pending" })] });

  test("validateFinalClaims still refuses an unsupported completion", () => {
    const result = validateFinalClaims({
      task: state,
      disposition: taskDisposition(state),
      text: "모든 작업을 완료했습니다.",
    });
    assert.equal(result.valid, false);
  });

  test("validateFinalClaims still allows an honest answer", () => {
    const result = validateFinalClaims({
      task: state,
      disposition: taskDisposition(state),
      text: "코드 실행은 아직 하지 않았습니다.",
    });
    assert.equal(result.valid, true);
  });

  test("a turn that produced no answer is not a claim either way", () => {
    assert.equal(unsupportedCompletionIn(turn("", "model"), state), false);
    assert.equal(unsupportedCompletionIn(turn("", "runtime"), state), false);
  });
});
