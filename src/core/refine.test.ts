import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CreateRunRequestSchema, type RunResult } from "../protocol/index.ts";
import { HasaClient } from "../hasa-client/client.ts";
import { nullLogger } from "../hasa-client/logger.ts";
import { clearSecrets } from "../hasa-client/redact.ts";
import { startMockHasa, type MockHasaServer } from "../testing/mock-hasa.ts";
import { EventHub } from "./events.ts";
import { Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";
import { RunManager } from "./runManager.ts";
import { RoleCollision, assertDistinctRoles, neighbourMessages } from "./refine.ts";
import { FairnessError, assertComparable } from "./fairness.ts";

let mock: MockHasaServer;
let store: Store;
let hub: EventHub;

before(async () => {
  mock = await startMockHasa({
    models: [
      // Its revision contains the marker the judge wants; its draft does not.
      { id: "cand/improvable", cannedReply: "DRAFT answer", refinedReply: "IMPROVED answer" },
      // Its revision changes without getting better, which is the common case
      // and the one the incumbent rule exists for.
      { id: "cand/stubborn", cannedReply: "PLAIN answer", refinedReply: "DIFFERENT answer" },
      { id: "cand/weak", cannedReply: "weak answer", refinedReply: "weak answer" },
      // Ranks the revision above the draft and the draft above a rival, so one
      // judge can settle both round 0 and round 1.
      { id: "judge/wants-improved", judgeRanks: ["IMPROVED", "DRAFT"] },
      { id: "judge/wants-plain", judgePrefers: "PLAIN" },
      { id: "critic/finds-one", criticDefects: ["3절의 주장에 근거가 없다"], criticSatisfiedBy: "IMPROVED" },
      { id: "critic/broken", criticGarbage: true },
    ],
  });
});

after(async () => {
  await mock.close();
  clearSecrets();
});

beforeEach(async () => {
  store = await Store.open({ dbPath: ":memory:", artifactRoot: null, logger: nullLogger });
  hub = new EventHub();
});

function manager(): RunManager {
  return new RunManager({
    client: new HasaClient({
      apiKey: mock.apiKey,
      baseUrl: mock.url,
      logger: nullLogger,
      maxRetries: 0,
      sleep: async () => {},
    }),
    scheduler: new Scheduler({ globalLimit: 4, perModelLimit: 2, logger: nullLogger }),
    store,
    hub,
    logger: nullLogger,
    random: () => 0.5,
  });
}

async function run(
  models: string[],
  judgeModel: string,
  refine: Record<string, unknown> | undefined,
): Promise<{ runId: string; result: RunResult; runs: RunManager }> {
  const runs = manager();
  const runId = runs.create(
    CreateRunRequestSchema.parse({
      mode: "response",
      taskSpec: { prompt: "Explain the tradeoffs." },
      candidates: models.map((modelId) => ({ modelId })),
      judge: { modelId: judgeModel },
      ...(refine ? { refine } : {}),
    }),
  );
  await runs.waitFor(runId);
  return { runId, result: JSON.parse(store.getRun(runId)?.result ?? "{}") as RunResult, runs };
}

describe("refinement loop", () => {
  test("a neighbour that wins replaces the incumbent", async () => {
    const { runId, result } = await run(["cand/improvable", "cand/weak"], "judge/wants-improved", {
      criticModelId: "critic/finds-one",
      maxRounds: 2,
    });

    assert.equal(result.outcome, "winner");
    assert.equal(result.winnerLabel, "cand-a~r1", "the revision should have taken the title");
    assert.equal(result.rounds[0]?.replaced, true);
    assert.deepEqual(result.rounds[0]?.defects, ["3절의 주장에 근거가 없다"]);

    // The neighbour is recorded as derived from its parent, not as a fresh
    // contestant — otherwise a later reader cannot tell a search from a field
    // of five independent models.
    const neighbour = store.listCandidates(runId).find((c) => c.label === "cand-a~r1");
    assert.equal(neighbour?.origin, "refinement");
    assert.equal(neighbour?.round, 1);
    assert.equal(neighbour?.parentCandidateId, `${runId}-cand-a`);
    assert.equal(neighbour?.modelId, "cand/improvable", "a neighbour must come from the same model");
  });

  test("a neighbour that does not win leaves the incumbent standing", async () => {
    // The monotonicity guarantee. Refinement loops routinely produce something
    // different rather than something better, and a loop that keeps the last
    // attempt ships regressions quietly. This one has to keep the champion.
    const { result } = await run(["cand/stubborn", "cand/weak"], "judge/wants-plain", {
      criticModelId: "critic/finds-one",
      maxRounds: 2,
    });

    assert.equal(result.winnerLabel, "cand-a", "the original answer must survive a losing revision");
    assert.equal(result.rounds.length, 1, "a lost round ends the search");
    assert.equal(result.rounds[0]?.replaced, false);
    assert.equal(result.convergedBy, "neighbour_not_better");
  });

  test("a critic with nothing to say ends the search, and says so", async () => {
    // Two rounds requested, but the critic returns defects only once. Round 2
    // must stop on "nothing to fix" rather than manufacture work.
    const { result } = await run(["cand/improvable", "cand/weak"], "judge/wants-improved", {
      criticModelId: "critic/finds-one",
      maxRounds: 3,
    });
    assert.equal(result.convergedBy, "no_defects_found");
    assert.equal(result.rounds.length, 1);
  });

  test("a broken critic is not reported as a satisfied one", async () => {
    // Both produce zero defects, and treating them alike would credit the run
    // with a check it never performed.
    const { result } = await run(["cand/improvable", "cand/weak"], "judge/wants-improved", {
      criticModelId: "critic/broken",
      maxRounds: 2,
    });
    assert.equal(result.convergedBy, "critic_unavailable");
    assert.equal(result.rounds.length, 0);
    assert.equal(result.winnerLabel, "cand-a", "a broken critic must not change the outcome");
  });

  test("without a refine config the run is a plain tournament", async () => {
    const { result } = await run(["cand/improvable", "cand/weak"], "judge/wants-improved", undefined);
    assert.deepEqual(result.rounds, []);
    assert.equal(result.convergedBy, null);
    assert.equal(result.winnerLabel, "cand-a");
  });

  test("the critic may not be the judge, and may not be a contestant", async () => {
    // Critic-as-judge optimises the scorer; critic-as-candidate reviews its own
    // work or its rival's. Both are refused before the run starts, where the
    // refusal still costs nothing.
    assert.throws(
      () => assertDistinctRoles("m/x", "m/x", ["m/a", "m/b"]),
      (err: unknown) => err instanceof RoleCollision && /judge/.test(err.message),
    );
    assert.throws(
      () => assertDistinctRoles("m/a", "m/j", ["m/a", "m/b"]),
      (err: unknown) => err instanceof RoleCollision && /후보/.test(err.message),
    );
    assert.doesNotThrow(() => assertDistinctRoles("m/c", "m/j", ["m/a", "m/b"]));
  });

  test("a run whose critic collides is refused, not silently degraded", async () => {
    const runs = manager();
    assert.throws(
      () =>
        runs.create(
          CreateRunRequestSchema.parse({
            mode: "response",
            taskSpec: { prompt: "Explain the tradeoffs." },
            candidates: [{ modelId: "cand/improvable" }, { modelId: "cand/weak" }],
            judge: { modelId: "judge/wants-improved" },
            refine: { criticModelId: "judge/wants-improved", maxRounds: 1 },
          }),
        ),
      RoleCollision,
    );
  });

  test("the neighbour prompt restates the task and names only the defects found", () => {
    const messages = neighbourMessages(
      { prompt: "Explain X.", systemPromptVersion: "v1", checks: [] },
      "previous attempt",
      ["결함 하나"],
    );
    const user = messages.at(-1)?.content;
    assert.match(String(user), /Explain X\./, "the neighbour answers the task, it does not merely edit");
    assert.match(String(user), /결함 하나/);
    assert.match(String(user), /지적되지 않은 부분까지 바꾸지 마라/);
  });
});

describe("assertComparable", () => {
  const side = (modelId: string) => ({
    modelId,
    temperature: 0.2,
    topP: 1,
    maxOutputTokens: 2048,
    systemPromptVersion: "v1",
  });

  test("a model comparison needs different models; a refinement needs the same one", () => {
    // The two kinds ask different questions, so the same pair cannot be valid
    // for both. Applying the run-level rule to a refinement round would make
    // the loop unexpressible; applying the refinement rule to a model
    // comparison would compare a model with itself.
    assert.doesNotThrow(() => assertComparable(side("m/a"), side("m/b"), "model"));
    assert.throws(() => assertComparable(side("m/a"), side("m/a"), "model"), FairnessError);

    assert.doesNotThrow(() => assertComparable(side("m/a"), side("m/a"), "refinement"));
    assert.throws(() => assertComparable(side("m/a"), side("m/b"), "refinement"), FairnessError);
  });

  test("sampling must match either way", () => {
    const hotter = { ...side("m/a"), temperature: 0.9 };
    assert.throws(() => assertComparable(side("m/a"), hotter, "refinement"), FairnessError);
    assert.throws(() => assertComparable(side("m/b"), hotter, "model"), FairnessError);
  });
});
