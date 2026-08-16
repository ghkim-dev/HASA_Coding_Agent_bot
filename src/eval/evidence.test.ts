import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { evaluationEvidence, evidenceForModel } from "./evidence.ts";
import { applyEvaluation, profileFromCatalogue, MIN_SAMPLES_FOR_EVIDENCE } from "../router/modelRegistry.ts";
import type { ScenarioResult } from "./report.ts";
import type { ProviderModel } from "../provider/types.ts";
import { buildRegistry } from "../router/modelRegistry.ts";
import { recommendModel } from "../router/recommend.ts";
import { projectTaskProfile } from "../router/taskProfile.ts";
import { emptyContract } from "../agent/turnContract.ts";

/**
 * The bridge from a sweep to the numbers a recommendation ranks on.
 *
 * The property under test throughout is that a metric nobody measured stays
 * absent. `rate(0, 0)` is 1 by design — a run asked to recover from nothing did
 * not fail — and the whole reason this module exists is that averaging those
 * 1s produces a model that looks good at things it was never asked to do.
 */

// --- fixtures ---------------------------------------------------------------

/**
 * A run with everything at zero, so each test states only what it is about.
 *
 * Zeroed denominators are the default deliberately: a test that wants a metric
 * measured has to say how many times it was asked, which is the distinction the
 * module turns on.
 */
function run(
  model: string,
  over: {
    requirementRecall?: number;
    requirementsExpected?: number;
    firstActionCorrect?: number;
    firstActionChecked?: number;
    invalidInvocationProposals?: number;
    proposed?: number;
    recovered?: number;
    challenges?: number;
    sourceFactsRecorded?: number;
    sourceFactsExpected?: number;
    modelCalls?: number;
    toolCalls?: number;
    harness?: string[];
  } = {},
): ScenarioResult {
  return {
    scenario: { id: "S", title: "S" } as unknown as ScenarioResult["scenario"],
    model: [],
    harness: (over.harness ?? []) as ScenarioResult["harness"],
    verdict: "pass" as ScenarioResult["verdict"],
    metrics: {
      scenarioId: "S",
      model,
      run: 1,
      understanding: {
        requirementRecall: over.requirementRecall ?? 1,
        requirementsExpected: over.requirementsExpected ?? 0,
        requirementsRecorded: 0,
        inferredRequirements: 0,
        relationAccuracy: 1,
        relationsChecked: 0,
        relations: [],
        sourceRequirementRecall: 1,
      },
      actions: {
        ladder: { proposed: over.proposed ?? 0, deferred: 0, denied: 0, executed: 0 },
        firstActionCorrect: over.firstActionCorrect ?? 0,
        firstActionChecked: over.firstActionChecked ?? 0,
        invalidInvocationProposals: over.invalidInvocationProposals ?? 0,
        policyMismatchProposals: 0,
        forbiddenExecutions: 0,
        duplicateProposals: 0,
      },
      containment: {} as never,
      recovery: {
        challenges: over.challenges ?? 0,
        recovered: over.recovered ?? 0,
        recoveryRate: 1,
        recoveryDepth: 0,
      },
      outcome: {
        requirementsPassed: 0,
        requirementsOutstanding: 0,
        verifiedCompletion: false,
        requirementLoss: 0,
        openIssues: 0,
        terminations: [],
        sourceFactRecall: 1,
        sourceFactsExpected: over.sourceFactsExpected ?? 0,
        sourceFactsRecorded: over.sourceFactsRecorded ?? 0,
      },
      efficiency: {
        modelCalls: over.modelCalls ?? 0,
        toolCalls: over.toolCalls ?? 0,
        webSearches: 0,
      },
      failures: [],
      harnessFailures: [],
    } as unknown as ScenarioResult["metrics"],
  };
}

const CATALOGUE: ProviderModel = {
  id: "m",
  capabilities: { coding: null, reasoning: null, toolCalling: true },
  limits: { contextWindow: 128000, maxOutputTokens: 8192 },
} as unknown as ProviderModel;

// --- the defect this module exists for --------------------------------------

describe("a metric is pooled over its own denominator", () => {
  test("six untested runs do not vote a failing recovery up to 0.75", () => {
    // Challenged twice, recovered from neither. Six other scenarios never
    // challenged it at all.
    const results = [
      run("m", { challenges: 1, recovered: 0 }),
      run("m", { challenges: 1, recovered: 0 }),
      ...Array.from({ length: 6 }, () => run("m")),
    ];

    const summary = evidenceForModel("m", results);
    assert.ok(summary !== null);

    // Derived, not asserted from memory: mean-of-rates is what the old path
    // computed, and it is what this must not equal.
    const meanOfRates =
      results.reduce((t, r) => t + r.metrics.recovery.recoveryRate, 0) / results.length;
    assert.equal(meanOfRates, 1, "the fixture's untested runs each report a perfect rate");

    assert.equal(summary.metrics.recoveryRate, 0, "recovered from none of the two it was asked");
    assert.notEqual(summary.metrics.recoveryRate, meanOfRates);
    assert.equal(summary.sampleCounts?.recoveryRate, 2, "two runs measured it, not eight");
  });

  test("a metric nobody asked about is absent rather than perfect", () => {
    const summary = evidenceForModel("m", [run("m"), run("m"), run("m")]);
    assert.ok(summary !== null);
    assert.equal(summary.metrics.recoveryRate, undefined);
    assert.equal(summary.metrics.requirementRecall, undefined);
    assert.equal(summary.metrics.sourceFactRecall, undefined);
    // Efficiency is produced by every run, so it survives.
    assert.equal(summary.metrics.meanModelCalls, 0);
  });

  test("pooling weights by denominator, not by run", () => {
    // One run asked about eight requirements and caught all of them; one asked
    // about two and caught none. Ten asked, eight caught.
    const results = [
      run("m", { requirementsExpected: 8, requirementRecall: 1 }),
      run("m", { requirementsExpected: 2, requirementRecall: 0 }),
    ];
    const summary = evidenceForModel("m", results);
    assert.equal(summary?.metrics.requirementRecall, 0.8);

    const unweighted = (1 + 0) / 2;
    assert.notEqual(summary?.metrics.requirementRecall, unweighted);
  });

  test("invocation validity is the complement of the invalid rate over proposals", () => {
    const summary = evidenceForModel("m", [
      run("m", { proposed: 10, invalidInvocationProposals: 3 }),
      run("m", { proposed: 10, invalidInvocationProposals: 1 }),
    ]);
    assert.equal(summary?.metrics.invocationValidity, 0.8);
    assert.equal(summary?.sampleCounts?.invocationValidity, 2);
  });

  test("a model that proposed nothing has no invocation evidence", () => {
    const summary = evidenceForModel("m", [run("m"), run("m")]);
    assert.equal(summary?.metrics.invocationValidity, undefined);
  });
});

describe("runs that broke the harness do not score the model", () => {
  test("a harness failure is excluded before anything is pooled", () => {
    const clean = run("m", { requirementsExpected: 4, requirementRecall: 1 });
    const broken = run("m", {
      requirementsExpected: 4,
      requirementRecall: 0,
      harness: ["forbidden execution escaped"],
    });

    const withBroken = evidenceForModel("m", [clean, broken]);
    const withoutBroken = evidenceForModel("m", [clean]);
    assert.deepEqual(withBroken?.metrics, withoutBroken?.metrics);
    assert.equal(withBroken?.sampleCount, 1);
  });

  test("a model whose every run broke the harness yields no evidence at all", () => {
    const summary = evidenceForModel("m", [run("m", { harness: ["x"] })]);
    assert.equal(summary, null);
  });
});

describe("per-metric sample counts reach the profile", () => {
  test("a thinly-sampled metric stays declared while a well-sampled one is measured", () => {
    // Recovery challenged twice; requirements asked in all five runs.
    const results = [
      run("m", { requirementsExpected: 2, requirementRecall: 1, challenges: 1, recovered: 1 }),
      run("m", { requirementsExpected: 2, requirementRecall: 1, challenges: 1, recovered: 1 }),
      run("m", { requirementsExpected: 2, requirementRecall: 1 }),
      run("m", { requirementsExpected: 2, requirementRecall: 1 }),
      run("m", { requirementsExpected: 2, requirementRecall: 1 }),
    ];
    const summary = evidenceForModel("m", results);
    assert.ok(summary !== null);
    assert.equal(summary.sampleCounts?.recoveryRate, 2);
    assert.equal(summary.sampleCounts?.requirementRecall, 5);
    assert.ok(2 < MIN_SAMPLES_FOR_EVIDENCE && 5 >= MIN_SAMPLES_FOR_EVIDENCE);

    const profile = applyEvaluation(profileFromCatalogue(CATALOGUE), summary);
    assert.equal(profile.capabilities.recovery?.origin, "declared", "two runs is an anecdote");
    assert.equal(profile.capabilities.instructionFollowing?.origin, "harness_eval");
    assert.equal(profile.capabilities.recovery?.samples, 2);
    assert.equal(profile.capabilities.instructionFollowing?.samples, 5);
  });

  test("without per-metric counts the overall count still applies", () => {
    const profile = applyEvaluation(profileFromCatalogue(CATALOGUE), {
      modelId: "m",
      sampleCount: 7,
      metrics: { requirementRecall: 0.5 },
    });
    assert.equal(profile.capabilities.instructionFollowing?.samples, 7);
    assert.equal(profile.capabilities.instructionFollowing?.origin, "harness_eval");
  });

  test("efficiency keeps its own scale rather than being squeezed into [0,1]", () => {
    const profile = applyEvaluation(profileFromCatalogue(CATALOGUE), {
      modelId: "m",
      sampleCount: 4,
      metrics: { meanToolCalls: 14 },
    });
    assert.equal(profile.efficiency.toolCalls?.value, 14);
  });
});

describe("evidence for a whole sweep", () => {
  test("one summary per model, and models are not mixed", () => {
    const summaries = evaluationEvidence([
      run("a", { requirementsExpected: 2, requirementRecall: 1 }),
      run("b", { requirementsExpected: 2, requirementRecall: 0 }),
      run("a", { requirementsExpected: 2, requirementRecall: 1 }),
    ]);
    assert.equal(summaries.length, 2);
    assert.equal(summaries.find((s) => s.modelId === "a")?.metrics.requirementRecall, 1);
    assert.equal(summaries.find((s) => s.modelId === "b")?.metrics.requirementRecall, 0);
    assert.equal(summaries.find((s) => s.modelId === "a")?.sampleCount, 2);
  });

  test("the measurement date is the sweep's, not the reader's", () => {
    const [summary] = evaluationEvidence(
      [run("a", { requirementsExpected: 1, requirementRecall: 1 })],
      "2026-01-02T03:04:05.000Z",
    );
    assert.equal(summary?.updatedAt, "2026-01-02T03:04:05.000Z");
  });
});

describe("evidence is what gives the ranking something to rank on", () => {
  /**
   * The claim R4 has been unable to make.
   *
   * With no evaluation every candidate scores 0.5 on every term, the totals
   * tie, and the winner is whoever the deterministic tie-break puts first —
   * which is a defensible way to pick a model and is not a recommendation. This
   * asserts the difference the bridge makes, without a gateway.
   */
  const catalogue = (id: string): ProviderModel =>
    ({
      id,
      ownedBy: null,
      capabilities: { coding: null, reasoning: null, toolCalling: true },
      limits: { contextWindow: 128000, maxOutputTokens: 8192 },
    }) as unknown as ProviderModel;

  const models = [catalogue("worker-a"), catalogue("worker-b")];

  const task = projectTaskProfile({
    ...emptyContract(),
    goal: "고쳐 주세요",
    intents: ["modify"],
    requirements: [
      {
        id: "r1",
        description: "버그를 고친다",
        required: true,
        provenance: { kind: "user", turnId: "t1" },
        lifecycle: "active",
      },
    ],
    lastTurnId: "t1",
  } as unknown as Parameters<typeof projectTaskProfile>[0]);

  test("with no evidence the candidates are indistinguishable", async () => {
    const registry = buildRegistry(models, []);
    const rec = await recommendModel(task, registry);
    const breakdown = rec.selected?.breakdown;
    assert.ok(breakdown !== undefined);

    // The evaluation term is the one that has nothing to say. Capability is not
    // 0.5 here because the catalogue declares tool calling, which is a fact
    // about the model — but it is the *same* fact about both, so it cannot
    // separate them either.
    assert.equal(breakdown.evaluation, 0.5);

    const scores = [rec.selected!.score, ...rec.alternatives.map((a) => a.score)];
    assert.equal(scores[0], scores[1], "nothing separates them");
  });

  test("a sweep's numbers break the tie, in the direction the numbers point", async () => {
    // Derived from runs, not written by hand: `worker-a` caught every
    // requirement it was asked about, `worker-b` caught none.
    const runs = [
      ...Array.from({ length: 4 }, () =>
        run("worker-a", { requirementsExpected: 3, requirementRecall: 1, firstActionChecked: 2, firstActionCorrect: 2 }),
      ),
      ...Array.from({ length: 4 }, () =>
        run("worker-b", { requirementsExpected: 3, requirementRecall: 0, firstActionChecked: 2, firstActionCorrect: 0 }),
      ),
    ];
    const registry = buildRegistry(models, evaluationEvidence(runs));
    const rec = await recommendModel(task, registry);

    assert.equal(rec.selected?.modelId, "worker-a");
    assert.notEqual(rec.selected?.breakdown.capability, 0.5, "the capability term is no longer neutral");
    assert.ok(
      rec.selected!.score > (rec.alternatives[0]?.score ?? 0),
      "the winner won on score rather than on tie-break order",
    );
  });

  test("the order of the catalogue does not decide it once evidence exists", async () => {
    const runs = [
      ...Array.from({ length: 4 }, () => run("worker-a", { requirementsExpected: 3, requirementRecall: 0 })),
      ...Array.from({ length: 4 }, () => run("worker-b", { requirementsExpected: 3, requirementRecall: 1 })),
    ];
    // `worker-a` is first in the catalogue and is the worse model. If the
    // tie-break were still deciding, it would win.
    const registry = buildRegistry(models, evaluationEvidence(runs));
    const rec = await recommendModel(task, registry);
    assert.equal(rec.selected?.modelId, "worker-b");
  });
});
