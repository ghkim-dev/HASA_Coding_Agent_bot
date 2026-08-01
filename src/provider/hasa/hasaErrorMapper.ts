import { HasaError, type ErrorKind } from "../../hasa-client/errors.ts";
import { redactString } from "../../hasa-client/redact.ts";
import { ProviderError, type ProviderErrorCode, isAbortLike, toProviderError } from "../errors.ts";

/**
 * HASA error interpretation.
 *
 * The transport already decided whether a request may be retried. This decides
 * what it means, and the two disagree in the place that matters most:
 *
 *   403 — the transport calls it terminal, because retrying the same request
 *         with the same key will never work. But it is *not* a credential
 *         failure. HASA returns it when a valid key lacks access to one model,
 *         and its body lists the models the key may use. Telling the user to
 *         re-enter a working key is the wrong instruction.
 *
 *   503 — HASA sends no `Retry-After` with it (measured, not documented:
 *         docs/compatibility-matrix.md §2.3), so backoff is the only option.
 *
 * See docs/hasa-coding-agent-architecture.md §3.2.
 */

const BY_KIND: Record<ErrorKind, ProviderErrorCode> = {
  auth: "unauthorized",
  forbidden: "forbidden",
  not_found: "model_not_found",
  rate_limit: "rate_limited",
  unavailable: "unavailable",
  server: "server_error",
  client: "bad_request",
  network: "network",
  timeout: "timeout",
  protocol: "protocol",
};

/**
 * Pulls the model names out of a 403 body.
 *
 * HASA answers a forbidden model with the list this key *can* use, which turns
 * a dead end into an actionable message. The body reaching us is redacted and
 * truncated to 200 characters, so a long list arrives clipped — a partial list
 * is still better than none, and a clipped final entry is dropped rather than
 * shown mangled.
 */
export function parseAllowedModels(bodySnippet: string | null): string[] | null {
  if (!bodySnippet) return null;
  const marker = /allowed[_-]?models["'\s:]*\[?/i.exec(bodySnippet);
  if (!marker) return null;
  const rest = bodySnippet.slice(marker.index + marker[0].length);
  const end = rest.search(/[\]}]/);
  const body = end === -1 ? rest : rest.slice(0, end);
  // A quoted name is self-delimiting: a truncated one has no closing quote and
  // simply does not match, so nothing further is needed.
  const quoted = [...body.matchAll(/["']([^"']+)["']/g)].map((m) => m[1] ?? "");
  if (quoted.length > 0) return dedupe(quoted);

  // JSON literals are what a body says when it has *no* list to give —
  // `"allowed_models": null`. Reading `null` as a model name would put it in
  // front of the user as something they could switch to.
  const LITERALS = new Set(["null", "true", "false", "undefined", "none"]);
  const bare = body
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[\w.\-/]+$/.test(s) && !LITERALS.has(s.toLowerCase()) && !/^\d+$/.test(s));
  // Without quotes there is no such signal. `end === -1` means the closing
  // bracket was cut off, so the final entry may be half a model name — and a
  // half name shown as fact sends the user looking for something that does not
  // exist.
  return dedupe(end === -1 && bare.length > 1 ? bare.slice(0, -1) : bare);
}

function dedupe(names: string[]): string[] | null {
  const unique = [...new Set(names.filter((n) => n.length > 0))];
  return unique.length > 0 ? unique : null;
}

/**
 * HASA answers an invalid key with 403, not 401.
 *
 * Measured against the live gateway on 2026-08-01:
 *
 *   403 {"error":"security_policy_blocked",
 *        "message":"[경고 1/10] 유효하지 않거나 만료된 API Key를 사용했습니다…",
 *        "violation_code":"invalid_api_key","strike_count":1,…}
 *
 * Every mock in this repository, and the documented error table, said 401. The
 * consequence of believing them is the exact failure the provider was built to
 * prevent: 403 means "the key works, this model does not", so a dead key was
 * about to be reported as connected.
 *
 * The gateway also counts strikes — ten of these escalate to timed blocks of
 * 1, 2, 4, 16 and 32 minutes. Classifying this correctly is what stops
 * validation from spending three of them per attempt.
 */
function isInvalidKey(bodySnippet: string | null): boolean {
  if (!bodySnippet) return false;
  return /["']?violation_code["']?\s*:\s*["']invalid_api_key["']/i.test(bodySnippet);
}

/** A policy block that is not about the key: rate abuse, banned content, … */
function isPolicyBlock(bodySnippet: string | null): boolean {
  return bodySnippet !== null && /security_policy_blocked/i.test(bodySnippet);
}

function forbiddenMessage(allowed: string[] | null): string {
  if (allowed === null || allowed.length === 0) {
    return "이 API Key로는 해당 모델을 사용할 수 없습니다. 다른 모델을 선택해 주세요.";
  }
  return `이 API Key로는 해당 모델을 사용할 수 없습니다. 사용 가능한 모델: ${allowed.join(", ")}`;
}

export interface MappedHasaError {
  error: ProviderError;
  /** Only ever present for 403. */
  allowedModels: string[] | null;
}

export function mapHasaErrorDetailed(err: unknown): MappedHasaError {
  // Reading the list back off the error rather than returning null: a 403 is
  // mapped where it is raised and inspected several layers up, and treating an
  // already-mapped error as having no allow-list silently disabled the only
  // actionable thing a 403 tells us.
  if (err instanceof ProviderError) return { error: err, allowedModels: err.allowedModels };

  if (err instanceof HasaError) {
    // The transport reports a caller-initiated abort as a terminal network or
    // timeout fault, because from its side that is what it looks like. Here it
    // is a decision the user made, and must not be worded as a failure.
    if ((err.kind === "network" || err.kind === "timeout") && err.terminal) {
      return {
        error: new ProviderError({ code: "aborted", detail: err.message, cause: err }),
        allowedModels: null,
      };
    }

    // A 403 that names the key rather than the model is an auth failure
    // wearing a permission failure's status code.
    const keyRejected = err.kind === "forbidden" && isInvalidKey(err.bodySnippet);
    const code = keyRejected ? "unauthorized" : BY_KIND[err.kind];
    const allowedModels =
      err.kind === "forbidden" && !keyRejected ? parseAllowedModels(err.bodySnippet) : null;
    const init = {
      code,
      // Redacted again on the way through. The transport already masks body
      // snippets, but this is the boundary the detail crosses on its way to a
      // log or a webview, and a second pass over 200 characters is cheaper than
      // trusting every present and future transport to have done it.
      detail: redactString(err.bodySnippet ? `${err.message} — ${err.bodySnippet}` : err.message),
      httpStatus: err.status,
      retryable: err.retryable,
      terminal: err.terminal,
      retryAfterMs: err.retryAfterMs,
      allowedModels,
      cause: err,
    };
    let error: ProviderError;
    if (keyRejected) {
      error = new ProviderError({
        ...init,
        // The gateway escalates: ten rejected keys buy a timed block. Saying so
        // is the difference between the user fixing the key and the user
        // retrying until they are locked out.
        userMessage:
          "API Key가 유효하지 않거나 만료되었습니다. 키를 다시 확인해 주세요. " +
          "잘못된 키로 반복 요청하면 일정 시간 차단됩니다.",
      });
    } else if (code === "forbidden") {
      error = new ProviderError({
        ...init,
        userMessage: isPolicyBlock(err.bodySnippet)
          ? "요청이 정책에 의해 차단되었습니다. 잠시 후 다시 시도해 주세요."
          : forbiddenMessage(allowedModels),
      });
    } else {
      error = new ProviderError(init);
    }
    return { error, allowedModels };
  }

  if (isAbortLike(err)) {
    return {
      error: new ProviderError({ code: "aborted", detail: "request aborted", cause: err }),
      allowedModels: null,
    };
  }

  return { error: toProviderError(err), allowedModels: null };
}

export function mapHasaError(err: unknown): ProviderError {
  return mapHasaErrorDetailed(err).error;
}
