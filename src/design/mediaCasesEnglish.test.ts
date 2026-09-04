import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { ENGLISH_MEDIA_CASES, type EnglishMediaCase } from "./mediaCasesEnglish.ts";
import type { MediaRequirement } from "./mediaCases.ts";
import { functionalCandidates, type FunctionalCandidate } from "./functionalExtract.ts";

/**
 * The English pass, scored — the first time it has had a denominator.
 *
 * The same three axes the Korean corpus uses, so the two can be compared
 * directly. They should not diverge much: a person asking for the same project
 * in the other language is asking for the same thing, and a design that reads
 * one well and the other badly is a design with a language it does not admit to
 * preferring.
 */

interface Score {
  turns: number;
  read: number;
  goldTotal: number;
  actHit: number;
  targetHit: number;
  unread: string[];
  wrongTarget: string[];
}

let score: Score;

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

before(() => {
  let read = 0;
  let goldTotal = 0;
  let actHit = 0;
  let targetHit = 0;
  const unread: string[] = [];
  const wrongTarget: string[] = [];

  for (const media of ENGLISH_MEDIA_CASES) {
    const got = functionalCandidates({ turnId: "t1", text: media.text });
    if (got.length > 0) read += 1;
    else unread.push(media.id);

    goldTotal += media.requirements.length;
    for (const { gold, got: match } of pair(media.requirements, got)) {
      if (match === null) continue;
      actHit += 1;
      const target = match.object.length === 0 ? null : match.object;
      if (sameTarget(target, gold.target)) targetHit += 1;
      else wrongTarget.push(`${media.id}: "${gold.target ?? "(없음)"}" 인데 "${target ?? "(없음)"}"`);
    }
  }

  score = { turns: ENGLISH_MEDIA_CASES.length, read, goldTotal, actHit, targetHit, unread, wrongTarget };
});

describe("영어로 물은 생성형 미디어 프로젝트", () => {
  test("말뭉치 자체", () => {
    assert.equal(score.turns, 25);
    assert.equal(score.goldTotal, 30);
    for (const media of ENGLISH_MEDIA_CASES) {
      assert.ok(media.why.length > 15, `${media.id}: 이유가 없습니다`);
      assert.ok(media.requirements.length > 0, `${media.id}: 정답이 비어 있습니다`);
    }
  });

  test("모든 문장에서 최소 한 개는 읽는다", () => {
    // Was 11/20 when this corpus was written — nine ordinary English sentences
    // produced nothing at all. Five more sentences joined it later, aimed at
    // the defects the Korean pass had just been made to give up; two of those
    // five were read as nothing and three produced a target the sentence does
    // not contain, which is what a 23/23 on the first twenty had been hiding.
    assert.deepEqual(score.unread, []);
    assert.equal(score.read, 25);
  });

  test("행위 정확도", () => {
    assert.deepEqual(
      { hit: score.actHit, of: score.goldTotal },
      { hit: 30, of: 30 },
      "행위 정확도가 움직였습니다",
    );
  });

  test("대상 정확도", () => {
    assert.deepEqual(score.wrongTarget, []);
    assert.deepEqual(
      { hit: score.targetHit, of: score.goldTotal },
      { hit: 30, of: 30 },
      "대상 정확도가 움직였습니다",
    );
  });
});
