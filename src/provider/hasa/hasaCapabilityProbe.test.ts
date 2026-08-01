import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { CapabilityMatrix, CapabilityStatus, ModelReport } from "../../protocol/index.ts";
import {
  HasaCapabilityProbe,
  capabilitiesFromReport,
  emptyCapabilityProbe,
  stateOf,
} from "./hasaCapabilityProbe.ts";

function report(
  modelId: string,
  caps: Partial<Record<string, CapabilityStatus>>,
  maxOutput: number | null = 32768,
): ModelReport {
  const capabilities: Record<string, { status: CapabilityStatus }> = {};
  for (const [name, status] of Object.entries(caps)) {
    if (status !== undefined) capabilities[name] = { status };
  }
  return {
    modelId,
    capabilities: capabilities as ModelReport["capabilities"],
    limits: { observedContextWindow: null, observedMaxOutputTokens: maxOutput, latencyMs: null },
    eligibility: { responseCompare: true, codingAgent: false, patchMode: false, judge: false, reasons: [] },
  };
}

function matrix(models: ModelReport[]): CapabilityMatrix {
  return {
    schemaVersion: 1,
    probeVersion: "probe-v1",
    probedAt: "2026-07-29T00:00:00.000Z",
    baseUrl: "https://open.hasa.re.kr/v1",
    keyFingerprint: "sha256:000000000000",
    models,
  };
}

describe("stateOf", () => {
  test("only pass proves a capability and only fail disproves one", () => {
    assert.equal(stateOf("pass"), true);
    assert.equal(stateOf("fail"), false);
  });

  test("denied, skipped, unknown and absent all mean unknown", () => {
    // A 403 says the key cannot reach the model — nothing was learned about
    // the model. Folding that into `false` would record a permission problem
    // as a permanent model deficiency.
    assert.equal(stateOf("denied"), "unknown");
    assert.equal(stateOf("skipped"), "unknown");
    assert.equal(stateOf("unknown"), "unknown");
    assert.equal(stateOf(undefined), "unknown");
  });
});

describe("capabilitiesFromReport", () => {
  test("a fully measured agent model", () => {
    const caps = capabilitiesFromReport(
      report("exaone-4.0-32b", {
        chat: "pass",
        stream: "pass",
        tools: "pass",
        tools_roundtrip: "pass",
        vision: "fail",
      }),
    );
    assert.equal(caps.chat, true);
    assert.equal(caps.streaming, true);
    assert.equal(caps.toolCalling, true);
    assert.equal(caps.coding, true);
    assert.equal(caps.vision, false);
  });

  test("coding needs the round trip, not just the first tool call", () => {
    // A model that emits a tool call but cannot consume the result cannot take
    // a second step, which is the whole of an agent loop.
    const caps = capabilitiesFromReport(
      report("m", { chat: "pass", stream: "pass", tools: "pass", tools_roundtrip: "fail" }),
    );
    assert.equal(caps.toolCalling, true);
    assert.equal(caps.coding, false);
  });

  test("one unknown ingredient makes coding unknown, not false", () => {
    const caps = capabilitiesFromReport(
      report("m", { chat: "pass", stream: "pass", tools: "denied", tools_roundtrip: "skipped" }),
    );
    assert.equal(caps.toolCalling, "unknown");
    assert.equal(caps.coding, "unknown");
  });

  test("a measured failure still wins over an unknown", () => {
    const caps = capabilitiesFromReport(report("m", { chat: "fail", stream: "unknown" }));
    assert.equal(caps.coding, false);
  });

  test("embedding and reranking stay unknown — the probe never asks", () => {
    const caps = capabilitiesFromReport(report("bge-m3", { chat: "fail" }));
    assert.equal(caps.embedding, "unknown");
    assert.equal(caps.reranking, "unknown");
  });

  test("a model measured as gateway-blocked reads as tools:false, not unknown", () => {
    // qwen2.5-coder-32b in the recorded matrix: the model can call tools, the
    // vLLM deployment was started without --tool-call-parser. The probe
    // recorded `fail`, and this layer reports what was recorded.
    const caps = capabilitiesFromReport(
      report("qwen2.5-coder-32b", { chat: "pass", stream: "pass", tools: "fail", tools_roundtrip: "skipped" }),
    );
    assert.equal(caps.toolCalling, false);
    assert.equal(caps.coding, false);
  });
});

describe("HasaCapabilityProbe", () => {
  test("an unmeasured model is unknown across the board", async () => {
    const caps = await emptyCapabilityProbe().capabilitiesOf("anything");
    assert.deepEqual(Object.values(caps), new Array(8).fill("unknown"));
  });

  test("reads measured capabilities and limits", async () => {
    const probe = new HasaCapabilityProbe({
      load: async () => matrix([report("m", { chat: "pass", stream: "pass" }, 8192)]),
    });
    assert.equal((await probe.capabilitiesOf("m")).chat, true);
    assert.equal((await probe.limitsOf("m")).maxOutputTokens, 8192);
    assert.equal((await probe.limitsOf("absent")).maxOutputTokens, null);
  });

  test("the matrix is loaded once, however many models are asked about", async () => {
    let loads = 0;
    const probe = new HasaCapabilityProbe({
      load: async () => {
        loads += 1;
        return matrix([report("a", { chat: "pass" }), report("b", { chat: "pass" })]);
      },
    });

    await Promise.all([probe.capabilitiesOf("a"), probe.capabilitiesOf("b"), probe.capabilitiesOf("a")]);
    assert.equal(loads, 1);
  });

  test("capabilitiesOf never sends a request", async () => {
    // §12: extension startup must not fire inference at every catalogue entry.
    let probed = 0;
    const probe = new HasaCapabilityProbe({
      load: async () => null,
      probe: async () => {
        probed += 1;
        return matrix([]);
      },
    });

    await probe.capabilitiesOf("m");
    await probe.capabilitiesOf("n");
    assert.equal(probed, 0);
  });

  test("ensure measures a model that has never been measured", async () => {
    const probedIds: string[][] = [];
    const probe = new HasaCapabilityProbe({
      load: async () => null,
      probe: async (ids) => {
        probedIds.push(ids);
        return matrix([report("m", { chat: "pass", stream: "pass", tools: "pass", tools_roundtrip: "pass" })]);
      },
    });

    const caps = await probe.ensure("m");
    assert.deepEqual(probedIds, [["m"]], "one model, not the catalogue");
    assert.equal(caps.coding, true);

    // Second call is served from the merged matrix.
    await probe.ensure("m");
    assert.equal(probedIds.length, 1);
  });

  test("ensure leaves an already-measured model alone", async () => {
    let probed = 0;
    const probe = new HasaCapabilityProbe({
      load: async () => matrix([report("m", { chat: "pass" })]),
      probe: async () => {
        probed += 1;
        return matrix([]);
      },
    });

    assert.equal((await probe.ensure("m")).chat, true);
    assert.equal(probed, 0);
  });

  test("ensure without a probe returns unknown instead of pretending", async () => {
    const caps = await new HasaCapabilityProbe({ load: async () => null }).ensure("m");
    assert.equal(caps.chat, "unknown");
  });

  test("a fresh probe result merges into what was already known", async () => {
    const probe = new HasaCapabilityProbe({
      load: async () => matrix([report("old", { chat: "pass" })]),
      probe: async () => matrix([report("new", { chat: "pass", stream: "pass" })]),
    });

    await probe.ensure("new");
    assert.equal((await probe.capabilitiesOf("old")).chat, true, "existing measurements survive");
    assert.equal((await probe.capabilitiesOf("new")).streaming, true);
  });

  test("a failure to persist does not lose a result we paid for", async () => {
    const probe = new HasaCapabilityProbe({
      load: async () => null,
      probe: async () => matrix([report("m", { chat: "pass" })]),
      save: async () => {
        throw new Error("disk full");
      },
    });

    assert.equal((await probe.ensure("m")).chat, true);
  });

  test("an unreadable matrix is treated as nothing measured", async () => {
    const probe = new HasaCapabilityProbe({
      load: async () => {
        throw new Error("no such file");
      },
    });
    assert.equal((await probe.capabilitiesOf("m")).chat, "unknown");
  });

  test("invalidate forces a reload", async () => {
    let loads = 0;
    const probe = new HasaCapabilityProbe({
      load: async () => {
        loads += 1;
        return matrix([report("m", { chat: "pass" })]);
      },
    });

    await probe.capabilitiesOf("m");
    probe.invalidate();
    await probe.capabilitiesOf("m");
    assert.equal(loads, 2);
  });

  test("eligibility comes back as the probe computed it", async () => {
    const probe = new HasaCapabilityProbe({
      load: async () => matrix([report("m", { chat: "pass" })]),
    });
    assert.equal((await probe.eligibilityOf("m"))?.responseCompare, true);
    assert.equal(await probe.eligibilityOf("absent"), null);
  });
});
