import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { functionalCandidates, type FunctionalCandidate } from "./functionalExtract.ts";
import { prohibitionsIn } from "../agent/statedProhibitions.ts";
import { GOLD_CASES } from "./goldCases.ts";
import { HOLDOUT_CASES } from "./holdoutCases.ts";
import { SCENARIOS } from "../eval/scenarios.ts";

/**
 * What must hold for every sentence, not for the ones somebody wrote a case for.
 *
 * The rest of this directory measures the extractor against answers: what it
 * should read from this sentence, what it should refuse to read from that one.
 * That is the right way to measure recall and it has a blind spot — a defect in
 * a shape nobody annotated is invisible until somebody annotates it.
 *
 * These are the properties the module's own header promises, checked against
 * every turn in all three corpora at once:
 *
 *     "Nothing is inferred from a verb alone, nothing is added because it
 *      'usually goes with' something else."
 *
 * A property test cannot say the extractor read a sentence *well*. It can say
 * that whatever it read, it read out of the sentence — which is the promise that
 * matters most, because a target the user never wrote is the one failure a
 * person reading the design panel cannot catch.
 *
 * The corpus size is asserted first. Every number below is meaningless if the
 * loop silently stops finding turns, and a property test that checks nothing
 * passes exactly as loudly as one that checks everything.
 */

interface Turn {
  id: string;
  text: string;
}

function everyTurn(): Turn[] {
  const turns: Turn[] = [];
  for (const gold of [...GOLD_CASES, ...HOLDOUT_CASES]) {
    for (const [i, turn] of gold.turns.entries()) {
      turns.push({ id: `${gold.id}#${i + 1}`, text: turn.text });
    }
  }
  for (const scenario of SCENARIOS) {
    for (const [i, turn] of scenario.turns.entries()) {
      turns.push({ id: `${scenario.id}#${i + 1}`, text: turn.user });
    }
  }
  return turns;
}

const TURNS = everyTurn();

let candidates: Array<{ turn: Turn; candidate: FunctionalCandidate }>;

before(() => {
  candidates = [];
  for (const turn of TURNS) {
    for (const candidate of functionalCandidates({ turnId: "t1", text: turn.text })) {
      candidates.push({ turn, candidate });
    }
  }
});

describe("추출기 불변식", () => {
  test("말뭉치가 비어 있지 않다", () => {
    // The denominator of every property below, pinned rather than bounded. A
    // property test that quietly stops finding turns passes exactly as loudly as
    // one that checks everything, and this is the only place that difference is
    // visible.
    //
    // `withObject` is the denominator of the invention check specifically: a
    // candidate with no object cannot invent one, so the count that matters is
    // how many actually name a target. `forbidding` is the denominator of the
    // contradiction check — if the corpora ever stop containing prohibitions,
    // that property is vacuous and this is what says so.
    const withObject = candidates.filter(({ candidate }) => candidate.object.length > 0).length;
    const forbidding = TURNS.filter((t) => [...prohibitionsIn(t.text)].length > 0).length;
    assert.deepEqual(
      { turns: TURNS.length, candidates: candidates.length, withObject, forbidding },
      // 123 → 124 when the generative-media verbs were added: `저장해줘` in one
      // of the scenario turns had produced nothing and now produces a
      // requirement.
      { turns: 117, candidates: 124, withObject: 112, forbidding: 14 },
      "말뭉치가 달라졌습니다 — 의도한 변경이면 이 숫자를 갱신하십시오",
    );
  });

  test("목적어의 모든 낱말은 사용자가 실제로 쓴 낱말이다", () => {
    // The promise. A target assembled out of anything but the sentence is an
    // invention, and this is the only check that covers a sentence nobody wrote
    // an answer for.
    const invented: string[] = [];
    for (const { turn, candidate } of candidates) {
      if (candidate.object.length === 0) continue;
      for (const word of candidate.object.split(/\s+/)) {
        if (!turn.text.includes(word)) {
          invented.push(`${turn.id}: "${word}" 는 원문에 없습니다 — ${candidate.text}`);
        }
      }
    }
    assert.deepEqual(invented, []);
  });

  test("근거 구간은 목적어를 담고 있다", () => {
    // A span that does not contain the words it is the evidence for points a
    // person at the wrong part of their own sentence.
    const wrong: string[] = [];
    for (const { turn, candidate } of candidates) {
      if (candidate.object.length === 0) continue;
      const quoted = turn.text.slice(candidate.span.start, candidate.span.end);
      for (const word of candidate.object.split(/\s+/)) {
        if (!quoted.includes(word)) {
          wrong.push(`${turn.id}: 근거 "${quoted}" 에 "${word}" 가 없습니다`);
        }
      }
    }
    assert.deepEqual(wrong, []);
  });

  test("금지하는 절에서 그 동작을 요구사항으로 만들지 않는다", () => {
    // The same invariant `statedProhibitions` enforces at the tool gate, checked
    // here at the other end: the two modules read the same words and must not
    // disagree about them. A positive requirement drawn out of the clause that
    // forbids it is how a refusal becomes a plan.
    //
    // Scoped to the clause, not the turn. This asserted the turn-wide version
    // first and passed — and the generated corpus in
    // `functionalExtract.fuzz.test.ts` showed that version is simply wrong:
    // "수정하지 말고 추가해줘" forbids one act and asks for another, and both are
    // what the user said. It passed here because a real sentence that forbids
    // something rarely asks for the same class in the same breath, which is a
    // property of the corpus rather than of the code.
    const contradictions: string[] = [];
    for (const { turn, candidate } of candidates) {
      const clause = turn.text.slice(candidate.span.start, candidate.span.end);
      const forbidden = new Set<string>([...prohibitionsIn(clause)]);
      const clashes =
        (forbidden.has("execute") && candidate.action === "execute") ||
        (forbidden.has("modify") &&
          (candidate.action === "modify" ||
            candidate.action === "create" ||
            candidate.action === "remove"));
      if (clashes) {
        contradictions.push(
          `${turn.id}: 금지하는 절 "${clause}" 에서 ${candidate.action} — ${candidate.text}`,
        );
      }
    }
    assert.deepEqual(contradictions, []);
  });

  test("두 번 읽어도 같은 것을 읽는다", () => {
    // Cheap, and it guards a specific accident: a `/g` flag on any of the verb
    // patterns would make `exec` carry `lastIndex` between calls, so the second
    // reading of the same sentence would differ from the first.
    for (const turn of TURNS) {
      const once = functionalCandidates({ turnId: "t1", text: turn.text });
      const twice = functionalCandidates({ turnId: "t1", text: turn.text });
      assert.deepEqual(twice, once, turn.id);
    }
  });

  test("조사가 겹쳐 남지 않는다", () => {
    // "결과도를 살펴본다" and "코드를를 수정한다" are what a half-stripped particle
    // looks like in front of a user.
    const doubled: string[] = [];
    for (const { turn, candidate } of candidates) {
      if (/(?:을을|를를|도를|도을|은을|는를|의를|만을)/u.test(candidate.text)) {
        doubled.push(`${turn.id}: ${candidate.text}`);
      }
    }
    assert.deepEqual(doubled, []);
  });

  test("목적어는 한 글자로 끝나지 않는다", () => {
    // A single surviving syllable is the shape a wrongly-stripped particle
    // leaves: `있 모델`, `의존성 되`, `속`. The extractor already refuses an
    // object shorter than two characters; this checks the same thing per word,
    // which is where those three actually went wrong.
    const fragments: string[] = [];
    for (const { turn, candidate } of candidates) {
      if (candidate.object.length === 0) continue;
      for (const word of candidate.object.split(/\s+/)) {
        // Latin words can legitimately be one character; Hangul fragments are
        // the failure this looks for.
        if (word.length === 1 && /[가-힣]/u.test(word)) {
          fragments.push(`${turn.id}: "${word}" — ${candidate.text}`);
        }
      }
    }
    assert.deepEqual(fragments, []);
  });
});
