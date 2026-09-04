import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { designHarness, type HarnessDesign } from "./harnessDesign.ts";
import { RECOMMENDATION_CASES, profileOf, type RecommendationCase } from "./recommendationCases.ts";
import type { FilteredModel } from "../router/eligibility.ts";

/**
 * Whether the router recommends well, with a denominator.
 *
 * Everything runs offline against synthetic candidates, so a failure here is a
 * failure of the demand projection, the eligibility filter or the ranker — never
 * of a gateway, and never of a catalogue that changed overnight.
 */

const designs = new Map<string, HarnessDesign>();

before(async () => {
  for (const c of RECOMMENDATION_CASES) {
    designs.set(
      c.id,
      await designHarness({ text: c.request, models: c.candidates.map(profileOf) }),
    );
  }
});

function designFor(c: RecommendationCase): HarnessDesign {
  const design = designs.get(c.id);
  assert.ok(design !== undefined, `${c.id}: no design`);
  return design;
}

describe("the expectations are traceable to a demand", () => {
  // A case asserting a basis the request does not have is a preference wearing
  // a measurement's clothes. This runs before the scoring below so that a
  // corpus which drifts away from what the designer derives fails as a corpus
  // problem rather than as a router one.
  for (const c of RECOMMENDATION_CASES) {
    if (c.becauseCapability === undefined) continue;
    test(`${c.id}: ${c.becauseCapability} is actually demanded`, () => {
      const design = designFor(c);
      const demand = design.profile.demands[c.becauseCapability!] ?? 0;
      assert.ok(
        demand > 0,
        `${c.id} decides on ${c.becauseCapability}, but "${c.request}" demands ${demand} of it`,
      );
    });
  }

  test("every case explains itself", () => {
    for (const c of RECOMMENDATION_CASES) {
      assert.ok(c.why.length > 30, `${c.id}: 이유가 너무 짧습니다`);
      assert.ok(c.candidates.length >= 2, `${c.id}: 후보가 둘 미만입니다`);
    }
  });
});

describe("the recommendation, scored", () => {
  for (const c of RECOMMENDATION_CASES) {
    test(`${c.id}`, () => {
      const design = designFor(c);
      const rec = design.recommendation;
      assert.ok(rec !== null, `${c.id}: no recommendation was produced`);

      if (c.expectWinner === null) {
        assert.equal(
          rec.selected,
          null,
          `${c.id}: everything should have been filtered, but ${rec.selected?.modelId} was picked`,
        );
      } else {
        assert.equal(
          rec.selected?.modelId,
          c.expectWinner,
          `${c.id}: ${c.why}`,
        );
      }

      for (const excluded of c.expectExcluded ?? []) {
        // Annotated rather than inferred: `assert.ok` narrows the binding it is
        // given, and TypeScript reads that as `found` depending on itself.
        const found: FilteredModel | undefined = rec.filteredOut.find(
          (f) => f.modelId === excluded.id,
        );
        assert.ok(
          found !== undefined,
          `${c.id}: ${excluded.id} should have been excluded, and was not`,
        );
        assert.equal(found.code, excluded.code, `${c.id}: ${excluded.id} excluded under the wrong code`);
      }
    });
  }

  test("the score, with its denominator", () => {
    // The number this file exists to produce. Pinned rather than bounded: a
    // drop is a regression someone should look at, and a rise is a result
    // someone should record.
    //
    // 14/14 → 20/20. The six that joined it are the three project topics this
    // file had never been asked and the continuation turn — and that last one
    // failed when it was written, which is what a corpus is for. `continue`
    // had a row in `INTENT_DEMAND` asking for `multiTurnContinuity` above
    // everything, and nothing ever reached it: intents came only from the acts
    // a sentence names, "이어서 해줘" names none, so a continuation was routed
    // as if it were a request to read something.
    let hit = 0;
    for (const c of RECOMMENDATION_CASES) {
      const rec = designFor(c).recommendation;
      const winner = rec?.selected?.modelId ?? null;
      if (winner === c.expectWinner) hit += 1;
    }
    assert.deepEqual(
      { hit, of: RECOMMENDATION_CASES.length },
      { hit: 20, of: 20 },
      "recommendation accuracy moved",
    );
  });
});

describe("a recommendation carries its reasons", () => {
  test("every pick names at least one reason", () => {
    for (const c of RECOMMENDATION_CASES) {
      const rec = designFor(c).recommendation;
      if (rec?.selected === null || rec === null) continue;
      assert.ok(
        rec.reasons.length > 0,
        `${c.id}: a pick with no reason is a number with nothing behind it`,
      );
    }
  });

  test("an excluded model is never also a reason to be confident", () => {
    // The two lists must not overlap: a model that was filtered cannot appear
    // as a ranked alternative, or the panel would offer a candidate the router
    // already refused.
    for (const c of RECOMMENDATION_CASES) {
      const rec = designFor(c).recommendation;
      if (rec === null) continue;
      const ranked = new Set([
        ...(rec.selected === null ? [] : [rec.selected.modelId]),
        ...rec.alternatives.map((a) => a.modelId),
      ]);
      for (const f of rec.filteredOut) {
        assert.ok(!ranked.has(f.modelId), `${c.id}: ${f.modelId} was both excluded and ranked`);
      }
    }
  });
});
