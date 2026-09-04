import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { ENGLISH_MEDIA_CASES, type EnglishMediaCase } from "./mediaCasesEnglish.ts";
import type { MediaRequirement } from "./mediaCases.ts";
import { functionalCandidates, type FunctionalCandidate } from "./functionalExtract.ts";

/**
 * The English pass, scored — the first time it has had a denominator.
 *
 * The same four axes the Korean corpus uses, so the two can be compared
 * directly — 읽힘, 행위, 대상, 지어내기. (This line counted three for as long as
 * 지어내기 sat at the bottom of the file with no total of its own: the axis was
 * there, the count of them was not.) They should not diverge much: a person
 * asking for the same project in the other language is asking for the same
 * thing, and a design that reads one well and the other badly is a design with a
 * language it does not admit to preferring.
 *
 * ## 집계 위에 사례를 얹는다
 *
 * 아래의 집계 핀(`read`, `actHit`, `targetHit`, `spurious`, 그리고 분모 30)은
 * 그대로 남아 있다. 말뭉치가 문장을 잃거나 정답이 줄어들면 그 핀이 먼저 깨져야
 * 하기 때문이다. 사례별 테스트는 그 위에 더해진 것이고, 하는 일은 하나다 —
 * 실패가 "30 중 29" 가 아니라 "이 문장의 이 축" 을 말하게 하는 것. 문장은 한
 * 번만 읽는다: `before()` 가 사례마다 후보와 그 짝을 계산해 두고, 테스트는
 * 그것을 꺼내 보기만 한다.
 *
 * ## 말뭉치를 만들다 터지는 것도 이름을 가진 실패여야 한다
 *
 * `node --test` 는 `before()` 가 throw 하면 그 아래 테스트를 **cancelled** 로
 * 처리하고, 요약줄에는 `fail 0` 을 찍는다. 이 파일이 통째로 실행되지 않아도
 * 요약줄은 초록이라고 말한다는 뜻이다 — 그 `fail 0` 은 거짓말이다. 사례마다
 * 이름을 붙여 둔 입도 전부가 훅 하나에 매달려 있으므로, 아래 `before()` 는
 * throw 하지 않는다. 터진 것은 `buildError` 에 담아 두기만 하고, 이 describe 의
 * 첫 테스트인 「말뭉치가 만들어졌다」 가 그것을 주장한다. 그러면 말뭉치가 깨질
 * 때 취소 0, 실패 N 이 된다 — 나머지 테스트는 빈 맵을 읽고 각자 자기 이름으로
 * 실패하는데, 조용히 취소되어 사라지는 것보다 그편이 낫다.
 */

interface Score {
  turns: number;
  read: number;
  goldTotal: number;
  actHit: number;
  targetHit: number;
  /** 정답 수를 넘겨 나온 후보의 총합 — 지어내기 축의 집계 핀. */
  spurious: number;
  unread: string[];
  wrongTarget: string[];
}

/** 한 문장에서 읽어낸 것과, 그것을 정답에 붙인 결과. `before()` 에서 한 번 계산된다. */
interface CaseResult {
  got: readonly FunctionalCandidate[];
  pairs: ReadonlyArray<{ gold: MediaRequirement; got: FunctionalCandidate | null }>;
  /** 같은 정답을 행위 대신 대상으로 짝지은 것 — `pairByTarget` 참고. */
  byTarget: ReadonlyArray<FunctionalCandidate | null>;
  /** 정답 수를 넘긴 후보의 개수 — 이 문장이 지어낸 것. 모자란 쪽은 세지 않는다. */
  extra: number;
}

/**
 * 말뭉치를 만들다 터진 것. `before()` 는 담아 두기만 하고 던지지 않는다 — 이유는
 * 파일 머리의 「말뭉치를 만들다 터지는 것도」 가 들고 있다.
 */
let buildError: Error | null = null;
let score: Score;
const byCase = new Map<string, CaseResult>();

function pair(
  gold: readonly MediaRequirement[],
  got: readonly FunctionalCandidate[],
): Array<{ gold: MediaRequirement; got: FunctionalCandidate | null }> {
  const left = [...got];
  return gold.map((want) => {
    const at = left.findIndex((c) => c.action === want.action);
    if (at === -1) return { gold: want, got: null };
    const [taken] = left.splice(at, 1);
    return { gold: want, got: taken ?? null };
  });
}

/** Compared case-insensitively: `API` and `api` are the same target. */
function sameTarget(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return a.toLowerCase() === b.toLowerCase();
}

function targetOf(candidate: FunctionalCandidate): string | null {
  return candidate.object.length === 0 ? null : candidate.object;
}

/**
 * The same answers, paired to candidates by target instead of by act.
 *
 * `pair` picks a candidate *by* its act, so asking what it returns whether its
 * act is the one that was asked for can only ever answer yes. The per-case 행위
 * axis was asserting exactly that — `match !== null` and nothing further — and a
 * tautology is not a check. Pairing by target hands that axis a candidate chosen
 * without reference to the act, so the act it carries is something the extractor
 * can get wrong, and would any time it produces the right thing under the wrong
 * verb. Deliberately the Korean file's `pairByTarget`, matched with this file's
 * case-insensitive `sameTarget` — the two passes should not disagree about how a
 * requirement is paired any more than about what it says.
 *
 * It is a second pairing rather than a replacement because the totals are
 * computed from `pair`. Pair by target there and the tautology only moves: 대상
 * 정확도 becomes the assertion that cannot fail, and `wrongTarget` can never hold
 * a name again. Each axis is asserted through the pairing that did not use it.
 */
function pairByTarget(
  gold: readonly MediaRequirement[],
  got: readonly FunctionalCandidate[],
): Array<FunctionalCandidate | null> {
  const left = [...got];
  return gold.map((want) => {
    const at = left.findIndex((c) => sameTarget(targetOf(c), want.target));
    if (at === -1) return null;
    const [taken] = left.splice(at, 1);
    return taken ?? null;
  });
}

/** `score` 가 undefined 인 것 대신, 훅이 무엇에 걸렸는지로 실패한다. */
function assertBuilt(): void {
  assert.equal(buildError, null, `말뭉치를 만들지 못했습니다: ${buildError && buildError.stack}`);
}

/** 미리 계산된 결과를 꺼낸다. 없으면 통과가 아니라 실패다. */
function resultOf(media: EnglishMediaCase): CaseResult {
  const found = byCase.get(media.id);
  assert.ok(
    found,
    `${media.id}: before() 가 이 사례를 계산하지 않았습니다` +
      (buildError ? ` — 말뭉치를 만들지 못했습니다: ${buildError.stack}` : ""),
  );
  return found;
}

/** 요구사항이 둘 이상인 문장은 몇 번째 것인지까지 이름에 남긴다. */
function labelOf(media: EnglishMediaCase, index: number): string {
  return media.requirements.length === 1 ? media.id : `${media.id}#${index + 1}`;
}

/** 실패했을 때 무엇을 읽었는지 그대로 펼쳐 놓는다 — 그것이 진단이다. */
function spell(got: readonly FunctionalCandidate[]): string {
  return got.map((c) => `${c.action}/${targetOf(c) ?? "(없음)"}`).join(", ") || "(없음)";
}

before(() => {
  try {
    let read = 0;
    let goldTotal = 0;
    let actHit = 0;
    let targetHit = 0;
    let spurious = 0;
    const unread: string[] = [];
    const wrongTarget: string[] = [];

    for (const media of ENGLISH_MEDIA_CASES) {
      const got = functionalCandidates({ turnId: "t1", text: media.text });
      if (got.length > 0) read += 1;
      else unread.push(media.id);

      goldTotal += media.requirements.length;
      // 넘친 것만 센다. 모자란 쪽은 행위 축이 이미 자기 이름으로 잡고 있다 —
      // 정답마다 짝이 있어야 하므로 `actHit` 이 곧 후보 수의 하한이다.
      const extra = got.length > media.requirements.length ? got.length - media.requirements.length : 0;
      spurious += extra;

      const pairs = pair(media.requirements, got);
      byCase.set(media.id, { got, pairs, byTarget: pairByTarget(media.requirements, got), extra });

      for (const { gold, got: match } of pairs) {
        if (match === null) continue;
        actHit += 1;
        const target = targetOf(match);
        if (sameTarget(target, gold.target)) targetHit += 1;
        else wrongTarget.push(`${media.id}: "${gold.target ?? "(없음)"}" 인데 "${target ?? "(없음)"}"`);
      }
    }

    score = {
      turns: ENGLISH_MEDIA_CASES.length,
      read,
      goldTotal,
      actHit,
      targetHit,
      spurious,
      unread,
      wrongTarget,
    };
  } catch (err) {
    buildError = err instanceof Error ? err : new Error(String(err));
  }
});

describe("영어로 물은 생성형 미디어 프로젝트", () => {
  // 이 describe 의 첫 테스트이자 나머지 전부의 전제. 여기가 깨지면 아래 113개도
  // 각자 자기 이름으로 실패한다 — 취소되어 사라지는 것이 아니라.
  test("말뭉치가 만들어졌다", () => {
    assertBuilt();
    assert.ok(byCase.size > 0, "말뭉치가 비어 있습니다");
    assert.equal(byCase.size, ENGLISH_MEDIA_CASES.length, "사례별 결과가 빠졌습니다");
  });

  test("말뭉치 자체", () => {
    assertBuilt();
    assert.equal(score.turns, 25);
    assert.equal(score.goldTotal, 30);
    for (const media of ENGLISH_MEDIA_CASES) {
      assert.ok(media.why.length > 15, `${media.id}: 이유가 없습니다`);
      assert.ok(media.requirements.length > 0, `${media.id}: 정답이 비어 있습니다`);
    }
    // 사례별 테스트는 id 로 결과를 찾는다. id 가 겹치면 두 문장이 한 칸에
    // 들어앉아, 뒤엣것만 검사되고 앞엣것은 조용히 사라진다.
    assert.equal(byCase.size, score.turns, "사례 id 가 겹칩니다");
  });

  /**
   * Was 11/20 when this corpus was written — nine ordinary English sentences
   * produced nothing at all. Five more sentences joined it later, aimed at
   * the defects the Korean pass had just been made to give up; two of those
   * five were read as nothing and three produced a target the sentence does
   * not contain, which is what a 23/23 on the first twenty had been hiding.
   */
  describe("읽힘", () => {
    test("모든 문장에서 최소 한 개는 읽는다", () => {
      assertBuilt();
      assert.deepEqual(score.unread, []);
      assert.equal(score.read, 25);
    });

    for (const media of ENGLISH_MEDIA_CASES) {
      test(`${media.id} · 읽힘`, () => {
        const { got } = resultOf(media);
        assert.ok(got.length > 0, `"${media.text}" 에서 아무것도 읽지 못했습니다`);
      });
    }
  });

  /**
   * 행위 축. 짝짓기는 행위로 하므로, 여기서 짝이 없다는 것은 곧 그 행위를
   * 읽지 못했다는 뜻이다 — 문장을 읽기는 읽었으나 `save` 를 `inspect` 로
   * 읽은 경우가 이 축에서 걸린다.
   */
  describe("행위", () => {
    test("행위 정확도", () => {
      assertBuilt();
      assert.deepEqual(
        { hit: score.actHit, of: score.goldTotal },
        { hit: 30, of: 30 },
        "행위 정확도가 움직였습니다",
      );
    });

    for (const media of ENGLISH_MEDIA_CASES) {
      media.requirements.forEach((gold, index) => {
        test(`${labelOf(media, index)} · 행위 ${gold.action}`, () => {
          const { got, pairs, byTarget } = resultOf(media);
          const entry = pairs[index];
          assert.ok(entry, `${media.id}: 정답 ${index + 1}번이 짝지어지지 않았습니다`);
          // 짝짓기가 행위로 하는 일이므로 여기까지가 말하는 것은 하나다 — 그
          // 행위를 든 후보가 있기는 하다. 어긋났을 때 무엇을 대신 읽었는지까지
          // 실패 메시지가 말하게 한다.
          assert.ok(
            entry.got,
            `"${media.text}" 에서 ${gold.action} 을(를) 읽지 못했습니다. 나온 행위: ` +
              (got.map((c) => c.action).join(", ") || "(없음)"),
          );
          // 이 축의 이름값은 여기 있다. 위의 후보에게 행위를 다시 묻는 것은
          // `pair` 가 행위로 골라 준 이상 언제나 참이라 검사가 아니었다 — 대신
          // 문장이 말하는 대상을 낸 후보를 데려와 그 후보의 행위를 묻는다. 짝을
          // 행위와 무관하게 골랐으므로 이 등식은 틀릴 수 있고, 대상은 맞게 냈는데
          // 행위를 잘못 붙인 경우가 여기서 잡힌다.
          const named = byTarget[index];
          if (named) {
            assert.equal(
              named.action,
              gold.action,
              `"${media.text}" → "${gold.target ?? "(없음)"}" 을(를) 낸 후보의 행위`,
            );
          }
          // named 가 없다는 것은 대상이 어긋났다는 뜻이고, 그것은 「대상」 축이
          // 자기 이름으로 실패하는 결함이다. 한 결함을 두 축에서 두 번
          // 실패시키지 않으려고 여기서는 묻지 않는다.
        });
      });
    }
  });

  /**
   * 대상 축. 어긋남은 두 가지 모양으로 온다: 문장에 있는 것을 놓치는 것과,
   * 문장에 없는 것을 지어내는 것. 뒤엣것이 더 나쁘다.
   */
  describe("대상", () => {
    test("대상 정확도", () => {
      assertBuilt();
      assert.deepEqual(score.wrongTarget, []);
      assert.deepEqual(
        { hit: score.targetHit, of: score.goldTotal },
        { hit: 30, of: 30 },
        "대상 정확도가 움직였습니다",
      );
    });

    for (const media of ENGLISH_MEDIA_CASES) {
      media.requirements.forEach((gold, index) => {
        test(`${labelOf(media, index)} · 대상`, () => {
          const match = resultOf(media).pairs[index]?.got ?? null;
          assert.ok(
            match !== null,
            `행위부터 어긋납니다 — "${media.text}" 에서 ${gold.action} 을(를) 읽지 못했습니다`,
          );
          const target = targetOf(match);
          assert.ok(
            sameTarget(target, gold.target),
            `"${media.text}" — "${gold.target ?? "(없음)"}" 인데 "${target ?? "(없음)"}"`,
          );
        });
      });
    }
  });

  /**
   * 지어내기 — 집계에는 없던 축.
   *
   * 위의 세 축은 정답을 후보에 붙여 보는 것이라, 정답보다 후보가 많아도 아무
   * 것도 말하지 않는다. "Do not run anything, just show me the design." 에서
   * 금지된 `run` 이 요구사항으로 하나 더 나와도 30/30 은 30/30 그대로다.
   * 한국어 쪽 `spurious` 가 세는 것이 이것이고, 영어 쪽에는 그 눈이 없었다.
   * 사례마다 정답 수를 넘긴 후보를 세어 두면, 없던 요구사항이 생기는 순간 그
   * 문장의 이름으로 실패한다.
   *
   * 세는 것은 한 방향뿐이다. 후보 수가 정답 수와 **같은지**를 보면 덜 읽었을
   * 때도 이 축이 「지어내기」 라는 이름으로 실패하는데, 덜 읽은 것은 지어낸
   * 것이 아니고 그 실패는 이미 행위 축이 자기 이름으로 들고 있다. 한 결함에 두
   * 축이 붙으면 축 이름이 진단을 못 한다.
   */
  describe("지어내기", () => {
    // 집계 핀. 나머지 세 축에는 각각 총계가 있는데 이 축에만 없었다 — 사례별
    // 테스트만 있으면 지어내던 문장이 말뭉치에서 빠질 때 그 사례의 테스트도
    // 같이 빠져, 고쳐진 것인지 치워진 것인지 구분되지 않는다. 분모는 「말뭉치
    // 자체」 가 잡고, 이 핀이 0 을 잡는다.
    test("문장에 없는 요구사항을 만들지 않는다", () => {
      assertBuilt();
      assert.equal(score.spurious, 0, "지어낸 요구사항이 있습니다");
    });

    for (const media of ENGLISH_MEDIA_CASES) {
      test(`${media.id} · 지어내기`, () => {
        const { got, extra } = resultOf(media);
        assert.equal(
          extra,
          0,
          `"${media.text}" — 정답은 ${media.requirements.length}개인데 ` +
            `${got.length}개를 읽었습니다: ${spell(got)}`,
        );
      });
    }
  });
});
