import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint } from "../hasa-client/redact.ts";
import {
  FileModelCache,
  MODEL_CACHE_VERSION,
  MemoryModelCache,
  cacheScope,
  type CachedModelList,
} from "./modelCache.ts";

const BASE_URL = "https://open.hasa.re.kr/v1";
const KEY = "hasa-live-key-0123456789abcdef";
const OTHER_KEY = "hasa-other-key-abcdef0123456789";

function entryFor(scope: string, ids: string[]): CachedModelList {
  return {
    version: MODEL_CACHE_VERSION,
    scope,
    fetchedAt: "2026-08-01T00:00:00.000Z",
    models: ids.map((id) => ({ id, ownedBy: "hasa" })),
  };
}

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hasa-model-cache-"));
  dirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("cacheScope", () => {
  test("separates two keys on the same gateway", () => {
    const a = cacheScope(BASE_URL, fingerprint(KEY));
    const b = cacheScope(BASE_URL, fingerprint(OTHER_KEY));
    assert.notEqual(a, b);
  });

  test("separates two gateways under the same key", () => {
    const print = fingerprint(KEY);
    assert.notEqual(cacheScope(BASE_URL, print), cacheScope("http://127.0.0.1:9/v1", print));
  });

  test("carries a digest, never the key", () => {
    const scope = cacheScope(BASE_URL, fingerprint(KEY));
    assert.ok(!scope.includes(KEY));
  });
});

describe("MemoryModelCache", () => {
  test("round-trips and clears", async () => {
    const cache = new MemoryModelCache();
    const scope = cacheScope(BASE_URL, fingerprint(KEY));

    assert.equal(await cache.read(scope), null);
    await cache.write(entryFor(scope, ["m/a", "m/b"]));
    assert.deepEqual((await cache.read(scope))?.models.map((m) => m.id), ["m/a", "m/b"]);

    await cache.clear(scope);
    assert.equal(await cache.read(scope), null);
  });

  test("one key's catalogue is invisible to another", async () => {
    const cache = new MemoryModelCache();
    const mine = cacheScope(BASE_URL, fingerprint(KEY));
    const theirs = cacheScope(BASE_URL, fingerprint(OTHER_KEY));

    await cache.write(entryFor(mine, ["m/private"]));
    assert.equal(await cache.read(theirs), null);
  });
});

describe("FileModelCache", () => {
  test("survives a round trip through disk", async () => {
    const cache = new FileModelCache(await tempDir());
    const scope = cacheScope(BASE_URL, fingerprint(KEY));

    await cache.write(entryFor(scope, ["m/a"]));
    const read = await cache.read(scope);
    assert.equal(read?.scope, scope);
    assert.deepEqual(read?.models, [{ id: "m/a", ownedBy: "hasa" }]);
  });

  test("the written bytes contain no key material", async () => {
    const dir = await tempDir();
    const cache = new FileModelCache(dir);
    const scope = cacheScope(BASE_URL, fingerprint(KEY));
    await cache.write(entryFor(scope, ["m/a", "m/b"]));

    const files = await readdir(dir);
    assert.equal(files.length, 1);

    const name = files[0] ?? "";
    const raw = await readFile(join(dir, name), "utf8");
    // The payload, and the filename it is stored under, are both derived from a
    // digest. Neither may be reversible to the credential.
    assert.ok(!raw.includes(KEY), "cache payload leaked the API key");
    assert.ok(!name.includes(KEY), "cache filename leaked the API key");
    assert.ok(!raw.includes("apiKey") && !raw.includes("authorization"));
  });

  test("refuses an entry stored under a different scope", async () => {
    const dir = await tempDir();
    const cache = new FileModelCache(dir);
    const scope = cacheScope(BASE_URL, fingerprint(KEY));

    await cache.write(entryFor(scope, ["m/a"]));
    const files = await readdir(dir);
    const path = join(dir, files[0] ?? "");
    await writeFile(path, JSON.stringify(entryFor("some-other-scope", ["m/evil"])), "utf8");

    assert.equal(await cache.read(scope), null);
  });

  test("a corrupt file degrades to no cache rather than to an error", async () => {
    const dir = await tempDir();
    const cache = new FileModelCache(dir);
    const scope = cacheScope(BASE_URL, fingerprint(KEY));

    await cache.write(entryFor(scope, ["m/a"]));
    const files = await readdir(dir);
    await writeFile(join(dir, files[0] ?? ""), "{ this is not json", "utf8");

    assert.equal(await cache.read(scope), null);
  });

  test("an entry from a future schema version is ignored", async () => {
    const dir = await tempDir();
    const cache = new FileModelCache(dir);
    const scope = cacheScope(BASE_URL, fingerprint(KEY));

    await cache.write(entryFor(scope, ["m/a"]));
    const files = await readdir(dir);
    const path = join(dir, files[0] ?? "");
    await writeFile(path, JSON.stringify({ ...entryFor(scope, ["m/a"]), version: 99 }), "utf8");

    assert.equal(await cache.read(scope), null);
  });

  test("an unwritable directory is not an error the caller has to handle", async () => {
    // Writing into a path whose parent is a file cannot succeed. The cache is an
    // optimisation; failing to populate it must not fail the request that was
    // trying to be helpful.
    const dir = await tempDir();
    const blocked = join(dir, "not-a-dir");
    await writeFile(blocked, "x", "utf8");

    const cache = new FileModelCache(join(blocked, "cache"));
    const scope = cacheScope(BASE_URL, fingerprint(KEY));
    await cache.write(entryFor(scope, ["m/a"]));
    assert.equal(await cache.read(scope), null);
  });

  test("clear removes the entry", async () => {
    const cache = new FileModelCache(await tempDir());
    const scope = cacheScope(BASE_URL, fingerprint(KEY));
    await cache.write(entryFor(scope, ["m/a"]));
    await cache.clear(scope);
    assert.equal(await cache.read(scope), null);
  });
});
