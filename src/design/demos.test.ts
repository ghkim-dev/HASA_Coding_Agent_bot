import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  acceptProposals,
  applyUserApproval,
  confidenceFor,
  markConflicts,
  mergeRequirements,
  runtimeRequirements,
  systemBaseline,
  type RequirementProposal,
  type RequirementSpec,
} from "./requirementSpec.ts";
import { spansOf } from "./sourceSpan.ts";
import { designScenarios, GENERIC_RULE } from "./scenarioBlueprint.ts";
import { auditCoverage, mayExecute } from "./coverageAudit.ts";
import { closeCoverage, mayExecutePlan } from "./coverageClosure.ts";

/**
 * The demos, as tests.
 *
 * Deterministic because the runtime half is: prohibitions and named sources are
 * read from the user's words with no model involved, and a proposal is accepted
 * or refused by rules about coordinates and meaning. What a model *would*
 * propose is a fixture, so what is under test is what the runtime does with it.
 */

const T1 = "t1";
const T2 = "t2";

/** A proposal pointing at a real span of the text, the way a model must. */
function at(text: string, needle: string, over: Partial<RequirementProposal> = {}): RequirementProposal {
  const [span] = spansOf(text, needle, T1);
  assert.ok(span !== undefined, `fixture error: "${needle}" is not in the text`);
  return { text: over.text ?? needle, span, quote: needle, ...over };
}

const codes = (findings: readonly { code: string }[]): string[] => findings.map((f) => f.code);

// ---------------------------------------------------------------------------
// 1. Confirmation authority
// ---------------------------------------------------------------------------

describe("확정 권한 — 모델은 스스로 confirmed 가 될 수 없다", () => {
  const TEXT = "실행하지 말고 코드만 설명해줘.";

  test("model_proposal 은 confirmed 를 보내도 ambiguous", () => {
    const { accepted } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [at(TEXT, "코드만 설명해줘", { text: "코드를 설명한다", confidence: "confirmed" })],
    });
    assert.equal(accepted[0]?.confidence, "ambiguous");
    assert.equal(accepted[0]?.modelClaimedConfidence, "confirmed", "모델 주장은 정보로 남는다");
  });

  test("confidence 를 밝히지 않아도 ambiguous", () => {
    const { accepted } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [at(TEXT, "코드만 설명해줘", { text: "코드를 설명한다" })],
    });
    assert.equal(accepted[0]?.confidence, "ambiguous");
    assert.equal(accepted[0]?.modelClaimedConfidence, undefined);
  });

  test("derivedBy 를 runtime_prohibition 으로 위조하면 거부", () => {
    const forged = {
      ...at(TEXT, "코드만 설명해줘"),
      derivedBy: "runtime_prohibition",
    } as unknown as RequirementProposal;
    const { accepted, rejected } = acceptProposals({ turnId: T1, userText: TEXT, proposals: [forged] });
    assert.equal(accepted.length, 0);
    assert.deepEqual(rejected[0]?.reasons, ["forged_provenance"]);
  });

  test("derivedBy 를 runtime_source 로 위조해도 거부", () => {
    const forged = { ...at(TEXT, "코드만 설명해줘"), derivedBy: "runtime_source" } as unknown as RequirementProposal;
    assert.equal(acceptProposals({ turnId: T1, userText: TEXT, proposals: [forged] }).rejected.length, 1);
  });

  test("sourceText 를 직접 실어 보내면 거부", () => {
    const forged = { ...at(TEXT, "코드만 설명해줘"), sourceText: "실행" } as unknown as RequirementProposal;
    assert.deepEqual(
      acceptProposals({ turnId: T1, userText: TEXT, proposals: [forged] }).rejected[0]?.reasons,
      ["forged_provenance"],
    );
  });

  test("런타임이 읽은 금지는 confirmed", () => {
    const specs = runtimeRequirements({ turnId: T1, text: TEXT });
    assert.equal(specs[0]?.confidence, "confirmed");
    assert.equal(specs[0]?.derivedBy, "runtime_prohibition");
  });

  test("사용자가 다음 턴에서 승인하면 confirmed", () => {
    const { accepted } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [at(TEXT, "코드만 설명해줘", { text: "코드를 설명한다" })],
    });
    const approved = applyUserApproval({
      specs: accepted,
      approvalText: "네 맞습니다. 그렇게 해주세요.",
      approvedIds: [accepted[0]!.id],
      turnId: T2,
    });
    assert.equal(approved[0]?.confidence, "confirmed");
  });

  test("승인이 아닌 답변은 confirmed 로 만들지 않는다", () => {
    const { accepted } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [at(TEXT, "코드만 설명해줘", { text: "코드를 설명한다" })],
    });
    const answered = applyUserApproval({
      specs: accepted,
      approvalText: "아니요, 그건 아닙니다.",
      approvedIds: [accepted[0]!.id],
      turnId: T2,
    });
    assert.equal(answered[0]?.confidence, "ambiguous");
  });

  test("inherited confirmed 는 유지된다", () => {
    const standing = runtimeRequirements({ turnId: T1, text: TEXT });
    const merged = mergeRequirements({ standing, incoming: [], relation: "continue", turnId: T2 });
    assert.equal(merged[0]?.status, "inherited");
    assert.equal(merged[0]?.confidence, "confirmed");
  });

  test("system_added 는 explicit 이 될 수 없다", () => {
    for (const spec of systemBaseline(T1)) {
      assert.equal(spec.status, "system_added");
      assert.equal(spec.sourceText, "");
      assert.equal(spec.span, undefined);
    }
  });

  test("확정 권한은 한 함수가 결정한다", () => {
    assert.equal(confidenceFor({ derivedBy: "model_proposal" }), "ambiguous");
    assert.equal(confidenceFor({ derivedBy: "runtime_prohibition" }), "confirmed");
    assert.equal(confidenceFor({ derivedBy: "carried", previous: "confirmed" }), "confirmed");
    assert.equal(confidenceFor({ derivedBy: "model_proposal", userApproved: true }), "confirmed");
    assert.equal(confidenceFor({ derivedBy: "runtime_prohibition", conditional: true }), "ambiguous");
  });
});

// ---------------------------------------------------------------------------
// 2. SourceSpan
// ---------------------------------------------------------------------------

describe("SourceSpan — 런타임이 원문을 직접 자른다", () => {
  const TEXT = "실행하지 말고 코드만 분석해줘.";

  test("범위 밖은 거부", () => {
    const { rejected } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [{ text: "x", span: { turnId: T1, start: 0, end: 9999 } }],
    });
    assert.ok(rejected[0]?.reasons.includes("out_of_range"));
  });

  test("빈 범위와 역전된 범위는 거부", () => {
    for (const span of [
      { turnId: T1, start: 5, end: 5 },
      { turnId: T1, start: 8, end: 3 },
    ]) {
      const { rejected } = acceptProposals({ turnId: T1, userText: TEXT, proposals: [{ text: "x", span }] });
      assert.ok(rejected[0]?.reasons.includes("reversed"), JSON.stringify(span));
    }
  });

  test("모델이 말한 인용과 런타임이 자른 것이 다르면 거부", () => {
    const [span] = spansOf(TEXT, "코드만 분석해줘", T1);
    const { rejected } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [{ text: "x", span: span!, quote: "실행하지 말고" }],
    });
    assert.ok(rejected[0]?.reasons.includes("quote_mismatch"));
  });

  test("다른 턴의 좌표는 거부", () => {
    const [span] = spansOf(TEXT, "코드만 분석해줘", "t9");
    const { rejected } = acceptProposals({ turnId: T1, userText: TEXT, proposals: [{ text: "x", span: span! }] });
    assert.ok(rejected[0]?.reasons.includes("wrong_turn"));
  });

  test("부정 표현이 잘려나가면 거부", () => {
    // "실행" alone, cut out of "실행하지 말고".
    const { rejected } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [at(TEXT, "실행", { text: "실행이 필수 요구사항이다" })],
    });
    assert.ok(
      rejected[0]?.reasons.includes("negation_truncated") || rejected[0]?.reasons.includes("too_slight"),
      JSON.stringify(rejected[0]?.reasons),
    );
  });

  test("한 글자·두 글자 조각으로 must 를 세우지 않는다", () => {
    const { rejected } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [at(TEXT, "코드", { text: "코드를 본다", priority: "must" })],
    });
    assert.ok(rejected[0]?.reasons.includes("too_slight"));
  });

  test("오프셋은 UTF-16 코드 단위 — 한국어", () => {
    const korean = "실행하지 말고 코드만 분석해줘.";
    const [span] = spansOf(korean, "코드만 분석해줘", T1);
    assert.equal(korean.slice(span!.start, span!.end), "코드만 분석해줘");
    assert.equal(span!.end - span!.start, "코드만 분석해줘".length);
  });

  test("오프셋은 UTF-16 코드 단위 — 이모지는 2단위", () => {
    const withEmoji = "🚀 실행하지 말고 코드만 분석해줘.";
    assert.equal(withEmoji.length, "🚀".length + " 실행하지 말고 코드만 분석해줘.".length);
    assert.equal("🚀".length, 2, "surrogate pair is two UTF-16 units");
    const [span] = spansOf(withEmoji, "코드만 분석해줘", T1);
    assert.equal(withEmoji.slice(span!.start, span!.end), "코드만 분석해줘");
  });

  test("서로게이트 쌍 가운데를 자르면 거부", () => {
    const withEmoji = "🚀 실행하지 말고 코드만 분석해줘.";
    const { rejected } = acceptProposals({
      turnId: T1,
      userText: withEmoji,
      proposals: [{ text: "x", span: { turnId: T1, start: 1, end: 12 } }],
    });
    assert.ok(rejected[0]?.reasons.includes("split_surrogate"));
  });

  test("같은 문자열이 여러 번 나오면 위치가 후보를 구분한다", () => {
    const twice = "실행하지 말고 보여줘. 나중에 실행해도 좋아.";
    const spans = spansOf(twice, "실행", T1);
    assert.equal(spans.length, 2);
    assert.notEqual(spans[0]!.start, spans[1]!.start);
  });
});

// ---------------------------------------------------------------------------
// 3. Semantic and polarity
// ---------------------------------------------------------------------------

describe("의미·극성 — 인용이 맞아도 뜻이 뒤집히면 거부", () => {
  test("K  짧은 출처 위조: 금지 구절로 실행을 요구", () => {
    const TEXT = "실행하지 말고 코드만 설명해줘.";
    const { accepted, rejected } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [at(TEXT, "실행하지 말고", { text: "실행은 필수다", polarity: "required", confidence: "confirmed" })],
    });
    assert.equal(accepted.length, 0, "금지 구절을 근거로 실행 요구가 통과했습니다");
    assert.ok(rejected[0]?.reasons.includes("semantics_reversed"));
  });

  test("유지 구절로 제거를 요구하면 거부", () => {
    const TEXT = "기존 API 호환성을 유지하면서 인증 코드를 수정해줘.";
    const { rejected } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [at(TEXT, "기존 API 호환성을 유지하면서", { text: "기존 API를 제거한다" })],
    });
    assert.ok(rejected[0]?.reasons.includes("semantics_reversed"));
  });

  test("과거 실패 보고를 금지로 만들면 거부", () => {
    const TEXT = "아까는 실행하지 못했어. 원인을 고치고 이번에는 다시 실행해줘.";
    const { rejected } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [at(TEXT, "아까는 실행하지 못했어", { text: "실행하지 않는다", polarity: "forbidden" })],
    });
    assert.ok(rejected[0]?.reasons.includes("semantics_reversed"));
  });

  test("확인할 수 없는 대응은 ambiguous 로 남기고 감사에서 보고한다", () => {
    const TEXT = "open.hasa.re.kr/models 기준으로 확인해줘.";
    const { accepted } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [at(TEXT, "open.hasa.re.kr/models 기준으로 확인해줘", { text: "somewhere-else.example 을 확인한다" })],
    });
    assert.equal(accepted[0]?.alignment?.verdict, "unknown");
    const audit = auditCoverage({ requirements: accepted, scenarios: designScenarios(accepted) });
    assert.ok(codes(audit.findings).includes("SEMANTIC_ALIGNMENT_UNKNOWN"));
  });
});

// ---------------------------------------------------------------------------
// Demos A–F
// ---------------------------------------------------------------------------

describe("데모 A — 명시적 금지", () => {
  const TEXT = "수정하거나 실행하지 말고 main.py 코드만 분석해줘.";
  const specs = runtimeRequirements({ turnId: T1, text: TEXT });

  test("두 금지가 추출되고 confirmed 이며 원문 좌표를 갖는다", () => {
    // Filtered rather than counted: the extractor also reads the action the
    // user asked for now, and asserting a total of two was asserting that it
    // could not.
    const forbidden = specs.filter((s) => s.polarity === "forbidden");
    assert.equal(forbidden.length, 2);
    for (const spec of forbidden) {
      assert.equal(spec.polarity, "forbidden");
      assert.equal(spec.confidence, "confirmed");
      assert.ok(spec.span !== undefined);
      assert.equal(TEXT.slice(spec.span.start, spec.span.end).trim(), spec.sourceText);
    }
  });

  test("금지와 정상 허용 쌍이 유지되고 감사를 통과한다", () => {
    const closed = closeCoverage({ requirements: specs, scenarios: designScenarios(specs) });
    // The prohibitions themselves close cleanly. The request the same sentence
    // carries is `ambiguous` and raises its own question, which is a different
    // fact and is asserted where it belongs.
    const aboutForbidden = closed.audit.findings.filter((f) =>
      specs.some((s) => s.polarity === "forbidden" && s.id === f.subject),
    );
    assert.deepEqual(aboutForbidden, [], JSON.stringify(aboutForbidden));
    for (const spec of specs.filter((s) => s.polarity === "forbidden")) {
      const mine = closed.scenarios.filter((s) => s.requirementIds.includes(spec.id));
      assert.ok(mine.some((s) => s.oracle.forbiddenTools.length > 0));
      assert.ok(mine.some((s) => s.oracle.requiredTools.length > 0));
    }
  });
});

describe("데모 B — 실행 요청", () => {
  const TEXT = "main.py 코드도 보여주고 실제 실행 결과도 보여줘.";

  test("실행 요청을 금지로 오인하지 않는다", () => {
    const specs = runtimeRequirements({ turnId: T1, text: TEXT });
    assert.equal(specs.filter((s) => s.polarity === "forbidden").length, 0);
    // And it is read as the request it is.
    assert.ok(specs.some((s) => s.derivedBy === "runtime_action"));
  });

  test("초기 감사에서 실행 증거 누락을 발견하고 Closure 가 보완한다", () => {
    const { accepted } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [at(TEXT, "실제 실행 결과도 보여줘", { text: "main.py 를 실행하고 결과를 보여준다", priority: "must" })],
    });
    const approved = applyUserApproval({
      specs: accepted,
      approvalText: "네 맞습니다.",
      approvedIds: accepted.map((s) => s.id),
      turnId: T2,
    });

    const before = auditCoverage({ requirements: approved, scenarios: designScenarios(approved) });
    assert.ok(codes(before.findings).includes("EXECUTION_WITHOUT_EVIDENCE"));
    assert.equal(mayExecute(before), false);

    const closed = closeCoverage({ requirements: approved, scenarios: designScenarios(approved) });
    assert.ok(closed.history.some((p) => p.added.some((a) => a.because === "EXECUTION_WITHOUT_EVIDENCE")));
    assert.ok(!codes(closed.audit.findings).includes("EXECUTION_WITHOUT_EVIDENCE"), "보완 후에도 남았습니다");
  });
});

describe("데모 C — 정정", () => {
  const FIRST = "main.py를 실행해서 결과를 보여줘.";
  const SECOND = "처음에는 실행을 요청했지만 정정할게. 실행하지 말고 코드만 보여줘.";

  const standing = acceptProposals({
    turnId: T1,
    userText: FIRST,
    proposals: [at(FIRST, "main.py를 실행해서 결과를 보여줘", { text: "main.py 를 실행한다" })],
  }).accepted;

  test("이전 실행 요구사항은 superseded 로 유지되고 새 금지는 confirmed", () => {
    const incoming = runtimeRequirements({ turnId: T2, text: SECOND });
    const merged = mergeRequirements({ standing, incoming, relation: "correct", turnId: T2 });

    const original = merged.find((s) => s.id === standing[0]!.id);
    assert.equal(original?.supersededBy, T2);
    const fresh = merged.find((s) => s.id === "t2-forbid-execute");
    assert.equal(fresh?.confidence, "confirmed");
    assert.equal(fresh?.supersededBy, undefined);
  });

  test("superseded 요구사항에는 실행 시나리오가 없다", () => {
    const incoming = runtimeRequirements({ turnId: T2, text: SECOND });
    const merged = mergeRequirements({ standing, incoming, relation: "correct", turnId: T2 });
    const scenarios = designScenarios(merged);
    assert.equal(scenarios.filter((s) => s.requirementIds.includes(standing[0]!.id)).length, 0);
  });

  test("모델이 confirmed 를 위조해도 결과가 같다", () => {
    const forgedStanding = acceptProposals({
      turnId: T1,
      userText: FIRST,
      proposals: [
        at(FIRST, "main.py를 실행해서 결과를 보여줘", {
          text: "main.py 를 실행한다",
          confidence: "confirmed",
        }),
      ],
    }).accepted;
    assert.equal(forgedStanding[0]?.confidence, "ambiguous");

    const incoming = runtimeRequirements({ turnId: T2, text: SECOND });
    const a = mergeRequirements({ standing, incoming, relation: "correct", turnId: T2 });
    const b = mergeRequirements({ standing: forgedStanding, incoming, relation: "correct", turnId: T2 });
    assert.deepEqual(
      a.map((s) => [s.id, s.supersededBy, s.confidence]),
      b.map((s) => [s.id, s.supersededBy, s.confidence]),
    );
  });

  test("refine 은 유지하며 더하고, question/continue 는 만들지 않는다", () => {
    const s = runtimeRequirements({ turnId: T1, text: "실행하지 말고 보여줘." });
    const i = runtimeRequirements({ turnId: T2, text: "수정도 하지 말아줘." });
    assert.equal(
      mergeRequirements({ standing: s, incoming: i, relation: "refine", turnId: T2 }).length,
      s.length + i.length,
    );
    for (const relation of ["question", "continue"] as const) {
      assert.equal(
        mergeRequirements({ standing: s, incoming: i, relation, turnId: T2 }).length,
        s.length,
        relation,
      );
    }
  });
});

describe("데모 D — 과거 실패와 재실행", () => {
  const TEXT = "아까는 실행하지 못했어. 원인을 고치고 이번에는 다시 실행해줘.";

  test("과거 실패를 금지로 읽지 않는다", () => {
    const specs = runtimeRequirements({ turnId: T1, text: TEXT });
    assert.equal(
      specs.filter((s) => s.polarity === "forbidden").length,
      0,
      "'실행하지 못했어' 는 보고이지 금지가 아니다",
    );
  });

  test("실행 증거와 회귀 시나리오가 자동 보완되고 재감사를 통과한다", () => {
    const { accepted } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [
        at(TEXT, "원인을 고치고 이번에는 다시 실행해줘", {
          text: "실행 실패 원인을 수정하고 다시 실행한다",
          priority: "must",
        }),
      ],
    });
    const approved = applyUserApproval({
      specs: accepted,
      approvalText: "네, 진행해주세요.",
      approvedIds: accepted.map((s) => s.id),
      turnId: T2,
    });

    const before = auditCoverage({ requirements: approved, scenarios: designScenarios(approved) });
    assert.ok(codes(before.findings).includes("EXECUTION_WITHOUT_EVIDENCE"));
    assert.ok(codes(before.findings).includes("MODIFY_WITHOUT_REGRESSION"));

    const closed = closeCoverage({ requirements: approved, scenarios: designScenarios(approved) });
    const after = codes(closed.audit.findings);
    assert.ok(!after.includes("EXECUTION_WITHOUT_EVIDENCE"));
    assert.ok(!after.includes("MODIFY_WITHOUT_REGRESSION"));
  });
});

describe("데모 E — 외부 출처", () => {
  const TEXT = "open.hasa.re.kr/models를 기준으로 사용할 수 있는 모델을 확인해줘.";

  test("출처가 span 과 함께 요구사항이 된다", () => {
    const specs = runtimeRequirements({ turnId: T1, text: TEXT });
    const source = specs.find((s) => s.derivedBy === "runtime_source");
    assert.ok(source !== undefined);
    assert.equal(source.confidence, "confirmed");
    assert.ok(source.span !== undefined);
    assert.equal(TEXT.slice(source.span.start, source.span.end).trim(), source.sourceText);
  });

  test("provenance 검사가 붙고 감사를 통과한다", () => {
    const specs = runtimeRequirements({ turnId: T1, text: TEXT });
    const closed = closeCoverage({ requirements: specs, scenarios: designScenarios(specs) });
    assert.ok(closed.scenarios.some((s) => s.oracle.requiredEvidence.includes("web_source")));
    const aboutSource = closed.audit.findings.filter((f) =>
      specs.some((s) => s.derivedBy === "runtime_source" && s.id === f.subject),
    );
    assert.deepEqual(aboutSource, [], JSON.stringify(aboutSource));
  });
});

describe("데모 F — 복합 요구사항", () => {
  const TEXT =
    "기존 Arena와 Worktree를 유지하면서 HASA Coding Agent를 추가하고, " +
    "API Key는 SecretStorage에만 저장하며 기존 테스트를 모두 유지해줘.";

  const proposals = (): RequirementProposal[] => [
    at(TEXT, "기존 Arena와 Worktree를 유지하면서", { text: "기존 Arena 와 Worktree 를 유지한다", kind: "compatibility", priority: "must" }),
    at(TEXT, "HASA Coding Agent를 추가하고", { text: "HASA Coding Agent 를 추가한다", kind: "functional", priority: "must" }),
    at(TEXT, "API Key는 SecretStorage에만 저장하며", { text: "API Key 는 SecretStorage 에만 저장한다", kind: "security", priority: "must" }),
    at(TEXT, "기존 테스트를 모두 유지해줘", { text: "기존 테스트를 모두 유지한다", kind: "quality", priority: "must" }),
  ];

  test("발명된 요구사항은 거부된다", () => {
    const { accepted, rejected } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [
        ...proposals(),
        { text: "성능을 두 배로 개선한다", span: { turnId: T1, start: 0, end: 12 }, quote: "성능을 두 배로" },
      ],
    });
    assert.equal(accepted.length, 4);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]?.reasons.includes("quote_mismatch"));
  });

  test("보안 요구사항에는 보안 oracle 이 붙는다", () => {
    const { accepted } = acceptProposals({ turnId: T1, userText: TEXT, proposals: proposals() });
    const security = accepted.find((s) => s.kind === "security");
    const mine = designScenarios(accepted).filter((s) => s.requirementIds.includes(security!.id));
    assert.ok(mine.some((s) => s.designRuleId === "security.v1"));
    assert.ok(mine.some((s) => s.oracleCoverage.includes("secret_not_persisted")));
  });

  test("회귀 누락이 자동 보완되고 재감사에서 사라진다", () => {
    const { accepted } = acceptProposals({ turnId: T1, userText: TEXT, proposals: proposals() });
    const approved = applyUserApproval({
      specs: accepted,
      approvalText: "확인했습니다. 진행해주세요.",
      approvedIds: accepted.map((s) => s.id),
      turnId: T2,
    });
    const before = auditCoverage({ requirements: approved, scenarios: designScenarios(approved) });
    assert.ok(codes(before.findings).includes("MODIFY_WITHOUT_REGRESSION"));

    const closed = closeCoverage({ requirements: approved, scenarios: designScenarios(approved) });
    assert.ok(!codes(closed.audit.findings).includes("MODIFY_WITHOUT_REGRESSION"));
    assert.ok(closed.scenarios.some((s) => s.category === "regression"));
  });

  test("system_added 는 explicit 과 섞이지 않는다", () => {
    const { accepted } = acceptProposals({ turnId: T1, userText: TEXT, proposals: proposals() });
    const all = [...accepted, ...systemBaseline(T1)];
    assert.equal(all.filter((s) => s.status === "explicit").length, 4);
    assert.equal(all.filter((s) => s.status === "system_added").length, 2);
  });
});

// ---------------------------------------------------------------------------
// Demos G–K
// ---------------------------------------------------------------------------

describe("데모 G — 우선순위", () => {
  const TEXT = "기존 API 호환성은 반드시 유지하고, 가능하면 응답 속도도 개선해줘.";

  test("반드시 는 must, 가능하면 은 must 가 아니다", () => {
    const { accepted } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [
        at(TEXT, "기존 API 호환성은 반드시 유지하고", { text: "기존 API 호환성을 유지한다", priority: "must" }),
        at(TEXT, "가능하면 응답 속도도 개선해줘", { text: "응답 속도를 개선한다", priority: "must" }),
      ],
    });
    assert.equal(accepted[0]?.priority, "must");
    assert.equal(accepted[1]?.priority, "may", "모델이 must 라 해도 원문이 '가능하면' 이면 올리지 않는다");
  });

  test("속도 개선 누락이 전체 실패로 승격되지 않는다", () => {
    const { accepted } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [at(TEXT, "가능하면 응답 속도도 개선해줘", { text: "응답 속도를 개선한다", priority: "must" })],
    });
    const audit = auditCoverage({ requirements: accepted, scenarios: [] });
    assert.equal(audit.coverage.needed, 0, "may 요구사항이 must 커버리지 분모에 들어갔습니다");
    assert.ok(!codes(audit.findings).includes("MUST_WITHOUT_SCENARIO"));
  });
});

describe("데모 H — 조건부 요구사항", () => {
  const TEXT = "기존 클라이언트가 사용 중이라면 API 형식을 변경하지 마.";

  test("조건이 붙은 요구사항은 확정되지 않는다", () => {
    const specs = runtimeRequirements({ turnId: T1, text: TEXT });
    const forbid = specs.find((s) => s.polarity === "forbidden");
    assert.ok(forbid !== undefined, "금지가 추출되지 않았습니다");
    assert.equal(forbid.confidence, "ambiguous");
    assert.ok(forbid.condition !== undefined);
  });

  test("조건은 감사에서 미해결로 보고되고 자동 보완되지 않는다", () => {
    const specs = runtimeRequirements({ turnId: T1, text: TEXT });
    const closed = closeCoverage({ requirements: specs, scenarios: designScenarios(specs) });
    assert.ok(codes(closed.unresolved).includes("UNRESOLVED_CONDITION"));
    assert.equal(mayExecutePlan(closed), false);
  });
});

describe("데모 I — 범위", () => {
  const TEXT = "auth 폴더 안에서만 수정하고 다른 파일은 건드리지 마.";

  test("범위가 auth 로 제한된다", () => {
    const { accepted } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [at(TEXT, "auth 폴더 안에서만 수정하고", { text: "auth 폴더 안에서만 수정한다", priority: "must" })],
    });
    assert.deepEqual(accepted[0]?.scope, ["auth"]);
  });

  test("범위 안 허용과 범위 밖 0 이 함께 설계된다", () => {
    const { accepted } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [at(TEXT, "auth 폴더 안에서만 수정하고", { text: "auth 폴더 안에서만 수정한다", priority: "must" })],
    });
    const scenarios = designScenarios(accepted);
    assert.ok(scenarios.some((s) => s.designRuleId === "scope.v1" && s.category === "happy_path"));
    assert.ok(scenarios.some((s) => s.designRuleId === "scope.v1" && s.category === "negative"));
    assert.ok(scenarios.every((s) => s.oracle.writeScope.length === 0 || s.oracle.writeScope.includes("auth")));
  });
});

describe("데모 J — 충돌", () => {
  const TEXT = "API 응답 형식은 그대로 유지하면서 필드 이름을 전부 바꿔줘.";

  test("두 요구사항의 충돌을 감지한다", () => {
    const { accepted } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [
        at(TEXT, "API 응답 형식은 그대로 유지하면서", { text: "API 응답 형식을 그대로 유지한다", priority: "must" }),
        at(TEXT, "필드 이름을 전부 바꿔줘", { text: "API 응답 필드 이름을 전부 바꾼다", priority: "must" }),
      ],
    });
    const marked = markConflicts(accepted);
    assert.ok(marked.some((s) => s.conflicts.length > 0), "충돌이 감지되지 않았습니다");
  });

  test("한쪽을 임의로 선택하지 않고 실행 불가로 남긴다", () => {
    const { accepted } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [
        at(TEXT, "API 응답 형식은 그대로 유지하면서", { text: "API 응답 형식을 그대로 유지한다", priority: "must" }),
        at(TEXT, "필드 이름을 전부 바꿔줘", { text: "API 응답 필드 이름을 전부 바꾼다", priority: "must" }),
      ],
    });
    const marked = markConflicts(accepted);
    const closed = closeCoverage({ requirements: marked, scenarios: designScenarios(marked) });
    assert.ok(codes(closed.unresolved).includes("REQUIREMENT_CONFLICT"));
    assert.equal(mayExecutePlan(closed), false);
    assert.equal(marked.filter((s) => s.supersededBy !== undefined).length, 0, "한쪽을 조용히 버렸습니다");
  });
});

// ---------------------------------------------------------------------------
// Design-rule meta audit and closure behaviour
// ---------------------------------------------------------------------------

describe("설계 규칙 자체의 감사", () => {
  const TEXT = "사용자 경험을 전반적으로 개선해줘.";

  test("generic 시나리오만 있으면 덮인 것으로 표시하지 않는다", () => {
    const { accepted } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [at(TEXT, "사용자 경험을 전반적으로 개선해줘", { text: "사용자 경험을 개선한다", kind: "ux", priority: "must" })],
    });
    const scenarios = designScenarios(accepted);
    assert.ok(scenarios.some((s) => s.designRuleId === GENERIC_RULE));

    const audit = auditCoverage({ requirements: accepted, scenarios });
    assert.ok(codes(audit.findings).includes("NO_DESIGN_RULE"));
    assert.ok(codes(audit.findings).includes("UNSUPPORTED_REQUIREMENT_KIND"));
    assert.equal(mayExecute(audit), false);
  });

  test("규칙 없음은 자동 보완 대상이 아니다", () => {
    const { accepted } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [at(TEXT, "사용자 경험을 전반적으로 개선해줘", { text: "사용자 경험을 개선한다", kind: "ux", priority: "must" })],
    });
    const closed = closeCoverage({ requirements: accepted, scenarios: designScenarios(accepted) });
    assert.ok(codes(closed.unresolved).includes("NO_DESIGN_RULE"));
  });

  test("각 시나리오는 규칙 ID 와 oracle 커버리지를 갖는다", () => {
    const specs = runtimeRequirements({ turnId: T1, text: "실행하지 말고 보여줘." });
    for (const scenario of designScenarios(specs)) {
      assert.ok(scenario.designRuleId.length > 0, scenario.id);
      assert.ok(Array.isArray(scenario.unresolvedAspects), scenario.id);
      if (scenario.designRuleId !== GENERIC_RULE) {
        assert.ok(scenario.oracleCoverage.length > 0, `${scenario.id} 의 oracle 이 아무것도 결정하지 않습니다`);
      }
    }
  });
});

describe("Coverage Closure 의 동작 경계", () => {
  const TEXT = "main.py 를 실행해서 결과를 보여줘.";
  const specs = () =>
    applyUserApproval({
      specs: acceptProposals({
        turnId: T1,
        userText: TEXT,
        proposals: [at(TEXT, "main.py 를 실행해서 결과를 보여줘", { text: "main.py 를 실행한다", priority: "must" })],
      }).accepted,
      approvalText: "네 맞습니다.",
      approvedIds: [`${T1}-model-1`],
      turnId: T2,
    });

  test("보완 이력에 원인 finding 이 남는다", () => {
    const closed = closeCoverage({ requirements: specs(), scenarios: designScenarios(specs()) });
    assert.ok(closed.history.length > 0);
    assert.ok(closed.history[0]?.added.every((a) => a.because.length > 0));
    assert.ok(closed.history[0]?.before.length > 0, "보완 전 감사 결과가 기록되지 않았습니다");
  });

  test("같은 결과를 결정론적으로 낸다", () => {
    const a = closeCoverage({ requirements: specs(), scenarios: designScenarios(specs()) });
    const b = closeCoverage({ requirements: specs(), scenarios: designScenarios(specs()) });
    assert.deepEqual(a.scenarios.map((s) => s.id), b.scenarios.map((s) => s.id));
    assert.deepEqual(codes(a.audit.findings), codes(b.audit.findings));
  });

  test("maxPasses 를 넘기지 않는다", () => {
    const closed = closeCoverage({
      requirements: specs(),
      scenarios: designScenarios(specs()),
      maxPasses: 1,
    });
    assert.ok(closed.passes <= 1);
  });

  test("종료를 보장하는 것은 시도 기록이지 pass 상한이 아니다", () => {
    // Worth naming, because a mutation that removes `maxPasses` changes
    // nothing: `attempted` already refuses to repair the same finding twice, so
    // the loop converges before any ceiling is reached. The ceiling is a bound
    // on a path this design does not take, kept as insurance for when remedies
    // start chaining. The guarantee under test is the first one.
    const closed = closeCoverage({ requirements: specs(), scenarios: designScenarios(specs()) });
    const ids = closed.scenarios.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, "같은 시나리오가 중복 추가됐습니다");
  });

  test("AbortSignal 이 이미 취소돼 있으면 보완하지 않는다", () => {
    const controller = new AbortController();
    controller.abort();
    const closed = closeCoverage({
      requirements: specs(),
      scenarios: designScenarios(specs()),
      signal: controller.signal,
    });
    assert.equal(closed.stoppedBecause, "aborted");
    assert.equal(closed.passes, 0);
  });

  test("모호한 요구사항은 자동 보완으로 실행 가능해지지 않는다", () => {
    const ambiguous = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [at(TEXT, "main.py 를 실행해서 결과를 보여줘", { text: "main.py 를 실행한다", priority: "must" })],
    }).accepted;
    assert.equal(ambiguous[0]?.confidence, "ambiguous");
    const closed = closeCoverage({ requirements: ambiguous, scenarios: designScenarios(ambiguous) });
    assert.ok(closed.scenarios.every((s) => s.unresolvedAspects.includes("requirement_is_ambiguous")));
  });

  test("호출 권한 없는 모델이 있으면 실행 불가", () => {
    const closed = closeCoverage({
      requirements: specs(),
      scenarios: designScenarios(specs()),
      plannedModels: ["glm-4.7-flash", "qwen3-32b"],
      permittedModels: ["glm-4.7-flash"],
    });
    assert.ok(codes(closed.unresolved).includes("MODEL_MAY_NOT_BE_CALLED"));
    assert.equal(mayExecutePlan(closed), false);
  });
});

describe("감사가 구조를 보는 방식 — 규칙 자체의 고정", () => {
  const specs = runtimeRequirements({ turnId: T1, text: "실행하지 말고 보여줘." });

  test("요구사항에 연결되지 않은 시나리오를 잡는다", () => {
    const orphan = { ...designScenarios(specs)[0]!, requirementIds: [] };
    const audit = auditCoverage({
      requirements: specs,
      scenarios: [...designScenarios(specs), orphan],
    });
    assert.ok(codes(audit.findings).includes("SCENARIO_WITHOUT_REQUIREMENT"));
  });

  test("한 시나리오에 요구사항이 너무 많으면 잡는다", () => {
    const overloaded = { ...designScenarios(specs)[0]!, requirementIds: ["a", "b", "c", "d"] };
    const audit = auditCoverage({ requirements: specs, scenarios: [overloaded] });
    assert.ok(codes(audit.findings).includes("SCENARIO_OVERLOADED"));
  });

  test("금지에 정상 허용 짝이 없으면 감사가 잡는다", () => {
    // Checked at the audit rather than only through closure: closure adds the
    // pair, and a plan that never audits for it would look complete the moment
    // the repair path is removed.
    const oneSided = designScenarios(specs).filter((s) => s.oracle.requiredTools.length === 0);
    const audit = auditCoverage({ requirements: specs, scenarios: oneSided });
    assert.ok(codes(audit.findings).includes("FORBIDDEN_WITHOUT_POSITIVE_PAIR"));
    assert.equal(mayExecute(audit), false);
  });

  test("금지에 부작용 oracle 이 없으면 잡는다", () => {
    const noSideEffect = designScenarios(specs).map((s) => ({
      ...s,
      oracle: { ...s.oracle, forbiddenTools: [] },
    }));
    const audit = auditCoverage({ requirements: specs, scenarios: noSideEffect });
    assert.ok(codes(audit.findings).includes("FORBIDDEN_WITHOUT_SIDE_EFFECT_ORACLE"));
  });

  test("문장에 의존하는 oracle 을 잡는다", () => {
    const first = designScenarios(specs)[0]!;
    const prosy = { ...first, oracle: { ...first.oracle, answerContains: "완료했습니다" } as never };
    const audit = auditCoverage({ requirements: specs, scenarios: [prosy] });
    assert.ok(codes(audit.findings).includes("ORACLE_READS_PROSE"));
  });

  test("must 에 시나리오가 없으면 실행을 막는다", () => {
    const audit = auditCoverage({ requirements: specs, scenarios: [] });
    assert.ok(codes(audit.findings).includes("MUST_WITHOUT_SCENARIO"));
    assert.equal(audit.coverage.covered, 0);
    assert.equal(mayExecute(audit), false);
  });
});

describe("모델 문자열은 어디에도 저장되지 않는다", () => {
  const TEXT = "실행하지 말고 코드만 분석해줘.";

  test("sourceText 는 런타임이 자른 것이지 모델이 보낸 quote 가 아니다", () => {
    // Whitespace differs deliberately: if `sourceText` ever came from the
    // proposal, this is the shape that would show it. The quote passes the
    // match check — it normalises equal — and is still not what gets stored.
    const [span] = spansOf(TEXT, "코드만 분석해줘", T1);
    const { accepted } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [{ text: "코드를 분석한다", span: span!, quote: "코드만   분석해줘" }],
    });
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.sourceText, "코드만 분석해줘", "모델의 표기가 그대로 저장됐습니다");
    assert.equal(
      TEXT.slice(accepted[0]!.span!.start, accepted[0]!.span!.end),
      accepted[0]?.sourceText,
      "저장된 문자열이 좌표와 일치하지 않습니다",
    );
  });
});

describe("부정이 잘린 인용은 근거가 되지 못한다", () => {
  test("금지 구절의 앞부분만 잘라내면 거부", () => {
    // "실행" cut out of "실행하지 말고": the words are the user's and the
    // meaning is the opposite. This is the failure the coordinates exist for.
    const TEXT = "실행하지 말고 코드만 분석해줘. 실행 로그도 정리해줘.";
    const [span] = spansOf(TEXT, "실행", T1);
    const { accepted, rejected } = acceptProposals({
      turnId: T1,
      userText: TEXT,
      proposals: [{ text: "실행이 필요하다", span: span!, quote: "실행", polarity: "required" }],
    });
    assert.equal(accepted.length, 0);
    assert.ok(
      rejected[0]?.reasons.includes("negation_truncated"),
      `expected negation_truncated, got ${JSON.stringify(rejected[0]?.reasons)}`,
    );
  });
});

describe("Closure 는 무한히 돌지 않는다", () => {
  test("보완할 것이 계속 생겨도 maxPasses 에서 멈춘다", () => {
    // A designer that never satisfies the audit. Without a pass ceiling this is
    // a loop, and a loop in a planner is a harness that never reports.
    const spec: RequirementSpec = {
      id: "loop-1",
      text: "테스트를 실행하고 파일을 수정한다",
      sourceText: "테스트를 실행하고 파일을 수정한다",
      span: { turnId: T1, start: 0, end: 18 },
      sourceTurnId: T1,
      kind: "functional",
      priority: "must",
      polarity: "required",
      status: "explicit",
      confidence: "confirmed",
      dependencies: [],
      conflicts: [],
      derivedBy: "runtime_prohibition",
    };
    const closed = closeCoverage({ requirements: [spec], scenarios: [], maxPasses: 2 });
    assert.ok(closed.passes <= 2, `passes=${closed.passes}`);
    assert.ok(["max_passes", "settled", "no_progress"].includes(closed.stoppedBecause));
  });
});
