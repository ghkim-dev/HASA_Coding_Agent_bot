import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import type { ArenaEvent } from "../protocol/index.ts";
import { HasaClient } from "../hasa-client/client.ts";
import { nullLogger } from "../hasa-client/logger.ts";
import { clearSecrets } from "../hasa-client/redact.ts";
import { startMockHasa, type MockHasaServer } from "../testing/mock-hasa.ts";
import { EventHub } from "../core/events.ts";
import { RunManager } from "../core/runManager.ts";
import { Scheduler } from "../core/scheduler.ts";
import { Store } from "../core/store.ts";
import { buildServer } from "./app.ts";

let mock: MockHasaServer;
let app: FastifyInstance;
let store: Store;
let hub: EventHub;
let runs: RunManager;

const TOKEN = "test-token-abc";

before(async () => {
  mock = await startMockHasa({
    models: [
      { id: "cand/alpha", cannedReply: "ALPHA response" },
      { id: "cand/beta", cannedReply: "BETA response" },
      { id: "judge/content", judgePrefers: "ALPHA" },
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
  runs = new RunManager({
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
  app = buildServer({ runs, store, hub, logger: nullLogger, token: TOKEN });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  hub.closeAll();
  store.close();
});

const auth = { "x-arena-token": TOKEN };

const validBody = {
  mode: "response",
  taskSpec: { prompt: "Compare the two approaches." },
  candidates: [{ modelId: "cand/alpha" }, { modelId: "cand/beta" }],
  judge: { modelId: "judge/content" },
};

async function createRun(): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/runs", headers: auth, payload: validBody });
  assert.equal(res.statusCode, 202);
  const runId = (res.json() as { runId: string }).runId;
  await runs.waitFor(runId);
  return runId;
}

describe("HTTP API", () => {
  test("healthz needs no token", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(res.statusCode, 200);
  });

  test("GET /models reports an empty catalogue rather than failing when unprobed", async () => {
    // The extension's model picker must be able to render "run pnpm probe
    // first" instead of showing an error it cannot act on.
    const res = await app.inject({ method: "GET", url: "/models", headers: auth });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { models: unknown[]; staleness: string[] };
    assert.deepEqual(body.models, []);
    assert.ok(body.staleness.length > 0);
  });

  test("every other route requires the shared token", async () => {
    const res = await app.inject({ method: "GET", url: "/runs" });
    assert.equal(res.statusCode, 401);
  });

  test("POST /runs accepts a valid body and returns 202", async () => {
    const res = await app.inject({ method: "POST", url: "/runs", headers: auth, payload: validBody });
    assert.equal(res.statusCode, 202);
    assert.equal((res.json() as { status: string }).status, "queued");
  });

  test("POST /runs rejects a malformed body with field-level issues", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/runs",
      headers: auth,
      payload: { ...validBody, candidates: [{ modelId: "only-one" }] },
    });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { error: string }).error, "invalid_request");
  });

  test("POST /runs rejects an unfair configuration with its violations", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/runs",
      headers: auth,
      payload: {
        ...validBody,
        candidates: [{ modelId: "cand/alpha" }, { modelId: "cand/alpha" }],
      },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error: string; violations: string[] };
    assert.equal(body.error, "unfair_run");
    assert.ok(body.violations.length > 0);
  });

  test("code mode is refused when no CodeRunManager is wired in", async () => {
    // This server instance is built without `codeRuns`, so the route must say
    // so rather than silently treating a code request as a response comparison.
    const res = await app.inject({
      method: "POST",
      url: "/code-runs",
      headers: auth,
      payload: { mode: "code", repoRoot: "/nope", taskSpec: { prompt: "x" }, candidates: [], judge: {} },
    });
    assert.equal(res.statusCode, 501);
    assert.equal((res.json() as { error: string }).error, "code_mode_unavailable");
  });

  test("GET /runs/:id returns the prompt but never the system prompt", async () => {
    const withSystem = {
      ...validBody,
      taskSpec: { prompt: "visible prompt", systemPrompt: "INTERNAL-SYSTEM-TEMPLATE" },
    };
    const created = await app.inject({ method: "POST", url: "/runs", headers: auth, payload: withSystem });
    const runId = (created.json() as { runId: string }).runId;
    await runs.waitFor(runId);

    const res = await app.inject({ method: "GET", url: `/runs/${runId}`, headers: auth });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes("visible prompt"));
    assert.ok(!res.body.includes("INTERNAL-SYSTEM-TEMPLATE"), "system prompt must stay server-side");
  });

  test("GET /runs/:id/candidates exposes responses but no key material", async () => {
    const runId = await createRun();
    const res = await app.inject({ method: "GET", url: `/runs/${runId}/candidates`, headers: auth });
    const body = res.json() as { candidates: Array<Record<string, unknown>> };
    assert.equal(body.candidates.length, 2);
    assert.ok(String(body.candidates[0]?.["responseText"]).length > 0);
    assert.ok(!res.body.includes(mock.apiKey));
  });

  test("GET /runs/:id/verdicts omits raw transcript paths", async () => {
    const runId = await createRun();
    const res = await app.inject({ method: "GET", url: `/runs/${runId}/verdicts`, headers: auth });
    const body = res.json() as { verdicts: Array<Record<string, unknown>> };
    assert.equal(body.verdicts.length, 2);
    assert.ok(!("rawPath" in (body.verdicts[0] ?? {})));
  });

  test("unknown run ids are 404, not 500", async () => {
    for (const path of ["", "/candidates", "/verdicts"]) {
      const res = await app.inject({ method: "GET", url: `/runs/does-not-exist${path}`, headers: auth });
      assert.equal(res.statusCode, 404, `GET /runs/:id${path}`);
    }
  });

  test("no response body anywhere contains the api key", async () => {
    const runId = await createRun();
    for (const path of [`/runs`, `/runs/${runId}`, `/runs/${runId}/candidates`, `/runs/${runId}/verdicts`]) {
      const res = await app.inject({ method: "GET", url: path, headers: auth });
      assert.ok(!res.body.includes(mock.apiKey), `key leaked from ${path}`);
    }
  });
});

describe("SSE events", () => {
  test("streams the run lifecycle and replays history to a late subscriber", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;

    const created = await fetch(`${base}/runs`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    const { runId } = (await created.json()) as { runId: string };
    await runs.waitFor(runId);

    // Subscribing after completion must still deliver the whole story.
    const res = await fetch(`${base}/runs/${runId}/events`, { headers: auth });
    assert.equal(res.headers.get("content-type"), "text/event-stream");

    const text = await res.text();
    const events: ArenaEvent[] = text
      .split("\n\n")
      .map((frame) => frame.split("\n").find((l) => l.startsWith("data: ")))
      .filter((l): l is string => l !== undefined)
      .map((l) => JSON.parse(l.slice(6)) as ArenaEvent);

    assert.ok(events.some((e) => e.type === "run.status" && e.status === "queued"));
    assert.ok(events.some((e) => e.type === "run.result"));
    assert.ok(!text.includes(mock.apiKey));
  });
});
