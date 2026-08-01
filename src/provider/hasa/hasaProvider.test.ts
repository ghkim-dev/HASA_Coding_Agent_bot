import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { nullLogger } from "../../hasa-client/logger.ts";
import { clearSecrets } from "../../hasa-client/redact.ts";
import { startMockHasa, type MockHasaServer } from "../../testing/mock-hasa.ts";
import { MemoryModelCache } from "../modelCache.ts";
import { ProviderError } from "../errors.ts";
import type { ProviderStreamEvent } from "../types.ts";
import { HasaCapabilityProbe } from "./hasaCapabilityProbe.ts";
import { HasaProvider, orderValidationCandidates } from "./hasaProvider.ts";

const WRONG_KEY = "wrong-key-value-0123456789";

let mock: MockHasaServer;

before(async () => {
  mock = await startMockHasa({
    models: [
      { id: "exaone-4.0-32b", tools: "native", multiTool: true, jsonObject: true, maxTokensLimit: 32768 },
      { id: "qwen2.5-coder-32b", tools: "none", jsonObject: true },
      { id: "m/forbidden", behavior: "forbidden" },
      { id: "m/limited", behavior: "rate_limit_once", tools: "none" },
      { id: "m/down", behavior: "unavailable" },
    ],
  });
});

after(async () => {
  await mock.close();
  clearSecrets();
});

function provider(overrides: { apiKey?: string; capabilities?: HasaCapabilityProbe } = {}): HasaProvider {
  return new HasaProvider({
    apiKey: overrides.apiKey ?? mock.apiKey,
    baseUrl: mock.url,
    cache: new MemoryModelCache(),
    modelCacheTtlMs: 0,
    logger: nullLogger,
    ...(overrides.capabilities === undefined ? {} : { capabilities: overrides.capabilities }),
  });
}

async function collect(events: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("HasaProvider — construction", () => {
  test("identifies itself and its gateway", () => {
    const p = provider();
    assert.equal(p.id, "hasa");
    assert.equal(p.displayName, "HASA Open API");
    assert.equal(p.baseUrl, mock.url);
  });

  test("refuses an unusable key before any request goes out", () => {
    assert.throws(
      () => new HasaProvider({ apiKey: "", baseUrl: mock.url }),
      (e: unknown) => e instanceof ProviderError && e.code === "config",
    );
  });

  test("exposes a fingerprint, not the key", () => {
    const p = provider();
    assert.match(p.keyFingerprint, /^sha256:[0-9a-f]{12}$/);
    assert.ok(!p.keyFingerprint.includes(mock.apiKey));
  });
});

describe("HasaProvider — models", () => {
  test("lists the gateway's catalogue", async () => {
    const listing = await provider().listModels();
    assert.deepEqual(listing.models.map((m) => m.id), [
      "exaone-4.0-32b",
      "qwen2.5-coder-32b",
      "m/forbidden",
      "m/limited",
      "m/down",
    ]);
    assert.equal(listing.source, "network");
  });

  test("attaches measured capabilities, and only measured ones", async () => {
    const capabilities = new HasaCapabilityProbe({
      load: async () => ({
        schemaVersion: 1,
        probeVersion: "probe-v1",
        probedAt: "2026-07-29T00:00:00.000Z",
        baseUrl: mock.url,
        keyFingerprint: "sha256:000000000000",
        models: [
          {
            modelId: "exaone-4.0-32b",
            capabilities: {
              chat: { status: "pass" },
              stream: { status: "pass" },
              tools: { status: "pass" },
              tools_roundtrip: { status: "pass" },
            },
            limits: { observedContextWindow: null, observedMaxOutputTokens: 32768, latencyMs: null },
            eligibility: { responseCompare: true, codingAgent: true, patchMode: false, judge: true, reasons: [] },
          },
          {
            modelId: "qwen2.5-coder-32b",
            capabilities: {
              chat: { status: "pass" },
              stream: { status: "pass" },
              // The gateway refuses tool_choice; the model itself is capable.
              tools: { status: "fail", errorCode: "server_tool_calling_disabled" },
              tools_roundtrip: { status: "skipped" },
            },
            limits: { observedContextWindow: null, observedMaxOutputTokens: 32768, latencyMs: null },
            eligibility: { responseCompare: true, codingAgent: false, patchMode: true, judge: true, reasons: [] },
          },
        ],
      }),
    });

    const listing = await provider({ capabilities }).listModels();
    const byId = new Map(listing.models.map((m) => [m.id, m]));

    assert.equal(byId.get("exaone-4.0-32b")?.capabilities.toolCalling, true);
    assert.equal(byId.get("exaone-4.0-32b")?.capabilities.coding, true);
    assert.equal(byId.get("exaone-4.0-32b")?.limits.maxOutputTokens, 32768);

    assert.equal(byId.get("qwen2.5-coder-32b")?.capabilities.toolCalling, false);
    assert.equal(byId.get("qwen2.5-coder-32b")?.capabilities.coding, false);

    // Never probed. A model named "coder" gets no credit for its name.
    assert.equal(byId.get("m/down")?.capabilities.coding, "unknown");
    assert.equal(byId.get("m/down")?.capabilities.chat, "unknown");
  });
});

describe("HasaProvider — chat", () => {
  test("returns a normalised response", async () => {
    const res = await provider().chat({
      modelId: "exaone-4.0-32b",
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      maxOutputTokens: 16,
    });

    assert.equal(res.text, "OK");
    assert.equal(res.finishReason, "stop");
    assert.deepEqual(res.toolCalls, []);
    assert.equal(res.usage?.inputTokens, 10);
  });

  test("tool calls come back normalised, with no OpenAI shapes attached", async () => {
    const res = await provider().chat({
      modelId: "exaone-4.0-32b",
      messages: [{ role: "user", content: "weather in Seoul" }],
      tools: [{ name: "get_weather", parameters: { type: "object", properties: {} } }],
    });

    assert.equal(res.finishReason, "tool_calls");
    assert.equal(res.toolCalls.length, 1);
    const call = res.toolCalls[0];
    assert.equal(call?.name, "get_weather");
    assert.deepEqual(call?.arguments, { city: "Seoul" });
    assert.equal(call?.argumentsValid, true);
    assert.deepEqual(Object.keys(call ?? {}).sort(), [
      "arguments",
      "argumentsValid",
      "id",
      "name",
      "rawArguments",
    ]);
  });

  test("a tool result round-trips back to the model", async () => {
    const p = provider();
    const first = await p.chat({
      modelId: "exaone-4.0-32b",
      messages: [{ role: "user", content: "weather in Seoul" }],
      tools: [{ name: "get_weather", parameters: { type: "object", properties: {} } }],
    });

    const second = await p.chat({
      modelId: "exaone-4.0-32b",
      messages: [
        { role: "user", content: "weather in Seoul" },
        { role: "assistant", content: null, toolCalls: first.toolCalls },
        { role: "tool", toolCallId: first.toolCalls[0]?.id ?? "", content: JSON.stringify({ celsius: -17.5 }) },
      ],
    });

    assert.match(second.text, /-17\.5/);
  });
});

describe("HasaProvider — streaming", () => {
  test("emits text deltas and a single done", async () => {
    const events = await collect(
      provider().stream({
        modelId: "exaone-4.0-32b",
        messages: [{ role: "user", content: "Count from 1 to 5, separated by spaces." }],
      }),
    );

    const text = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    assert.equal(text, "1 2 3 4 5");
    assert.equal(events.filter((e) => e.type === "done").length, 1);
    assert.deepEqual(events.at(-1), { type: "done", finishReason: "stop" });
  });

  test("assembles a streamed tool call across frames", async () => {
    const events = await collect(
      provider().stream({
        modelId: "exaone-4.0-32b",
        messages: [{ role: "user", content: "weather in Seoul" }],
        tools: [{ name: "get_weather", parameters: { type: "object", properties: {} } }],
      }),
    );

    const start = events.find((e) => e.type === "tool_call_start");
    const end = events.find((e) => e.type === "tool_call_end");
    assert.equal((start as { name: string } | undefined)?.name, "get_weather");
    assert.deepEqual((end as { toolCall: { arguments: unknown } } | undefined)?.toolCall.arguments, {
      city: "Seoul",
    });
    assert.equal(events.at(-1)?.type, "done");
  });

  test("a stream error surfaces as a ProviderError, not a transport error", async () => {
    // The transport is an async generator: it does not fail until it is pulled,
    // so an error map placed only around the call would miss this.
    await assert.rejects(
      collect(provider().stream({ modelId: "m/down", messages: [{ role: "user", content: "hi" }] }, { maxRetries: 0 })),
      (e: unknown) => e instanceof ProviderError && e.code === "unavailable",
    );
  });
});

describe("HasaProvider — errors", () => {
  test("401 means the key is wrong, and is terminal", async () => {
    await assert.rejects(
      provider({ apiKey: WRONG_KEY }).chat({
        modelId: "exaone-4.0-32b",
        messages: [{ role: "user", content: "hi" }],
      }),
      (e: unknown) =>
        e instanceof ProviderError && e.code === "unauthorized" && e.terminal && !e.retryable,
    );
  });

  test("403 means the model is wrong, not the key", async () => {
    await assert.rejects(
      provider().chat({ modelId: "m/forbidden", messages: [{ role: "user", content: "hi" }] }),
      (e: unknown) => {
        assert.ok(e instanceof ProviderError);
        assert.equal(e.code, "forbidden");
        assert.equal(e.httpStatus, 403);
        // The instruction must not be "re-enter your key".
        assert.match(e.userMessage, /모델/);
        assert.doesNotMatch(e.userMessage, /API Key가 유효하지/);
        return true;
      },
    );
  });

  test("404 is a missing model", async () => {
    await assert.rejects(
      provider().chat({ modelId: "m/never-registered", messages: [{ role: "user", content: "hi" }] }),
      (e: unknown) => e instanceof ProviderError && e.code === "model_not_found",
    );
  });

  test("429 is retryable and carries the advertised wait", async () => {
    await assert.rejects(
      provider().chat(
        { modelId: "m/limited", messages: [{ role: "user", content: "hi" }] },
        { maxRetries: 0 },
      ),
      (e: unknown) =>
        e instanceof ProviderError &&
        e.code === "rate_limited" &&
        e.retryable &&
        e.retryAfterMs === 1000,
    );
  });

  test("503 is retryable", async () => {
    await assert.rejects(
      provider().chat({ modelId: "m/down", messages: [{ role: "user", content: "hi" }] }, { maxRetries: 0 }),
      (e: unknown) => e instanceof ProviderError && e.code === "unavailable" && e.retryable,
    );
  });

  test("a cancelled request reads as cancelled, not as a network fault", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      provider().chat(
        { modelId: "exaone-4.0-32b", messages: [{ role: "user", content: "hi" }] },
        { signal: controller.signal },
      ),
      (e: unknown) => e instanceof ProviderError && e.code === "aborted" && !e.retryable,
    );
  });

  test("no error surface carries key material", async () => {
    try {
      await provider().chat({ modelId: "m/forbidden", messages: [{ role: "user", content: "hi" }] });
      assert.fail("expected rejection");
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      const surfaces = [err.message, err.detail, err.userMessage, JSON.stringify(err.toJSON())];
      for (const surface of surfaces) {
        assert.ok(!surface.includes(mock.apiKey), `leaked the key in: ${surface}`);
      }
    }
  });

  test("the JSON form is safe to hand to a webview", () => {
    const json = new ProviderError({ code: "forbidden", detail: "some detail" }).toJSON();
    assert.deepEqual(Object.keys(json).sort(), [
      "allowedModels",
      "code",
      "detail",
      "httpStatus",
      "retryAfterMs",
      "retryable",
      "terminal",
      "userMessage",
    ]);
  });
});

describe("HasaProvider — validation", () => {
  test("a public model list is not proof that the key works", async () => {
    // This is the whole point. HASA answers GET /v1/models without a key, so a
    // provider that stopped at "the list came back" would report a typo'd key
    // as connected and let the user find out on their first real request.
    const result = await provider({ apiKey: WRONG_KEY }).validate();

    assert.equal(result.endpointReachable, true);
    assert.ok(result.modelCount > 0);
    assert.equal(result.credentialValid, false);
    assert.match(result.detail, /API Key/);
    assert.equal(result.error?.code, "unauthorized");
  });

  test("a working key validates against a real model", async () => {
    const result = await provider().validate();
    assert.equal(result.endpointReachable, true);
    assert.equal(result.credentialValid, true);
    assert.equal(result.probedModelId, "exaone-4.0-32b");
    assert.equal(result.error, null);
    assert.match(result.detail, /연결되었습니다/);
  });

  test("a key that can reach nothing but authenticates is still valid", async () => {
    const forbiddenOnly = await startMockHasa({ models: [{ id: "m/forbidden", behavior: "forbidden" }] });
    try {
      const p = new HasaProvider({ apiKey: forbiddenOnly.apiKey, baseUrl: forbiddenOnly.url, logger: nullLogger });
      const result = await p.validate();

      // 403 proves the credential was accepted. Reporting it as invalid would
      // send the user off to regenerate a key that works.
      assert.equal(result.credentialValid, true);
      assert.equal(result.probedModelId, "m/forbidden");
      assert.equal(result.error, null);
    } finally {
      await forbiddenOnly.close();
    }
  });

  test("an unrouted model is skipped rather than blamed on the key", async () => {
    const withDeadModel = await startMockHasa({
      models: [
        { id: "bge-m3", behavior: "not_found" },
        { id: "exaone-4.0-32b", jsonObject: true },
      ],
    });
    try {
      const p = new HasaProvider({ apiKey: withDeadModel.apiKey, baseUrl: withDeadModel.url, logger: nullLogger });
      const result = await p.validate();

      assert.equal(result.credentialValid, true);
      assert.equal(result.probedModelId, "exaone-4.0-32b");
    } finally {
      await withDeadModel.close();
    }
  });

  test("an outage leaves the credential unknown, never false", async () => {
    const down = await startMockHasa({ models: [{ id: "m/down", behavior: "unavailable" }] });
    try {
      const p = new HasaProvider({ apiKey: down.apiKey, baseUrl: down.url, logger: nullLogger });
      const result = await p.validate();

      assert.equal(result.endpointReachable, true);
      assert.equal(result.credentialValid, "unknown");
      assert.equal(result.error?.code, "unavailable");
    } finally {
      await down.close();
    }
  });

  test("an empty catalogue leaves nothing to probe with", async () => {
    const empty = await startMockHasa({ models: [] });
    try {
      const p = new HasaProvider({ apiKey: empty.apiKey, baseUrl: empty.url, logger: nullLogger });
      const result = await p.validate();

      assert.equal(result.endpointReachable, true);
      assert.equal(result.modelCount, 0);
      assert.equal(result.credentialValid, "unknown");
      assert.equal(result.probedModelId, null);
    } finally {
      await empty.close();
    }
  });

  test("an unreachable gateway is reported as unreachable", async () => {
    const p = new HasaProvider({
      apiKey: "hasa-live-key-0123456789abcdef",
      baseUrl: "http://127.0.0.1:1/v1",
      timeoutMs: 500,
      logger: nullLogger,
    });
    const result = await p.validate();

    assert.equal(result.endpointReachable, false);
    assert.equal(result.credentialValid, "unknown");
    assert.equal(result.modelCount, 0);
  });

  test("validation does not retry — a waiting user should not sit through a ladder", async () => {
    const down = await startMockHasa({ models: [{ id: "m/down", behavior: "unavailable" }] });
    try {
      const p = new HasaProvider({ apiKey: down.apiKey, baseUrl: down.url, logger: nullLogger });
      await p.validate();
      assert.equal(down.stats.byModel.get("m/down"), 1);
    } finally {
      await down.close();
    }
  });

  test("no validation surface carries key material", async () => {
    const result = await provider().validate();
    assert.ok(!JSON.stringify(result).includes(mock.apiKey));
  });
});

describe("orderValidationCandidates", () => {
  test("spends the first request on a model already known to chat", () => {
    const model = (id: string, chat: boolean | "unknown"): Parameters<typeof orderValidationCandidates>[0][number] => ({
      id,
      ownedBy: null,
      limits: { maxOutputTokens: null, contextWindow: null },
      capabilities: {
        chat,
        streaming: "unknown",
        toolCalling: "unknown",
        coding: "unknown",
        reasoning: "unknown",
        vision: "unknown",
        embedding: "unknown",
        reranking: "unknown",
      },
    });

    const ordered = orderValidationCandidates([
      model("known-bad", false),
      model("unmeasured", "unknown"),
      model("known-good", true),
    ]);
    assert.deepEqual(ordered.map((m) => m.id), ["known-good", "unmeasured", "known-bad"]);
  });
});
