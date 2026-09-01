import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toPayload } from "./designerPayload.ts";
import { designHarness } from "./harnessDesign.ts";
import { handoffFor } from "./harnessHandoff.ts";
import { profileOf } from "./recommendationCases.ts";

/**
 * What the panel is told, checked for the first time.
 *
 * Three corpora score what the runtime reads. None of them scores what the user
 * is shown, and those are different claims: a requirement can be read perfectly
 * and then presented as the harness's own rule, a filtered model can be listed
 * as an alternative, a truncated list can report its own length as the total.
 * Every one of those is a lie on a screen that no extraction test would notice,
 * and until this file the code making those calls could not be loaded by the
 * test runner at all.
 */

const MODELS = [
  profileOf({ id: "coder", strong: { coding: 0.9, toolUse: 0.8 } }),
  profileOf({ id: "middling", strong: { coding: 0.5, toolUse: 0.5 } }),
  profileOf({ id: "weak", strong: { coding: 0.2, toolUse: 0.1 } }),
];

const design = (text: string, models?: typeof MODELS): Promise<ReturnType<typeof toPayload>> =>
  designHarness(models === undefined ? { text } : { text, models }).then((d) => toPayload(d, text));

describe("패널에 넘기는 것", () => {
  test("런타임의 규칙과 사용자의 말을 구분해서 표시한다", async () => {
    // The panel draws these differently, and drawing a baseline as the user's
    // own requirement would tell them they asked for something they did not.
    const payload = await design("로그인 오류를 수정해줘.");
    const baselines = payload.requirements.filter((r) => r.baseline);
    const stated = payload.requirements.filter((r) => !r.baseline);
    assert.ok(baselines.length > 0, "the harness adds its own rules and they are marked");
    assert.ok(stated.length > 0, "the user's own requirement survived");
    assert.ok(stated.some((r) => r.text.includes("수정")));
    // A baseline can never be pointed at words, because there are none.
    assert.ok(baselines.every((r) => !r.grounded));
  });

  test("사용자의 말에서 잘라낸 요구사항은 근거가 있다고 표시된다", async () => {
    const payload = await design("로그인 오류를 수정해줘.");
    const stated = payload.requirements.filter((r) => !r.baseline);
    assert.ok(stated.every((r) => r.grounded), JSON.stringify(stated));
  });

  test("금지는 금지로 표시된다", async () => {
    const payload = await design("코드를 실행하지 말고 읽기만 해줘.");
    assert.ok(
      payload.requirements.some((r) => r.forbidden),
      JSON.stringify(payload.requirements),
    );
    assert.deepEqual(payload.prohibitions, ["no_execute"]);
  });

  test("제외된 모델은 후보로도 선택으로도 나타나지 않는다", async () => {
    // The same invariant the recommendation corpus checks, asserted where the
    // user would see it broken: a model the router refused, offered as a
    // choice.
    const payload = await design("로그인 오류를 수정하고 테스트해줘.", MODELS);
    assert.ok(payload.recommendation !== null);
    const shown = new Set([
      ...(payload.recommendation.selected === null ? [] : [payload.recommendation.selected.modelId]),
      ...payload.recommendation.alternatives.map((a) => a.modelId),
    ]);
    for (const dropped of payload.recommendation.filteredOut) {
      assert.ok(!shown.has(dropped.modelId), `${dropped.modelId} was both refused and offered`);
    }
  });

  test("잘라낸 목록이 자기 길이를 전체 개수라고 말하지 않는다", async () => {
    // `filteredOut` shows six; `filteredOutTotal` must be how many there were.
    // A panel that says "6 dropped" when nine were is telling the user the
    // shortlist was the whole field.
    const many = Array.from({ length: 9 }, (_, i) =>
      profileOf({ id: `unavailable-${i}`, available: false, strong: { coding: 0.5 } }),
    );
    const payload = await design("로그인 오류를 수정해줘.", many as typeof MODELS);
    assert.ok(payload.recommendation !== null);
    assert.equal(payload.recommendation.filteredOut.length, 6, "the panel shows at most six");
    assert.equal(payload.recommendation.filteredOutTotal, 9, "and says how many there were");
  });

  test("점수에는 분해가 따라붙는다", async () => {
    // A score with nothing behind it is a number the user has no way to argue
    // with. The breakdown was computed and dropped here once already.
    const payload = await design("로그인 오류를 수정하고 테스트해줘.", MODELS);
    const selected = payload.recommendation?.selected;
    assert.ok(selected !== null && selected !== undefined);
    assert.ok(Object.keys(selected.breakdown).length > 0, "a score with no terms behind it");
    assert.equal(typeof selected.confidence.known, "number");
    assert.equal(typeof selected.confidence.total, "number");
  });

  test("탈락 사유는 코드와 문장을 모두 들고 온다", async () => {
    const payload = await design("로그인 오류를 수정해줘.", [
      profileOf({ id: "gone", available: false, strong: { coding: 0.9 } }),
    ] as typeof MODELS);
    assert.ok(payload.recommendation !== null);
    for (const dropped of payload.recommendation.filteredOut) {
      assert.ok(dropped.code.length > 0, "an enum with no sentence");
      assert.ok(dropped.detail.length > 0, "a sentence with no code");
    }
  });

  test("읽지 못한 요청에는 추천을 보여주지 않는다", async () => {
    const payload = await design("안녕하세요", MODELS);
    assert.equal(payload.understood, false);
    assert.equal(payload.recommendation, null);
  });

  test("수요는 숫자인 것만 넘어간다", async () => {
    const payload = await design("웹에서 최신 모델을 찾아줘.", MODELS);
    for (const [name, value] of Object.entries(payload.demands)) {
      assert.equal(typeof value, "number", `${name} is not a number`);
    }
    assert.ok(Object.keys(payload.demands).length > 0);
  });

  test("핸드오프 경고 개수는 핸드오프가 실제로 든 개수다", async () => {
    // The panel shows a count and the modal shows the list. Two places holding
    // the same warning is how they drift, so the count is not computed twice.
    for (const text of ["테스트해줘", "로그인 오류를 수정해줘.", "안녕하세요"]) {
      const full = await designHarness({ text, models: MODELS });
      assert.equal(toPayload(full, text).handoff.blockerCount, handoffFor(full, text).blockers.length, text);
    }
  });
});
