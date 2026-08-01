import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { HasaError, type ErrorKind } from "../../hasa-client/errors.ts";
import { nullLogger } from "../../hasa-client/logger.ts";
import { forEachSeedAsync, fuzzIterations, type Rng } from "../../testing/fuzz.ts";
import { ProviderError } from "../errors.ts";
import { MemoryModelCache } from "../modelCache.ts";
import type {
  ChatTransport,
  TransportModelRecord,
} from "../openai-compatible/openaiCompatibleProvider.ts";
import type { ModelListing } from "../types.ts";
import { HasaModelRegistry } from "./hasaModelRegistry.ts";

/**
 * The registry, driven through random sequences of everything that can happen
 * to it.
 *
 * Four of the defects found in this file were state-transition bugs — a clock
 * moving backwards, a cache write failing, an in-flight request overlapping an
 * invalidation. Hand-written cases found them one at a time because someone
 * thought of each; this generates the sequences instead.
 */

const KEY_PRINT = "sha256:abcdef012345";

type Operation =
  | { kind: "list" }
  | { kind: "refresh" }
  | { kind: "invalidate" }
  | { kind: "advanceClock"; ms: number }
  | { kind: "rewindClock"; ms: number }
  | { kind: "setCatalogue"; models: TransportModelRecord[] }
  | { kind: "setFailure"; error: ErrorKind | null }
  | { kind: "breakCache" }
  | { kind: "fixCache" }
  | { kind: "concurrentList"; count: number };

function generateOperations(rng: Rng): Operation[] {
  const count = rng.int(1, 25);
  return Array.from({ length: count }, (): Operation => {
    switch (rng.int(0, 9)) {
      case 0:
        return { kind: "refresh" };
      case 1:
        return { kind: "invalidate" };
      case 2:
        return { kind: "advanceClock", ms: rng.pick([1, 1_000, 60_000, 3_600_000]) };
      case 3:
        return { kind: "rewindClock", ms: rng.pick([1, 60_000, 3_600_000]) };
      case 4:
        return {
          kind: "setCatalogue",
          models: Array.from({ length: rng.int(0, 6) }, (_, i) => ({
            id: rng.bool(0.15) ? rng.pick(["", "  ", "dup"]) : `model-${rng.int(0, 8)}-${i}`,
            ownedBy: rng.bool() ? "hasa" : null,
          })),
        };
      case 5:
        return {
          kind: "setFailure",
          error: rng.bool(0.4)
            ? null
            : rng.pick<ErrorKind>(["network", "unavailable", "rate_limit", "auth", "forbidden", "protocol"]),
        };
      case 6:
        return rng.bool() ? { kind: "breakCache" } : { kind: "fixCache" };
      case 7:
        return { kind: "concurrentList", count: rng.int(2, 8) };
      default:
        return { kind: "list" };
    }
  });
}

function assertWellFormed(listing: ModelListing): void {
  const ids = listing.models.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, "a listing must not repeat a model");
  for (const id of ids) assert.ok(id.trim().length > 0, "a listing must not contain a blank id");
  assert.ok(!Number.isNaN(Date.parse(listing.fetchedAt)), "fetchedAt must be a real timestamp");
  if (listing.source === "network") {
    assert.equal(listing.stale, false, "a fresh fetch is never stale");
    assert.equal(listing.warning, null, "a fresh fetch has nothing to warn about");
  }
  if (listing.stale) assert.ok(listing.warning !== null, "a stale listing must explain itself");
}

/** What the transport should return, mutated by the operation stream. */
interface Script {
  catalogue: TransportModelRecord[];
  failure: ErrorKind | null;
  cacheBroken: boolean;
}

describe("HasaModelRegistry — properties over random operation sequences", () => {
  test(`survives ${fuzzIterations()} generated sequences`, async () => {
    await forEachSeedAsync(async (rng) => {
      const script: Script = {
        catalogue: [{ id: "initial", ownedBy: null }],
        failure: null,
        cacheBroken: false,
      };

      let now = 1_700_000_000_000;
      let inFlight = 0;
      let maxInFlight = 0;
      let transportCalls = 0;
      let listCalls = 0;

      const transport: ChatTransport = {
        baseUrl: "https://open.hasa.re.kr/v1",
        listModelRecords: async () => {
          transportCalls += 1;
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          try {
            // A turn of the event loop, so overlapping calls really overlap.
            await Promise.resolve();
            if (script.failure !== null) {
              throw new HasaError({
                message: `HASA ${script.failure}`,
                kind: script.failure,
                retryable: true,
                terminal: false,
              });
            }
            return script.catalogue;
          } finally {
            inFlight -= 1;
          }
        },
        chat: async () => {
          throw new Error("not used");
        },
        streamChunks: async function* () {
          throw new Error("not used");
        },
      };

      const backing = new MemoryModelCache();
      const cache = {
        read: async (scope: string) => {
          if (script.cacheBroken) throw new Error("cache unreadable");
          return backing.read(scope);
        },
        write: async (entry: Parameters<typeof backing.write>[0]) => {
          if (script.cacheBroken) throw new Error("cache unwritable");
          return backing.write(entry);
        },
        clear: async (scope: string) => backing.clear(scope),
      };

      const registry = new HasaModelRegistry({
        transport,
        keyFingerprint: KEY_PRINT,
        cache,
        ttlMs: 30_000,
        now: () => now,
        logger: nullLogger,
      });

      const run = async (opts: { refresh?: boolean } = {}): Promise<void> => {
        listCalls += 1;
        try {
          assertWellFormed(await registry.list(opts));
        } catch (err) {
          assert.ok(err instanceof ProviderError, "only classified errors escape");
          assert.ok(err.userMessage.length > 0);
        }
      };

      for (const op of generateOperations(rng)) {
        switch (op.kind) {
          case "list":
            await run();
            break;
          case "refresh":
            await run({ refresh: true });
            break;
          case "invalidate":
            registry.invalidate();
            break;
          case "advanceClock":
            now += op.ms;
            break;
          case "rewindClock":
            now -= op.ms;
            break;
          case "setCatalogue":
            script.catalogue = op.models;
            break;
          case "setFailure":
            script.failure = op.error;
            break;
          case "breakCache":
            script.cacheBroken = true;
            break;
          case "fixCache":
            script.cacheBroken = false;
            break;
          case "concurrentList": {
            listCalls += op.count;
            const settled = await Promise.allSettled(
              Array.from({ length: op.count }, () => registry.list()),
            );
            for (const result of settled) {
              if (result.status === "fulfilled") assertWellFormed(result.value);
              else assert.ok(result.reason instanceof ProviderError);
            }
            break;
          }
        }
      }

      // Deduplication is the point of the in-flight slot: however many callers
      // arrive at once, the shared GPU gateway sees one request.
      assert.equal(maxInFlight <= 1, true, `${maxInFlight} overlapping requests reached the gateway`);
      assert.ok(transportCalls <= listCalls, "the registry never invents a request");
    });
  });

  test("a working gateway is always preferred to a cache", async () => {
    await forEachSeedAsync(async (rng) => {
      const catalogue: TransportModelRecord[] = Array.from({ length: rng.int(1, 5) }, (_, i) => ({
        id: `m${i}`,
        ownedBy: null,
      }));
      let now = 0;
      const registry = new HasaModelRegistry({
        transport: {
          baseUrl: "https://open.hasa.re.kr/v1",
          listModelRecords: async () => catalogue,
          chat: async () => {
            throw new Error("not used");
          },
          streamChunks: async function* () {
            throw new Error("not used");
          },
        },
        keyFingerprint: KEY_PRINT,
        cache: new MemoryModelCache(),
        ttlMs: rng.pick([0, 1, 1_000]),
        now: () => now,
        logger: nullLogger,
      });

      await registry.list();
      catalogue.push({ id: "added-later", ownedBy: null });
      now += 10_000;

      const listing = await registry.list();
      assert.equal(listing.source, "network");
      assert.deepEqual(listing.models.map((m) => m.id), catalogue.map((m) => m.id));
    }, Math.max(1, Math.floor(fuzzIterations() / 3)));
  });
});
