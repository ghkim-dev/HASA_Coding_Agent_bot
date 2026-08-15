import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { emptyContract, mergeContract, parseTurnContract } from "../agent/turnContract.ts";
import { HasaCatalog } from "../provider/hasa/hasaCatalog.ts";
import { projectTaskProfile, type TaskProfile } from "./taskProfile.ts";
import { measure, type ModelProfile } from "./modelProfile.ts";
import { recommendModel } from "./recommend.ts";
import { EmbeddingCache, embeddingMatcher, type EmbeddingProvider } from "./embedding.ts";
import {
  EmbeddingError,
  createHasaEmbeddingProvider,
  embeddingRefusedBy,
  endpointFor,
  readVectors,
} from "./hasaEmbedding.ts";
import { evaluateShadow, shadowAgrees } from "./shadow.ts";
import {
  coverageReport,
  curatedProfiles,
  historicalProfileFor,
  poolEffectFor,
  profileFingerprint,
  semanticProfileFor,
} from "./modelSemanticCatalog.ts";
import { filterEligible } from "./eligibility.ts";
import { buildRegistry } from "./modelRegistry.ts";
import { unknownCapabilities, type ProviderModel } from "../provider/types.ts";
import type { TaskSemanticProfile } from "./semanticProfile.ts";

/**
 * R4.0: the shadow observes, and cannot do anything else.
 *
 * The claim under test is a negative one, which is the hard kind: that running
 * a real embedding measurement beside the router changes nothing about what the
 * router decides — not when it succeeds, not when it times out, not when the
 * gateway returns nonsense.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function taskOf(constraints: string[] = []): TaskProfile {
  const parsed = parseTurnContract(
    {
      goal: "Python 디버깅",
      relation: "new_task",
      intents: "modify\nverify",
      requirements: "오류를 고친다\n테스트를 실행한다",
      ...(constraints.length === 0 ? {} : { constraints: constraints.join("\n") }),
    },
    "t1",
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return projectTaskProfile(mergeContract(emptyContract(), parsed.contract));
}

const TASK_SEMANTIC: TaskSemanticProfile = {
  taskTypes: ["implementation", "testing"],
  languages: ["ko"],
  description: "Python 오류를 고치고 테스트를 실행한다",
};

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

const CANDIDATES = [
  model("strong", {
    capabilities: { coding: measure(0.9, "harness_eval", 30) },
    evidence: { evalSampleCount: 30 },
  }),
  model("weak", {
    capabilities: { coding: measure(0.2, "harness_eval", 30) },
    evidence: { evalSampleCount: 30 },
  }),
];

/** A provider that records what it was asked to embed. */
function recordingProvider(
  vectors: (text: string) => number[] = () => [1, 0, 0],
): EmbeddingProvider & { sent: string[] } {
  const provider = {
    embeddingModelId: "fake",
    providerId: "test",
    sent: [] as string[],
    async embed(texts: readonly string[]): Promise<number[][]> {
      provider.sent.push(...texts);
      return texts.map(vectors);
    },
  };
  return provider;
}

function matcherOver(provider: EmbeddingProvider): ReturnType<typeof embeddingMatcher> {
  return embeddingMatcher({
    provider,
    lookup: (id) => ({
      modelId: id,
      role: "general_worker",
      domains: ["software engineering"],
      taskTypes: ["implementation"],
      languages: ["en"],
      description: `${id} does code`,
      provenance: {
        origin: "manual",
        evidenceStatus: "provider_documented",
        source: "fixture",
        reviewed: false,
      },
    }),
    taskSemantic: () => TASK_SEMANTIC,
  });
}

async function shadowFor(
  task: TaskProfile,
  matcher: Parameters<typeof evaluateShadow>[0]["matcher"],
): Promise<Awaited<ReturnType<typeof evaluateShadow>>> {
  const recommendation = await recommendModel(task, CANDIDATES);
  return evaluateShadow({
    task,
    taskSemantic: TASK_SEMANTIC,
    recommendation,
    profiles: CANDIDATES,
    matcher,
  });
}

// ---------------------------------------------------------------------------
// The shadow changes nothing
// ---------------------------------------------------------------------------

describe("R4.0 · shadow observes and does not decide", () => {
  test("production picks the same worker with and without a shadow run", async () => {
    const task = taskOf();
    const before = await recommendModel(task, CANDIDATES);
    const shadow = await shadowFor(task, matcherOver(recordingProvider()));
    const after = await recommendModel(task, CANDIDATES);

    assert.equal(before.selected?.modelId, after.selected?.modelId);
    assert.deepEqual(before.selected?.breakdown, after.selected?.breakdown);
    assert.equal(shadow.status, "measured");
  });

  test("a shadow that disagrees still does not move production", async () => {
    // The shadow adores the weak model; production is unmoved.
    const provider = recordingProvider((text) => (text.includes("weak") ? [1, 0] : [0, 1]));
    const task = taskOf();
    const recommendation = await recommendModel(task, CANDIDATES);
    const shadow = await evaluateShadow({
      task,
      taskSemantic: TASK_SEMANTIC,
      recommendation,
      profiles: CANDIDATES,
      matcher: matcherOver(provider),
    });
    assert.equal(recommendation.selected?.modelId, "strong");
    assert.notEqual(shadow.shadowSelectedModelId, null);
    // Whatever the shadow thought, the recommendation is untouched.
    assert.equal(recommendation.selected?.modelId, "strong");
    assert.equal(shadowAgrees(shadow), shadow.shadowSelectedModelId === "strong");
  });

  test("the shadow reports both rankings so a disagreement is visible", async () => {
    const shadow = await shadowFor(taskOf(), matcherOver(recordingProvider()));
    for (const candidate of shadow.candidates) {
      assert.ok(candidate.productionRank >= 1);
      assert.ok(candidate.shadowRank >= 1);
    }
  });

  test("no vectors are kept, only the space they came from", async () => {
    const shadow = await shadowFor(taskOf(), matcherOver(recordingProvider()));
    const serialised = JSON.stringify(shadow);
    assert.ok(!serialised.includes('"embedding"'));
    assert.ok(!serialised.includes('"vector"'));
    assert.deepEqual(Object.keys(shadow.embeddingSpace ?? {}).sort(), [
      "dimension",
      "modelId",
      "provider",
    ]);
  });

  test("it says whether the mapping has been calibrated", async () => {
    const shadow = await shadowFor(taskOf(), matcherOver(recordingProvider()));
    assert.equal(shadow.calibrated, false);
    assert.match(shadow.method ?? "", /uncalibrated/);
  });
});

// ---------------------------------------------------------------------------
// Constraints are checked before anything is sent
// ---------------------------------------------------------------------------

describe("R4.0 · what is never sent, and when nothing is sent at all", () => {
  test("a localOnly task makes no embedding call", async () => {
    const task = { ...taskOf(), constraints: { ...taskOf().constraints, localOnly: true } };
    const provider = recordingProvider();
    const shadow = await shadowFor(task as TaskProfile, matcherOver(provider));
    assert.equal(shadow.status, "refused_by_constraint");
    assert.equal(shadow.failure, "LOCAL_ONLY");
    assert.deepEqual(provider.sent, [], "nothing may leave the machine");
  });

  test("a noExternalNetwork task makes no embedding call", async () => {
    const base = taskOf();
    const task = { ...base, constraints: { ...base.constraints, noExternalNetwork: true } };
    const provider = recordingProvider();
    const shadow = await shadowFor(task as TaskProfile, matcherOver(provider));
    assert.equal(shadow.failure, "NO_EXTERNAL_NETWORK");
    assert.deepEqual(provider.sent, []);
  });

  test("a user who forbade research is not sent to an external service either", async () => {
    const task = taskOf(["no_research: 인터넷 찾아보지 마"]);
    assert.equal(task.constraints.noResearch, true);
    const provider = recordingProvider();
    const shadow = await shadowFor(task, matcherOver(provider));
    assert.equal(shadow.failure, "NO_RESEARCH");
    assert.deepEqual(provider.sent, []);
  });

  test("the refusal is decided before the provider, not inside it", () => {
    const task = taskOf(["no_research: 하지 마"]);
    assert.equal(embeddingRefusedBy(task), "NO_RESEARCH");
    assert.equal(embeddingRefusedBy(taskOf()), null);
  });

  test("the raw prompt is never what gets embedded", async () => {
    const provider = recordingProvider();
    await shadowFor(taskOf(), matcherOver(provider));
    assert.ok(provider.sent.length > 0);
    for (const text of provider.sent) {
      // What goes out is the rendered semantic profile: sectioned, derived,
      // deterministic. The user's own sentence is not in it.
      assert.ok(
        text.startsWith("Task types:") || text.startsWith("Domains:"),
        `unexpected payload: ${text.slice(0, 80)}`,
      );
      assert.ok(!text.includes("Python 디버깅과"), "the goal line is not the payload");
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-open
// ---------------------------------------------------------------------------

describe("R4.0 · every embedding failure is survivable", () => {
  const FAILURES: ReadonlyArray<{ name: string; provider: EmbeddingProvider; failure: string }> = [
    {
      name: "timeout",
      provider: {
        embeddingModelId: "f",
        embed: async () => {
          throw new EmbeddingError("TIMEOUT", "too slow");
        },
      },
      failure: "TIMEOUT",
    },
    {
      name: "a 500",
      provider: {
        embeddingModelId: "f",
        embed: async () => {
          throw new EmbeddingError("HTTP_ERROR", "HTTP 500", 500);
        },
      },
      failure: "HTTP_ERROR",
    },
    {
      name: "a malformed vector",
      provider: {
        embeddingModelId: "f",
        embed: async () => {
          throw new EmbeddingError("MALFORMED_RESPONSE", "no data array");
        },
      },
      failure: "MALFORMED_RESPONSE",
    },
    {
      name: "a dimension mismatch",
      provider: {
        embeddingModelId: "f",
        embed: async () => {
          throw new EmbeddingError("DIMENSION_MISMATCH", "1024 vs 768");
        },
      },
      failure: "DIMENSION_MISMATCH",
    },
    {
      name: "an unauthorised key",
      provider: {
        embeddingModelId: "f",
        embed: async () => {
          throw new EmbeddingError("UNAUTHORIZED", "403", 403);
        },
      },
      failure: "UNAUTHORIZED",
    },
  ];

  for (const scenario of FAILURES) {
    test(`${scenario.name} — the turn still gets its worker`, async () => {
      const task = taskOf();
      const recommendation = await recommendModel(task, CANDIDATES);
      const shadow = await evaluateShadow({
        task,
        taskSemantic: TASK_SEMANTIC,
        recommendation,
        profiles: CANDIDATES,
        matcher: matcherOver(scenario.provider),
      });
      assert.equal(recommendation.selected?.modelId, "strong");
      assert.equal(shadow.status, "provider_failed");
      assert.equal(shadow.failure, scenario.failure);
    });

    test(`${scenario.name} — is recorded machine-readably rather than thrown`, async () => {
      const shadow = await shadowFor(taskOf(), matcherOver(scenario.provider));
      assert.equal(typeof shadow.failure, "string");
      assert.ok((shadow.detail?.length ?? 0) > 0);
      assert.deepEqual(shadow.candidates, []);
    });
  }

  test("no provider at all is reported, not crashed on", async () => {
    const shadow = await shadowFor(taskOf(), null);
    assert.equal(shadow.status, "unavailable");
    assert.equal(shadow.failure, "NO_PROVIDER");
  });
});

// ---------------------------------------------------------------------------
// The real provider
// ---------------------------------------------------------------------------

describe("R4.0 · the gateway's embeddings endpoint", () => {
  test("a base that already ends in /v1 is not given a second one", () => {
    assert.equal(endpointFor("https://x/v1", "/embeddings"), "https://x/v1/embeddings");
    assert.equal(endpointFor("https://x/v1/", "/embeddings"), "https://x/v1/embeddings");
    assert.equal(endpointFor("https://x", "/embeddings"), "https://x/v1/embeddings");
  });

  test("the shape the live gateway actually returned is read", () => {
    // Recorded from a real call on 2026-08-15: 1024 dimensions, two vectors.
    const body = {
      object: "list",
      model: "bge-m3",
      data: [
        { index: 0, embedding: [0.1, 0.2, 0.3] },
        { index: 1, embedding: [0.4, 0.5, 0.6] },
      ],
      usage: { prompt_tokens: 12 },
    };
    assert.deepEqual(readVectors(body, 2), [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
  });

  const BAD: ReadonlyArray<{ name: string; body: unknown; expected: number; failure: string }> = [
    { name: "not an object", body: "nope", expected: 1, failure: "MALFORMED_RESPONSE" },
    { name: "no data array", body: { object: "list" }, expected: 1, failure: "MALFORMED_RESPONSE" },
    { name: "empty data", body: { data: [] }, expected: 1, failure: "EMPTY_RESPONSE" },
    {
      name: "fewer vectors than asked for",
      body: { data: [{ embedding: [1] }] },
      expected: 2,
      failure: "MALFORMED_RESPONSE",
    },
    {
      name: "an entry with no embedding",
      body: { data: [{ index: 0 }] },
      expected: 1,
      failure: "MALFORMED_RESPONSE",
    },
    {
      name: "a vector containing a non-number",
      body: { data: [{ embedding: [1, "two"] }] },
      expected: 1,
      failure: "MALFORMED_RESPONSE",
    },
    {
      name: "vectors of different lengths",
      body: { data: [{ embedding: [1, 2] }, { embedding: [1, 2, 3] }] },
      expected: 2,
      failure: "DIMENSION_MISMATCH",
    },
  ];

  for (const scenario of BAD) {
    test(`${scenario.name} is refused as ${scenario.failure}`, () => {
      assert.throws(
        () => readVectors(scenario.body, scenario.expected),
        (err: unknown) => err instanceof EmbeddingError && err.failure === scenario.failure,
      );
    });
  }

  test("a 404 names the URL, because the one that happened was a doubled /v1", async () => {
    const provider = createHasaEmbeddingProvider({
      apiKey: "k",
      baseUrl: "https://x/v1",
      fetchImpl: async () => new Response("{}", { status: 404 }),
    });
    await assert.rejects(
      provider.embed(["t"]),
      (err: unknown) => err instanceof EmbeddingError && err.failure === "MODEL_UNAVAILABLE",
    );
  });

  test("a rejected key is told apart from a missing model", async () => {
    const provider = createHasaEmbeddingProvider({
      apiKey: "k",
      baseUrl: "https://x/v1",
      fetchImpl: async () => new Response("{}", { status: 403 }),
    });
    await assert.rejects(
      provider.embed(["t"]),
      (err: unknown) => err instanceof EmbeddingError && err.failure === "UNAUTHORIZED",
    );
  });

  test("the whole batch goes in one request", async () => {
    let requests = 0;
    const provider = createHasaEmbeddingProvider({
      apiKey: "k",
      baseUrl: "https://x/v1",
      fetchImpl: async (_url, init) => {
        requests += 1;
        const body = JSON.parse(String((init as RequestInit).body)) as { input: string[] };
        return new Response(
          JSON.stringify({ data: body.input.map(() => ({ embedding: [1, 2, 3] })) }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const vectors = await provider.embed(["a", "b", "c"]);
    assert.equal(requests, 1);
    assert.equal(vectors.length, 3);
  });

  test("an empty batch costs no request", async () => {
    let requests = 0;
    const provider = createHasaEmbeddingProvider({
      apiKey: "k",
      baseUrl: "https://x/v1",
      fetchImpl: async () => {
        requests += 1;
        return new Response("{}", { status: 200 });
      },
    });
    assert.deepEqual(await provider.embed([]), []);
    assert.equal(requests, 0);
  });

  test("the key is sent as a bearer token and the model is named", async () => {
    let seen: { auth?: string; model?: string } = {};
    const provider = createHasaEmbeddingProvider({
      apiKey: "secret-key",
      baseUrl: "https://x/v1",
      fetchImpl: async (_url, init) => {
        const headers = new Headers((init as RequestInit).headers);
        seen = {
          auth: headers.get("authorization") ?? undefined,
          model: JSON.parse(String((init as RequestInit).body)).model,
        };
        return new Response(JSON.stringify({ data: [{ embedding: [1] }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await provider.embed(["t"]);
    assert.equal(seen.auth, "Bearer secret-key");
    assert.equal(seen.model, "bge-m3");
  });
});

// ---------------------------------------------------------------------------
// Catalog freshness
// ---------------------------------------------------------------------------

describe("R4.0 · the catalogue does not go stale for a process lifetime", () => {
  const rows = [{ name: "m", modality: "text", status: "available", callable: true }];

  test("a second read inside the TTL makes no request", async () => {
    let calls = 0;
    const catalog = new HasaCatalog(
      {
        fetchJson: async () => {
          calls += 1;
          return rows;
        },
      },
      { ttlMs: 1000, now: () => 0 },
    );
    await catalog.all();
    await catalog.all();
    assert.equal(calls, 1);
  });

  test("a read after the TTL fetches again", async () => {
    let calls = 0;
    let clock = 0;
    const catalog = new HasaCatalog(
      {
        fetchJson: async () => {
          calls += 1;
          return rows;
        },
      },
      { ttlMs: 1000, now: () => clock },
    );
    await catalog.all();
    clock = 1001;
    await catalog.all();
    assert.equal(calls, 2, "a stale catalogue must be re-read");
  });

  test("a failure is not cached for the rest of the process", async () => {
    let calls = 0;
    const catalog = new HasaCatalog(
      {
        fetchJson: async () => {
          calls += 1;
          if (calls === 1) throw new Error("gateway down");
          return rows;
        },
      },
      { ttlMs: 60_000, now: () => 0 },
    );
    assert.deepEqual(await catalog.all(), []);
    const recovered = await catalog.all();
    assert.equal(recovered.length, 1, "one bad minute must not empty the picker forever");
  });

  test("invalidate forces a re-read", async () => {
    let calls = 0;
    const catalog = new HasaCatalog(
      {
        fetchJson: async () => {
          calls += 1;
          return rows;
        },
      },
      { ttlMs: 60_000, now: () => 0 },
    );
    await catalog.all();
    catalog.invalidate();
    await catalog.all();
    assert.equal(calls, 2);
  });

  test("a response that arrives after an invalidation does not become the answer", async () => {
    let release: ((value: unknown) => void) | null = null;
    let calls = 0;
    const catalog = new HasaCatalog(
      {
        fetchJson: async () => {
          calls += 1;
          if (calls === 1) {
            return new Promise((resolve) => {
              release = resolve;
            });
          }
          return [{ name: "new-key-model", modality: "text", status: "available" }];
        },
      },
      { ttlMs: 60_000, now: () => 0 },
    );

    const inFlight = catalog.all();
    catalog.invalidate(); // the key changed while the first request was open
    (release as ((v: unknown) => void) | null)?.([{ name: "old-key-model", modality: "text", status: "available" }]);
    const result = await inFlight;

    assert.deepEqual(
      result.map((e) => e.id),
      ["new-key-model"],
      "the answer for the old key must not be installed for the new one",
    );
  });

  test("concurrent lookups still make one request", async () => {
    let calls = 0;
    const catalog = new HasaCatalog(
      {
        fetchJson: async () => {
          calls += 1;
          return rows;
        },
      },
      { ttlMs: 60_000, now: () => 0 },
    );
    await Promise.all([catalog.all(), catalog.all(), catalog.modalityOf("m")]);
    assert.equal(calls, 1);
  });
});

// ---------------------------------------------------------------------------
// The wiring itself
// ---------------------------------------------------------------------------

/**
 * Read as text, because the alternative is not to check it at all.
 *
 * `AgentHost` cannot be instantiated outside a VS Code extension host, and the
 * failure being guarded is precisely that the matcher is never passed — which
 * is what was actually true for the whole of R4.1 and R4.2 while every unit
 * test passed. A structural assertion is weaker than a behavioural one and much
 * stronger than the nothing that was there before. `extensionBoundary.test.ts`
 * checks the same class the same way for the same reason.
 */
describe("R4.0 · the shadow is actually wired into the product", () => {
  const HOST = readFileSync(
    new URL("../../extension/src/agent/agentHost.ts", import.meta.url),
    "utf8",
  );

  test("the host delegates to the runner rather than reimplementing it", () => {
    // The behaviour is tested in `shadowRunner.test.ts` by running it. What is
    // left to check here is that the host reaches that code at all — the one
    // thing a behavioural test of the runner cannot tell us.
    assert.match(HOST, /new ShadowRunner\(/, "no runner is constructed");
    assert.match(HOST, /\.observe\(decision/, "the observation is never called");
  });

  test("the runner is held on the host, not built per turn", () => {
    assert.match(HOST, /private shadowRunner:/, "the runner is not held");
    assert.match(HOST, /this\.shadowRunner \?\?= new ShadowRunner\(/, "the held runner is not reused");
  });

  test("the observation is called from the routing path", () => {
    assert.match(HOST, /observeShadow\(decision, signal\)/, "the observation is never reached");
  });

  test("the observation is passed to the recorded decision", () => {
    assert.match(HOST, /shadow/, "the observation is never recorded");
  });

  test("nothing in the host feeds a shadow score back into the decision", () => {
    // `decision` is settled before `observeShadow` is called, and the result is
    // only ever put into the event. If this stops being true the ordering below
    // is the first thing to look at.
    const routeBody = /const shadow =[\s\S]*?routingEvent\(\{/.exec(HOST)?.[0] ?? "";
    assert.ok(routeBody.length > 0, "the shadow call site moved");
    assert.ok(
      // A single `=`, not the first character of `===`. The comparison
      // `decision.recommendation === undefined` is a read, not a write.
      !/decision\.(modelId|recommendation)\s*=(?!=)/.test(routeBody),
      "the decision must not be reassigned after the shadow runs",
    );
  });
});

// ---------------------------------------------------------------------------
// Roles, pools, coverage and history
// ---------------------------------------------------------------------------

describe("R4.0 · role, pool and provenance", () => {
  const providerModel = (id: string): ProviderModel => ({
    id,
    ownedBy: null,
    capabilities: { ...unknownCapabilities(), chat: true, toolCalling: true },
    limits: { maxOutputTokens: 4096, contextWindow: 128_000 },
  });

  test("a vision model is a worker, and not a coding-pool candidate", () => {
    const profile = semanticProfileFor("qwen2.5-vl-72b").profile;
    assert.equal(profile?.role, "vision_worker");
    assert.equal(poolEffectFor("qwen2.5-vl-72b", "coding").excluded, true);
    assert.equal(poolEffectFor("qwen2.5-vl-72b", "vision").excluded, false);
  });

  test("an OCR model is the same shape", () => {
    assert.equal(semanticProfileFor("paddleocr-vl").profile?.role, "ocr_worker");
    assert.equal(poolEffectFor("paddleocr-vl", "coding").excluded, true);
    assert.equal(poolEffectFor("paddleocr-vl", "vision").excluded, false);
  });

  test("a pool-scoped exclusion does not reach another pool", () => {
    const registry = buildRegistry([providerModel("qwen2.5-vl-72b")], [], { pool: "vision" });
    const { eligible } = filterEligible(registry, taskOf());
    assert.equal(eligible.length, 1, "the vision pool keeps its vision model");
  });

  test("an assertion advises and never excludes", () => {
    const effect = poolEffectFor("nemotron-safety-4b", "coding");
    assert.equal(effect.evidence, "manual_assertion");
    assert.equal(effect.effect, "advisory");
    assert.equal(effect.excluded, false);
    const registry = buildRegistry([providerModel("nemotron-safety-4b")]);
    const result = filterEligible(registry, taskOf());
    assert.equal(result.eligible.length, 1);
    assert.equal(result.advisories.length, 1);
  });

  test("a measurement excludes", () => {
    assert.equal(poolEffectFor("bge-m3", "coding").evidence, "invocation_verified");
    assert.equal(poolEffectFor("bge-m3", "coding").excluded, true);
  });

  test("coverage names its denominator, and the populations do not mix", () => {
    const report = coverageReport({
      liveCatalog: ["exaone-4.0-32b", "bge-m3", "brand-new"],
      chatCapable: ["exaone-4.0-32b", "brand-new"],
      embedding: ["bge-m3"],
    });
    assert.equal(report.liveCatalog.total, 3);
    assert.equal(report.chatCapable.total, 2);
    assert.equal(report.embedding.total, 1);
    // The embedding model is not counted as an uncurated coding candidate.
    assert.ok(!report.chatCapable.coldStart.includes("bge-m3"));
    assert.ok(!report.codingPool.coldStart.includes("bge-m3"));
    assert.deepEqual(report.chatCapable.coldStart, ["brand-new"]);
  });

  test("the coding pool's denominator excludes what is not a candidate for it", () => {
    const report = coverageReport({
      liveCatalog: ["exaone-4.0-32b", "qwen2.5-vl-72b"],
      chatCapable: ["exaone-4.0-32b", "qwen2.5-vl-72b"],
      embedding: [],
    });
    assert.equal(report.chatCapable.total, 2);
    assert.equal(report.codingPool.total, 1, "a vision model is not coding-pool work to curate");
    assert.ok(report.chatCapable.ineligible.includes("qwen2.5-vl-72b"));
  });

  test("an obsolete profile explains a past decision and never returns as a candidate", () => {
    // Withdrawn from the gateway, still readable.
    assert.equal(semanticProfileFor("qwen2.5-coder-32b").profile, null, "not a live candidate");
    const historical = historicalProfileFor("qwen2.5-coder-32b");
    assert.notEqual(historical, null);
    assert.equal(historical?.obsolete, true);
    assert.equal(historical?.profile.role, "coding_worker");
  });

  test("a stored fingerprint links a decision to the profile it was made against", () => {
    const historical = historicalProfileFor("qwen2.5-coder-32b")!;
    const recorded = profileFingerprint(historical.profile);
    assert.equal(historicalProfileFor("qwen2.5-coder-32b", recorded)?.fingerprintMatches, true);
    assert.equal(historicalProfileFor("qwen2.5-coder-32b", "tpf-somethingelse")?.fingerprintMatches, false);
  });

  test("a live profile is reachable the same way, and says it is not obsolete", () => {
    const historical = historicalProfileFor("exaone-4.0-32b");
    assert.equal(historical?.obsolete, false);
  });

  test("an obsolete model is never eligible, because it is never in the registry", () => {
    const registry = buildRegistry([providerModel("qwen2.5-coder-32b")]);
    // It has no live profile, so it is a cold start rather than a curated
    // coding worker — the registry is built from what the gateway offers.
    assert.equal(registry[0]!.intendedUse, undefined);
  });

  test("every curated entry states an evidence status", () => {
    for (const profile of curatedProfiles()) {
      assert.ok(
        ["invocation_verified", "provider_documented", "manual_assertion"].includes(
          profile.provenance.evidenceStatus,
        ),
        profile.modelId,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

describe("R4.0 · the shadow costs nothing when nothing is chosen", () => {
  test("a cache is reused across observations rather than rebuilt", async () => {
    const provider = recordingProvider();
    const cache = new EmbeddingCache(provider);
    const matcher = embeddingMatcher({
      provider,
      cache,
      lookup: (id) => ({
        modelId: id,
        role: "general_worker",
        domains: ["software engineering"],
        taskTypes: ["implementation"],
        languages: ["en"],
        description: `${id} does code`,
        provenance: {
          origin: "manual",
          evidenceStatus: "provider_documented",
          source: "fixture",
          reviewed: false,
        },
      }),
      taskSemantic: () => TASK_SEMANTIC,
    });
    const task = taskOf();
    const first = await recommendModel(task, CANDIDATES);
    await evaluateShadow({ task, taskSemantic: TASK_SEMANTIC, recommendation: first, profiles: CANDIDATES, matcher });
    const after = cache.calls;
    await evaluateShadow({ task, taskSemantic: TASK_SEMANTIC, recommendation: first, profiles: CANDIDATES, matcher });
    assert.equal(cache.calls, after, "a second observation of the same pair re-embeds nothing");
  });

  test("the observation reports what it spent", async () => {
    const shadow = await shadowFor(taskOf(), matcherOver(recordingProvider()));
    assert.ok(shadow.embeddingCalls > 0);
  });

  test("a refused observation spends nothing", async () => {
    const base = taskOf();
    const task = { ...base, constraints: { ...base.constraints, localOnly: true } };
    const shadow = await shadowFor(task as TaskProfile, matcherOver(recordingProvider()));
    assert.equal(shadow.embeddingCalls, 0);
  });
});
