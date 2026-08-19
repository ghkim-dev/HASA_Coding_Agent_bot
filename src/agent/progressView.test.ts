import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  STALL_DISPLAY_MS,
  describePhase,
  describePlanAbsence,
  progressView,
  type AgentProgressPhase,
} from "./progressView.ts";
import { emptyContract, mergeContract, parseTurnContract, type TaskContract } from "./turnContract.ts";
import type { SessionEvent } from "./sessionEvents.ts";

/**
 * The screen this file exists for.
 *
 * A turn whose model kept writing an unreadable tool call, which the loop handed
 * back twice and then gave up on, so the model's raw `record_request: …` became
 * the answer. The turn ended `finished` having settled nothing. The panel showed
 * `진행 중`, `0/1`, "계획에 아직 없습니다", no action — for as long as it stayed
 * open, because its only status was a `TaskDisposition` and `finished` with an
 * unmet requirement falls through that function to `active`.
 *
 * Every assertion below is about what the *record* can support. There is no
 * progress store: each case builds events, folds them, and checks the fold.
 */

const T0 = 1_700_000_000_000;
let seq = 0;
function id(turnId = "t1"): { id: string; turnId: string; at: number } {
  seq += 1;
  return { id: `e${seq}`, turnId, at: T0 + seq * 1000 };
}

const ASKED = {
  goal: "개와 고양이 분류 모델 학습",
  relation: "new_task",
  intents: "execute",
  requirements: "CNN 학습\n결과 저장",
};

function contractFrom(args: Record<string, unknown>, turnId = "t1"): TaskContract {
  const parsed = parseTurnContract(args, turnId);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.problem.reason);
  return mergeContract(emptyContract(), parsed.contract);
}

/** The events of a turn, in the order the runtime writes them. */
function userMessage(text = "개와 고양이 분류 모델을 학습시켜줘", turnId = "t1"): SessionEvent {
  return { type: "user_message", ...id(turnId), text };
}
function contractEvent(turnId = "t1"): SessionEvent {
  const parsed = parseTurnContract(ASKED, turnId);
  assert.ok(parsed.ok);
  return { type: "turn_contract", ...id(turnId), contract: parsed.contract } as SessionEvent;
}
function workerEvent(modelId: string | null, turnId = "t1"): SessionEvent {
  return {
    type: "worker_selected",
    ...id(turnId),
    selectionOrigin: "auto_recommendation",
    selectedModelId: modelId,
  } as SessionEvent;
}
function planEvent(steps: string[], turnId = "t1"): SessionEvent {
  return { type: "plan", ...id(turnId), steps, current: 0 } as SessionEvent;
}
function started(callId: string, summary: string, turnId = "t1"): SessionEvent {
  return {
    type: "tool_started",
    ...id(turnId),
    callId,
    toolName: "run_command",
    risk: "execute",
    summary,
  } as SessionEvent;
}
function completed(
  callId: string,
  outcome: { status: string; disposition?: string; detail?: string },
  turnId = "t1",
): SessionEvent {
  return {
    type: "tool_completed",
    ...id(turnId),
    callId,
    toolName: "run_command",
    status: outcome.status,
    ...(outcome.disposition === undefined ? {} : { disposition: outcome.disposition }),
    detail: outcome.detail ?? "",
  } as SessionEvent;
}
function done(reason: string, turnId = "t1"): SessionEvent {
  return { type: "run_completed", ...id(turnId), reason, summary: "" } as SessionEvent;
}
function notice(level: "info" | "warning" | "error", text: string, turnId = "t1"): SessionEvent {
  return { type: "notice", ...id(turnId), level, text } as SessionEvent;
}

/** The projection, at the moment the last event landed. */
function view(events: SessionEvent[], contract = contractFrom(ASKED), afterMs = 0) {
  const last = events.reduce((latest, e) => Math.max(latest, e.at), T0);
  const projected = progressView({ events, contract, now: last + afterMs });
  assert.ok(projected !== null, "이벤트가 있는데 projection 이 null 입니다");
  return projected;
}

describe("첨부 화면의 재현과 수정", () => {
  test("turn 이 끝났으면 진행 중이 아니다", () => {
    // The reported screen, as events: a contract from bootstrap, no plan, no
    // action, and a run that ended `finished`.
    const events = [userMessage(), contractEvent(), done("finished")];
    const progress = view(events);

    assert.equal(progress.terminalReason, "finished");
    assert.notEqual(progress.phase, "executing");
    assert.equal(progress.phase, "partial", "아무것도 정하지 못한 채 끝난 턴은 일부 완료입니다");
    assert.equal(describePhase(progress.phase), "일부만 완료");
  });

  test("계획이 없으면 이유를 말한다", () => {
    const events = [userMessage(), contractEvent(), workerEvent("glm-4.7"), done("finished")];
    const progress = view(events);
    assert.notEqual(progress.planAbsence, null, "계획 없음에 이유가 없습니다");
    assert.equal(progress.planAbsence, "worker_streaming");
    assert.ok(describePlanAbsence(progress.planAbsence).length > 0);
  });

  test("도구 호출을 읽지 못한 턴은 프로토콜 오류로 구분된다", () => {
    // The actual cause of the screen. A protocol problem is not a stall and not
    // a provider error; a user who is told which one can act on it.
    const events = [
      userMessage(),
      contractEvent(),
      workerEvent("glm-4.7"),
      notice("warning", "도구 호출 형식을 읽지 못했습니다"),
      done("finished"),
    ];
    const progress = view(events);
    assert.equal(progress.planAbsence, "protocol_error");
    assert.equal(describePlanAbsence("protocol_error"), "모델이 보낸 도구 호출을 읽지 못했습니다");
  });
});

describe("A~J 회귀 시나리오", () => {
  test("A. bootstrap 진행 중 → 요청 분석 중", () => {
    const progress = view([userMessage()], emptyContract());
    assert.equal(progress.phase, "interpreting");
    assert.equal(describePhase(progress.phase), "요청 분석 중");
  });

  test("B. 계약 완료, worker 없음 → 모델 선택 중", () => {
    const progress = view([userMessage(), contractEvent()]);
    assert.equal(progress.phase, "selecting_worker");
    assert.equal(progress.planAbsence, "waiting_for_worker");
  });

  test("B'. 계약 완료, 이전 턴 worker 승계 → 요청 분석 완료", () => {
    // Two turns: the first routed, the second did not need to. The phase says
    // "nothing is being selected" rather than pretending routing is running.
    const events = [
      userMessage("첫 요청", "t1"),
      workerEvent("glm-4.7", "t1"),
      done("finished", "t1"),
      userMessage("이어서 해줘", "t2"),
      contractEvent("t2"),
    ];
    const progress = view(events);
    assert.equal(progress.currentTurnId, "t2");
    assert.equal(progress.workerModelId, "glm-4.7");
    assert.equal(progress.phase, "contract_ready");
  });

  test("C. worker 호출 중, plan 없음 → 대기 상태와 이유가 함께 나온다", () => {
    const progress = view([userMessage(), contractEvent(), workerEvent("glm-4.7")]);
    assert.equal(progress.phase, "worker_selected");
    assert.equal(describePhase(progress.phase), "모델 응답 대기 중");
    // The failure this replaces: an empty "계획이 아직 없습니다" and nothing else.
    assert.equal(progress.planAbsence, "worker_streaming");
  });

  test("D. action 실행 중 → 무엇을 얼마나 하고 있는지 나온다", () => {
    const events = [
      userMessage(),
      contractEvent(),
      workerEvent("glm-4.7"),
      planEvent(["학습 스크립트 실행"]),
      started("c1", "`python train.py` 을(를) 실행합니다"),
    ];
    const progress = view(events, contractFrom(ASKED), 4000);
    assert.equal(progress.phase, "executing");
    assert.equal(progress.currentActionId, "c1");
    assert.equal(progress.currentActionType, "run_command");
    assert.equal(progress.actions.at(-1)?.state, "EXECUTING");
    assert.equal(progress.idleMs, 4000, "마지막 활동 이후 경과가 그대로 나옵니다");
    assert.ok(progress.elapsedMs >= 4000);
  });

  test("E. deferred action 은 실행됨이 아니다", () => {
    const events = [
      userMessage(),
      contractEvent(),
      workerEvent("glm-4.7"),
      started("c1", "`rm -rf build` 을(를) 실행합니다"),
      completed("c1", { status: "failed", disposition: "deferred", detail: "ACTION_REQUIRES_JUSTIFICATION" }),
    ];
    const progress = view(events);
    const action = progress.actions.find((a) => a.id === "c1");
    assert.equal(action?.state, "DEFERRED", "보류를 실패로 표시하면 안 됩니다");
    assert.notEqual(action?.state, "FAILED");
    assert.notEqual(action?.state, "EXECUTING");
    assert.ok(progress.timeline.some((t) => t.text.startsWith("승인 대기")));
  });

  test("E'. 정책 거부와 실행 실패는 다르다", () => {
    const events = [
      userMessage(),
      contractEvent(),
      started("c1", "명령 A"),
      completed("c1", { status: "failed", disposition: "denied", detail: "ACTION_DENIED_BY_CONSTRAINT" }),
      started("c2", "명령 B"),
      completed("c2", { status: "failed", disposition: "executed_failure", detail: "exit 1" }),
    ];
    const progress = view(events);
    assert.equal(progress.actions.find((a) => a.id === "c1")?.state, "DENIED");
    assert.equal(progress.actions.find((a) => a.id === "c2")?.state, "FAILED");
  });

  test("F. provider 실패 → 진행 중 배지가 남지 않는다", () => {
    const events = [
      userMessage(),
      contractEvent(),
      notice("error", "PROVIDER_REQUEST 실패: 400"),
      done("error"),
    ];
    const progress = view(events);
    assert.equal(progress.phase, "failed");
    assert.equal(progress.terminalReason, "error");
    assert.equal(progress.planAbsence, "worker_error");
    for (const label of ["요청 분석 중", "모델 응답 대기 중", "작업 실행 중"]) {
      assert.notEqual(describePhase(progress.phase), label);
    }
  });

  test("G. no-progress 종료 → stalled/중단이며 event 수는 진행도가 아니다", () => {
    const events = [
      userMessage(),
      contractEvent(),
      workerEvent("glm-4.7"),
      started("c1", "명령"),
      completed("c1", { status: "success", disposition: "executed_success" }),
      done("no_progress"),
    ];
    const progress = view(events);
    assert.equal(progress.phase, "failed");
    // Six events, one succeeded action, and nothing verified. No number here may
    // read as five-sixths of anything.
    assert.equal(progress.totalRequirementCount, 2);
    assert.equal(progress.verifiedRequirementCount, 0);
    assert.ok(!Object.keys(progress).includes("percent"));
  });

  test("H. reload → 지난 활동이 현재 활동으로 갱신되지 않는다", () => {
    const events = [userMessage(), contractEvent(), workerEvent("glm-4.7"), done("finished")];
    const last = events.reduce((latest, e) => Math.max(latest, e.at), T0);

    const live = progressView({ events, contract: contractFrom(ASKED), now: last });
    // Three days later, the same array. Only `now` moved.
    const reloaded = progressView({ events, contract: contractFrom(ASKED), now: last + 3 * 86_400_000 });
    assert.ok(live !== null && reloaded !== null);

    assert.equal(reloaded.lastActivityAt, live.lastActivityAt, "과거 타임스탬프가 갱신됐습니다");
    assert.equal(reloaded.phase, live.phase, "재시작으로 단계가 바뀌었습니다");
    assert.equal(reloaded.terminalReason, "finished");
    assert.deepEqual(
      reloaded.timeline.map((t) => t.text),
      live.timeline.map((t) => t.text),
    );
    // The only thing that may differ is how long ago it was.
    assert.ok(reloaded.idleMs > live.idleMs);
  });

  test("H'. 끝난 턴은 시간이 지나도 stalled 로 바뀌지 않는다", () => {
    const events = [userMessage(), contractEvent(), done("finished")];
    const progress = view(events, contractFrom(ASKED), STALL_DISPLAY_MS * 10);
    assert.equal(progress.phase, "partial", "종료된 턴을 응답 없음으로 바꾸면 안 됩니다");
  });

  test("I. branch → 형제 브랜치의 action 이 새지 않는다", () => {
    // The caller passes one branch's chain. A sibling's events are simply not in
    // it, and the projection reads nothing else.
    // The shared history already contains an action. It belongs to `t1` and must
    // not appear as either branch's current work — which is also the check that
    // catches a projection reading the whole array instead of the current turn.
    const shared = [
      userMessage("공통 요청", "t1"),
      contractEvent("t1"),
      started("shared1", "공통 턴의 명령", "t1"),
      completed("shared1", { status: "success", disposition: "executed_success" }, "t1"),
      done("finished", "t1"),
    ];
    const branchA = [...shared, userMessage("A 쪽 요청", "t2"), started("a1", "A 명령", "t2")];
    const branchB = [...shared, userMessage("B 쪽 요청", "t3")];

    const a = view(branchA);
    const b = view(branchB);
    assert.equal(a.currentTurnId, "t2");
    assert.equal(b.currentTurnId, "t3");
    assert.deepEqual(a.actions.map((x) => x.id), ["a1"], "이전 턴의 action 이 섞였습니다");
    assert.deepEqual(b.actions, [], "형제·이전 턴의 action 이 보입니다");
    assert.ok(
      !b.timeline.some((t) => t.text.includes("공통 턴의 명령")),
      "이전 턴의 활동이 현재 timeline 에 있습니다",
    );
  });

  test("J. 같은 event 는 timeline 에 한 번만 나온다", () => {
    // The same array folded with a duplicated entry — a live post and a replay
    // of the same event. One line, not two.
    const message = userMessage();
    const contract = contractEvent();
    const progress = view([message, contract, contract, message]);
    const ids = progress.timeline.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, `중복 렌더: ${ids.join(",")}`);
    assert.equal(progress.timeline.filter((t) => t.kind === "interpreted").length, 1);
  });
});

describe("timeline 은 내부 이름을 노출하지 않는다", () => {
  test("record_request 같은 프로토콜 이름이 사용자 문구로 번역된다", () => {
    const events = [userMessage(), contractEvent(), workerEvent("glm-4.7")];
    const progress = view(events);
    const text = progress.timeline.map((t) => t.text).join(" | ");
    for (const internal of ["record_request", "turn_contract", "worker_selected", "tool_started"]) {
      assert.ok(!text.includes(internal), `${internal} 이 사용자 문구에 있습니다`);
    }
    assert.ok(text.includes("요청 분석 완료"));
    assert.ok(text.includes("모델 선택 완료"));
  });

  test("모델의 사고 과정은 timeline 에 들어가지 않는다", () => {
    const events: SessionEvent[] = [
      userMessage(),
      { type: "reasoning", ...id(), summary: "먼저 데이터를 살펴보고…" } as SessionEvent,
      { type: "assistant_text", ...id(), text: "이제 학습을 시작하겠습니다" } as SessionEvent,
      contractEvent(),
    ];
    const progress = view(events);
    const text = progress.timeline.map((t) => t.text).join(" ");
    assert.ok(!text.includes("먼저 데이터를"), "reasoning 이 노출됐습니다");
    assert.ok(!text.includes("이제 학습을"), "모델 답변이 progress 로 중복됐습니다");
  });
});

describe("의미 기반 진행도", () => {
  test("분모는 사용자가 말한 요구사항 수다", () => {
    const progress = view([userMessage(), contractEvent()]);
    assert.equal(progress.totalRequirementCount, 2);
    assert.equal(progress.completedRequirementCount, 0);
    assert.equal(progress.verifiedRequirementCount, 0);
  });

  test("증거 없는 완료는 verified 로 세지 않는다", () => {
    // The plan says a step passed; nothing observed it. The two counts differ,
    // and that difference is the point.
    const events: SessionEvent[] = [
      userMessage(),
      contractEvent(),
      planEvent(["CNN 학습", "결과 저장"]),
      started("c1", "`python train.py` 을(를) 실행합니다"),
      completed("c1", { status: "success", disposition: "executed_success", detail: "exit 0" }),
    ];
    const progress = view(events);
    assert.ok(
      progress.completedRequirementCount >= progress.verifiedRequirementCount,
      "검증 수가 완료 수를 넘었습니다",
    );
  });
});

describe("stall 은 표시이고 판정이 아니다", () => {
  test("오래 조용하면 stalled 로 보이지만 terminalReason 은 비어 있다", () => {
    const events = [userMessage(), contractEvent(), workerEvent("glm-4.7")];
    const progress = view(events, contractFrom(ASKED), STALL_DISPLAY_MS + 1000);
    assert.equal(progress.phase, "stalled");
    assert.equal(progress.planAbsence, "stalled");
    assert.equal(progress.terminalReason, null, "시간 경과로 턴을 종료 처리했습니다");
  });

  test("임계값 아래에서는 대기 상태를 유지한다", () => {
    const events = [userMessage(), contractEvent(), workerEvent("glm-4.7")];
    const progress = view(events, contractFrom(ASKED), STALL_DISPLAY_MS - 1000);
    assert.equal(progress.phase, "worker_selected");
  });
});

describe("모든 phase 는 도달 가능하고 문구가 있다", () => {
  test("12개 phase 전부에 사용자 문구가 있다", () => {
    const all: AgentProgressPhase[] = [
      "interpreting",
      "contract_ready",
      "selecting_worker",
      "worker_selected",
      "planning",
      "executing",
      "verifying",
      "completed",
      "partial",
      "blocked",
      "failed",
      "stalled",
    ];
    for (const phase of all) {
      const label = describePhase(phase);
      assert.ok(label.length > 0, phase);
      assert.ok(!label.includes("_"), `${phase} 의 문구가 enum 이름입니다`);
    }
  });

  test("계약이 없으면 projection 도 없다", () => {
    assert.equal(progressView({ events: [], contract: emptyContract(), now: T0 }), null);
  });
});

describe("the plan's two cursors", () => {
  // `update_plan`'s `current` is the model's narration. The record's cursor is
  // the first step no tool observation has settled. The transcript this
  // distinguishes them for showed `current: 2` over a task in which nothing had
  // ever run.

  test("a claimed cursor with no evidence stays a claim", () => {
    const events: SessionEvent[] = [
      userMessage(),
      contractEvent(),
      workerEvent("m1"),
      { type: "plan", ...id(), steps: ["패키지를 설치한다", "테스트를 실행한다"], current: 2 } as SessionEvent,
    ];
    const view = progressView({ events, contract: contractFrom(ASKED), now: T0 + 60_000 });
    assert.ok(view?.plan);
    assert.equal(view.plan.claimedCurrent, 2);
    assert.equal(view.plan.groundedCurrent, 1);
  });

  test("evidence moves the grounded cursor", () => {
    const events: SessionEvent[] = [
      userMessage(),
      contractEvent(),
      workerEvent("m1"),
      { type: "plan", ...id(), steps: ["패키지를 설치한다", "테스트를 실행한다"], current: 1 } as SessionEvent,
      started("c1", "pip install torch"),
      completed("c1", { status: "success", disposition: "executed_success" }),
    ];
    const view = progressView({ events, contract: contractFrom(ASKED), now: T0 + 60_000 });
    assert.equal(view?.plan?.groundedCurrent, 2);
  });

  test("no plan, no cursors", () => {
    const events: SessionEvent[] = [userMessage(), contractEvent()];
    const view = progressView({ events, contract: contractFrom(ASKED), now: T0 + 5_000 });
    assert.equal(view?.plan, null);
  });

  test("all steps settled: the cursor rests on the last step", () => {
    const events: SessionEvent[] = [
      userMessage(),
      contractEvent(),
      workerEvent("m1"),
      { type: "plan", ...id(), steps: ["테스트를 실행한다"], current: 1 } as SessionEvent,
      started("c1", "pytest -q"),
      completed("c1", { status: "success", disposition: "executed_success" }),
    ];
    const view = progressView({ events, contract: contractFrom(ASKED), now: T0 + 60_000 });
    assert.equal(view?.plan?.groundedCurrent, 1);
  });
});

describe("contradictions surface in the projection", () => {
  test("a story that flips between turns is counted", () => {
    const events: SessionEvent[] = [
      userMessage(),
      { type: "assistant_text", ...id(), text: "데이터셋 다운로드를 완료했습니다." } as SessionEvent,
      { type: "run_completed", ...id(), reason: "finished", summary: "" } as SessionEvent,
      userMessage("진행된 게 없는데?", "t2"),
      { type: "assistant_text", ...id("t2"), text: "데이터셋 다운로드가 아직 되지 않았습니다." } as SessionEvent,
    ];
    const view = progressView({ events, contract: contractFrom(ASKED), now: T0 + 60_000 });
    assert.equal(view?.stateContradictionCount, 1);
  });

  test("an honest conversation counts zero", () => {
    const events: SessionEvent[] = [userMessage(), contractEvent()];
    const view = progressView({ events, contract: contractFrom(ASKED), now: T0 + 5_000 });
    assert.equal(view?.stateContradictionCount, 0);
  });
});
