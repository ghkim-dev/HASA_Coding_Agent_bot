import { DEFAULT_BASE_URL } from "../../hasa-client/client.ts";

/**
 * HASA connection defaults.
 *
 * These live in the provider, not in the UI. A user connects by pasting one API
 * key; base URL, endpoint paths and auth scheme are ours to know (§8 of the
 * product brief). Advanced settings may override the base URL, and nothing else.
 *
 * There are no model ids in this file, and there must never be. The catalogue
 * comes from `GET /v1/models` at runtime so that a model added or withdrawn on
 * the gateway needs no extension release.
 */

export const HASA_PROVIDER_ID = "hasa" as const;
export const HASA_DISPLAY_NAME = "HASA Open API";

/** `https://open.hasa.re.kr/v1` — re-exported so callers need one import. */
export const HASA_DEFAULT_BASE_URL = DEFAULT_BASE_URL;

/** Secret-storage key. Matches what the Arena extension already writes. */
export const HASA_SECRET_KEY = "hasaArena.apiKey";

export const HASA_DEFAULT_TIMEOUT_MS = 120_000;

/** How long a fetched model list stays fresh before a refresh is attempted. */
export const HASA_MODEL_CACHE_TTL_MS = 5 * 60_000;

/**
 * Validation is interactive — the user is watching a spinner in a settings
 * panel — so it gets a short budget and no retries.
 */
export const HASA_VALIDATION_TIMEOUT_MS = 15_000;

/**
 * How many models the credential probe will try before giving up.
 *
 * More than one because a key that lacks access to the first-listed model gets
 * a 403, and a model that is listed but unrouted gets a 404; neither says
 * anything about the key. Bounded because each attempt is a real request.
 *
 * Six rather than three, measured against the live gateway: a real key's
 * allow-list was `bge-m3, bge-reranker-v2-m3, exaone-4.0-32b, gpt-oss-20b,
 * granite-guardian-3.1-8b, qwen2.5-coder-32b` — and the two that come first are
 * an embedding and a reranker, which answer `/chat/completions` with 404. A
 * budget of three was spent before reaching the first model that can hold a
 * conversation. The allow-list is the right length for the budget because it is
 * what the gateway itself considers this key's world.
 */
export const HASA_VALIDATION_MODEL_ATTEMPTS = 6;
