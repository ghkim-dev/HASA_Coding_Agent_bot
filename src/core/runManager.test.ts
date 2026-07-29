import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateRunRequestSchema, type ArenaEvent, type RunResult } from "../protocol/index.ts";
import { HasaClient } from "../hasa-client/client.ts";
import { nullLogger } from "../hasa-client/logger.ts";
import { clearSecrets } from "../hasa-client/redact.ts";
import { startMockHasa, type MockHasaServer } from "../testing/mock-hasa.ts";
import { EventHub } from "./events.ts";
import { Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";
import { RunManager } from "./runManager.ts";
import { FairnessError } from "./fairness.ts";

let mock: MockHasaServer;
let store: Store;
let hub: EventHub;

before(async () => {
  mock = await startMockHasa({
    models: [
      { id: "cand/alpha", cannedReply: "ALPHA response from the first system" },
      { id: "cand/beta", cannedReply: "BETA response from the second system" },
      { id: "cand/same-1", cannedReply: "identical text" },
      { id: "cand/same-2", cannedReply: "identical text" },
      { id: "cand/empty", cannedReply: "" },
      { id: "cand/forbidden", behavior: "forbidden" },
      { id: "cand/self-naming", cannedReply: "As cand/self-naming I say ALPHA" },
      { id: "judge/content", judgePrefers: "ALPHA" },
      { id: "judge/biased", judgeAlwaysPicksSlot: 1 },
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

function request(models: string[], judgeModel: string): ReturnType<typeof CreateRunRequestSchema.parse> {
  return CreateRunRequestSchema.parse({
    mode: "response",
    taskSpec: { prompt: "Summarise the tradeoffs." },
    candidates: models.map((modelId) => ({ modelId })),
    judge: { modelId: judgeModel },
  });
}

async function runToCompletion(models: string[], judgeModel: string): Promise<{ runId: string; result: RunResult; events: ArenaEvent[]; runs: RunManager }> {
  const runs = manager();
  const runId = runs.create(request(models, judgeModel));
  const events: ArenaEvent[] = [];
  hub.forRun(runId).subscribe((e) => events.push(e));
  await runs.waitFor(runId);
  const row = store.getRun(runId);
  assert.ok(row?.result, "run finished without a result");
  return { runId, result: JSON.parse(row.result) as RunResult, events, runs };
}

describe("RunManager — response compare", () => {
  test("a content-driven judge produces a stable winner", async () => {
    const { result } = await runToCompletion(["cand/alpha", "cand/beta"], "judge/content");
    assert.equal(result.outcome, "winner");
    assert.equal(result.winnerLabel, "cand-a", "cand-a is the ALPHA model the judge prefers");
    assert.equal(result.confidence, "judge");
  });

  test("a position-biased judge yields no_winner instead of a coin flip", async () => {
    const { result } = await runToCompletion(["cand/alpha", "cand/beta"], "judge/biased");
    assert.equal(result.outcome, "no_winner");
    assert.match(result.reason, /judge 불안정/);
    assert.equal(result.requiresHumanReview, true);
  });

  test("indistinguishable answers end in no_winner, not an arbitrary pick", async () => {
    const { result } = await runToCompletion(["cand/same-1", "cand/same-2"], "judge/content");
    assert.equal(result.outcome, "no_winner");
    assert.match(result.reason, /동률/);
  });

  test("a 403 candidate is excluded and the survivor needs human review", async () => {
    const { runId, result, runs } = await runToCompletion(["cand/alpha", "cand/forbidden"], "judge/content");
    const view = runs.candidateView(runId);
    const denied = view.find((c) => c["modelId"] === "cand/forbidden");
    assert.equal(denied?.["status"], "excluded");
    assert.equal(denied?.["excludedReason"], "403");
    assert.equal(result.outcome, "winner");
    assert.equal(result.confidence, "sole_survivor");
    assert.equal(result.requiresHumanReview, true);
  });

  test("an empty response is a failure, not a submission", async () => {
    const { runId, result, runs } = await runToCompletion(["cand/empty", "cand/beta"], "judge/content");
    const empty = runs.candidateView(runId).find((c) => c["modelId"] === "cand/empty");
    assert.equal(empty?.["status"], "failed");
    assert.equal(empty?.["errorCode"], "empty_response");
    assert.equal(result.confidence, "sole_survivor");
  });

  test("when every candidate fails the run reports no_winner with per-candidate causes", async () => {
    const { result } = await runToCompletion(["cand/empty", "cand/forbidden"], "judge/content");
    assert.equal(result.outcome, "no_winner");
    assert.match(result.reason, /모든 후보가 기준 미달/);
    assert.match(result.reason, /cand-a/);
  });

  test("a self-naming model is anonymised before judging", async () => {
    // The run must complete rather than trip the anonymity assertion, which
    // proves the scrub happened before the leak check.
    const { result } = await runToCompletion(["cand/self-naming", "cand/beta"], "judge/content");
    assert.equal(result.outcome, "winner");
  });

  test("emits the full status lifecycle", async () => {
    const { events } = await runToCompletion(["cand/alpha", "cand/beta"], "judge/content");
    const statuses = events.filter((e) => e.type === "run.status").map((e) => e.status);
    assert.deepEqual(statuses, ["queued", "running", "evaluating", "completed"]);

    const candidateStatuses = events.filter((e) => e.type === "candidate.status");
    assert.ok(candidateStatuses.some((e) => e.status === "running"));
    assert.ok(candidateStatuses.some((e) => e.status === "completed"));
    assert.ok(events.some((e) => e.type === "judge.progress" && e.order === "AB"));
    assert.ok(events.some((e) => e.type === "judge.progress" && e.order === "BA"));
    assert.ok(events.some((e) => e.type === "run.result"));
  });

  test("records both presentation orders for every judged pair", async () => {
    const { runId } = await runToCompletion(["cand/alpha", "cand/beta"], "judge/content");
    const verdicts = store.listVerdicts(runId);
    assert.equal(verdicts.length, 2);
    assert.deepEqual(verdicts.map((v) => v.presentationOrder).sort(), ["AB", "BA"]);
  });

  test("no event carries the api key", async () => {
    const { events } = await runToCompletion(["cand/alpha", "cand/beta"], "judge/content");
    const serialised = JSON.stringify(events);
    assert.ok(!serialised.includes(mock.apiKey));
  });

  test("an unfair configuration is rejected before anything is persisted", () => {
    const runs = manager();
    assert.throws(
      () => runs.create(request(["cand/alpha", "cand/alpha"], "judge/content")),
      FairnessError,
    );
    assert.equal(store.listRuns().length, 0);
  });

  test("candidate labels are assigned in declaration order regardless of execution order", async () => {
    const { runId, runs } = await runToCompletion(["cand/alpha", "cand/beta"], "judge/content");
    const view = runs.candidateView(runId);
    assert.equal(view.find((c) => c["label"] === "cand-a")?.["modelId"], "cand/alpha");
    assert.equal(view.find((c) => c["label"] === "cand-b")?.["modelId"], "cand/beta");
  });
});

describe("RunManager — durable record", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arena-run-"));
    store = await Store.open({ dbPath: join(dir, "arena.db"), artifactRoot: dir, logger: nullLogger });
    hub = new EventHub();
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function jsonlLines(relativePath: string): Promise<Array<Record<string, unknown>>> {
    const text = await readFile(join(dir, relativePath), "utf8");
    return text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  test("writes the whole run to JSONL as well as SQLite", async () => {
    const runs = manager();
    const runId = runs.create(request(["cand/alpha", "cand/beta"], "judge/content"));
    await runs.waitFor(runId);

    const lines = await jsonlLines(`runs/${runId}/run.jsonl`);
    const types = lines.map((l) => l["type"]);
    assert.deepEqual(types, ["run", "candidate", "candidate", "verdict", "verdict", "result"]);

    const candidates = lines.filter((l) => l["type"] === "candidate");
    assert.ok(candidates.every((c) => String(c["responseText"] ?? "").length > 0));

    const verdicts = lines.filter((l) => l["type"] === "verdict");
    assert.deepEqual(verdicts.map((v) => v["presentationOrder"]).sort(), ["AB", "BA"]);

    const result = lines.at(-1);
    assert.equal(result?.["outcome"], "winner");
    assert.equal(result?.["winnerLabel"], "cand-a");
  });

  test("appends one index line per run to a flat runs.jsonl", async () => {
    const runs = manager();
    const first = runs.create(request(["cand/alpha", "cand/beta"], "judge/content"));
    await runs.waitFor(first);
    const second = runs.create(request(["cand/same-1", "cand/same-2"], "judge/content"));
    await runs.waitFor(second);

    const index = await jsonlLines("runs.jsonl");
    assert.equal(index.length, 2);
    assert.deepEqual(index.map((l) => l["outcome"]), ["winner", "no_winner"]);
  });

  test("the JSONL record contains no api key", async () => {
    const runs = manager();
    const runId = runs.create(request(["cand/alpha", "cand/beta"], "judge/content"));
    await runs.waitFor(runId);
    const raw = await readFile(join(dir, `runs/${runId}/run.jsonl`), "utf8");
    assert.ok(!raw.includes(mock.apiKey));
  });

  test("the event trail is persisted separately from the result record", async () => {
    const runs = manager();
    const runId = runs.create(request(["cand/alpha", "cand/beta"], "judge/content"));
    await runs.waitFor(runId);
    const events = await jsonlLines(`runs/${runId}/events.jsonl`);
    assert.ok(events.some((e) => e["type"] === "run.status" && e["status"] === "queued"));
    assert.ok(events.some((e) => e["type"] === "run.result"));
  });
});
