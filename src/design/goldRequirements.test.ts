import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { GOLD_CASES } from "./goldCases.ts";
import {
  KNOWN_MISSES,
  NEVER_ASKED,
  UNMEASURED,
  pairRequirements,
  readExtraction,
  scoreGold,
  startableOf,
  type ExtractedRequirement,
  type GoldCase,
  type GoldCategory,
  type GoldScore,
  type GoldTurn,
  type Pairing,
} from "./goldRequirements.ts";
import { previewDesign, relationOf, type PreviewResult } from "./preview.ts";
import { questionsFrom, type Question } from "./previewReport.ts";
import { measurePreviews } from "./previewMetrics.ts";
import type { TurnRelation } from "../agent/turnContract.ts";

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
 *
 * ## 집계 하나 옆에 사례 하나씩
 *
 * 집계 핀은 그대로 남는다. `{ hit: 61, of: 61 }` 은 분모를 주장하는 문장이고,
 * 말뭉치가 사례를 잃으면 그 문장이 먼저 실패해야 하기 때문이다. 그 위에 축마다
 * 사례별 테스트를 얹는다 — 대체가 아니라 덧붙임이다. 집계는 "몇 개가 어긋났다"
 * 까지만 말하고, 사례별 테스트는 "이 사례의 이 축이 이렇게 어긋났다" 를 이름과
 * 실패 메시지로 말한다.
 *
 * 사례별 테스트는 `before()` 가 한 번 계산해 둔 결과만 읽는다. 테스트마다
 * `previewDesign` 을 다시 부르면 43번이 400번이 되고, 무엇보다 각 테스트가 서로
 * 다른 관찰을 보게 되어 집계와 사례별 결과가 같은 관찰이라는 보장이 사라진다.
 */

let score: GoldScore;
const previews = new Map<string, PreviewResult>();

/**
 * 한 턴에서 나온 것을, 그 턴의 정답 옆에 나란히 세워 둔 것.
 *
 * `scoreGold` 가 내부에서 부르는 것과 같은 순수 함수(`readExtraction`,
 * `pairRequirements`, `relationOf`)를 같은 입력에 한 번 더 부른다. 결정적이라는
 * 것은 아래 "측정은 결정적이다" 가 따로 주장하므로, 집계와 사례별 테스트는 같은
 * 관찰을 두 가지 입도로 말한다.
 */
interface TurnBreakdown {
  turnId: string;
  gold: GoldTurn;
  /** 이 턴에서 런타임이 실제로 뽑아낸 것 전부. 정답과 짝지어지기 전. */
  extracted: ExtractedRequirement[];
  /** 정답 한 줄에 하나씩. `got === null` 이 recall 의 반례다. */
  pairs: Pairing[];
  /** 어떤 정답도 요구하지 않은 추출. precision 의 반례다. */
  unmatched: ExtractedRequirement[];
  /** 런타임이 읽은 관계. 정답은 `gold.relation`. */
  relation: TurnRelation;
}

interface CaseBreakdown {
  gold: GoldCase;
  preview: PreviewResult;
  turns: TurnBreakdown[];
  asked: Question[];
  /** 요구사항 수준의 시작 가능. `preview.executable` 과는 다른 주장이다. */
  startable: boolean;
}

const breakdown = new Map<string, CaseBreakdown>();

/**
 * 미리 계산된 사례 결과를 꺼낸다.
 *
 * 없으면 그 사실 자체가 실패다. 사례가 말뭉치에서 사라지면 위의 집계가 분모로
 * 먼저 잡아내지만, 여기서도 조용히 건너뛰지는 않는다.
 */
function caseOf(id: string): CaseBreakdown {
  const found = breakdown.get(id);
  assert.ok(found !== undefined, `${id}: before() 가 이 사례의 결과를 담지 않았습니다`);
  return found;
}

/** 턴이 하나뿐이면 사례 id 로 충분하고, 여럿이면 어느 턴인지까지 이름에 넣는다. */
function label(gold: GoldCase, index: number): string {
  return gold.turns.length === 1 ? gold.id : `${gold.id} t${index + 1}`;
}

/**
 * 말뭉치를 만들다 터진 것. `before()` 는 이것을 담아 두고 던지지 않는다.
 *
 * `node --test` 는 `before()` 훅이 throw 하면 그 아래 테스트를 실행하지 않고
 * **cancelled** 로 처리하는데, 요약줄은 그것을 `fail 0` 으로 적는다. 확인한
 * 사실이다 — 훅 하나가 터지면 이 파일의 사례별 테스트 수백 개가 통째로 사라지고,
 * 마지막 줄만 읽는 사람에게는 초록으로 보인다. `fail 0` 이 거짓말을 하는 자리가
 * 정확히 여기다.
 *
 * 위에서 축마다 사례별로 갈라 놓은 입도가 전부 이 훅 하나에 매달려 있으므로,
 * 훅은 실패를 삼키고 아래 "말뭉치가 만들어졌다" 가 그것을 이름 있는 실패로
 * 바꾼다. 말뭉치가 깨지면 나머지 테스트들은 빈 맵을 읽고 `caseOf` 에서 각자 자기
 * 이름으로 실패한다 — 취소되어 조용히 사라지는 것보다, N 개가 각자 무엇을 보지
 * 못했는지 말하며 빨갛게 되는 편이 낫다. 취소 0, 실패 N 이 이 파일이 원하는
 * 실패 모양이다.
 */
let buildError: Error | null = null;

before(async () => {
  try {
    for (const gold of GOLD_CASES) {
      const preview = await previewDesign({ turns: gold.turns.map((t) => t.text) });
      previews.set(gold.id, preview);
      breakdown.set(gold.id, {
        gold,
        preview,
        turns: gold.turns.map((turn, index) => {
          const turnId = `t${index + 1}`;
          const extracted = readExtraction({ turnId, text: turn.text });
          const { pairs, unmatched } = pairRequirements(turn.requirements, extracted);
          return {
            turnId,
            gold: turn,
            extracted,
            pairs,
            unmatched,
            relation: relationOf(turn.text, index === 0),
          };
        }),
        asked: questionsFrom(preview),
        startable: startableOf(preview),
      });
    }
    score = scoreGold(GOLD_CASES, previews);
  } catch (err) {
    buildError = err instanceof Error ? err : new Error(String(err));
  }
});

/**
 * 아래 모든 주장의 분모가 만들어졌다는 것.
 *
 * 이 파일에서 가장 먼저 선언되는 테스트라 실패 목록의 맨 위에 온다. 사례 수까지
 * 함께 주장하는 이유는, 훅이 절반쯤 만들다 멈춰도 `caseOf` 가 실패하기 전에
 * 여기서 "43 개 중 몇 개만 만들어졌다" 가 먼저 읽히게 하기 위해서다.
 */
describe("말뭉치 빌드", () => {
  test("말뭉치가 만들어졌다", () => {
    assert.equal(
      buildError,
      null,
      `말뭉치를 만들지 못했습니다: ${buildError && buildError.stack}`,
    );
    assert.ok(breakdown.size > 0, "사례가 하나도 만들어지지 않았습니다");
    assert.equal(
      breakdown.size,
      GOLD_CASES.length,
      `${GOLD_CASES.length} 개 중 ${breakdown.size} 개만 만들어졌습니다`,
    );
    assert.equal(
      previews.size,
      GOLD_CASES.length,
      `${GOLD_CASES.length} 개 중 ${previews.size} 개만 미리보기가 있습니다`,
    );
    assert.ok(score, "점수가 계산되지 않았습니다");
  });
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
  test("recall 61/61", () => {
    assert.deepEqual(score.requirementRecall, { hit: 61, of: 61, value: 1 });
    assert.deepEqual(score.missed, [], "놓친 요구사항이 있습니다");
  });

  test("precision 59/59 — 발명이 0이다", () => {
    // The one that must never slip. A missing requirement is visible to the user
    // as work not done; an invented one is work they never asked for.
    assert.deepEqual(score.requirementPrecision, { hit: 61, of: 61, value: 1 });
    assert.deepEqual(score.spurious, [], "요청에 없는 요구사항을 만들었습니다");
  });

  test("target 정확도 61/61, span 근거 61/61", () => {
    assert.deepEqual(score.targetAccuracy, { hit: 61, of: 61, value: 1 });
    assert.deepEqual(score.spanGrounding, { hit: 61, of: 61, value: 1 });
  });

  test("relation 47/48", () => {
    // Was 48/48, and the one it now misses is recorded rather than fixed by
    // editing the answer.
    //
    // `past-failure-retry` turn 2 — "실행했는데 실패했어. 다시 실행해줘." after
    // "테스트를 실행해줘." — is annotated `new_task`. `relationOf` now reads an
    // unmarked follow-up as `refine`, because the fallback it replaced was
    // `new_task` and `new_task` discards everything standing. Measured against
    // the scenario corpus the old fallback was wrong four times in thirty-one
    // and every error ran the destructive way: "좋은 오픈소스 모델하고 HASA
    // 모델도 추가해줘" reset the conversation it was adding to, in the scenario
    // whose title is "Refine adds without losing".
    //
    // Whether this turn is a new task is genuinely arguable — nothing in it
    // starts a new subject, and a reader could as easily have called it
    // `continue`. What is not arguable is that the answer stays as the person
    // who wrote it wrote it; a gold edited to agree with the code measures the
    // code's memory of itself.
    //
    // Nothing is lost by the disagreement here: both turns ask for the same
    // work, so the conversation stands at ["테스트를 실행한다", "요청한 명령을
    // 실행한다"] either way.
    assert.deepEqual(score.relationAccuracy, { hit: 47, of: 48, value: 0.979 });
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

/**
 * 위의 `recall 61/61` 을 정답 한 줄 단위로 쪼갠 것.
 *
 * 집계는 몇 줄을 놓쳤는지까지만 말한다. 여기서는 어느 사례의 어느 턴에서, 어떤
 * 행위·극성의 요구사항이, 어떤 근거 구절을 둔 채로 사라졌는지가 실패 메시지에
 * 그대로 남는다. 60/61 이 되는 순간 이름 하나가 빨갛게 된다.
 */
describe("사례별 · 요구사항 recall", () => {
  for (const gold of GOLD_CASES) {
    gold.turns.forEach((turn, index) => {
      // 정답 요구사항이 0줄인 턴에는 테스트를 만들지 않는다. 놓칠 것이 없으면
      // `missed` 는 무슨 일이 있어도 빈 배열이라, 그런 테스트는 초록 하나를 늘릴 뿐
      // 아무것도 주장하지 않는다. 그 턴들은 아래 "요구사항이 없는 턴" 이 맡는다.
      if (turn.requirements.length === 0) return;
      test(`${label(gold, index)} · 요구사항 recall`, () => {
        const missed = caseOf(gold.id)
          .turns[index].pairs.filter((pair) => pair.got === null)
          .map((pair) => `${pair.gold.action}/${pair.gold.polarity} "${pair.gold.quote}"`);
        assert.deepEqual(missed, [], `"${turn.text}" 의 정답 요구사항을 찾지 못했습니다`);
      });
    });
  }
});

/**
 * `precision 61/61` 을 사례별로. 발명은 여기서 이름을 갖는다.
 *
 * 놓친 요구사항은 하지 않은 일로 보이지만, 만들어낸 요구사항은 아무도 시키지 않은
 * 일이다. 그래서 실패 메시지는 만들어진 요구사항의 행위·극성·대상과, 그것이 잘라
 * 온 원문 구간까지 함께 적는다. 어느 문장의 어느 조각이 요구사항으로 오해됐는지가
 * 곧 고칠 자리다.
 */
describe("사례별 · 요구사항 precision", () => {
  for (const gold of GOLD_CASES) {
    gold.turns.forEach((turn, index) => {
      test(`${label(gold, index)} · 요구사항 precision`, () => {
        const invented = caseOf(gold.id).turns[index].unmatched.map(
          (got) =>
            `${got.action}/${got.polarity} 대상=${JSON.stringify(got.target)} ← "${got.sourceText}"`,
        );
        assert.deepEqual(invented, [], `"${turn.text}" 에 없는 요구사항을 만들었습니다`);
      });
    });
  }
});

/**
 * `target 정확도 61/61` 을 사례별로.
 *
 * 짝지어진 요구사항만 센다 — 대상이 틀린 것과 요구사항 자체를 놓친 것은 서로 다른
 * 실패이고 고치는 자리도 다르기 때문이다(`pairRequirements` 의 주석 참고). 실패는
 * 정답 대상과 추출 대상을 나란히 적으므로, `있는 모델` 처럼 조각을 집었는지
 * `main` 처럼 이름을 반으로 쪼갰는지가 바로 보인다.
 */
describe("사례별 · 대상 정확도", () => {
  for (const gold of GOLD_CASES) {
    gold.turns.forEach((turn, index) => {
      // 정답이 0줄이면 짝지어진 요구사항도 0개다. 빈 배열끼리 비교하는 테스트를
      // 만드는 대신, 그 턴은 아래 "요구사항이 없는 턴" 하나로 주장한다.
      if (turn.requirements.length === 0) return;
      test(`${label(gold, index)} · 대상`, () => {
        const wrong = caseOf(gold.id)
          .turns[index].pairs.filter((pair) => pair.got !== null && !pair.targetMatch)
          .map(
            (pair) =>
              `${pair.gold.action}: 정답 ${JSON.stringify(pair.gold.target)} ≠ 추출 ${JSON.stringify(
                pair.got?.target ?? null,
              )}`,
          );
        assert.deepEqual(wrong, [], `"${turn.text}" 의 대상이 정답과 다릅니다`);
      });
    });
  }
});

/**
 * `span 근거 61/61` 을 사례별로.
 *
 * 근거란 런타임이 잘라 온 구간이 정답의 인용을 덮는다는 뜻이다. 최소 구간인지는
 * 여전히 `UNMEASURED` 에 남아 있으므로(이 파일이 주장하지 않는 것 목록 참고),
 * 여기서 실패한다는 것은 근거가 좁아서가 아니라 엉뚱한 곳을 가리켰다는 뜻이다.
 */
describe("사례별 · span 근거", () => {
  for (const gold of GOLD_CASES) {
    gold.turns.forEach((turn, index) => {
      // 위와 같은 이유로 정답이 0줄인 턴은 건너뛴다. 근거를 요구할 인용이 없는
      // 자리에서 "근거가 다 있다" 고 말해 봐야 초록만 하나 늘어난다.
      if (turn.requirements.length === 0) return;
      test(`${label(gold, index)} · span 근거`, () => {
        const ungrounded = caseOf(gold.id)
          .turns[index].pairs.filter((pair) => pair.got !== null && !pair.grounded)
          .map((pair) => `"${pair.gold.quote}" 이 추출 구간 "${pair.got?.sourceText ?? ""}" 밖입니다`);
        assert.deepEqual(ungrounded, [], `"${turn.text}" 의 근거 구절이 추출 구간 밖입니다`);
      });
    });
  }
});

/**
 * 정답 요구사항이 0줄인 턴. 그 턴에 대해 이 파일이 하는 유일한 주장이다.
 *
 * 위의 recall·대상·span 은 정답 한 줄마다 하나씩 세는 축이라, 정답이 0줄인 턴에서는
 * 셋 다 빈 배열과 빈 배열을 비교한다. 무엇이 망가져도 초록인 테스트 아홉 개는
 * 주장을 늘리지 않고 "몇 개가 통과했다" 만 부풀린다. 그래서 그 턴들에서는 세 축을
 * 만들지 않고 여기 하나만 둔다.
 *
 * 여기서 주장하는 것은 말뭉치가 아니라 런타임이다. 테스트가 생기는 조건이 "정답이
 * 비어 있다" 이므로 정답이 비었다는 것을 다시 확인하면 그것이야말로 항진명제다.
 * 대신 "이 문장에서는 아무 요구사항도 읽히지 않는다" 를 주장한다 — `적당히 잘 좀
 * 해줘.`, `고마워, 잘 됐어.`, `아까 하던 작업 계속해줘.` 에서 무엇이든 읽어내는
 * 것이 이 말뭉치가 가장 무서워하는 실패다.
 *
 * `pairs` 가 비어 있다는 것도 함께 못 박는다. 이 턴이 recall·대상·span 의 분모 61
 * 에 한 줄도 보태지 않는다는 뜻이고, 위에서 세 축을 만들지 않은 근거가 그것이다.
 */
describe("사례별 · 요구사항이 없는 턴", () => {
  for (const gold of GOLD_CASES) {
    gold.turns.forEach((turn, index) => {
      if (turn.requirements.length > 0) return;
      test(`${label(gold, index)} · 요구사항 없음`, () => {
        const { extracted, pairs } = caseOf(gold.id).turns[index];
        assert.deepEqual(pairs, [], `${gold.id}: 정답이 0줄인데 짝지을 것이 생겼습니다`);
        assert.deepEqual(
          extracted.map((got) => `${got.action}/${got.polarity} ← "${got.sourceText}"`),
          [],
          `"${turn.text}" 에는 요구사항이 없는데 읽어냈습니다`,
        );
      });
    });
  }
});

/**
 * 지금 동작 그대로 못 박아 둔 relation. 정답과 다른 줄만 여기 있다.
 *
 * 정답을 고쳐서 초록을 만들지 않는다. 집계 `relation 47/48` 이 이 한 건을 계속
 * 세고 있고, 여기서는 그 한 건이 이름을 갖는다. 이 표에서 한 줄을 지우려면 동작이
 * 정답 쪽으로 움직여야 하고 — 그때는 집계 47/48 이 먼저 실패한다 — 새 줄이
 * 필요해지면 그건 회귀다.
 *
 * 알려진 어긋남: `past-failure-retry` t2 "실행했는데 실패했어. 다시 실행해줘."
 * 정답은 `new_task`, 지금 동작은 `refine`. 어느 쪽이 옳은지에 대한 논거 전체는
 * 위 "relation 47/48" 의 주석에 있다.
 *
 * `KnownGap.axis` 에 `relation` 이 없어서 이 표는 `KNOWN_MISSES` 밖에 산다. 밖에
 * 산다고 규율까지 밖에 두면, 판정도 이유도 없는 줄이 조용히 늘어나는 두 번째
 * as-built 표가 된다. 그래서 항목마다 `KNOWN_MISSES` 와 같은 것을 요구한다 —
 * 결정인지 결함인지(`verdict`)와, 40자보다 긴 이유. 아래 "relation as-built 표도
 * KNOWN_MISSES 와 같은 규율을 받는다" 가 그것을 강제한다.
 *
 * 키는 테스트 이름을 만드는 `label()` 이 내는 문자열 그대로다. 키를 항상
 * `<id> t<n>` 으로 적던 시절에는, 단일 턴 사례에서 실패한 테스트 이름을 그대로
 * 옮겨 적으면 `label()` 이 ` t1` 을 떼는 탓에 조회가 빗나갔다 — 못은 박히지 않고
 * 테스트는 초록이 되는 함정이다. 이름과 키가 같은 함수에서 나오면 그 함정이 없고,
 * 아래 규율 테스트가 실재하지 않는 턴을 가리키는 키를 잡는다.
 */
interface RelationAsBuilt {
  /** 지금 런타임이 읽는 관계. 정답은 그 턴의 `relation` 이다. */
  relation: TurnRelation;
  /** 결정인지 결함인지. `KnownGap.verdict` 와 같은 두 값. */
  verdict: "defect" | "by_design";
  /** 왜 이 어긋남을 못 박아 두는지. 한 줄로 끝나지 않는 것이 규율이다. */
  reason: string;
}

const RELATION_AS_BUILT = new Map<string, RelationAsBuilt>([
  [
    "past-failure-retry t2",
    {
      relation: "refine",
      verdict: "by_design",
      reason:
        "표시 없는 후속 턴의 fallback 을 `new_task` 에서 `refine` 으로 바꾼 결과다. " +
        "`new_task` 는 서 있던 것을 전부 버리므로 시나리오 말뭉치 31건 중 4건에서 " +
        "덧붙이는 요청이 대화를 초기화했다. 이 턴이 새 작업인지는 실제로 논쟁적이고 " +
        "— 새로운 주제를 시작하는 문장이 하나도 없다 — 두 턴이 같은 일을 요청하므로 " +
        "결과 대화는 어느 쪽으로 읽어도 같다. 정답을 코드에 맞춰 고치지 않고 남긴다.",
    },
  ],
]);

/**
 * `relation 47/48` 을 턴 단위로. 관계는 턴의 축이라 사례가 아니라 턴마다 하나다.
 *
 * 이름에 사례 id 와 턴 번호가 함께 들어가므로, 실패는 "48 분의 몇" 이 아니라
 * "이 대화의 이 턴을 이렇게 읽었다" 가 된다.
 */
describe("사례별 · relation", () => {
  for (const gold of GOLD_CASES) {
    gold.turns.forEach((turn, index) => {
      // 조회 키와 테스트 이름을 같은 함수가 만든다. 왜 그래야 하는지는 위
      // `RELATION_AS_BUILT` 주석의 마지막 문단에 있다.
      const pinned = RELATION_AS_BUILT.get(label(gold, index));
      const name = `${label(gold, index)} · relation${pinned === undefined ? "" : " — 알려진 어긋남"}`;
      test(name, () => {
        const seen = caseOf(gold.id).turns[index].relation;
        if (pinned !== undefined) {
          assert.equal(
            seen,
            pinned.relation,
            `"${turn.text}" — 알려진 어긋남(정답 ${turn.relation}, 지금 ${pinned.relation})이 또 움직였습니다`,
          );
          return;
        }
        assert.equal(seen, turn.relation, `"${turn.text}" 의 관계를 잘못 읽었습니다`);
      });
    });
  }
});

/**
 * 대상이 없는 정답만 골라, 그 자리에 무엇이 채워졌는지 사례별로 본다.
 *
 * 위 "대상이 없는 요청은 대상을 만들어내지 않는다" 와 같은 주장을 사례마다 하나씩
 * 나눠 놓은 것이다. 그 반복문은 첫 번째 어긋남에서 멈추므로 두 사례가 동시에
 * 깨지면 하나만 보인다. 여기서는 둘 다 이름을 갖는다. 대상이 `null` 인 정답이 있는
 * 턴에만 테스트가 생긴다 — 없는 턴에서는 주장할 것이 없기 때문이다.
 */
describe("사례별 · 문장에 없는 대상은 만들지 않는다", () => {
  for (const gold of GOLD_CASES) {
    gold.turns.forEach((turn, index) => {
      const open = turn.requirements.filter((req) => req.target === null);
      if (open.length === 0) return;
      test(`${label(gold, index)} · 없는 대상`, () => {
        const extracted = caseOf(gold.id).turns[index].extracted;
        const filled = open
          .map((want) => ({
            want,
            same: extracted.filter(
              (got) => got.action === want.action && got.polarity === want.polarity,
            ),
          }))
          .filter(({ same }) => !same.some((got) => got.target === null))
          .map(({ want, same }) => `"${want.quote}" → ${JSON.stringify(same.map((g) => g.target))}`);
        assert.deepEqual(filled, [], `"${turn.text}" 에 없는 대상을 채웠습니다`);
      });
    });
  }
});

describe("질문 정확성 — 분모를 함께", () => {
  test("recall 13/13, precision 14/14", () => {
    // Precision was 11/33. The 22 false positives were all `NO_DESIGN_RULE` —
    // the plan asking a user to design its verification rules — and they are gone
    // because the five missing act rules were written, not because the question
    // was suppressed: recall went *up* at the same time, from 11/12 to 12/12.
    assert.deepEqual(score.questionRecall, { hit: 13, of: 13, value: 1 });
    assert.deepEqual(score.questionPrecision, { hit: 14, of: 14, value: 1 });
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
    assert.equal(askedTotal, 14);
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

/**
 * `questionRecall 13/13` 을 사례별로.
 *
 * 정답이 질문을 기대하는 사례에만 테스트가 생긴다. 아무것도 묻지 않아야 하는
 * 사례는 recall 이 아니라 precision 이 지키는 쪽이라, 여기에 빈 테스트를 두면
 * 초록 하나가 늘 뿐 주장은 늘지 않는다.
 *
 * 실패 메시지에는 그 사례가 실제로 물은 코드 목록이 함께 나온다. 묻지 않은 것과
 * 다른 것을 물은 것은 한 화면에서 같이 읽혀야 원인이 보이기 때문이다.
 */
describe("사례별 · 질문 recall", () => {
  for (const gold of GOLD_CASES) {
    if (gold.questions.expected.length === 0) continue;
    test(`${gold.id} · 질문 recall`, () => {
      const asked = caseOf(gold.id).asked;
      const missing = gold.questions.expected.filter(
        (code) => !asked.some((question) => question.code === code),
      );
      assert.deepEqual(
        missing,
        [],
        `${gold.id}: 물어야 하는 것을 묻지 않았습니다 (물은 것: ${JSON.stringify(
          asked.map((question) => question.code),
        )})`,
      );
    });
  }
});

/**
 * `questionPrecision 14/14` 과 "초과 질문이 하나도 없다" 를 사례별로.
 *
 * `expected` 는 완전한 정답이므로 그 밖의 질문은 전부 오탐이다. 43 사례 모두에
 * 테스트가 생기고, 아무것도 기대하지 않는 30 사례에서는 "한 마디도 묻지 않는다"
 * 라는 주장이 된다 — 빈 기대는 빈 주장이 아니다.
 *
 * `NEVER_ASKED` 코드도 여기에 걸린다. 사용자가 직접 쓴 동사를 되묻는 질문은 어떤
 * 사례의 정답에도 없기 때문이다.
 */
describe("사례별 · 질문 precision", () => {
  for (const gold of GOLD_CASES) {
    test(`${gold.id} · 질문 precision`, () => {
      const expected = new Set(gold.questions.expected);
      const unexpected = caseOf(gold.id)
        .asked.filter((question) => !expected.has(question.code))
        .map((question) => `${question.code} (${question.subject})`);
      assert.deepEqual(unexpected, [], `${gold.id}: 정답에 없는 질문을 했습니다`);
    });
  }
});

/**
 * `questionCeiling 43/43` 을 사례별로. 상한은 사례마다 다른 수다.
 *
 * 이름에 그 사례의 상한을 적어 두었으므로, 실패 목록만 읽어도 "두 개까지 허용된
 * 자리에서 세 개를 물었다" 가 보인다. 집계는 몇 사례가 넘었는지만 말한다.
 */
describe("사례별 · 질문 상한", () => {
  for (const gold of GOLD_CASES) {
    test(`${gold.id} · 질문 상한 ${gold.questions.max}`, () => {
      const asked = caseOf(gold.id).asked;
      assert.ok(
        asked.length <= gold.questions.max,
        `${gold.id}: ${asked.length} 개를 물었습니다 (상한 ${gold.questions.max}) — ${JSON.stringify(
          asked.map((question) => question.code),
        )}`,
      );
    });
  }
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

/**
 * `requirementStartability 43/43` 을 사례별로. 문장을 읽었는가에 대한 주장이다.
 *
 * 이름에 정답을 적어 두므로 `thanks-no-requirement · startable=false` 처럼 그
 * 사례가 무엇을 주장하는지가 목록에서 바로 읽힌다. 여기서는 `KNOWN_MISSES` 를
 * 면제로 쓰지 않는다 — 이 축의 면제가 하나라도 생기면 위의 `43/43` 이 먼저
 * 실패하므로, 사례별 테스트까지 봐주면 같은 사실을 두 번 숨기게 된다.
 */
describe("사례별 · Startable", () => {
  for (const gold of GOLD_CASES) {
    test(`${gold.id} · startable=${gold.startable}`, () => {
      assert.equal(
        caseOf(gold.id).startable,
        gold.startable,
        `${gold.id}: 요구사항 수준의 시작 가능 판정이 정답과 다릅니다 (${gold.why})`,
      );
    });
  }
});

/**
 * `harnessExecutability 43/43` 을 사례별로. 시작 가능과는 다른 주장이다.
 *
 * Startability 는 문장을 이해했다는 뜻이고, executability 는 그 계획을 하네스가
 * 실제로 돌릴 수 있다는 뜻이다 — 모든 요구사항에 검증 규칙이 있고 감사가 닫지
 * 못한 것이 없어야 한다. 둘을 한 숫자로 묶어 보고하던 시절에는 "요청을 이해했다"
 * 가 "안전하게 실행할 수 있다" 로 읽혔다. 사례별로도 두 축은 따로 실패한다.
 */
describe("사례별 · Executable", () => {
  for (const gold of GOLD_CASES) {
    test(`${gold.id} · executable=${gold.executable}`, () => {
      assert.equal(
        caseOf(gold.id).preview.executable,
        gold.executable,
        `${gold.id}: 하네스 실행 가능 판정이 정답과 다릅니다 (${gold.why})`,
      );
    });
  }
});

/**
 * 시작 불가 사례가 그래서 무엇을 못 하는지, 사례마다 하나씩.
 *
 * 위 "대상이 열린 요구사항이 있으면 시작 가능이 아니다" 와 같은 주장이다. 그
 * 반복문은 첫 사례에서 멈추므로 세 사례가 함께 깨져도 하나만 보인다. 시작할 수
 * 없다는 판정이 도구 실행 금지까지 이어지는지가 이 파일에서 가장 안전에 가까운
 * 주장이라, 사례마다 이름을 갖게 한다.
 *
 * `startable` 이 false 인 사례에만 테스트가 생긴다. 시작 가능한 사례에 대해서는
 * 여기서 주장할 것이 없다.
 */
describe("사례별 · 시작 불가면 도구도 계획도 남지 않는다", () => {
  for (const gold of GOLD_CASES) {
    if (gold.startable) continue;
    const known = KNOWN_MISSES.some((m) => m.caseId === gold.id && m.axis === "startability");
    if (known) continue;
    test(`${gold.id} · 실행 차단`, () => {
      const { preview, startable } = caseOf(gold.id);
      assert.equal(startable, false, `${gold.id}: 시작 가능으로 표시됐습니다`);
      assert.equal(preview.executable, false, `${gold.id}: 실행 가능으로 표시됐습니다`);
      assert.equal(preview.mayExecute, false, `${gold.id}: 도구 실행이 허용됐습니다`);
      assert.deepEqual(preview.plannedTools, [], `${gold.id}: 실행 계획이 남아 있습니다`);
    });
  }
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

  test("relation as-built 표도 KNOWN_MISSES 와 같은 규율을 받는다", () => {
    // `KnownGap.axis` 에 relation 이 없어서 relation 의 어긋남은 위 표에 들어가지
    // 못하고 `RELATION_AS_BUILT` 라는 두 번째 as-built 표에 산다. 규율까지 밖에
    // 두면 판정도 이유도 없는 줄이 조용히 늘어나므로, 같은 것을 여기서 요구한다.
    const names = new Set(
      GOLD_CASES.flatMap((gold) => gold.turns.map((_, index) => label(gold, index))),
    );
    for (const [key, pin] of RELATION_AS_BUILT) {
      assert.ok(pin.reason.length > 40, `${key}: 이유가 너무 짧습니다`);
      assert.ok(["defect", "by_design"].includes(pin.verdict), `${key}: 판정이 없습니다`);
      // 키는 곧 테스트 이름이다. 빗나간 키는 아무 못도 박지 않은 채 초록이 된다.
      assert.ok(
        names.has(key),
        `${key}: 존재하지 않는 턴을 가리킵니다 — 키는 테스트 이름과 같아야 합니다`,
      );
    }
  });

  test("relation as-built 표에는 정답과 어긋나는 줄만 있다", () => {
    // 위 표 주석의 "정답과 다른 줄만 여기 있다" 를 주장으로 바꾼 것. 정답과 같은
    // 관계를 못 박아 두면 그 턴은 정답 대신 못을 검사하게 되어, 관계를 잘못 읽는
    // 회귀가 그 자리에서만 통과한다.
    const agreeing: string[] = [];
    for (const gold of GOLD_CASES) {
      gold.turns.forEach((turn, index) => {
        const pin = RELATION_AS_BUILT.get(label(gold, index));
        if (pin !== undefined && pin.relation === turn.relation) agreeing.push(label(gold, index));
      });
    }
    assert.deepEqual(agreeing, [], "정답과 같은 관계를 어긋남으로 적어 두었습니다");
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
