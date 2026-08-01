import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint } from "../hasa-client/redact.ts";
import { forEachSeedAsync } from "../testing/fuzz.ts";
import {
  FileModelCache,
  MODEL_CACHE_VERSION,
  MemoryModelCache,
  cacheScope,
  type CachedModelList,
} from "./modelCache.ts";

const BASE_URL = "https://open.hasa.re.kr/v1";
const KEY = "hasa-live-key-0123456789abcdef";
const SCOPE = cacheScope(BASE_URL, fingerprint(KEY));

function entry(ids: string[], scope = SCOPE): CachedModelList {
  return {
    version: MODEL_CACHE_VERSION,
    scope,
    fetchedAt: "2026-08-01T00:00:00.000Z",
    models: ids.map((id) => ({ id, ownedBy: "hasa" })),
  };
}

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hasa-cache-edge-"));
  dirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function onlyFile(dir: string): Promise<string> {
  const files = await readdir(dir);
  assert.equal(files.length, 1, `expected one cache file, saw ${files.length}`);
  return join(dir, files[0] ?? "");
}

describe("FileModelCache — payloads that are not two models", () => {
  test("a catalogue far larger than HASA's survives the round trip", async () => {
    const cache = new FileModelCache(await tempDir());
    const ids = Array.from({ length: 10_000 }, (_, i) => `vendor/model-${i}`);
    await cache.write(entry(ids));

    const read = await cache.read(SCOPE);
    assert.equal(read?.models.length, 10_000);
    assert.equal(read?.models[9_999]?.id, "vendor/model-9999");
  });

  test("an empty model list is a legitimate entry", async () => {
    const cache = new FileModelCache(await tempDir());
    await cache.write(entry([]));
    assert.deepEqual((await cache.read(SCOPE))?.models, []);
  });

  test("ids with characters that are illegal in a path are stored safely", async () => {
    const cache = new FileModelCache(await tempDir());
    const ids = ["a/b", "..", "../escape", "C:\\windows", "모델 하나", "🧑‍💻", "x".repeat(400), 'quote"inside'];
    await cache.write(entry(ids));
    assert.deepEqual((await cache.read(SCOPE))?.models.map((m) => m.id), ids);
  });

  test("a null owner is preserved as null, not dropped", async () => {
    const cache = new FileModelCache(await tempDir());
    await cache.write({ ...entry([]), models: [{ id: "m", ownedBy: null }] });
    assert.equal((await cache.read(SCOPE))?.models[0]?.ownedBy, null);
  });

  test("the filename depends only on the scope, so a rewrite replaces rather than accumulates", async () => {
    const dir = await tempDir();
    const cache = new FileModelCache(dir);
    await cache.write(entry(["a"]));
    const first = await onlyFile(dir);
    await cache.write(entry(["b", "c"]));
    assert.equal(await onlyFile(dir), first);
    assert.deepEqual((await cache.read(SCOPE))?.models.map((m) => m.id), ["b", "c"]);
  });

  test("two scopes occupy two files", async () => {
    const dir = await tempDir();
    const cache = new FileModelCache(dir);
    const other = cacheScope(BASE_URL, fingerprint("a-different-key-9876543210"));
    await cache.write(entry(["mine"]));
    await cache.write(entry(["theirs"], other));
    assert.equal((await readdir(dir)).length, 2);
    assert.deepEqual((await cache.read(SCOPE))?.models.map((m) => m.id), ["mine"]);
    assert.deepEqual((await cache.read(other))?.models.map((m) => m.id), ["theirs"]);
  });
});

describe("FileModelCache — concurrency", () => {
  const WRITERS = 16;
  const MODELS = 25_000;
  const ROUNDS = 4;

  test("concurrent writes to one scope leave a complete entry, never a spliced one", async () => {
    // Same process, same scope, at once: two panels refreshing, or a retry
    // racing its own first attempt.
    //
    // The size matters. At a few thousand models each write lands in one go and
    // the race never shows; at this size a write spans many syscalls, and with
    // a shared temporary path the published file was assembled from several
    // writers in 16 of 40 measured rounds — once as invalid JSON. Shrinking
    // this test would quietly stop testing anything.
    const dir = await tempDir();
    const cache = new FileModelCache(dir);

    for (let round = 0; round < ROUNDS; round += 1) {
      const payloads = Array.from({ length: WRITERS }, (_, i) =>
        entry(Array.from({ length: MODELS }, (_, j) => `writer${i}/model-${j}`)),
      );
      await Promise.all(payloads.map((p) => cache.write(p)));

      const read = await cache.read(SCOPE);
      assert.ok(read !== null, `round ${round}: a concurrent write destroyed the cache`);
      assert.equal(read.models.length, MODELS, `round ${round}: the surviving entry is truncated`);
      const writer = read.models[0]?.id.split("/")[0];
      assert.ok(
        read.models.every((m) => m.id.startsWith(`${writer}/`)),
        `round ${round}: the entry was spliced from several writers`,
      );
    }
  });

  test("a lost race leaves no debris behind", async () => {
    // Giving each writer its own temporary path fixes the splice but not the
    // litter: on Windows the loser's rename fails outright, and without an
    // explicit cleanup its megabyte-sized temporary file stays forever. One
    // measured run left 265 of them.
    const dir = await tempDir();
    const cache = new FileModelCache(dir);

    for (let round = 0; round < ROUNDS; round += 1) {
      await Promise.all(
        Array.from({ length: WRITERS }, (_, i) =>
          cache.write(entry(Array.from({ length: MODELS }, (_, j) => `writer${i}/model-${j}`))),
        ),
      );
    }

    const files = await readdir(dir);
    assert.deepEqual(files.filter((f) => f.endsWith(".tmp")), [], "temporary files must not survive");
    assert.equal(files.length, 1, "one scope means one file, however many writers raced for it");
  });

  test("reads during a write see either the old entry or the new one", async () => {
    const dir = await tempDir();
    const cache = new FileModelCache(dir);
    await cache.write(entry(["old"]));

    const writes = Promise.all(
      Array.from({ length: 8 }, () =>
        cache.write(entry(Array.from({ length: 3_000 }, (_, j) => `new-${j}`))),
      ),
    );
    const reads = await Promise.all(Array.from({ length: 40 }, () => cache.read(SCOPE)));
    await writes;

    for (const read of reads) {
      if (read === null) continue; // a miss is acceptable; a wrong answer is not
      const ids = read.models.map((m) => m.id);
      assert.ok(
        ids.length === 1 ? ids[0] === "old" : ids.every((id) => id.startsWith("new-")),
        "a read must never observe a mixture of two entries",
      );
    }
  });

  test("two cache instances over one directory agree", async () => {
    const dir = await tempDir();
    const a = new FileModelCache(dir);
    const b = new FileModelCache(dir);
    await a.write(entry(["shared"]));
    assert.deepEqual((await b.read(SCOPE))?.models.map((m) => m.id), ["shared"]);
    await b.clear(SCOPE);
    assert.equal(await a.read(SCOPE), null);
  });
});

describe("FileModelCache — corrupt and hostile files", () => {
  const corruptions: Array<[string, string]> = [
    ["empty file", ""],
    ["whitespace only", "   \n"],
    ["truncated json", '{"version":1,"scope":"'],
    ["json null", "null"],
    ["json array", "[]"],
    ["json string", '"a string"'],
    ["json number", "42"],
    ["missing version", JSON.stringify({ scope: SCOPE, fetchedAt: "x", models: [] })],
    ["wrong version", JSON.stringify({ version: 2, scope: SCOPE, fetchedAt: "x", models: [] })],
    ["version as string", JSON.stringify({ version: "1", scope: SCOPE, fetchedAt: "x", models: [] })],
    ["models not an array", JSON.stringify({ version: 1, scope: SCOPE, fetchedAt: "x", models: {} })],
    ["models holding nulls", JSON.stringify({ version: 1, scope: SCOPE, fetchedAt: "x", models: [null] })],
    ["models holding strings", JSON.stringify({ version: 1, scope: SCOPE, fetchedAt: "x", models: ["m"] })],
    ["model without an id", JSON.stringify({ version: 1, scope: SCOPE, fetchedAt: "x", models: [{ ownedBy: null }] })],
    ["model id not a string", JSON.stringify({ version: 1, scope: SCOPE, fetchedAt: "x", models: [{ id: 1, ownedBy: null }] })],
    ["ownedBy missing", JSON.stringify({ version: 1, scope: SCOPE, fetchedAt: "x", models: [{ id: "m" }] })],
    ["ownedBy a number", JSON.stringify({ version: 1, scope: SCOPE, fetchedAt: "x", models: [{ id: "m", ownedBy: 1 }] })],
    ["fetchedAt missing", JSON.stringify({ version: 1, scope: SCOPE, models: [] })],
    ["scope missing", JSON.stringify({ version: 1, fetchedAt: "x", models: [] })],
    ["a JSON bomb of nesting", `${"[".repeat(2000)}${"]".repeat(2000)}`],
  ];

  for (const [name, contents] of corruptions) {
    test(`${name} reads as no cache, not as an error`, async () => {
      const dir = await tempDir();
      const cache = new FileModelCache(dir);
      await cache.write(entry(["good"]));
      await writeFile(await onlyFile(dir), contents, "utf8");
      assert.equal(await cache.read(SCOPE), null, name);
    });
  }

  test("a file with a UTF-8 BOM is rejected rather than half-parsed", async () => {
    const dir = await tempDir();
    const cache = new FileModelCache(dir);
    await cache.write(entry(["good"]));
    const path = await onlyFile(dir);
    await writeFile(path, `\uFEFF${JSON.stringify(entry(["good"]))}`, "utf8");
    // JSON.parse rejects a BOM; the important part is that nothing throws.
    assert.equal(await cache.read(SCOPE), null);
  });

  test("a directory where the cache file should be reads as no cache", async () => {
    const dir = await tempDir();
    const cache = new FileModelCache(dir);
    await cache.write(entry(["good"]));
    const path = await onlyFile(dir);
    await rm(path);
    await mkdir(path);
    assert.equal(await cache.read(SCOPE), null);
  });

  test("reading a scope that was never written is a miss, not a failure", async () => {
    const cache = new FileModelCache(await tempDir());
    assert.equal(await cache.read("never-written"), null);
  });

  test("clearing a scope that was never written is not an error", async () => {
    await new FileModelCache(await tempDir()).clear("never-written");
  });

  test("an entry whose payload contradicts its filename is refused", async () => {
    // Guards against a digest collision and against a cache directory copied
    // between machines or between keys.
    const dir = await tempDir();
    const cache = new FileModelCache(dir);
    await cache.write(entry(["mine"]));
    await writeFile(await onlyFile(dir), JSON.stringify(entry(["theirs"], "someone-elses-scope")), "utf8");
    assert.equal(await cache.read(SCOPE), null);
  });
});

describe("MemoryModelCache — edges", () => {
  test("overwriting replaces rather than merges", async () => {
    const cache = new MemoryModelCache();
    await cache.write(entry(["a", "b"]));
    await cache.write(entry(["c"]));
    assert.deepEqual((await cache.read(SCOPE))?.models.map((m) => m.id), ["c"]);
  });

  test("clearing an absent scope is not an error", async () => {
    await new MemoryModelCache().clear("nothing-here");
  });

  test("holds many scopes without confusing them", async () => {
    const cache = new MemoryModelCache();
    const scopes = Array.from({ length: 500 }, (_, i) => cacheScope(BASE_URL, `sha256:${i}`));
    await Promise.all(scopes.map((scope, i) => cache.write(entry([`m${i}`], scope))));
    for (let i = 0; i < scopes.length; i += 1) {
      assert.deepEqual((await cache.read(scopes[i] ?? ""))?.models.map((m) => m.id), [`m${i}`]);
    }
  });
});

describe("no credential reaches the disk, whatever the model ids are", () => {
  test("holds over generated catalogues", async () => {
    const dir = await tempDir();
    const cache = new FileModelCache(dir);

    await forEachSeedAsync(async (rng) => {
      const scope = cacheScope(BASE_URL, fingerprint(KEY));
      const ids = Array.from({ length: rng.int(0, 20) }, () => rng.string(30));
      await cache.write({
        version: MODEL_CACHE_VERSION,
        scope,
        fetchedAt: new Date(0).toISOString(),
        models: ids.map((id) => ({ id, ownedBy: rng.bool() ? rng.string(10) : null })),
      });

      const files = await readdir(dir);
      for (const name of files) {
        assert.ok(!name.includes(KEY), "filename leaked the key");
        const raw = await readFile(join(dir, name), "utf8");
        assert.ok(!raw.includes(KEY), "payload leaked the key");
      }
      const read = await cache.read(scope);
      assert.deepEqual(read?.models.map((m) => m.id), ids, "the catalogue survived the round trip");
    }, 60);
  });
});
