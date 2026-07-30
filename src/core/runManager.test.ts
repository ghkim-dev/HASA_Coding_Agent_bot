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
      // Never emits parseable JSON, however many times it is asked.
      { id: "judge/prose", judgePrefers: "ALPHA", judgeGarbageTimes: 99 },
      // Wrong on its first reading, consistent afterwards: S1 sees a
      // contradiction, S2 finds out it was one bad draw.
      { id: "judge/noisy", judgePrefers: "ALPHA", judgeContrarianCalls: 1 },
      { id: "judge/second-opinion", judgePrefers: "ALPHA" },
      // Position-biased when asked to prefer, but able to name a checkable
      // difference when asked for one instead.
      { id: "judge/biased-but-honest", judgeAlwaysPicksSlot: 1, probeMarker: "ALPHA" },
      // Names a difference and attributes it to the wrong submission.
      { id: "judge/confabulating", judgeAlwaysPicksSlot: 1, probeMarker: "ALPHA", probeMarkerLies: true },
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

function request(
  models: string[],
  judgeModel: string,
  judgeOverrides: Record<string, unknown> = {},
): ReturnType<typeof CreateRunRequestSchema.parse> {
  return CreateRunRequestSchema.parse({
    mode: "response",
    taskSpec: { prompt: "Summarise the tradeoffs." },
    candidates: models.map((modelId) => ({ modelId })),
    judge: { modelId: judgeModel, ...judgeOverrides },
  });
}

async function runToCompletion(
  models: string[],
  judgeModel: string,
  judgeOverrides: Record<string, unknown> = {},
): Promise<{ runId: string; result: RunResult; events: ArenaEvent[]; runs: RunManager }> {
  const runs = manager();
  const runId = runs.create(request(models, judgeModel, judgeOverrides));
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
    assert.equal(result.reviewReason, "undecidable");
    assert.equal(result.requiresHumanReview, true);
    // The claim "undecidable" is only worth anything with the attempts behind
    // it: position bias survives repetition, and the trace has to show that
    // repetition was actually tried before the run gave up.
    assert.ok(
      result.ladderTrace.some((s) => s.stage === "S2"),
      "gave up without climbing past the first reading",
    );
    assert.ok(result.judgeCallsSpent > 2, "reported undecidable after a single pass");
  });

  test("one noisy reading is not the same as an inseparable pair", async () => {
    // This is the rung's whole justification. Judged once, this pair looks
    // exactly like the position-biased case above — AB and BA disagree. Asking
    // again is what tells the two situations apart, and only one of them is a
    // reason to interrupt a person.
    const { result } = await runToCompletion(["cand/alpha", "cand/beta"], "judge/noisy");
    assert.equal(result.outcome, "winner");
    assert.equal(result.winnerLabel, "cand-a");
    assert.equal(result.decidedAt, "S2");
    assert.equal(result.reviewReason, null);
    assert.equal(result.requiresHumanReview, false);

    const s2 = result.ladderTrace.find((s) => s.stage === "S2");
    assert.equal(s2?.agreement, 1, "every repetition agreed once the noise passed");
  });

  test("a second judge can settle what the first one could not", async () => {
    const { result } = await runToCompletion(["cand/alpha", "cand/beta"], "judge/biased", {
      ensemble: ["judge/second-opinion"],
    });
    assert.equal(result.outcome, "winner");
    assert.equal(result.winnerLabel, "cand-a");
    assert.equal(result.decidedAt, "S3");
    assert.equal(result.reviewReason, null);
  });

  test("running out of budget is reported as money, not as difficulty", async () => {
    // Both end without a winner, and the difference is the whole point: one
    // says buy more calls, the other says no number of calls would help.
    // Reporting them alike sends the operator to read two answers by hand when
    // the fix was a larger ceiling.
    const starved = await runToCompletion(["cand/alpha", "cand/beta"], "judge/biased", {
      maxJudgeCalls: 2,
    });
    assert.equal(starved.result.reviewReason, "budget_exhausted");
    assert.ok(starved.result.judgeCallsSpent <= 2);
    assert.ok(!starved.result.ladderTrace.some((s) => s.stage === "S2"), "S2 ran on an empty budget");

    const exhausted = await runToCompletion(["cand/alpha", "cand/beta"], "judge/biased");
    assert.equal(exhausted.result.reviewReason, "undecidable");
    assert.notEqual(starved.result.reviewReason, exhausted.result.reviewReason);
  });

  test("the ladder is not climbed for a pair the judge already settled", async () => {
    // Escalation is for ambiguity, not for every run. A ladder that always
    // climbs is just a more expensive way to get the same answer.
    const { result } = await runToCompletion(["cand/alpha", "cand/beta"], "judge/content");
    assert.equal(result.decidedAt, "S1");
    assert.equal(result.judgeCallsSpent, 2, "one pair, two presentation orders, nothing more");
  });

  test("a claim that can be checked outranks an opinion that cannot", async () => {
    // S1 and S2 both fail here: the judge is position-biased, so repetition
    // reproduces the bias rather than resolving it. Asked for a verifiable
    // claim instead of a preference, it names one, and the run decides on the
    // measurement rather than on the judge's say-so.
    const { result } = await runToCompletion(["cand/alpha", "cand/beta"], "judge/biased-but-honest");
    assert.equal(result.outcome, "winner");
    assert.equal(result.winnerLabel, "cand-a");
    assert.equal(result.decidedAt, "S4");
    assert.equal(result.reviewReason, null);
    assert.match(result.ladderTrace.find((s) => s.stage === "S4")?.detail ?? "", /검증된 분별 주장/);
  });

  test("a judge whose stated reason is false of its own pick decides nothing", async () => {
    // The failure the earlier rungs cannot see: a confident wrong rationale is
    // indistinguishable from a confident right one under repetition and under a
    // second opinion alike. Running the claim is what exposes it — and the
    // right response is to report that nothing was settled, not to take the
    // half of the answer that happened to be checkable.
    const { result } = await runToCompletion(["cand/alpha", "cand/beta"], "judge/confabulating");
    assert.equal(result.outcome, "no_winner");
    assert.equal(result.reviewReason, "undecidable");
    assert.match(result.ladderTrace.find((s) => s.stage === "S4")?.detail ?? "", /반대쪽에서 참/);
  });

  test("undecidable now means the whole ladder ran", async () => {
    const { result } = await runToCompletion(["cand/alpha", "cand/beta"], "judge/biased");
    assert.equal(result.reviewReason, "undecidable");
    assert.deepEqual(
      [...new Set(result.ladderTrace.map((s) => s.stage))].sort(),
      ["S1", "S2", "S4"],
      "every rung available to this run must appear in the receipt",
    );
  });

  test("the review flag names a specific weakness rather than always firing", async () => {
    // A flag that is true in every branch distinguishes nothing and only moves
    // blame. Each value has to correspond to a distinct, checkable situation.
    const biased = await runToCompletion(["cand/alpha", "cand/beta"], "judge/biased");
    const sole = await runToCompletion(["cand/alpha", "cand/forbidden"], "judge/content");
    const tie = await runToCompletion(["cand/same-1", "cand/same-2"], "judge/content");
    const decided = await runToCompletion(["cand/alpha", "cand/beta"], "judge/content");

    assert.equal(biased.result.reviewReason, "undecidable");
    assert.equal(sole.result.reviewReason, "never_compared");
    assert.equal(tie.result.reviewReason, "tie");
    assert.equal(decided.result.reviewReason, null);

    const distinct = new Set(
      [biased, sole, tie, decided].map((r) => r.result.reviewReason),
    );
    assert.equal(distinct.size, 4, "every outcome must map to a different reason");
  });

  test("response mode can reach a verdict it does not hedge on", async () => {
    // The property this pins is the one the mode used to fail: before
    // `judge_only` was removed, *every* decided response run asked for human
    // review, so the request carried no information about this run. A mode in
    // which the flag is structurally always on has no way to say "decided".
    const { result } = await runToCompletion(["cand/alpha", "cand/beta"], "judge/content");
    assert.equal(result.outcome, "winner");
    assert.equal(result.reviewReason, null);
    assert.equal(result.requiresHumanReview, false);
    // The mode's real limitation is still reported — as a fact about what
    // evidence existed, not as doubt about this particular verdict.
    assert.deepEqual(result.evidenceAxes, ["judge"]);
  });

  test("a judge that never returns parseable JSON is broken, not undecided", async () => {
    // Different remedies: a bigger budget or another judge model fixes this,
    // whereas more evidence fixes an inconsistent judge. Folding both into
    // `unstable_judge` told the operator to do the wrong thing half the time.
    const { result } = await runToCompletion(["cand/alpha", "cand/beta"], "judge/prose");
    assert.equal(result.outcome, "no_winner");
    assert.equal(result.reviewReason, "judge_unavailable");
    assert.equal(result.requiresHumanReview, true);
  });

  test("declared checks settle a pair before any judge is asked", async () => {
    // The rung that makes response mode's evidenceAxes honest. cand-a says
    // ALPHA and cand-b says BETA, so a must_include check separates them
    // without an opinion being involved — and the biased judge that would
    // otherwise force `undecidable` is never consulted.
    const runs = manager();
    const runId = runs.create(
      CreateRunRequestSchema.parse({
        mode: "response",
        taskSpec: { prompt: "Summarise the tradeoffs.", checks: [{ kind: "must_include", items: ["ALPHA"] }] },
        candidates: [{ modelId: "cand/alpha" }, { modelId: "cand/beta" }],
        judge: { modelId: "judge/biased" },
      }),
    );
    await runs.waitFor(runId);
    const result = JSON.parse(store.getRun(runId)?.result ?? "{}") as RunResult;

    assert.equal(result.outcome, "winner");
    assert.equal(result.winnerLabel, "cand-a");
    assert.equal(result.decidedAt, "S0");
    assert.equal(result.confidence, "objective");
    assert.equal(result.judgeCallsSpent, 0, "a settled pair should not reach the judge at all");
    assert.equal(result.reviewReason, null);
    assert.deepEqual(result.evidenceAxes, ["objective", "judge"]);
  });

  test("checks that do not separate the candidates leave the ladder to decide", async () => {
    // The counterpart property: S0 must not manufacture a winner out of a
    // check both candidates pass. It contributes only when it discriminates.
    const runs = manager();
    const runId = runs.create(
      CreateRunRequestSchema.parse({
        mode: "response",
        taskSpec: { prompt: "Summarise the tradeoffs.", checks: [{ kind: "min_words", limit: 1 }] },
        candidates: [{ modelId: "cand/alpha" }, { modelId: "cand/beta" }],
        judge: { modelId: "judge/content" },
      }),
    );
    await runs.waitFor(runId);
    const result = JSON.parse(store.getRun(runId)?.result ?? "{}") as RunResult;

    assert.equal(result.decidedAt, "S1", "an undiscriminating check must not settle anything");
    assert.equal(result.winnerLabel, "cand-a");
    assert.ok(result.judgeCallsSpent > 0);
  });

  test("an all-failed run needs no review — there is nothing ambiguous about it", async () => {
    const { result } = await runToCompletion(["cand/empty", "cand/forbidden"], "judge/content");
    assert.equal(result.reviewReason, null);
    assert.equal(result.requiresHumanReview, false);
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
