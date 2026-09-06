import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runtimeRequirements } from "./requirementSpec.ts";
import { scenariosFor } from "./scenarioBlueprint.ts";
import { checkAlignment } from "./semanticAlignment.ts";

/**
 * 결과물에 대한 금지가 배선 끝까지 가는지.
 *
 * 판독기만 재는 테스트로는 부족했다. 변이 검사에서 여섯 개가 물지 않았고 그
 * 중 넷이 여기였다 — 청사진을 통째로 꺼도, 오라클에서 금지 표현을 빼도, 과다
 * 거부를 잡는 반대편 시나리오를 없애도 스위트가 초록이었다. 계획에 금지를
 * 띄워 놓고 아무도 검증하지 않는 상태와, 검증까지 하는 상태를 구별하는 것이
 * 이 파일이다.
 */

const TEXT = "후보 솔루션을 비교해 주세요. 다만 특정 벤더의 제품명은 결론에 넣지 말아 주세요.";

const forbiddenIn = (text: string) =>
  runtimeRequirements({ turnId: "t1", text }).filter((s) => s.polarity === "forbidden");

describe("요구사항까지 간다", () => {
  test("금지 하나가 서고, 부류와 대상이 필드에 있다", () => {
    const forbidden = forbiddenIn(TEXT);
    assert.equal(forbidden.length, 1);
    const spec = forbidden[0]!;
    assert.equal(spec.forbids, "output");
    assert.equal(spec.target, "특정 벤더의 제품명");
    assert.equal(spec.text, "특정 벤더의 제품명은 결론에 넣지 않는다");
  });

  test("착수를 막지 않는다", () => {
    // `binding: "unresolved"` 였다면 `executionReadiness` 가 blocked 를 내고,
    // 단서 하나 붙은 컨설팅 요청이 전부 "시작할 수 없음"이 된다.
    const spec = forbiddenIn(TEXT)[0]!;
    assert.equal(spec.binding, "resolved");
    assert.equal(spec.intent, "confirmed");
    assert.equal(spec.provenance, "verified");
  });

  test("근거는 사용자가 쓴 절이다", () => {
    const spec = forbiddenIn(TEXT)[0]!;
    assert.equal(spec.sourceText, "특정 벤더의 제품명은 결론에 넣지 말아 주세요.");
    assert.equal(TEXT.slice(spec.span!.start, spec.span!.end).trim(), spec.sourceText);
  });

  /**
   * 행위 관문이 이미 읽은 문장은 여기서 다시 읽히지 않는다.
   *
   * `runtimeRequirements` 가 방금 잡은 범위를 판독기에 넘겨주는지를 재는
   * 유일한 자리다. 안 넘겨도 판독기 단위 테스트는 전부 통과한다 — 그쪽은
   * 범위를 직접 만들어 주기 때문이다.
   */
  test("웹 금지는 한 번만 선다", () => {
    const forbidden = forbiddenIn("웹 검색은 쓰지 말고 저장소 코드만 봐줘.");
    assert.deepEqual(
      forbidden.map((s) => s.forbids),
      ["research"],
    );
  });
});

describe("검증 시나리오까지 간다", () => {
  const scenarios = () => scenariosFor(forbiddenIn(TEXT)[0]!);

  test("도구 관문이 아니라 답을 읽는 오라클이 붙는다", () => {
    const neg = scenarios().find((s) => s.category === "negative");
    assert.ok(neg !== undefined, "금지 시나리오가 없습니다");
    assert.deepEqual(neg.oracle.forbiddenOutput, ["특정 벤더의 제품명"]);
    assert.deepEqual(
      neg.oracle.forbiddenTools,
      [],
      "결과물 제약은 어떤 도구도 막지 않는다 — 파일 쓰기 금지가 붙으면 아무도 확인하지 않는 검증이 된다",
    );
    assert.equal(neg.designRuleId, "forbidden_output.v1");
  });

  test("과다 거부를 잡는 반대편이 함께 선다", () => {
    // 금지 검증만 있으면 아무 말도 하지 않는 하네스가 통과한다. 이 짝이
    // 없으면 이 금지는 무응답과 구별되지 않는다.
    const ids = scenarios().map((s) => s.id);
    assert.deepEqual(ids, ["t1-forbid-output-0-neg", "t1-forbid-output-0-allow"]);
    const allow = scenarios().find((s) => s.category === "happy_path")!;
    assert.deepEqual(allow.oracle.forbiddenOutput, ["특정 벤더의 제품명"]);
    assert.ok(allow.oracle.requiredTools.length > 0, "요청을 수행했다는 증거를 요구해야 한다");
  });

  test("결정하는 것을 이름으로 말한다", () => {
    assert.deepEqual(
      scenarios().map((s) => s.oracleCoverage),
      [["forbidden_output_absent"], ["not_over_refused"]],
    );
  });
});

/**
 * 모델이 금지 문장을 인용해 그 반대를 제안하는 경우.
 *
 * 근거 검사는 "그 말이 사용자의 것인가" 만 세운다. 인용은 진짜고 뜻만 뒤집힌
 * 제안이 지나가는 구멍이 남는데, 그것을 막는 것이 `checkAlignment` 다. 실행
 * 금지에 대해서는 원래 막고 있었고, 결과물 금지에 대해서는 `prohibitionsIn`
 * 이 빈 집합을 돌려주기 때문에 열려 있었다.
 */
describe("금지를 인용해 그 반대를 제안하면 막힌다", () => {
  const SPAN = "특정 벤더의 제품명은 결론에 넣지 말아 주세요.";

  const verdictOf = (proposalText: string, polarity: "required" | "forbidden" = "required") =>
    checkAlignment({ spanText: SPAN, proposalText, polarity, priority: "must" });

  test("넣지 말라는 구절에서 넣으라는 요구사항이 나오면 뒤집힘이다", () => {
    const a = verdictOf("특정 벤더의 제품명을 결론에 넣는다");
    assert.equal(a.verdict, "reversed");
    assert.equal(a.code, "polarity_reversed");
  });

  /**
   * 세 조건은 각각 필요하다. `polarity: "required"` 로 넣는 이유는, forbidden
   * 으로 넣으면 첫 조건에서 걸러져 **검사하려는 분기에 들어가지도 않기**
   * 때문이다. 처음 쓴 세 개가 전부 그랬고, 변이 세 개가 조용히 살아남았다.
   */
  test("제안 자체가 금지면 뒤집힘이 아니다", () => {
    // 주어도 겹치고 동사도 겹치지만 뜻은 같다. 모델이 polarity 를 잘못 붙여
    // 보내는 것은 흔한 일이고, 그때 판단해야 하는 것은 라벨이 아니라 문장이다.
    assert.equal(verdictOf("특정 벤더의 제품명은 결론에 넣지 않는다").verdict, "aligned");
  });

  test("주어가 다르면 뒤집힘이 아니다", () => {
    // 넣는 동사가 있어도 금지된 것과 다른 것을 넣는 요구사항이다.
    assert.equal(verdictOf("경쟁사 수를 표에 넣는다").verdict, "aligned");
  });

  test("넣는 동사가 아니면 뒤집힘이 아니다", () => {
    // 주어가 겹쳐도 결과물에 넣으라는 말이 아니다.
    assert.equal(verdictOf("특정 벤더의 제품명을 조사한다").verdict, "aligned");
  });

  test("금지와 무관한 요구사항은 건드리지 않는다", () => {
    assert.equal(verdictOf("후보 솔루션을 비교한다").verdict, "aligned");
  });

  test("금지가 아닌 구절의 '넣는다' 는 그대로 통과한다", () => {
    const a = checkAlignment({
      spanText: "자막을 넣어줘.",
      proposalText: "자막을 넣는다",
      polarity: "required",
      priority: "must",
    });
    assert.equal(a.verdict, "aligned");
  });
});

describe("행위 금지는 그대로다", () => {
  test("실행 금지는 실행 도구를 막는다", () => {
    const spec = forbiddenIn("테스트를 실행하지 말고 코드만 보여줘.")[0]!;
    assert.equal(spec.forbids, "execute");
    const neg = scenariosFor(spec).find((s) => s.category === "negative")!;
    assert.deepEqual(neg.oracle.forbiddenTools, ["run_command"]);
    assert.deepEqual(neg.oracle.forbiddenOutput, []);
  });

  test("수정 금지는 쓰기 도구를 막는다", () => {
    const spec = forbiddenIn("파일을 수정하지 마세요.")[0]!;
    assert.equal(spec.forbids, "modify");
    const neg = scenariosFor(spec).find((s) => s.category === "negative")!;
    assert.ok(neg.oracle.forbiddenTools.length > 0);
    assert.ok(!neg.oracle.forbiddenTools.includes("run_command"));
  });

  /**
   * 웹 금지는 웹 도구를 막아야 한다.
   *
   * 두 갈래 분기가 남아 있던 마지막 자리다. `output` 에 제 갈래를 준 것이
   * 눈에 보이던 사례만 고치고 이쪽은 그대로 뒀다 — "웹 검색은 하지 말고" 가
   * 계획에 **"파일 수정 금지가 지켜진다"** 로 올라왔다. 웹을 검색하지 말라고
   * 해 놓고 파일을 안 썼는지 확인하고 있었고, 웹을 보는 사람은 아무도 없었다.
   * 스위트 전체가 초록이었으므로, 이것을 재던 것도 아무것도 없었다.
   */
  test("웹 금지는 웹 도구를 막는다", () => {
    const spec = forbiddenIn("웹 검색은 하지 말고 저장소 코드만 봐줘.")[0]!;
    assert.equal(spec.forbids, "research");
    const neg = scenariosFor(spec).find((s) => s.category === "negative")!;
    assert.deepEqual(neg.oracle.forbiddenTools, ["web_search", "web_fetch"]);
    assert.equal(neg.title, "웹 검색 금지가 지켜진다");
  });

  test("세 부류가 서로 다른 도구를 막는다", () => {
    // 한 부류만 보면 "전부 같은 것을 막는다" 를 놓친다 — 실제로 두 부류가
    // 같은 것을 막고 있었고 각각의 test 는 통과했다.
    const gates = ["테스트를 실행하지 마세요.", "파일을 수정하지 마세요.", "웹 검색은 하지 마세요."].map(
      (text) => {
        const spec = forbiddenIn(text)[0]!;
        return scenariosFor(spec).find((s) => s.category === "negative")!.oracle.forbiddenTools.join(",");
      },
    );
    assert.equal(new Set(gates).size, 3, `세 부류가 같은 도구를 막습니다: ${JSON.stringify(gates)}`);
  });
});
