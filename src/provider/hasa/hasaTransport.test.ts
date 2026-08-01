import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { HasaClient } from "../../hasa-client/client.ts";
import { HasaError } from "../../hasa-client/errors.ts";
import { nullLogger } from "../../hasa-client/logger.ts";
import { clearSecrets } from "../../hasa-client/redact.ts";
import { startMockHasa, type MockHasaServer } from "../../testing/mock-hasa.ts";
import { HasaTransport, createHasaTransport } from "./hasaTransport.ts";
import { HASA_DEFAULT_BASE_URL } from "./defaults.ts";

/**
 * The adapter between `HasaClient` and the provider contract.
 *
 * Thirty lines of shape-matching, and the seam that keeps the provider from
 * growing a second HTTP client. What it must not do is change behaviour — so
 * these tests are mostly about what passes through untouched.
 */

let mock: MockHasaServer;

before(async () => {
  mock = await startMockHasa({
    models: [
      { id: "m/owned", tools: "native", jsonObject: true },
      { id: "m/anonymous" },
      { id: "m/down", behavior: "unavailable" },
    ],
  });
});

after(async () => {
  await mock.close();
  clearSecrets();
});

function transport(overrides: { maxRetries?: number } = {}): HasaTransport {
  return createHasaTransport({
    apiKey: mock.apiKey,
    baseUrl: mock.url,
    logger: nullLogger,
    ...(overrides.maxRetries === undefined ? {} : { maxRetries: overrides.maxRetries }),
  });
}

describe("construction", () => {
  test("defaults to the HASA gateway when no base URL is given", () => {
    const built = createHasaTransport({ apiKey: "hasa-live-key-0123456789abcdef", logger: nullLogger });
    assert.equal(built.baseUrl, HASA_DEFAULT_BASE_URL);
    assert.equal(built.baseUrl, "https://open.hasa.re.kr/v1");
  });

  test("wraps an existing client rather than building a second one", () => {
    const client = new HasaClient({ apiKey: mock.apiKey, baseUrl: mock.url, logger: nullLogger });
    const wrapped = new HasaTransport(client);
    assert.equal(wrapped.client, client);
    assert.equal(wrapped.baseUrl, client.baseUrl);
  });

  test("the client is reachable, so the Arena can share one connection", () => {
    assert.ok(transport().client instanceof HasaClient);
  });

  test("an empty key is refused by the client it delegates to", () => {
    assert.throws(() => createHasaTransport({ apiKey: "" }));
  });
});

describe("listModelRecords", () => {
  // `owned_by` → `ownedBy` is the one field name that crosses this boundary.
  // Getting it wrong shows up as every model appearing unowned, which reads
  // like a gateway change rather than a mapping bug.
  test("reports each model, with a null owner when the gateway gives none", async () => {
    const records = await transport().listModelRecords();
    assert.deepEqual(records.map((r) => r.id), ["m/owned", "m/anonymous", "m/down"]);
    assert.equal(records[0]?.ownedBy, "mock");
    assert.ok(records.every((r) => r.ownedBy === null || typeof r.ownedBy === "string"));
  });

  test("returns plain data — nothing from the client leaks through", async () => {
    const records = await transport().listModelRecords();
    for (const record of records) {
      assert.deepEqual(Object.keys(record).sort(), ["id", "ownedBy"]);
    }
  });

  test("options reach the client", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(transport().listModelRecords({ signal: controller.signal }));
  });
});

describe("chat and streaming pass through unchanged", () => {
  test("a completion comes back in the gateway's own shape", async () => {
    const res = await transport().chat({
      model: "m/owned",
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_tokens: 16,
    });
    assert.equal(res.choices[0]?.message.content, "OK");
  });

  test("chunks arrive as the client decoded them", async () => {
    const chunks = [];
    for await (const chunk of transport().streamChunks({
      model: "m/owned",
      messages: [{ role: "user", content: "Count from 1 to 5, separated by spaces." }],
    })) {
      chunks.push(chunk);
    }
    assert.ok(chunks.length > 1);
    const text = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
    assert.equal(text, "1 2 3 4 5");
  });

  test("the client's error taxonomy is not rewritten here", async () => {
    // Classification is the provider's job, one layer up. An adapter that
    // started interpreting errors would give us two places to look.
    await assert.rejects(
      transport({ maxRetries: 0 }).chat({ model: "m/down", messages: [{ role: "user", content: "hi" }] }),
      (e: unknown) => e instanceof HasaError && e.kind === "unavailable",
    );
  });

  test("a streaming failure also arrives as the client's error", async () => {
    await assert.rejects(
      (async () => {
        for await (const _ of transport({ maxRetries: 0 }).streamChunks({
          model: "m/down",
          messages: [{ role: "user", content: "hi" }],
        })) {
          void _;
        }
      })(),
      (e: unknown) => e instanceof HasaError,
    );
  });

  test("streamChunks is lazy — nothing is sent until it is pulled", async () => {
    const before = mock.stats.requests;
    const iterable = transport().streamChunks({
      model: "m/owned",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(mock.stats.requests, before, "creating the iterable must not open a connection");

    const iterator = iterable[Symbol.asyncIterator]();
    await iterator.next();
    assert.ok(mock.stats.requests > before);
    await iterator.return?.(undefined);
  });
});
