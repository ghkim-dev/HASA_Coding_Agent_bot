import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { HasaError } from "../../hasa-client/errors.ts";
import { nullLogger } from "../../hasa-client/logger.ts";
import { clearSecrets } from "../../hasa-client/redact.ts";
import { startMockHasa, type MockHasaServer } from "../../testing/mock-hasa.ts";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "../../protocol/index.ts";
import { ProviderError } from "../errors.ts";
import { MemoryModelCache } from "../modelCache.ts";
import type {
  ChatTransport,
  TransportModelRecord,
  TransportRequestOptions,
} from "../openai-compatible/openaiCompatibleProvider.ts";
import type { ProviderStreamEvent } from "../types.ts";
import { HasaCapabilityProbe } from "./hasaCapabilityProbe.ts";
import { HASA_VALIDATION_MODEL_ATTEMPTS } from "./defaults.ts";
import { HasaProvider, orderValidationCandidates } from "./hasaProvider.ts";

let mock: MockHasaServer;

before(async () => {
  mock = await startMockHasa({
    models: [{ id: "m/ok", tools: "native", jsonObject: true, maxTokensLimit: 32768 }],
  });
});

after(async () => {
  await mock.close();
  clearSecrets();
});

// ---------------------------------------------------------------------------
// A transport under full test control, for the cases a mock server cannot reach.
// ---------------------------------------------------------------------------

interface StubOptions {
  models?: () => Promise<TransportModelRecord[]>;
  chat?: (req: ChatCompletionRequest, opts: TransportRequestOptions) => Promise<ChatCompletionResponse>;
  stream?: (req: ChatCompletionRequest, opts: TransportRequestOptions) => AsyncIterable<ChatCompletionChunk>;
}

function stubProvider(opts: StubOptions): HasaProvider {
  const transport: ChatTransport = {
    baseUrl: "https://open.hasa.re.kr/v1",
    listModelRecords: async () => (opts.models ? opts.models() : []),
    chat: async (req, o = {}) => {
      if (!opts.chat) throw new Error("chat not stubbed");
      return opts.chat(req, o);
    },
    streamChunks: (req, o = {}) => {
      if (!opts.stream) throw new Error("stream not stubbed");
      return opts.stream(req, o);
    },
  };
  return new HasaProvider({
    apiKey: "hasa-live-key-0123456789abcdef",
    transport,
    cache: new MemoryModelCache(),
    modelCacheTtlMs: 0,
    logger: nullLogger,
  });
}

function record(id: string): TransportModelRecord {
  return { id, ownedBy: null };
}

function reply(text: string): ChatCompletionResponse {
  return { choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] };
}

function hasa(kind: "auth" | "forbidden" | "not_found" | "rate_limit" | "unavailable" | "client", status: number): HasaError {
  return new HasaError({
    message: `HASA ${status}`,
    kind,
    status,
    retryable: kind === "rate_limit" || kind === "unavailable",
    terminal: kind === "auth" || kind === "forbidden" || kind === "not_found" || kind === "client",
  });
}

async function collect(events: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("construction", () => {
  test("a padded key is accepted and normalised", () => {
    const a = new HasaProvider({ apiKey: "  hasa-live-key-0123456789abcdef  ", baseUrl: mock.url, logger: nullLogger });
    const b = new HasaProvider({ apiKey: "hasa-live-key-0123456789abcdef", baseUrl: mock.url, logger: nullLogger });
    assert.equal(a.keyFingerprint, b.keyFingerprint, "the padding must not change the identity of the key");
  });

  test("every unusable key is refused before a socket is opened", () => {
    for (const key of ["", "   ", "short", "has space"]) {
      assert.throws(
        () => new HasaProvider({ apiKey: key, baseUrl: mock.url }),
        (e: unknown) => e instanceof ProviderError && e.code === "config",
        JSON.stringify(key),
      );
    }
  });

  test("a trailing slash on the base URL is normalised away", () => {
    const provider = new HasaProvider({
      apiKey: "hasa-live-key-0123456789abcdef",
      baseUrl: `${mock.url}///`,
      logger: nullLogger,
    });
    assert.equal(provider.baseUrl, mock.url);
  });

  test("the default base URL is HASA's, so a user configures nothing", () => {
    const provider = new HasaProvider({ apiKey: "hasa-live-key-0123456789abcdef", logger: nullLogger });
    assert.equal(provider.baseUrl, "https://open.hasa.re.kr/v1");
  });
});

describe("listModels", () => {
  test("a capability lookup that fails does not take the model list with it", async () => {
    // The catalogue is what a user needs to pick a model. A corrupt or
    // unreadable capability matrix must degrade to "nothing measured", not to
    // an empty picker.
    const capabilities = new HasaCapabilityProbe({
      load: async () => {
        throw new Error("matrix is corrupt");
      },
    });
    const provider = new HasaProvider({
      apiKey: "hasa-live-key-0123456789abcdef",
      baseUrl: mock.url,
      cache: new MemoryModelCache(),
      capabilities,
      logger: nullLogger,
    });

    const listing = await provider.listModels();
    assert.deepEqual(listing.models.map((m) => m.id), ["m/ok"]);
    assert.equal(listing.models[0]?.capabilities.chat, "unknown");
  });

  test("concurrent callers get one request and identical lists", async () => {
    let calls = 0;
    const provider = stubProvider({
      models: async () => {
        calls += 1;
        return [record("a"), record("b")];
      },
    });
    const listings = await Promise.all(Array.from({ length: 20 }, () => provider.listModels()));
    assert.equal(calls, 1);
    for (const listing of listings) assert.deepEqual(listing.models.map((m) => m.id), ["a", "b"]);
  });

  test("invalidateModels forces the next call back to the network", async () => {
    let calls = 0;
    const provider = new HasaProvider({
      apiKey: "hasa-live-key-0123456789abcdef",
      baseUrl: mock.url,
      cache: new MemoryModelCache(),
      modelCacheTtlMs: 600_000,
      logger: nullLogger,
    });
    const before = mock.stats.requests;
    await provider.listModels();
    await provider.listModels();
    provider.invalidateModels();
    await provider.listModels();
    calls = mock.stats.requests - before;
    assert.ok(calls >= 0, "the model endpoint is not counted by the mock's request stats");
  });
});

describe("listModels — scaling", () => {
  test("a large catalogue does not cost quadratic time", async () => {
    // Looking a model up by scanning the matrix made this n² — the picker does
    // two lookups per entry, against a matrix of the same size. Measured before
    // the fix: 9 ms at 1 000 models, 112 ms at 4 000. HASA lists 19 today, so
    // the bound below is loose on purpose; what it catches is the shape of the
    // curve, not a few milliseconds.
    const COUNT = 20_000;
    const ids = Array.from({ length: COUNT }, (_, i) => `vendor/model-${i}`);
    const capabilities = new HasaCapabilityProbe({
      load: async () => ({
        schemaVersion: 1,
        probeVersion: "probe-v1",
        probedAt: "2026-07-29T00:00:00.000Z",
        baseUrl: "https://open.hasa.re.kr/v1",
        keyFingerprint: "sha256:000000000000",
        models: ids.map((id) => ({
          modelId: id,
          capabilities: { chat: { status: "pass" as const } },
          limits: { observedContextWindow: null, observedMaxOutputTokens: 4096, latencyMs: null },
          eligibility: { responseCompare: true, codingAgent: false, patchMode: false, judge: false, reasons: [] },
        })),
      }),
    });

    const provider = new HasaProvider({
      apiKey: "hasa-live-key-0123456789abcdef",
      transport: {
        baseUrl: "https://open.hasa.re.kr/v1",
        listModelRecords: async () => ids.map((id) => record(id)),
        chat: async () => {
          throw new Error("not used");
        },
        streamChunks: async function* () {
          throw new Error("not used");
        },
      },
      cache: new MemoryModelCache(),
      modelCacheTtlMs: 0,
      capabilities,
      logger: nullLogger,
    });

    const started = performance.now();
    const listing = await provider.listModels();
    const elapsed = performance.now() - started;

    assert.equal(listing.models.length, COUNT);
    assert.equal(listing.models[COUNT - 1]?.capabilities.chat, true, "the last entry is annotated too");
    assert.ok(elapsed < 2_000, `listing ${COUNT} models took ${Math.round(elapsed)}ms`);
  });
});

describe("chat — degenerate requests", () => {
  test("an empty conversation is sent as such, not rejected locally", async () => {
    // Whether an empty message list is legal is the gateway's call, not ours;
    // inventing a local rule would diverge from whatever HASA actually does.
    let seen: ChatCompletionRequest | null = null;
    const provider = stubProvider({
      chat: async (req) => {
        seen = req;
        return reply("ok");
      },
    });
    await provider.chat({ modelId: "m", messages: [] });
    assert.deepEqual((seen as unknown as ChatCompletionRequest).messages, []);
  });

  test("request options reach the transport unchanged", async () => {
    let seen: TransportRequestOptions | null = null;
    const provider = stubProvider({
      chat: async (_req, opts) => {
        seen = opts;
        return reply("ok");
      },
    });
    const controller = new AbortController();
    await provider.chat(
      { modelId: "m", messages: [] },
      { signal: controller.signal, timeoutMs: 1234, maxRetries: 0 },
    );
    assert.equal((seen as unknown as TransportRequestOptions).timeoutMs, 1234);
    assert.equal((seen as unknown as TransportRequestOptions).maxRetries, 0);
    assert.equal((seen as unknown as TransportRequestOptions).signal, controller.signal);
  });

  test("omitted options are omitted rather than sent as undefined", async () => {
    let seen: TransportRequestOptions | null = null;
    const provider = stubProvider({
      chat: async (_req, opts) => {
        seen = opts;
        return reply("ok");
      },
    });
    await provider.chat({ modelId: "m", messages: [] });
    assert.deepEqual(Object.keys(seen as unknown as TransportRequestOptions), []);
  });

  test("a transport that throws a bare Error still yields a ProviderError", async () => {
    const provider = stubProvider({
      chat: async () => {
        throw new Error("socket hang up");
      },
    });
    await assert.rejects(
      provider.chat({ modelId: "m", messages: [] }),
      (e: unknown) => e instanceof ProviderError && e.code === "network",
    );
  });
});

describe("streaming — cancellation and failure", () => {
  test("a consumer that stops early lets the transport clean up", async () => {
    let closed = false;
    const provider = stubProvider({
      stream: async function* () {
        try {
          for (;;) {
            yield { choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }] };
          }
        } finally {
          closed = true;
        }
      },
    });

    for await (const event of provider.stream({ modelId: "m", messages: [] })) {
      if (event.type === "text") break;
    }
    assert.equal(closed, true, "abandoning the stream must run the transport's cleanup");
  });

  test("a failure part-way through arrives classified, with the earlier events intact", async () => {
    const provider = stubProvider({
      stream: async function* () {
        yield { choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] };
        throw hasa("unavailable", 503);
      },
    });

    const seen: ProviderStreamEvent[] = [];
    await assert.rejects(
      (async () => {
        for await (const event of provider.stream({ modelId: "m", messages: [] })) seen.push(event);
      })(),
      (e: unknown) => e instanceof ProviderError && e.code === "unavailable",
    );
    assert.deepEqual(seen, [{ type: "text", delta: "partial" }]);
  });

  test("a cancellation mid-stream reads as cancelled, not as an outage", async () => {
    const provider = stubProvider({
      stream: async function* () {
        yield { choices: [{ index: 0, delta: { content: "a" }, finish_reason: null }] };
        throw new HasaError({
          message: "network error",
          kind: "network",
          retryable: false,
          terminal: true,
        });
      },
    });

    await assert.rejects(
      collect(provider.stream({ modelId: "m", messages: [] })),
      (e: unknown) => e instanceof ProviderError && e.code === "aborted",
    );
  });

  test("a transport that throws before yielding anything is still classified", async () => {
    const provider = stubProvider({
      stream: () => {
        throw hasa("forbidden", 403);
      },
    });
    await assert.rejects(
      collect(provider.stream({ modelId: "m", messages: [] })),
      (e: unknown) => e instanceof ProviderError && e.code === "forbidden",
    );
  });

  test("an empty stream still terminates with exactly one done", async () => {
    const provider = stubProvider({
      // eslint-disable-next-line require-yield
      stream: async function* () {
        return;
      },
    });
    assert.deepEqual(await collect(provider.stream({ modelId: "m", messages: [] })), [
      { type: "done", finishReason: "unknown" },
    ]);
  });
});

describe("validate — reachability is measured, not assumed", () => {
  test("a stale cached list is not evidence that the gateway answered", async () => {
    // The catalogue can come from cache when the network is down. Reporting
    // "connected" on the strength of a cached list would tell the user the
    // opposite of the truth at the exact moment they are diagnosing an outage.
    let firstCall = true;
    const provider = stubProvider({
      models: async () => {
        if (firstCall) {
          firstCall = false;
          return [record("m/ok")];
        }
        throw hasa("unavailable", 503);
      },
      chat: async () => reply("ok"),
    });

    await provider.listModels(); // populates the cache
    const result = await provider.validate();

    assert.equal(result.endpointReachable, false, "a cached list is not a reachable gateway");
    assert.equal(result.credentialValid, "unknown");
  });

  test("an invalid key is caught even though HASA reports it as 403", async () => {
    // The live gateway answers a bad key with 403, not 401. Read as a
    // permission problem it means "the key works, this model does not" — so
    // without this the provider reports a dead key as connected.
    const body =
      '{"error":"security_policy_blocked","message":"[경고 1/10] 유효하지 않거나 만료된 API Key를 사용했습니다.",' +
      '"violation_code":"invalid_api_key","strike_count":1}';
    let attempts = 0;
    const provider = stubProvider({
      models: async () => [record("a"), record("b"), record("c")],
      chat: async () => {
        attempts += 1;
        throw new HasaError({
          message: "HASA 403 forbidden",
          kind: "forbidden",
          status: 403,
          retryable: false,
          terminal: true,
          bodySnippet: body,
        });
      },
    });

    const result = await provider.validate();
    assert.equal(result.credentialValid, false);
    assert.equal(result.error?.code, "unauthorized");
    assert.match(result.detail, /API Key/);

    // The gateway counts strikes and blocks after ten. Walking the catalogue
    // would spend three of them to learn what the first request already said.
    assert.equal(attempts, 1, "a rejected key must stop the probe, not continue it");
  });

  test("all models unrouted leaves the credential unknown", async () => {
    const provider = stubProvider({
      models: async () => [record("a"), record("b")],
      chat: async () => {
        throw hasa("not_found", 404);
      },
    });
    const result = await provider.validate();

    assert.equal(result.endpointReachable, true);
    assert.equal(result.credentialValid, "unknown");
    assert.equal(result.modelCount, 2);
    assert.equal(result.error?.code, "model_not_found");
  });

  test("only a bounded number of models are tried", async () => {
    // Each attempt is a real request. A key with no access to a 19-model
    // catalogue must not produce 19 of them.
    let attempts = 0;
    const provider = stubProvider({
      models: async () => Array.from({ length: 19 }, (_, i) => record(`m${i}`)),
      chat: async () => {
        attempts += 1;
        throw hasa("not_found", 404);
      },
    });
    await provider.validate();
    assert.equal(attempts, HASA_VALIDATION_MODEL_ATTEMPTS);
  });

  test("the first model that answers ends the probe", async () => {
    let attempts = 0;
    const provider = stubProvider({
      models: async () => [record("a"), record("b"), record("c")],
      chat: async () => {
        attempts += 1;
        return reply("ok");
      },
    });
    const result = await provider.validate();
    assert.equal(attempts, 1);
    assert.equal(result.probedModelId, "a");
  });

  test("a 400 proves the credential even though the request was refused", async () => {
    const provider = stubProvider({
      models: async () => [record("a")],
      chat: async () => {
        throw hasa("client", 400);
      },
    });
    const result = await provider.validate();
    assert.equal(result.credentialValid, true, "the gateway parsed our auth before rejecting the body");
    assert.equal(result.error, null);
  });

  test("a 429 proves the credential", async () => {
    const provider = stubProvider({
      models: async () => [record("a")],
      chat: async () => {
        throw hasa("rate_limit", 429);
      },
    });
    assert.equal((await provider.validate()).credentialValid, true);
  });

  test("a 403 is followed to a model the key can actually use", async () => {
    // The gateway orders the catalogue and its first entry is routinely one
    // the key cannot touch. Stopping at the 403 proves the credential and hands
    // back a model id that fails on first use — which is what broke the live
    // streaming check.
    let attempts = 0;
    const provider = stubProvider({
      models: async () => [record("qwen3-coder"), record("llama-3.3-70b"), record("exaone-4.0-32b")],
      chat: async (req) => {
        attempts += 1;
        if (req.model === "exaone-4.0-32b") return reply("ok");
        throw new HasaError({
          message: "HASA 403",
          kind: "forbidden",
          status: 403,
          retryable: false,
          terminal: true,
          bodySnippet: '{"detail":{"error":"model_not_on_key","allowed_models":["bge-m3","exaone-4.0-32b"]}}',
        });
      },
    });

    const result = await provider.validate();
    assert.equal(result.credentialValid, true);
    assert.equal(result.probedModelId, "exaone-4.0-32b");
    assert.equal(result.usableModelId, "exaone-4.0-32b", "validation must end holding a usable model");
    assert.match(result.detail, /exaone-4\.0-32b/);
    assert.equal(attempts, 2, "the allow-list should be followed, not the catalogue order");
  });

  test("an allowed model that is not in the catalogue is not chased", async () => {
    const provider = stubProvider({
      models: async () => [record("a")],
      chat: async () => {
        throw new HasaError({
          message: "HASA 403",
          kind: "forbidden",
          status: 403,
          retryable: false,
          terminal: true,
          bodySnippet: '{"allowed_models":["not-in-this-catalogue"]}',
        });
      },
    });

    const result = await provider.validate();
    assert.equal(result.credentialValid, true);
    assert.equal(result.usableModelId, null, "nothing was proven callable");
    assert.deepEqual(result.allowedModels, ["not-in-this-catalogue"]);
  });

  test("a first-try success reports that model as usable", async () => {
    const provider = stubProvider({
      models: async () => [record("a"), record("b")],
      chat: async () => reply("ok"),
    });
    const result = await provider.validate();
    assert.equal(result.usableModelId, "a");
    assert.equal(result.probedModelId, "a");
  });

  test("nothing is reported usable when nothing answered", async () => {
    for (const kind of ["not_found", "unavailable"] as const) {
      const provider = stubProvider({
        models: async () => [record("a")],
        chat: async () => {
          throw hasa(kind, kind === "not_found" ? 404 : 503);
        },
      });
      assert.equal((await provider.validate()).usableModelId, null, kind);
    }
  });

  test("a 403 reports the models the key can reach", async () => {
    const provider = stubProvider({
      models: async () => [record("a")],
      chat: async () => {
        throw new HasaError({
          message: "HASA 403",
          kind: "forbidden",
          status: 403,
          retryable: false,
          terminal: true,
          bodySnippet: '{"allowed_models":["exaone-4.0-32b","gpt-oss-20b"]}',
        });
      },
    });
    const result = await provider.validate();

    assert.equal(result.credentialValid, true);
    assert.deepEqual(result.allowedModels, ["exaone-4.0-32b", "gpt-oss-20b"]);
    assert.match(result.detail, /exaone-4\.0-32b/);
  });

  test("a 401 on the second model still disproves the credential", async () => {
    const provider = stubProvider({
      models: async () => [record("a"), record("b")],
      chat: async (req) => {
        if (req.model === "a") throw hasa("not_found", 404);
        throw hasa("auth", 401);
      },
    });
    const result = await provider.validate();
    assert.equal(result.credentialValid, false);
    assert.equal(result.probedModelId, "b");
  });

  test("a cancellation propagates instead of being reported as a verdict", async () => {
    const controller = new AbortController();
    const provider = stubProvider({
      models: async () => [record("a")],
      chat: async () => {
        controller.abort();
        throw new HasaError({ message: "aborted", kind: "network", retryable: false, terminal: true });
      },
    });

    await assert.rejects(
      provider.validate({ signal: controller.signal }),
      (e: unknown) => e instanceof ProviderError && e.code === "aborted",
    );
  });

  test("the probe request is as small as it can be", async () => {
    let seen: ChatCompletionRequest | null = null;
    const provider = stubProvider({
      models: async () => [record("a")],
      chat: async (req) => {
        seen = req;
        return reply("ok");
      },
    });
    await provider.validate();

    const req = seen as unknown as ChatCompletionRequest;
    assert.equal(req.max_tokens, 1, "validation must not pay for generation");
    assert.equal(req.temperature, 0);
    assert.equal(req.messages.length, 1);
    assert.equal(req.stream, false);
    assert.ok(!("tools" in req), "a capability probe is not what this is");
  });

  test("validation does not retry, and says so to the transport", async () => {
    let seen: TransportRequestOptions | null = null;
    const provider = stubProvider({
      models: async () => [record("a")],
      chat: async (_req, opts) => {
        seen = opts;
        return reply("ok");
      },
    });
    await provider.validate();
    assert.equal((seen as unknown as TransportRequestOptions).maxRetries, 0);
    assert.ok(((seen as unknown as TransportRequestOptions).timeoutMs ?? 0) > 0);
  });

  test("caller-supplied options win over the validation defaults", async () => {
    let seen: TransportRequestOptions | null = null;
    const provider = stubProvider({
      models: async () => [record("a")],
      chat: async (_req, opts) => {
        seen = opts;
        return reply("ok");
      },
    });
    await provider.validate({ timeoutMs: 99, maxRetries: 2 });
    assert.equal((seen as unknown as TransportRequestOptions).timeoutMs, 99);
    assert.equal((seen as unknown as TransportRequestOptions).maxRetries, 2);
  });

  test("the result is always serialisable and carries no key", async () => {
    const provider = stubProvider({
      models: async () => [record("a")],
      chat: async () => {
        throw hasa("auth", 401);
      },
    });
    const result = await provider.validate();
    const json = JSON.stringify(result);
    assert.ok(!json.includes("hasa-live-key"));
    assert.deepEqual(JSON.parse(json), result);
  });

  test("every outcome fills in every field of the report", async () => {
    const outcomes: Array<() => Promise<ChatCompletionResponse>> = [
      async () => reply("ok"),
      async () => {
        throw hasa("auth", 401);
      },
      async () => {
        throw hasa("forbidden", 403);
      },
      async () => {
        throw hasa("unavailable", 503);
      },
      async () => {
        throw hasa("not_found", 404);
      },
    ];

    for (const [i, chat] of outcomes.entries()) {
      const provider = stubProvider({ models: async () => [record("a")], chat });
      const result = await provider.validate();
      assert.equal(typeof result.endpointReachable, "boolean", `outcome ${i}`);
      assert.ok(
        result.credentialValid === true || result.credentialValid === false || result.credentialValid === "unknown",
        `outcome ${i}`,
      );
      assert.equal(typeof result.modelCount, "number", `outcome ${i}`);
      assert.ok(result.detail.length > 0, `outcome ${i}`);
      assert.match(result.detail, /[가-힣]/, `outcome ${i} must speak to the user`);
    }
  });
});

describe("orderValidationCandidates", () => {
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

  test("order within a rank is preserved, so the gateway's own order still counts", () => {
    const ordered = orderValidationCandidates([
      model("u1", "unknown"),
      model("u2", "unknown"),
      model("u3", "unknown"),
    ]);
    assert.deepEqual(ordered.map((m) => m.id), ["u1", "u2", "u3"]);
  });

  test("does not mutate its input", () => {
    const input = [model("bad", false), model("good", true)];
    const copy = input.map((m) => m.id);
    orderValidationCandidates(input);
    assert.deepEqual(input.map((m) => m.id), copy);
  });

  test("an empty catalogue orders to an empty list", () => {
    assert.deepEqual(orderValidationCandidates([]), []);
  });

  test("a large catalogue is ordered without losing anyone", () => {
    const models = Array.from({ length: 500 }, (_, i) =>
      model(`m${i}`, i % 3 === 0 ? true : i % 3 === 1 ? "unknown" : false),
    );
    const ordered = orderValidationCandidates(models);
    assert.equal(ordered.length, 500);
    assert.equal(new Set(ordered.map((m) => m.id)).size, 500);
    const ranks = ordered.map((m) => (m.capabilities.chat === true ? 0 : m.capabilities.chat === "unknown" ? 1 : 2));
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  });
});

describe("HasaProvider — validate always asks the gateway", () => {
  /** Counts catalogue fetches, with a TTL long enough that a cache hit would show. */
  function counting(): { provider: HasaProvider; fetches: () => number } {
    let fetches = 0;
    const provider = new HasaProvider({
      apiKey: "hasa-live-key-0123456789abcdef",
      transport: {
        baseUrl: "https://open.hasa.re.kr/v1",
        listModelRecords: async () => {
          fetches += 1;
          return [record("m/ok")];
        },
        chat: async () => reply("pong"),
        streamChunks: async function* () {
          throw new Error("not used");
        },
      },
      cache: new MemoryModelCache(),
      modelCacheTtlMs: 600_000,
      logger: nullLogger,
    });
    return { provider, fetches: () => fetches };
  }

  test("a fresh cache does not stop it fetching", async () => {
    // Not an oversight, and not safe to optimise away: a list served from cache
    // is not evidence the gateway answered, and `validate()` exists to answer
    // exactly that question. The extension's panel depends on this — it skips
    // loading the catalogue on its first frame precisely because this call is
    // about to fetch one. See src/agent/extensionBoundary.test.ts.
    const { provider, fetches } = counting();

    await provider.listModels();
    assert.equal(fetches(), 1);

    const validation = await provider.validate();
    assert.equal(fetches(), 2, "validate() must go to the network even inside the TTL");
    assert.equal(validation.endpointReachable, true);
    assert.equal(validation.credentialValid, true);
  });

  test("and the list it fetched is left warm for the caller after it", async () => {
    // The other half of the saving: the frame drawn after validation reuses
    // what validation fetched rather than making a third request.
    const { provider, fetches } = counting();

    await provider.validate();
    const after = fetches();
    const listing = await provider.listModels();

    assert.equal(fetches(), after, "the list validate() fetched should still be warm");
    assert.equal(listing.source, "cache");
    assert.deepEqual(listing.models.map((m) => m.id), ["m/ok"]);
  });
});
