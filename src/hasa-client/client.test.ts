import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMockHasa, type MockHasaServer } from "../testing/mock-hasa.ts";
import { HasaClient } from "./client.ts";
import { HasaError } from "./errors.ts";
import { nullLogger } from "./logger.ts";
import { clearSecrets } from "./redact.ts";

let mock: MockHasaServer;

before(async () => {
  mock = await startMockHasa({
    models: [
      { id: "m/full", tools: "native", multiTool: true, jsonObject: true, maxTokensLimit: 16384 },
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

interface Harness {
  client: HasaClient;
  waits: number[];
}

function makeClient(overrides: { apiKey?: string; maxRetries?: number } = {}): Harness {
  const waits: number[] = [];
  const client = new HasaClient({
    apiKey: overrides.apiKey ?? mock.apiKey,
    baseUrl: mock.url,
    maxRetries: overrides.maxRetries ?? 3,
    logger: nullLogger,
    // Retries are asserted by what the client *decided* to wait, not by
    // actually waiting — otherwise the suite would take minutes.
    sleep: async (ms: number) => {
      waits.push(ms);
    },
    random: () => 0.5,
  });
  return { client, waits };
}

describe("HasaClient", () => {
  test("refuses to construct without a key", () => {
    assert.throws(() => new HasaClient({ apiKey: "" }));
  });

  test("lists models from the gateway", async () => {
    const { client } = makeClient();
    const ids = await client.listModels();
    assert.deepEqual(ids, ["m/full", "m/forbidden", "m/limited", "m/down"]);
  });

  test("completes a basic chat", async () => {
    const { client } = makeClient();
    const res = await client.chat({
      model: "m/full",
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_tokens: 16,
    });
    assert.equal(res.choices[0]?.message.content, "OK");
  });

  test("401 aborts immediately and is not retried", async () => {
    const { client, waits } = makeClient({ apiKey: "wrong-key-value-1234567890" });
    const before = mock.stats.requests;
    await assert.rejects(
      client.chat({ model: "m/full", messages: [{ role: "user", content: "hi" }] }),
      (e: unknown) => e instanceof HasaError && e.kind === "auth" && e.terminal,
    );
    assert.equal(waits.length, 0, "must not sleep for an auth failure");
    assert.equal(mock.stats.requests, before, "401 is rejected before the body is counted");
  });

  test("403 is terminal — the key simply lacks access", async () => {
    const { client, waits } = makeClient();
    const before = mock.stats.byModel.get("m/forbidden") ?? 0;
    await assert.rejects(
      client.chat({ model: "m/forbidden", messages: [{ role: "user", content: "hi" }] }),
      (e: unknown) => e instanceof HasaError && e.kind === "forbidden" && e.status === 403,
    );
    assert.equal(waits.length, 0);
    assert.equal(mock.stats.byModel.get("m/forbidden"), before + 1, "403 must not be retried");
  });

  test("404 for an unregistered model is not retried", async () => {
    const { client, waits } = makeClient();
    await assert.rejects(
      client.chat({ model: "m/does-not-exist", messages: [{ role: "user", content: "hi" }] }),
      (e: unknown) => e instanceof HasaError && e.status === 404,
    );
    assert.equal(waits.length, 0);
  });

  test("429 waits exactly as long as Retry-After says, then succeeds", async () => {
    const { client, waits } = makeClient();
    const res = await client.chat({
      model: "m/limited",
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
    });
    assert.equal(res.choices[0]?.message.content, "OK");
    assert.deepEqual(waits, [1000], "Retry-After: 1 must win over computed backoff");
  });

  test("503 is retried up to the limit and then surfaces", async () => {
    const { client, waits } = makeClient({ maxRetries: 2 });
    const before = mock.stats.byModel.get("m/down") ?? 0;
    await assert.rejects(
      client.chat({ model: "m/down", messages: [{ role: "user", content: "hi" }] }),
      (e: unknown) => e instanceof HasaError && e.kind === "unavailable",
    );
    assert.equal(mock.stats.byModel.get("m/down"), before + 3, "1 attempt + 2 retries");
    assert.equal(waits.length, 2);
    assert.ok(waits.every((w) => w >= 0), "backoff used when no Retry-After header is present");
  });

  test("400 from a too-large max_tokens is reported, not retried", async () => {
    const { client, waits } = makeClient();
    await assert.rejects(
      client.chat({ model: "m/full", messages: [{ role: "user", content: "hi" }], max_tokens: 999_999 }),
      (e: unknown) => e instanceof HasaError && e.status === 400,
    );
    assert.equal(waits.length, 0);
  });

  test("streams and reassembles content", async () => {
    const { client } = makeClient();
    const asm = await client.chatStream({
      model: "m/full",
      messages: [{ role: "user", content: "Count from 1 to 5, separated by spaces." }],
    });
    assert.equal(asm.content, "1 2 3 4 5");
    assert.ok(asm.chunkCount > 1);
    assert.equal(asm.finishReason, "stop");
  });

  test("streams and reassembles tool calls", async () => {
    const { client } = makeClient();
    const asm = await client.chatStream({
      model: "m/full",
      messages: [{ role: "user", content: "weather in Seoul" }],
      tools: [
        {
          type: "function",
          function: { name: "get_weather", parameters: { type: "object", properties: {} } },
        },
      ],
    });
    assert.equal(asm.toolCalls.length, 1);
    assert.deepEqual(JSON.parse(asm.toolCalls[0]?.function.arguments ?? "{}"), { city: "Seoul" });
  });

  test("an aborted request is not retried", async () => {
    const { client, waits } = makeClient();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      client.chat(
        { model: "m/full", messages: [{ role: "user", content: "hi" }] },
        { signal: controller.signal },
      ),
    );
    assert.equal(waits.length, 0);
  });

  test("the error body snippet carries no authorization material", async () => {
    const { client } = makeClient();
    try {
      await client.chat({ model: "m/forbidden", messages: [{ role: "user", content: "hi" }] });
      assert.fail("expected rejection");
    } catch (err) {
      assert.ok(err instanceof HasaError);
      assert.ok(!(err.bodySnippet ?? "").includes(mock.apiKey));
      assert.ok(!JSON.stringify(err.message).includes(mock.apiKey));
    }
  });
});
