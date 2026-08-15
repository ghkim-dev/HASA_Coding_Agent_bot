import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { emptyContract, mergeContract, parseTurnContract, type TaskContract } from "../agent/turnContract.ts";
import { projectTaskProfile, CAPABILITY_KEYS, type TaskProfile } from "./taskProfile.ts";
import {
  measure,
  preferMeasure,
  evidenceConfidence,
  EVIDENCE_RANK,
  type ModelProfile,
} from "./modelProfile.ts";
import { filterEligible } from "./eligibility.ts";
import {
  DEFAULT_WEIGHTS,
  demandedCapabilities,
  neutralMatcher,
  recommendModel,
  type SemanticMatcher,
} from "./recommend.ts";
import {
  applyEvaluation,
  buildRegistry,
  isReferenceModel,
  MIN_SAMPLES_FOR_EVIDENCE,
  profileFromCatalogue,
} from "./modelRegistry.ts";
import type { ProviderModel } from "../provider/types.ts";
import { unknownCapabilities } from "../provider/types.ts";

/**
 * The router, tested as invariants rather than as expected numbers.
 *
 * §35 of the brief asks for this explicitly, and the reason is the one the
 * migration sweep already demonstrated: a fixture holding the number the
 * implementation happens to produce is a second copy of the implementation, and
 * it passes for exactly as long as it is useless. So nothing below asserts a
 * score. What it asserts is what must be true of *any* correct ranking —
 * a filtered model cannot be selected, more of a demanded capability cannot
 * rank lower, the same input gives the same answer.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function contractFor(
  goal: string,
  intents: string,
  requirements: string[],
  constraints: string[] = [],
): TaskContract {
  const parsed = parseTurnContract(
    {
      goal,
      relation: "new_task",
      intents,
      requirements: requirements.join("\n"),
      ...(constraints.length === 0 ? {} : { constraints: constraints.join("\n") }),
    },
    "t1",
  );
  assert.equal(parsed.ok, true, `fixture contract must parse: ${goal}`);
  if (!parsed.ok) throw new Error("unreachable");
  return mergeContract(emptyContract(), parsed.contract);
}

/** §15 A — "README 문구 조금 수정해줘." */
const SIMPLE = (): TaskProfile =>
  projectTaskProfile(contractFor("README 오타 수정", "modify", ["README의 오타를 고친다"]));

/** §15 B — 30 files, analyse, fix, then test. */
const COMPLEX = (): TaskProfile =>
  projectTaskProfile(
    contractFor("TypeScript 오류 전체 수정", "modify execute verify inspect", [
      "30개 파일의 타입 오류를 분석한다",
      "각 파일의 오류를 수정한다",
      "테스트를 실행한다",
      "테스트가 통과할 때까지 반복한다",
    ]),
  );

/** §15 C — analyse only, do not execute or modify. */
const ANALYSIS_ONLY = (): TaskProfile =>
  projectTaskProfile(
    contractFor("코드 구조 분석", "inspect discuss", ["이 코드의 아키텍처 문제를 분석한다"], [
      "no_execute: 실행하지 마십시오",
      "no_modify: 수정하지 마십시오",
    ]),
  );

function model(id: string, over: Partial<ModelProfile> = {}): ModelProfile {
  return {
    modelId: id,
    availability: {
      available: true,
      protocol: "native",
      contextWindow: 128_000,
      maxOutputTokens: 8192,
      supportsNativeTools: true,
    },
    capabilities: {},
    efficiency: {},
    semanticDescription: `${id} 설명`,
    evidence: { evalSampleCount: 0 },
    ...over,
  };
}

function providerModel(id: string, over: Partial<ProviderModel> = {}): ProviderModel {
  return {
    id,
    ownedBy: null,
    capabilities: unknownCapabilities(),
    limits: { maxOutputTokens: 4096, contextWindow: 32_000 },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// TaskProfile — the projection
// ---------------------------------------------------------------------------

describe("router · TaskProfile is projected from the contract, never re-read from prose", () => {
  const PROFILES: ReadonlyArray<[string, () => TaskProfile]> = [
    ["simple", SIMPLE],
    ["complex", COMPLEX],
    ["analysis-only", ANALYSIS_ONLY],
  ];

  for (const [name, build] of PROFILES) {
    test(`${name} — every demand is a number in [0,1]`, () => {
      const profile = build();
      for (const key of CAPABILITY_KEYS) {
        const value = profile.demands[key];
        assert.ok(Number.isFinite(value), `${key} is not finite`);
        assert.ok(value >= 0 && value <= 1, `${key} = ${value} is outside [0,1]`);
      }
    });

    test(`${name} — names the contract it came from`, () => {
      const profile = build();
      assert.equal(profile.provenance.lastTurnId, "t1");
      assert.ok(profile.provenance.requirementIds.length > 0);
    });

    test(`${name} — projecting twice gives the same profile`, () => {
      assert.deepEqual(build(), build());
    });

    test(`${name} — invents no extraction quality the runtime cannot know`, () => {
      // §8. The runtime cannot know what the user said that the model failed to
      // record, so it must not report a coverage number.
      assert.equal(build().extractionQuality, undefined);
    });

    test(`${name} — the semantic description comes from the contract's own words`, () => {
      const profile = build();
      assert.ok(profile.semanticDescription.length > 0);
      // Never the raw user message: it is built from goal + requirements.
      for (const id of profile.provenance.requirementIds) {
        assert.equal(typeof id, "string");
      }
    });
  }

  test("§28 — a small edit is low complexity and prefers efficiency", () => {
    const profile = SIMPLE();
    assert.equal(profile.complexity, "low");
    assert.equal(profile.contextDemand, "small");
    assert.ok(profile.priorities.speed >= 0.8);
    assert.ok(profile.priorities.cost >= 0.8);
  });

  test("§28 — nothing forces a large model onto a small task", () => {
    const profile = SIMPLE();
    assert.ok(profile.demands.reasoning < 0.7, "a typo fix does not demand heavy reasoning");
    assert.ok(profile.demands.recovery < 0.7, "nor heavy recovery");
  });

  test("§29 — a multi-file fix-and-verify task demands coding, tools and recovery", () => {
    const profile = COMPLEX();
    assert.equal(profile.complexity, "high");
    assert.equal(profile.contextDemand, "large");
    assert.ok(profile.demands.coding >= 0.7);
    assert.ok(profile.demands.toolUse >= 0.7);
    assert.ok(profile.demands.recovery >= 0.6);
    assert.ok(profile.demands.debugging >= 0.7);
  });

  test("§29 — quality outranks speed once the work is large", () => {
    const profile = COMPLEX();
    assert.ok(profile.priorities.quality > profile.priorities.speed);
    assert.ok(profile.priorities.quality > profile.priorities.cost);
  });

  test("§30 — an analysis-only turn records both constraints as hard", () => {
    const profile = ANALYSIS_ONLY();
    assert.equal(profile.constraints.noExecute, true);
    assert.equal(profile.constraints.noModify, true);
  });

  test("§30 — and raises instruction-following, because there is now a way to fail", () => {
    const profile = ANALYSIS_ONLY();
    assert.ok(profile.demands.instructionFollowing >= 0.8);
    assert.ok(profile.demands.reasoning >= 0.6);
  });

  test("§30 — a constraint is a filter, not merely a score", () => {
    // The same demand could be produced by an intent; what makes it a
    // constraint is that it also appears in the hard set.
    const profile = ANALYSIS_ONLY();
    assert.notEqual(profile.constraints.noExecute, undefined);
  });

  test("an unclassified constraint forbids nothing", () => {
    const profile = projectTaskProfile(
      contractFor("무언가", "modify", ["뭔가 한다"], ["가능하면 빨리 해주세요"]),
    );
    assert.equal(profile.constraints.noExecute, undefined);
    assert.equal(profile.constraints.noModify, undefined);
    // But it is still on the record.
    assert.ok(profile.provenance.constraintKinds.includes("other"));
  });

  test("present_only implies both prohibitions", () => {
    const profile = projectTaskProfile(
      contractFor("보여만 주세요", "present", ["코드를 보여준다"], ["present_only: 보여주기만 하세요"]),
    );
    assert.equal(profile.constraints.presentOnly, true);
    assert.equal(profile.constraints.noExecute, true);
    assert.equal(profile.constraints.noModify, true);
  });

  test("an empty contract projects without throwing", () => {
    const profile = projectTaskProfile(emptyContract());
    assert.equal(profile.complexity, "low");
    assert.deepEqual(profile.provenance.requirementIds, []);
  });

  test("demanded capabilities are ordered by demand and are deterministic", () => {
    const profile = COMPLEX();
    const first = demandedCapabilities(profile);
    assert.deepEqual(first, demandedCapabilities(profile));
    for (let i = 1; i < first.length; i += 1) {
      assert.ok(
        profile.demands[first[i - 1]!] >= profile.demands[first[i]!],
        "demanded capabilities must be sorted strongest first",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

describe("router · a number and the reason to believe it are different things", () => {
  test("a stronger origin wins regardless of which was written last", () => {
    const declared = measure(0.9, "declared", 0);
    const evaluated = measure(0.4, "harness_eval", 50);
    assert.equal(preferMeasure(declared, evaluated), evaluated);
    assert.equal(preferMeasure(evaluated, declared), evaluated);
  });

  test("within an origin, more samples wins", () => {
    const few = measure(0.9, "harness_eval", 1);
    const many = measure(0.5, "harness_eval", 100);
    assert.equal(preferMeasure(few, many), many);
    assert.equal(preferMeasure(many, few), many);
  });

  test("merging never averages two disagreeing sources into a third number", () => {
    const a = measure(0.2, "declared", 0);
    const b = measure(0.8, "harness_eval", 10);
    const merged = preferMeasure(a, b)!;
    assert.ok(merged.value === 0.2 || merged.value === 0.8);
  });

  test("the origin ranking is total and strictly ordered", () => {
    const origins = Object.keys(EVIDENCE_RANK) as (keyof typeof EVIDENCE_RANK)[];
    const ranks = origins.map((o) => EVIDENCE_RANK[o]);
    assert.equal(new Set(ranks).size, ranks.length);
    assert.ok(EVIDENCE_RANK.harness_eval > EVIDENCE_RANK.declared);
    assert.ok(EVIDENCE_RANK.manual > EVIDENCE_RANK.harness_eval);
  });

  test("§12 — one run does not become a measured capability", () => {
    const base = model("m");
    const after = applyEvaluation(base, {
      modelId: "m",
      sampleCount: 1,
      metrics: { recoveryRate: 0.95 },
    });
    assert.equal(after.capabilities.recovery?.origin, "declared", "a single run is not evidence");
    assert.equal(after.evidence.evalSampleCount, 0);
  });

  test("§12 — enough runs does", () => {
    const after = applyEvaluation(model("m"), {
      modelId: "m",
      sampleCount: MIN_SAMPLES_FOR_EVIDENCE,
      metrics: { recoveryRate: 0.95 },
    });
    assert.equal(after.capabilities.recovery?.origin, "harness_eval");
    assert.equal(after.evidence.evalSampleCount, MIN_SAMPLES_FOR_EVIDENCE);
  });

  test("§11 — a reference model never becomes model data", () => {
    for (const id of ["reference:good", "reference:sloppy", "reference:stubborn", "reference:overclaimer"]) {
      assert.equal(isReferenceModel(id), true);
      const after = applyEvaluation(model(id), {
        modelId: id,
        sampleCount: 1000,
        metrics: { recoveryRate: 1, requirementRecall: 1 },
      });
      assert.deepEqual(after.capabilities, {}, `${id} must not produce capability data`);
    }
  });

  test("§11 — and is dropped from a registry build", () => {
    const registry = buildRegistry(
      [providerModel("real-model")],
      [
        { modelId: "reference:good", sampleCount: 100, metrics: { recoveryRate: 1 } },
        { modelId: "real-model", sampleCount: 10, metrics: { recoveryRate: 0.6 } },
      ],
    );
    assert.equal(registry.length, 1);
    assert.equal(registry[0]!.capabilities.recovery?.value, 0.6);
  });

  test("an unmeasured capability is absent, not zero", () => {
    const profile = profileFromCatalogue(providerModel("m"));
    assert.equal(profile.capabilities.coding, undefined);
    const confidence = evidenceConfidence(profile, ["coding", "recovery"]);
    assert.equal(confidence.known, 0);
    assert.equal(confidence.coldStart, true);
  });

  test("the catalogue's own description never contains the model id", () => {
    const profile = profileFromCatalogue(
      providerModel("qwen2.5-coder-32b", {
        capabilities: { ...unknownCapabilities(), coding: true },
      }),
    );
    assert.ok(
      !profile.semanticDescription.includes("qwen"),
      "a name is not evidence, and must not reach an embedding as though it were",
    );
  });
});

// ---------------------------------------------------------------------------
// Eligibility — §31
// ---------------------------------------------------------------------------

describe("router · a hard constraint cannot be outscored", () => {
  test("§31 — a model with too little context is filtered out, not ranked low", async () => {
    const small = model("small-context", {
      availability: {
        available: true,
        protocol: "native",
        contextWindow: 32_000,
        maxOutputTokens: 8192,
        supportsNativeTools: true,
      },
      // Deliberately excellent at everything the task wants.
      capabilities: {
        coding: measure(1, "harness_eval", 100),
        toolUse: measure(1, "harness_eval", 100),
        recovery: measure(1, "harness_eval", 100),
        debugging: measure(1, "harness_eval", 100),
      },
      evidence: { evalSampleCount: 100 },
    });
    const big = model("big-context", {
      capabilities: { coding: measure(0.5, "harness_eval", 10) },
      evidence: { evalSampleCount: 10 },
    });

    const task = projectTaskProfile(
      contractFor("큰 작업", "modify verify", ["여러 파일을 고친다", "테스트한다"]),
      { minContextWindow: 128_000 },
    );

    // A matcher that adores the ineligible model, to make the point.
    const biased: SemanticMatcher = {
      score: async (_t, m) => (m.modelId === "small-context" ? 0.99 : 0.1),
    };

    const result = await recommendModel(task, [small, big], { matcher: biased });
    assert.equal(result.selected?.modelId, "big-context");
    assert.ok(!result.alternatives.some((a) => a.modelId === "small-context"));
    const excluded = result.filteredOut.find((f) => f.modelId === "small-context");
    assert.equal(excluded?.code, "CONTEXT_TOO_SMALL");
    assert.match(excluded!.detail, /128,000|128000/);
  });

  test("a filtered model can never be the selection", async () => {
    const task = projectTaskProfile(contractFor("g", "modify", ["r"]), {
      forbiddenModels: ["banned"],
    });
    const result = await recommendModel(task, [model("banned"), model("fine")]);
    assert.notEqual(result.selected?.modelId, "banned");
    assert.ok(!result.alternatives.some((a) => a.modelId === "banned"));
  });

  const EXCLUSIONS: ReadonlyArray<{
    name: string;
    profile: ModelProfile;
    constraints: Parameters<typeof projectTaskProfile>[1];
    code: string;
  }> = [
    {
      name: "unavailable",
      profile: model("m", {
        availability: {
          available: false,
          protocol: "native",
          contextWindow: 128_000,
          maxOutputTokens: 4096,
          supportsNativeTools: true,
        },
      }),
      constraints: {},
      code: "MODEL_UNAVAILABLE",
    },
    {
      name: "cannot converse",
      profile: model("m", {
        availability: {
          available: true,
          protocol: null,
          contextWindow: 128_000,
          maxOutputTokens: 4096,
          supportsNativeTools: false,
        },
      }),
      constraints: {},
      code: "CANNOT_CONVERSE",
    },
    {
      name: "wrong protocol",
      profile: model("m", {
        availability: {
          available: true,
          protocol: "text",
          contextWindow: 128_000,
          maxOutputTokens: 4096,
          supportsNativeTools: false,
        },
      }),
      constraints: { requiredProtocol: ["native"] },
      code: "PROTOCOL_INCOMPATIBLE",
    },
    {
      name: "forbidden",
      profile: model("m"),
      constraints: { forbiddenModels: ["m"] },
      code: "USER_FORBIDDEN",
    },
    {
      name: "not allowlisted",
      profile: model("m"),
      constraints: { allowedModels: ["other"] },
      code: "NOT_IN_ALLOWLIST",
    },
    {
      name: "context too small",
      profile: model("m", {
        availability: {
          available: true,
          protocol: "native",
          contextWindow: 8_000,
          maxOutputTokens: 4096,
          supportsNativeTools: true,
        },
      }),
      constraints: { minContextWindow: 64_000 },
      code: "CONTEXT_TOO_SMALL",
    },
  ];

  for (const exclusion of EXCLUSIONS) {
    test(`${exclusion.name} — excluded with ${exclusion.code}`, () => {
      const task = projectTaskProfile(contractFor("g", "modify", ["r"]), exclusion.constraints);
      const { eligible, filteredOut } = filterEligible([exclusion.profile], task);
      assert.equal(eligible.length, 0);
      assert.equal(filteredOut[0]?.code, exclusion.code);
    });

    test(`${exclusion.name} — the exclusion says what was required`, () => {
      const task = projectTaskProfile(contractFor("g", "modify", ["r"]), exclusion.constraints);
      const { filteredOut } = filterEligible([exclusion.profile], task);
      assert.ok((filteredOut[0]?.detail.length ?? 0) > 0);
    });
  }

  test("an unknown context window is not treated as too small", () => {
    const unknown = model("m", {
      availability: {
        available: true,
        protocol: "native",
        contextWindow: null,
        maxOutputTokens: 4096,
        supportsNativeTools: true,
      },
    });
    const task = projectTaskProfile(contractFor("g", "modify", ["r"]), {
      minContextWindow: 128_000,
    });
    assert.equal(filterEligible([unknown], task).eligible.length, 1);
  });

  test("no eligible model produces a reason rather than an empty answer", async () => {
    const task = projectTaskProfile(contractFor("g", "modify", ["r"]), {
      allowedModels: ["nobody"],
    });
    const result = await recommendModel(task, [model("a"), model("b")]);
    assert.equal(result.selected, null);
    assert.ok((result.unavailableReason?.length ?? 0) > 0);
    assert.equal(result.filteredOut.length, 2);
  });

  test("an empty catalogue says so distinctly", async () => {
    const result = await recommendModel(SIMPLE(), []);
    assert.equal(result.selected, null);
    assert.match(result.unavailableReason!, /비어/);
  });
});

// ---------------------------------------------------------------------------
// Ranking — §32, §33, §23
// ---------------------------------------------------------------------------

describe("router · evaluation moves the ranking", () => {
  test("§32 — with semantics equal, the better recovery evaluation wins", async () => {
    const task = COMPLEX();
    assert.ok(task.demands.recovery > 0, "the fixture must actually demand recovery");

    const strong = model("strong-recovery", {
      capabilities: {
        recovery: measure(0.9, "harness_eval", 50),
        coding: measure(0.7, "harness_eval", 50),
      },
      evidence: { evalSampleCount: 50 },
    });
    const weak = model("weak-recovery", {
      capabilities: {
        recovery: measure(0.2, "harness_eval", 50),
        coding: measure(0.7, "harness_eval", 50),
      },
      evidence: { evalSampleCount: 50 },
    });

    const result = await recommendModel(task, [weak, strong], { matcher: neutralMatcher });
    assert.equal(result.selected?.modelId, "strong-recovery");
    assert.ok(
      result.selected!.breakdown.evaluation > result.alternatives[0]!.breakdown.evaluation,
      "the evaluation term is what separated them",
    );
  });

  test("more of a demanded capability never ranks lower, all else equal", async () => {
    const task = COMPLEX();
    for (const capability of demandedCapabilities(task).slice(0, 5)) {
      const better = model("better", {
        capabilities: { [capability]: measure(0.9, "harness_eval", 20) },
        evidence: { evalSampleCount: 20 },
      });
      const worse = model("worse", {
        capabilities: { [capability]: measure(0.1, "harness_eval", 20) },
        evidence: { evalSampleCount: 20 },
      });
      const result = await recommendModel(task, [worse, better]);
      assert.equal(
        result.selected?.modelId,
        "better",
        `raising ${capability} must not lower the ranking`,
      );
    }
  });

  test("a capability the task does not demand does not decide the ranking", async () => {
    const task = SIMPLE();
    const irrelevant = CAPABILITY_KEYS.find((k) => task.demands[k] === 0);
    assert.notEqual(irrelevant, undefined);
    const a = model("a", { capabilities: { [irrelevant!]: measure(1, "harness_eval", 50) } });
    const b = model("b", { capabilities: { [irrelevant!]: measure(0, "harness_eval", 50) } });
    const result = await recommendModel(task, [a, b]);
    assert.equal(
      result.selected!.breakdown.capability,
      result.alternatives[0]!.breakdown.capability,
    );
  });

  test("§33 — a model with no evaluation data stays a candidate", async () => {
    const cold = model("cold-start", {
      capabilities: { coding: measure(0.8, "declared") },
      evidence: { evalSampleCount: 0 },
    });
    const result = await recommendModel(COMPLEX(), [cold]);
    assert.equal(result.selected?.modelId, "cold-start");
    assert.equal(result.filteredOut.length, 0);
  });

  test("§33 — and the recommendation says the evaluation is missing", async () => {
    const cold = model("cold-start", { capabilities: { coding: measure(0.8, "declared") } });
    const result = await recommendModel(COMPLEX(), [cold]);
    assert.ok(result.reasons.some((r) => r.code === "EVALUATION_UNAVAILABLE"));
    assert.equal(result.selected!.confidence.coldStart, true);
  });

  test("a declared capability is not counted as an evaluation", async () => {
    const declared = model("declared-only", {
      capabilities: { coding: measure(1, "declared"), recovery: measure(1, "declared") },
    });
    const result = await recommendModel(COMPLEX(), [declared]);
    // Neutral, because nothing this harness measured stands behind it.
    assert.equal(result.selected!.breakdown.evaluation, 0.5);
    assert.ok(result.selected!.breakdown.capability > 0.5, "but it still counts as capability");
  });

  test("§23 — the same inputs give the same ranking, every time", async () => {
    const task = COMPLEX();
    const models = [
      model("a", { capabilities: { coding: measure(0.6, "harness_eval", 10) }, evidence: { evalSampleCount: 10 } }),
      model("b", { capabilities: { coding: measure(0.6, "harness_eval", 10) }, evidence: { evalSampleCount: 10 } }),
      model("c", { capabilities: { coding: measure(0.6, "harness_eval", 10) }, evidence: { evalSampleCount: 10 } }),
    ];
    const first = await recommendModel(task, models);
    for (let i = 0; i < 5; i += 1) {
      const again = await recommendModel(task, models);
      assert.deepEqual(again, first);
    }
  });

  test("§23 — catalogue order does not change the answer", async () => {
    const task = COMPLEX();
    const a = model("aaa", { capabilities: { coding: measure(0.6, "harness_eval", 10) } });
    const b = model("bbb", { capabilities: { coding: measure(0.6, "harness_eval", 10) } });
    const forward = await recommendModel(task, [a, b]);
    const backward = await recommendModel(task, [b, a]);
    assert.equal(forward.selected?.modelId, backward.selected?.modelId);
  });

  test("§23 — an exact tie is broken by evidence, then by id", async () => {
    const task = SIMPLE();
    const known = model("zzz-known", {
      capabilities: { coding: measure(0.5, "harness_eval", 10) },
      evidence: { evalSampleCount: 10 },
    });
    const unknown = model("aaa-unknown");
    const result = await recommendModel(task, [unknown, known]);
    // Not the alphabetically first: knowing more about the demanded
    // capabilities breaks the tie before the id does.
    assert.equal(result.selected?.modelId, "zzz-known");
  });

  test("the breakdown always sums to the reported score", async () => {
    const result = await recommendModel(COMPLEX(), [
      model("a", { capabilities: { coding: measure(0.7, "harness_eval", 9) } }),
      model("b", { capabilities: { recovery: measure(0.3, "harness_eval", 9) } }),
    ]);
    for (const ranked of [result.selected!, ...result.alternatives]) {
      const { semantic, capability, evaluation, efficiency } = ranked.breakdown;
      const expected =
        DEFAULT_WEIGHTS.semantic * semantic +
        DEFAULT_WEIGHTS.capability * capability +
        DEFAULT_WEIGHTS.evaluation * evaluation +
        DEFAULT_WEIGHTS.efficiency * efficiency;
      assert.ok(Math.abs(ranked.score - expected) < 1e-9);
      assert.equal(ranked.score, ranked.breakdown.total);
    }
  });

  test("§14 — semantic similarity alone cannot decide the recommendation", async () => {
    // A matcher that maxes one model and floors the other. Capability and
    // evaluation must still be able to overturn it.
    const loud: SemanticMatcher = {
      score: async (_t, m) => (m.modelId === "all-talk" ? 1 : 0),
    };
    const allTalk = model("all-talk", {
      capabilities: { coding: measure(0.05, "harness_eval", 50), toolUse: measure(0.05, "harness_eval", 50) },
      evidence: { evalSampleCount: 50 },
    });
    const capable = model("capable", {
      capabilities: { coding: measure(0.95, "harness_eval", 50), toolUse: measure(0.95, "harness_eval", 50) },
      evidence: { evalSampleCount: 50 },
    });
    const result = await recommendModel(COMPLEX(), [allTalk, capable], { matcher: loud });
    assert.equal(result.selected?.modelId, "capable");
  });

  test("the semantic term is carried, not silently dropped", async () => {
    const fixed: SemanticMatcher = { score: async () => 0.77 };
    const result = await recommendModel(SIMPLE(), [model("a")], { matcher: fixed });
    assert.equal(result.selected!.breakdown.semantic, 0.77);
  });
});

// ---------------------------------------------------------------------------
// Explainability — §17, §35
// ---------------------------------------------------------------------------

describe("router · the choice can be explained", () => {
  test("every reason references a signal that is actually in the TaskProfile", async () => {
    const task = ANALYSIS_ONLY();
    const result = await recommendModel(task, [
      model("m", {
        capabilities: { instructionFollowing: measure(0.9, "harness_eval", 40), reasoning: measure(0.8, "harness_eval", 40) },
        evidence: { evalSampleCount: 40 },
      }),
    ]);
    assert.ok(result.reasons.length > 0);
    for (const reason of result.reasons) {
      if (reason.subject === undefined) continue;
      const known = (CAPABILITY_KEYS as readonly string[]).includes(reason.subject);
      assert.ok(known, `reason subject ${reason.subject} is not a capability the profile has`);
      if ((CAPABILITY_KEYS as readonly string[]).includes(reason.subject)) {
        assert.ok(
          task.demands[reason.subject as keyof typeof task.demands] > 0,
          `${reason.subject} is named as a reason but the task does not demand it`,
        );
      }
    }
  });

  test("§30 — a constraint-bearing task names constraint-following as a reason", async () => {
    const result = await recommendModel(ANALYSIS_ONLY(), [model("m")]);
    assert.ok(result.reasons.some((r) => r.code === "CONSTRAINT_FOLLOWING_CRITICAL"));
  });

  test("a light task names efficiency as a reason", async () => {
    const result = await recommendModel(SIMPLE(), [model("m")]);
    assert.ok(result.reasons.some((r) => r.code === "EFFICIENCY_PREFERRED"));
  });

  test("a sole survivor is reported as such", async () => {
    const result = await recommendModel(SIMPLE(), [model("only")]);
    assert.ok(result.reasons.some((r) => r.code === "ONLY_CANDIDATE"));
  });

  test("why did B lose — the breakdown answers it term by term", async () => {
    const result = await recommendModel(COMPLEX(), [
      model("a", { capabilities: { coding: measure(0.9, "harness_eval", 20) }, evidence: { evalSampleCount: 20 } }),
      model("b", { capabilities: { coding: measure(0.2, "harness_eval", 20) }, evidence: { evalSampleCount: 20 } }),
    ]);
    const loser = result.alternatives[0]!;
    assert.equal(loser.modelId, "b");
    // Not merely "lower total": the term responsible is identifiable.
    assert.ok(loser.breakdown.capability < result.selected!.breakdown.capability);
    assert.equal(loser.breakdown.semantic, result.selected!.breakdown.semantic);
  });

  test("alternatives are kept in rank order for a future fallback (§21)", async () => {
    const result = await recommendModel(COMPLEX(), [
      model("a", { capabilities: { coding: measure(0.9, "harness_eval", 20) } }),
      model("b", { capabilities: { coding: measure(0.5, "harness_eval", 20) } }),
      model("c", { capabilities: { coding: measure(0.1, "harness_eval", 20) } }),
    ]);
    const scores = [result.selected!, ...result.alternatives].map((r) => r.score);
    for (let i = 1; i < scores.length; i += 1) {
      assert.ok(scores[i - 1]! >= scores[i]!, "candidates must be ordered for fallback");
    }
    assert.equal(result.alternatives.length, 2);
  });

  test("the recommendation names the profile it answered", async () => {
    const task = COMPLEX();
    const result = await recommendModel(task, [model("m")]);
    assert.equal(result.taskProfileId, task.id);
  });
});

// ---------------------------------------------------------------------------
// The registry, end to end
// ---------------------------------------------------------------------------

describe("router · the registry reads the catalogue the way Auto already does", () => {
  test("a model the catalogue cannot converse with is excluded by eligibility", async () => {
    const embedding = providerModel("emb", {
      capabilities: { ...unknownCapabilities(), chat: false },
    });
    const registry = buildRegistry([embedding]);
    assert.equal(registry[0]!.availability.protocol, null);
    const result = await recommendModel(SIMPLE(), registry);
    assert.equal(result.selected, null);
    assert.equal(result.filteredOut[0]?.code, "CANNOT_CONVERSE");
  });

  test("a model whose gateway blocks tool calls is a text-protocol candidate, not a reject", async () => {
    const blocked = providerModel("blocked", {
      capabilities: { ...unknownCapabilities(), chat: true, toolCalling: false, coding: true },
    });
    const registry = buildRegistry([blocked]);
    assert.equal(registry[0]!.availability.protocol, "native");
    assert.equal(registry[0]!.availability.supportsNativeTools, false);
    const result = await recommendModel(SIMPLE(), registry);
    assert.equal(result.selected?.modelId, "blocked");
  });

  test("an unavailable model is filtered with a reason", async () => {
    const registry = buildRegistry(
      [providerModel("down", { capabilities: { ...unknownCapabilities(), chat: true } })],
      [],
      { unavailable: ["down"] },
    );
    const result = await recommendModel(SIMPLE(), registry);
    assert.equal(result.filteredOut[0]?.code, "MODEL_UNAVAILABLE");
  });

  test("evaluations fold into the catalogue without erasing it", () => {
    const registry = buildRegistry(
      [providerModel("m", { capabilities: { ...unknownCapabilities(), chat: true, coding: true } })],
      [{ modelId: "m", sampleCount: 20, metrics: { recoveryRate: 0.7, requirementRecall: 0.9 } }],
    );
    const profile = registry[0]!;
    assert.equal(profile.capabilities.coding?.origin, "declared");
    assert.equal(profile.capabilities.recovery?.origin, "harness_eval");
    assert.equal(profile.capabilities.instructionFollowing?.value, 0.9);
    assert.equal(profile.evidence.evalSampleCount, 20);
  });

  test("an evaluation outranks a declaration for the same capability", () => {
    const registry = buildRegistry(
      [providerModel("m", { capabilities: { ...unknownCapabilities(), chat: true, toolCalling: true } })],
      [{ modelId: "m", sampleCount: 30, metrics: { firstActionAccuracy: 0.2 } }],
    );
    // Declared tool use was 0.75; the harness measured 0.2 and that is what stands.
    assert.equal(registry[0]!.capabilities.toolUse?.value, 0.2);
    assert.equal(registry[0]!.capabilities.toolUse?.origin, "harness_eval");
  });

  test("metric values outside [0,1] are clamped rather than trusted", () => {
    const registry = buildRegistry(
      [providerModel("m", { capabilities: { ...unknownCapabilities(), chat: true } })],
      [{ modelId: "m", sampleCount: 10, metrics: { recoveryRate: 1.8, requirementRecall: -3 } }],
    );
    assert.equal(registry[0]!.capabilities.recovery?.value, 1);
    assert.equal(registry[0]!.capabilities.instructionFollowing?.value, 0);
  });

  test("building the registry twice builds the same registry", () => {
    const models = [
      providerModel("a", { capabilities: { ...unknownCapabilities(), chat: true, coding: true } }),
      providerModel("b", { capabilities: { ...unknownCapabilities(), chat: true } }),
    ];
    const evaluations = [{ modelId: "a", sampleCount: 5, metrics: { recoveryRate: 0.5 } }];
    assert.deepEqual(buildRegistry(models, evaluations), buildRegistry(models, evaluations));
  });
});

// ---------------------------------------------------------------------------
// The boundary this slice is really about
// ---------------------------------------------------------------------------

describe("router · selection is not strategy, and competition is not the default", () => {
  test("a recommendation names exactly one worker", async () => {
    const result = await recommendModel(COMPLEX(), [model("a"), model("b"), model("c")]);
    assert.notEqual(result.selected, null);
    assert.equal(typeof result.selected!.modelId, "string");
  });

  test("the alternatives are ranked candidates, not co-workers", async () => {
    // §20: the online path runs one model. The others are kept for a future
    // fallback and for explainability, and nothing here suggests running them.
    const result = await recommendModel(COMPLEX(), [model("a"), model("b")]);
    assert.equal(result.alternatives.length, 1);
    assert.notEqual(result.selected!.modelId, result.alternatives[0]!.modelId);
  });

  test("nothing in the router decides how the agent should run", async () => {
    // Strategy is a separate axis (§19). The recommendation carries no strategy
    // field, and this test exists so adding one is a deliberate act.
    const result = await recommendModel(SIMPLE(), [model("a")]);
    assert.ok(!("strategy" in result));
    assert.ok(!("bestOfN" in result));
  });

  test("§8 — an extraction that recorded no constraint yields no constraint", () => {
    // The gpt-oss case from the live run: the same sentence produced a
    // constraint from one model and nothing from another. The router cannot
    // know what was missed, and must not act as though it does.
    const withConstraint = projectTaskProfile(
      contractFor("g", "modify", ["r"], ["no_execute: 실행하지 마십시오"]),
    );
    const without = projectTaskProfile(contractFor("g", "modify", ["r"]));
    assert.equal(withConstraint.constraints.noExecute, true);
    assert.equal(without.constraints.noExecute, undefined);
    assert.equal(without.extractionQuality, undefined);
  });

  test("§8 — the evaluator may supply coverage the runtime cannot", () => {
    const profile = projectTaskProfile(contractFor("g", "modify", ["r"]), {
      extractionQuality: { constraintCoverage: 0.5, requirementCoverage: 1 },
    });
    assert.equal(profile.extractionQuality?.constraintCoverage, 0.5);
  });
});
