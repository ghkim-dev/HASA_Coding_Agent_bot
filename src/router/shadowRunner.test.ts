import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { emptyContract, mergeContract, parseTurnContract } from "../agent/turnContract.ts";
import { measure, type ModelProfile } from "./modelProfile.ts";
import { routeTurn } from "./routing.ts";
import { projectTaskProfile } from "./taskProfile.ts";
import { ShadowRunner } from "./shadowRunner.ts";
import { EmbeddingError } from "./hasaEmbedding.ts";
import type { EmbeddingProvider } from "./embedding.ts";

/**
 * The wiring, tested by running it.
 *
 * `shadow.test.ts` covers what an observation *is*. This covers what the host
 * does with one, which is the part that was actually broken: for two slices the
 * matcher was never passed to the recommender, and every unit test passed
 * because nothing exercised the connection. A regex over the host source caught
 * it afterwards; this catches it by behaviour.
 */

function contractOf(relation = "new_task", requirements = "오류를 고친다"): ReturnType<typeof parseTurnContract> {
  return parseTurnContract(
    {
      goal: "Python 디버깅",
      relation,
      intents: "modify\nverify",
      ...(requirements.length === 0 ? {} : { requirements }),
    },
    "t1",
  );
}

function model(id: string, coding: number): ModelProfile {
  return {
    modelId: id,
    availability: {
      available: true,
      protocol: "native",
      contextWindow: 128_000,
      maxOutputTokens: 8192,
      supportsNativeTools: true,
    },
    capabilities: { coding: measure(coding, "harness_eval", 30) },
    efficiency: {},
    semanticDescription: id,
    evidence: { evalSampleCount: 30 },
  };
}

const PROFILES = [model("exaone-4.0-32b", 0.9), model("gpt-oss-20b", 0.2)];

/** Counts what the runner actually asked the network for. */
function countingProvider(): EmbeddingProvider & { requests: number; texts: string[] } {
  const provider = {
    embeddingModelId: "counting",
    providerId: "test",
    requests: 0,
    texts: [] as string[],
    async embed(texts: readonly string[]): Promise<number[][]> {
      provider.requests += 1;
      provider.texts.push(...texts);
      return texts.map((t) => [t.length % 7, t.length % 5, 1]);
    },
  };
  return provider;
}

/** The contract the runner projects its task text from. */
const CONTRACT = (() => {
  const parsed = contractOf();
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return mergeContract(emptyContract(), parsed.contract);
})();

function runnerWith(
  provider: EmbeddingProvider & { requests: number; texts: string[] },
  apiKey: string | null = "k",
): { runner: ShadowRunner; built: () => number } {
  let built = 0;
  const runner = new ShadowRunner({
    apiKey: async () => apiKey,
    baseUrl: () => "https://gateway/v1",
    taskContract: () => CONTRACT,
    createProvider: () => {
      built += 1;
      return provider;
    },
  });
  return { runner, built: () => built };
}

async function decisionFor(relation = "new_task"): Promise<Awaited<ReturnType<typeof routeTurn>>> {
  const parsed = contractOf(relation, relation === "continue" ? "" : "오류를 고친다");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return routeTurn({
    turn: parsed.contract,
    previous: relation === "continue" ? CONTRACT : emptyContract(),
    currentWorker: relation === "continue" ? "exaone-4.0-32b" : null,
    ...(relation === "continue"
      ? { previousProfile: projectTaskProfile(CONTRACT) }
      : {}),
    profiles: PROFILES,
  });
}

// ---------------------------------------------------------------------------

describe("R4.0 · the host's shadow wiring, exercised", () => {
  test("a routed turn actually calls the embedding provider", async () => {
    const provider = countingProvider();
    const { runner } = runnerWith(provider);
    const decision = await decisionFor();
    const shadow = await runner.observe(decision, PROFILES);

    assert.notEqual(shadow, null, "the observation must run");
    assert.equal(shadow?.status, "measured");
    assert.ok(provider.requests > 0, "the matcher was never invoked");
  });

  test("the observation sees the candidates production ranked", async () => {
    const provider = countingProvider();
    const { runner } = runnerWith(provider);
    const decision = await decisionFor();
    const shadow = await runner.observe(decision, PROFILES);
    assert.deepEqual(
      shadow?.candidates.map((c) => c.modelId).sort(),
      ["exaone-4.0-32b", "gpt-oss-20b"].sort(),
    );
  });

  test("the provider is built once across turns, not once per turn", async () => {
    const provider = countingProvider();
    const { runner, built } = runnerWith(provider);
    for (let i = 0; i < 4; i += 1) {
      await runner.observe(await decisionFor(), PROFILES);
    }
    assert.equal(built(), 1, "a provider rebuilt per turn has a cache that never hits");
  });

  test("and the cache is shared across turns", async () => {
    const provider = countingProvider();
    const { runner } = runnerWith(provider);
    await runner.observe(await decisionFor(), PROFILES);
    const afterFirst = provider.requests;
    await runner.observe(await decisionFor(), PROFILES);
    assert.equal(
      provider.requests,
      afterFirst,
      "the same task and the same models must not be re-embedded",
    );
  });

  test("resetting the runner starts a new space, as a key change should", async () => {
    const provider = countingProvider();
    const { runner, built } = runnerWith(provider);
    await runner.observe(await decisionFor(), PROFILES);
    runner.reset();
    await runner.observe(await decisionFor(), PROFILES);
    assert.equal(built(), 2);
  });

  test("production's selection is identical with and without the observation", async () => {
    const provider = countingProvider();
    const { runner } = runnerWith(provider);

    const withoutShadow = await decisionFor();
    const withShadow = await decisionFor();
    const shadow = await runner.observe(withShadow, PROFILES);

    assert.equal(withoutShadow.modelId, withShadow.modelId);
    assert.equal(withShadow.modelId, "exaone-4.0-32b");
    assert.deepEqual(
      withoutShadow.recommendation?.selected?.breakdown,
      withShadow.recommendation?.selected?.breakdown,
    );
    assert.notEqual(shadow, null);
  });

  test("a shadow that prefers the other model still leaves production alone", async () => {
    // Vectors chosen so the shadow's order is the reverse of production's.
    const provider: EmbeddingProvider & { requests: number; texts: string[] } = {
      embeddingModelId: "biased",
      providerId: "test",
      requests: 0,
      texts: [],
      async embed(texts) {
        this.requests += 1;
        return texts.map((t) => (t.includes("summar") ? [1, 0] : [0, 1]));
      },
    };
    const { runner } = runnerWith(provider);
    const decision = await decisionFor();
    const before = decision.modelId;
    await runner.observe(decision, PROFILES);
    assert.equal(decision.modelId, before);
    assert.equal(decision.modelId, "exaone-4.0-32b");
  });

  const FAILURES: ReadonlyArray<{ name: string; err: unknown }> = [
    { name: "a timeout", err: new EmbeddingError("TIMEOUT", "slow") },
    { name: "a 500", err: new EmbeddingError("HTTP_ERROR", "boom", 500) },
    { name: "a malformed vector", err: new EmbeddingError("MALFORMED_RESPONSE", "bad") },
    { name: "an unexpected throw", err: new Error("something else entirely") },
  ];

  for (const scenario of FAILURES) {
    test(`${scenario.name} does not end the turn`, async () => {
      const provider: EmbeddingProvider & { requests: number; texts: string[] } = {
        embeddingModelId: "broken",
        requests: 0,
        texts: [],
        async embed() {
          throw scenario.err;
        },
      };
      const { runner } = runnerWith(provider);
      const decision = await decisionFor();
      const shadow = await runner.observe(decision, PROFILES);
      // Whatever came back, the worker is unchanged and nothing threw.
      assert.equal(decision.modelId, "exaone-4.0-32b");
      if (shadow !== null) assert.notEqual(shadow.status, "measured");
    });
  }

  test("no credential means no observation and no crash", async () => {
    const provider = countingProvider();
    const { runner, built } = runnerWith(provider, null);
    const decision = await decisionFor();
    assert.equal(await runner.observe(decision, PROFILES), null);
    assert.equal(built(), 0);
    assert.equal(provider.requests, 0);
    assert.equal(decision.modelId, "exaone-4.0-32b");
  });

  test("a missing credential is not retried on every turn", async () => {
    let asked = 0;
    const runner = new ShadowRunner({
      apiKey: async () => {
        asked += 1;
        return null;
      },
      baseUrl: () => "https://gateway/v1",
      taskContract: () => CONTRACT,
      createProvider: () => countingProvider(),
    });
    await runner.observe(await decisionFor(), PROFILES);
    await runner.observe(await decisionFor(), PROFILES);
    assert.equal(asked, 1);
  });

  test("a carried turn observes nothing and embeds nothing", async () => {
    const provider = countingProvider();
    const { runner, built } = runnerWith(provider);
    const carried = await decisionFor("continue");
    // No recommendation ran, so there is nothing to observe.
    assert.equal(carried.recommendation, undefined);
    assert.equal(await runner.observe(carried, PROFILES), null);
    assert.equal(provider.requests, 0, "a carried turn must cost no embedding");
    assert.equal(built(), 0, "and must not even build a provider");
  });

  test("a manual turn observes nothing and embeds nothing", async () => {
    const provider = countingProvider();
    const { runner } = runnerWith(provider);
    const parsed = contractOf();
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const manual = await routeTurn({
      turn: parsed.contract,
      previous: emptyContract(),
      currentWorker: null,
      profiles: PROFILES,
      userRequestedModel: "chosen-by-hand",
    });
    assert.equal(manual.recommendation, undefined);
    assert.equal(await runner.observe(manual, PROFILES), null);
    assert.equal(provider.requests, 0);
  });

  test("what is sent is the rendered profile, not the user's sentence", async () => {
    const provider = countingProvider();
    const { runner } = runnerWith(provider);
    await runner.observe(await decisionFor(), PROFILES);
    assert.ok(provider.texts.length > 0);
    for (const text of provider.texts) {
      assert.ok(
        /^(Domains|Task types|Languages|Description):/.test(text),
        `unexpected payload: ${text.slice(0, 60)}`,
      );
    }
  });

  test("the runner reports what it spent", async () => {
    const provider = countingProvider();
    const { runner } = runnerWith(provider);
    assert.equal(runner.embeddingCalls, 0);
    await runner.observe(await decisionFor(), PROFILES);
    assert.ok(runner.embeddingCalls > 0);
  });
});
