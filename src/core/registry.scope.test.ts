import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROBE_VERSION, type CapabilityMatrix } from "../protocol/index.ts";
import { ModelRegistry } from "./registry.ts";

/**
 * A matrix belongs to the gateway it measured.
 *
 * This was a real failure, not a hypothetical one. `pnpm probe --mock` wrote
 * its synthetic results to the default path; the Arena's model picker then
 * offered `mock/full` and `mock/no-tools` against the live gateway; every
 * candidate came back 403; and the run ended `no_winner` for a reason that had
 * nothing to do with any model.
 *
 * Nothing in that chain was an error. Each layer did what it was told, which is
 * why the check has to be at the point the matrix is loaded.
 */

const dirs: string[] = [];

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const REAL = "https://open.hasa.re.kr/v1";
const MOCK = "http://127.0.0.1:57290/v1";

async function matrixAt(baseUrl: string, modelIds: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arena-matrix-"));
  dirs.push(dir);
  const path = join(dir, "capability-matrix.json");
  const matrix: CapabilityMatrix = {
    schemaVersion: 1,
    probeVersion: PROBE_VERSION,
    probedAt: "2026-08-01T00:00:00.000Z",
    baseUrl,
    keyFingerprint: "sha256:000000000000",
    models: modelIds.map((modelId) => ({
      modelId,
      capabilities: { chat: { status: "pass" } } as CapabilityMatrix["models"][number]["capabilities"],
      limits: { observedContextWindow: null, observedMaxOutputTokens: 8192, latencyMs: null },
      eligibility: { responseCompare: true, codingAgent: false, patchMode: true, judge: false, reasons: [] },
    })),
  };
  await writeFile(path, JSON.stringify(matrix), "utf8");
  return path;
}

describe("loading a matrix", () => {
  test("a matrix measured against this gateway is used", async () => {
    const path = await matrixAt(REAL, ["exaone-4.0-32b"]);
    const registry = await ModelRegistry.load(path, { baseUrl: REAL });
    assert.equal(registry.available, true);
    assert.deepEqual(registry.list().map((m) => m.modelId), ["exaone-4.0-32b"]);
  });

  test("a matrix from a mock run is refused", async () => {
    // The failure that motivated this: mock ids reaching the live picker.
    const path = await matrixAt(MOCK, ["mock/full", "mock/no-tools"]);
    const registry = await ModelRegistry.load(path, { baseUrl: REAL });

    assert.equal(registry.available, false);
    assert.deepEqual(registry.list(), [], "no phantom model may reach a picker");
  });

  test("the refusal is visible as staleness, not as silence", async () => {
    // An empty picker with no reason is the version of this bug that takes an
    // afternoon to recognise.
    const path = await matrixAt(MOCK, ["mock/full"]);
    const registry = await ModelRegistry.load(path, { baseUrl: REAL });
    assert.deepEqual(registry.staleness(Date.now()), ["capability matrix not found"]);
  });

  test("without an expectation the matrix is used as before", async () => {
    // The parameter is opt-in so that a caller with no gateway in hand — a
    // test, a one-off script — behaves the way it always did.
    const path = await matrixAt(MOCK, ["mock/full"]);
    assert.equal((await ModelRegistry.load(path)).available, true);
  });

  test("a missing file is still just an empty registry", async () => {
    const registry = await ModelRegistry.load("/does/not/exist.json", { baseUrl: REAL });
    assert.equal(registry.available, false);
  });

  test("a corrupt file is still just an empty registry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arena-matrix-"));
    dirs.push(dir);
    const path = join(dir, "m.json");
    await writeFile(path, "{ not json", "utf8");
    assert.equal((await ModelRegistry.load(path, { baseUrl: REAL })).available, false);
  });

  test("the check is on the gateway, not on the key", async () => {
    // Rotating a key against the same gateway keeps the measurements: the
    // models are the same software. Measuring another host is not.
    const path = await matrixAt(REAL, ["exaone-4.0-32b"]);
    const registry = await ModelRegistry.load(path, { baseUrl: REAL });
    assert.equal(registry.available, true);
  });

  test("a trailing-slash difference is still a different gateway", async () => {
    // Both spellings reach the same host, but `HasaClient` normalises its own
    // base URL, so a mismatch here means they were not produced by the same
    // configuration — which is the thing worth noticing.
    const path = await matrixAt(`${REAL}/`, ["exaone-4.0-32b"]);
    assert.equal((await ModelRegistry.load(path, { baseUrl: REAL })).available, false);
  });
});
