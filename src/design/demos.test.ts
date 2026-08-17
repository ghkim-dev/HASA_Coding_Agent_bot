import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  acceptProposals,
  mergeRequirements,
  runtimeRequirements,
  systemBaseline,
  type RequirementSpec,
} from "./requirementSpec.ts";
import { designScenarios } from "./scenarioBlueprint.ts";
import { auditCoverage, mayExecute } from "./coverageAudit.ts";

/**
 * The six demos, as tests rather than as a script.
 *
 * Deterministic because the runtime half is deterministic: prohibitions and
 * named sources are read out of the user's own words with no model involved,
 * and a model's proposals are accepted or refused by a rule about the
 * transcript. What a model *would* propose is supplied as a fixture, so the
 * thing under test is what the runtime does with it rather than what a model
 * happened to say that day.
 */

const T1 = "t1";
const T2 = "t2";

const plan = (specs: readonly RequirementSpec[]) => {
  const scenarios = designScenarios(specs);
  return { scenarios, audit: auditCoverage({ requirements: specs, scenarios }) };
};

// --- A: an explicit prohibition ---------------------------------------------

describe("데모 A — 명시적 금지", () => {
  const TEXT = "수정하거나 실행하지 말고 main.py 코드만 분석해줘.";
  const specs = runtimeRequirements({ turnId: T1, text: TEXT });

  test("두 금지가 모두 추출되고, 원문이 보존된다", () => {
    assert.equal(specs.length, 2);
    for (const spec of specs) {
      assert.equal(spec.polarity, "forbidden");
      assert.equal(spec.status, "explicit");
      assert.equal(spec.priority, "must");
      assert.ok(TEXT.includes(spec.sourceText), `sourceText not in the user's words: ${spec.sourceText}`);
    }
    assert.deepEqual(
      specs.map((s) => s.id).sort(),
      ["t1-forbid-execute", "t1-forbid-modify"],
    );
  });

  test("금지마다 부작용 검사와 정상 허용이 함께 생성된다", () => {
    const { scenarios, audit } = plan(specs);
    for (const spec of specs) {
      const mine = scenarios.filter((s) => s.requirementIds.includes(spec.id));
      assert.ok(
        mine.some((s) => s.oracle.forbiddenTools.length > 0),
        `${spec.id}: 부작용 0 검사 없음`,
      );
      assert.ok(
        mine.some((s) => s.oracle.requiredTools.length > 0),
        `${spec.id}: 정상 허용 검사 없음 — 전부 거부하는 하네스도 통과한다`,
      );
      assert.ok(mine.some((s) => s.category === "security"), `${spec.id}: 계약 누락 시나리오 없음`);
      assert.ok(mine.some((s) => s.category === "boundary"), `${spec.id}: 다음 턴 허용 시나리오 없음`);
    }
    assert.equal(audit.ok, true, JSON.stringify(audit.findings));
    assert.equal(mayExecute(audit), true);
  });

  test("oracle 은 문장이 아니라 도구 기록을 본다", () => {
    const { scenarios } = plan(specs);
    for (const scenario of scenarios) {
      const values = Object.entries(scenario.oracle).filter(([k]) => k !== "harnessInvariants");
      for (const [key, value] of values) {
        assert.notEqual(typeof value, "string", `${scenario.id}.${key} 가 문장입니다`);
      }
    }
  });
});

// --- B: the other direction -------------------------------------------------

describe("데모 B — 반대 방향", () => {
  const TEXT = "main.py 코드도 보여주고 실제 실행 결과도 보여줘.";

  test("실행 요청은 금지로 읽히지 않는다", () => {
    const specs = runtimeRequirements({ turnId: T1, text: TEXT });
    assert.deepEqual(specs, [], "요청한 동작을 금지로 오독하면 요청을 거부하게 된다");
  });

  test("실행 요구사항에는 실제 실행 증거가 요구된다", () => {
    // Nothing runtime-derivable here, so this is where a model proposal is
    // needed — and it is checked against the transcript before it counts.
    const { accepted, rejected } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [
        {
          text: "main.py 를 실행하고 그 결과를 보여준다",
          sourceText: "실제 실행 결과도 보여줘",
          kind: "functional",
          priority: "must",
          confidence: "confirmed",
        },
      ],
    });
    assert.equal(rejected.length, 0);
    assert.equal(accepted.length, 1);

    const audit = auditCoverage({ requirements: accepted, scenarios: designScenarios(accepted) });
    assert.ok(
      audit.findings.some((f) => f.code === "EXECUTION_WITHOUT_EVIDENCE"),
      "실행 요구사항인데 실행 증거를 요구하지 않는 계획이 통과했습니다",
    );
    assert.equal(mayExecute(audit), false, "감사가 실패했는데 실행 가능으로 나왔습니다");
  });
});

// --- C: a correction --------------------------------------------------------

describe("데모 C — 정정", () => {
  const FIRST = "main.py를 실행해서 결과를 보여줘.";
  const SECOND = "처음에는 실행을 요청했지만 정정할게. 실행하지 말고 코드만 보여줘.";

  test("정정은 기존 요구사항을 삭제하지 않고 superseded 로 남긴다", () => {
    const standing = acceptProposals({
      turnId: T1,
      userText: FIRST,
      proposals: [
        { text: "main.py 를 실행한다", sourceText: "main.py를 실행해서", polarity: "required" },
      ],
    }).accepted;
    assert.equal(standing.length, 1);

    const incoming = runtimeRequirements({ turnId: T2, text: SECOND });
    assert.ok(
      incoming.some((s) => s.id === "t2-forbid-execute"),
      "정정 턴에서 금지가 추출되지 않았습니다",
    );

    const merged = mergeRequirements({ standing, incoming, relation: "correct", turnId: T2 });
    const original = merged.find((s) => s.id === standing[0]!.id);
    assert.ok(original !== undefined, "원래 요구사항이 사라졌습니다");
    assert.equal(original.supersededBy, T2, "정정이 superseded 로 기록되지 않았습니다");
    assert.ok(
      merged.some((s) => s.id === "t2-forbid-execute" && s.supersededBy === undefined),
      "새 금지가 서 있지 않습니다",
    );
  });

  test("superseded 요구사항에는 시나리오를 만들지 않는다", () => {
    const superseded: RequirementSpec = {
      ...runtimeRequirements({ turnId: T1, text: "실행하지 말고 보여줘." })[0]!,
      supersededBy: T2,
    };
    assert.deepEqual(designScenarios([superseded]), []);
  });

  test("refine 은 기존 요구사항을 유지하며 더한다", () => {
    const standing = runtimeRequirements({ turnId: T1, text: "실행하지 말고 보여줘." });
    const incoming = runtimeRequirements({ turnId: T2, text: "수정도 하지 말아줘." });
    const merged = mergeRequirements({ standing, incoming, relation: "refine", turnId: T2 });
    assert.equal(merged.length, standing.length + incoming.length);
    assert.ok(merged.every((s) => s.supersededBy === undefined));
    assert.equal(merged.find((s) => s.id === standing[0]!.id)?.status, "inherited");
  });

  test("question 과 continue 는 새 요구사항을 만들지 않는다", () => {
    const standing = runtimeRequirements({ turnId: T1, text: "실행하지 말고 보여줘." });
    for (const relation of ["question", "continue"] as const) {
      const merged = mergeRequirements({
        standing,
        incoming: runtimeRequirements({ turnId: T2, text: "수정도 하지 말아줘." }),
        relation,
        turnId: T2,
      });
      assert.equal(merged.length, standing.length, relation);
      assert.ok(merged.every((s) => s.status === "inherited"), relation);
    }
  });
});

// --- D: a past failure and a present request --------------------------------

describe("데모 D — 과거 실패와 현재 요청", () => {
  const TEXT = "아까는 실행하지 못했어. 원인을 고치고 이번에는 다시 실행해줘.";

  test("과거의 실패 보고를 금지로 읽지 않는다", () => {
    const specs = runtimeRequirements({ turnId: T1, text: TEXT });
    assert.deepEqual(
      specs,
      [],
      "'실행하지 못했어' 는 보고이지 금지가 아니다. 금지로 읽으면 사용자가 요청한 수정을 거부한다",
    );
  });

  test("복구 요구사항은 실행 증거를 요구하는 계획을 만든다", () => {
    const { accepted } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [
        {
          text: "실행 실패 원인을 고치고 다시 실행한다",
          sourceText: "원인을 고치고 이번에는 다시 실행해줘",
          kind: "functional",
          priority: "must",
          confidence: "confirmed",
        },
      ],
    });
    const audit = auditCoverage({ requirements: accepted, scenarios: designScenarios(accepted) });
    const codes = audit.findings.map((f) => f.code);
    assert.ok(codes.includes("EXECUTION_WITHOUT_EVIDENCE"));
    assert.ok(codes.includes("MODIFY_WITHOUT_REGRESSION"));
    assert.equal(mayExecute(audit), false);
  });
});

// --- E: an external source --------------------------------------------------

describe("데모 E — 외부 출처", () => {
  const TEXT = "open.hasa.re.kr/models를 기준으로 사용할 수 있는 모델을 확인해줘.";

  test("지목된 출처가 요구사항이 된다", () => {
    const specs = runtimeRequirements({ turnId: T1, text: TEXT });
    const source = specs.find((s) => s.derivedBy === "runtime_source");
    assert.ok(source !== undefined, "URL 이 요구사항으로 추출되지 않았습니다");
    assert.equal(source.kind, "validation");
    assert.equal(source.priority, "must");
    assert.ok(TEXT.includes(source.sourceText));
  });

  test("출처 요구사항에는 provenance 검사가 붙는다", () => {
    const specs = runtimeRequirements({ turnId: T1, text: TEXT });
    const { scenarios, audit } = plan(specs);
    assert.ok(scenarios.some((s) => s.oracle.requiredEvidence.includes("web_source")));
    // Asserted on structure, not on a word in the title. A test that matches a
    // phrase is the same mistake the audit refuses in an oracle.
    assert.ok(
      scenarios.some(
        (s) => s.category === "negative" && s.oracle.requiredEvidence.includes("web_source"),
      ),
      "출처 오귀속을 잡는 negative 시나리오가 없습니다",
    );
    assert.equal(audit.ok, true, JSON.stringify(audit.findings));
  });
});

// --- F: a compound request --------------------------------------------------

describe("데모 F — 복합 요구사항", () => {
  const TEXT =
    "기존 Arena와 Worktree를 유지하면서 HASA Coding Agent를 추가하고, " +
    "API Key는 SecretStorage에만 저장하며 기존 테스트를 모두 유지해줘.";

  const PROPOSALS = [
    {
      text: "기존 Arena 기능을 유지한다",
      sourceText: "기존 Arena와 Worktree를 유지하면서",
      kind: "compatibility" as const,
      priority: "must" as const,
      confidence: "confirmed" as const,
    },
    {
      text: "HASA Coding Agent 를 추가한다",
      sourceText: "HASA Coding Agent를 추가하고",
      kind: "functional" as const,
      priority: "must" as const,
      confidence: "confirmed" as const,
    },
    {
      text: "API Key 는 SecretStorage 에만 저장한다",
      sourceText: "API Key는 SecretStorage에만 저장하며",
      kind: "security" as const,
      priority: "must" as const,
      polarity: "required" as const,
      confidence: "confirmed" as const,
    },
    {
      text: "기존 테스트를 모두 유지한다",
      sourceText: "기존 테스트를 모두 유지해줘",
      kind: "quality" as const,
      priority: "must" as const,
      confidence: "confirmed" as const,
    },
  ];

  test("네 요구사항이 각각 원문에 연결된다", () => {
    const { accepted, rejected } = acceptProposals({ turnId: T1, userText: TEXT, proposals: PROPOSALS });
    assert.equal(rejected.length, 0);
    assert.equal(accepted.length, 4);
    for (const spec of accepted) {
      assert.ok(TEXT.includes(spec.sourceText), spec.sourceText);
      assert.equal(spec.sourceTurnId, T1);
    }
  });

  test("사용자가 말하지 않은 요구사항은 거부된다", () => {
    const { accepted, rejected } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [
        ...PROPOSALS,
        {
          text: "성능을 두 배로 개선한다",
          sourceText: "성능을 두 배로 개선해줘",
        },
      ],
    });
    assert.equal(accepted.length, 4);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.reason, "not_in_source");
  });

  test("시스템 조건은 explicit 과 섞이지 않는다", () => {
    const { accepted } = acceptProposals({ turnId: T1, userText: TEXT, proposals: PROPOSALS });
    const all = [...accepted, ...systemBaseline(T1)];
    assert.equal(all.filter((s) => s.status === "explicit").length, 4);
    assert.equal(all.filter((s) => s.status === "system_added").length, 2);
    for (const spec of all.filter((s) => s.status === "system_added")) {
      assert.equal(spec.sourceText, "", "시스템 조건에 사용자 원문이 붙어 있습니다");
    }
  });

  test("추가 요구사항에는 회귀 시나리오가 요구된다", () => {
    const { accepted } = acceptProposals({ turnId: T1, userText: TEXT, proposals: PROPOSALS });
    const audit = auditCoverage({ requirements: accepted, scenarios: designScenarios(accepted) });
    assert.ok(audit.findings.some((f) => f.code === "MODIFY_WITHOUT_REGRESSION"));
    assert.equal(mayExecute(audit), false, "회귀 검증 없이 실행 가능으로 나왔습니다");
  });

  test("모든 must 요구사항이 시나리오를 갖는다", () => {
    const { accepted } = acceptProposals({ turnId: T1, userText: TEXT, proposals: PROPOSALS });
    const audit = auditCoverage({ requirements: accepted, scenarios: designScenarios(accepted) });
    assert.equal(audit.coverage.needed, 4);
    assert.equal(audit.coverage.covered, 4);
    assert.ok(!audit.findings.some((f) => f.code === "MUST_WITHOUT_SCENARIO"));
  });
});

// --- the audit's own guarantees ---------------------------------------------

describe("Coverage Audit 는 계획의 구조만 본다", () => {
  const specs = runtimeRequirements({ turnId: T1, text: "실행하지 말고 보여줘." });

  test("must 에 시나리오가 없으면 실행을 막는다", () => {
    const audit = auditCoverage({ requirements: specs, scenarios: [] });
    assert.equal(mayExecute(audit), false);
    assert.equal(audit.findings[0]?.code, "MUST_WITHOUT_SCENARIO");
    assert.equal(audit.coverage.covered, 0);
  });

  test("금지에 정상 허용 짝이 없으면 실행을 막는다", () => {
    const oneSided = designScenarios(specs).filter((s) => s.oracle.requiredTools.length === 0);
    const audit = auditCoverage({ requirements: specs, scenarios: oneSided });
    assert.ok(audit.findings.some((f) => f.code === "FORBIDDEN_WITHOUT_POSITIVE_PAIR"));
    assert.equal(mayExecute(audit), false);
  });

  test("요구사항에 연결되지 않은 시나리오를 잡는다", () => {
    const orphan = { ...designScenarios(specs)[0]!, requirementIds: [] };
    const audit = auditCoverage({ requirements: specs, scenarios: [...designScenarios(specs), orphan] });
    assert.ok(audit.findings.some((f) => f.code === "SCENARIO_WITHOUT_REQUIREMENT"));
  });

  test("한 시나리오에 요구사항이 너무 많으면 잡는다", () => {
    const overloaded = {
      ...designScenarios(specs)[0]!,
      requirementIds: ["a", "b", "c", "d"],
    };
    const audit = auditCoverage({ requirements: specs, scenarios: [overloaded] });
    assert.ok(audit.findings.some((f) => f.code === "SCENARIO_OVERLOADED"));
  });

  test("문장에 의존하는 oracle 을 잡는다", () => {
    const prosy = {
      ...designScenarios(specs)[0]!,
      oracle: { ...designScenarios(specs)[0]!.oracle, answerContains: "완료했습니다" } as never,
    };
    const audit = auditCoverage({ requirements: specs, scenarios: [prosy] });
    assert.ok(audit.findings.some((f) => f.code === "ORACLE_READS_PROSE"));
  });

  test("호출 권한 없는 모델이 계획에 있으면 잡는다", () => {
    const audit = auditCoverage({
      requirements: specs,
      scenarios: designScenarios(specs),
      plannedModels: ["glm-4.7-flash", "qwen3-32b"],
      permittedModels: ["glm-4.7-flash"],
    });
    assert.ok(audit.findings.some((f) => f.detail.includes("qwen3-32b")));
    assert.equal(mayExecute(audit), false);
  });

  test("모호한 요구사항을 확정 판정하지 않는다", () => {
    const ambiguous: RequirementSpec = { ...specs[0]!, confidence: "ambiguous", polarity: "required" };
    const decided = {
      ...designScenarios([ambiguous])[0]!,
      oracle: { ...designScenarios([ambiguous])[0]!.oracle, verifiedCompletion: true },
    };
    const audit = auditCoverage({ requirements: [ambiguous], scenarios: [decided] });
    assert.ok(audit.findings.some((f) => f.code === "AMBIGUOUS_DECIDED"));
  });
});

describe("모델 제안은 스스로 확정되지 않는다", () => {
  const TEXT = "기존 테스트를 유지하면서 캐시를 추가해줘.";

  test("confidence 를 밝히지 않은 제안은 ambiguous 로 남는다", () => {
    // The default matters. A proposal that says nothing about its own certainty
    // is not a confident one, and recording it as `confirmed` is the model
    // deciding on the user's behalf and hiding that it did.
    const { accepted } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [{ text: "캐시를 추가한다", sourceText: "캐시를 추가해줘" }],
    });
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.confidence, "ambiguous");
    assert.equal(accepted[0]?.derivedBy, "model_proposal");
  });

  test("확정을 밝힌 제안만 confirmed 가 된다", () => {
    const { accepted } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [
        { text: "캐시를 추가한다", sourceText: "캐시를 추가해줘", confidence: "confirmed" },
      ],
    });
    assert.equal(accepted[0]?.confidence, "confirmed");
  });

  test("ambiguous 인 채로 확정 판정하는 계획은 실행되지 않는다", () => {
    const { accepted } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [{ text: "캐시를 추가한다", sourceText: "캐시를 추가해줘", priority: "must" }],
    });
    const scenarios = designScenarios(accepted).map((s) => ({
      ...s,
      oracle: { ...s.oracle, verifiedCompletion: true },
    }));
    const audit = auditCoverage({ requirements: accepted, scenarios });
    assert.ok(audit.findings.some((f) => f.code === "AMBIGUOUS_DECIDED"));
    assert.equal(mayExecute(audit), false);
  });
});
