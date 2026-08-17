import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseProposals } from "./proposalParse.ts";
import { previewDesign, type Proposer } from "./preview.ts";

/**
 * Telling one failure from another.
 *
 * Every one of these answers used to produce an empty array, and the metric
 * called all of them `no_response`. "The model said nothing" and "the model
 * wrote prose" and "the model wrote items with no coordinates" are three
 * different things to fix, and one of them is not a model problem at all.
 */

const T = "t1";

describe("파서는 실패의 종류를 보존한다", () => {
  const cases: Array<[string, string, string]> = [
    ["빈 응답", "", "empty_response"],
    ["공백만", "   \n  ", "empty_response"],
    ["배열 없는 산문", "요구사항을 찾지 못했습니다.", "no_json_array"],
    ["깨진 JSON", "[{text: 없음", "no_json_array"],
    ["배열 열고 안 닫음", "[ {\"text\": \"x\"", "no_json_array"],
    ["파싱 실패", "[{\"text\": \"x\",}]", "json_parse_error"],
    ["최상위가 객체", "{\"items\": [1]}", "wrong_top_level"],
    ["최상위가 스칼라", "\"없음\"", "wrong_top_level"],
    ["빈 배열", "[]", "empty_array"],
    ["코드펜스 안의 빈 배열", "```json\n[]\n```", "empty_array"],
    ["산문에 둘러싸인 배열", "찾았습니다:\n[{\"text\":\"x\",\"start\":0,\"end\":5}]", "parsed_candidate"],
    ["항목에 좌표 없음", "[{\"text\": \"x\"}]", "malformed_item"],
    ["항목이 객체가 아님", "[1, 2, 3]", "malformed_item"],
    ["정상", "[{\"text\":\"x\",\"start\":0,\"end\":5}]", "parsed_candidate"],
  ];

  for (const [label, raw, expected] of cases) {
    test(`${label} → ${expected}`, () => {
      assert.equal(parseProposals(raw, T).outcome, expected, JSON.stringify(raw));
    });
  }

  test("여섯 가지 실패가 하나로 뭉치지 않는다", () => {
    // The set, not a count. A ceiling ("at least 5 kinds") passes when two
    // failures merge and a third splits, which is the collapse being guarded.
    const failures = cases
      .filter(([, , e]) => e !== "parsed_candidate")
      .map(([, raw]) => parseProposals(raw, T).outcome);
    assert.deepEqual(
      [...new Set(failures)].sort(),
      ["empty_array", "empty_response", "json_parse_error", "malformed_item", "no_json_array", "wrong_top_level"],
    );
  });

  test("모든 ParseOutcome 이 도달 가능하다", () => {
    // A state nothing can produce is a state nothing measures. `wrong_top_level`
    // was unreachable for exactly as long as the bracket search ran first.
    const reached = new Set(cases.map(([, raw]) => parseProposals(raw, T).outcome));
    reached.add(parseProposals('[{"text":"x","start":0,"end":5,"id":"forged"}]', T).outcome);
    assert.deepEqual(
      [...reached].sort(),
      ["empty_array", "empty_response", "forbidden_field", "json_parse_error", "malformed_item", "no_json_array", "parsed_candidate", "wrong_top_level"],
    );
  });

  test("금지 필드는 버리지 않고 표시해 넘긴다", () => {
    const parse = parseProposals('[{"text":"x","start":0,"end":5,"confidence":"confirmed"}]', T);
    assert.equal(parse.outcome, "forbidden_field");
    assert.equal(parse.forbiddenFieldItems, 1);
    assert.equal(parse.proposals.length, 1, "거부는 검사 계층이 기록해야 감사할 수 있다");
  });

  test("일부만 쓸 만한 답은 실패로 보고하지 않는다", () => {
    const parse = parseProposals('[{"text":"x"},{"text":"y","start":0,"end":5}]', T);
    assert.equal(parse.outcome, "parsed_candidate");
    assert.equal(parse.itemsSeen, 2);
    assert.equal(parse.proposals.length, 1);
    assert.deepEqual(parse.itemOutcomes, ["malformed_item", "parsed_candidate"]);
  });

  test("응답 원문은 결과에 남지 않는다", () => {
    const secret = "sk-should-never-be-kept-0123456789";
    const parse = parseProposals(`prose ${secret} [{"text":"x","start":0,"end":5}]`, T);
    assert.ok(!JSON.stringify(parse).includes(secret));
  });
});

describe("preview 는 malformed 와 empty 를 다르게 집계한다", () => {
  const proposer = (raw: string): Proposer => async ({ turnId }) => {
    const parse = parseProposals(raw, turnId);
    return { proposals: parse.proposals, modelId: "m", calls: 1, parse };
  };

  test("빈 응답과 형식 오류가 같은 outcome 이 되지 않는다", async () => {
    const empty = await previewDesign({ turns: ["코드를 보여줘."], propose: proposer("") });
    const malformed = await previewDesign({
      turns: ["코드를 보여줘."],
      propose: proposer('[{"text":"x"}]'),
    });
    assert.equal(empty.proposals.perTurn[0]?.outcome, "empty_response");
    assert.equal(malformed.proposals.perTurn[0]?.outcome, "malformed_item");
    assert.notEqual(empty.proposals.perTurn[0]?.outcome, malformed.proposals.perTurn[0]?.outcome);
  });

  test("outcome 은 파서에서 오지 개수에서 오지 않는다", async () => {
    // Both answers yield zero proposals. Only the parse tells them apart, and a
    // count-based rule would call both the same thing.
    const prose = await previewDesign({ turns: ["코드를 보여줘."], propose: proposer("없습니다") });
    const emptyArray = await previewDesign({ turns: ["코드를 보여줘."], propose: proposer("[]") });
    assert.equal(prose.proposals.perTurn[0]?.outcome, "no_json_array");
    assert.equal(emptyArray.proposals.perTurn[0]?.outcome, "empty_array");
  });

  test("span 거부와 의미 거부는 파싱 성공 뒤의 별개 결과다", async () => {
    const TEXT = "실행하지 말고 코드만 설명해줘.";
    const outOfRange = await previewDesign({
      turns: [TEXT],
      propose: proposer('[{"text":"x","start":0,"end":9999}]'),
    });
    assert.equal(outOfRange.proposals.perTurn[0]?.outcome, "span_rejected");

    const reversed = await previewDesign({
      turns: [TEXT],
      propose: proposer('[{"text":"실행이 필수다","start":0,"end":8,"polarity":"required"}]'),
    });
    assert.equal(reversed.proposals.perTurn[0]?.outcome, "semantics_rejected");
  });

  /**
   * Authority is not a coordinate problem.
   *
   * `forged_provenance` was aggregated into `span_rejected`, so a prompt leaking
   * `derivedBy` or `sourceText` was reported as a model miscounting characters.
   * Nobody reading that number would have reached for the prompt, which is the
   * only thing that fixes it.
   */
  test("권한 위조는 span 거부로 집계되지 않는다", async () => {
    const TEXT = "로그인 오류를 수정해줘.";
    const forged = await previewDesign({
      turns: [TEXT],
      propose: proposer('[{"text":"로그인 오류 수정","start":0,"end":8,"derivedBy":"runtime_extraction"}]'),
    });
    const report = forged.proposals.perTurn[0];
    assert.equal(report?.outcome, "provenance_rejected");
    assert.notEqual(report?.outcome, "span_rejected");
    // The parse layer saw it too, and said so in its own vocabulary.
    assert.equal(report?.parseOutcome, "forbidden_field");
    assert.equal(report?.forbiddenFieldItems, 1);
    assert.deepEqual(forged.rejected[0]?.reasons, ["forged_provenance"]);
  });

  test("좌표가 멀쩡한 위조도 권한 거부다", async () => {
    // The span is exactly right. Nothing about this answer is a coordinate
    // mistake, and an outcome of `span_rejected` would have been simply false.
    const TEXT = "로그인 오류를 수정해줘.";
    const forged = await previewDesign({
      turns: [TEXT],
      propose: proposer(
        '[{"text":"로그인 오류 수정","start":0,"end":8,"quote":"로그인 오류를","status":"confirmed"}]',
      ),
    });
    assert.equal(forged.proposals.perTurn[0]?.outcome, "provenance_rejected");
  });

  test("다섯 가지 거부 사유가 각각 다른 결과로 기록된다", async () => {
    // The set, not a count: two of these merging while a third splits would keep
    // any "at least N kinds" assertion green.
    const TEXT = "실행하지 말고 코드만 설명해줘.";
    const answers: Array<[string, string, string]> = [
      ["빈 응답", "", "empty_response"],
      ["파싱 실패", '[{"text": "x",}]', "json_parse_error"],
      ["span 오류", '[{"text":"x","start":0,"end":9999}]', "span_rejected"],
      [
        "의미 반전",
        '[{"text":"실행이 필수다","start":0,"end":8,"polarity":"required"}]',
        "semantics_rejected",
      ],
      [
        "권한 위조",
        '[{"text":"코드 설명","start":9,"end":15,"derivedBy":"runtime_extraction"}]',
        "provenance_rejected",
      ],
    ];

    const outcomes: string[] = [];
    for (const [label, raw, expected] of answers) {
      const result = await previewDesign({ turns: [TEXT], propose: proposer(raw) });
      const outcome = result.proposals.perTurn[0]?.outcome ?? "missing";
      assert.equal(outcome, expected, `${label} → ${outcome}`);
      outcomes.push(outcome);
    }
    assert.equal(new Set(outcomes).size, answers.length, "두 사유가 한 결과로 뭉쳤습니다");
  });
});
