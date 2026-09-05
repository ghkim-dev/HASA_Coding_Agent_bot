import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { CONSULTING_CASES, type ConsultingCase } from "./consultingCases.ts";
import type { MediaRequirement } from "./mediaCases.ts";
import { functionalCandidates, type FunctionalCandidate } from "./functionalExtract.ts";

/**
 * 설계기를 IT·디지털 전환 컨설팅 요청으로 채점한다.
 *
 * 세 번째 영역이다. `goldCases`·`holdoutCases` 는 저장소를 고치는 심부름이고
 * `mediaCases` 는 생성형 미디어이며, 둘 다 이 설계기가 오래 다듬어진 문장들이다.
 * 컨설팅 요청은 처음 물어보는 모양이고, 그래서 이 파일이 처음 낸 숫자는 앞의 둘과
 * 나란히 놓을 수 있는 값이 아니다:
 *
 *     읽기 25/25   행위 33/33   대상 30/33   지어냄 0
 *
 * 낮은 것이 결과다. 새 영역을 처음 재면 이렇게 나오고, 이 파일은 그 사실을 숨기지
 * 않기 위해 있다. **지어냄 0** 이 이 첫 측정에서 가장 중요한 숫자다 — 읽지 못한
 * 것은 구멍이고, 문장에 없는 요구사항을 만들어내는 것은 그보다 나쁘다.
 *
 * ## 실패가 어디에 모이는가
 *
 * 25문장의 실패는 흩어져 있지 않고 세 부류로 모인다. 그것이 이 말뭉치가 준 답이다.
 *
 *   · **어휘에 없는 컨설팅 동사.** `이관`, `이전`, `수립`, `설계`, `작성`, `조정`,
 *     `적용`, `산정`, `보고`. 여덟 문장이 이것 하나 때문에 통째로 읽히지 않는다.
 *     빠뜨린 것이지 틀린 것이 아니다 — 어휘는 저장소를 고치는 심부름과 미디어
 *     생성 주위에서 자랐고, 컨설팅 산출물을 만드는 동사는 거기 없었다.
 *   · **`-아서/-어서` 로 활용한 동사형.** "필드를 찾아서 …" 의 `찾아서` 는 `찾아줘`
 *     와 같은 동사인데 어미가 달라 잡히지 않는다.
 *   · **두 어절 창이 긴 명사구를 자른다.** `장애 복구 시간` → `복구 시간`,
 *     `데이터 거버넌스 정책` → (수립을 모르므로 아예 없음), `벤더 세 곳의 제안서`
 *     → `세 곳의 제안서`. 컨설팅 명사구는 세 어절이 예사이고, 잘린 자리에서
 *     사라지는 것은 **무엇에 대한 것인지**를 말하는 앞머리다.
 *
 * 앞의 둘은 목록에 넣으면 닫히고, 셋째는 창의 크기를 정하는 결정이라 다른 종류의
 * 일이다. 숫자를 올리기 전에 세 부류를 각각 이름을 달아 못 박아 둔다.
 *
 * ## 왜 훅이 던지지 않는가
 *
 * `node --test` 는 `before()` 가 throw 하면 그 아래 테스트를 **cancelled** 로
 * 처리하고 요약줄에 `fail 0` 을 찍는다. 사례별로 가른 입도가 전부 그 훅 하나에
 * 매달리므로, 훅은 던지지 않고 기록만 하고 첫 테스트가 그것을 주장한다.
 */

/**
 * 지금 맞히지 못하는 자리, 하나씩 이름과 이유를 달아서.
 *
 * 처음 잰 뒤 어휘를 채우고 관형절 가드를 넣자 읽기와 행위는 전부 맞았다. 남은 것은
 * 셋인데 셋이 같은 결함이다 — **두 어절 창**. 목적어 창은 마지막 두 어절만 남기고,
 * 컨설팅 명사구는 세 어절이 예사다. 잘려 나가는 것은 언제나 앞머리, 곧 그것이
 * 무엇에 대한 것인지 말하는 부분이다.
 *
 * 이 표에 있는 줄이 맞기 시작하면 그 줄의 테스트가 **실패한다.** 좋은 소식이
 * 조용히 지나가지 않게 하려는 것이고, 그때 할 일은 여기서 줄을 지우고 숫자를
 * 올리는 것이다.
 *
 * 창을 넓히는 것은 이 파일이 결정할 일이 아니다. 넓히면 다른 말뭉치에서 남의
 * 생각에서 온 낱말이 대상에 붙기 시작하고, 그 균형은 `functionalExtract` 의 창
 * 주석이 이미 한 번 정한 것이다. 여기서는 그 결정이 이 영역에서 무엇을 잃는지를
 * 숫자와 이름으로 남긴다.
 */
const KNOWN_TARGET_MISS = new Map<string, { got: string; reason: string }>([
  [
    "c-roadmap-range",
    {
      got: "확산까지 단계",
      reason:
        "`PoC부터 전사 확산까지 단계` 는 네 어절이고 창이 마지막 둘만 남긴다. 범위의 " +
        "시작인 `PoC부터` 가 사라져, 남은 것은 어디서부터인지 말하지 않는다.",
    },
  ],
  [
    "c-operate-measure-and-report#1",
    {
      got: "복구 시간",
      reason:
        "`장애 복구 시간` 이 세 어절이라 앞머리가 잘린다. 남은 것은 무엇의 복구 " +
        "시간인지 말하지 않는다 — 컨설팅 명사구는 세 어절이 예사이므로 이 창은 이 " +
        "영역에서 가장 자주 걸리는 결정이다.",
    },
  ],
  [
    "c-operate-vendor",
    {
      got: "세 곳의 제안서",
      reason:
        "`벤더 세 곳의 제안서` 에서 머리 명사 `벤더` 가 잘리고 수량 구만 남는다. " +
        "`NUMERAL` 은 `세 곳` 처럼 조사가 없는 형태를 한 단위로 묶지만 `세 곳의` 는 " +
        "묶지 않아, 창이 세는 두 단위가 수량 구와 머리 명사가 된다.",
    },
  ],
]);

/** 어휘를 채운 뒤로 읽기와 행위는 전부 맞으므로, 이 표는 비어 있다. */
const KNOWN_MISS = new Map<string, string>([]);

interface CaseOutcome {
  got: FunctionalCandidate[];
  /** 정답 한 줄과 그것에 짝지어진 후보. 짝이 없으면 null. */
  pairs: Array<{ want: MediaRequirement; got: FunctionalCandidate | null }>;
  /** 정답 수를 넘긴 후보의 수. 한 방향만 센다. */
  extra: number;
}

interface Score {
  read: number;
  goldTotal: number;
  actHit: number;
  targetHit: number;
  spurious: number;
  unread: string[];
  wrongTarget: string[];
}

let score: Score = {
  read: 0,
  goldTotal: 0,
  actHit: 0,
  targetHit: 0,
  spurious: 0,
  unread: [],
  wrongTarget: [],
};
const outcomes = new Map<string, CaseOutcome>();
let buildError: unknown = null;

/** 후보의 대상. 없는 것과 빈 문자열은 같은 것으로 읽는다. */
function targetOf(candidate: FunctionalCandidate): string | null {
  return candidate.object.length === 0 ? null : candidate.object;
}

/** 행위로 짝을 짓는다. 대상 축은 이 짝이 고른 후보에게 대상을 묻는다. */
function pair(
  gold: readonly MediaRequirement[],
  got: readonly FunctionalCandidate[],
): Array<{ want: MediaRequirement; got: FunctionalCandidate | null }> {
  const left = [...got];
  return gold.map((want) => {
    const at = left.findIndex((c) => c.action === want.action);
    return { want, got: at === -1 ? null : left.splice(at, 1)[0]! };
  });
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

    for (const item of CONSULTING_CASES) {
      const got = functionalCandidates({ turnId: "t1", text: item.text });
      if (got.length > 0) read += 1;
      else unread.push(item.id);
      goldTotal += item.requirements.length;

      const pairs = pair(item.requirements, got);
      for (const entry of pairs) {
        if (entry.got === null) continue;
        actHit += 1;
        if (targetOf(entry.got) === entry.want.target) targetHit += 1;
        else wrongTarget.push(`${item.id}: ${JSON.stringify(entry.want.target)} ≠ ${JSON.stringify(targetOf(entry.got))}`);
      }

      const extra = got.length > item.requirements.length ? got.length - item.requirements.length : 0;
      spurious += extra;
      outcomes.set(item.id, { got, pairs, extra });
    }

    score = { read, goldTotal, actHit, targetHit, spurious, unread, wrongTarget };
  } catch (err) {
    // 기록만 한다. 던지면 아래 테스트가 통째로 취소되고 요약줄은 fail 0 을 찍는다.
    buildError = err;
  }
});

function outcomeOf(id: string): CaseOutcome {
  const found = outcomes.get(id);
  assert.ok(
    found !== undefined,
    `${id} 의 결과가 없습니다${buildError === null ? "" : ` — 말뭉치를 만들지 못했습니다: ${String(buildError)}`}`,
  );
  return found;
}

describe("IT·디지털 전환 컨설팅 요청", () => {
  test("말뭉치가 만들어졌다", () => {
    assert.equal(
      buildError,
      null,
      `말뭉치를 만들지 못했습니다: ${buildError instanceof Error ? buildError.stack : String(buildError)}`,
    );
    assert.equal(outcomes.size, CONSULTING_CASES.length);
  });

  test("말뭉치의 사례 수와 이름", () => {
    assert.equal(CONSULTING_CASES.length, 25);
    assert.equal(score.goldTotal, 33);
    // 이름을 고정한다. 개수만 세면 사례 하나를 자리채움으로 바꿔치기해도 통과한다.
    assert.deepEqual(
      CONSULTING_CASES.map((c) => c.id).sort(),
      [
        "c-diagnose-and-find",
        "c-diagnose-architecture",
        "c-diagnose-question",
        "c-diagnose-tco",
        "c-diagnose-tech-debt",
        "c-govern-adverb",
        "c-govern-no-execute",
        "c-govern-pii",
        "c-govern-policy",
        "c-govern-preserve",
        "c-migrate-condition",
        "c-migrate-instrumental",
        "c-migrate-prohibition",
        "c-migrate-scope",
        "c-migrate-two-acts",
        "c-operate-cost",
        "c-operate-measure-and-report",
        "c-operate-runbook",
        "c-operate-sla",
        "c-operate-vendor",
        "c-roadmap-create",
        "c-roadmap-feature",
        "c-roadmap-priority",
        "c-roadmap-range",
        "c-roadmap-source",
      ],
    );
    for (const item of CONSULTING_CASES) {
      assert.ok(item.why.length > 15, `${item.id}: 이유가 없습니다`);
      assert.ok(item.requirements.length > 0, `${item.id}: 정답이 비어 있습니다`);
    }
  });

  test("읽기 25/25", () => {
    // 읽지 못한 여덟은 전부 어휘에 없는 동사 때문이고, 이름이 여기 있다.
    assert.deepEqual(score.unread, []);
    assert.equal(score.read, 25);
  });

  test("행위 33/33", () => {
    assert.deepEqual({ hit: score.actHit, of: score.goldTotal }, { hit: 33, of: 33 });
  });

  test("대상 30/33", () => {
    assert.deepEqual({ hit: score.targetHit, of: score.goldTotal }, { hit: 30, of: 33 });
  });

  test("알려진 어긋남에는 이유가 있고, 실재하는 줄을 가리킨다", () => {
    const labels = new Set(
      CONSULTING_CASES.flatMap((item) =>
        item.requirements.map((_, index) =>
          item.requirements.length === 1 ? item.id : `${item.id}#${index + 1}`,
        ),
      ),
    );
    for (const [key, reason] of KNOWN_MISS) {
      assert.ok(labels.has(key), `${key}: 존재하지 않는 줄을 가리킵니다`);
      assert.ok(reason.length > 40, `${key}: 이유가 너무 짧습니다`);
    }
    for (const [key, pin] of KNOWN_TARGET_MISS) {
      assert.ok(labels.has(key), `${key}: 존재하지 않는 줄을 가리킵니다`);
      assert.ok(pin.reason.length > 40, `${key}: 이유가 너무 짧습니다`);
    }
  });

  test("문장에 없는 요구사항을 만들지 않는다", () => {
    // 첫 측정에서 가장 중요한 줄. 읽지 못한 것은 구멍이고, 지어낸 것은 그보다 나쁘다.
    assert.equal(score.spurious, 0, `지어낸 요구사항이 있습니다`);
    assert.equal(score.wrongTarget.length, 3, score.wrongTarget.join(" / "));
  });

  describe("사례별 · 읽기", () => {
    for (const item of CONSULTING_CASES) {
      test(`${item.id} · 읽기`, () => {
        const found = outcomeOf(item.id);
        if (score.unread.includes(item.id)) {
          assert.equal(found.got.length, 0, `${item.id}: 읽기 시작했다면 좋은 소식이니 못을 갱신하라`);
          return;
        }
        assert.ok(found.got.length > 0, `${item.id}: 아무것도 읽지 못했습니다`);
      });
    }
  });

  describe("사례별 · 행위", () => {
    for (const item of CONSULTING_CASES) {
      item.requirements.forEach((want, index) => {
        const label = item.requirements.length === 1 ? item.id : `${item.id}#${index + 1}`;
        const missed = KNOWN_MISS.get(label);
        test(`${label} · 행위 ${want.action}${missed === undefined ? "" : " (아직 못 읽음)"}`, () => {
          const entry = outcomeOf(item.id).pairs[index]!;
          if (score.unread.includes(item.id) || missed !== undefined) {
            assert.equal(
              entry.got,
              null,
              `${label}: 읽기 시작했습니다 — 좋은 소식이니 못을 지우고 숫자를 올리십시오`,
            );
            return;
          }
          assert.ok(entry.got !== null, `${label}: ${want.action} 후보가 없습니다`);
        });
      });
    }
  });

  describe("사례별 · 대상", () => {
    for (const item of CONSULTING_CASES) {
      item.requirements.forEach((want, index) => {
        const label = item.requirements.length === 1 ? item.id : `${item.id}#${index + 1}`;
        const cut = KNOWN_TARGET_MISS.get(label);
        test(`${label} · 대상${cut === undefined ? "" : " (아직 잘림)"}`, () => {
          const entry = outcomeOf(item.id).pairs[index]!;
          if (entry.got === null) {
            assert.ok(
              score.unread.includes(item.id) || KNOWN_MISS.has(label),
              `${label}: 짝이 없는데 이유가 기록되지 않았습니다`,
            );
            return;
          }
          if (cut !== undefined) {
            assert.equal(targetOf(entry.got), cut.got, `${label}: 잘리는 방식이 달라졌습니다`);
            assert.notEqual(cut.got, want.target, `${label}: 정답과 같은 것을 어긋남으로 적었습니다`);
            return;
          }
          assert.equal(targetOf(entry.got), want.target, `${label}: 대상이 다릅니다`);
        });
      });
    }
  });

  describe("사례별 · 지어냄", () => {
    for (const item of CONSULTING_CASES) {
      test(`${item.id} · 지어냄`, () => {
        assert.equal(outcomeOf(item.id).extra, 0, `${item.id}: 정답보다 후보가 많습니다`);
      });
    }
  });
});
