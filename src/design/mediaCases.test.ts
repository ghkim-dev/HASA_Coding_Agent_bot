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

let score: Score;

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

function targetOf(candidate: FunctionalCandidate): string | null {
  return candidate.object.length === 0 ? null : candidate.object;
}

before(() => {
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
    if (got.length > media.requirements.length) spurious += got.length - media.requirements.length;

    for (const { gold, got: match } of pair(media.requirements, got)) {
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
});

describe("생성형 미디어 프로젝트 요청", () => {
  test("말뭉치 자체", () => {
    // The denominator, guarded. Every rate below is meaningless if this drifts.
    assert.equal(score.turns, 31);
    assert.equal(score.goldTotal, 33);
    for (const media of MEDIA_CASES) {
      assert.ok(media.why.length > 15, `${media.id}: 이유가 없습니다`);
      assert.ok(media.requirements.length > 0, `${media.id}: 정답이 비어 있습니다`);
    }
  });

  test("읽지 못하는 문장은 하나뿐이고, 그것이 무엇인지 적혀 있다", () => {
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
    // "프롬프트를 바꾸면 … 비교해줘" produced "프롬프트를 수정한다" — a condition
    // read as a request, and the actual request lost behind it.
    assert.equal(score.spurious, 0, "지어낸 요구사항이 있습니다");
  });
});
