import type { ProviderErrorLike } from "./types.ts";

/**
 * Provider error taxonomy.
 *
 * Deliberately a superset of `hasa-client/errors.ts` rather than a rename of
 * it: the transport classifies "may I retry this HTTP request", while this
 * layer answers "what does the user do now". Those are different questions and
 * `403` is where they diverge — the transport must not retry it, and the user
 * must be told to pick a different model rather than to re-enter their key.
 *
 * Every code carries a Korean `userMessage` because the product is aimed at
 * working developers at small companies, not at people debugging an LLM
 * gateway. See docs/hasa-coding-agent-architecture.md §12.
 */
export type ProviderErrorCode =
  | "unauthorized" // 401 — key missing or wrong
  | "forbidden" // 403 — key is fine, this model is not permitted
  | "model_not_found" // 404 — model not registered on the gateway
  | "rate_limited" // 429 — honour Retry-After
  | "unavailable" // 503 — backend down
  | "server_error" // other 5xx
  | "bad_request" // other 4xx
  | "timeout"
  | "network"
  | "protocol" // reachable, but the response was not what the API promises
  | "aborted" // the caller cancelled
  | "config"; // our own misconfiguration, before any request went out

const MESSAGES: Record<ProviderErrorCode, string> = {
  unauthorized: "API Key가 유효하지 않습니다. 키를 다시 입력해 주세요.",
  forbidden: "이 API Key로는 해당 모델을 사용할 수 없습니다. 다른 모델을 선택해 주세요.",
  model_not_found: "요청한 모델을 찾을 수 없습니다. 모델 목록을 새로고침해 주세요.",
  rate_limited: "요청이 잠시 제한되었습니다. 잠시 후 자동으로 다시 시도합니다.",
  unavailable: "모델 서버가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해 주세요.",
  server_error: "HASA 서버에서 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
  bad_request: "요청이 거부되었습니다. 설정을 확인해 주세요.",
  timeout: "응답 시간이 초과되었습니다. 다시 시도해 주세요.",
  network: "HASA에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.",
  protocol: "HASA 응답 형식을 해석하지 못했습니다.",
  aborted: "요청이 취소되었습니다.",
  config: "HASA 연결 설정이 올바르지 않습니다.",
};

export function messageFor(code: ProviderErrorCode): string {
  return MESSAGES[code];
}

export interface ProviderErrorInit {
  code: ProviderErrorCode;
  /** Technical detail for logs. Already redacted by the caller. */
  detail?: string;
  httpStatus?: number | null;
  retryable?: boolean;
  terminal?: boolean;
  retryAfterMs?: number | null;
  /** Overrides the default Korean message for this code. */
  userMessage?: string;
  /**
   * Models the gateway says this key may call. Only ever set on a 403.
   *
   * It lives on the error rather than beside it because the error is what
   * travels: a 403 raised in the transport is mapped once, then caught,
   * inspected and re-raised several layers up. Anything carried alongside is
   * lost at the first hop.
   */
  allowedModels?: string[] | null;
  cause?: unknown;
}

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  "rate_limited",
  "unavailable",
  "server_error",
  "timeout",
  "network",
]);

/** Retrying will never help; stop using this model for this request. */
const TERMINAL: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  "unauthorized",
  "forbidden",
  "model_not_found",
  "bad_request",
  "aborted",
  "config",
]);

export class ProviderError extends Error implements ProviderErrorLike {
  readonly code: ProviderErrorCode;
  readonly httpStatus: number | null;
  readonly retryable: boolean;
  readonly terminal: boolean;
  readonly retryAfterMs: number | null;
  readonly detail: string;
  readonly userMessage: string;
  readonly allowedModels: string[] | null;

  constructor(init: ProviderErrorInit) {
    const detail = init.detail ?? "";
    super(detail.length > 0 ? `${init.code}: ${detail}` : init.code,
      init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ProviderError";
    this.code = init.code;
    this.httpStatus = init.httpStatus ?? null;
    this.terminal = init.terminal ?? TERMINAL.has(init.code);
    // "Retrying will never help" and "it is safe to retry" cannot both hold.
    // An upstream that claims both — a transport with a bug, or one we did not
    // write — would otherwise hand an agent loop permission to retry something
    // it has been told is hopeless, which is how a loop burns its whole budget
    // on a 403. Terminal wins: failing fast is the recoverable mistake.
    this.retryable = (init.retryable ?? RETRYABLE.has(init.code)) && !this.terminal;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.detail = detail;
    this.userMessage = init.userMessage ?? MESSAGES[init.code];
    this.allowedModels = init.allowedModels ?? null;
  }

  /** The shape safe to send to a webview: no cause, no stack, no key material. */
  toJSON(): ProviderErrorLike & {
    detail: string;
    retryAfterMs: number | null;
    allowedModels: string[] | null;
  } {
    return {
      code: this.code,
      httpStatus: this.httpStatus,
      retryable: this.retryable,
      terminal: this.terminal,
      userMessage: this.userMessage,
      detail: this.detail,
      retryAfterMs: this.retryAfterMs,
      allowedModels: this.allowedModels,
    };
  }
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError;
}

/** True for the abort shapes `fetch` and `AbortSignal` actually throw. */
export function isAbortLike(err: unknown): boolean {
  if (err instanceof ProviderError) return err.code === "aborted";
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * Describes an unknown throwable without trusting it to describe itself.
 *
 * `String(value)` throws on a null-prototype object and on anything with a
 * hostile `toString` — and this runs on the path that exists to stop unexpected
 * values from escaping, so a crash here replaces one confusing failure with a
 * worse one.
 */
function describeThrowable(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * Last-resort mapping for anything that reaches the provider layer unclassified.
 *
 * Kept separate from `mapHasaError` so that a non-HASA transport (a future
 * provider, or a bug in our own code) still produces a `ProviderError` rather
 * than leaking a raw `Error` into the agent loop.
 */
export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (isAbortLike(err)) {
    return new ProviderError({ code: "aborted", detail: "request aborted", cause: err });
  }
  return new ProviderError({ code: "network", detail: describeThrowable(err), cause: err });
}
