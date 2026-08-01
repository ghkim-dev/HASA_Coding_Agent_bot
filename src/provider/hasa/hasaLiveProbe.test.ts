import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HasaClient } from "../../hasa-client/client.ts";
import { nullLogger } from "../../hasa-client/logger.ts";
import { clearSecrets, fingerprint } from "../../hasa-client/redact.ts";
import { PROBE_VERSION, type CapabilityMatrix } from "../../protocol/index.ts";
import { startMockHasa, type MockHasaServer } from "../../testing/mock-hasa.ts";
import {
  createLiveCapabilityProbe,
  createLiveHasaCapabilityProbe,
  readCapabilityMatrix,
  writeCapabilityMatrix,
} from "./hasaLiveProbe.ts";

/**
 * The seam between the lazy cache and the probe that measures.
 *
 * Before this existed, `ensure` had an injection point and nothing injected
 * into it — every capability stayed `unknown` unless someone had run the CLI by
 * hand. These tests are mostly about the guards on the stored matrix, because
 * a matrix measured under different conditions is not a measurement of these.
 */

let mock: MockHasaServer;
const dirs: string[] = [];

before(async () => {
  mock = await startMockHasa({
    models: [
      { id: "m/full", tools: "native", multiTool: true, jsonObject: true, jsonSchema: true, maxTokensLimit: 32768 },
      { id: "m/chat-only", tools: "none", jsonObject: true },
      { id: "m/forbidden", behavior: "forbidden" },
    ],
  });
});

after(async () => {
  await mock.close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  clearSecrets();
});

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hasa-matrix-"));
  dirs.push(dir);
  return join(dir, "capability-matrix.json");
}

function client(): HasaClient {
  return new HasaClient({ apiKey: mock.apiKey, baseUrl: mock.url, logger: nullLogger });
}

function matrix(overrides: Partial<CapabilityMatrix> = {}): CapabilityMatrix {
  return {
    schemaVersion: 1,
    probeVersion: PROBE_VERSION,
    probedAt: "2026-08-01T00:00:00.000Z",
    baseUrl: mock.url,
    keyFingerprint: fingerprint(mock.apiKey),
    models: [
      {
        modelId: "m/full",
        capabilities: { chat: { status: "pass" } } as CapabilityMatrix["models"][number]["capabilities"],
        limits: { observedContextWindow: null, observedMaxOutputTokens: 4096, latencyMs: null },
        eligibility: { responseCompare: true, codingAgent: false, patchMode: true, judge: false, reasons: [] },
      },
    ],
    ...overrides,
  };
}

describe("createLiveCapabilityProbe", () => {
  test("measures exactly the models it is asked about", async () => {
    const probe = createLiveCapabilityProbe({ client: client(), apiKey: mock.apiKey, logger: nullLogger });
    const result = await probe(["m/full"]);

    assert.deepEqual(result.models.map((m) => m.modelId), ["m/full"], "one model, not the catalogue");
    assert.equal(result.models[0]?.capabilities["chat"]?.status, "pass");
    assert.equal(result.probeVersion, PROBE_VERSION);
  });

  test("the matrix is fingerprinted with the key that produced it, not the key", async () => {
    const probe = createLiveCapabilityProbe({ client: client(), apiKey: mock.apiKey, logger: nullLogger });
    const result = await probe(["m/chat-only"]);

    assert.equal(result.keyFingerprint, fingerprint(mock.apiKey));
    assert.ok(!JSON.stringify(result).includes(mock.apiKey), "the matrix leaked the key");
  });

  test("a model the key cannot reach is recorded as denied, never as incapable", async () => {
    // A 403 says nothing about the model. Recording it as a failure would
    // outlive the permission that caused it.
    const probe = createLiveCapabilityProbe({ client: client(), apiKey: mock.apiKey, logger: nullLogger });
    const result = await probe(["m/forbidden"]);
    assert.equal(result.models[0]?.capabilities["chat"]?.status, "denied");
  });

  test("the abort signal reaches the probe run", async () => {
    const controller = new AbortController();
    controller.abort();
    const probe = createLiveCapabilityProbe({ client: client(), apiKey: mock.apiKey, logger: nullLogger });
    const result = await probe(["m/full"], controller.signal);
    // An aborted run produces a report rather than throwing, so a cancelled
    // measurement cannot be mistaken for a measured failure.
    assert.notEqual(result.models[0]?.capabilities["chat"]?.status, "pass");
  });
});

describe("readCapabilityMatrix — guards", () => {
  const scope = () => ({ keyFingerprint: fingerprint(mock.apiKey), baseUrl: mock.url, logger: nullLogger });

  test("reads back what was written", async () => {
    const path = await tempPath();
    await writeCapabilityMatrix(matrix(), path);
    const read = await readCapabilityMatrix({ path, ...scope() });
    assert.equal(read?.models[0]?.modelId, "m/full");
  });

  test("a matrix measured with another key is not used", async () => {
    // Its `denied` results describe someone else's permissions.
    const path = await tempPath();
    await writeCapabilityMatrix(matrix({ keyFingerprint: fingerprint("some-other-key-1234567890") }), path);
    assert.equal(await readCapabilityMatrix({ path, ...scope() }), null);
  });

  test("a matrix measured against another gateway is not used", async () => {
    const path = await tempPath();
    await writeCapabilityMatrix(matrix({ baseUrl: "https://elsewhere.example/v1" }), path);
    assert.equal(await readCapabilityMatrix({ path, ...scope() }), null);
  });

  test("a matrix from an older probe is not used", async () => {
    // The probe measured different things then; the labels no longer mean the
    // same thing.
    const path = await tempPath();
    await writeCapabilityMatrix(matrix({ probeVersion: "probe-v0" }), path);
    assert.equal(await readCapabilityMatrix({ path, ...scope() }), null);
  });

  test("a missing file is a miss, not an error", async () => {
    assert.equal(await readCapabilityMatrix({ path: await tempPath(), ...scope() }), null);
  });

  test("a corrupt file is a miss, not an error", async () => {
    const path = await tempPath();
    await writeCapabilityMatrix(matrix(), path);
    await writeFile(path, "{ not json", "utf8");
    assert.equal(await readCapabilityMatrix({ path, ...scope() }), null);
  });

  test("a file that parses but is not a matrix is a miss", async () => {
    const path = await tempPath();
    await writeFile(path, JSON.stringify({ schemaVersion: 1, models: "nope" }), "utf8");
    assert.equal(await readCapabilityMatrix({ path, ...scope() }), null);
  });
});

describe("writeCapabilityMatrix", () => {
  test("leaves no temporary files behind, even under concurrency", async () => {
    const path = await tempPath();
    await Promise.all(Array.from({ length: 12 }, () => writeCapabilityMatrix(matrix(), path)));
    const files = await readdir(join(path, ".."));
    assert.deepEqual(files.filter((f) => f.endsWith(".tmp")), []);
    assert.deepEqual(files, ["capability-matrix.json"]);
  });

  test("the written file holds a fingerprint and no key", async () => {
    const path = await tempPath();
    await writeCapabilityMatrix(matrix(), path);
    const raw = await readFile(path, "utf8");
    assert.ok(!raw.includes(mock.apiKey));
    assert.ok(raw.includes("sha256:"));
  });

  test("an unwritable path is not an error the caller has to handle", async () => {
    const blocked = join(await tempPath(), "nested", "matrix.json");
    await writeCapabilityMatrix(matrix(), blocked);
  });
});

describe("createLiveHasaCapabilityProbe", () => {
  test("reads nothing, measures on demand, and persists the result", async () => {
    const path = await tempPath();
    const probe = createLiveHasaCapabilityProbe({
      client: client(),
      apiKey: mock.apiKey,
      keyFingerprint: fingerprint(mock.apiKey),
      baseUrl: mock.url,
      path,
      logger: nullLogger,
    });

    // Nothing measured yet: reading must not fire a request.
    assert.equal((await probe.capabilitiesOf("m/full")).chat, "unknown");

    const measured = await probe.ensure("m/full");
    assert.equal(measured.chat, true);
    assert.equal(measured.streaming, true);

    // The next session starts from disk.
    const stored = await readCapabilityMatrix({
      path,
      keyFingerprint: fingerprint(mock.apiKey),
      baseUrl: mock.url,
      logger: nullLogger,
    });
    assert.equal(stored?.models.find((m) => m.modelId === "m/full")?.capabilities["chat"]?.status, "pass");
  });

  test("persisting one model does not erase the others", async () => {
    // `save` receives the merged matrix rather than the delta. Handed only the
    // model just measured, a file store would overwrite the catalogue with one
    // entry — and could not merge it back, because merging already happened.
    const path = await tempPath();
    const make = (): ReturnType<typeof createLiveHasaCapabilityProbe> =>
      createLiveHasaCapabilityProbe({
        client: client(),
        apiKey: mock.apiKey,
        keyFingerprint: fingerprint(mock.apiKey),
        baseUrl: mock.url,
        path,
        logger: nullLogger,
      });

    await make().ensure("m/full");
    // A fresh instance, so the second probe starts from what is on disk.
    await make().ensure("m/chat-only");

    const stored = await readCapabilityMatrix({
      path,
      keyFingerprint: fingerprint(mock.apiKey),
      baseUrl: mock.url,
      logger: nullLogger,
    });
    assert.deepEqual(
      stored?.models.map((m) => m.modelId).sort(),
      ["m/chat-only", "m/full"],
      "the earlier measurement was overwritten",
    );
  });

  test("a stored matrix from another key is ignored rather than trusted", async () => {
    const path = await tempPath();
    await writeCapabilityMatrix(matrix({ keyFingerprint: fingerprint("a-different-key-0987654321") }), path);

    const probe = createLiveHasaCapabilityProbe({
      client: client(),
      apiKey: mock.apiKey,
      keyFingerprint: fingerprint(mock.apiKey),
      baseUrl: mock.url,
      path,
      logger: nullLogger,
    });
    assert.equal((await probe.capabilitiesOf("m/full")).chat, "unknown");
  });
});
