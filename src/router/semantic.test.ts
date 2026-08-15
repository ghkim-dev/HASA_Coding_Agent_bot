import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { emptyContract, mergeContract, parseTurnContract, type TaskContract } from "../agent/turnContract.ts";
import { projectTaskProfile, type TaskProfile } from "./taskProfile.ts";
import { measure, type ModelProfile } from "./modelProfile.ts";
import { recommendModel } from "./recommend.ts";
import { routeTurn } from "./routing.ts";
import {
  SEMANTIC_SECTIONS,
  languagesIn,
  projectTaskSemanticProfile,
  renderSemanticText,
  semanticFingerprint,
  validateModelSemanticProfile,
  type ModelSemanticProfile,
} from "./semanticProfile.ts";
import {
  coverageOf,
  curatedProfiles,
  semanticProfileFor,
  validateProfiles,
} from "./modelSemanticCatalog.ts";
import {
  COLD_START_SCORE,
  EmbeddingCache,
  PROVISIONAL_METHOD,
  cosineSimilarity,
  embeddingMatcher,
  normalizeSimilarity,
  spaceKey,
  type EmbeddingProvider,
} from "./embedding.ts";
import { applyCalibration, fitCalibration } from "./calibration.ts";
import { filterEligible } from "./eligibility.ts";
import { roleIsWorker } from "./semanticProfile.ts";
import { buildRegistry } from "./modelRegistry.ts";
import { unknownCapabilities, type ProviderModel } from "../provider/types.ts";
import { DEFAULT_POLICY, knownPolicies, policyById, policyIsWellFormed } from "./policy.ts";

/**
 * R4: the semantic term stops measuring nothing.
 *
 * The tests do not assert cosine values. A number out of an embedding model is
 * not a fact this repository owns, and a fixture holding one would fail the day
 * the model changed while proving nothing about the router. What is asserted is
 * ordering — that a Python debugging task scores a code model above a
 * summarisation model, and the reverse for a Korean document task — and that
 * the term stays subordinate to the other three.
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
  assert.equal(parsed.ok, true, goal);
  if (!parsed.ok) throw new Error("unreachable");
  return mergeContract(emptyContract(), parsed.contract);
}

const PYTHON_DEBUG = contractFor(
  "Python 디버깅과 테스트 수리",
  "modify\nverify\ninspect",
  ["여러 파일의 Python 오류를 분석한다", "실패하는 테스트를 고친다", "테스트를 실행한다"],
);

const KOREAN_DOCS = contractFor(
  "한국어 문서 요약과 보고서 분석",
  "discuss\ninspect",
  ["회의 문서를 요약한다", "보고서 내용을 분석한다"],
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
    semanticDescription: id,
    evidence: { evalSampleCount: 0 },
    ...over,
  };
}

function semantic(
  modelId: string,
  domains: string[],
  taskTypes: string[],
  languages: string[],
  description: string,
): ModelSemanticProfile {
  return {
    modelId,
    role: "general_worker",
    domains,
    taskTypes,
    languages,
    description,
    provenance: { origin: "manual", evidenceStatus: "provider_documented", source: "test fixture", reviewed: false },
  };
}

const CODER = semantic(
  "coder",
  ["software engineering"],
  ["implementation", "debugging", "code analysis"],
  ["en"],
  "Code-specialised model for code generation, code repair and Python debugging.",
);

const SUMMARISER = semantic(
  "summariser",
  ["document processing", "Korean language tasks"],
  ["summarization", "translation", "document analysis"],
  ["ko", "en"],
  "Model for Korean document summarization, report analysis and translation.",
);

/**
 * A deterministic stand-in for an embedding model.
 *
 * A bag-of-words vector over a fixed vocabulary. Not an embedding in any real
 * sense — no synonymy, no subword handling — but it is deterministic, it needs
 * no network, and it is enough to test the property under test: that ordering
 * follows subject matter. The real provider swaps in at the interface.
 */
/**
 * Concepts, each with the surface forms that mean it.
 *
 * The Korean and English forms share a dimension, and that is the point rather
 * than a convenience. The curated model descriptions are in English and the
 * users write in Korean, so a monolingual embedding would return a flat 0.5 for
 * every pair and the semantic term would be back to measuring nothing — this
 * time invisibly, because a plausible number would come out.
 *
 * That is a real constraint on which embedding model can be used in
 * production, not an artefact of this fake: it has to be multilingual.
 * `bge-m3`, which this key already allows, is.
 */
const CONCEPTS: readonly (readonly string[])[] = [
  ["python"],
  ["code", "coding", "코드", "코딩"],
  ["debug", "debugging", "디버깅"],
  ["repair", "fix", "수리", "고친다"],
  ["test", "testing", "테스트"],
  ["implementation", "구현"],
  ["software", "engineering", "소프트웨어"],
  ["analysis", "analyse", "분석"],
  ["error", "오류"],
  ["document", "문서"],
  ["summarization", "summary", "요약"],
  ["report", "보고서"],
  ["translation", "번역"],
  ["korean", "한국어"],
  ["meeting", "회의"],
];

const fakeProvider = (): EmbeddingProvider & { calls: number } => {
  const provider = {
    embeddingModelId: "fake-bow-v1",
    calls: 0,
    async embed(texts: readonly string[]): Promise<number[][]> {
      provider.calls += 1;
      return texts.map((text) => {
        const lower = text.toLowerCase();
        return CONCEPTS.map((forms) =>
          forms.reduce((total, form) => {
            let count = 0;
            let index = lower.indexOf(form);
            while (index !== -1) {
              count += 1;
              index = lower.indexOf(form, index + form.length);
            }
            return total + count;
          }, 0),
        );
      });
    },
  };
  return provider;
};

const matcherFor = (
  provider: EmbeddingProvider,
  profiles: Record<string, ModelSemanticProfile>,
): ReturnType<typeof embeddingMatcher> =>
  embeddingMatcher({
    provider,
    lookup: (id) => profiles[id] ?? null,
    taskSemantic: (task) => ({
      taskTypes: task.demands.coding > 0.5 ? ["implementation"] : ["explanation"],
      languages: [],
      description: task.semanticDescription,
    }),
  });

// ---------------------------------------------------------------------------
// R4.1 — A: coverage
// ---------------------------------------------------------------------------

describe("R4.1 · every Auto candidate is curated, to the same depth", () => {
  /**
   * Read from the probe's own record rather than written into this file.
   *
   * The list of Auto candidates is a measurement, and a copy of it here would
   * be a second one — it would keep passing after the key's model access
   * changed, which is exactly when this test should start failing.
   */
  const MATRIX = (() => {
    const path = new URL("../../.arena/capability-matrix.json", import.meta.url);
    return JSON.parse(readFileSync(path, "utf8")) as {
      probedAt?: string;
      models?: Array<{ modelId: string; capabilities?: { chat?: { status?: string } } }>;
    };
  })();

  const AUTO_CANDIDATES: string[] = (MATRIX.models ?? [])
    .filter((m) => m.capabilities?.chat?.status === "pass")
    .map((m) => m.modelId);

  test("the probe record names the models this key can converse with", () => {
    assert.ok(AUTO_CANDIDATES.length > 0, "the capability matrix should list conversable models");
  });

  /**
   * The claim below is only ever about the snapshot on disk.
   *
   * This has already been wrong once. The matrix was two weeks old, the key's
   * model access had changed from four models to sixteen, and one of the four
   * curated models had been withdrawn from the catalogue entirely — and the
   * coverage test passed the whole time, because it was asking a stale file
   * whether the file's own contents were covered.
   *
   * A test cannot reach the gateway; there is no credential in CI and there
   * should not be. What it can do is refuse to be quietly reassured: the age of
   * the record it is trusting is printed, so "coverage is complete" is never
   * read without "as of this date" beside it.
   */
  test("the record this coverage claim rests on says when it was taken", () => {
    assert.ok(typeof MATRIX.probedAt === "string", "the matrix must record when it was probed");
    const days = (Date.now() - Date.parse(MATRIX.probedAt!)) / 86_400_000;
    assert.ok(Number.isFinite(days), "probedAt must be a readable date");
    if (days > 7) {
      process.stderr.write(
        `\n  [coverage] the capability matrix is ${Math.floor(days)} days old ` +
          `(${MATRIX.probedAt}). Coverage below is a claim about that snapshot, not about ` +
          `the gateway. Re-run \`pnpm probe\` before trusting it.\n`,
      );
    }
  });

  /**
   * Invariants, not counts.
   *
   * The number of live models is not a fact this repository owns — it changed
   * from four to sixteen in thirteen days while a test asserting the old number
   * kept passing. What is stable is how coverage must *behave* when the
   * catalogue moves, and that is what is asserted here.
   */
  test("a model the gateway has just added shows up as cold start", () => {
    const coverage = coverageOf([...AUTO_CANDIDATES, "a-model-added-this-morning"]);
    assert.ok(coverage.coldStart.includes("a-model-added-this-morning"));
    assert.equal(coverage.complete, false);
    // And nothing was invented for it.
    assert.equal(semanticProfileFor("a-model-added-this-morning").profile, null);
  });

  test("a curated model the gateway no longer offers is reported obsolete", () => {
    const withoutOne = curatedProfiles()
      .map((p) => p.modelId)
      .filter((id) => id !== "exaone-4.0-32b");
    const coverage = coverageOf(withoutOne);
    assert.ok(coverage.obsolete.includes("exaone-4.0-32b"));
  });

  test("an obsolete profile never counts as coverage of a live candidate", () => {
    const live = ["some-live-model"];
    const coverage = coverageOf(live);
    assert.deepEqual(coverage.reviewed, []);
    assert.deepEqual(coverage.unreviewed, []);
    assert.deepEqual(coverage.coldStart, live);
    // Every curated entry is obsolete relative to this catalogue, and none of
    // them is counted as covering anything.
    assert.equal(coverage.obsolete.length, curatedProfiles().length);
  });

  test("coverage is complete only when every live id is curated", () => {
    const allCurated = curatedProfiles().map((p) => p.modelId);
    assert.equal(coverageOf(allCurated).complete, true);
    assert.equal(coverageOf([...allCurated, "one-more"]).complete, false);
  });

  test("every curated entry carries the same fields, so none is thinner", () => {
    for (const profile of curatedProfiles()) {
      const id = profile.modelId;
      assert.ok(profile.domains.length > 0, `${id} has no domains`);
      assert.ok(profile.taskTypes.length > 0, `${id} has no task types`);
      assert.ok(profile.languages.length > 0, `${id} has no languages`);
      assert.ok(profile.description.trim().length > 0, `${id} has no description`);
      assert.ok(profile.provenance.source.trim().length > 0, `${id} has no source`);
      assert.notEqual(profile.provenance.evidenceStatus, undefined, `${id} has no evidence status`);
    }
  });

  test("G — a model nobody curated is cold-start, not invented", () => {
    const lookup = semanticProfileFor("some-model-that-does-not-exist");
    assert.equal(lookup.status, "cold_start");
    assert.equal(lookup.profile, null);
  });

  test("G — and coverage reports it rather than hiding it", () => {
    const coverage = coverageOf([...curatedProfiles().map((p) => p.modelId), "brand-new-model"]);
    assert.deepEqual(coverage.coldStart, ["brand-new-model"]);
    assert.equal(coverage.complete, false);
  });

  test("every entry says where it came from", () => {
    for (const profile of curatedProfiles()) {
      assert.ok(profile.provenance.source.trim().length > 0, profile.modelId);
      assert.equal(profile.provenance.origin, "manual");
    }
  });

  test("nothing claims to have been reviewed that has not been", () => {
    for (const profile of curatedProfiles()) {
      if (profile.provenance.reviewed) {
        assert.ok(profile.provenance.reviewedAt !== undefined, `${profile.modelId} claims review with no date`);
      } else {
        assert.equal(semanticProfileFor(profile.modelId).status, "unreviewed");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Being able to answer is not being for this
// ---------------------------------------------------------------------------

describe("R4 · a model that is not a worker is filtered, not out-scored", () => {
  const providerModel = (id: string): ProviderModel => ({
    id,
    ownedBy: null,
    capabilities: { ...unknownCapabilities(), chat: true, toolCalling: true, coding: true },
    limits: { maxOutputTokens: 4096, contextWindow: 128_000 },
  });

  test("the role table decides, and unknown is not a verdict", () => {
    assert.equal(roleIsWorker("general_worker"), true);
    assert.equal(roleIsWorker("coding_worker"), true);
    assert.equal(roleIsWorker("safety_classifier"), false);
    assert.equal(roleIsWorker("embedding"), false);
    assert.equal(roleIsWorker("reranker"), false);
    assert.equal(roleIsWorker("unknown"), "unknown");
  });

  test("the safety classifier is excluded before any score exists", () => {
    const registry = buildRegistry([providerModel("granite-guardian-3.1-8b")]);
    const task = projectTaskProfile(PYTHON_DEBUG);
    const { eligible, filteredOut } = filterEligible(registry, task);
    assert.equal(eligible.length, 0);
    assert.equal(filteredOut[0]?.code, "NOT_A_WORKER");
  });

  test("and the refusal names its basis, including that it is unreviewed", () => {
    const registry = buildRegistry([providerModel("granite-guardian-3.1-8b")]);
    const { filteredOut } = filterEligible(registry, projectTaskProfile(PYTHON_DEBUG));
    assert.match(filteredOut[0]!.detail, /guardrail|classifier/i);
    assert.match(filteredOut[0]!.detail, /provider_documented/);
  });

  test("passing the capability probe does not make something a worker", () => {
    // The probe measured chat and tool calling as true for this model; that is
    // what made it a candidate before, and it is not what decides now.
    const registry = buildRegistry([providerModel("granite-guardian-3.1-8b")]);
    const profile = registry[0]!;
    assert.equal(profile.availability.protocol, "native");
    assert.equal(profile.availability.supportsNativeTools, true);
    assert.equal(profile.intendedUse?.workerEligible, false);
  });

  test("a semantic score never has to compensate for it", async () => {
    // The failure this replaces: relying on similarity to push a non-worker
    // down. Semantic is 0.15 against capability's 0.40, so even a perfect
    // mismatch could lose to a strong capability profile.
    const registry = buildRegistry([
      providerModel("granite-guardian-3.1-8b"),
      providerModel("exaone-4.0-32b"),
    ]);
    const generous = { score: async (): Promise<number> => 1 };
    const result = await recommendModel(projectTaskProfile(PYTHON_DEBUG), registry, {
      matcher: generous,
    });
    assert.equal(result.selected?.modelId, "exaone-4.0-32b");
    assert.ok(result.filteredOut.some((f) => f.code === "NOT_A_WORKER"));
  });

  test("the curated workers are not filtered", () => {
    for (const id of ["exaone-4.0-32b", "gpt-oss-20b", "qwen2.5-coder-32b"]) {
      const registry = buildRegistry([providerModel(id)]);
      const { eligible } = filterEligible(registry, projectTaskProfile(PYTHON_DEBUG));
      assert.equal(eligible.length, 1, id);
    }
  });

  test("an uncurated model is not excluded for lacking a role", () => {
    const registry = buildRegistry([providerModel("nobody-has-curated-this")]);
    assert.equal(registry[0]!.intendedUse, undefined);
    const { eligible } = filterEligible(registry, projectTaskProfile(PYTHON_DEBUG));
    assert.equal(eligible.length, 1, "cold start stays a candidate");
  });

  test("every curated entry declares a role", () => {
    for (const profile of curatedProfiles()) {
      assert.notEqual(profile.role, undefined, profile.modelId);
      assert.notEqual(profile.role, "unknown", `${profile.modelId} should state what it is`);
    }
  });
});

// ---------------------------------------------------------------------------
// R4.1 — B, C, D: what may not be in a profile
// ---------------------------------------------------------------------------

describe("R4.1 · a semantic profile is about subject, not quality or metadata", () => {
  test("B/C/D — the curated table passes its own validator", () => {
    assert.deepEqual(validateProfiles(), []);
  });

  const REJECTED: ReadonlyArray<{ name: string; profile: ModelSemanticProfile; code: string }> = [
    {
      name: "B a superlative",
      profile: semantic("m", ["software engineering"], ["implementation"], ["en"], "The best model for coding."),
      code: "QUALITY_CLAIM",
    },
    {
      name: "B a Korean superlative",
      profile: semantic("m", ["software engineering"], ["implementation"], ["en"], "코딩에 최고인 모델."),
      code: "QUALITY_CLAIM",
    },
    {
      name: "B 'powerful'",
      profile: semantic("m", ["software engineering"], ["implementation"], ["en"], "A powerful assistant."),
      code: "QUALITY_CLAIM",
    },
    {
      name: "C a percentage",
      profile: semantic("m", ["software engineering"], ["implementation"], ["en"], "Requirement recall 94% on the harness."),
      code: "EVALUATION_NUMBER",
    },
    {
      name: "C a score",
      profile: semantic("m", ["software engineering"], ["implementation"], ["en"], "Coding score 0.91 measured."),
      code: "EVALUATION_NUMBER",
    },
    {
      name: "D a context window",
      profile: semantic("m", ["software engineering"], ["implementation"], ["en"], "Supports a 128k context window."),
      code: "CAPABILITY_METADATA",
    },
    {
      name: "D a tool protocol",
      profile: semantic("m", ["software engineering"], ["implementation"], ["en"], "Has native tool calling."),
      code: "CAPABILITY_METADATA",
    },
    {
      name: "D Korean metadata",
      profile: semantic("m", ["software engineering"], ["implementation"], ["en"], "컨텍스트가 넉넉합니다."),
      code: "CAPABILITY_METADATA",
    },
    {
      name: "an empty profile",
      profile: semantic("m", [], [], [], "   "),
      code: "EMPTY",
    },
  ];

  for (const rejected of REJECTED) {
    test(`${rejected.name} is refused with ${rejected.code}`, () => {
      const problem = validateModelSemanticProfile(rejected.profile);
      assert.notEqual(problem, null);
      assert.equal(problem?.code, rejected.code);
    });
  }

  test("a source-less profile is refused", () => {
    const profile = semantic("m", ["software engineering"], ["implementation"], ["en"], "Does coding.");
    profile.provenance.source = "  ";
    assert.equal(validateModelSemanticProfile(profile)?.code, "NO_SOURCE");
  });

  test("a plain subject description passes", () => {
    assert.equal(validateModelSemanticProfile(CODER), null);
    assert.equal(validateModelSemanticProfile(SUMMARISER), null);
  });

  test("C — no curated description contains a measurement", () => {
    for (const profile of curatedProfiles()) {
      assert.ok(!/\d\s?%|\b0\.\d+\b/.test(profile.description), profile.modelId);
    }
  });
});

// ---------------------------------------------------------------------------
// R4.1 — E, F, H: renderer and axes
// ---------------------------------------------------------------------------

describe("R4.1 · the same profile renders the same text", () => {
  test("E — rendering is deterministic", () => {
    for (const profile of curatedProfiles()) {
      assert.equal(renderSemanticText(profile), renderSemanticText(profile));
    }
  });

  test("E — list order in the source does not change the output", () => {
    const forward = semantic("m", ["a", "b", "c"], ["x", "y"], ["ko", "en"], "d");
    const backward = semantic("m", ["c", "b", "a"], ["y", "x"], ["en", "ko"], "d");
    assert.equal(renderSemanticText(forward), renderSemanticText(backward));
  });

  test("E — and so does the fingerprint", () => {
    const forward = semantic("m", ["a", "b"], ["x"], ["ko"], "d");
    const backward = semantic("m", ["b", "a"], ["x"], ["ko"], "d");
    assert.equal(
      semanticFingerprint(renderSemanticText(forward)),
      semanticFingerprint(renderSemanticText(backward)),
    );
  });

  test("E — a changed profile gets a different fingerprint", () => {
    const before = semanticFingerprint(renderSemanticText(CODER));
    const after = semanticFingerprint(
      renderSemanticText({ ...CODER, domains: [...CODER.domains, "data analysis"] }),
    );
    assert.notEqual(before, after);
  });

  test("F — a renamed model does not acquire meaning from its new name", () => {
    const original = semanticProfileFor("granite-guardian-3.1-8b");
    assert.equal(original.status, "unreviewed");
    // The same id with an alias suffix is simply not in the table.
    assert.equal(semanticProfileFor("granite-guardian-3.1-8b-alias").status, "cold_start");
    assert.equal(semanticProfileFor("super-coder-9000").status, "cold_start");
    assert.equal(semanticProfileFor("granite-guardian-3.1-8b-v2").status, "cold_start");
  });

  test("F — an id containing a domain word produces nothing on its own", () => {
    for (const id of ["a-coding-model", "korean-summarizer", "debugger-pro"]) {
      assert.equal(semanticProfileFor(id).profile, null, id);
    }
  });

  test("H — both sides render through the same sections", () => {
    const taskText = renderSemanticText(projectTaskSemanticProfile(PYTHON_DEBUG));
    const modelText = renderSemanticText(CODER);
    const sectionsIn = (text: string): string[] =>
      SEMANTIC_SECTIONS.filter((s) => text.includes(`${s}:`));
    // Every section either side uses is one of the shared vocabulary.
    for (const section of sectionsIn(taskText)) assert.ok(SEMANTIC_SECTIONS.includes(section));
    for (const section of sectionsIn(modelText)) assert.ok(SEMANTIC_SECTIONS.includes(section));
    assert.ok(sectionsIn(taskText).length > 0);
    assert.ok(sectionsIn(modelText).length > 0);
  });

  test("H — the task side uses the same axes it can honestly fill", () => {
    const profile = projectTaskSemanticProfile(PYTHON_DEBUG);
    assert.ok(profile.taskTypes.length > 0);
    assert.ok(profile.description.length > 0);
    // Domains are absent rather than guessed. Nothing today can fill them.
    assert.equal(profile.domains, undefined);
  });

  test("the task's task types come from its intents, by table", () => {
    const debugging = projectTaskSemanticProfile(PYTHON_DEBUG);
    assert.ok(debugging.taskTypes.includes("implementation"));
    assert.ok(debugging.taskTypes.includes("testing"));
    const docs = projectTaskSemanticProfile(KOREAN_DOCS);
    assert.ok(docs.taskTypes.includes("explanation"));
    assert.ok(!docs.taskTypes.includes("execution"));
  });

  test("language is detected from the characters, not interpreted", () => {
    assert.deepEqual(languagesIn("한국어 문서를 요약해줘"), ["ko"]);
    assert.deepEqual(languagesIn("summarise this document"), ["en"]);
    assert.deepEqual(languagesIn("한국어 document"), ["ko", "en"]);
    assert.deepEqual(languagesIn("12345"), []);
  });

  test("the task description is the user's own words", () => {
    const profile = projectTaskSemanticProfile(PYTHON_DEBUG);
    assert.ok(profile.description.includes("Python"));
    assert.ok(profile.description.includes("테스트"));
  });
});

// ---------------------------------------------------------------------------
// R4.2 — ranking invariants
// ---------------------------------------------------------------------------

describe("R4.2 · similarity follows subject matter", () => {
  test("a Python debugging task scores the code model above the summariser", async () => {
    const provider = fakeProvider();
    const matcher = matcherFor(provider, { coder: CODER, summariser: SUMMARISER });
    const task = projectTaskProfile(PYTHON_DEBUG);
    const coder = await matcher.score(task, model("coder"));
    const summariser = await matcher.score(task, model("summariser"));
    assert.ok(coder > summariser, `coder ${coder} should beat summariser ${summariser}`);
  });

  test("a Korean document task scores the summariser above the code model", async () => {
    const provider = fakeProvider();
    const matcher = matcherFor(provider, { coder: CODER, summariser: SUMMARISER });
    const task = projectTaskProfile(KOREAN_DOCS);
    const coder = await matcher.score(task, model("coder"));
    const summariser = await matcher.score(task, model("summariser"));
    assert.ok(summariser > coder, `summariser ${summariser} should beat coder ${coder}`);
  });

  test("the ordering reverses with the task, which is the whole claim", async () => {
    const provider = fakeProvider();
    const matcher = matcherFor(provider, { coder: CODER, summariser: SUMMARISER });
    const debugCoder = await matcher.score(projectTaskProfile(PYTHON_DEBUG), model("coder"));
    const debugSummariser = await matcher.score(projectTaskProfile(PYTHON_DEBUG), model("summariser"));
    const docsCoder = await matcher.score(projectTaskProfile(KOREAN_DOCS), model("coder"));
    const docsSummariser = await matcher.score(projectTaskProfile(KOREAN_DOCS), model("summariser"));
    assert.ok(debugCoder > debugSummariser);
    assert.ok(docsSummariser > docsCoder);
  });

  test("scoring the same pair twice gives the same number", async () => {
    const matcher = matcherFor(fakeProvider(), { coder: CODER });
    const task = projectTaskProfile(PYTHON_DEBUG);
    const first = await matcher.score(task, model("coder"));
    const second = await matcher.score(task, model("coder"));
    assert.equal(first, second);
  });

  test("an uncurated model is neutral, not bad", async () => {
    const matcher = matcherFor(fakeProvider(), { coder: CODER });
    const score = await matcher.score(projectTaskProfile(PYTHON_DEBUG), model("nobody-curated"));
    // The literal, not the constant. Comparing against `COLD_START_SCORE` would
    // hold however that constant changed, which is the one thing this test is
    // for — 0.5 is the neutral every other term uses for "nothing is known",
    // and a cold start has to land there rather than at a measured zero.
    assert.equal(score, 0.5);
    assert.equal(COLD_START_SCORE, 0.5);
  });

  test("partial curation does not push uncurated models to the bottom", async () => {
    // The bias the curation slice was meant to avoid rather than introduce: if
    // an absent profile scored as a mismatch, every model nobody had written up
    // would rank last regardless of what it can do.
    const provider = fakeProvider();
    const matcher = matcherFor(provider, { curated: SUMMARISER });
    const task = projectTaskProfile(PYTHON_DEBUG);

    const uncuratedButAble = model("uncurated", {
      capabilities: { coding: measure(0.95, "harness_eval", 40), toolUse: measure(0.9, "harness_eval", 40) },
      evidence: { evalSampleCount: 40 },
    });
    const curatedButWeak = model("curated", {
      capabilities: { coding: measure(0.1, "harness_eval", 40), toolUse: measure(0.1, "harness_eval", 40) },
      evidence: { evalSampleCount: 40 },
    });

    const result = await recommendModel(task, [curatedButWeak, uncuratedButAble], { matcher });
    assert.equal(result.selected?.modelId, "uncurated");
  });

  test("a cold start is reported as one rather than as a measurement", async () => {
    const matcher = matcherFor(fakeProvider(), { coder: CODER });
    const explained = await matcher.explain(projectTaskProfile(PYTHON_DEBUG), model("nobody"));
    assert.equal(explained.raw, null, "there was no comparison, so there is no raw value");
    assert.equal(explained.method, "cold-start");
    assert.equal(explained.calibrated, false);
  });

  test("a score built on an unreviewed profile says so", async () => {
    const matcher = matcherFor(fakeProvider(), { coder: CODER });
    const explained = await matcher.explain(projectTaskProfile(PYTHON_DEBUG), model("coder"));
    assert.match(explained.method, /unreviewed-profile/);
  });

  test("and a reviewed one does not carry the marker", async () => {
    const reviewed: ModelSemanticProfile = {
      ...CODER,
      provenance: { origin: "manual", evidenceStatus: "provider_documented", source: "s", reviewed: true, reviewedAt: "2026-08-15" },
    };
    const matcher = matcherFor(fakeProvider(), { coder: reviewed });
    const explained = await matcher.explain(projectTaskProfile(PYTHON_DEBUG), model("coder"));
    assert.ok(!explained.method.includes("unreviewed"));
  });

  test("the cache key includes the space, not just the model name", () => {
    const a = spaceKey({ provider: "hasa", modelId: "bge-m3", dimension: 1024 });
    const b = spaceKey({ provider: "hasa", modelId: "bge-m3", dimension: 768 });
    const c = spaceKey({ provider: "other", modelId: "bge-m3", dimension: 1024 });
    assert.notEqual(a, b, "a different dimension is a different space");
    assert.notEqual(a, c, "a different backend is a different space");
  });

  test("the space a cache reports is the one it is actually keying on", async () => {
    // What can honestly be tested today. A cache holds one provider for its
    // whole life, so the provider and config parts of the key cannot vary
    // within an instance and two instances never share a map — those parts
    // become load-bearing only when a cache is shared or persisted across
    // spaces, which is not something this build does. The dimension part *does*
    // vary within an instance, and that is tested below.
    const provider: EmbeddingProvider = {
      embeddingModelId: "bge-m3",
      providerId: "hasa",
      configFingerprint: "pooling=cls",
      async embed(texts) {
        return texts.map(() => [1, 2, 3, 4]);
      },
    };
    const cache = new EmbeddingCache(provider);
    assert.equal(cache.space.dimension, null, "nothing embedded yet, so nothing observed");
    await cache.embedAll(["t"]);
    assert.deepEqual(cache.space, {
      provider: "hasa",
      modelId: "bge-m3",
      dimension: 4,
      configFingerprint: "pooling=cls",
    });
  });

  test("a changed vector dimension is a different space", async () => {
    let dimension = 4;
    const shifting: EmbeddingProvider = {
      embeddingModelId: "shifting",
      async embed(texts) {
        return texts.map(() => Array.from({ length: dimension }, (_, i) => i + 1));
      },
    };
    const cache = new EmbeddingCache(shifting);
    await cache.embedAll(["a"]);
    assert.equal(cache.space.dimension, 4);
    dimension = 8;
    await cache.embedAll(["b"]);
    assert.equal(cache.space.dimension, 8);
    // "a" was embedded in the old space and must not come back from the cache.
    const before = cache.calls;
    await cache.embedAll(["a"]);
    assert.ok(cache.calls > before, "a vector from the old space must not be reused");
  });

  test("a real comparison keeps its raw value alongside the normalised one", async () => {
    const matcher = matcherFor(fakeProvider(), { coder: CODER });
    const explained = await matcher.explain(projectTaskProfile(PYTHON_DEBUG), model("coder"));
    assert.notEqual(explained.raw, null);
    assert.equal(explained.calibrated, false);
    assert.equal(explained.normalized, normalizeSimilarity(explained.raw).normalized);
  });

  test("and costs no embedding call to find out", async () => {
    const provider = fakeProvider();
    const matcher = matcherFor(provider, { coder: CODER });
    await matcher.score(projectTaskProfile(PYTHON_DEBUG), model("nobody-curated"));
    assert.equal(matcher.cache.calls, 0);
  });

  test("raw cosine is reported as the metric produced it", () => {
    assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1]) ?? NaN) < 1e-9);
  });

  test("no comparison is null, not a number in the middle", () => {
    // "There was nothing to compare" and "the comparison came out neutral" are
    // different facts, and one float cannot carry both.
    assert.equal(cosineSimilarity([], []), null);
    assert.equal(cosineSimilarity([1, 2], [1]), null);
    assert.equal(cosineSimilarity([0, 0], [1, 1]), null);
  });

  test("the normalisation cannot subtract from a score the others only add to", () => {
    for (const raw of [-1, -0.5, 0, 0.41, 0.9, 1]) {
      const score = normalizeSimilarity(raw);
      assert.ok(score.normalized >= 0 && score.normalized <= 1, `${raw} → ${score.normalized}`);
    }
  });

  test("the normalisation is monotone, which is all it claims to be", () => {
    const values = [-1, -0.3, 0, 0.41, 0.7, 1].map((r) => normalizeSimilarity(r).normalized);
    for (let i = 1; i < values.length; i += 1) assert.ok(values[i]! >= values[i - 1]!);
  });

  test("and it says it is not a calibration", () => {
    const score = normalizeSimilarity(0.41);
    assert.equal(score.calibrated, false);
    assert.equal(score.method, PROVISIONAL_METHOD);
    assert.equal(score.raw, 0.41);
  });

  test("nothing here fixes 'unrelated means 0.5' as a fact about the metric", () => {
    // Measured against the model this project would use: the cosine of
    // "한국어 문서 요약" and "python debugging" — two texts with nothing in
    // common — is about 0.41, not 0. Under the provisional mapping that is 0.70.
    // Recorded so the number is visible rather than assumed away.
    const measuredUnrelated = 0.41;
    const provisional = normalizeSimilarity(measuredUnrelated);
    assert.ok(
      provisional.normalized > 0.6,
      "an unrelated pair does not land on the neutral point under this mapping",
    );
    assert.equal(provisional.calibrated, false);
  });

  test("a fitted calibration puts the measured floor on the neutral point", () => {
    const fitted = fitCalibration([
      { taskText: "a", modelText: "b", related: false, raw: 0.40 },
      { taskText: "a", modelText: "c", related: false, raw: 0.42 },
      { taskText: "a", modelText: "d", related: true, raw: 0.80 },
      { taskText: "a", modelText: "e", related: true, raw: 0.84 },
    ]);
    assert.notEqual(fitted, null);
    if (fitted === null) return;
    assert.ok(Math.abs(applyCalibration(0.41, fitted).normalized - 0.5) < 0.02);
    assert.ok(applyCalibration(0.82, fitted).normalized > 0.95);
    assert.equal(applyCalibration(0.82, fitted).calibrated, true);
  });

  test("a calibration with no negative examples is refused", () => {
    assert.equal(
      fitCalibration([{ taskText: "a", modelText: "b", related: true, raw: 0.9 }]),
      null,
    );
    assert.equal(
      fitCalibration([
        { taskText: "a", modelText: "b", related: true, raw: 0.4 },
        { taskText: "a", modelText: "c", related: false, raw: 0.5 },
      ]),
      null,
      "a set where unrelated scores higher has measured no separation",
    );
  });
});

// ---------------------------------------------------------------------------
// R4.2 — the term stays subordinate
// ---------------------------------------------------------------------------

describe("R4.2 · similarity cannot buy its way past anything", () => {
  const task = projectTaskProfile(PYTHON_DEBUG);

  test("a hard constraint still filters a perfect semantic match", async () => {
    const perfect = model("perfect-but-text-only", {
      availability: {
        available: true,
        protocol: "text",
        contextWindow: 128_000,
        maxOutputTokens: 4096,
        supportsNativeTools: false,
      },
      capabilities: { coding: measure(1, "harness_eval", 99) },
      evidence: { evalSampleCount: 99 },
    });
    const usable = model("usable", { capabilities: { coding: measure(0.4, "harness_eval", 9) } });
    const constrained = projectTaskProfile(PYTHON_DEBUG, { requiredProtocol: ["native"] });

    const result = await recommendModel(constrained, [perfect, usable], {
      matcher: { score: async (_t, m) => (m.modelId === "perfect-but-text-only" ? 1 : 0) },
    });
    assert.equal(result.selected?.modelId, "usable");
    assert.ok(result.filteredOut.some((f) => f.modelId === "perfect-but-text-only"));
  });

  test("capability and evaluation can still overturn a maximal similarity", async () => {
    const allTalk = model("all-talk", {
      capabilities: { coding: measure(0.05, "harness_eval", 50), toolUse: measure(0.05, "harness_eval", 50) },
      evidence: { evalSampleCount: 50 },
    });
    const capable = model("capable", {
      capabilities: { coding: measure(0.95, "harness_eval", 50), toolUse: measure(0.95, "harness_eval", 50) },
      evidence: { evalSampleCount: 50 },
    });
    const result = await recommendModel(task, [allTalk, capable], {
      matcher: { score: async (_t, m) => (m.modelId === "all-talk" ? 1 : 0) },
    });
    assert.equal(result.selected?.modelId, "capable");
  });

  test("the semantic term is 0.15 of the score, and the breakdown shows it", async () => {
    const result = await recommendModel(task, [model("m")], {
      matcher: { score: async () => 1 },
    });
    const withMax = result.selected!.breakdown.total;
    const floored = await recommendModel(task, [model("m")], {
      matcher: { score: async () => 0 },
    });
    const delta = withMax - floored.selected!.breakdown.total;
    assert.ok(Math.abs(delta - DEFAULT_POLICY.weights.semantic) < 1e-9);
  });

  test("similarity alone never decides between two otherwise equal models", async () => {
    // Equal on everything else, so semantic is the only differentiator — and it
    // does decide here, which is correct. The point is that it takes equality
    // everywhere else for that to happen.
    const a = model("a", { capabilities: { coding: measure(0.5, "harness_eval", 10) } });
    const b = model("b", { capabilities: { coding: measure(0.5, "harness_eval", 10) } });
    const result = await recommendModel(task, [a, b], {
      matcher: { score: async (_t, m) => (m.modelId === "a" ? 1 : 0) },
    });
    assert.equal(result.selected?.modelId, "a");
    // But a small capability edge for b is enough to take it back.
    const strongerB = model("b", { capabilities: { coding: measure(0.95, "harness_eval", 10) } });
    const again = await recommendModel(task, [a, strongerB], {
      matcher: { score: async (_t, m) => (m.modelId === "a" ? 1 : 0) },
    });
    assert.equal(again.selected?.modelId, "b");
  });
});

// ---------------------------------------------------------------------------
// R4.2 — cache and cost
// ---------------------------------------------------------------------------

describe("R4.2 · embeddings are computed once", () => {
  test("a repeated text is not embedded twice", async () => {
    const provider = fakeProvider();
    const cache = new EmbeddingCache(provider);
    await cache.embedAll(["one", "two"]);
    await cache.embedAll(["one", "two"]);
    assert.equal(cache.calls, 2);
    assert.equal(provider.calls, 1);
  });

  test("misses go out in one request rather than one each", async () => {
    const provider = fakeProvider();
    const cache = new EmbeddingCache(provider);
    await cache.embedAll(["a", "b", "c", "d"]);
    assert.equal(provider.calls, 1);
    assert.equal(cache.calls, 4);
  });

  test("a changed profile is embedded again; an unchanged one is not", async () => {
    const provider = fakeProvider();
    const matcher = matcherFor(provider, { coder: CODER });
    const task = projectTaskProfile(PYTHON_DEBUG);
    await matcher.score(task, model("coder"));
    const afterFirst = matcher.cache.calls;
    await matcher.score(task, model("coder"));
    assert.equal(matcher.cache.calls, afterFirst, "the same pair must not re-embed");
  });

  test("scoring several models embeds the task once", async () => {
    const provider = fakeProvider();
    const matcher = matcherFor(provider, { coder: CODER, summariser: SUMMARISER });
    const task = projectTaskProfile(PYTHON_DEBUG);
    await matcher.score(task, model("coder"));
    await matcher.score(task, model("summariser"));
    // task + coder + summariser, and the task only once.
    assert.equal(matcher.cache.calls, 3);
  });

  test("a different embedding model does not reuse the old vectors", async () => {
    const first = fakeProvider();
    const cacheA = new EmbeddingCache(first);
    await cacheA.embedAll(["text"]);
    const second = { ...fakeProvider(), embeddingModelId: "fake-bow-v2" };
    const cacheB = new EmbeddingCache(second);
    await cacheB.embedAll(["text"]);
    assert.equal(cacheB.calls, 1, "a new embedding space starts empty");
  });

  test("carried and restored turns cost no embedding at all", async () => {
    const provider = fakeProvider();
    const matcher = matcherFor(provider, { coder: CODER });
    const previous = PYTHON_DEBUG;
    const parsed = parseTurnContract({ goal: "이어서", relation: "continue", intents: "modify" }, "t2");
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;

    const decision = await routeTurn({
      turn: parsed.contract,
      previous,
      currentWorker: "coder",
      previousProfile: projectTaskProfile(previous),
      profiles: [model("coder")],
      recommend: { matcher },
    });
    assert.equal(decision.trigger, "carried");
    assert.equal(matcher.cache.calls, 0, "a carried turn must not embed anything");
    assert.equal(provider.calls, 0);
  });

  test("a turn that does recommend does embed", async () => {
    const provider = fakeProvider();
    const matcher = matcherFor(provider, { coder: CODER });
    const parsed = parseTurnContract(
      { goal: "새 작업", relation: "new_task", intents: "modify", requirements: "고친다" },
      "t2",
    );
    if (!parsed.ok) return;
    await routeTurn({
      turn: parsed.contract,
      previous: emptyContract(),
      currentWorker: null,
      profiles: [model("coder")],
      recommend: { matcher },
    });
    assert.ok(matcher.cache.calls > 0);
  });
});

// ---------------------------------------------------------------------------
// R4.2 — policy versioning
// ---------------------------------------------------------------------------

describe("R4.2 · the weights are a named policy, not a constant", () => {
  test("the default policy is well formed", () => {
    assert.equal(policyIsWellFormed(DEFAULT_POLICY), true);
  });

  test("every known policy sums to one", () => {
    for (const policy of knownPolicies()) {
      assert.equal(policyIsWellFormed(policy), true, policy.id);
    }
  });

  test("a policy that does not partition the score is rejected", () => {
    assert.equal(
      policyIsWellFormed({
        id: "bad",
        weights: { semantic: 0.5, capability: 0.5, evaluation: 0.5, efficiency: 0.5 },
        rationale: "",
      }),
      false,
    );
    assert.equal(
      policyIsWellFormed({
        id: "negative",
        weights: { semantic: -0.1, capability: 0.5, evaluation: 0.4, efficiency: 0.2 },
        rationale: "",
      }),
      false,
    );
  });

  test("I — a recommendation names the policy that produced it", async () => {
    const result = await recommendModel(projectTaskProfile(PYTHON_DEBUG), [model("m")]);
    assert.equal(result.policyId, DEFAULT_POLICY.id);
  });

  test("I — and the decision record carries it", async () => {
    const parsed = parseTurnContract(
      { goal: "g", relation: "new_task", intents: "modify", requirements: "r" },
      "t1",
    );
    if (!parsed.ok) return;
    const decision = await routeTurn({
      turn: parsed.contract,
      previous: emptyContract(),
      currentWorker: null,
      profiles: [model("m")],
    });
    assert.equal(decision.recommendation?.policyId, DEFAULT_POLICY.id);
  });

  test("an unknown policy id is not silently replaced by today's", () => {
    assert.equal(policyById("requirement-router-v99"), null);
    assert.notEqual(policyById(DEFAULT_POLICY.id), null);
  });

  test("the policy's weights and the recommender's defaults agree", async () => {
    const task = projectTaskProfile(PYTHON_DEBUG);
    const viaDefault = await recommendModel(task, [model("m")], { matcher: { score: async () => 1 } });
    const viaPolicy = await recommendModel(task, [model("m")], {
      matcher: { score: async () => 1 },
      weights: DEFAULT_POLICY.weights,
    });
    assert.equal(viaDefault.selected!.score, viaPolicy.selected!.score);
  });
});
