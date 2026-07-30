import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "../hasa-client/logger.ts";
import { Store, type CandidateRow, type RunRow } from "./store.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "arena-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function runRow(id: string): RunRow {
  return {
    id,
    mode: "response",
    status: "queued",
    taskSpec: JSON.stringify({ prompt: "p" }),
    sampling: JSON.stringify({ temperature: 0.2 }),
    judge: JSON.stringify({ modelId: "j" }),
    createdAt: 1000,
    finishedAt: null,
    result: null,
    repoRoot: null,
    baseCommit: null,
  };
}

function candidateRow(runId: string, label: string): CandidateRow {
  return {
    id: `${runId}-${label}`,
    runId,
    label,
    modelId: `model/${label}`,
    spec: "{}",
    status: "queued",
    orderIndex: 0,
    excludedReason: null,
    responseText: null,
    tokensIn: null,
    tokensOut: null,
    latencyMs: null,
    errorCode: null,
    artifacts: null,
    score: null,
    round: 0,
    parentCandidateId: null,
    origin: "seed",
  };
}

describe("Store", () => {
  test("uses node:sqlite when the runtime provides it", async () => {
    const store = await Store.open({ dbPath: join(dir, "a.db"), artifactRoot: dir, logger: nullLogger });
    assert.equal(store.sqliteEnabled, true, "Node 24 ships node:sqlite — a fallback here would be a regression");
    store.close();
  });

  test("survives a restart — rows are rehydrated from disk", async () => {
    const dbPath = join(dir, "b.db");
    const first = await Store.open({ dbPath, artifactRoot: null, logger: nullLogger });
    first.insertRun(runRow("run-1"));
    first.insertCandidate(candidateRow("run-1", "cand-a"));
    first.updateRun("run-1", { status: "completed", finishedAt: 2000, result: '{"outcome":"no_winner"}' });
    first.updateCandidate("run-1-cand-a", { status: "completed", responseText: "hello" });
    first.close();

    const second = await Store.open({ dbPath, artifactRoot: null, logger: nullLogger });
    const restored = second.getRun("run-1");
    assert.equal(restored?.status, "completed");
    assert.equal(restored?.finishedAt, 2000);
    assert.equal(second.listCandidates("run-1")[0]?.responseText, "hello");
    second.close();
  });

  test("updateCandidate on an unknown id is a no-op, not a crash", async () => {
    const store = await Store.open({ dbPath: ":memory:", artifactRoot: null, logger: nullLogger });
    assert.doesNotThrow(() => store.updateCandidate("nope", { status: "failed" }));
    store.close();
  });

  test("listRuns returns newest first", async () => {
    const store = await Store.open({ dbPath: ":memory:", artifactRoot: null, logger: nullLogger });
    store.insertRun({ ...runRow("old"), createdAt: 1 });
    store.insertRun({ ...runRow("new"), createdAt: 99 });
    assert.deepEqual(store.listRuns().map((r) => r.id), ["new", "old"]);
    store.close();
  });

  test("appendJsonl writes one parseable object per line", async () => {
    const store = await Store.open({ dbPath: ":memory:", artifactRoot: dir, logger: nullLogger });
    await store.appendJsonl("runs.jsonl", { a: 1 });
    await store.appendJsonl("runs.jsonl", { a: 2 });
    const lines = (await readFile(join(dir, "runs.jsonl"), "utf8")).trim().split("\n");
    assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ a: 1 }, { a: 2 }]);
    store.close();
  });

  test("a null artifact root disables file output without erroring", async () => {
    const store = await Store.open({ dbPath: ":memory:", artifactRoot: null, logger: nullLogger });
    assert.equal(await store.appendJsonl("runs.jsonl", { a: 1 }), null);
    assert.equal(store.runDir("x"), null);
    store.close();
  });

  test("an unwritable artifact path degrades to a warning, not a thrown error", async () => {
    // A run must not die because the disk is full or a path is bad.
    const store = await Store.open({ dbPath: ":memory:", artifactRoot: "\0invalid", logger: nullLogger });
    assert.equal(await store.appendJsonl("runs.jsonl", { a: 1 }), null);
    store.close();
  });
});
