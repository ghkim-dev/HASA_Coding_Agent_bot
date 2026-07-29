import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROBE_VERSION } from "../protocol/index.ts";
import { buildMatrix, buildModelReport, emptyLimits, type CapabilityMap } from "../probe/matrix.ts";
import { ModelRegistry } from "./registry.ts";

let dir: string;
let matrixPath: string;

const agentCapable: CapabilityMap = {
  chat: { status: "pass" },
  stream: { status: "pass" },
  tools: { status: "pass" },
  tools_roundtrip: { status: "pass" },
  json_object: { status: "pass" },
};

const toolless: CapabilityMap = {
  chat: { status: "pass" },
  stream: { status: "pass" },
  tools: { status: "fail" },
  json_object: { status: "pass" },
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "arena-reg-"));
  matrixPath = join(dir, "capability-matrix.json");
  const matrix = buildMatrix({
    baseUrl: "https://example/v1",
    keyFingerprint: "sha256:abcdef012345",
    probedAt: new Date().toISOString(),
    models: [
      buildModelReport("model/agent", agentCapable, { ...emptyLimits(), observedMaxOutputTokens: 8192 }),
      buildModelReport("model/patch", toolless, { ...emptyLimits(), observedMaxOutputTokens: 8192 }),
      buildModelReport("model/tiny", toolless, { ...emptyLimits(), observedMaxOutputTokens: 512 }),
    ],
  });
  await writeFile(matrixPath, JSON.stringify(matrix), "utf8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
});

describe("ModelRegistry", () => {
  test("loads a matrix and reports eligibility", async () => {
    const registry = await ModelRegistry.load(matrixPath);
    assert.equal(registry.available, true);
    assert.equal(registry.eligibilityOf("model/agent")?.codingAgent, true);
    assert.equal(registry.eligibilityOf("model/patch")?.codingAgent, false);
    assert.equal(registry.eligibilityOf("model/patch")?.patchMode, true);
  });

  test("refuses a tool-less model in the agent runtime and names the alternative", async () => {
    const registry = await ModelRegistry.load(matrixPath);
    const objections = registry.objectionsFor(["model/agent", "model/patch"], "agent");
    assert.equal(objections.length, 1);
    assert.match(objections[0] ?? "", /model\/patch/);
    assert.match(objections[0] ?? "", /patch/);
  });

  test("accepts the same pair in the patch runtime", async () => {
    const registry = await ModelRegistry.load(matrixPath);
    assert.deepEqual(registry.objectionsFor(["model/agent", "model/patch"], "patch"), []);
  });

  test("a model with too small an output budget is refused everywhere", async () => {
    const registry = await ModelRegistry.load(matrixPath);
    assert.equal(registry.objectionsFor(["model/tiny"], "agent").length, 1);
    assert.equal(registry.objectionsFor(["model/tiny"], "patch").length, 1);
  });

  test("an unprobed model is refused with a pointer to the probe", async () => {
    const registry = await ModelRegistry.load(matrixPath);
    const objections = registry.objectionsFor(["model/unknown"], "agent");
    assert.match(objections[0] ?? "", /pnpm probe/);
  });

  test("a missing matrix raises no objections but is reported as stale", async () => {
    // Blocking every code run because Phase 0 was never executed would be worse
    // than running with a warning — and the warning is what tells the user.
    const registry = await ModelRegistry.load(join(dir, "does-not-exist.json"));
    assert.equal(registry.available, false);
    assert.deepEqual(registry.objectionsFor(["anything"], "agent"), []);
    assert.match(registry.staleness(Date.now()).join(" "), /not found/);
  });

  test("a matrix from an older probe version is flagged", async () => {
    const stale = JSON.parse(await (await import("node:fs/promises")).readFile(matrixPath, "utf8")) as {
      probeVersion: string;
    };
    stale.probeVersion = "probe-v0";
    await writeFile(matrixPath, JSON.stringify(stale), "utf8");
    const registry = await ModelRegistry.load(matrixPath);
    assert.match(registry.staleness(Date.now()).join(" "), new RegExp(PROBE_VERSION));
  });
});
