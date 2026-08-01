import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { clearSecrets, redactString } from "../hasa-client/redact.ts";
import {
  EnvCredentialStore,
  InMemorySecretStorage,
  MIN_API_KEY_LENGTH,
  SecretStorageCredentialStore,
  assertUsableApiKey,
  normalizeApiKey,
  type SecretStorageLike,
} from "./credentials.ts";
import { ProviderError } from "./errors.ts";
import { createHasaCredentialStore } from "./hasa/hasaCredentialStore.ts";

/**
 * Storage that misbehaves, and keys that are not what a key looks like.
 *
 * The most important case in this file is the Thenable one. VS Code's
 * `SecretStorage` returns its own `Thenable`, not a `Promise`; a store written
 * against `Promise` typechecks against a mock and then fails in the only
 * environment that matters.
 */

const KEY = "hasa-live-key-0123456789abcdef";

afterEach(() => {
  clearSecrets();
});

/** A Thenable that is deliberately not a Promise, the way VS Code's is. */
function thenable<T>(value: T): PromiseLike<T> {
  return {
    then<R1 = T, R2 = never>(
      onFulfilled?: ((v: T) => R1 | PromiseLike<R1>) | null,
      _onRejected?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
    ): PromiseLike<R1 | R2> {
      const result = onFulfilled ? onFulfilled(value) : (value as unknown as R1);
      return Promise.resolve(result) as PromiseLike<R1>;
    },
  };
}

class ThenableSecretStorage implements SecretStorageLike {
  private readonly map = new Map<string, string>();

  get(key: string): PromiseLike<string | undefined> {
    return thenable(this.map.get(key));
  }

  store(key: string, value: string): PromiseLike<void> {
    this.map.set(key, value);
    return thenable(undefined);
  }

  delete(key: string): PromiseLike<void> {
    this.map.delete(key);
    return thenable(undefined);
  }
}

class FailingSecretStorage implements SecretStorageLike {
  private readonly failOn: Set<"get" | "store" | "delete">;

  constructor(failOn: Array<"get" | "store" | "delete">) {
    this.failOn = new Set(failOn);
  }

  async get(): Promise<string | undefined> {
    if (this.failOn.has("get")) throw new Error("keychain is locked");
    return undefined;
  }

  async store(): Promise<void> {
    if (this.failOn.has("store")) throw new Error("keychain is locked");
  }

  async delete(): Promise<void> {
    if (this.failOn.has("delete")) throw new Error("keychain is locked");
  }
}

describe("normalizeApiKey", () => {
  test("strips the whitespace a paste actually carries", () => {
    assert.equal(normalizeApiKey(`\n\t ${KEY} \r\n`), KEY);
  });

  test("leaves interior characters alone", () => {
    assert.equal(normalizeApiKey("a-b_c.d"), "a-b_c.d");
  });

  test("a key that is only whitespace normalises to nothing", () => {
    for (const blank of ["", " ", "\t", "\n", "\r\n  \t"]) {
      assert.equal(normalizeApiKey(blank), "");
    }
  });
});

describe("assertUsableApiKey — boundaries", () => {
  test("exactly the minimum length is accepted", () => {
    const key = "a".repeat(MIN_API_KEY_LENGTH);
    assert.equal(assertUsableApiKey(key), key);
  });

  test("one character short is not", () => {
    assert.throws(
      () => assertUsableApiKey("a".repeat(MIN_API_KEY_LENGTH - 1)),
      (e: unknown) => e instanceof ProviderError && e.code === "config",
    );
  });

  test("length is measured after trimming, not before", () => {
    // "  abc  " is seven characters and three of key.
    assert.throws(() => assertUsableApiKey("  abc  "), (e: unknown) => e instanceof ProviderError);
  });

  test("interior whitespace of every kind is rejected", () => {
    for (const gap of [" ", "\t", "\n", "\r", "\f", "\v"]) {
      assert.throws(
        () => assertUsableApiKey(`hasa-key${gap}continued`),
        (e: unknown) => e instanceof ProviderError && e.code === "config",
        `gap ${JSON.stringify(gap)} should be rejected`,
      );
    }
  });

  test("a very long key is accepted — length is not ours to cap", () => {
    const key = `hasa-${"x".repeat(10_000)}`;
    assert.equal(assertUsableApiKey(key), key);
  });

  test("non-ASCII characters are accepted", () => {
    // We do not know HASA's key alphabet, and inventing one would reject a
    // valid key with a confident-sounding message.
    const key = "키-0123456789-ключ";
    assert.equal(assertUsableApiKey(key), key);
  });

  test("every rejection is a config error with a Korean instruction", () => {
    for (const bad of ["", "   ", "short", "has space here"]) {
      try {
        assertUsableApiKey(bad);
        assert.fail(`expected ${JSON.stringify(bad)} to be rejected`);
      } catch (err) {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.code, "config");
        assert.match(err.userMessage, /[가-힣]/);
      }
    }
  });
});

describe("SecretStorageCredentialStore — storage that is not a Promise", () => {
  test("works against a Thenable, which is what VS Code returns", async () => {
    const store = createHasaCredentialStore(new ThenableSecretStorage());
    await store.set(KEY);
    assert.equal(await store.get(), KEY);
    assert.equal(await store.has(), true);
    assert.match((await store.fingerprint()) ?? "", /^sha256:/);
    await store.clear();
    assert.equal(await store.get(), null);
  });
});

describe("SecretStorageCredentialStore — storage that fails", () => {
  test("a locked keychain surfaces rather than reading as 'no key'", async () => {
    // Reporting a locked keychain as an absent key would send the user to
    // re-enter a key they already have.
    const store = createHasaCredentialStore(new FailingSecretStorage(["get"]));
    await assert.rejects(store.get(), /keychain is locked/);
    await assert.rejects(store.has(), /keychain is locked/);
    await assert.rejects(store.fingerprint(), /keychain is locked/);
  });

  test("a failed write is not reported as a success", async () => {
    const store = createHasaCredentialStore(new FailingSecretStorage(["store"]));
    await assert.rejects(store.set(KEY), /keychain is locked/);
  });

  test("a failed delete surfaces", async () => {
    const store = createHasaCredentialStore(new FailingSecretStorage(["delete"]));
    await assert.rejects(store.clear(), /keychain is locked/);
  });

  test("validation runs before storage, so a bad key never reaches the keychain", async () => {
    const secrets = new InMemorySecretStorage();
    const store = createHasaCredentialStore(secrets);
    await assert.rejects(store.set("x"), (e: unknown) => e instanceof ProviderError);
    assert.equal(secrets.raw().size, 0);
  });
});

describe("SecretStorageCredentialStore — values already in storage", () => {
  test("a key stored with surrounding whitespace reads back trimmed", async () => {
    const secrets = new InMemorySecretStorage();
    await secrets.store("hasaArena.apiKey", `  ${KEY}  `);
    assert.equal(await createHasaCredentialStore(secrets).get(), KEY);
  });

  test("an empty string in storage is the same as no key", async () => {
    const secrets = new InMemorySecretStorage();
    await secrets.store("hasaArena.apiKey", "");
    const store = createHasaCredentialStore(secrets);
    assert.equal(await store.get(), null);
    assert.equal(await store.has(), false);
    assert.equal(await store.fingerprint(), null);
  });

  test("a stored key below the minimum length is still returned", async () => {
    // `set` guards the entrance. Refusing to read a short key back would strand
    // a user whose gateway genuinely issues short keys, with no way to clear it.
    const secrets = new InMemorySecretStorage();
    await secrets.store("hasaArena.apiKey", "tiny");
    assert.equal(await createHasaCredentialStore(secrets).get(), "tiny");
  });

  test("a short stored key is not registered with the redactor", async () => {
    // registerSecret ignores values under 8 characters, because masking a
    // 4-character string would blank ordinary words out of every log line.
    const secrets = new InMemorySecretStorage();
    await secrets.store("hasaArena.apiKey", "tiny");
    await createHasaCredentialStore(secrets).get();
    assert.ok(redactString("the word tiny appears here").includes("tiny"));
  });

  test("under a custom key name, the default name is untouched", async () => {
    const secrets = new InMemorySecretStorage();
    await new SecretStorageCredentialStore(secrets, "custom.key").set(KEY);
    assert.deepEqual([...secrets.raw().keys()], ["custom.key"]);
    assert.equal(await createHasaCredentialStore(secrets).get(), null);
  });

  test("two stores over one storage see each other's writes", async () => {
    const secrets = new InMemorySecretStorage();
    const a = createHasaCredentialStore(secrets);
    const b = createHasaCredentialStore(secrets);
    await a.set(KEY);
    assert.equal(await b.get(), KEY);
    await b.clear();
    assert.equal(await a.get(), null);
  });

  test("clearing a store that holds nothing is not an error", async () => {
    await createHasaCredentialStore(new InMemorySecretStorage()).clear();
  });

  test("concurrent reads all agree", async () => {
    const secrets = new InMemorySecretStorage();
    const store = createHasaCredentialStore(secrets);
    await store.set(KEY);
    const reads = await Promise.all(Array.from({ length: 50 }, () => store.get()));
    assert.ok(reads.every((r) => r === KEY));
  });

  test("the last write wins under concurrency, and the store is never left empty", async () => {
    const secrets = new InMemorySecretStorage();
    const store = createHasaCredentialStore(secrets);
    await Promise.all([store.set(`${KEY}-a`), store.set(`${KEY}-b`), store.set(`${KEY}-c`)]);
    const value = await store.get();
    assert.ok(value !== null && value.startsWith(KEY));
  });
});

describe("redaction coverage", () => {
  test("a stored key is masked out of anything that later mentions it", async () => {
    const secrets = new InMemorySecretStorage();
    await createHasaCredentialStore(secrets).set(KEY);

    for (const surface of [
      `Authorization: Bearer ${KEY}`,
      `{"apiKey":"${KEY}"}`,
      `curl -H "authorization: Bearer ${KEY}" https://open.hasa.re.kr/v1/models`,
      `the key is ${KEY} and that is that`,
    ]) {
      assert.ok(!redactString(surface).includes(KEY), surface);
    }
  });

  test("masking does not destroy ordinary model ids around it", () => {
    const line = "model qwen2.5-coder-32b returned 200";
    assert.equal(redactString(line), line);
  });
});

describe("EnvCredentialStore — edges", () => {
  const VAR = "HASA_EDGE_TEST_KEY";

  afterEach(() => {
    delete process.env[VAR];
  });

  test("an empty variable is the same as an unset one", async () => {
    const store = new EnvCredentialStore(VAR);
    process.env[VAR] = "";
    assert.equal(await store.get(), null);
    process.env[VAR] = "   ";
    assert.equal(await store.get(), null);
  });

  test("a short value is returned as-is — env is the operator's business", async () => {
    process.env[VAR] = "tiny";
    assert.equal(await new EnvCredentialStore(VAR).get(), "tiny");
  });

  test("the refusal to write names the variable so it can be fixed", async () => {
    const store = new EnvCredentialStore(VAR);
    await assert.rejects(store.set(), (e: unknown) => e instanceof ProviderError && e.detail.includes(VAR));
    await assert.rejects(store.clear(), (e: unknown) => e instanceof ProviderError && e.detail.includes(VAR));
  });

  test("a change to the environment is visible on the next read", async () => {
    const store = new EnvCredentialStore(VAR);
    assert.equal(await store.get(), null);
    process.env[VAR] = KEY;
    assert.equal(await store.get(), KEY);
    delete process.env[VAR];
    assert.equal(await store.get(), null);
  });
});
