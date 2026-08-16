import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { taskDisposition, validateFinalClaims } from "./finalClaims.ts";
import type { Evidence, RequirementState, TaskState } from "./taskState.ts";
import { defaultSummary } from "./loop.ts";

/**
 * The boundary between what a model says and what a user is told.
 *
 * This gate had no direct test until the first live sweep produced seventeen
 * completion claims that reached the answer against a record that did not
 * support them. Eleven thousand tests passed while it did — which is what an
 * untested boundary looks like from the inside.
 *
 * The claim shapes below are the ones real models produced, redacted. They are
 * fixtures rather than a list of forbidden phrases: what each asserts is that a
 * claim is refused *because the record cannot support it*, not because the
 * wording was recognised. The two coincide here and must not be confused —
 * §4 of the brief is explicit that string matching is a second line and the
 * requirement/evidence state is the first.
 */

// --- fixtures ---------------------------------------------------------------

function requirement(over: Partial<RequirementState> = {}): RequirementState {
  return {
    id: "r1",
    description: "divide 함수의 0 나누기 버그를 고친다",
    status: "pending",
    required: true,
    evidence: [],
    ...over,
  };
}

function evidence(over: Partial<Evidence> = {}): Evidence {
  return {
    id: "e1",
    kind: "test_result",
    source: "run_command",
    status: "passed",
    observation: "pytest exited 0",
    at: 1,
    ...over,
  } as Evidence;
}

function task(over: Partial<TaskState> = {}): TaskState {
  return {
    taskId: "t1",
    goal: "버그를 고친다",
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

const kinds = (r: ReturnType<typeof validateFinalClaims>): string[] =>
  r.violations.map((v) => v.kind);

// --- the defect ------------------------------------------------------------

describe("an empty record cannot support a claim", () => {
  /**
   * Ten of the seventeen live escapes came through here. The turn recorded no
   * contract, so `task` was null, so the gate returned valid and every sentence
   * went out unexamined.
   */
  test("a completion claim with no task record at all is refused", () => {
    const result = validateFinalClaims({
      task: null,
      disposition: taskDisposition(null),
      text: "요청하신 작업을 모두 완료했습니다.",
    });
    assert.equal(result.valid, false);
    assert.deepEqual(kinds(result), ["UNSUPPORTED_COMPLETION"]);
  });

  test("a test-success claim with no record is refused", () => {
    const result = validateFinalClaims({
      task: null,
      disposition: taskDisposition(null),
      text: "모든 테스트가 통과했습니다.",
    });
    assert.equal(result.valid, false);
    assert.ok(kinds(result).includes("UNSUPPORTED_TEST_SUCCESS"));
  });

  test("an answer that claims nothing is still allowed with no record", () => {
    // The fix must not turn "no record" into "refuse everything". A turn that
    // answers a question has nothing to support and nothing to claim.
    const result = validateFinalClaims({
      task: null,
      disposition: taskDisposition(null),
      text: "src/inventory.py 는 전역 상태를 파일에 직접 씁니다. 세 가지 구조적 문제가 보입니다.",
    });
    assert.equal(result.valid, true);
  });

  test("an honest refusal with no record is allowed", () => {
    const result = validateFinalClaims({
      task: null,
      disposition: taskDisposition(null),
      text: "아직 완료되지 않았습니다. 무엇부터 볼지 알려주세요.",
    });
    assert.equal(result.valid, true);
  });
});

// --- §6 the shapes that actually escaped ------------------------------------

describe("claim shapes taken from real escaped answers", () => {
  const empty = task();

  const REFUSED = [
    "모든 작업이 완료되었습니다.",
    "테스트까지 모두 통과했습니다.",
    "성공적으로 구현했습니다.",
    "Everything is done.",
    "All tests pass.",
    "Implementation is complete.",
    "코드는 수정했습니다. 전체 완료입니다.",
    "요구사항을 모두 충족했습니다.",
  ];

  for (const text of REFUSED) {
    test(`refused against an empty record: ${text}`, () => {
      const result = validateFinalClaims({
        task: empty,
        disposition: taskDisposition(empty),
        text,
      });
      assert.equal(result.valid, false, `"${text}" was allowed`);
    });
  }

  const ALLOWED = [
    "완료하려면 테스트가 더 필요합니다.",
    "아직 완료되지 않았습니다.",
    "테스트가 통과했다고 말할 수 없습니다.",
    "작업을 완료하지 못했습니다.",
  ];

  for (const text of ALLOWED) {
    test(`not a false positive: ${text}`, () => {
      const result = validateFinalClaims({
        task: empty,
        disposition: taskDisposition(empty),
        text,
      });
      assert.equal(result.valid, true, `"${text}" was refused`);
    });
  }

  test("a completion word attached to an admission is still a claim", () => {
    // The shape a report takes when it wants to be read as success.
    const result = validateFinalClaims({
      task: empty,
      disposition: taskDisposition(empty),
      text: "작업은 끝났지만 테스트는 실행하지 못했습니다.",
    });
    assert.equal(result.valid, false);
  });
});

// --- §7 completion invariants ----------------------------------------------

describe("completion needs the record, not the wording", () => {
  test("a requirement that passed may be named as done", () => {
    const done = task({
      requirements: [requirement({ status: "passed" })],
      evidence: [evidence()],
    });
    const result = validateFinalClaims({
      task: done,
      disposition: taskDisposition(done),
      text: "divide 함수의 0 나누기 버그를 고쳤습니다.",
    });
    assert.equal(result.valid, true);
  });

  test("one passed requirement does not license a claim about the whole", () => {
    const partial = task({
      requirements: [
        requirement({ id: "r1", status: "passed" }),
        requirement({ id: "r2", description: "pytest 로 확인한다", status: "failed" }),
      ],
    });
    const result = validateFinalClaims({
      task: partial,
      disposition: taskDisposition(partial),
      text: "요구사항을 모두 완료했습니다.",
    });
    assert.equal(result.valid, false);
    assert.ok(kinds(result).includes("UNSUPPORTED_COMPLETION"));
    // The refusal quotes what is left rather than saying "no".
    assert.match(result.violations[0]?.detail ?? "", /pytest/);
  });

  test("naming a finished piece does not license a claim about the whole", () => {
    // The case the totality rule exists for, and the one the earlier version of
    // this test missed: the sentence *does* name a requirement that passed, so
    // the scoping rule would allow it on that ground alone. `모든` is what makes
    // it a claim about the task rather than about the piece.
    const partial = task({
      requirements: [
        requirement({ id: "r1", description: "divide 버그를 고친다", status: "passed" }),
        requirement({ id: "r2", description: "pytest 로 확인한다", status: "failed" }),
      ],
    });

    const scoped = validateFinalClaims({
      task: partial,
      disposition: taskDisposition(partial),
      text: "divide 버그를 고쳤습니다.",
    });
    assert.equal(scoped.valid, true, "the piece may be reported as done");

    const whole = validateFinalClaims({
      task: partial,
      disposition: taskDisposition(partial),
      text: "divide 버그를 포함해 모든 작업을 완료했습니다.",
    });
    assert.equal(whole.valid, false, "the same piece plus 모든 is a claim about the task");
  });

  test("a test-pass claim without a passed test result is refused", () => {
    const noTest = task({ requirements: [requirement({ status: "passed" })] });
    const result = validateFinalClaims({
      task: noTest,
      disposition: taskDisposition(noTest),
      text: "테스트가 모두 통과했습니다.",
    });
    assert.equal(result.valid, false);
    assert.ok(kinds(result).includes("UNSUPPORTED_TEST_SUCCESS"));
  });

  test("a failed test result does not support a test-pass claim", () => {
    const failed = task({
      requirements: [requirement({ status: "failed" })],
      evidence: [evidence({ status: "failed", observation: "pytest exited 1" })],
    });
    const result = validateFinalClaims({
      task: failed,
      disposition: taskDisposition(failed),
      text: "테스트가 통과했습니다.",
    });
    assert.equal(result.valid, false);
    assert.ok(kinds(result).includes("UNSUPPORTED_TEST_SUCCESS"));
  });
});

describe("the run ending is not the task ending", () => {
  test("a step-limit termination cannot be reported as completion", () => {
    const stalled = task({ requirements: [requirement()] });
    const result = validateFinalClaims({
      task: stalled,
      disposition: taskDisposition(stalled, "max_steps"),
      text: "작업을 모두 마무리했습니다.",
    });
    assert.equal(result.valid, false);
  });

  test("a no-progress termination says so in the refusal", () => {
    const stuck = task({ requirements: [requirement()] });
    const result = validateFinalClaims({
      task: stuck,
      disposition: taskDisposition(stuck, "no_progress"),
      text: "전부 완료했습니다.",
      termination: "no_progress",
    });
    assert.equal(result.valid, false);
    assert.match(result.violations[0]?.detail ?? "", /실행 종료는 작업 완료가 아닙니다/);
  });

  test("work verified before the budget ran out is still complete", () => {
    // A run that ended untidily after the work was done is not an unfinished
    // task, and refusing the claim here would be the opposite error.
    const done = task({
      status: "completed",
      requirements: [requirement({ status: "passed" })],
      evidence: [evidence()],
    });
    assert.equal(taskDisposition(done, "max_steps"), "completed");
  });
});

describe("the runtime's own words pass the runtime's own gate", () => {
  /**
   * The invariant that would have caught this on the day it was written.
   *
   * `defaultSummary` is generated after the gate, from a stop reason and a file
   * count, and it reached the user unexamined. Its `finished` branch said
   * "완료했습니다" — an unconditional completion claim from a function that has
   * no access to the task record. Every one of the seventeen escaped claims in
   * the first live sweep was that string, and each was attributed to whichever
   * model had provoked the empty turn.
   *
   *     the harness blamed models for a sentence the harness wrote
   *
   * So the runtime's own text is now held to the boundary the model's text is
   * held to, against the emptiest record there is.
   */
  const REASONS = [
    "finished",
    "denied",
    "aborted",
    "timeout",
    "loop_detected",
    "max_steps",
    "max_model_calls",
    "max_tool_calls",
    "no_progress",
    "error",
  ] as const;

  for (const reason of REASONS) {
    for (const changed of [0, 3]) {
      test(`${reason} with ${changed} changed files makes no claim it cannot support`, () => {
        const empty = task();
        const result = validateFinalClaims({
          task: empty,
          disposition: taskDisposition(empty, reason),
          text: defaultSummary(reason as never, changed),
          termination: reason,
        });
        assert.equal(
          result.valid,
          true,
          `${reason}/${changed}: ${JSON.stringify(defaultSummary(reason as never, changed))} → ${result.violations
            .map((v) => v.kind)
            .join(",")}`,
        );
      });
    }
  }

  test("a finished turn that recorded nothing does not report completion", () => {
    const text = defaultSummary("finished" as never, 0);
    assert.ok(!/완료했습니다|완료됐습니다|all done/i.test(text), `still claims completion: ${text}`);
  });

  test("a file count is still reported, because it is an observation", () => {
    assert.match(defaultSummary("finished" as never, 2), /2개 파일/);
  });
});

describe("evidence is about the tree it ran against", () => {
  const passingTest = (at: number): Evidence => evidence({ id: `e${at}`, at });

  test("a passing run before the last edit does not support a test claim", () => {
    const stale = task({
      requirements: [requirement({ status: "passed" })],
      evidence: [passingTest(100)],
      changedFiles: ["src/stats.py"],
      lastChangeAt: 200,
    });
    const result = validateFinalClaims({
      task: stale,
      disposition: taskDisposition(stale),
      text: "테스트가 통과했습니다.",
    });
    assert.equal(result.valid, false);
    assert.ok(kinds(result).includes("UNSUPPORTED_TEST_SUCCESS"));
    // The refusal says which of the two problems it is, because they call for
    // different next actions.
    assert.match(result.violations[0]?.detail ?? "", /다시 실행/);
  });

  test("a passing run after the last edit does support it", () => {
    const fresh = task({
      requirements: [requirement({ status: "passed" })],
      evidence: [passingTest(300)],
      changedFiles: ["src/stats.py"],
      lastChangeAt: 200,
    });
    const result = validateFinalClaims({
      task: fresh,
      disposition: taskDisposition(fresh),
      text: "테스트가 통과했습니다.",
    });
    assert.equal(result.valid, true);
  });

  test("never having run is a different refusal from having run too early", () => {
    const never = task({ requirements: [requirement({ status: "passed" })], lastChangeAt: 200 });
    const result = validateFinalClaims({
      task: never,
      disposition: taskDisposition(never),
      text: "테스트가 통과했습니다.",
    });
    assert.equal(result.valid, false);
    assert.match(result.violations[0]?.detail ?? "", /돌린 적이 없으면/);
  });

  test("a run and an edit in the same millisecond count as fresh", () => {
    // Not ordered by this clock. Refusing on a tie would reject a legitimate
    // run for the resolution of a timestamp.
    const tied = task({
      requirements: [requirement({ status: "passed" })],
      evidence: [passingTest(200)],
      lastChangeAt: 200,
    });
    const result = validateFinalClaims({
      task: tied,
      disposition: taskDisposition(tied),
      text: "테스트가 통과했습니다.",
    });
    assert.equal(result.valid, true);
  });

  test("a workspace nothing changed leaves every observation fresh", () => {
    const untouched = task({
      requirements: [requirement({ status: "passed" })],
      evidence: [passingTest(1)],
    });
    assert.equal(untouched.lastChangeAt, 0);
    const result = validateFinalClaims({
      task: untouched,
      disposition: taskDisposition(untouched),
      text: "테스트가 통과했습니다.",
    });
    assert.equal(result.valid, true);
  });
});

describe("a state built outside the reducer still reads correctly", () => {
  test("a task with no change clock treats its evidence as fresh", () => {
    // The failure direction that matters. Reading an absent clock as the change
    // time makes every observation older than it, so every legitimate claim is
    // refused — the safe-looking mistake that silently breaks the gate for a
    // caller that constructed the state by hand rather than by reducing events.
    const noClock = {
      taskId: "t1",
      goal: "g",
      status: "active",
      requirements: [requirement({ status: "passed" })],
      issues: [],
      evidence: [evidence({ at: 5 })],
      changedFiles: [],
      sources: [],
      facts: [],
    } as unknown as TaskState;

    assert.equal((noClock as { lastChangeAt?: number }).lastChangeAt, undefined);

    const result = validateFinalClaims({
      task: noClock,
      disposition: taskDisposition(noClock),
      text: "테스트가 통과했습니다.",
    });
    assert.equal(result.valid, true, "an absent clock must not stale every observation");
  });
});
