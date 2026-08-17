import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { GOLD_CASES } from "./goldCases.ts";
import {
  KNOWN_MISSES,
  NEVER_ASKED,
  UNMEASURED,
  readExtraction,
  scoreGold,
  startableOf,
  type GoldCategory,
  type GoldScore,
} from "./goldRequirements.ts";
import { previewDesign, type PreviewResult } from "./preview.ts";
import { questionsFrom } from "./previewReport.ts";
import { measurePreviews } from "./previewMetrics.ts";

/**
 * The measurement, with its denominators written down beside it.
 *
 * What this file is allowed to claim is bounded by what `goldCases.ts` wrote
 * down. Where the gold is silent the number stays absent — `UNMEASURED` is
 * asserted to be non-empty and to still name the things nobody has annotated,
 * because a suite that quietly stops listing them is how "we did not measure
 * this" turns into "this was fine".
 *
 * Every rate below is asserted as a *pair of integers* rather than as a rounded
 * ratio. `0.98` reads the same at 49/50 and at 490/500, and the second one is a
 * much stronger claim; pinning the numerator and the denominator makes the
 * strength of the claim part of the test.
 */

let score: GoldScore;
const previews = new Map<string, PreviewResult>();

before(async () => {
  for (const gold of GOLD_CASES) {
    previews.set(gold.id, await previewDesign({ turns: gold.turns.map((t) => t.text) }));
  }
  score = scoreGold(GOLD_CASES, previews);
});

describe("Gold 집합 자체", () => {
  test("30개 이상이고, 요구된 범주를 모두 덮는다", () => {
    assert.ok(GOLD_CASES.length >= 30, `${GOLD_CASES.length} 개뿐입니다`);
    const required: GoldCategory[] = [
      "explicit",
      "prohibition",
      "correction",
      "refinement",
      "question",
      "continuation",
      "compound",
      "particle",
      "omitted_object",
      "past_failure",
      "conditional",
      "preserve",
      "inspect",
      "mixed_script",
      "wrong_binding",
      "question_restraint",
      "no_invention",
    ];
    const covered = new Set(GOLD_CASES.map((c) => c.category));
    assert.deepEqual(
      required.filter((c) => !covered.has(c)),
      [],
      "정답이 없는 범주가 남아 있습니다",
    );
  });

  test("모든 사례에 9개 축의 정답이 기록돼 있다", () => {
    for (const gold of GOLD_CASES) {
      assert.ok(gold.why.length > 0, `${gold.id}: 왜 이 사례가 있는지가 없습니다`);
      assert.ok(gold.turns.length > 0, `${gold.id}: 턴이 없습니다`);
      assert.equal(typeof gold.startable, "boolean", `${gold.id}: 시작 가능 여부가 없습니다`);
      assert.equal(typeof gold.executable, "boolean", `${gold.id}: 실행 가능 여부가 없습니다`);
      assert.ok(gold.questions.max >= 0, `${gold.id}: 질문 상한이 없습니다`);
      for (const turn of gold.turns) {
        assert.ok(turn.relation.length > 0, `${gold.id}: relation 이 없습니다`);
        for (const req of turn.requirements) {
          assert.ok(req.action.length > 0, `${gold.id}: action 이 없습니다`);
          assert.ok(
            req.polarity === "required" || req.polarity === "forbidden",
            `${gold.id}: polarity 가 없습니다`,
          );
          assert.ok(req.quote.length > 0, `${gold.id}: 근거 구절이 없습니다`);
          assert.ok(
            turn.text.includes(req.quote),
            `${gold.id}: 근거 구절 "${req.quote}" 이 턴 원문에 없습니다`,
          );
          // `null` is a recorded answer; an empty string would be an omission.
          assert.ok(req.target === null || req.target.length > 0, `${gold.id}: target 이 빈 문자열입니다`);
        }
      }
    }
  });

  test("한국어 중심이다", () => {
    const hangul = GOLD_CASES.filter((c) => c.turns.some((t) => /[가-힣]/.test(t.text)));
    assert.equal(hangul.length, GOLD_CASES.length, "한글이 없는 사례가 있습니다");
  });
});

describe("요구사항 정확성 — 분모를 함께", () => {
  test("recall 59/59", () => {
    assert.deepEqual(score.requirementRecall, { hit: 59, of: 59, value: 1 });
    assert.deepEqual(score.missed, [], "놓친 요구사항이 있습니다");
  });

  test("precision 59/59 — 발명이 0이다", () => {
    // The one that must never slip. A missing requirement is visible to the user
    // as work not done; an invented one is work they never asked for.
    assert.deepEqual(score.requirementPrecision, { hit: 59, of: 59, value: 1 });
    assert.deepEqual(score.spurious, [], "요청에 없는 요구사항을 만들었습니다");
  });

  test("target 정확도 59/59, span 근거 59/59", () => {
    assert.deepEqual(score.targetAccuracy, { hit: 59, of: 59, value: 1 });
    assert.deepEqual(score.spanGrounding, { hit: 59, of: 59, value: 1 });
  });

  test("relation 48/48", () => {
    assert.deepEqual(score.relationAccuracy, { hit: 48, of: 48, value: 1 });
  });

  test("대상이 없는 요청은 대상을 만들어내지 않는다", () => {
    // The precision number above says nothing was invented in aggregate. This
    // says it about the specific axis where inventing is easiest.
    for (const gold of GOLD_CASES) {
      gold.turns.forEach((turn, index) => {
        const got = readExtraction({ turnId: `t${index + 1}`, text: turn.text });
        for (const want of turn.requirements) {
          if (want.target !== null) continue;
          const same = got.filter((g) => g.action === want.action && g.polarity === want.polarity);
          assert.ok(
            same.some((g) => g.target === null),
            `${gold.id}: "${want.quote}" 의 대상은 문장에 없는데 ${JSON.stringify(
              same.map((g) => g.target),
            )} 로 채웠습니다`,
          );
        }
      });
    }
  });
});

describe("질문 정확성 — 분모를 함께", () => {
  test("recall 12/12, precision 13/13", () => {
    // Precision was 11/33. The 22 false positives were all `NO_DESIGN_RULE` —
    // the plan asking a user to design its verification rules — and they are gone
    // because the five missing act rules were written, not because the question
    // was suppressed: recall went *up* at the same time, from 11/12 to 12/12.
    assert.deepEqual(score.questionRecall, { hit: 12, of: 12, value: 1 });
    assert.deepEqual(score.questionPrecision, { hit: 13, of: 13, value: 1 });
  });

  test("초과 질문이 하나도 없다", () => {
    assert.deepEqual(score.unexpectedQuestions, []);
  });

  test("질문을 없애서 precision 을 만든 것이 아니다", () => {
    // The cheap way to a perfect precision is to ask nothing at all. So: every
    // case whose gold expects a question got one, and the total asked is the total
    // expected — 13 questions across 43 cases, none of them about our own
    // verification rules.
    const askedTotal = GOLD_CASES.reduce(
      (sum, gold) => sum + questionsFrom(previews.get(gold.id) as PreviewResult).length,
      0,
    );
    assert.equal(askedTotal, 13);
    assert.deepEqual(score.missingQuestions, []);
    for (const gold of GOLD_CASES) {
      if (gold.questions.expected.length === 0) continue;
      const asked = questionsFrom(previews.get(gold.id) as PreviewResult);
      assert.ok(asked.length > 0, `${gold.id}: 물어야 하는데 묻지 않았습니다`);
    }
  });

  test("사용자가 직접 말한 요구를 되묻지 않는다", () => {
    for (const gold of GOLD_CASES) {
      const preview = previews.get(gold.id);
      assert.ok(preview !== undefined);
      for (const question of questionsFrom(preview)) {
        assert.ok(
          !NEVER_ASKED.includes(question.code),
          `${gold.id}: ${question.code} 을 물었습니다 (${question.subject})`,
        );
      }
    }
  });

  test("질문 상한을 넘는 사례가 없다", () => {
    assert.deepEqual(score.questionCeiling, { hit: 43, of: 43, value: 1 });
  });

  test("요구사항 하나에 질문은 하나다", () => {
    for (const gold of GOLD_CASES) {
      const asked = questionsFrom(previews.get(gold.id) as PreviewResult);
      const subjects = asked.map((q) => q.subject);
      assert.equal(new Set(subjects).size, subjects.length, `${gold.id}: 같은 대상을 두 번 물었습니다`);
    }
  });

  test("가장 급한 finding 이 질문이 된다", () => {
    // Ranking, not emission order. A missing verification rule used to crowd out
    // an unsettled condition on the same requirement.
    const conditional = previews.get("conditional-requirement") as PreviewResult;
    const asked = questionsFrom(conditional);
    assert.ok(
      asked.some((q) => q.code === "UNRESOLVED_CONDITION"),
      "조건이 정해지지 않았는데 다른 것을 물었습니다",
    );
  });
});

describe("Startable 과 Executable 은 다른 주장이다", () => {
  test("Requirement Startability 43/43", () => {
    // Understanding the sentence. Says nothing about whether anything may run.
    assert.deepEqual(score.requirementStartability, { hit: 43, of: 43, value: 1 });
  });

  test("Harness Executability 43/43", () => {
    // A different claim with its own denominator: every requirement covered by a
    // design rule, and nothing the audit could not close.
    assert.deepEqual(score.harnessExecutability, { hit: 43, of: 43, value: 1 });
  });

  test("두 축을 교차하면 남는 사례가 없다", () => {
    assert.deepEqual(score.cross.startableNotExecutable, []);
    assert.deepEqual(score.cross.executableNotStartable, []);
  });

  test("사용자 요구사항이 없는데 Executable 인 사례는 0건이다", () => {
    // The invariant, measured over the whole set rather than asserted about one
    // sentence. `고마워.` used to be a plan ready to run.
    assert.deepEqual(score.cross.executableWithoutUserRequirement, []);
  });

  test("대상이 열린 요구사항이 있으면 시작 가능이 아니다", () => {
    for (const gold of GOLD_CASES) {
      if (gold.startable) continue;
      const preview = previews.get(gold.id) as PreviewResult;
      const known = KNOWN_MISSES.some((m) => m.caseId === gold.id && m.axis === "startability");
      if (known) continue;
      assert.equal(startableOf(preview), false, `${gold.id}: 시작 가능으로 표시됐습니다`);
      assert.equal(preview.executable, false, `${gold.id}: 실행 가능으로 표시됐습니다`);
      assert.equal(preview.mayExecute, false, `${gold.id}: 도구 실행이 허용됐습니다`);
      assert.deepEqual(preview.plannedTools, [], `${gold.id}: 실행 계획이 남아 있습니다`);
    }
  });
});

describe("아직 맞지 않는 것은 이름을 갖는다", () => {
  test("남은 불일치는 KNOWN_MISSES 와 정확히 같다", () => {
    const observed: Array<{ caseId: string; axis: string }> = [
      ...score.missed.map((m) => ({ caseId: m.caseId, axis: "requirement" })),
      ...score.spurious.map((s) => ({ caseId: s.caseId, axis: "requirement" })),
      ...score.missingQuestions.map((q) => ({ caseId: q.caseId, axis: "question" })),
      ...GOLD_CASES.filter(
        (c) => startableOf(previews.get(c.id) as PreviewResult) !== c.startable,
      ).map((c) => ({ caseId: c.id, axis: "startability" })),
    ];
    const expected = KNOWN_MISSES.map((m) => ({ caseId: m.caseId, axis: m.axis }));
    assert.deepEqual(
      observed.sort((a, b) => `${a.caseId}${a.axis}`.localeCompare(`${b.caseId}${b.axis}`)),
      expected.sort((a, b) => `${a.caseId}${a.axis}`.localeCompare(`${b.caseId}${b.axis}`)),
    );
  });

  test("모든 KNOWN_MISSES 에 이유와 판정이 있다", () => {
    for (const miss of KNOWN_MISSES) {
      assert.ok(miss.reason.length > 40, `${miss.caseId}: 이유가 너무 짧습니다`);
      assert.ok(["defect", "by_design"].includes(miss.verdict));
      assert.ok(
        GOLD_CASES.some((c) => c.id === miss.caseId),
        `${miss.caseId}: 존재하지 않는 사례를 가리킵니다`,
      );
    }
  });

  test("정답이 없는 축은 계속 unmeasured 로 남는다", () => {
    assert.ok(UNMEASURED.length > 0);
    assert.deepEqual(score.unmeasured, UNMEASURED);
    for (const needle of ["priority", "kind", "Oracle coverage", "모델 제안"]) {
      assert.ok(
        UNMEASURED.some((line) => line.includes(needle)),
        `${needle} 이 unmeasured 목록에서 사라졌습니다`,
      );
    }
  });

  test("fixture 지표는 여전히 recall·precision 을 주장하지 않는다", () => {
    // The gold set does not license the *fixture* metrics to start printing
    // these. Two different populations; only one of them has answers.
    const metrics = measurePreviews([...previews.values()]);
    for (const line of metrics.unmeasured) assert.ok(line.length > 0);
    assert.ok(
      metrics.unmeasured.some((l) => l.includes("requirementRecall")),
      "fixture 쪽 unmeasured 에서 recall 이 사라졌습니다",
    );
    assert.ok(!Object.keys(metrics).includes("requirementRecall"));
  });
});

describe("측정은 결정적이다", () => {
  test("같은 입력에 같은 점수", async () => {
    const again = new Map<string, PreviewResult>();
    for (const gold of GOLD_CASES) {
      again.set(gold.id, await previewDesign({ turns: gold.turns.map((t) => t.text) }));
    }
    assert.deepEqual(scoreGold(GOLD_CASES, again), score);
  });
});
