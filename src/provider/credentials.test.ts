import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { clearSecrets, redactString } from "../hasa-client/redact.ts";
import {
  EnvCredentialStore,
  InMemorySecretStorage,
  MIN_API_KEY_LENGTH,
  SecretStorageCredentialStore,
  assertUsableApiKey,
} from "./credentials.ts";
import { ProviderError } from "./errors.ts";
import { HASA_SECRET_KEY, createHasaCredentialStore } from "./hasa/hasaCredentialStore.ts";

const KEY = "hasa-live-key-0123456789abcdef";

afterEach(() => {
  clearSecrets();
});

describe("assertUsableApiKey", () => {
  test("trims and returns a usable key", () => {
    assert.equal(assertUsableApiKey(`  ${KEY}\n`), KEY);
  });

  test("rejects an empty key before any request is made", () => {
    assert.throws(
      () => assertUsableApiKey("   "),
      (e: unknown) => e instanceof ProviderError && e.code === "config",
    );
  });

  test("rejects a key shorter than the minimum", () => {
    assert.throws(
      () => assertUsableApiKey("a".repeat(MIN_API_KEY_LENGTH - 1)),
      (e: unknown) => e instanceof ProviderError && e.code === "config",
    );
  });

  test("rejects a key with embedded whitespace — a half-pasted key", () => {
    assert.throws(
      () => assertUsableApiKey("hasa-live key-012345"),
      (e: unknown) => e instanceof ProviderError && e.code === "config",
    );
  });

  test("the rejection message never repeats the key back", () => {
    const partial = "sk-a1b2";
    try {
      assertUsableApiKey(`${partial} c3d4`);
      assert.fail("expected rejection");
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.ok(!err.message.includes(partial), err.message);
      assert.ok(!err.userMessage.includes(partial), err.userMessage);
    }
  });
});

describe("SecretStorageCredentialStore", () => {
  test("saves, reads back and deletes", async () => {
    const secrets = new InMemorySecretStorage();
    const store = new SecretStorageCredentialStore(secrets, HASA_SECRET_KEY);

    assert.equal(await store.get(), null);
    assert.equal(await store.has(), false);

    await store.set(KEY);
    assert.equal(await store.get(), KEY);
    assert.equal(await store.has(), true);

    await store.clear();
    assert.equal(await store.get(), null);
    assert.equal(await store.has(), false);
  });

  test("stores under the key the Arena extension already uses", async () => {
    const secrets = new InMemorySecretStorage();
    await createHasaCredentialStore(secrets).set(KEY);
    assert.deepEqual([...secrets.raw().keys()], [HASA_SECRET_KEY]);
  });

  test("normalises on the way in, so a pasted newline is not stored", async () => {
    const secrets = new InMemorySecretStorage();
    await createHasaCredentialStore(secrets).set(` ${KEY} `);
    assert.equal(secrets.raw().get(HASA_SECRET_KEY), KEY);
  });

  test("refuses to store an unusable key", async () => {
    const secrets = new InMemorySecretStorage();
    const store = createHasaCredentialStore(secrets);
    await assert.rejects(store.set("nope"), (e: unknown) => e instanceof ProviderError);
    assert.equal(secrets.raw().size, 0, "nothing must land in storage on rejection");
  });

  test("a key written by an earlier session is treated as blank when empty", async () => {
    const secrets = new InMemorySecretStorage();
    await secrets.store(HASA_SECRET_KEY, "   ");
    assert.equal(await createHasaCredentialStore(secrets).get(), null);
  });

  test("reading registers the key with the redactor", async () => {
    const secrets = new InMemorySecretStorage();
    await secrets.store(HASA_SECRET_KEY, KEY);
    // Before any read the redactor has never seen this value.
    assert.ok(redactString(`token=${KEY}`).includes(KEY));

    await createHasaCredentialStore(secrets).get();

    // A key restored from a previous session never passes through `set`, so if
    // reading did not register it, every later log line would leak it.
    assert.ok(!redactString(`token=${KEY}`).includes(KEY));
  });

  test("the fingerprint identifies the key without containing it", async () => {
    const secrets = new InMemorySecretStorage();
    const store = createHasaCredentialStore(secrets);
    assert.equal(await store.fingerprint(), null);

    await store.set(KEY);
    const print = await store.fingerprint();
    assert.ok(print !== null);
    assert.match(print, /^sha256:[0-9a-f]{12}$/);
    assert.ok(!print.includes(KEY));

    // Same key, same fingerprint — that is what makes it usable as a cache scope.
    await store.set(KEY);
    assert.equal(await store.fingerprint(), print);
  });

  test("different keys fingerprint differently", async () => {
    const a = createHasaCredentialStore(new InMemorySecretStorage());
    const b = createHasaCredentialStore(new InMemorySecretStorage());
    await a.set(KEY);
    await b.set(`${KEY}-other`);
    assert.notEqual(await a.fingerprint(), await b.fingerprint());
  });
});

describe("EnvCredentialStore", () => {
  const VAR = "HASA_TEST_KEY_FIXTURE";

  test("reads the variable and refuses to write it", async () => {
    const store = new EnvCredentialStore(VAR);
    assert.equal(await store.get(), null);

    process.env[VAR] = ` ${KEY} `;
    try {
      assert.equal(await store.get(), KEY);
      assert.equal(await store.has(), true);
      await assert.rejects(store.set(), (e: unknown) => e instanceof ProviderError);
      await assert.rejects(store.clear(), (e: unknown) => e instanceof ProviderError);
    } finally {
      delete process.env[VAR];
    }
  });
});
