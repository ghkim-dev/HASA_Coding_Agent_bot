import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { GENERIC_RULE, designScenarios, scenariosFor, type ScenarioBlueprint } from "./scenarioBlueprint.ts";
import { auditCoverage } from "./coverageAudit.ts";
import { runtimeRequirements, systemBaseline, type RequirementSpec } from "./requirementSpec.ts";
import { previewDesign } from "./preview.ts";
import { questionsFrom } from "./previewReport.ts";

/**
 * Two new design rules, and the standard they had to meet to be added.
 *
 * The temptation with `NO_DESIGN_RULE` is to make the number go away, and there
 * is an easy way to do that: widen the fallback until it matches everything.
 * That is worse than the finding — it reports every requirement as covered while
 * verifying none of them, which is the exact failure `designRuleId` was
 * introduced to expose. So the tests here check two things about the additions,
 * and the second one is the one that matters:
 *
 *   1. `inspect` and `preserve` requirements now get a rule of their own.
 *   2. Every rule's oracle decides something from *runtime evidence* — which
 *      tools ran, what evidence exists, whether the workspace changed — and
 *      nothing from prose. An oracle that could read the answer's sentences
 *      would pass whichever model writes in the style it was built against, and
 *      the whole point of an inspect requirement is that its output *is* prose.
 *
 * And a third, negative: the acts that still have no rule must still say so.
 * A test that only checked "no requirement reports NO_DESIGN_RULE" would be
 * satisfied by the generic-widening this file exists to prevent.
 */

const T = "t1";

function specsFor(text: string): RequirementSpec[] {
  return runtimeRequirements({ turnId: T, text });
}

function ruleIdsFor(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const spec of specsFor(text)) {
    out.set(spec.id, [...new Set(scenariosFor(spec).map((s) => s.designRuleId))]);
  }
  return out;
}

/** Fields on an oracle that carry a runtime observation rather than a phrase. */
function decidesSomething(scenario: ScenarioBlueprint): boolean {
  const o = scenario.oracle;
  return (
    o.requiredTools.length > 0 ||
    o.forbiddenTools.length > 0 ||
    o.requiredEvidence.length > 0 ||
    o.writeScope.length > 0 ||
    o.workspaceChanged !== null ||
    o.verifiedCompletion !== null
  );
}

describe("inspect 규칙", () => {
  test("분석·설명 요청에 전용 규칙이 붙는다", () => {
    for (const text of [
      "handleLogin 함수를 설명해줘.",
      "저장소 구조를 분석해줘.",
      "README.md를 보여줘.",
      "원인을 찾아줘.",
    ]) {
      const rules = [...ruleIdsFor(text).values()].flat();
      assert.ok(rules.includes("inspect.v1"), `${text} → ${rules.join(", ")}`);
      assert.ok(!rules.includes(GENERIC_RULE), `${text} 가 아직 generic 입니다`);
    }
  });

  test("규칙은 문장이 아니라 런타임이 읽은 act 로 고른다", () => {
    // The same requirement text with a different act must not get this rule, and
    // an inspect whose wording says nothing about inspecting must still get it.
    const inspect = specsFor("코드를 보여줘.").find((s) => s.act === "inspect");
    assert.ok(inspect !== undefined);
    const asModify: RequirementSpec = { ...inspect, act: "modify" };
    assert.deepEqual(
      [...new Set(scenariosFor(asModify).map((s) => s.designRuleId))].filter((r) => r === "inspect.v1"),
      [],
      "act 가 아니라 문장으로 규칙을 골랐습니다",
    );
  });

  test("oracle 은 읽은 기록과 변경 없음으로 판정한다", () => {
    const spec = specsFor("handleLogin 함수를 설명해줘.")[0] as RequirementSpec;
    const scenarios = scenariosFor(spec);
    const read = scenarios.find((s) => s.id.endsWith("-read"));
    assert.ok(read !== undefined);
    assert.ok(read.oracle.requiredTools.includes("read_file"), "읽기 도구 실행을 요구하지 않습니다");
    assert.equal(read.oracle.workspaceChanged, false);

    const readOnly = scenarios.find((s) => s.id.endsWith("-read-only"));
    assert.ok(readOnly !== undefined);
    assert.ok(readOnly.oracle.forbiddenTools.includes("write_file"));
  });

  test("모델의 자기 보고는 완료 근거가 아니다", () => {
    const spec = specsFor("코드를 설명해줘.")[0] as RequirementSpec;
    const unsupported = scenariosFor(spec).find((s) => s.id.endsWith("-unsupported"));
    assert.ok(unsupported !== undefined);
    assert.equal(unsupported.oracle.verifiedCompletion, false);
  });
});

describe("preserve 규칙", () => {
  test("기존 동작 유지 요청에 전용 규칙이 붙는다", () => {
    for (const text of ["기존 동작은 그대로 유지해줘.", "기존 API 호환성은 반드시 유지해줘."]) {
      const rules = [...ruleIdsFor(text).values()].flat();
      assert.ok(rules.includes("preserve.v1"), `${text} → ${rules.join(", ")}`);
      assert.ok(!rules.includes(GENERIC_RULE), `${text} 가 아직 generic 입니다`);
    }
  });

  test("oracle 은 실행된 검증 결과를 요구한다", () => {
    const spec = specsFor("기존 동작은 그대로 유지해줘.")[0] as RequirementSpec;
    const regression = scenariosFor(spec).find((s) => s.category === "regression");
    assert.ok(regression !== undefined);
    assert.ok(regression.oracle.requiredEvidence.includes("test_result"), "실행 증거를 요구하지 않습니다");
    assert.ok(regression.oracle.requiredTools.includes("run_command"));
  });

  test("유지 요구가 아무것도 하지 않는 하네스에 만점을 주지 않는다", () => {
    // The same asymmetry the prohibition rule already guards: a check that only
    // proves nothing broke is passed by a harness that does nothing at all.
    const spec = specsFor("기존 동작은 그대로 유지해줘.")[0] as RequirementSpec;
    const opposite = scenariosFor(spec).find((s) => s.oracle.workspaceChanged === true);
    assert.ok(opposite !== undefined, "반대 방향 시나리오가 없습니다");
    assert.ok(opposite.oracleCoverage.includes("not_over_refused"));
  });

  test("유지는 '변경 0' 으로 검증하지 않는다", () => {
    // "리팩터링하되 기존 동작은 유지해줘" asks for changes. An oracle demanding an
    // untouched workspace would refuse the work the user asked for.
    const spec = specsFor("기존 동작은 그대로 유지해줘.")[0] as RequirementSpec;
    const regression = scenariosFor(spec).find((s) => s.category === "regression");
    assert.notEqual(regression?.oracle.workspaceChanged, false);
  });
});

describe("Oracle 은 런타임 증거만 읽는다", () => {
  const TEXTS = [
    "handleLogin 함수를 설명해줘.",
    "기존 동작은 그대로 유지해줘.",
    "실행하지 말고 코드만 보여줘.",
    "https://nodejs.org/api/test.html 를 읽고 정리해줘.",
    "src 폴더 안에서만 로그를 추가해줘.",
    "로그인 오류를 수정하고 테스트해줘.",
  ];

  test("어떤 oracle 에도 문장·정규식 필드가 없다", () => {
    for (const text of TEXTS) {
      const scenarios = designScenarios([...specsFor(text), ...systemBaseline(T)]);
      for (const scenario of scenarios) {
        for (const [key, value] of Object.entries(scenario.oracle)) {
          assert.ok(!(value instanceof RegExp), `${scenario.id}.${key} 가 정규식입니다`);
          if (key === "harnessInvariants") continue;
          assert.notEqual(typeof value, "string", `${scenario.id}.${key} 가 문자열입니다`);
        }
      }
    }
  });

  test("새 규칙의 모든 시나리오는 무언가를 판정한다", () => {
    for (const text of ["handleLogin 함수를 설명해줘.", "기존 동작은 그대로 유지해줘."]) {
      for (const spec of specsFor(text)) {
        for (const scenario of scenariosFor(spec)) {
          assert.ok(decidesSomething(scenario), `${scenario.id} 의 oracle 이 아무것도 판정하지 않습니다`);
          assert.ok(scenario.oracleCoverage.length > 0, `${scenario.id} 가 덮는 것이 없습니다`);
        }
      }
    }
  });

  test("audit 도 새 규칙을 근거 없는 커버리지로 보지 않는다", () => {
    for (const text of ["handleLogin 함수를 설명해줘.", "기존 동작은 그대로 유지해줘."]) {
      const requirements = specsFor(text);
      const audit = auditCoverage({ requirements, scenarios: designScenarios(requirements) });
      const codes = audit.findings.map((f) => f.code);
      assert.ok(!codes.includes("NO_DESIGN_RULE"), `${text}: ${codes.join(", ")}`);
      assert.ok(!codes.includes("ORACLE_INSUFFICIENT"), `${text}: ${codes.join(", ")}`);
      assert.ok(!codes.includes("ORACLE_READS_PROSE"), `${text}: ${codes.join(", ")}`);
    }
  });
});

describe("규칙이 없는 유형은 계속 없다고 말한다", () => {
  test("modify·execute·create·remove·verify 는 여전히 generic 이다", () => {
    // The honest half. If this ever passes by silence, somebody widened the
    // fallback instead of writing a rule.
    const cases: Array<[string, string]> = [
      ["로그인 오류를 수정해줘.", "modify"],
      ["main.py를 실행해줘.", "execute"],
      ["로그인 테스트를 추가해줘.", "create"],
      ["사용하지 않는 import를 제거해줘.", "remove"],
      ["테스트해줘.", "verify"],
    ];
    for (const [text, act] of cases) {
      const spec = specsFor(text).find((s) => s.act === act);
      assert.ok(spec !== undefined, `${text} 에서 ${act} 를 찾지 못했습니다`);
      const rules = scenariosFor(spec).map((s) => s.designRuleId);
      assert.ok(rules.includes(GENERIC_RULE), `${act} 에 규칙이 생겼다면 이 테스트를 갱신하십시오`);
    }
  });

  test("generic 은 여전히 NO_DESIGN_RULE 을 낸다", async () => {
    const result = await previewDesign({ turns: ["로그인 오류를 수정해줘."] });
    const codes = result.closure.audit.findings.map((f) => f.code);
    assert.ok(codes.includes("NO_DESIGN_RULE"));
  });

  test("규칙이 생긴 유형은 질문에서 사라진다", async () => {
    for (const text of ["handleLogin 함수를 설명해줘.", "기존 동작은 그대로 유지해줘."]) {
      const result = await previewDesign({ turns: [text] });
      assert.deepEqual(questionsFrom(result), [], `${text} 에 대해 여전히 묻고 있습니다`);
    }
  });
});
