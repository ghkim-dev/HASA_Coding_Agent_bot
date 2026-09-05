import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  NAMED_COVERAGE,
  buildProposerCase,
  rankByMeasurement,
  scoreProposer,
  scoreProposerCase,
  type CaseOutcome,
  type ProposerMeasurement,
  type ProposerScore,
} from "./proposerMetrics.ts";
import { PROPOSER_CASES, PROPOSER_SWEEP, PROPOSER_WANTS } from "./proposerCases.ts";
import { SYSTEM } from "./modelProposer.ts";

/**
 * The measurement scored against answers written here, not against a live
 * model.
 *
 * A metric verified only by running it is verified by whatever the models
 * happened to do that day; every claim below is about an answer whose correct
 * score is decided by argument before the code sees it. The live sweep is a
 * separate thing and lives in `scripts/proposerSweep.mjs`.
 */

const legacy = PROPOSER_CASES[0]?.testCase;
assert.ok(legacy !== undefined, "말뭉치 첫 사례가 있어야 한다");

/** The two passages `p-diagnose-legacy` states, as the corpus records them. */
const WANT_A = "현재 아키텍처의 병목 지점을 분석해";
const WANT_B = "이관 대상 모듈의 우선순위를 정해";

const answer = (items: readonly Record<string, unknown>[]): string => JSON.stringify(items);

describe("buildProposerCase", () => {
  it("원문에 없는 인용을 거부한다", () => {
    assert.throws(
      () =>
        buildProposerCase({
          turnId: "t1",
          text: "아키텍처를 분석해줘.",
          wants: [{ quote: "비용을 산정해" }],
        }),
      /원문에 없습니다/,
    );
  });

  it("두 번 나오는 인용을 거부한다 — 어디를 가리켰는지 답이 둘이 된다", () => {
    assert.throws(
      () =>
        buildProposerCase({
          turnId: "t1",
          text: "분석해줘. 그리고 또 분석해줘.",
          wants: [{ quote: "분석해" }],
        }),
      /두 번 나옵니다/,
    );
  });
});

describe("scoreProposerCase — 읽음과 지목은 다른 축이다", () => {
  it("좌표가 틀려도 문장을 옳게 쓰면 읽음으로 센다", () => {
    // ax-3.1 이 실제로 낸 모양: 요구는 맞고 start/end 는 엉뚱한 곳.
    const outcome = scoreProposerCase({
      testCase: legacy,
      raw: answer([
        { text: "현재 아키텍처의 병목 지점을 분석해야 함", start: 3, end: 19 },
        { text: "이관 대상 모듈의 우선순위를 정해야 함", start: 24, end: 38 },
      ]),
    });
    assert.equal(outcome.named, 2, "두 요구 모두 읽었다");
    assert.equal(outcome.pointed, 0, "좌표는 둘 다 빗나갔다");
    assert.equal(outcome.invented, 0, "지어낸 것은 없다");
  });

  it("좌표가 맞으면 지목으로도 센다", () => {
    const a = legacy.text.indexOf(WANT_A);
    const b = legacy.text.indexOf(WANT_B);
    const outcome = scoreProposerCase({
      testCase: legacy,
      raw: answer([
        { text: "아키텍처 병목을 분석한다", start: a, end: a + WANT_A.length },
        { text: "이관 모듈 우선순위를 정한다", start: b, end: b + WANT_B.length },
      ]),
    });
    assert.equal(outcome.pointed, 2);
    assert.equal(outcome.accepted, 2);
  });

  it("원문에 없는 요구는 지어냄으로 센다", () => {
    const outcome = scoreProposerCase({
      testCase: legacy,
      raw: answer([{ text: "예산을 30% 절감해야 함", start: 0, end: 5 }]),
    });
    assert.equal(outcome.named, 0);
    assert.equal(outcome.invented, 1);
  });

  it("요구가 없는 문단에 후보를 내면 전부 지어냄이다", () => {
    const nothing = PROPOSER_CASES.find((k) => k.testCase.wants.length === 0)?.testCase;
    assert.ok(nothing !== undefined, "요구 없는 사례가 말뭉치에 있어야 한다");
    const outcome = scoreProposerCase({
      testCase: nothing,
      raw: answer([{ text: "온프레미스 계열사를 파악해야 함", start: 0, end: 6 }]),
    });
    assert.equal(outcome.named, 0);
    assert.equal(outcome.invented, 1);
    assert.equal(outcome.pointed, 0);
  });

  it("빈 배열은 요구 없는 문단에서 만점이다 — 지어냄도 놓침도 없다", () => {
    const nothing = PROPOSER_CASES.find((k) => k.testCase.wants.length === 0)?.testCase;
    assert.ok(nothing !== undefined);
    const outcome = scoreProposerCase({ testCase: nothing, raw: "[]" });
    assert.equal(outcome.invented, 0);
    assert.equal(outcome.named, 0);
    assert.equal(outcome.parse, "empty_array");
  });

  it("산문은 형식에서 걸리고, 읽음을 얻지 못한다", () => {
    const outcome = scoreProposerCase({
      testCase: legacy,
      raw: "네, 아키텍처 병목을 분석하고 이관 우선순위를 정하겠습니다.",
    });
    assert.equal(outcome.parse, "no_json_array");
    assert.equal(outcome.named, 0, "말로 맞혀도 읽음이 아니다 — 형식이 계약이다");
  });

  it("구간을 그대로 베껴 쓰면 옮겨적음으로 센다", () => {
    const a = legacy.text.indexOf(WANT_A);
    const outcome = scoreProposerCase({
      testCase: legacy,
      raw: answer([{ text: WANT_A, start: a, end: a + WANT_A.length }]),
    });
    assert.equal(outcome.transcribed, 1);
    assert.equal(outcome.pointed, 1, "베꼈어도 가리킨 것은 맞다 — 두 축은 독립이다");
  });

  it("좌표만 틀린 후보는 거부돼도 읽음으로 남는다", () => {
    // acceptProposals 가 구간을 보고 거부하는 경우. 후보 자체는 파싱을 통과해
    // 왔으므로 지표가 그 문장을 읽을 수 있고, 읽어야 한다.
    const outcome = scoreProposerCase({
      testCase: legacy,
      raw: answer([{ text: "현재 아키텍처의 병목 지점을 분석해야 함", start: 9000, end: 9010 }]),
    });
    assert.equal(outcome.rejected, 1, "구간이 원문 밖이라 거부된다");
    assert.equal(outcome.pointed, 0);
    assert.equal(outcome.named, 1, "거부됐어도 읽기는 읽었다");
  });

  it("한쪽만 담고 있어도 옮겨적음이다 — 자동 변이가 찾은 구멍", () => {
    // `a.includes(b) || b.includes(a)` 를 `&&` 로 바꿔도 전체 스위트가
    // 통과했다. 앞선 옮겨적음 시험이 구간을 **정확히** 베낀 답만 써서, 양방향이
    // 동시에 참이었기 때문이다. 잘라 베낀 답은 한 방향만 참이고, 그것도 베낀
    // 것이다.
    const a = legacy.text.indexOf(WANT_A);
    const outcome = scoreProposerCase({
      testCase: legacy,
      raw: answer([{ text: WANT_A.slice(0, 10), start: a, end: a + WANT_A.length }]),
    });
    assert.equal(outcome.transcribed, 1, "구간의 일부만 베껴도 베낀 것이다");
  });

  it("빈 문장은 옮겨적음이 아니다", () => {
    // `a.length === 0 || b.length === 0` 를 `&&` 로 바꿔도 통과했다. 한쪽만
    // 비었을 때 `x.includes("")` 가 참이라 빈 답이 베낀 것으로 세어진다.
    const a = legacy.text.indexOf(WANT_A);
    const outcome = scoreProposerCase({
      testCase: legacy,
      raw: answer([{ text: "", start: a, end: a + WANT_A.length }]),
    });
    assert.equal(outcome.transcribed, 0, "아무 말도 안 한 것은 베낀 것이 아니다");
  });

  it("권한을 참칭한 후보도 읽음은 읽음으로 센다 — 넘어선 것과 못 읽은 것은 다르다", () => {
    // parseProposals 는 참칭 항목을 지우지 않고 표시해서 내보낸다. 거부를
    // 검사기가 '기록'하게 하려는 설계이고, 이 지표가 그것을 없던 일로 만들면
    // 안 된다. 넘어선 사실은 parse 가 이미 forbidden_field 로 말하고 있으니
    // 읽음까지 깎으면 한 답을 두 번 벌하는 셈이다.
    const a = legacy.text.indexOf(WANT_A);
    const outcome = scoreProposerCase({
      testCase: legacy,
      raw: answer([
        {
          text: "현재 아키텍처의 병목 지점을 분석해야 함",
          start: a,
          end: a + WANT_A.length,
          status: "confirmed",
        },
      ]),
    });
    assert.equal(outcome.parse, "forbidden_field", "넘어선 사실은 여기에 남는다");
    assert.equal(outcome.named, 1);
    assert.equal(outcome.rejected, 1, "구간은 맞지만 참칭 때문에 거부된다");
    assert.equal(outcome.pointed, 0, "거부됐으니 런타임이 잘라준 말이 없다");
  });
});

describe("읽음 임계값", () => {
  it("서로 닮은 두 요구를 한 문장이 동시에 만족시키지 않는다", () => {
    // p-govern-policy 의 두 요구는 '정책을' 과 문법 대부분을 공유한다. 임계가
    // 낮으면 한 문장이 둘 다 집어 읽음이 부풀어 오른다.
    const govern = PROPOSER_CASES.find((k) => k.testCase.turnId === "p-govern-policy")?.testCase;
    assert.ok(govern !== undefined);
    const first = govern.wants[0]?.quote;
    assert.ok(first !== undefined);
    const outcome = scoreProposerCase({
      testCase: govern,
      raw: answer([{ text: `${first}야 함`, start: 0, end: 5 }]),
    });
    assert.equal(outcome.named, 1, "하나만 읽은 것으로 세야 한다");
  });

  it("임계값은 0과 1 사이의 실수다", () => {
    assert.ok(NAMED_COVERAGE > 0 && NAMED_COVERAGE < 1);
  });

  it("계수가 임계값과 정확히 같으면 읽은 것이다 — 경계는 포함이다", () => {
    // 자동 변이 감사가 남긴 마지막 자리들. `>=` 를 `>` 로 바꿔도, 그리고
    // 바이그램 루프의 `<=` 를 `<` 로 바꿔도 전체 스위트가 통과했다 — 계수가
    // 정확히 0.6 이 되는 사례가 하나도 없었기 때문이다. 아래는 계산해서 만든
    // 그 사례이고, 마지막 바이그램을 잃으면 0.5 로 떨어져 두 변이를 함께 잡는다.
    const phased = PROPOSER_CASES.find((k) => k.testCase.turnId === "p-roadmap-phased")?.testCase;
    assert.ok(phased !== undefined);
    assert.equal(phased.wants[1]?.quote, "단계별 투자 규모를 산정해");
    const outcome = scoreProposerCase({
      testCase: phased,
      raw: answer([{ text: "정해단계계별별투투자자규", start: 0, end: 5 }]),
    });
    assert.equal(outcome.named, 1, "정확히 0.6 이면 읽은 것으로 세야 한다");
    // 읽음과 지어냄은 같은 임계를 서로 다른 자리에서 쓴다. 읽음만 주장하면
    // 지어냄 쪽 경계는 여전히 아무도 지키지 않는다 — 감사가 그 자리를 남겼다.
    assert.equal(outcome.invented, 0, "읽은 것을 동시에 지어낸 것으로 셀 수는 없다");
  });

  it("절반쯤 겹치는 문장은 그 요구를 읽은 것이 아니다", () => {
    // 위의 '닮은 두 요구' 시험은 임계를 0.3 으로 낮춰도 그대로 통과한다 —
    // 그 두 문장은 0.13 밖에 안 겹쳐서 어느 임계로 재도 답이 같기 때문이다.
    // 임계를 실제로 재려면 그 사이에 놓인 문장이 있어야 한다. 아래는 0.43 이라
    // 0.6 에서는 못 읽은 것, 0.3 에서는 읽은 것이 된다.
    const govern = PROPOSER_CASES.find((k) => k.testCase.turnId === "p-govern-policy")?.testCase;
    assert.ok(govern !== undefined);
    assert.equal(govern.wants[0]?.quote, "데이터 접근 권한 정책을 새로 설계해");
    const outcome = scoreProposerCase({
      testCase: govern,
      raw: answer([{ text: "데이터 접근 권한을 정리한다", start: 0, end: 5 }]),
    });
    assert.equal(outcome.named, 0, "낱말 절반을 공유해도 다른 요구다");
    assert.equal(outcome.invented, 1, "그리고 원문이 말하지 않은 요구다");
  });
});

describe("scoreProposer — 무응답은 모델에 대한 판단이 아니다", () => {
  const outcome = (over: Partial<CaseOutcome>): CaseOutcome => ({
    turnId: "t1",
    parse: "parsed_candidate",
    accepted: 1,
    rejected: 0,
    named: 1,
    pointed: 0,
    invented: 0,
    transcribed: 0,
    ...over,
  });

  it("무응답은 형식의 분모에 들어가되 별도로도 보고된다", () => {
    const score = scoreProposer({
      modelId: "m",
      outcomes: [outcome({}), outcome({})],
      wantsTotal: 4,
      unanswered: 2,
    });
    assert.equal(score.shape.hit, 2);
    assert.equal(score.shape.of, 4, "답을 못 받은 사례도 분모다");
    assert.equal(score.unanswered, 2);
  });

  it("분모가 비면 값은 0이 아니라 null 이다", () => {
    const score = scoreProposer({ modelId: "m", outcomes: [], wantsTotal: 0, unanswered: 0 });
    assert.equal(score.named.value, null);
    assert.equal(score.invented.value, null);
  });

  it("예산이 모자라 잘린 사례를 따로 센다", () => {
    // 잘린 답은 빈 문자열로 도착해 '아무것도 못 읽은 모델'과 구분이 안 된다.
    // 첫 스윕이 네 모델을 그렇게 0/16 으로 적었다. 그 수는 모델이 아니라 예산에
    // 대한 것이었다.
    const score = scoreProposer({
      modelId: "m",
      outcomes: [outcome({ parse: "empty_response", accepted: 0, named: 0 })],
      wantsTotal: 2,
      unanswered: 0,
      truncated: 1,
    });
    assert.equal(score.truncated, 1);
    assert.equal(score.named.hit, 0, "읽음은 여전히 0 이다 — 잘림이 점수를 대신 주지는 않는다");
  });

  it("잘림을 세지 않으면 0 이다 — 옛 호출부가 조용히 틀린 수를 갖지 않는다", () => {
    const score = scoreProposer({ modelId: "m", outcomes: [], wantsTotal: 0, unanswered: 0 });
    assert.equal(score.truncated, 0);
  });

  it("지어냄의 분모는 낸 후보 전체다 — 거부된 것까지", () => {
    const score = scoreProposer({
      modelId: "m",
      outcomes: [outcome({ accepted: 1, rejected: 3, invented: 2 })],
      wantsTotal: 1,
      unanswered: 0,
    });
    assert.equal(score.invented.of, 4);
  });
});

describe("rankByMeasurement", () => {
  const score = (over: Partial<ProposerScore> & { modelId: string }): ProposerScore => ({
    shape: { hit: 10, of: 10, value: 1 },
    accepted: { hit: 1, of: 1, value: 1 },
    named: { hit: 8, of: 16, value: 0.5 },
    pointed: { hit: 0, of: 16, value: 0 },
    invented: { hit: 0, of: 8, value: 0 },
    transcribed: { hit: 0, of: 8, value: 0 },
    unanswered: 0,
    truncated: 0,
    outcomes: [],
    ...over,
  });
  const measure = (scores: readonly ProposerScore[]): ProposerMeasurement => ({
    prompt: SYSTEM,
    takenAt: 0,
    baseUrl: "https://example.invalid/v1",
    cases: PROPOSER_CASES.length,
    wants: PROPOSER_WANTS,
    maxTokens: 6000,
    scores,
  });

  it("읽음이 높은 쪽이 앞선다", () => {
    // 이름은 일부러 기대 순서와 반대로 붙였다. 앞서 이 시험은 "low"/"high" 를
    // 썼는데, 그러면 읽음을 정렬 키에서 통째로 빼도 마지막 이름순 타이브레이크가
    // 우연히 같은 답을 내서 통과했다 — 아무것도 재지 않는 시험이었다.
    const order = rankByMeasurement(
      measure([
        score({ modelId: "a-low", named: { hit: 2, of: 16, value: 0.125 } }),
        score({ modelId: "b-high", named: { hit: 14, of: 16, value: 0.875 } }),
      ]),
    );
    assert.deepEqual(order, ["b-high", "a-low"]);
  });

  it("읽음이 같으면 지어냄이 적은 쪽이 앞선다", () => {
    const order = rankByMeasurement(
      measure([
        score({ modelId: "a-invents", invented: { hit: 4, of: 8, value: 0.5 } }),
        score({ modelId: "b-clean", invented: { hit: 0, of: 8, value: 0 } }),
      ]),
    );
    assert.deepEqual(order, ["b-clean", "a-invents"]);
  });

  it("지목이 살아나면 그때부터 순위를 가른다", () => {
    // 프롬프트가 좌표를 낼 수 있게 바뀌는 날, 이 함수를 고치지 않아도
    // 지목이 순위에 반영되어야 한다.
    const order = rankByMeasurement(
      measure([
        score({ modelId: "a-blind", pointed: { hit: 0, of: 16, value: 0 } }),
        score({ modelId: "b-aims", pointed: { hit: 12, of: 16, value: 0.75 } }),
      ]),
    );
    assert.deepEqual(order, ["b-aims", "a-blind"]);
  });

  it("모두 같으면 이름순으로 갈라 결과가 흔들리지 않는다", () => {
    const order = rankByMeasurement(measure([score({ modelId: "b" }), score({ modelId: "a" })]));
    assert.deepEqual(order, ["a", "b"]);
  });
});

describe("말뭉치", () => {
  it("요구 없는 문단이 적어도 하나 있다", () => {
    // 없으면 문장마다 후보 하나를 내는 제안자가 좋은 제안자와 같은 점수를 받는다.
    assert.ok(PROPOSER_SWEEP.some((k) => k.wants.length === 0));
  });

  it("요구가 둘 이상인 사례가 있다", () => {
    assert.ok(PROPOSER_SWEEP.some((k) => k.wants.length >= 2));
  });

  it("모든 인용은 제 원문 안에 정확히 한 번 있다", () => {
    for (const k of PROPOSER_SWEEP) {
      for (const want of k.wants) {
        const first = k.text.indexOf(want.quote);
        assert.notEqual(first, -1, `${k.turnId}: «${want.quote}»`);
        assert.equal(k.text.indexOf(want.quote, first + 1), -1, `${k.turnId}: «${want.quote}» 중복`);
      }
    }
  });

  it("요구 합계가 따로 센 값과 같다", () => {
    assert.equal(
      PROPOSER_WANTS,
      PROPOSER_SWEEP.reduce((n, k) => n + k.wants.length, 0),
    );
  });

  it("사례 아이디가 모두 다르다", () => {
    const ids = PROPOSER_SWEEP.map((k) => k.turnId);
    assert.equal(new Set(ids).size, ids.length);
  });
});
