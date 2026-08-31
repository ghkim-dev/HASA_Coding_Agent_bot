import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { handoffFor } from "./harnessHandoff.ts";
import { designHarness } from "./harnessDesign.ts";
import { profileOf } from "./recommendationCases.ts";

/**
 * What crosses from the designer to the agent.
 *
 * Written against real designs rather than hand-built objects: the thing worth
 * checking is that a handoff cannot say something the design did not, and a
 * fixture shaped by hand can be made to say anything.
 */

const MODELS = [
  profileOf({ id: "strong-coder", strong: { coding: 0.9, toolUse: 0.8 } }),
  profileOf({ id: "weak-coder", strong: { coding: 0.3, toolUse: 0.2 } }),
];

describe("설계에서 에이전트로 넘어가는 것", () => {
  test("사용자의 말이 그대로 넘어간다", async () => {
    const text = "로그인 오류를 수정하고 테스트해줘.";
    const handoff = handoffFor(await designHarness({ text, models: MODELS }), text);
    assert.equal(handoff.prompt, text);
  });

  test("추천된 모델이 함께 넘어간다", async () => {
    const text = "로그인 오류를 수정하고 테스트해줘.";
    const handoff = handoffFor(await designHarness({ text, models: MODELS }), text);
    assert.equal(handoff.modelId, "strong-coder");
    assert.match(handoff.why, /strong-coder/);
  });

  test("모델 목록이 없으면 에이전트의 기본 선택에 맡긴다", async () => {
    // Null rather than a guess. `✨ Auto` is a working answer; a model name
    // invented here would be presented to the user as the design's decision.
    //
    // "추천할 모델이 없다" and "쓸 수 있는 모델이 없다" are different sentences and
    // the second is a much stronger claim, so the two are checked apart.
    const text = "로그인 오류를 수정해줘.";
    const handoff = handoffFor(await designHarness({ text }), text);
    assert.equal(handoff.modelId, null);
    assert.match(handoff.why, /모델 목록이 없어/);
  });

  test("대상이 분명한 요청은 막는 것이 없다", async () => {
    // The other side of the question test below: a request the runtime settled
    // completely hands over with nothing to warn about.
    const text = "로그인 오류를 수정해줘.";
    const handoff = handoffFor(await designHarness({ text, models: MODELS }), text);
    assert.deepEqual(handoff.blockers, []);
    assert.equal(handoff.modelId, "strong-coder");
  });

  test("읽어내지 못한 요청은 넘기기 전에 그렇다고 말한다", async () => {
    // Not refused — a person may hand off anyway — but they are told first.
    const text = "안녕하세요";
    const handoff = handoffFor(await designHarness({ text, models: MODELS }), text);
    assert.equal(handoff.prompt, text);
    assert.ok(
      handoff.blockers.some((b) => b.includes("읽어내지 못했습니다")),
      handoff.blockers.join(" / "),
    );
  });

  test("아직 정해지지 않은 것은 넘기기 전에 보여준다", async () => {
    // "테스트해줘" names an act and no target, which the design records as an
    // open question rather than answering it. Starting a run on it means the
    // agent picks the target, which is the decision the design refused to make.
    const text = "테스트해줘";
    const design = await designHarness({ text, models: MODELS });
    assert.ok(design.questions.length > 0, "이 문장은 질문을 남겨야 합니다");
    const handoff = handoffFor(design, text);
    assert.equal(handoff.blockers.length, design.questions.length);
    for (const question of design.questions) {
      assert.ok(
        handoff.blockers.some((b) => b.includes(question.about)),
        `${question.about} 이(가) 빠졌습니다`,
      );
    }
  });

  test("동점 후보가 있으면 임의 선택임을 밝힌다", async () => {
    // Two identical models: the ranker cannot separate them and says so. A
    // handoff that carried the winner without the tie would present sort order
    // as a recommendation.
    const text = "로그인 오류를 수정하고 테스트해줘.";
    const twins = [
      profileOf({ id: "twin-a", strong: { coding: 0.7, toolUse: 0.7 } }),
      profileOf({ id: "twin-b", strong: { coding: 0.7, toolUse: 0.7 } }),
    ];
    const design = await designHarness({ text, models: twins });
    assert.ok((design.recommendation?.tiedWith ?? []).length > 0, "동점이 나와야 합니다");
    const handoff = handoffFor(design, text);
    assert.ok(
      handoff.blockers.some((b) => b.includes("점수가 같은")),
      handoff.blockers.join(" / "),
    );
  });

  test("금지사항은 넘기지 않는다 — 에이전트가 같은 문장에서 다시 읽는다", async () => {
    // The load-bearing decision in this module. A prohibition is trustworthy
    // because it was read out of what the user wrote; handed over as a
    // conclusion it becomes a claim about a sentence, and a claim can drift
    // from the sentence while the sentence stays put. So the handoff carries
    // the words and nothing derived from them.
    const text = "수정하지 말고 main.py 코드만 분석해줘.";
    const design = await designHarness({ text, models: MODELS });
    assert.ok(design.prohibitions.length > 0, "이 문장은 금지를 담고 있습니다");
    const handoff = handoffFor(design, text);
    assert.deepEqual(Object.keys(handoff).sort(), ["blockers", "modelId", "prompt", "why"]);
    assert.equal(handoff.prompt, text, "금지가 살아 있는 유일한 이유는 원문이 그대로이기 때문이다");
  });
});
