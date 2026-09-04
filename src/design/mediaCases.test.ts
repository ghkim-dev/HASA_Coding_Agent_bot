import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { MEDIA_CASES, type MediaCase, type MediaRequirement } from "./mediaCases.ts";
import { functionalCandidates, type FunctionalCandidate } from "./functionalExtract.ts";

/**
 * The designer on generative-media projects, scored.
 *
 * Three axes, each with its denominator written down, because a single "accuracy"
 * over a set this small says nothing about which half is broken:
 *
 *   `read`     — did the sentence produce any requirement at all. The floor. A
 *                sentence read as nothing is a request the design silently drops,
 *                and the user sees a panel that says it understood them.
 *   `act`      — of the requirements found, how many name the act the sentence
 *                names. Reading "저장해줘" as an inspection is worse than reading
 *                nothing, because it is confidently wrong.
 *   `target`   — and how many name the right thing to do it to.
 *
 * `spurious` is counted separately and is the one that must stay at zero for the
 * conditional case: a requirement the sentence does not contain is an invention,
 * and no amount of recall pays for one.
 *
 * ## Two layers, and why both
 *
 * The totals — `행위 정확도 32/33` and its neighbours — are kept exactly as they
 * were. They are the guard on the corpus itself: delete a sentence and every rate
 * stays high while only the denominator moves, so the denominator is what is
 * pinned, and it stays pinned.
 *
 * On top of them, one test per sentence per axis, named with the case id. What a
 * total does and does not name differs by axis, so the argument is made per axis
 * rather than as one sentence about "totals":
 *
 *   · 행위 and 지어냄 are counts and nothing else — `32 of 33`, `spurious === 0`.
 *     They say how many, never which one, and a change that breaks one sentence
 *     while fixing another leaves both unmoved.
 *   · 읽기 and 대상 do name names: `unread` and `wrongTarget` are pinned by
 *     `deepEqual`, and a swap there does fail. What they cannot do is fail *as*
 *     the sentence — one aggregate line carries every offender at once — and
 *     `wrongTarget` stays silent about a requirement that was paired to no
 *     candidate at all, because `before()` skips the unpaired before it ever
 *     looks at a target. Such a requirement is missing from the target count and
 *     absent from the list of names, and only its own test says so.
 *
 * The per-case tests put the sentence and the axis in the failure line itself.
 * They read what `before()` already computed — `functionalCandidates` runs once
 * per sentence for the whole file, and no test extracts a second time.
 */

interface Score {
  turns: number;
  read: number;
  goldTotal: number;
  actHit: number;
  targetHit: number;
  spurious: number;
  unread: string[];
  wrongTarget: string[];
}

/** What one sentence produced, computed once and read by every axis below. */
interface CaseOutcome {
  got: readonly FunctionalCandidate[];
  /** The answer key paired to candidates by `pair`, in answer-key order. */
  pairs: ReadonlyArray<{ gold: MediaRequirement; got: FunctionalCandidate | null }>;
  /** The same answer key paired by target instead — see `pairByTarget`. */
  byTarget: ReadonlyArray<FunctionalCandidate | null>;
  /** Candidates beyond what the sentence contains — inventions, per sentence. */
  extra: number;
}

let score: Score;
const outcomes = new Map<string, CaseOutcome>();

/**
 * What building the corpus failed with, or null. It is recorded, never thrown.
 *
 * `node --test` treats a `before()` hook that throws as a cancellation of
 * everything beneath it: the tests never run, they are counted as `cancelled`,
 * and the summary line still prints `fail 0`. The one number a reader trusts
 * lies. Not hypothetical — one hook throwing takes 148 tests out of a
 * neighbouring file while the summary reports no failure — and the per-case
 * granularity this file is built on hangs off exactly one hook.
 *
 * So the hook records instead of throwing, `말뭉치가 만들어졌다` below asserts on
 * the record, and every other test reads an empty map and fails under its own
 * name. Cancelled 0, failed N, each failure naming the sentence it belongs to,
 * which is the entire reason the axes were split per case in the first place.
 */
let buildError: Error | null = null;

/**
 * Pairs answers to candidates by act first, then by position.
 *
 * Deliberately generous about order and strict about content: a sentence with two
 * requirements may produce them in either order, and nothing about the answer key
 * depends on which comes first. What it will not do is pair an answer with a
 * candidate of a different act just to raise the target score.
 */
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

/**
 * The same answers, paired to candidates by target instead of by act.
 *
 * Why a second pairing exists at all: `pair` selects a candidate *by* its act, so
 * asking what it returns whether its act is the one that was asked for can only
 * ever answer yes. The per-case 행위 axis was asserting exactly that, and a
 * tautology is not a check. Pairing by target hands that axis a candidate chosen
 * without reference to the act, so the act it carries is something the extractor
 * can get wrong — and would, any time it produces the right thing under the wrong
 * verb.
 *
 * It is a second pairing rather than a replacement because `pair` is what the
 * totals are computed from. Pair by target there and the tautology moves rather
 * than disappears: `대상 정확도 32/33` becomes the assertion that cannot fail and
 * `wrongTarget` can never hold a name again. Complementary is the point — each
 * axis is asserted through the pairing that did not use it.
 */
function pairByTarget(
  gold: readonly MediaRequirement[],
  got: readonly FunctionalCandidate[],
): Array<FunctionalCandidate | null> {
  const left = [...got];
  return gold.map((want) => {
    const at = left.findIndex((c) => targetOf(c) === want.target);
    if (at === -1) return null;
    const [taken] = left.splice(at, 1);
    return taken ?? null;
  });
}

function targetOf(candidate: FunctionalCandidate): string | null {
  return candidate.object.length === 0 ? null : candidate.object;
}

/** Fails on the recorded build error instead of on `score` being undefined. */
function assertBuilt(): void {
  assert.equal(buildError, null, `말뭉치를 만들지 못했습니다: ${buildError && buildError.stack}`);
}

/** Reads what `before()` stored for one sentence. Never extracts again. */
function outcomeOf(id: string): CaseOutcome {
  const found = outcomes.get(id);
  assert.ok(
    found,
    `${id}: before() 가 이 사례를 계산하지 않았습니다` +
      (buildError ? ` — 말뭉치를 만들지 못했습니다: ${buildError.stack}` : ""),
  );
  return found;
}

/** `m-download-and-run#2` when one sentence carries more than one requirement. */
function slot(media: MediaCase, index: number): string {
  return media.requirements.length > 1 ? `${media.id}#${index + 1}` : media.id;
}

/**
 * The one sentence known to produce nothing, named once.
 *
 * The argument for leaving it unread is in `읽지 못하는 문장은 하나뿐이고, 그것이
 * 무엇인지 적혀 있다` below and is not repeated. What this set does is let the
 * per-case tests pin that sentence's present behaviour instead of asserting an
 * answer it does not reach — the total above is what refuses to let the set grow
 * a second member.
 */
const UNREAD_BY_DESIGN: ReadonlySet<string> = new Set(["m-user-chooses"]);

/**
 * Says in the test's own name that this one pins a miss rather than passing on
 * merit.
 *
 * `m-user-chooses · 읽기` read exactly like the thirty names beside it, and every
 * one of those is green because the extractor got the sentence right. This one is
 * green because the extractor produces nothing and the test holds that still. The
 * suffix puts the difference where a reader of the TAP output actually looks.
 */
function pinSuffix(media: MediaCase): string {
  return UNREAD_BY_DESIGN.has(media.id) ? " (읽지 않음 고정)" : "";
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

    for (const media of MEDIA_CASES) {
      const got = functionalCandidates({ turnId: "t1", text: media.text });
      if (got.length > 0) read += 1;
      else unread.push(media.id);

      goldTotal += media.requirements.length;
      const extra = got.length > media.requirements.length ? got.length - media.requirements.length : 0;
      spurious += extra;

      const pairs = pair(media.requirements, got);
      outcomes.set(media.id, { got, pairs, byTarget: pairByTarget(media.requirements, got), extra });

      for (const { gold, got: match } of pairs) {
        if (match === null) continue;
        actHit += 1;
        if (targetOf(match) === gold.target) targetHit += 1;
        else wrongTarget.push(`${media.id}: "${gold.target ?? "(없음)"}" 인데 "${targetOf(match) ?? "(없음)"}"`);
      }
    }

    score = {
      turns: MEDIA_CASES.length,
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

describe("생성형 미디어 프로젝트 요청", () => {
  test("말뭉치가 만들어졌다", () => {
    // 훅이 던지지 않는 이유는 `buildError` 의 주석에 적혀 있다. 훅이 무엇에
    // 걸렸는지 말하는 자리가 여기이고, 이것이 붉으면 아래는 전부 그 결과다.
    assertBuilt();
    assert.equal(outcomes.size, MEDIA_CASES.length, "사례별 결과가 빠졌습니다");
    assert.ok(outcomes.size > 0, "말뭉치가 비어 있습니다");
  });

  test("말뭉치 자체", () => {
    assertBuilt();
    // The denominator, guarded. Every rate below is meaningless if this drifts.
    assert.equal(score.turns, 31);
    assert.equal(score.goldTotal, 33);
    for (const media of MEDIA_CASES) {
      assert.ok(media.why.length > 15, `${media.id}: 이유가 없습니다`);
      assert.ok(media.requirements.length > 0, `${media.id}: 정답이 비어 있습니다`);
    }
  });

  test("읽지 못하는 문장은 하나뿐이고, 그것이 무엇인지 적혀 있다", () => {
    assertBuilt();
    // Was 12/24 when this corpus was written: half of a domain's ordinary
    // sentences produced nothing while the panel said it had understood.
    //
    // The one left is "사용자가 이미지와 영상 중에 고를 수 있게 해줘". `고르다`
    // is not one of the acts, and it is not obvious which act it should be —
    // the request is to build a chooser, and reading it as `create` with the
    // target `이미지와 영상` would render "이미지와 영상을 추가한다", a
    // requirement to add both rather than to offer a choice between them.
    // Deciding that on the user's behalf is the thing this file refuses to do,
    // so the sentence stays unread and stays listed.
    assert.deepEqual(score.unread, ["m-user-chooses"]);
    assert.equal(score.read, 30);
  });

  test("행위 정확도 32/33", () => {
    assertBuilt();
    // Was 13/26. The missing act is the unread sentence above.
    //
    // 26 → 33 when seven sentences joined the set, aimed at what the first
    // twenty-four did not contain. Four of the seven were producing a target
    // the sentence does not name when they were written down.
    assert.deepEqual(
      { hit: score.actHit, of: score.goldTotal },
      { hit: 32, of: 33 },
      "행위 정확도가 움직였습니다",
    );
  });

  test("대상 정확도 32/33", () => {
    assertBuilt();
    // Was 7/26, and the harder axis — it decides whether a person recognises
    // their own request in what the panel shows back. Every requirement that is
    // produced now names the right thing; the one short of full is the sentence
    // that produces nothing, so `wrongTarget` is empty and asserted to be.
    assert.deepEqual(score.wrongTarget, []);
    assert.deepEqual(
      { hit: score.targetHit, of: score.goldTotal },
      { hit: 32, of: 33 },
      "대상 정확도가 움직였습니다 — 어긋난 것: " + score.wrongTarget.join(" / "),
    );
  });

  test("문장에 없는 요구사항을 만들지 않는다", () => {
    assertBuilt();
    // "프롬프트를 바꾸면 … 비교해줘" produced "프롬프트를 수정한다" — a condition
    // read as a request, and the actual request lost behind it.
    assert.equal(score.spurious, 0, "지어낸 요구사항이 있습니다");
  });
});

/**
 * 읽기, one sentence at a time.
 *
 * The floor axis, split. `read === 30` says thirty sentences produced something;
 * it says nothing when one sentence goes silent and another is taught to speak in
 * the same change, because the total does not move. These name the sentence.
 */
describe("사례별 · 읽기", () => {
  for (const media of MEDIA_CASES) {
    test(`${media.id} · 읽기${pinSuffix(media)}`, () => {
      const { got } = outcomeOf(media.id);
      if (UNREAD_BY_DESIGN.has(media.id)) {
        // 알려진 어긋남: 정답은 요구사항 하나(`create` / `이미지와 영상`)인데
        // 지금은 아무것도 읽지 않는다. 왜 그대로 두는지는 위
        // 「읽지 못하는 문장은 하나뿐이고…」 의 주석이 그대로 들고 있다. 여기서는
        // 지금 동작을 못 박아 둔다 — 읽기 시작하면 이 테스트가 실패하고, 그때
        // 무엇으로 읽었는지 실패 메시지가 말해 준다.
        assert.equal(
          got.length,
          0,
          `"${media.text}" → 읽히기 시작했습니다: ${got.map((c) => `${c.action}/${targetOf(c) ?? "(없음)"}`).join(" | ")}`,
        );
        return;
      }
      assert.ok(got.length > 0, `"${media.text}" → 아무것도 읽지 못했습니다`);
    });
  }
});

/**
 * 지어냄, one sentence at a time.
 *
 * `spurious === 0` is a sum, and a sum is the shape that hides which sentence
 * invented: the aggregate only ever names the count. Per sentence the failure
 * prints the request and every candidate it produced, which is what tells you
 * whether a condition clause or a prohibition was read as a request.
 */
describe("사례별 · 지어냄", () => {
  for (const media of MEDIA_CASES) {
    test(`${media.id} · 지어냄`, () => {
      const { got, extra } = outcomeOf(media.id);
      assert.equal(
        extra,
        0,
        `"${media.text}" → 정답 ${media.requirements.length}개인데 ${got.length}개를 냈습니다: ` +
          got.map((c) => `${c.action}/${targetOf(c) ?? "(없음)"}`).join(" | "),
      );
    });
  }
});

/**
 * 행위, one requirement at a time.
 *
 * The failure this names: a sentence produced something, possibly even the right
 * number of things, and none of it is the act the sentence names. `#1`/`#2`
 * follow the answer key's order for the two sentences carrying two requirements.
 *
 * Two assertions, drawn from the two pairings, because for a while one of them
 * was neither. `pair` chooses a candidate *by* act, so what it hands back cannot
 * disagree about its act; what that pairing does say — and it is the failure
 * named above — is that a candidate with this act exists at all. The act itself
 * is then asked of the candidate `pairByTarget` chose, which was chosen by the
 * sentence's target with its act left free to be wrong.
 */
describe("사례별 · 행위", () => {
  for (const media of MEDIA_CASES) {
    media.requirements.forEach((want, index) => {
      test(`${slot(media, index)} · 행위${pinSuffix(media)}`, () => {
        const { got, pairs, byTarget } = outcomeOf(media.id);
        const entry = pairs[index];
        assert.ok(entry, `${media.id}: 정답 ${index + 1}번이 짝지어지지 않았습니다`);
        if (UNREAD_BY_DESIGN.has(media.id)) {
          // 알려진 어긋남: 「사례별 · 읽기」 의 같은 사례와 같은 이유다. 정답은
          // `create` 이지만 문장이 통째로 읽히지 않아 짝지을 후보가 없다.
          assert.equal(entry.got, null, `"${media.text}" → 후보가 생겼습니다`);
          return;
        }
        assert.ok(
          entry.got,
          `"${media.text}" → \`${want.action}\` 후보가 없습니다. 나온 것: ` +
            (got.map((c) => c.action).join(", ") || "(없음)"),
        );
        // 이 축의 이름값은 여기 있다. 위의 assert.ok 는 "그 행위의 후보가
        // 존재한다" 까지만 말한다. 그 후보에게 행위를 다시 묻는 것은 pair() 가
        // 행위로 골라 준 이상 언제나 참이라 검사가 아니었다 — 대신 문장이 말하는
        // 대상을 낸 후보를 데려와 그 후보의 행위를 묻는다. 짝을 행위와 무관하게
        // 골랐으므로 이 등식은 틀릴 수 있고, 대상은 맞게 냈는데 행위를 잘못 붙인
        // 경우가 여기서 잡힌다.
        const named = byTarget[index];
        if (named) {
          assert.equal(
            named.action,
            want.action,
            `"${media.text}" → "${want.target ?? "(없음)"}" 을(를) 낸 후보의 행위`,
          );
        }
        // named 가 없다는 것은 대상이 어긋났다는 뜻이고, 그것은 「사례별 · 대상」
        // 이 자기 이름으로 실패하는 결함이다. 한 결함을 두 축에서 두 번
        // 실패시키지 않으려고 여기서는 묻지 않는다.
      });
    });
  }
});

/**
 * 대상, one requirement at a time.
 *
 * The axis a person actually reads back, and the one `wrongTarget` reports as a
 * single joined list — a good pin and a poor diagnosis. Per requirement the
 * failure names the sentence, what it asks for, and what came out instead. The
 * rules the answers follow (relative clause out, compound in, `-로` phrase out)
 * are written down in `mediaCases.ts`; these are that document, applied.
 */
describe("사례별 · 대상", () => {
  for (const media of MEDIA_CASES) {
    media.requirements.forEach((want, index) => {
      test(`${slot(media, index)} · 대상${pinSuffix(media)}`, () => {
        const entry = outcomeOf(media.id).pairs[index];
        assert.ok(entry, `${media.id}: 정답 ${index + 1}번이 짝지어지지 않았습니다`);
        if (UNREAD_BY_DESIGN.has(media.id)) {
          // 알려진 어긋남: 「사례별 · 읽기」 의 같은 사례와 같은 이유다. 정답
          // 대상은 `이미지와 영상` 이지만 후보 자체가 없다.
          assert.equal(entry.got, null, `"${media.text}" → 후보가 생겼습니다`);
          return;
        }
        assert.ok(entry.got, `"${media.text}" → \`${want.action}\` 후보가 없어 대상을 볼 수 없습니다`);
        assert.equal(
          targetOf(entry.got),
          want.target,
          `"${media.text}" → 대상은 "${want.target ?? "(없음)"}" 이어야 합니다`,
        );
      });
    });
  }
});
