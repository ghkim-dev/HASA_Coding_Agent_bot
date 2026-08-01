import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { CapabilityMatrix, CapabilityStatus, ModelReport } from "../../protocol/index.ts";
import { forEachSeedAsync, fuzzIterations, type Rng } from "../../testing/fuzz.ts";
import type { CapabilityState, ModelCapabilities } from "../types.ts";
import { HasaCapabilityProbe, capabilitiesFromReport } from "./hasaCapabilityProbe.ts";

/**
 * Capability lookup, over generated matrices and operation sequences.
 *
 * The rule this protects is the one that is easiest to erode by accident:
 * `unknown` must never collapse into `false`. A 403 or a GPU outage leaves a
 * model unmeasured, and recording that as a deficiency mislabels the model
 * permanently — after a key upgrade, after the backend comes back.
 */

const STATUSES: CapabilityStatus[] = ["pass", "fail", "denied", "unknown", "skipped"];
const CAPABILITY_NAMES = ["chat", "stream", "tools", "tools_roundtrip", "vision", "reasoning_content"];

function randomReport(rng: Rng, modelId: string): ModelReport {
  const capabilities: Record<string, { status: CapabilityStatus }> = {};
  for (const name of CAPABILITY_NAMES) {
    if (rng.bool(0.8)) capabilities[name] = { status: rng.pick(STATUSES) };
  }
  return {
    modelId,
    capabilities: capabilities as ModelReport["capabilities"],
    limits: {
      observedContextWindow: rng.bool() ? rng.int(1, 131072) : null,
      observedMaxOutputTokens: rng.bool() ? rng.int(1, 32768) : null,
      latencyMs: null,
    },
    eligibility: {
      responseCompare: rng.bool(),
      codingAgent: rng.bool(),
      patchMode: rng.bool(),
      judge: rng.bool(),
      reasons: [],
    },
  };
}

function randomMatrix(rng: Rng, ids: string[]): CapabilityMatrix {
  return {
    schemaVersion: 1,
    probeVersion: "probe-v1",
    probedAt: new Date(0).toISOString(),
    baseUrl: "https://open.hasa.re.kr/v1",
    keyFingerprint: "sha256:000000000000",
    models: ids.map((id) => randomReport(rng, id)),
  };
}

const TRISTATE: CapabilityState[] = [true, false, "unknown"];

function assertTristate(caps: ModelCapabilities): void {
  assert.equal(Object.keys(caps).length, 8, "the capability set is fixed");
  for (const [name, value] of Object.entries(caps)) {
    assert.ok(TRISTATE.includes(value as CapabilityState), `${name} is ${String(value)}`);
  }
}

describe("capabilitiesFromReport — properties", () => {
  test("coding follows exactly from its four ingredients", async () => {
    await forEachSeedAsync(async (rng) => {
      const report = randomReport(rng, "m");
      const caps = capabilitiesFromReport(report);
      assertTristate(caps);

      const ingredients: CapabilityState[] = [caps.chat, caps.streaming, caps.toolCalling];
      const roundtrip = report.capabilities["tools_roundtrip"]?.status;
      ingredients.push(roundtrip === "pass" ? true : roundtrip === "fail" ? false : "unknown");

      if (ingredients.includes(false)) {
        assert.equal(caps.coding, false, "one measured failure settles it");
      } else if (ingredients.includes("unknown")) {
        assert.equal(caps.coding, "unknown", "an unmeasured ingredient must not become a verdict");
      } else {
        assert.equal(caps.coding, true);
      }
    });
  });

  test("what was never asked is never claimed", async () => {
    await forEachSeedAsync(async (rng) => {
      // The probe has no embedding or rerank request, so it can have no opinion,
      // however capable the model turned out to be at everything else.
      const caps = capabilitiesFromReport(randomReport(rng, "m"));
      assert.equal(caps.embedding, "unknown");
      assert.equal(caps.reranking, "unknown");
    });
  });

  test("a 403 or an outage never reads as a deficiency", async () => {
    await forEachSeedAsync(async (rng) => {
      const inconclusive = rng.pick<CapabilityStatus>(["denied", "unknown", "skipped"]);
      const report: ModelReport = {
        modelId: "m",
        capabilities: {
          chat: { status: inconclusive },
          stream: { status: inconclusive },
          tools: { status: inconclusive },
        } as ModelReport["capabilities"],
        limits: { observedContextWindow: null, observedMaxOutputTokens: null, latencyMs: null },
        eligibility: { responseCompare: false, codingAgent: false, patchMode: false, judge: false, reasons: [] },
      };
      const caps = capabilitiesFromReport(report);
      assert.equal(caps.chat, "unknown");
      assert.equal(caps.streaming, "unknown");
      assert.equal(caps.toolCalling, "unknown");
      assert.equal(caps.coding, "unknown");
    }, Math.max(1, Math.floor(fuzzIterations() / 3)));
  });
});

describe("HasaCapabilityProbe — properties over operation sequences", () => {
  test("lookups stay consistent through loads, probes and invalidations", async () => {
    await forEachSeedAsync(async (rng) => {
      const ids = Array.from({ length: rng.int(0, 6) }, (_, i) => `m${i}`);
      const stored = randomMatrix(rng, ids);
      let probeCalls = 0;

      const probe = new HasaCapabilityProbe({
        load: async () => (rng.bool(0.8) ? stored : null),
        probe: async (probeIds) => {
          probeCalls += 1;
          assert.equal(probeIds.length, 1, "a lazy probe measures one model, not a catalogue");
          return randomMatrix(rng, probeIds);
        },
      });

      const seen = new Map<string, ModelCapabilities>();
      const operations = rng.int(1, 20);

      for (let i = 0; i < operations; i += 1) {
        const modelId = rng.bool(0.7) ? rng.pick([...ids, "never-listed"]) : rng.string(6);
        switch (rng.int(0, 5)) {
          case 0: {
            probe.invalidate();
            seen.clear();
            break;
          }
          case 1: {
            const caps = await probe.ensure(modelId);
            assertTristate(caps);
            seen.set(modelId, caps);
            break;
          }
          case 2: {
            // Concurrent readers must not disagree with each other.
            const results = await Promise.all(
              Array.from({ length: rng.int(2, 5) }, () => probe.capabilitiesOf(modelId)),
            );
            for (const caps of results) {
              assertTristate(caps);
              assert.deepEqual(caps, results[0], "two lookups of one model disagreed");
            }
            break;
          }
          case 3: {
            const limits = await probe.limitsOf(modelId);
            assert.ok(limits.maxOutputTokens === null || limits.maxOutputTokens > 0);
            assert.ok(limits.contextWindow === null || limits.contextWindow > 0);
            break;
          }
          default: {
            const caps = await probe.capabilitiesOf(modelId);
            assertTristate(caps);
            const before = seen.get(modelId);
            if (before !== undefined) {
              // Nothing between a measurement and a read can change the answer.
              assert.deepEqual(caps, before, `${modelId} changed without being re-measured`);
            }
            seen.set(modelId, caps);
            break;
          }
        }
      }

      assert.ok(probeCalls >= 0);
    });
  });

  test("concurrent ensure for one model never doubles up on requests", async () => {
    await forEachSeedAsync(async (rng) => {
      let probeCalls = 0;
      const probe = new HasaCapabilityProbe({
        load: async () => null,
        probe: async (ids) => {
          probeCalls += 1;
          await Promise.resolve();
          return randomMatrix(rng, ids);
        },
      });

      const callers = rng.int(2, 12);
      const results = await Promise.all(Array.from({ length: callers }, () => probe.ensure("m")));

      assert.equal(probeCalls, 1, `${callers} callers produced ${probeCalls} inference requests`);
      for (const caps of results) {
        assertTristate(caps);
        assert.deepEqual(caps, results[0], "callers of one probe must get one answer");
      }
    }, Math.max(1, Math.floor(fuzzIterations() / 3)));
  });
});
