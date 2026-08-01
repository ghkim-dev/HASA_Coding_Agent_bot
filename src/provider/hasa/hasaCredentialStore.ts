import {
  EnvCredentialStore,
  SecretStorageCredentialStore,
  type CredentialStore,
  type SecretStorageLike,
} from "../credentials.ts";
import { HASA_SECRET_KEY } from "./defaults.ts";

/**
 * Where the HASA key lives.
 *
 * One function per storage backend, and no third option. In particular there is
 * no settings-file or workspace-state variant, because the moment one exists
 * something will start writing to it — `settings.json` is synced, searchable,
 * and frequently pasted into issue reports. See docs/security-policy.md §1.1.
 *
 * The secret key name matches what the Arena extension already stores, so a
 * user who has connected once does not have to enter the key again when the
 * Coding Agent ships.
 */

export function createHasaCredentialStore(
  secrets: SecretStorageLike,
  key: string = HASA_SECRET_KEY,
): CredentialStore {
  return new SecretStorageCredentialStore(secrets, key);
}

/** For the orchestrator process and the CLI, which receive the key as env. */
export function createHasaEnvCredentialStore(variable = "HASA_API_KEY"): CredentialStore {
  return new EnvCredentialStore(variable);
}

export { HASA_SECRET_KEY };
