import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { HasaError } from "../../hasa-client/errors.ts";
import { fingerprint } from "../../hasa-client/redact.ts";
import type {
  ChatTransport,
  TransportModelRecord,
  TransportRequestOptions,
} from "../openai-compatible/openaiCompatibleProvider.ts";
import type { Logger } from "../../hasa-client/logger.ts";
import { MemoryModelCache, cacheScope, type ModelCacheStore } from "../modelCache.ts";
import { ProviderError } from "../errors.ts";
import { HasaModelRegistry } from "./hasaModelRegistry.ts";

const BASE_URL = "https://open.hasa.re.kr/v1";
const KEY = "hasa-live-key-0123456789abcdef";
const PRINT = fingerprint(KEY);

interface Stub {
  transport: ChatTransport;
  calls: number;
  /** Replaced per test to script the next answer. */
  answer: () => Promise<TransportModelRecord[]>;
  lastOptions: TransportRequestOptions | undefined;
}

function stubTransport(initial: () => Promise<TransportModelRecord[]>): Stub {
  const stub: Stub = {
    calls: 0,
    answer: initial,
    lastOptions: undefined,
    transport: {
      baseUrl: BASE_URL,
      async listModelRecords(opts) {
        stub.calls += 1;
        stub.lastOptions = opts;
        return stub.answer();
      },
      chat() {
        throw new Error("not used");
      },
      streamChunks() {
        throw new Error("not used");
      },
    },
  };
  return stub;
}

const OK = async (): Promise<TransportModelRecord[]> => [
  { id: "exaone-4.0-32b", ownedBy: "hasa" },
  { id: "gpt-oss-20b", ownedBy: null },
];

function makeRegistry(
  stub: Stub,
  opts: { cache?: ModelCacheStore; now?: () => number; ttlMs?: number; logger?: Logger } = {},
): HasaModelRegistry {
  return new HasaModelRegistry({
    transport: stub.transport,
    keyFingerprint: PRINT,
    ...(opts.cache === undefined ? {} : { cache: opts.cache }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.ttlMs === undefined ? {} : { ttlMs: opts.ttlMs }),
    ...(opts.logger === undefined ? {} : { logger: opts.logger }),
  });
}

interface CapturedLog {
  level: "warn";
  msg: string;
  fields: Record<string, unknown>;
}

/** Collects `warn` lines so a test can assert what an operator would be told. */
function capturingLogger(into: CapturedLog[]): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg, fields) => into.push({ level: "warn", msg, fields: fields ?? {} }),
    error: () => {},
    child: () => logger,
  };
  return logger;
}

describe("HasaModelRegistry", () => {
  test("lists what the gateway returns, with no ids of its own", async () => {
    const stub = stubTransport(OK);
    const listing = await makeRegistry(stub).list();

    assert.deepEqual(listing.models.map((m) => m.id), ["exaone-4.0-32b", "gpt-oss-20b"]);
    assert.equal(listing.source, "network");
    assert.equal(listing.stale, false);
    assert.equal(listing.warning, null);
    assert.equal(listing.models[0]?.ownedBy, "hasa");
    assert.equal(listing.models[1]?.ownedBy, null);
  });

  test("a duplicated id is shown once and reported to whoever can fix it", async () => {
    // Observed against the live gateway: `GET /v1/models` answered with 22
    // records for 21 distinct models. Dropping the extra is right; dropping it
    // in silence left the client logging 22 and the picker showing 21, with no
    // way to tell which count was the bug.
    const seen: CapturedLog[] = [];
    const stub = stubTransport(async () => [
      { id: "exaone-4.0-32b", ownedBy: "hasa" },
      { id: "gpt-oss-20b", ownedBy: null },
      { id: "exaone-4.0-32b", ownedBy: "hasa" },
    ]);
    const listing = await makeRegistry(stub, { logger: capturingLogger(seen) }).list();

    assert.deepEqual(listing.models.map((m) => m.id), ["exaone-4.0-32b", "gpt-oss-20b"]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.fields["received"], 3);
    assert.equal(seen[0]?.fields["kept"], 2);
    assert.deepEqual(seen[0]?.fields["duplicated"], ["exaone-4.0-32b"]);
    assert.equal(seen[0]?.fields["blank"], undefined, "nothing was blank, so nothing to say about it");
  });

  test("an id repeated three times is named once, not twice", async () => {
    const seen: CapturedLog[] = [];
    const stub = stubTransport(async () => [
      { id: "solar-pro", ownedBy: null },
      { id: "solar-pro", ownedBy: null },
      { id: "solar-pro", ownedBy: null },
    ]);
    await makeRegistry(stub, { logger: capturingLogger(seen) }).list();

    assert.deepEqual(seen[0]?.fields["duplicated"], ["solar-pro"]);
    assert.equal(seen[0]?.fields["kept"], 1);
  });

  test("an entry with no id is counted, because it has no name to report", async () => {
    const seen: CapturedLog[] = [];
    const stub = stubTransport(async () => [
      { id: "solar-pro", ownedBy: null },
      { id: "   ", ownedBy: null },
    ]);
    const listing = await makeRegistry(stub, { logger: capturingLogger(seen) }).list();

    assert.deepEqual(listing.models.map((m) => m.id), ["solar-pro"]);
    assert.equal(seen[0]?.fields["blank"], 1);
    assert.equal(seen[0]?.fields["duplicated"], undefined);
  });

  test("a clean catalogue says nothing at all", async () => {
    // The silence is the signal: an operator who fixes the duplicate should see
    // this warning stop, and that only works if a healthy list is quiet.
    const seen: CapturedLog[] = [];
    await makeRegistry(stubTransport(OK), { logger: capturingLogger(seen) }).list();
    assert.deepEqual(seen, []);
  });

  test("capabilities default to unknown until something measures them", async () => {
    // Naming a model "coder" is not evidence. Every field starts unknown.
    const listing = await makeRegistry(stubTransport(OK)).list();
    assert.deepEqual(listing.models[0]?.capabilities, {
      chat: "unknown",
      streaming: "unknown",
      toolCalling: "unknown",
      coding: "unknown",
      reasoning: "unknown",
      vision: "unknown",
      embedding: "unknown",
      reranking: "unknown",
    });
  });

  test("a second call inside the TTL is served from memory", async () => {
    const stub = stubTransport(OK);
    const registry = makeRegistry(stub, { now: () => 1_000, ttlMs: 60_000 });

    await registry.list();
    const second = await registry.list();
    assert.equal(stub.calls, 1);
    assert.equal(second.source, "cache");
    assert.equal(second.stale, false);
  });

  test("refresh:true goes back to the network even inside the TTL", async () => {
    const stub = stubTransport(OK);
    const registry = makeRegistry(stub, { now: () => 1_000, ttlMs: 60_000 });

    await registry.list();
    const second = await registry.list({ refresh: true });
    assert.equal(stub.calls, 2);
    assert.equal(second.source, "network");
  });

  test("the memory entry expires with the TTL", async () => {
    const stub = stubTransport(OK);
    let now = 1_000;
    const registry = makeRegistry(stub, { now: () => now, ttlMs: 5_000 });

    await registry.list();
    now += 5_001;
    await registry.list();
    assert.equal(stub.calls, 2);
  });

  test("concurrent callers share one request", async () => {
    // Every panel that opens asks for the model list. Without deduplication a
    // reload fires one request per listener at the same shared GPU gateway.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = stubTransport(async () => {
      await gate;
      return OK();
    });
    const registry = makeRegistry(stub);

    const all = Promise.all([registry.list(), registry.list(), registry.list()]);
    release();
    const listings = await all;

    assert.equal(stub.calls, 1);
    for (const listing of listings) assert.equal(listing.models.length, 2);
  });

  test("an empty catalogue is reported as empty, not as a failure", async () => {
    const listing = await makeRegistry(stubTransport(async () => [])).list();
    assert.deepEqual(listing.models, []);
    assert.equal(listing.source, "network");
    assert.equal(listing.warning, null);
  });

  test("an empty catalogue does not overwrite a good cache", async () => {
    // A gateway that briefly answers `{"data": []}` would otherwise destroy the
    // only list left to fall back on when it goes down for real.
    const cache = new MemoryModelCache();
    const stub = stubTransport(OK);
    const registry = makeRegistry(stub, { cache });

    await registry.list();
    stub.answer = async () => [];
    await registry.list({ refresh: true });

    const stored = await cache.read(cacheScope(BASE_URL, PRINT));
    assert.deepEqual(stored?.models.map((m) => m.id), ["exaone-4.0-32b", "gpt-oss-20b"]);
  });

  test("a malformed catalogue surfaces as a protocol error", async () => {
    const stub = stubTransport(async () => {
      throw new HasaError({
        message: "GET /models returned an unexpected shape",
        kind: "protocol",
        status: 200,
        retryable: false,
        terminal: true,
      });
    });

    await assert.rejects(
      makeRegistry(stub).list(),
      (e: unknown) => e instanceof ProviderError && e.code === "protocol",
    );
  });

  test("a network failure with no cache surfaces as an error", async () => {
    const stub = stubTransport(async () => {
      throw new HasaError({ message: "network error", kind: "network", retryable: true, terminal: false });
    });

    await assert.rejects(
      makeRegistry(stub, { cache: new MemoryModelCache() }).list(),
      (e: unknown) => e instanceof ProviderError && e.code === "network",
    );
  });

  test("a network failure falls back to the last successful list", async () => {
    const cache = new MemoryModelCache();
    const stub = stubTransport(OK);
    let now = 1_000;
    const registry = makeRegistry(stub, { cache, now: () => now, ttlMs: 1_000 });

    await registry.list();
    now += 10_000;
    stub.answer = async () => {
      throw new HasaError({ message: "GPU backend unavailable", kind: "unavailable", status: 503, retryable: true, terminal: false });
    };

    const listing = await registry.list();
    assert.equal(listing.source, "cache");
    assert.equal(listing.stale, true);
    assert.deepEqual(listing.models.map((m) => m.id), ["exaone-4.0-32b", "gpt-oss-20b"]);
    // The user has to be told the list is old, and told it in their language.
    assert.ok(listing.warning !== null);
    assert.match(listing.warning, /일시적으로/);
  });

  test("a cache written under another key is not used as a fallback", async () => {
    const cache = new MemoryModelCache();
    await cache.write({
      version: 1,
      scope: cacheScope(BASE_URL, fingerprint("someone-elses-key-9876543210")),
      fetchedAt: "2026-08-01T00:00:00.000Z",
      models: [{ id: "m/not-mine", ownedBy: null }],
    });

    const stub = stubTransport(async () => {
      throw new HasaError({ message: "network error", kind: "network", retryable: true, terminal: false });
    });

    await assert.rejects(
      makeRegistry(stub, { cache }).list(),
      (e: unknown) => e instanceof ProviderError && e.code === "network",
    );
  });

  test("an abort is not answered with a stale list", async () => {
    // Serving a cached list here would answer a question nobody is still asking.
    const cache = new MemoryModelCache();
    const stub = stubTransport(OK);
    const registry = makeRegistry(stub, { cache, ttlMs: 0 });
    await registry.list();

    stub.answer = async () => {
      throw new HasaError({
        message: "network error",
        kind: "network",
        retryable: false,
        terminal: true,
        cause: new Error("aborted"),
      });
    };

    await assert.rejects(
      registry.list(),
      (e: unknown) => e instanceof ProviderError && e.code === "aborted",
    );
  });

  test("a failing refresh does not poison the in-flight slot", async () => {
    const stub = stubTransport(async () => {
      throw new HasaError({ message: "boom", kind: "server", status: 500, retryable: true, terminal: false });
    });
    const registry = makeRegistry(stub);

    await assert.rejects(registry.list());
    stub.answer = OK;
    const listing = await registry.list();
    assert.equal(listing.models.length, 2);
    assert.equal(stub.calls, 2);
  });

  test("invalidate forces the next call back to the network", async () => {
    const stub = stubTransport(OK);
    const registry = makeRegistry(stub, { now: () => 1_000, ttlMs: 60_000 });

    await registry.list();
    registry.invalidate();
    await registry.list();
    assert.equal(stub.calls, 2);
  });

  test("request options reach the transport", async () => {
    const stub = stubTransport(OK);
    const controller = new AbortController();
    await makeRegistry(stub).list({ signal: controller.signal, timeoutMs: 5_000, maxRetries: 0 });

    assert.equal(stub.lastOptions?.timeoutMs, 5_000);
    assert.equal(stub.lastOptions?.maxRetries, 0);
    assert.equal(stub.lastOptions?.signal, controller.signal);
  });
});
