import { fingerprint, registerSecret } from "../hasa-client/redact.ts";
import { ProviderError } from "./errors.ts";

/**
 * Credential storage.
 *
 * The interesting constraint here is what this file must *not* import. VS Code
 * `SecretStorage` is the required home for the key (docs/security-policy.md
 * §1.2), but importing `vscode` would make the whole provider layer
 * unloadable outside an extension host — no `pnpm test`, no CLI, no
 * orchestrator. So the dependency is expressed structurally: `SecretStorageLike`
 * is exactly the slice of `vscode.SecretStorage` we use, and `context.secrets`
 * satisfies it without either side knowing about the other.
 *
 * See docs/hasa-coding-agent-architecture.md §8 (dependency direction, rule 4).
 */

/**
 * Structural port for `vscode.SecretStorage`.
 *
 * `PromiseLike` rather than `Promise` because VS Code returns its own
 * `Thenable`, which is assignable to this and not to `Promise`.
 */
export interface SecretStorageLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export interface CredentialStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
  has(): Promise<boolean>;
  /** `sha256(key)` prefix, or null when no key is stored. Never the key. */
  fingerprint(): Promise<string | null>;
}

/**
 * Shortest credential we will accept.
 *
 * Matches the existing extension's input validation so that a key already
 * accepted by `hasaArena.setApiKey` is not rejected here.
 */
export const MIN_API_KEY_LENGTH = 8;

export function normalizeApiKey(value: string): string {
  return value.trim();
}

/**
 * Rejects obviously-unusable input before it reaches the network.
 *
 * A blank or truncated key produces a 401 that looks identical to a revoked
 * key, and sending it costs a round trip to tell the user something we already
 * knew.
 */
export function assertUsableApiKey(value: string): string {
  const key = normalizeApiKey(value);
  if (key.length === 0) {
    throw new ProviderError({ code: "config", detail: "API key is empty", userMessage: "API Key를 입력해 주세요." });
  }
  if (key.length < MIN_API_KEY_LENGTH) {
    throw new ProviderError({
      code: "config",
      detail: `API key shorter than ${MIN_API_KEY_LENGTH} characters`,
      userMessage: "API Key가 너무 짧습니다. 전체 키를 붙여넣었는지 확인해 주세요.",
    });
  }
  if (/\s/.test(key)) {
    throw new ProviderError({
      code: "config",
      detail: "API key contains whitespace",
      userMessage: "API Key에 공백이 포함되어 있습니다. 다시 복사해 주세요.",
    });
  }
  return key;
}

/**
 * A key held in an OS secret store.
 *
 * `get` registers the value with the redactor on every read rather than only on
 * `set`: a key stored in a previous session is read back without ever passing
 * through `set`, and an unregistered key is one that log masking cannot see.
 */
export class SecretStorageCredentialStore implements CredentialStore {
  private readonly secrets: SecretStorageLike;
  private readonly key: string;

  constructor(secrets: SecretStorageLike, key: string) {
    this.secrets = secrets;
    this.key = key;
  }

  async get(): Promise<string | null> {
    const stored = await this.secrets.get(this.key);
    if (stored === undefined) return null;
    const value = normalizeApiKey(stored);
    if (value.length === 0) return null;
    registerSecret(value);
    return value;
  }

  async set(value: string): Promise<void> {
    const key = assertUsableApiKey(value);
    registerSecret(key);
    await this.secrets.store(this.key, key);
  }

  async clear(): Promise<void> {
    await this.secrets.delete(this.key);
  }

  async has(): Promise<boolean> {
    return (await this.get()) !== null;
  }

  async fingerprint(): Promise<string | null> {
    const value = await this.get();
    return value === null ? null : fingerprint(value);
  }
}

/** In-process `SecretStorageLike`, for tests and for the CLI's single run. */
export class InMemorySecretStorage implements SecretStorageLike {
  private readonly map = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.map.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  /** Test helper: what actually landed in storage, unfiltered. */
  raw(): ReadonlyMap<string, string> {
    return this.map;
  }
}

/**
 * Read-only store over the process environment.
 *
 * This is how the orchestrator process receives the key today — the extension
 * puts it in the child's env and nothing writes it back. `set` and `clear`
 * therefore fail loudly rather than pretending to work.
 */
export class EnvCredentialStore implements CredentialStore {
  private readonly variable: string;

  constructor(variable: string) {
    this.variable = variable;
  }

  async get(): Promise<string | null> {
    const raw = process.env[this.variable];
    if (raw === undefined) return null;
    const value = normalizeApiKey(raw);
    if (value.length === 0) return null;
    registerSecret(value);
    return value;
  }

  async set(): Promise<never> {
    throw new ProviderError({
      code: "config",
      detail: `${this.variable} is read-only; set it in the environment`,
    });
  }

  async clear(): Promise<never> {
    throw new ProviderError({
      code: "config",
      detail: `${this.variable} is read-only; unset it in the environment`,
    });
  }

  async has(): Promise<boolean> {
    return (await this.get()) !== null;
  }

  async fingerprint(): Promise<string | null> {
    const value = await this.get();
    return value === null ? null : fingerprint(value);
  }
}
