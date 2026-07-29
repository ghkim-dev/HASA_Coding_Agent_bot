/**
 * HASA error taxonomy.
 *
 * The distinction that matters is not "did it fail" but "should we ever try
 * again, and does this disqualify the model". 403 and 429 both look like
 * failures and are handled in opposite ways: one permanently excludes a
 * candidate, the other must be waited out.
 *
 * See docs/compatibility-matrix.md §2.2.
 */

export type ErrorKind =
  | "auth" // 401 — configuration fault, abort everything
  | "forbidden" // 403 — key lacks access to this model
  | "not_found" // 404 — model not registered
  | "rate_limit" // 429 — honour Retry-After
  | "unavailable" // 503 — GPU backend down
  | "server" // other 5xx
  | "client" // other 4xx
  | "network"
  | "timeout"
  | "protocol"; // malformed response / stream

export interface Classification {
  kind: ErrorKind;
  /** Safe to retry the identical request. */
  retryable: boolean;
  /** Retrying will never help; stop touching this model for this run. */
  terminal: boolean;
}

export function classifyStatus(status: number): Classification {
  if (status === 401) return { kind: "auth", retryable: false, terminal: true };
  if (status === 403) return { kind: "forbidden", retryable: false, terminal: true };
  if (status === 404) return { kind: "not_found", retryable: false, terminal: true };
  if (status === 408) return { kind: "timeout", retryable: true, terminal: false };
  if (status === 429) return { kind: "rate_limit", retryable: true, terminal: false };
  if (status === 503) return { kind: "unavailable", retryable: true, terminal: false };
  if (status >= 500) return { kind: "server", retryable: true, terminal: false };
  return { kind: "client", retryable: false, terminal: true };
}

export class HasaError extends Error {
  readonly kind: ErrorKind;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly terminal: boolean;
  readonly retryAfterMs: number | null;
  /** Redacted, truncated body — enough to diagnose, never enough to leak. */
  readonly bodySnippet: string | null;

  constructor(init: {
    message: string;
    kind: ErrorKind;
    status?: number | null;
    retryable: boolean;
    terminal: boolean;
    retryAfterMs?: number | null;
    bodySnippet?: string | null;
    cause?: unknown;
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "HasaError";
    this.kind = init.kind;
    this.status = init.status ?? null;
    this.retryable = init.retryable;
    this.terminal = init.terminal;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.bodySnippet = init.bodySnippet ?? null;
  }

  /** Short stable code used in matrices, events and DB rows. */
  get code(): string {
    return this.status === null ? this.kind : String(this.status);
  }
}

export function isHasaError(e: unknown): e is HasaError {
  return e instanceof HasaError;
}

/**
 * `Retry-After` is either delta-seconds or an HTTP-date. Both are accepted;
 * anything else yields null so the caller falls back to backoff.
 */
export function parseRetryAfter(header: string | null | undefined, nowMs: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.max(0, Number(trimmed) * 1000);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - nowMs);
}

/** Exponential backoff with full jitter, capped. */
export function backoffMs(attempt: number, baseMs = 500, capMs = 30_000, rnd = Math.random): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(rnd() * exp);
}
