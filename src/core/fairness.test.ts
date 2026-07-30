import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { JudgeConfigSchema, type CandidateInput, type JudgeConfig, type Sampling, type TaskSpec } from "../protocol/index.ts";
import { FairnessError, assertFairness, labelFor, resolveCandidateSpecs, shuffled } from "./fairness.ts";

const sampling: Sampling = { temperature: 0.2, topP: 1, maxOutputTokens: 2048 };
const judge: JudgeConfig = JudgeConfigSchema.parse({ modelId: "judge/model" });
const taskSpec: TaskSpec = { prompt: "compare these", systemPromptVersion: "response-compare-v1", checks: [] };

function candidates(...ids: string[]): CandidateInput[] {
  return ids.map((modelId) => ({ modelId }));
}

describe("assertFairness", () => {
  test("accepts two distinct models sharing one sampling config", () => {
    assert.doesNotThrow(() => assertFairness({ candidates: candidates("a", "b"), sampling, judge }));
  });

  test("rejects a single candidate — one entrant is not a comparison", () => {
    assert.throws(
      () => assertFairness({ candidates: candidates("a"), sampling, judge }),
      FairnessError,
    );
  });

  test("rejects duplicate models", () => {
    assert.throws(
      () => assertFairness({ candidates: candidates("a", "a"), sampling, judge }),
      (e: unknown) => e instanceof FairnessError && e.violations.some((v) => v.includes("중복")),
    );
  });

  test("rejects a per-candidate sampling override", () => {
    assert.throws(
      () =>
        assertFairness({
          candidates: [{ modelId: "a", overrides: { temperature: 0.9 } }, { modelId: "b" }],
          sampling,
          judge,
        }),
      (e: unknown) => e instanceof FairnessError && e.violations.some((v) => v.includes("temperature")),
    );
  });

  test("an override equal to the shared value is harmless", () => {
    assert.doesNotThrow(() =>
      assertFairness({
        candidates: [{ modelId: "a", overrides: { temperature: 0.2 } }, { modelId: "b" }],
        sampling,
        judge,
      }),
    );
  });

  test("rejects a judge that is also competing", () => {
    assert.throws(
      () => assertFairness({ candidates: candidates("a", "judge/model"), sampling, judge }),
      (e: unknown) => e instanceof FairnessError && e.violations.some((v) => v.includes("자기 심사")),
    );
  });

  test("reports every violation at once rather than the first", () => {
    try {
      assertFairness({ candidates: candidates("judge/model"), sampling, judge });
      assert.fail("expected FairnessError");
    } catch (err) {
      assert.ok(err instanceof FairnessError);
      assert.ok(err.violations.length >= 2);
    }
  });
});

describe("resolveCandidateSpecs", () => {
  test("labels follow declaration order so results stay mappable", () => {
    const specs = resolveCandidateSpecs("run1", candidates("x", "y", "z"), sampling, taskSpec);
    assert.deepEqual(
      specs.map((s) => s.label),
      ["cand-a", "cand-b", "cand-c"],
    );
    assert.deepEqual(
      specs.map((s) => s.modelId),
      ["x", "y", "z"],
    );
  });

  test("every spec carries identical sampling — the fairness invariant", () => {
    const specs = resolveCandidateSpecs("run1", candidates("x", "y"), sampling, taskSpec);
    const distinct = new Set(specs.map((s) => `${s.temperature}|${s.topP}|${s.maxOutputTokens}|${s.systemPromptVersion}`));
    assert.equal(distinct.size, 1);
  });

  test("labelFor degrades gracefully past the alphabet", () => {
    assert.equal(labelFor(0), "cand-a");
    assert.equal(labelFor(25), "cand-z");
    assert.equal(labelFor(26), "cand-27");
  });
});

describe("shuffled", () => {
  test("is a permutation, never a subset", () => {
    const input = [1, 2, 3, 4, 5];
    const out = shuffled(input, () => 0.42);
    assert.equal(out.length, input.length);
    assert.deepEqual([...out].sort((a, b) => a - b), input);
  });

  test("does not mutate the input", () => {
    const input = ["a", "b", "c"];
    shuffled(input, () => 0.1);
    assert.deepEqual(input, ["a", "b", "c"]);
  });

  test("a pinned RNG makes execution order reproducible", () => {
    const rng = (): number => 0.7;
    assert.deepEqual(shuffled([1, 2, 3, 4], rng), shuffled([1, 2, 3, 4], rng));
  });
});
