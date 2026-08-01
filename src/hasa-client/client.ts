import {
  ModelsResponseSchema,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type AssembledStream,
  type ModelsResponse,
} from "../protocol/index.ts";
import {
  HasaError,
  backoffMs,
  classifyStatus,
  parseRetryAfter,
} from "./errors.ts";
import { createLogger, nullLogger, type Logger } from "./logger.ts";
import { evidence, registerSecret, summarizeMessages } from "./redact.ts";
import { assembleStream, iterateSse, parseChunk } from "./sse.ts";

export const DEFAULT_BASE_URL = "https://open.hasa.re.kr/v1";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HasaClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Per-attempt timeout. Total wall time can exceed this across retries. */
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: FetchLike;
  logger?: Logger;
  /** Injected for deterministic retry tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Lets the scheduler pause a model's queue for the advertised cooldown. */
  onRateLimit?: (info: { model: string | null; retryAfterMs: number | null }) => void;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Overrides the client default for one call (probes tune this). */
  maxRetries?: number;
  timeoutMs?: number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Thin HASA HTTP client.
 *
 * Responsibilities kept deliberately narrow: auth, timeouts, error taxonomy,
 * Retry-After-aware retries, and SSE decoding. It has no opinion about models
 * or capabilities — those belong to the probe, which must be free to send
 * requests it expects to fail.
 */
export class HasaClient {
  private readonly apiKey: string;
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: FetchLike;
  private readonly log: Logger;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly onRateLimit: HasaClientOptions["onRateLimit"];

  constructor(opts: HasaClientOptions) {
    if (!opts.apiKey) {
      throw new Error("HASA_API_KEY is required (pass apiKey; never hardcode it)");
    }
    this.apiKey = opts.apiKey;
    // Registering the key means it is stripped from every log line and every
    // serialised error from this point on, whoever writes them.
    registerSecret(this.apiKey);
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.log = opts.logger ?? createLogger("hasa-client");
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.onRateLimit = opts.onRateLimit;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
      ...extra,
    };
  }

  private async send(
    path: string,
    init: { method: string; body?: unknown; accept?: string; modelHint?: string },
    opts: RequestOptions,
  ): Promise<Response> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: this.headers(init.accept ? { accept: init.accept } : undefined),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal,
      });
    } catch (cause) {
      const aborted = opts.signal?.aborted === true;
      const timedOut = timeout.aborted;
      throw new HasaError({
        message: timedOut ? `request timed out after ${timeoutMs}ms` : "network error",
        kind: timedOut ? "timeout" : "network",
        // A caller-initiated abort is a decision, not a transient fault.
        retryable: !aborted,
        terminal: aborted,
        cause,
      });
    }

    if (res.ok) return res;

    const cls = classifyStatus(res.status);
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), Date.now());
    let snippet: string | null = null;
    try {
      snippet = evidence(await res.text(), 200);
    } catch {
      snippet = null;
    }
    if (cls.kind === "rate_limit") {
      this.onRateLimit?.({ model: init.modelHint ?? null, retryAfterMs });
    }
    throw new HasaError({
      message: `HASA ${res.status} ${cls.kind}`,
      kind: cls.kind,
      status: res.status,
      retryable: cls.retryable,
      terminal: cls.terminal,
      retryAfterMs,
      bodySnippet: snippet,
    });
  }

  /**
   * Retries only what is safe to retry, and prefers the server's own advice:
   * a 429 with `Retry-After: 30` waits 30s rather than guessing.
   */
  private async withRetry<T>(
    label: string,
    fn: () => Promise<T>,
    opts: RequestOptions,
  ): Promise<T> {
    const limit = opts.maxRetries ?? this.maxRetries;
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        const hasa = err instanceof HasaError ? err : null;
        if (!hasa || !hasa.retryable || attempt >= limit) throw err;
        const wait = hasa.retryAfterMs ?? backoffMs(attempt, 500, 30_000, this.random);
        this.log.warn("retrying request", {
          label,
          attempt: attempt + 1,
          limit,
          code: hasa.code,
          waitMs: wait,
          honouredRetryAfter: hasa.retryAfterMs !== null,
        });
        await this.sleep(wait, opts.signal);
        attempt += 1;
      }
    }
  }

  /**
   * Full catalogue entries, as the gateway reports them.
   *
   * `owned_by` is kept here rather than discarded in `listModels` because a
   * model picker wants it; nothing in the probe does, which is why the id-only
   * view stayed the default.
   */
  async listModelRecords(opts: RequestOptions = {}): Promise<ModelsResponse["data"]> {
    const res = await this.withRetry(
      "GET /models",
      () => this.send("/models", { method: "GET" }, opts),
      opts,
    );
    const json: unknown = await res.json();
    const parsed = ModelsResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new HasaError({
        message: "GET /models returned an unexpected shape",
        kind: "protocol",
        status: 200,
        retryable: false,
        terminal: true,
        bodySnippet: evidence(parsed.error.message, 200),
      });
    }
    const records = parsed.data.data.filter((m) => m.id.length > 0);
    this.log.info("listed models", { count: records.length });
    return records;
  }

  /**
   * Model ids come from here or from the environment — never from source.
   * See docs/compatibility-matrix.md §1.
   */
  async listModels(opts: RequestOptions = {}): Promise<string[]> {
    return (await this.listModelRecords(opts)).map((m) => m.id);
  }

  async chat(
    req: ChatCompletionRequest,
    opts: RequestOptions = {},
  ): Promise<ChatCompletionResponse> {
    this.log.debug("chat request", {
      model: req.model,
      prompt: summarizeMessages(req.messages),
      hasTools: Boolean(req.tools?.length),
      stream: false,
    });
    const res = await this.withRetry(
      `POST /chat/completions (${req.model})`,
      () =>
        this.send(
          "/chat/completions",
          { method: "POST", body: { ...req, stream: false }, modelHint: req.model },
          opts,
        ),
      opts,
    );
    const json: unknown = await res.json();
    const body = json as ChatCompletionResponse;
    if (!body || !Array.isArray(body.choices)) {
      throw new HasaError({
        message: "chat completion response has no choices[]",
        kind: "protocol",
        status: 200,
        retryable: false,
        terminal: false,
        bodySnippet: evidence(JSON.stringify(json ?? null), 200),
      });
    }
    return body;
  }

  /**
   * Yields decoded chunks. Retries cover connection establishment only — once
   * the first byte of a stream has been consumed, replaying the request would
   * duplicate output rather than recover it.
   */
  async *streamChunks(
    req: ChatCompletionRequest,
    opts: RequestOptions = {},
  ): AsyncGenerator<ChatCompletionChunk> {
    this.log.debug("chat request", {
      model: req.model,
      prompt: summarizeMessages(req.messages),
      hasTools: Boolean(req.tools?.length),
      stream: true,
    });
    const res = await this.withRetry(
      `POST /chat/completions stream (${req.model})`,
      () =>
        this.send(
          "/chat/completions",
          {
            method: "POST",
            body: { ...req, stream: true },
            accept: "text/event-stream",
            modelHint: req.model,
          },
          opts,
        ),
      opts,
    );
    if (!res.body) {
      throw new HasaError({
        message: "streaming response had no body",
        kind: "protocol",
        status: res.status,
        retryable: false,
        terminal: false,
      });
    }
    for await (const frame of iterateSse(res.body, opts.signal)) {
      const chunk = parseChunk(frame.data);
      if (chunk === null) return; // [DONE]
      yield chunk;
    }
  }

  async chatStream(
    req: ChatCompletionRequest,
    opts: RequestOptions = {},
  ): Promise<AssembledStream> {
    return assembleStream(this.streamChunks(req, opts));
  }
}

export function clientFromEnv(overrides: Partial<HasaClientOptions> = {}): HasaClient {
  const apiKey = overrides.apiKey ?? process.env["HASA_API_KEY"] ?? "";
  if (!apiKey) {
    throw new Error(
      "HASA_API_KEY is not set. Export it in your shell; do not put it in source or .env committed to git.",
    );
  }
  return new HasaClient({
    apiKey,
    baseUrl: overrides.baseUrl ?? process.env["HASA_BASE_URL"] ?? DEFAULT_BASE_URL,
    logger: overrides.logger ?? createLogger("hasa-client"),
    ...overrides,
  });
}

export { nullLogger };
