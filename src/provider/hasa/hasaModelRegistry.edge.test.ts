import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { HasaError } from "../../hasa-client/errors.ts";
import { fingerprint } from "../../hasa-client/redact.ts";
import { ProviderError } from "../errors.ts";
import { MemoryModelCache, cacheScope, type CachedModelList, type ModelCacheStore } from "../modelCache.ts";
import type {
  ChatTransport,
  TransportModelRecord,
  TransportRequestOptions,
} from "../openai-compatible/openaiCompatibleProvider.ts";
import { unknownCapabilities, type ModelCapabilities } from "../types.ts";
import { HasaModelRegistry } from "./hasaModelRegistry.ts";

const BASE_URL = "https://open.hasa.re.kr/v1";
const PRINT = fingerprint("hasa-live-key-0123456789abcdef");
const SCOPE = cacheScope(BASE_URL, PRINT);

interface Stub {
  transport: ChatTransport;
  calls: number;
  answer: () => Promise<TransportModelRecord[]>;
  lastOptions: TransportRequestOptions | undefined;
}

function stubTransport(initial: () => Promise<TransportModelRecord[]>, baseUrl = BASE_URL): Stub {
  const stub: Stub = {
    calls: 0,
    answer: initial,
    lastOptions: undefined,
    transport: {
      baseUrl,
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

const twoModels = async (): Promise<TransportModelRecord[]> => [
  { id: "a", ownedBy: "hasa" },
  { id: "b", ownedBy: null },
];

function makeRegistry(
  stub: Stub,
  opts: {
    cache?: ModelCacheStore;
    now?: () => number;
    ttlMs?: number;
    capabilitiesOf?: (id: string) => ModelCapabilities;
  } = {},
): HasaModelRegistry {
  return new HasaModelRegistry({
    transport: stub.transport,
    keyFingerprint: PRINT,
    ...(opts.cache === undefined ? {} : { cache: opts.cache }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.ttlMs === undefined ? {} : { ttlMs: opts.ttlMs }),
    ...(opts.capabilitiesOf === undefined ? {} : { capabilitiesOf: opts.capabilitiesOf }),
  });
}

function hasa(kind: "network" | "unavailable" | "rate_limit" | "auth" | "forbidden"): HasaError {
  return new HasaError({ message: `HASA ${kind}`, kind, retryable: true, terminal: false });
}

describe("freshness and the clock", () => {
  test("a clock that jumps backwards does not freeze the cache as fresh", async () => {
    // NTP corrections and laptop sleep both move the clock backwards. A naive
    // `now - fetchedAt < ttl` reads a negative age as fresh, so a one-hour jump
    // back would pin a stale catalogue for an hour past its TTL.
    const stub = stubTransport(twoModels);
    let now = 1_000_000;
    const registry = makeRegistry(stub, { now: () => now, ttlMs: 60_000 });

    await registry.list();
    assert.equal(stub.calls, 1);

    now -= 3_600_000;
    await registry.list();
    assert.equal(stub.calls, 2, "a backwards clock must force a refresh, not extend freshness");
  });

  test("an entry exactly at the TTL boundary is stale", async () => {
    const stub = stubTransport(twoModels);
    let now = 1_000;
    const registry = makeRegistry(stub, { now: () => now, ttlMs: 5_000 });

    await registry.list();
    now += 4_999;
    await registry.list();
    assert.equal(stub.calls, 1, "just inside the window is still fresh");

    now += 1;
    await registry.list();
    assert.equal(stub.calls, 2, "exactly at the window is stale");
  });

  test("a zero TTL means never reuse", async () => {
    const stub = stubTransport(twoModels);
    const registry = makeRegistry(stub, { now: () => 1_000, ttlMs: 0 });
    await registry.list();
    await registry.list();
    await registry.list();
    assert.equal(stub.calls, 3);
  });

  test("an infinite TTL means fetch once", async () => {
    const stub = stubTransport(twoModels);
    let now = 0;
    const registry = makeRegistry(stub, { now: () => now, ttlMs: Number.POSITIVE_INFINITY });
    await registry.list();
    now = Number.MAX_SAFE_INTEGER;
    await registry.list();
    assert.equal(stub.calls, 1);
  });

  test("fetchedAt is an ISO timestamp taken from the injected clock", async () => {
    const stub = stubTransport(twoModels);
    const listing = await makeRegistry(stub, { now: () => 1_700_000_000_000 }).list();
    assert.equal(listing.fetchedAt, new Date(1_700_000_000_000).toISOString());
  });
});

describe("catalogues that are not two well-formed models", () => {
  test("a model with a blank id never reaches a picker", async () => {
    const stub = stubTransport(async () => [
      { id: "real", ownedBy: null },
      { id: "", ownedBy: null },
      { id: "   ", ownedBy: null },
    ]);
    const listing = await makeRegistry(stub).list();
    assert.deepEqual(listing.models.map((m) => m.id), ["real"]);
  });

  test("duplicate ids are reported once", async () => {
    // A duplicated entry is a gateway misconfiguration, but a picker rendering
    // the same model twice is our bug, not theirs.
    const stub = stubTransport(async () => [
      { id: "a", ownedBy: "hasa" },
      { id: "a", ownedBy: "someone-else" },
      { id: "b", ownedBy: null },
    ]);
    const listing = await makeRegistry(stub).list();
    assert.deepEqual(listing.models.map((m) => m.id), ["a", "b"]);
    assert.equal(listing.models[0]?.ownedBy, "hasa", "the first entry wins");
  });

  test("gateway order is preserved", async () => {
    const ids = ["z", "m", "a", "0", "가"];
    const stub = stubTransport(async () => ids.map((id) => ({ id, ownedBy: null })));
    assert.deepEqual((await makeRegistry(stub).list()).models.map((m) => m.id), ids);
  });

  test("a catalogue far larger than HASA's is handled", async () => {
    const stub = stubTransport(async () =>
      Array.from({ length: 20_000 }, (_, i) => ({ id: `m${i}`, ownedBy: null })),
    );
    const listing = await makeRegistry(stub, { cache: new MemoryModelCache() }).list();
    assert.equal(listing.models.length, 20_000);
  });

  test("ids with unusual characters survive", async () => {
    const ids = ["a/b", "a:b", "모델", "🧑‍💻", "x".repeat(300)];
    const stub = stubTransport(async () => ids.map((id) => ({ id, ownedBy: null })));
    assert.deepEqual((await makeRegistry(stub).list()).models.map((m) => m.id), ids);
  });
});

describe("the cache as a dependency that can itself fail", () => {
  test("a cache that throws on read is treated as empty", async () => {
    const cache: ModelCacheStore = {
      read: async () => {
        throw new Error("disk unreadable");
      },
      write: async () => {},
      clear: async () => {},
    };
    const stub = stubTransport(async () => {
      throw hasa("network");
    });
    await assert.rejects(
      makeRegistry(stub, { cache }).list(),
      (e: unknown) => e instanceof ProviderError && e.code === "network",
    );
  });

  test("a cache that throws on write does not fail the request it was helping", async () => {
    const cache: ModelCacheStore = {
      read: async () => null,
      write: async () => {
        throw new Error("disk full");
      },
      clear: async () => {},
    };
    const listing = await makeRegistry(stubTransport(twoModels), { cache }).list();
    assert.equal(listing.models.length, 2);
    assert.equal(listing.source, "network");
  });

  test("a cache holding an entry for another scope is not used", async () => {
    const cache = new MemoryModelCache();
    await cache.write({
      version: 1,
      scope: cacheScope(BASE_URL, "sha256:someoneelse"),
      fetchedAt: "2026-01-01T00:00:00.000Z",
      models: [{ id: "not-mine", ownedBy: null }],
    });
    const stub = stubTransport(async () => {
      throw hasa("network");
    });
    await assert.rejects(makeRegistry(stub, { cache }).list());
  });

  test("the cached entry is written under this registry's own scope", async () => {
    const cache = new MemoryModelCache();
    await makeRegistry(stubTransport(twoModels), { cache }).list();
    const stored = await cache.read(SCOPE);
    assert.equal(stored?.scope, SCOPE);
    assert.ok(!stored?.scope.includes("hasa-live-key"), "the scope carries a digest, not the key");
  });

  test("a different gateway gets a different cache entry", async () => {
    const cache = new MemoryModelCache();
    await makeRegistry(stubTransport(twoModels), { cache }).list();
    const other = stubTransport(async () => [{ id: "elsewhere", ownedBy: null }], "http://127.0.0.1:9/v1");
    await makeRegistry(other, { cache }).list();

    assert.deepEqual((await cache.read(SCOPE))?.models.map((m) => m.id), ["a", "b"]);
    assert.deepEqual(
      (await cache.read(cacheScope("http://127.0.0.1:9/v1", PRINT)))?.models.map((m) => m.id),
      ["elsewhere"],
    );
  });

  test("a stale listing reports when it was fetched, not when it was served", async () => {
    const cache = new MemoryModelCache();
    const entry: CachedModelList = {
      version: 1,
      scope: SCOPE,
      fetchedAt: "2026-07-01T12:00:00.000Z",
      models: [{ id: "cached", ownedBy: null }],
    };
    await cache.write(entry);

    const stub = stubTransport(async () => {
      throw hasa("unavailable");
    });
    const listing = await makeRegistry(stub, { cache }).list();
    assert.equal(listing.fetchedAt, "2026-07-01T12:00:00.000Z");
    assert.equal(listing.stale, true);
  });

  test("the stale warning is in the user's language and names no internals", async () => {
    const cache = new MemoryModelCache();
    await makeRegistry(stubTransport(twoModels), { cache }).list();
    const stub2 = stubTransport(async () => {
      throw hasa("unavailable");
    });
    const registry = makeRegistry(stub2, { cache, ttlMs: 0 });
    const listing = await registry.list();

    assert.ok(listing.warning !== null);
    assert.match(listing.warning, /[가-힣]/);
    assert.doesNotMatch(listing.warning, /HasaError|503|stack|undefined/);
  });

  test("capabilities are recomputed for a cached list, not frozen into it", async () => {
    // The cache stores ids. Measurements taken since it was written must show up
    // the next time the list is served, without a refetch.
    const cache = new MemoryModelCache();
    let measured = false;
    const capabilitiesOf = (): ModelCapabilities => ({
      ...unknownCapabilities(),
      chat: measured ? true : "unknown",
    });

    await makeRegistry(stubTransport(twoModels), { cache, capabilitiesOf }).list();

    measured = true;
    const stub = stubTransport(async () => {
      throw hasa("network");
    });
    const listing = await makeRegistry(stub, { cache, capabilitiesOf }).list();
    assert.equal(listing.source, "cache");
    assert.equal(listing.models[0]?.capabilities.chat, true);
  });
});

describe("concurrency", () => {
  test("many simultaneous callers make one request and all get the same list", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = stubTransport(async () => {
      await gate;
      return twoModels();
    });
    const registry = makeRegistry(stub);

    const all = Promise.all(Array.from({ length: 64 }, () => registry.list()));
    release();
    const listings = await all;

    assert.equal(stub.calls, 1);
    for (const listing of listings) {
      assert.deepEqual(listing.models.map((m) => m.id), ["a", "b"]);
    }
  });

  test("a shared failure rejects every caller with the same classification", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = stubTransport(async () => {
      await gate;
      throw hasa("unavailable");
    });
    const registry = makeRegistry(stub);

    const all = Promise.allSettled(Array.from({ length: 16 }, () => registry.list()));
    release();
    const results = await all;

    assert.equal(stub.calls, 1);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      assert.ok(result.reason instanceof ProviderError);
      assert.equal((result.reason as ProviderError).code, "unavailable");
    }
  });

  test("the in-flight slot is released after success, so the next TTL expiry refetches", async () => {
    const stub = stubTransport(twoModels);
    let now = 0;
    const registry = makeRegistry(stub, { now: () => now, ttlMs: 10 });
    await Promise.all([registry.list(), registry.list()]);
    assert.equal(stub.calls, 1);
    now += 100;
    await registry.list();
    assert.equal(stub.calls, 2);
  });

  test("invalidate during a refresh does not corrupt the result", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = stubTransport(async () => {
      await gate;
      return twoModels();
    });
    const registry = makeRegistry(stub, { ttlMs: 60_000 });

    const pending = registry.list();
    registry.invalidate();
    release();
    const listing = await pending;

    assert.deepEqual(listing.models.map((m) => m.id), ["a", "b"]);
    assert.match(listing.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  test("interleaved success and failure never leaves a poisoned slot", async () => {
    const stub = stubTransport(twoModels);
    const registry = makeRegistry(stub, { ttlMs: 0 });

    for (let round = 0; round < 20; round += 1) {
      stub.answer = round % 2 === 0 ? twoModels : async () => {
        throw hasa("unavailable");
      };
      const results = await Promise.allSettled([registry.list(), registry.list()]);
      const expected = round % 2 === 0 ? "fulfilled" : "rejected";
      for (const result of results) assert.equal(result.status, expected, `round ${round}`);
    }
  });
});

describe("cancellation", () => {
  test("an already-aborted signal is reported as a cancellation, not an outage", async () => {
    const controller = new AbortController();
    controller.abort();
    const stub = stubTransport(async () => {
      throw new HasaError({
        message: "network error",
        kind: "network",
        retryable: false,
        terminal: true,
        cause: controller.signal.reason,
      });
    });

    await assert.rejects(
      makeRegistry(stub, { cache: new MemoryModelCache() }).list({ signal: controller.signal }),
      (e: unknown) => e instanceof ProviderError && e.code === "aborted",
    );
  });

  test("a cancellation is never answered from cache", async () => {
    const cache = new MemoryModelCache();
    const stub = stubTransport(twoModels);
    const registry = makeRegistry(stub, { cache, ttlMs: 0 });
    await registry.list();

    stub.answer = async () => {
      throw new HasaError({ message: "aborted", kind: "network", retryable: false, terminal: true });
    };
    await assert.rejects(
      registry.list(),
      (e: unknown) => e instanceof ProviderError && e.code === "aborted",
    );
  });
});

describe("error classification passes through", () => {
  const cases: Array<[Parameters<typeof hasa>[0], string]> = [
    ["auth", "unauthorized"],
    ["forbidden", "forbidden"],
    ["rate_limit", "rate_limited"],
    ["unavailable", "unavailable"],
    ["network", "network"],
  ];

  for (const [kind, code] of cases) {
    test(`${kind} from the transport surfaces as ${code}`, async () => {
      const stub = stubTransport(async () => {
        throw hasa(kind);
      });
      await assert.rejects(
        makeRegistry(stub).list(),
        (e: unknown) => e instanceof ProviderError && e.code === code,
      );
    });
  }

  test("a non-HasaError throwable still becomes a ProviderError", async () => {
    const stub = stubTransport(async () => {
      throw new TypeError("transport is broken");
    });
    await assert.rejects(makeRegistry(stub).list(), (e: unknown) => e instanceof ProviderError);
  });
});
