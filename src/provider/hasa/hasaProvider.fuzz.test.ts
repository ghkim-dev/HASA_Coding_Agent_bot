import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { HasaError, type ErrorKind } from "../../hasa-client/errors.ts";
import { nullLogger } from "../../hasa-client/logger.ts";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "../../protocol/index.ts";
import { forEachSeedAsync, fuzzIterations, type Rng } from "../../testing/fuzz.ts";
import { ProviderError } from "../errors.ts";
import { MemoryModelCache, type ModelCacheStore } from "../modelCache.ts";
import type {
  ChatTransport,
  TransportModelRecord,
} from "../openai-compatible/openaiCompatibleProvider.ts";
import type { ModelListing, ProviderChatResponse, ProviderStreamEvent } from "../types.ts";
import { HasaProvider } from "./hasaProvider.ts";

/**
 * Properties of the whole provider, over a gateway that misbehaves at random.
 *
 * The unit tests each pin one behaviour. These pin the contract: whatever the
 * gateway does, `chat` either answers or raises a classified error, `stream`
 * always terminates, `validate` never raises at all, and the key never appears
 * anywhere. A settings panel that has to catch an unclassified exception from
 * `validate` has no way to tell the user anything useful.
 */

const KEY = "hasa-live-key-0123456789abcdef";

const KINDS: ErrorKind[] = [
  "auth",
  "forbidden",
  "not_found",
  "rate_limit",
  "unavailable",
  "server",
  "client",
  "network",
  "timeout",
  "protocol",
];

const STATUS: Partial<Record<ErrorKind, number>> = {
  auth: 401,
  forbidden: 403,
  not_found: 404,
  rate_limit: 429,
  unavailable: 503,
  server: 500,
  client: 400,
};

/** One of the ways a HASA call can go wrong, chosen at random. */
function randomFault(rng: Rng): HasaError {
  const kind = rng.pick(KINDS);
  const status = STATUS[kind];
  return new HasaError({
    message: `HASA ${kind}`,
    kind,
    ...(status === undefined ? {} : { status }),
    retryable: rng.bool(),
    terminal: rng.bool(),
    ...(rng.bool(0.3)
      ? { bodySnippet: rng.pick([`{"allowed_models":["a","b"]}`, "model access denied", `key=${KEY}`]) }
      : {}),
    ...(rng.bool(0.2) ? { retryAfterMs: rng.int(0, 60_000) } : {}),
  });
}

interface GatewayPlan {
  models: TransportModelRecord[] | HasaError | Error;
  chat: (req: ChatCompletionRequest) => ChatCompletionResponse | HasaError | Error;
  chunks: (req: ChatCompletionRequest) => Array<ChatCompletionChunk | HasaError>;
}

function planGateway(rng: Rng): GatewayPlan {
  const modelCount = rng.int(0, 5);
  const models: TransportModelRecord[] = Array.from({ length: modelCount }, (_, i) => ({
    id: rng.bool(0.1) ? "" : `model-${i}`,
    ownedBy: rng.bool() ? "hasa" : null,
  }));

  const listFails = rng.bool(0.25);
  const chatOutcome = rng.int(0, 9);

  return {
    models: listFails ? (rng.bool(0.8) ? randomFault(rng) : new Error("transport exploded")) : models,
    chat: () => {
      if (chatOutcome <= 4) {
        return {
          model: rng.bool(0.2) ? "" : "echo",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: rng.bool(0.1) ? null : rng.string(30) },
              finish_reason: rng.pick(["stop", "length", "tool_calls", null]),
            },
          ],
          ...(rng.bool(0.5) ? { usage: { prompt_tokens: rng.int(0, 99) } } : {}),
        } satisfies ChatCompletionResponse;
      }
      return chatOutcome === 9 ? new Error("transport exploded") : randomFault(rng);
    },
    chunks: () => {
      const out: Array<ChatCompletionChunk | HasaError> = [];
      const n = rng.int(0, 6);
      for (let i = 0; i < n; i += 1) {
        out.push({
          choices: [{ index: 0, delta: { content: rng.string(8) }, finish_reason: null }],
        });
      }
      if (rng.bool(0.25)) out.push(randomFault(rng));
      else out.push({ choices: [{ index: 0, delta: {}, finish_reason: rng.pick(["stop", "length", null]) }] });
      return out;
    },
  };
}

function providerFor(plan: GatewayPlan, cache: ModelCacheStore): HasaProvider {
  const transport: ChatTransport = {
    baseUrl: "https://open.hasa.re.kr/v1",
    listModelRecords: async () => {
      if (plan.models instanceof Error) throw plan.models;
      return plan.models;
    },
    chat: async (req) => {
      const result = plan.chat(req);
      if (result instanceof Error) throw result;
      return result;
    },
    streamChunks: async function* (req) {
      for (const item of plan.chunks(req)) {
        if (item instanceof Error) throw item;
        yield item;
      }
    },
  };
  return new HasaProvider({
    apiKey: KEY,
    transport,
    cache,
    modelCacheTtlMs: 0,
    logger: nullLogger,
  });
}

function assertNoKey(label: string, value: unknown): void {
  let serialised: string;
  try {
    serialised = JSON.stringify(value) ?? String(value);
  } catch {
    return; // not serialisable, so it never reaches a webview either
  }
  assert.ok(!serialised.includes(KEY), `${label} leaked the API key`);
}

function assertWellFormedListing(listing: ModelListing): void {
  assert.ok(Array.isArray(listing.models));
  assert.ok(listing.source === "network" || listing.source === "cache");
  assert.equal(typeof listing.stale, "boolean");
  assert.ok(!Number.isNaN(Date.parse(listing.fetchedAt)), "fetchedAt must be a real timestamp");
  const ids = listing.models.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, "a picker must never be handed duplicates");
  for (const id of ids) assert.ok(id.trim().length > 0, "a picker must never be handed a blank id");
  if (listing.source === "network") assert.equal(listing.stale, false);
  if (listing.stale) assert.ok(listing.warning !== null, "a stale list must explain itself");
}

function assertWellFormedResponse(res: ProviderChatResponse): void {
  assert.equal(typeof res.text, "string");
  assert.equal(typeof res.reasoning, "string");
  assert.ok(Array.isArray(res.toolCalls));
  assert.ok(res.modelId.length > 0, "a response always names a model");
  assert.ok(["stop", "tool_calls", "length", "content_filter", "unknown"].includes(res.finishReason));
  for (const call of res.toolCalls) {
    assert.ok(call.id.length > 0);
    assert.equal(typeof call.rawArguments, "string");
    assert.ok(call.arguments !== null && typeof call.arguments === "object");
  }
}

function assertWellFormedError(err: unknown): asserts err is ProviderError {
  assert.ok(err instanceof ProviderError, `expected a ProviderError, got ${Object.prototype.toString.call(err)}`);
  assert.ok(err.userMessage.length > 0, "every error has something to tell the user");
  assert.ok(!(err.retryable && err.terminal), "an error cannot be both retryable and terminal");
  assertNoKey("error", err.toJSON());
  assert.ok(!err.message.includes(KEY), "the message leaked the key");
  assert.ok(!err.detail.includes(KEY), "the detail leaked the key");
}

describe("HasaProvider — properties over a misbehaving gateway", () => {
  test(`listModels answers or raises a classified error (${fuzzIterations()} gateways)`, async () => {
    await forEachSeedAsync(async (rng) => {
      const provider = providerFor(planGateway(rng), new MemoryModelCache());
      try {
        const listing = await provider.listModels();
        assertWellFormedListing(listing);
        assertNoKey("listing", listing);
      } catch (err) {
        assertWellFormedError(err);
      }
    });
  });

  test("chat answers or raises a classified error", async () => {
    await forEachSeedAsync(async (rng) => {
      const provider = providerFor(planGateway(rng), new MemoryModelCache());
      try {
        const res = await provider.chat({
          modelId: rng.string(10) || "m",
          messages: [{ role: "user", content: rng.string(20) }],
          ...(rng.bool() ? { temperature: 0 } : {}),
          ...(rng.bool() ? { maxOutputTokens: rng.int(0, 4096) } : {}),
        });
        assertWellFormedResponse(res);
        assertNoKey("response", res);
      } catch (err) {
        assertWellFormedError(err);
      }
    });
  });

  test("a stream either terminates with exactly one done, or raises", async () => {
    await forEachSeedAsync(async (rng) => {
      const provider = providerFor(planGateway(rng), new MemoryModelCache());
      const events: ProviderStreamEvent[] = [];
      try {
        for await (const event of provider.stream({
          modelId: "m",
          messages: [{ role: "user", content: rng.string(20) }],
        })) {
          events.push(event);
          assert.ok(events.length < 10_000, "a stream must not run away");
        }
      } catch (err) {
        assertWellFormedError(err);
        // A stream that failed must not have claimed to finish first.
        assert.equal(events.filter((e) => e.type === "done").length, 0);
        return;
      }
      assert.equal(events.filter((e) => e.type === "done").length, 1);
      assert.equal(events.at(-1)?.type, "done");
    });
  });

  test("validate produces a report, and the only thing it may raise is a cancellation", async () => {
    // This is the strongest of the properties. A settings panel calls it with a
    // key the user just typed; if it can throw something unclassified there is
    // nothing sensible to render. A cancellation is the one exception, because
    // a cancelled operation has no result to report — and the caller, having
    // passed the signal, is the one who knows.
    await forEachSeedAsync(async (rng) => {
      const provider = providerFor(planGateway(rng), new MemoryModelCache());

      let result: Awaited<ReturnType<HasaProvider["validate"]>>;
      try {
        result = await provider.validate();
      } catch (err) {
        assertWellFormedError(err);
        assert.equal(err.code, "aborted", "validate may only raise a cancellation");
        return;
      }

      assert.equal(typeof result.endpointReachable, "boolean");
      assert.ok(
        result.credentialValid === true || result.credentialValid === false || result.credentialValid === "unknown",
      );
      assert.ok(Number.isInteger(result.modelCount) && result.modelCount >= 0);
      assert.ok(result.detail.length > 0, "the report always says something");
      assert.match(result.detail, /[가-힣]/, "and says it to the user, in their language");
      assert.ok(result.probedModelId === null || result.probedModelId.length > 0);
      assert.ok(result.allowedModels === null || result.allowedModels.length > 0);
      assertNoKey("validation", result);

      // A credential cannot be judged without reaching the gateway.
      if (!result.endpointReachable) assert.notEqual(result.credentialValid, true);
      // Nor can it be judged without a model to try.
      if (result.modelCount === 0) assert.notEqual(result.credentialValid, true);
      // A verdict of "valid" is never accompanied by an error.
      if (result.credentialValid === true) assert.equal(result.error, null);
    }, Math.max(1, Math.floor(fuzzIterations() / 2)));
  });

  test("a shared cache never lets one gateway's models surface under another", async () => {
    const cache = new MemoryModelCache();
    await forEachSeedAsync(async (rng, seed) => {
      const plan = planGateway(rng);
      // Same cache, a different key each round: the scope digest is what keeps
      // the entries apart.
      const provider = new HasaProvider({
        apiKey: `${KEY}-${seed}`,
        transport: {
          baseUrl: "https://open.hasa.re.kr/v1",
          listModelRecords: async () => {
            if (plan.models instanceof Error) throw plan.models;
            return plan.models;
          },
          chat: async () => {
            throw new Error("not used");
          },
          streamChunks: async function* () {
            throw new Error("not used");
          },
        },
        cache,
        modelCacheTtlMs: 0,
        logger: nullLogger,
      });

      try {
        const listing = await provider.listModels();
        assertWellFormedListing(listing);
        if (Array.isArray(plan.models)) {
          const expected = [...new Set(plan.models.map((m) => m.id).filter((id) => id.trim().length > 0))];
          assert.deepEqual(listing.models.map((m) => m.id), expected, "a foreign catalogue must not leak in");
        }
      } catch (err) {
        assertWellFormedError(err);
      }
    }, Math.max(1, Math.floor(fuzzIterations() / 2)));
  });
});
