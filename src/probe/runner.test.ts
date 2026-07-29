import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMockHasa, type MockHasaServer } from "../testing/mock-hasa.ts";
import { HasaClient } from "../hasa-client/client.ts";
import { nullLogger, setLogSink } from "../hasa-client/logger.ts";
import { clearSecrets } from "../hasa-client/redact.ts";
import { HasaError } from "../hasa-client/errors.ts";
import { runProbes } from "./runner.ts";
import type { CapabilityMatrix, ModelReport } from "../protocol/index.ts";

let mock: MockHasaServer;

before(async () => {
  mock = await startMockHasa({
    models: [
      {
        id: "mock/full",
        tools: "native",
        multiTool: true,
        jsonObject: true,
        jsonSchema: true,
        maxTokensLimit: 16384,
      },
      { id: "mock/no-tools", tools: "none", jsonObject: true, maxTokensLimit: 8192 },
      { id: "mock/forbidden", behavior: "forbidden" },
      { id: "mock/small", tools: "none", jsonObject: true, maxTokensLimit: 1024 },
      // Reasoning-style model: silent until given a real budget.
      { id: "mock/slow-starter", tools: "none", jsonObject: true, minTokensForContent: 500, maxTokensLimit: 8192 },
      // Capable model behind a gateway that never enabled tool calling.
      { id: "mock/tools-blocked", tools: "native", toolsServerDisabled: true, jsonObject: true, maxTokensLimit: 8192 },
      // Gateway that allows tools only when the choice is coerced.
      { id: "mock/needs-required", tools: "native", toolsRejectAuto: true, jsonObject: true, maxTokensLimit: 8192 },
      // Answers correctly but renders the value with an en-dash and markdown.
      { id: "mock/typographic", tools: "native", typographicOutput: true, jsonObject: true, maxTokensLimit: 8192 },
    ],
  });
});

after(async () => {
  await mock.close();
  clearSecrets();
});

function client(overrides: { apiKey?: string } = {}): HasaClient {
  return new HasaClient({
    apiKey: overrides.apiKey ?? mock.apiKey,
    baseUrl: mock.url,
    logger: nullLogger,
    maxRetries: 1,
    sleep: async () => {},
  });
}

function report(matrix: CapabilityMatrix, modelId: string): ModelReport {
  const found = matrix.models.find((m) => m.modelId === modelId);
  assert.ok(found, `no report for ${modelId}`);
  return found;
}

async function probeAll(models: string[]): Promise<CapabilityMatrix> {
  return runProbes({
    client: client(),
    apiKey: mock.apiKey,
    log: nullLogger,
    models,
    concurrency: 2,
  });
}

describe("runProbes", () => {
  test("model ids come from the gateway, never from source", async () => {
    const ids = await client().listModels();
    const matrix = await probeAll(ids);
    assert.deepEqual(
      matrix.models.map((m) => m.modelId).sort(),
      [
        "mock/forbidden",
        "mock/full",
        "mock/needs-required",
        "mock/no-tools",
        "mock/slow-starter",
        "mock/small",
        "mock/tools-blocked",
        "mock/typographic",
      ],
    );
  });

  test("a model that is silent on a small budget is retried with a larger one", async () => {
    // Regression: probing with one tight max_tokens reported reasoning-style
    // models as broken when they had simply been cut off mid-thought.
    const matrix = await probeAll(["mock/slow-starter"]);
    const r = report(matrix, "mock/slow-starter");
    assert.equal(r.capabilities["chat"]?.status, "pass");
    assert.match(r.capabilities["chat"]?.evidence ?? "", /larger budget/);
    assert.equal(r.eligibility.responseCompare, true);
  });

  test("typography is not mistaken for a failed tool round-trip", async () => {
    // Regression: an en-dash minus sign and markdown emphasis around the value
    // made a model that used the tool correctly look like it had ignored it.
    const matrix = await probeAll(["mock/typographic"]);
    const r = report(matrix, "mock/typographic");
    assert.equal(r.capabilities["tools_roundtrip"]?.status, "pass");
    assert.equal(r.eligibility.codingAgent, true);
  });

  test("a gateway that disables tool calling is distinguished from an incapable model", async () => {
    const matrix = await probeAll(["mock/tools-blocked"]);
    const r = report(matrix, "mock/tools-blocked");
    assert.equal(r.capabilities["tools"]?.status, "fail");
    assert.equal(r.capabilities["tools"]?.errorCode, "server_tool_calling_disabled");
    assert.match(r.capabilities["tools"]?.evidence ?? "", /배포 설정/);
  });

  test("tool_choice falls back from auto to a coerced mode when the gateway demands it", async () => {
    const matrix = await probeAll(["mock/needs-required"]);
    const r = report(matrix, "mock/needs-required");
    assert.equal(r.capabilities["tools"]?.status, "pass");
    assert.match(r.capabilities["tools"]?.evidence ?? "", /tool_choice=required/);
    // The dependent probes must reuse the accepted mode rather than retry auto.
    assert.equal(r.capabilities["tools_roundtrip"]?.status, "pass");
    assert.equal(r.eligibility.codingAgent, true);
  });

  test("a fully capable model passes every core probe", async () => {
    const matrix = await probeAll(["mock/full"]);
    const r = report(matrix, "mock/full");
    for (const cap of ["chat", "stream", "tools", "tools_multi", "tools_roundtrip", "tools_stream", "json_object", "json_schema"] as const) {
      assert.equal(r.capabilities[cap]?.status, "pass", `${cap} should pass`);
    }
    assert.equal(r.eligibility.codingAgent, true);
  });

  test("a model that ignores tools is recorded as fail, not as an error", async () => {
    const matrix = await probeAll(["mock/no-tools"]);
    const r = report(matrix, "mock/no-tools");
    assert.equal(r.capabilities["chat"]?.status, "pass");
    assert.equal(r.capabilities["tools"]?.status, "fail");
    assert.equal(r.eligibility.codingAgent, false);
    assert.equal(r.eligibility.patchMode, true);
  });

  test("probes that depend on a failed probe are skipped, not silently passed", async () => {
    const matrix = await probeAll(["mock/no-tools"]);
    const r = report(matrix, "mock/no-tools");
    assert.equal(r.capabilities["tools_multi"]?.status, "skipped");
    assert.equal(r.capabilities["tools_roundtrip"]?.status, "skipped");
    assert.match(r.capabilities["tools_multi"]?.evidence ?? "", /tools/);
  });

  test("403 stops further requests for that model and marks it denied", async () => {
    const before = mock.stats.byModel.get("mock/forbidden") ?? 0;
    const matrix = await probeAll(["mock/forbidden"]);
    const r = report(matrix, "mock/forbidden");
    assert.equal(r.capabilities["chat"]?.status, "denied");
    assert.equal(r.capabilities["chat"]?.httpStatus, 403);
    assert.equal(r.eligibility.responseCompare, false);
    const spent = (mock.stats.byModel.get("mock/forbidden") ?? 0) - before;
    assert.equal(spent, 1, "a denied model must not burn one request per probe");
    for (const cap of ["stream", "tools", "json_object"] as const) {
      assert.equal(r.capabilities[cap]?.status, "skipped");
    }
  });

  test("the max_tokens ladder finds the real ceiling", async () => {
    const matrix = await probeAll(["mock/full", "mock/small"]);
    assert.equal(report(matrix, "mock/full").limits.observedMaxOutputTokens, 16384);
    assert.equal(report(matrix, "mock/small").limits.observedMaxOutputTokens, 1024);
  });

  test("a low ceiling disqualifies a model from code work", async () => {
    const matrix = await probeAll(["mock/small"]);
    const r = report(matrix, "mock/small");
    assert.equal(r.eligibility.patchMode, false);
    assert.equal(r.eligibility.responseCompare, true);
  });

  test("401 aborts the whole run rather than producing a misleading matrix", async () => {
    await assert.rejects(
      runProbes({
        client: client({ apiKey: "definitely-not-the-key-000000" }),
        apiKey: "definitely-not-the-key-000000",
        log: nullLogger,
        models: ["mock/full"],
      }),
      (e: unknown) => e instanceof HasaError && e.kind === "auth",
    );
  });

  test("the emitted matrix leaks neither the key nor prompt text", async () => {
    const lines: string[] = [];
    const previous = setLogSink((line) => lines.push(line));
    let matrix: CapabilityMatrix;
    try {
      matrix = await probeAll(["mock/full"]);
    } finally {
      setLogSink(previous);
    }
    const serialised = JSON.stringify(matrix);
    assert.ok(!serialised.includes(mock.apiKey));
    assert.ok(!serialised.includes("What is the temperature in Seoul"));
    for (const line of lines) assert.ok(!line.includes(mock.apiKey));
  });

  test("every capability in a report carries a status — no undefined holes", async () => {
    const matrix = await probeAll(["mock/full"]);
    const r = report(matrix, "mock/full");
    for (const [name, result] of Object.entries(r.capabilities)) {
      assert.ok(result.status, `${name} has no status`);
    }
  });
});
