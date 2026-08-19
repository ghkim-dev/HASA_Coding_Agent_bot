import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  BARREN_TURN_CHALLENGE_AT,
  barrenTurnChallenge,
  barrenWorkTurns,
  bootstrapHistoryFrom,
  executionCounts,
  guardRelation,
  isBareContinuation,
  isRepetitionComplaint,
  isStatusQuestion,
  looksLikeSameTask,
  stateContradictions,
  statusAnswerFrom,
} from "./continuity.ts";
import {
  emptyContract,
  mergeContract,
  activeRequirements,
  type Requirement,
  type TaskContract,
  type TurnContract,
  type TurnRelation,
} from "./turnContract.ts";
import { reduceTask } from "./taskReducer.ts";
import type { SessionEvent } from "./sessionEvents.ts";

/**
 * The transcript that motivated C4.9, replayed as a fixture.
 *
 * Seven user turns from a real conversation. T1 states a whole project; every
 * later turn is a follow-up — and in the live run, almost every one of them was
 * read as a fresh task, which replaced the contract, restarted the plan, and
 * left the user re-explaining their request without knowing it.
 *
 * The expected relations are conceptual and mapped onto this codebase's
 * vocabulary: "retry" is `continue` with an execute intent, and a permission
 * refinement is `refine`. What must never happen is any of T2–T7 becoming
 * `new_task`.
 */
const T1 =
  "개와 고양이 분류 모델 프로젝트를 진행해줘. CNN부터 ViT까지 다양한 모델을 10개 정도 학습하고, " +
  "웹과 Hugging Face를 참고해서 추론과 성능 비교까지 하고 결과를 저장하고 보고해줘.";
const T2 = "작업 진행해줘.";
const T3 = "현재 디렉토리에서 진행해줘.";
const T4 = "진행된 게 없는데 다시 확인해줘.";
const T5 = "다시 실행해봐.";
const T6 = "승인은 다 해놓았으니 알아서 실험하고 결과만 알려줘.";
const T7 = "알아서 실행해달라니까 왜 반복하는 거야.";

const T1_REQUIREMENTS = [
  "개와 고양이 이진 분류",
  "CNN 모델 구현",
  "ViT 등 Transformer 모델 구현",
  "약 10개 모델 학습",
  "웹과 Hugging Face 참고",
  "추론 실행",
  "성능 비교",
  "결과 저장",
  "결과 보고",
];

function requirement(turnId: string, index: number, description: string): Requirement {
  return {
    id: `${turnId}-r${index + 1}`,
    description,
    required: true,
    provenance: { sourceTurnId: turnId, origin: "explicit" },
    lifecycle: "active",
  };
}

function contractOf(
  turnId: string,
  relation: TurnRelation,
  requirements: readonly string[],
  goal = "요청 처리",
): TurnContract {
  return {
    turnId,
    relation,
    goal,
    intents: ["execute"],
    requirements: requirements.map((r, i) => requirement(turnId, i, r)),
    deliverables: [],
    constraints: [],
  };
}

/** The standing task after T1, for every guard test that needs one. */
function taskAfterT1(): TaskContract {
  return mergeContract(emptyContract(), contractOf("t1", "new_task", T1_REQUIREMENTS, T1));
}

// ---------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------

describe("recognising a bare continuation", () => {
  test("the transcript's own follow-ups", () => {
    assert.equal(isBareContinuation(T2), true);
    assert.equal(isBareContinuation(T5), true);
    assert.equal(isBareContinuation("이어서 해줘"), true);
    assert.equal(isBareContinuation("계속해줘"), true);
    assert.equal(isBareContinuation("proceed"), true);
  });

  test("a message that adds anything is not bare", () => {
    // T3 refines the workspace; T6 refines permissions. Both carry content the
    // model must read, so the deterministic layer stays out of the way.
    assert.equal(isBareContinuation(T1), false);
    assert.equal(isBareContinuation(T3), false);
    assert.equal(isBareContinuation(T6), false);
    assert.equal(isBareContinuation("CNN부터 구현해줘"), false);
    assert.equal(isBareContinuation(""), false);
  });
});

describe("recognising a status question", () => {
  test("asking where the work stands", () => {
    assert.equal(isStatusQuestion(T4), true);
    assert.equal(isStatusQuestion("지금 진행하고 있는게 맞지?"), true);
    assert.equal(isStatusQuestion("어디까지 했어?"), true);
    assert.equal(isStatusQuestion("진행 상황 좀 알려줘"), true);
  });

  test("a status phrase attached to new work is a request", () => {
    assert.equal(isStatusQuestion("진행된 게 없는데 CNN부터 구현해줘"), false);
    assert.equal(isStatusQuestion("어디까지 했어? 이제 테스트를 작성해줘"), false);
  });

  test("a continuation is not a question", () => {
    assert.equal(isStatusQuestion(T2), false);
    assert.equal(isStatusQuestion(T5), false);
  });
});

describe("recognising a repetition complaint", () => {
  test("the transcript's T7", () => {
    assert.equal(isRepetitionComplaint(T7), true);
    assert.equal(isRepetitionComplaint("왜 자꾸 같은 계획만 보여줘?"), true);
  });
  test("ordinary messages are not complaints", () => {
    assert.equal(isRepetitionComplaint(T2), false);
    assert.equal(isRepetitionComplaint(T1), false);
  });
});

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

describe("guarding the relation", () => {
  test("T2 misread as new_task becomes continue, and the task survives", () => {
    const prior = taskAfterT1();
    // The interpreter, shown no history, records a fresh task with its own
    // paraphrase — exactly what the live run did.
    const misread = contractOf("t2", "new_task", ["작업을 진행한다"]);
    const guarded = guardRelation(misread, { userText: T2, priorTask: prior });

    assert.equal(guarded.contract.relation, "continue");
    assert.equal(guarded.override?.reason, "bare_continuation");
    assert.deepEqual(guarded.override?.droppedRequirements, ["작업을 진행한다"]);

    const merged = mergeContract(prior, guarded.contract);
    assert.equal(activeRequirements(merged).length, T1_REQUIREMENTS.length);
    assert.equal(merged.goal, T1);
  });

  test("T4 misread as new_task becomes question", () => {
    const guarded = guardRelation(contractOf("t4", "new_task", ["진행 상황을 확인한다"]), {
      userText: T4,
      priorTask: taskAfterT1(),
    });
    assert.equal(guarded.contract.relation, "question");
    assert.equal(guarded.override?.reason, "status_question");
  });

  test("T5 misread as new_task becomes continue", () => {
    const guarded = guardRelation(contractOf("t5", "new_task", ["다시 실행한다"]), {
      userText: T5,
      priorTask: taskAfterT1(),
    });
    assert.equal(guarded.contract.relation, "continue");
  });

  test("T7 misread as new_task becomes correct", () => {
    const guarded = guardRelation(contractOf("t7", "new_task", ["알아서 실행한다"]), {
      userText: T7,
      priorTask: taskAfterT1(),
    });
    assert.equal(guarded.contract.relation, "correct");
    assert.equal(guarded.override?.reason, "repetition_complaint");
  });

  test("a restated task merges as refine instead of replacing", () => {
    // T3 read as new_task, carrying a paraphrase of the standing requirements.
    // Accepting the replacement is how ten requirements became one.
    const restated = contractOf("t3", "new_task", [
      "개와 고양이를 분류하는 모델 학습",
      "CNN 모델을 구현",
      "ViT 모델을 구현",
      "모델 성능 비교",
    ]);
    const prior = taskAfterT1();
    const guarded = guardRelation(restated, { userText: T3, priorTask: prior });

    assert.equal(guarded.contract.relation, "refine");
    assert.equal(guarded.override?.reason, "same_task_restated");
    const merged = mergeContract(prior, guarded.contract);
    // Nothing lost. Near-duplicates may add, but every original must survive.
    for (const description of T1_REQUIREMENTS) {
      assert.ok(
        activeRequirements(merged).some((r) => r.description === description),
        `lost: ${description}`,
      );
    }
  });

  test("a genuinely new task mid-conversation is left alone", () => {
    const fresh = contractOf("t8", "new_task", ["README의 오타를 수정"], "완전히 다른 작업");
    const guarded = guardRelation(fresh, {
      userText: "이제 완전히 다른 작업이야. README의 오타를 고쳐줘.",
      priorTask: taskAfterT1(),
    });
    assert.equal(guarded.contract.relation, "new_task");
    assert.equal(guarded.override, null);
  });

  test("the first turn is never touched", () => {
    const first = contractOf("t1", "new_task", T1_REQUIREMENTS, T1);
    const guarded = guardRelation(first, { userText: T1, priorTask: emptyContract() });
    assert.equal(guarded.override, null);
    assert.equal(guarded.contract.requirements.length, T1_REQUIREMENTS.length);
  });

  test("a correct relation from the model passes through untouched", () => {
    const refined = contractOf("t3", "refine", ["현재 디렉토리에서 작업"]);
    const guarded = guardRelation(refined, { userText: T3, priorTask: taskAfterT1() });
    assert.equal(guarded.override, null);
    assert.equal(guarded.contract.requirements.length, 1);
  });
});

describe("the transcript end to end", () => {
  test("T1 through T7 never lose a requirement, even when every relation is misread", () => {
    // Worst case: the interpreter calls every follow-up a new task. The guard
    // is the only thing standing between that and a reset per turn.
    const turns: Array<{ turnId: string; text: string; misread: TurnContract }> = [
      { turnId: "t2", text: T2, misread: contractOf("t2", "new_task", ["작업을 진행한다"]) },
      {
        turnId: "t3",
        text: T3,
        misread: contractOf("t3", "new_task", ["개와 고양이 분류 모델을 학습", "CNN 모델을 구현", "성능 비교"]),
      },
      { turnId: "t4", text: T4, misread: contractOf("t4", "new_task", ["진행 상황 확인"]) },
      { turnId: "t5", text: T5, misread: contractOf("t5", "new_task", ["다시 실행"]) },
      {
        turnId: "t6",
        text: T6,
        misread: contractOf("t6", "new_task", ["개와 고양이 분류 실험을 진행", "모델을 학습", "결과만 보고"]),
      },
      { turnId: "t7", text: T7, misread: contractOf("t7", "new_task", ["알아서 실행"]) },
    ];

    let task = taskAfterT1();
    for (const turn of turns) {
      const guarded = guardRelation(turn.misread, { userText: turn.text, priorTask: task });
      assert.notEqual(guarded.contract.relation, "new_task", `${turn.turnId} reset the task`);
      const before = activeRequirements(task).length;
      task = mergeContract(task, guarded.contract);
      assert.ok(
        activeRequirements(task).length >= before,
        `${turn.turnId} shrank the requirement set`,
      );
    }
    for (const description of T1_REQUIREMENTS) {
      assert.ok(
        activeRequirements(task).some((r) => r.description === description),
        `lost by the end: ${description}`,
      );
    }
    assert.equal(task.goal, T1);
  });
});

describe("looksLikeSameTask", () => {
  test("a paraphrase of the standing requirements is the same task", () => {
    const prior = taskAfterT1();
    const incoming = contractOf("tx", "new_task", [
      "개와 고양이 분류 모델 학습",
      "CNN 모델 구현하기",
      "성능 비교 진행",
    ]).requirements;
    assert.equal(looksLikeSameTask(prior.requirements, incoming), true);
  });

  test("different work is a different task", () => {
    const prior = taskAfterT1();
    const incoming = contractOf("tx", "new_task", [
      "README 오타 수정",
      "CI 파이프라인 구성",
    ]).requirements;
    assert.equal(looksLikeSameTask(prior.requirements, incoming), false);
  });

  test("an empty side can never match", () => {
    assert.equal(looksLikeSameTask([], contractOf("tx", "new_task", ["a b c"]).requirements), false);
    assert.equal(looksLikeSameTask(taskAfterT1().requirements, []), false);
  });
});

// ---------------------------------------------------------------------------
// Events, for the record-reading half
// ---------------------------------------------------------------------------

let ordinal = 0;
function base(turnId: string, at: number): { id: string; turnId: string; at: number } {
  ordinal += 1;
  return { id: `e${ordinal}`, turnId, at };
}

function userMessage(turnId: string, at: number, text: string): SessionEvent {
  return { type: "user_message", ...base(turnId, at), text };
}

function contractEvent(turnId: string, at: number, intents: string[]): SessionEvent {
  return {
    type: "turn_contract",
    ...base(turnId, at),
    contract: {
      turnId,
      relation: "continue",
      goal: "작업",
      intents,
      requirements: [],
      deliverables: [],
      constraints: [],
    },
  };
}

function toolDone(
  turnId: string,
  at: number,
  toolName: string,
  disposition: "executed_success" | "executed_failure" | "deferred" | "denied",
): SessionEvent {
  return {
    type: "tool_completed",
    ...base(turnId, at),
    callId: `c${ordinal}`,
    toolName,
    status: disposition === "executed_success" ? "success" : disposition === "executed_failure" ? "failed" : "blocked",
    disposition,
    detail: "…",
  };
}

function runDone(turnId: string, at: number, summary = ""): SessionEvent {
  return { type: "run_completed", ...base(turnId, at), reason: "finished", summary };
}

function assistant(turnId: string, at: number, text: string): SessionEvent {
  return { type: "assistant_text", ...base(turnId, at), text };
}

describe("executionCounts", () => {
  test("declarative tools do not count as execution", () => {
    const events: SessionEvent[] = [
      userMessage("t1", 1, T1),
      toolDone("t1", 2, "record_request", "executed_success"),
      toolDone("t1", 3, "update_plan", "executed_success"),
      toolDone("t1", 4, "report_blocked", "executed_success"),
    ];
    assert.deepEqual(executionCounts(events), { executed: 0, failed: 0, filesChanged: 0 });
  });

  test("real work counts, failures separately, files once", () => {
    const events: SessionEvent[] = [
      userMessage("t1", 1, T1),
      toolDone("t1", 2, "run_command", "executed_success"),
      toolDone("t1", 3, "run_command", "executed_failure"),
      { type: "file_changed", ...base("t1", 4), path: "a.py", change: "created" },
      { type: "file_changed", ...base("t1", 5), path: "a.py", change: "modified" },
    ];
    assert.deepEqual(executionCounts(events), { executed: 2, failed: 1, filesChanged: 1 });
  });

  test("a deferred call never counts as executed", () => {
    const events: SessionEvent[] = [
      userMessage("t1", 1, T1),
      toolDone("t1", 2, "run_command", "deferred"),
      toolDone("t1", 3, "run_command", "denied"),
    ];
    assert.equal(executionCounts(events).executed, 0);
  });
});

describe("answering a status question from the record", () => {
  test("nothing ran: says so, and says nothing is running", () => {
    const events: SessionEvent[] = [
      userMessage("t1", 1, T1),
      toolDone("t1", 2, "record_request", "executed_success"),
      { type: "plan", ...base("t1", 3), steps: ["데이터 준비", "학습"], current: 1 },
      runDone("t1", 4),
      userMessage("t2", 5, T4),
    ];
    const answer = statusAnswerFrom(events, reduceTask(events));
    assert.match(answer, /아직 실행된 작업이 없습니다/);
    assert.match(answer, /실행 중인 프로세스는 없습니다/);
    // The record's own denominators, not the model's account.
    assert.match(answer, /아직 실행 안 함/);
  });

  test("work happened: counts come from the events", () => {
    const events: SessionEvent[] = [
      userMessage("t1", 1, T1),
      toolDone("t1", 2, "run_command", "executed_success"),
      { type: "file_changed", ...base("t1", 3), path: "train.py", change: "created" },
      runDone("t1", 4),
      userMessage("t2", 5, T4),
    ];
    const answer = statusAnswerFrom(events, reduceTask(events));
    assert.match(answer, /도구를 1회 실행했고/);
    assert.match(answer, /파일 1개가 변경되었습니다/);
  });
});

describe("progress across turns", () => {
  function barrenTurn(turnId: string, at: number): SessionEvent[] {
    return [
      userMessage(turnId, at, T2),
      contractEvent(turnId, at + 1, ["execute"]),
      toolDone(turnId, at + 2, "record_request", "executed_success"),
      toolDone(turnId, at + 3, "update_plan", "executed_success"),
      runDone(turnId, at + 4),
    ];
  }

  test("turns that plan and never act are counted from the tail", () => {
    const events = [...barrenTurn("t1", 10), ...barrenTurn("t2", 20)];
    assert.equal(barrenWorkTurns(events), 2);
    assert.ok(barrenTurnChallenge(events) !== null);
    assert.match(barrenTurnChallenge(events)!, /실행된 도구가 없습니다/);
  });

  test("one barren turn is not yet a pattern", () => {
    const events = [...barrenTurn("t1", 10)];
    assert.equal(barrenWorkTurns(events), 1);
    assert.ok(BARREN_TURN_CHALLENGE_AT > 1);
    assert.equal(barrenTurnChallenge(events), null);
  });

  test("a turn that executed anything breaks the streak", () => {
    const worked: SessionEvent[] = [
      userMessage("t0", 1, T1),
      contractEvent("t0", 2, ["execute"]),
      toolDone("t0", 3, "run_command", "executed_success"),
      runDone("t0", 4),
    ];
    const events = [...worked, ...barrenTurn("t1", 10)];
    assert.equal(barrenWorkTurns(events), 1);
  });

  test("a question turn is not a barren work turn", () => {
    const question: SessionEvent[] = [
      userMessage("t1", 1, "이 코드 뭐 하는 거야?"),
      contractEvent("t1", 2, ["discuss"]),
      runDone("t1", 3),
    ];
    assert.equal(barrenWorkTurns([...question]), 0);
  });

  test("a live turn is not counted until it completes", () => {
    const events = [...barrenTurn("t1", 10), ...barrenTurn("t2", 20)];
    const live = [...events, userMessage("t3", 30, T2), contractEvent("t3", 31, ["execute"])];
    // The two *completed* barren turns still count; the running one does not.
    assert.equal(barrenWorkTurns(live), 2);
  });
});

describe("history for the interpreter", () => {
  test("user words and final summaries, in order", () => {
    const events: SessionEvent[] = [
      userMessage("t1", 1, T1),
      toolDone("t1", 2, "run_command", "executed_success"),
      runDone("t1", 3, "데이터셋 스크립트를 만들었습니다."),
      userMessage("t2", 4, T2),
      runDone("t2", 5, ""),
    ];
    const history = bootstrapHistoryFrom(events);
    assert.deepEqual(
      history.map((m) => m.role),
      ["user", "assistant", "user"],
    );
    assert.equal(history[0]?.content, T1);
    // An empty summary is not a message.
    assert.equal(history.length, 3);
  });

  test("long messages are clipped, not dropped", () => {
    const events: SessionEvent[] = [userMessage("t1", 1, "가".repeat(2000))];
    const history = bootstrapHistoryFrom(events);
    assert.equal(history.length, 1);
    assert.ok(history[0]!.content.length <= 601);
  });
});

describe("state contradictions", () => {
  test("done in one turn, not started in the next, nothing observed between", () => {
    const events: SessionEvent[] = [
      userMessage("t1", 1, T1),
      assistant("t1", 2, "데이터셋 다운로드를 완료했습니다."),
      runDone("t1", 3),
      userMessage("t2", 4, T4),
      assistant("t2", 5, "데이터셋 다운로드가 아직 되지 않았습니다."),
      runDone("t2", 6),
    ];
    const found = stateContradictions(events);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.claimedDoneAt, "t1");
    assert.equal(found[0]?.reversedAt, "t2");
  });

  test("evidence between the claims clears the pair", () => {
    const events: SessionEvent[] = [
      userMessage("t1", 1, T1),
      assistant("t1", 2, "데이터셋 다운로드를 완료했습니다."),
      userMessage("t2", 3, T5),
      toolDone("t2", 4, "run_command", "executed_failure"),
      assistant("t2", 5, "데이터셋 다운로드가 아직 되지 않았습니다."),
    ];
    assert.equal(stateContradictions(events).length, 0);
  });

  test("claims about different things do not pair", () => {
    const events: SessionEvent[] = [
      userMessage("t1", 1, T1),
      assistant("t1", 2, "데이터셋 다운로드를 완료했습니다."),
      userMessage("t2", 3, T2),
      assistant("t2", 4, "모델 학습이 아직 시작되지 않았습니다."),
    ];
    assert.equal(stateContradictions(events).length, 0);
  });

  test("the runtime state itself never moves on prose", () => {
    // The other half of §10: a contradiction is recorded about the *story*;
    // the record is untouched by either sentence.
    const events: SessionEvent[] = [
      userMessage("t1", 1, T1),
      { type: "plan", ...base("t1", 2), steps: ["데이터셋 다운로드"], current: 1 },
      assistant("t1", 3, "데이터셋 다운로드를 완료했습니다."),
    ];
    const task = reduceTask(events);
    assert.equal(task?.requirements[0]?.status, "pending");
    assert.equal(task?.changedFiles.length, 0);
    assert.equal(task?.evidence.length, 0);
  });
});

describe("continue and question merges are inert even when the model adds baggage", () => {
  // Pinned after the first mutation sweep: replacing the continue/question
  // branch of `mergeContract` with a fall-through to `refine` survived every
  // test (M108), because every fixture's continuation arrived empty-handed —
  // as the guard produces them. Models on their own do attach requirements to
  // a `continue`, and the merge is the last thing standing between that and
  // the task quietly growing steps nobody asked for.

  test("a continue carrying requirements adds none of them", () => {
    const prior = taskAfterT1();
    const merged = mergeContract(prior, contractOf("t2", "continue", ["새로 지어낸 요구사항"]));
    assert.equal(activeRequirements(merged).length, T1_REQUIREMENTS.length);
    assert.ok(!activeRequirements(merged).some((r) => r.description === "새로 지어낸 요구사항"));
  });

  test("a question carrying requirements adds none of them", () => {
    const prior = taskAfterT1();
    const merged = mergeContract(prior, contractOf("t2", "question", ["상태를 확인한다"]));
    assert.equal(activeRequirements(merged).length, T1_REQUIREMENTS.length);
  });

  test("a continue carrying deliverables adds none of them", () => {
    const prior = taskAfterT1();
    const withDeliverable: TurnContract = {
      ...contractOf("t2", "continue", []),
      deliverables: [
        {
          id: "t2-d1",
          description: "지어낸 산출물",
          provenance: { sourceTurnId: "t2", origin: "explicit" },
          lifecycle: "active",
        },
      ],
    };
    const merged = mergeContract(prior, withDeliverable);
    assert.equal(merged.deliverables.length, prior.deliverables.length);
  });
});
