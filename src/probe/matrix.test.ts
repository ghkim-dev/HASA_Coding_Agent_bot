import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PROBE_VERSION, type CapabilityResult, type ModelLimits } from "../protocol/index.ts";
import {
  MATRIX_MAX_AGE_MS,
  buildMatrix,
  buildModelReport,
  checkStaleness,
  computeEligibility,
  emptyLimits,
  type CapabilityMap,
} from "./matrix.ts";

const PASS: CapabilityResult = { status: "pass" };
const FAIL: CapabilityResult = { status: "fail" };
const DENIED: CapabilityResult = { status: "denied" };

function limits(maxOutput: number | null): ModelLimits {
  return { ...emptyLimits(), observedMaxOutputTokens: maxOutput };
}

const fullyCapable: CapabilityMap = {
  chat: PASS,
  stream: PASS,
  tools: PASS,
  tools_roundtrip: PASS,
  json_object: PASS,
};

describe("computeEligibility", () => {
  test("a fully capable model qualifies for coding-agent and judge", () => {
    const e = computeEligibility(fullyCapable, limits(8192));
    assert.equal(e.codingAgent, true);
    assert.equal(e.responseCompare, true);
    assert.equal(e.judge, true);
    assert.equal(e.patchMode, false, "an agent-capable model never competes in the patch league");
  });

  test("no tool calling means patch-mode, not coding-agent", () => {
    const e = computeEligibility({ ...fullyCapable, tools: FAIL }, limits(8192));
    assert.equal(e.codingAgent, false);
    assert.equal(e.patchMode, true);
    assert.ok(e.reasons.some((r) => r.includes("tools!=pass")));
  });

  test("tool calling without a working round-trip is not enough", () => {
    const e = computeEligibility({ ...fullyCapable, tools_roundtrip: FAIL }, limits(8192));
    assert.equal(e.codingAgent, false);
    assert.ok(e.reasons.some((r) => r.includes("tools_roundtrip")));
  });

  test("an output ceiling below the code threshold disqualifies both code modes", () => {
    const e = computeEligibility(fullyCapable, limits(2048));
    assert.equal(e.codingAgent, false);
    assert.equal(e.patchMode, false);
    assert.ok(e.reasons.some((r) => r.includes("2048")));
  });

  test("an unmeasured output ceiling is treated as insufficient, never assumed", () => {
    const e = computeEligibility(fullyCapable, limits(null));
    assert.equal(e.codingAgent, false);
  });

  test("chat failure disqualifies everything", () => {
    const e = computeEligibility({ chat: FAIL }, limits(8192));
    assert.deepEqual(
      [e.responseCompare, e.codingAgent, e.patchMode, e.judge],
      [false, false, false, false],
    );
  });

  test("a 403 anywhere removes the model from response compare", () => {
    const e = computeEligibility({ ...fullyCapable, vision: DENIED }, limits(8192));
    assert.equal(e.responseCompare, false);
    assert.ok(e.reasons.some((r) => r.includes("403")));
  });

  test("judge requires structured output, since a free-text verdict cannot be parsed reliably", () => {
    const e = computeEligibility({ chat: PASS, json_object: FAIL, json_schema: FAIL }, limits(8192));
    assert.equal(e.judge, false);
    const withSchema = computeEligibility({ chat: PASS, json_schema: PASS }, limits(8192));
    assert.equal(withSchema.judge, true);
  });
});

describe("buildMatrix", () => {
  test("validates its own output against the schema", () => {
    const matrix = buildMatrix({
      baseUrl: "http://example/v1",
      keyFingerprint: "sha256:abcdef012345",
      probedAt: new Date(0).toISOString(),
      models: [buildModelReport("a/b", fullyCapable, limits(8192))],
    });
    assert.equal(matrix.probeVersion, PROBE_VERSION);
    assert.equal(matrix.models.length, 1);
    assert.equal(matrix.models[0]?.eligibility.codingAgent, true);
  });

  test("contains no key material — only a fingerprint", () => {
    const matrix = buildMatrix({
      baseUrl: "http://example/v1",
      keyFingerprint: "sha256:abcdef012345",
      probedAt: new Date(0).toISOString(),
      models: [buildModelReport("a/b", fullyCapable, limits(8192))],
    });
    const serialised = JSON.stringify(matrix);
    assert.ok(!serialised.includes("Bearer"));
    assert.match(matrix.keyFingerprint, /^sha256:/);
  });
});

describe("checkStaleness", () => {
  const fresh = buildMatrix({
    baseUrl: "http://example/v1",
    keyFingerprint: "sha256:abcdef012345",
    probedAt: new Date(1_000_000).toISOString(),
    models: [],
  });

  test("a recent matrix from the same key is usable", () => {
    const s = checkStaleness(fresh, {
      now: 1_000_000 + 1000,
      keyFingerprint: "sha256:abcdef012345",
      baseUrl: "http://example/v1",
    });
    assert.equal(s.stale, false);
  });

  test("age past the window is flagged", () => {
    const s = checkStaleness(fresh, { now: 1_000_000 + MATRIX_MAX_AGE_MS + 1 });
    assert.equal(s.stale, true);
  });

  test("a different key invalidates the matrix — permissions may differ", () => {
    const s = checkStaleness(fresh, { now: 1_000_000, keyFingerprint: "sha256:999999999999" });
    assert.equal(s.stale, true);
    assert.ok(s.reasons.some((r) => r.includes("keyFingerprint")));
  });

  test("a probe-version bump invalidates the matrix", () => {
    const older = { ...fresh, probeVersion: "probe-v0" };
    const s = checkStaleness(older, { now: 1_000_000 });
    assert.equal(s.stale, true);
  });
});
