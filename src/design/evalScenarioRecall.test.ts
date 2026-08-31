import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { designHarness } from "./harnessDesign.ts";
import { SCENARIOS } from "../eval/scenarios.ts";

/**
 * The designer, scored on project-scale requests.
 *
 * The corpora it had until now — `goldCases` and `holdoutCases` — are short
 * coding chores, because they were written for the coding agent. The designer
 * invites a different kind of sentence: "CNN부터 Transformer까지 쓰고, 학습과
 * 추론을 하고, 결과를 비교해줘". Measured only on the short ones, it looked
 * finished; measured on these, it read nothing at all from five of twenty-four
 * turns and named less than a third of what the user named.
 *
 * The answers here are not new. `src/eval/scenarios.ts` has carried a
 * hand-written keyword list per turn since the evaluator was built, and nothing
 * in the extractor was ever fitted to them — which makes them a holdout in
 * every sense that matters, without a line of new annotation.
 *
 * ## What each number means
 *
 * `turnsRead` is coverage: did the design produce any requirement of the user's
 * own. `keywordHit` is fidelity: of the things the user *named*, how many
 * survive into the requirement text a person reads. The second is the harder
 * one and the one that matters for this product — a design that says
 * "분류기를 추가한다" for a request naming CNN, ViT, 학습, 추론 and 비교 has
 * read the sentence and lost the request.
 *
 * The numbers are pinned rather than bounded. A drop is a regression and a rise
 * is a result; both should be a decision someone makes, not a threshold that
 * absorbs either quietly.
 */

interface Score {
  turnsWithAnswers: number;
  turnsRead: number;
  keywordHit: number;
  keywordTotal: number;
  unread: string[];
}

let score: Score;

before(async () => {
  let turnsWithAnswers = 0;
  let turnsRead = 0;
  let keywordHit = 0;
  let keywordTotal = 0;
  const unread: string[] = [];

  for (const scenario of SCENARIOS) {
    for (const [index, turn] of scenario.turns.entries()) {
      const wanted = turn.requirements ?? [];
      if (wanted.length === 0) continue;
      turnsWithAnswers += 1;

      const design = await designHarness({ text: turn.user });
      const stated = design.requirements.filter((r) => r.status !== "system_added");
      if (stated.length > 0) turnsRead += 1;
      else unread.push(`${scenario.id}#${index + 1}`);

      // What the design has to show for the request, in the words a person
      // reads. A keyword counts when it survives into that text — not when it
      // merely appeared in the input.
      const shown = stated.map((r) => r.text).join(" ").toLowerCase();
      for (const keyword of wanted) {
        keywordTotal += 1;
        if (shown.includes(keyword.toLowerCase())) keywordHit += 1;
      }
    }
  }

  score = { turnsWithAnswers, turnsRead, keywordHit, keywordTotal, unread };
});

describe("the designer on project-scale requests", () => {
  test("the corpus is the evaluator's, and it is not small", () => {
    // Guards the denominator itself. A scenario file that loses its answers
    // would make every number below improve for the wrong reason.
    assert.equal(score.turnsWithAnswers, 24);
    assert.equal(score.keywordTotal, 47);
  });

  test("every annotated turn produces at least one requirement", () => {
    // Was 19/24. The five it read nothing from were "CNN과 ViT로 분류기를
    // 만들고 각각 학습해줘", "torch와 torchvision을 설치해줘" and their kin —
    // ordinary project requests built from verbs the list had never needed
    // while it grew around editing a repository.
    assert.deepEqual(score.unread, []);
    assert.equal(score.turnsRead, 24);
  });

  test("keyword fidelity 35/47", () => {
    // 14 → 22 → 35. The 22 was target extraction: an enumeration lost every
    // member but the last ("CNN과 ViT로 분류기를 만들고" → "ViT로 분류기"), a
    // range lost both ends, and the renderer replaced the user's verb with a
    // representative of its class, so 번역 came back as 수정 and 비교 as 살펴봄.
    //
    // The twelve still missing are three separate things, none of them a
    // one-line fix and each recorded rather than rounded away:
    //
    //   · `쓰다` is not read at all, on purpose — "보고서를 쓰고" is writing and
    //     "CNN을 쓰고" is using, and the object cannot tell them apart. A missed
    //     request is a gap; a request turned into the wrong act is an invention.
    //   · "학습과 추론을 하고" binds a coordinated pair to the light verb 하다.
    //     Reading it needs 하다 itself to be a verb here, which would match
    //     almost every Korean sentence.
    //   · "Hugging Face와 …에서 모델을 찾아줘" names Hugging Face as a *source*,
    //     not as the object of 찾다. Sources are their own feature; the URL half
    //     of that same sentence already becomes a requirement and the bare name
    //     does not.
    assert.deepEqual(
      { hit: score.keywordHit, of: score.keywordTotal },
      { hit: 35, of: 47 },
      "keyword fidelity moved — a rise is a result worth recording, a drop is a regression",
    );
  });
});
