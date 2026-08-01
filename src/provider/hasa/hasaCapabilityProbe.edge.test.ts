import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { CapabilityMatrix, CapabilityStatus, ModelReport } from "../../protocol/index.ts";
import { HasaCapabilityProbe, capabilitiesFromReport, limitsFromReport, stateOf } from "./hasaCapabilityProbe.ts";

function report(
  modelId: string,
  caps: Partial<Record<string, CapabilityStatus>> = {},
  limits: { max?: number | null; context?: number | null } = {},
): ModelReport {
  const capabilities: Record<string, { status: CapabilityStatus }> = {};
  for (const [name, status] of Object.entries(caps)) {
    if (status !== undefined) capabilities[name] = { status };
  }
  return {
    modelId,
    capabilities: capabilities as ModelReport["capabilities"],
    limits: {
      observedContextWindow: limits.context ?? null,
      observedMaxOutputTokens: limits.max ?? null,
      latencyMs: null,
    },
    eligibility: { responseCompare: false, codingAgent: false, patchMode: false, judge: false, reasons: [] },
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

describe("stateOf — the full status vocabulary", () => {
  const statuses: CapabilityStatus[] = ["pass", "fail", "denied", "unknown", "skipped"];

  test("every status maps to a tristate, and only pass and fail are decisive", () => {
    const mapped = statuses.map((s) => [s, stateOf(s)] as const);
    assert.deepEqual(mapped, [
      ["pass", true],
      ["fail", false],
      ["denied", "unknown"],
      ["unknown", "unknown"],
      ["skipped", "unknown"],
    ]);
  });

  test("an unrecognised status is unknown rather than false", () => {
    assert.equal(stateOf("something-new" as CapabilityStatus), "unknown");
    assert.equal(stateOf(undefined), "unknown");
  });
});

describe("capabilitiesFromReport — the truth table for coding", () => {
  const T: CapabilityStatus = "pass";
  const F: CapabilityStatus = "fail";
  const U: CapabilityStatus = "denied";

  const cases: Array<[string, CapabilityStatus, CapabilityStatus, CapabilityStatus, CapabilityStatus, boolean | "unknown"]> = [
    ["all measured good", T, T, T, T, true],
    ["no chat", F, T, T, T, false],
    ["no streaming", T, F, T, T, false],
    ["no tools", T, T, F, T, false],
    ["no round trip", T, T, T, F, false],
    ["chat unmeasured", U, T, T, T, "unknown"],
    ["tools unmeasured", T, T, U, T, "unknown"],
    ["one failure beats several unknowns", F, U, U, U, false],
    ["all unmeasured", U, U, U, U, "unknown"],
  ];

  for (const [name, chat, stream, tools, roundtrip, expected] of cases) {
    test(name, () => {
      const caps = capabilitiesFromReport(
        report("m", { chat, stream, tools, tools_roundtrip: roundtrip }),
      );
      assert.equal(caps.coding, expected);
    });
  }

  test("a report with no capabilities at all is entirely unknown", () => {
    const caps = capabilitiesFromReport(report("m"));
    for (const [name, value] of Object.entries(caps)) {
      assert.equal(value, "unknown", name);
    }
  });

  test("embedding and reranking are never claimed, whatever else was measured", () => {
    const caps = capabilitiesFromReport(
      report("bge-m3", { chat: "pass", stream: "pass", tools: "pass", tools_roundtrip: "pass" }),
    );
    assert.equal(caps.embedding, "unknown");
    assert.equal(caps.reranking, "unknown");
  });

  test("a model id that reads like a capability earns nothing from its name", () => {
    for (const id of ["qwen2.5-coder-32b", "gpt-oss-20b-vision-tools", "bge-reranker-v2-m3"]) {
      const caps = capabilitiesFromReport(report(id));
      assert.equal(caps.coding, "unknown", id);
      assert.equal(caps.vision, "unknown", id);
      assert.equal(caps.reranking, "unknown", id);
    }
  });
});

describe("limitsFromReport", () => {
  test("measured limits are carried through, including zero", () => {
    assert.deepEqual(limitsFromReport(report("m", {}, { max: 32768, context: 131072 })), {
      maxOutputTokens: 32768,
      contextWindow: 131072,
    });
  });

  test("unmeasured limits are null, not zero", () => {
    assert.deepEqual(limitsFromReport(report("m")), { maxOutputTokens: null, contextWindow: null });
  });
});

describe("loading", () => {
  test("a load that never resolves does not block a second caller forever", async () => {
    let resolveLoad: (m: CapabilityMatrix | null) => void = () => {};
    const probe = new HasaCapabilityProbe({
      load: () =>
        new Promise<CapabilityMatrix | null>((resolve) => {
          resolveLoad = resolve;
        }),
    });

    const first = probe.capabilitiesOf("m");
    const second = probe.capabilitiesOf("m");
    resolveLoad(matrix([report("m", { chat: "pass" })]));

    assert.equal((await first).chat, true);
    assert.equal((await second).chat, true);
  });

  test("a load that rejects is remembered as 'nothing measured', not retried forever", async () => {
    let loads = 0;
    const probe = new HasaCapabilityProbe({
      load: async () => {
        loads += 1;
        throw new Error("no such file");
      },
    });

    await probe.capabilitiesOf("a");
    await probe.capabilitiesOf("b");
    await probe.capabilitiesOf("c");
    assert.equal(loads, 1, "a missing matrix is a fact, not a transient failure");
  });

  test("a load returning a matrix with duplicate ids uses the first", async () => {
    const probe = new HasaCapabilityProbe({
      load: async () => matrix([report("m", { chat: "pass" }), report("m", { chat: "fail" })]),
    });
    assert.equal((await probe.capabilitiesOf("m")).chat, true);
  });

  test("lookups are exact — no prefix or case matching", async () => {
    const probe = new HasaCapabilityProbe({ load: async () => matrix([report("exaone-4.0-32b", { chat: "pass" })]) });
    assert.equal((await probe.capabilitiesOf("exaone-4.0-32b")).chat, true);
    assert.equal((await probe.capabilitiesOf("EXAONE-4.0-32B")).chat, "unknown");
    assert.equal((await probe.capabilitiesOf("exaone")).chat, "unknown");
    assert.equal((await probe.capabilitiesOf("")).chat, "unknown");
  });

  test("invalidate mid-load does not attach the old result to the new generation", async () => {
    let resolveLoad: (m: CapabilityMatrix | null) => void = () => {};
    let loads = 0;
    const probe = new HasaCapabilityProbe({
      load: () => {
        loads += 1;
        return loads === 1
          ? new Promise<CapabilityMatrix | null>((resolve) => {
              resolveLoad = resolve;
            })
          : Promise.resolve(matrix([report("m", { chat: "fail" })]));
      },
    });

    const pending = probe.capabilitiesOf("m");
    probe.invalidate();
    resolveLoad(matrix([report("m", { chat: "pass" })]));
    await pending;

    assert.equal((await probe.capabilitiesOf("m")).chat, false, "the reload must win");
  });
});

describe("ensure", () => {
  test("concurrent callers for one model probe it once", async () => {
    // Every call is a live inference request against a shared GPU. Ten
    // components asking about the same model at once must not become ten
    // requests.
    let probes = 0;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const probe = new HasaCapabilityProbe({
      load: async () => null,
      probe: async (ids) => {
        probes += 1;
        await gate;
        return matrix(ids.map((id) => report(id, { chat: "pass" })));
      },
    });

    const all = Promise.all(Array.from({ length: 10 }, () => probe.ensure("m")));
    release();
    const results = await all;

    assert.equal(probes, 1, "a model is probed once, however many callers ask");
    for (const caps of results) assert.equal(caps.chat, true);
  });

  test("concurrent callers for different models probe each once", async () => {
    const probed: string[] = [];
    const probe = new HasaCapabilityProbe({
      load: async () => null,
      probe: async (ids) => {
        probed.push(...ids);
        return matrix(ids.map((id) => report(id, { chat: "pass" })));
      },
    });

    await Promise.all(["a", "b", "c"].map((id) => probe.ensure(id)));
    assert.deepEqual([...probed].sort(), ["a", "b", "c"]);
  });

  test("a failed probe is not cached as a measurement", async () => {
    let attempts = 0;
    const probe = new HasaCapabilityProbe({
      load: async () => null,
      probe: async (ids) => {
        attempts += 1;
        if (attempts === 1) throw new Error("gateway down");
        return matrix(ids.map((id) => report(id, { chat: "pass" })));
      },
    });

    await assert.rejects(probe.ensure("m"), /gateway down/);
    // A transient outage must not permanently mark the model unmeasurable.
    assert.equal((await probe.ensure("m")).chat, true);
    assert.equal(attempts, 2);
  });

  test("a probe that answers about the wrong model leaves the request unmeasured", async () => {
    const probe = new HasaCapabilityProbe({
      load: async () => null,
      probe: async () => matrix([report("some-other-model", { chat: "pass" })]),
    });
    assert.equal((await probe.ensure("m")).chat, "unknown");
  });

  test("a probe returning an empty matrix leaves the model unmeasured", async () => {
    const probe = new HasaCapabilityProbe({ load: async () => null, probe: async () => matrix([]) });
    assert.equal((await probe.ensure("m")).chat, "unknown");
  });

  test("the abort signal reaches the probe", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const probe = new HasaCapabilityProbe({
      load: async () => null,
      probe: async (ids, signal) => {
        seen = signal;
        return matrix(ids.map((id) => report(id)));
      },
    });

    await probe.ensure("m", controller.signal);
    assert.equal(seen, controller.signal);
  });

  test("merging keeps earlier measurements and the newer probe's metadata", async () => {
    const probe = new HasaCapabilityProbe({
      load: async () => matrix([report("old", { chat: "pass" }), report("shared", { chat: "fail" })]),
      probe: async () =>
        matrix([report("new", { chat: "pass" }), report("shared", { chat: "pass" })]),
    });

    await probe.ensure("new");
    assert.equal((await probe.capabilitiesOf("old")).chat, true, "untouched models survive");
    assert.equal((await probe.capabilitiesOf("new")).chat, true);
    assert.equal((await probe.capabilitiesOf("shared")).chat, true, "a fresh measurement wins");
  });

  test("invalidate discards a probed result and goes back to the stored matrix", async () => {
    let probes = 0;
    const probe = new HasaCapabilityProbe({
      load: async () => matrix([]),
      probe: async (ids) => {
        probes += 1;
        return matrix(ids.map((id) => report(id, { chat: "pass" })));
      },
    });

    await probe.ensure("m");
    probe.invalidate();
    assert.equal((await probe.capabilitiesOf("m")).chat, "unknown");
    await probe.ensure("m");
    assert.equal(probes, 2);
  });

  test("save receiving a rejected promise does not lose the measurement", async () => {
    const probe = new HasaCapabilityProbe({
      load: async () => null,
      probe: async (ids) => matrix(ids.map((id) => report(id, { chat: "pass" }))),
      save: () => Promise.reject(new Error("read-only volume")),
    });
    assert.equal((await probe.ensure("m")).chat, true);
  });

  test("save throwing synchronously does not lose the measurement", async () => {
    const probe = new HasaCapabilityProbe({
      load: async () => null,
      probe: async (ids) => matrix(ids.map((id) => report(id, { chat: "pass" }))),
      save: () => {
        throw new Error("synchronous failure");
      },
    });
    assert.equal((await probe.ensure("m")).chat, true);
  });

  test("save is called once per probe, with the probed matrix", async () => {
    const saved: CapabilityMatrix[] = [];
    const probe = new HasaCapabilityProbe({
      load: async () => null,
      probe: async (ids) => matrix(ids.map((id) => report(id, { chat: "pass" }))),
      save: async (m) => {
        saved.push(m);
      },
    });

    await probe.ensure("m");
    await probe.ensure("m");
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0]?.models.map((r) => r.modelId), ["m"]);
  });
});
