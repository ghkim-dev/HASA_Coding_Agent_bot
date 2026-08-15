import type { EmbeddingProvider } from "./embedding.ts";
import type { TaskProfile } from "./taskProfile.ts";

/**
 * The gateway's embeddings endpoint, as an `EmbeddingProvider`.
 *
 * Written after calling it rather than from the shape of the OpenAI API, and
 * the difference showed up immediately: the configured base URL for this
 * gateway already ends in `/v1`, so appending another produced
 * `/v1/v1/embeddings` and a 404 whose body said `{"detail":"Not Found"}` —
 * indistinguishable, without looking, from "this model has no embedding
 * endpoint". `endpointFor` handles that once so no caller has to know.
 *
 * What one real call established, on 2026-08-15:
 *
 *     POST /v1/embeddings   200 in 272ms
 *     model bge-m3, 1024 dimensions, a two-item batch honoured in one request
 *     usage reported as prompt_tokens
 *
 * ## It is allowed to fail
 *
 * Everything this feeds is a shadow observation. A timeout, a 500, a vector of
 * the wrong length — none of them may stop a turn, so the failure modes below
 * are reported rather than thrown, and the matcher above turns them into a
 * recorded reason and a neutral score.
 */

/** Joins a base that may or may not already carry the version segment. */
export function endpointFor(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}${path}` : `${base}/v1${path}`;
}

export type EmbeddingFailure =
  | "TIMEOUT"
  | "UNAUTHORIZED"
  | "MODEL_UNAVAILABLE"
  | "HTTP_ERROR"
  | "MALFORMED_RESPONSE"
  | "DIMENSION_MISMATCH"
  | "EMPTY_RESPONSE"
  | "NETWORK_ERROR";

export class EmbeddingError extends Error {
  readonly failure: EmbeddingFailure;
  readonly status: number | null;

  constructor(failure: EmbeddingFailure, message: string, status: number | null = null) {
    super(message);
    this.name = "EmbeddingError";
    this.failure = failure;
    this.status = status;
  }
}

export interface HasaEmbeddingOptions {
  apiKey: string;
  baseUrl: string;
  modelId?: string;
  timeoutMs?: number;
  /** Injected for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_MODEL = "bge-m3";
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Reads the vectors out of a response, or says exactly what was wrong with it.
 *
 * Every branch here is a shape that was worth ruling out rather than a
 * defensive reflex: a 200 with no `data`, a `data` array shorter than the
 * batch, an entry whose `embedding` is missing, and vectors of differing
 * lengths within one response. The last one matters most — a cosine between
 * two different-length vectors is not a small error, it is arithmetic on
 * unrelated numbers, and `cosineSimilarity` returns null for it rather than a
 * plausible float.
 */
export function readVectors(body: unknown, expected: number): number[][] {
  if (body === null || typeof body !== "object") {
    throw new EmbeddingError("MALFORMED_RESPONSE", "응답이 객체가 아닙니다.");
  }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new EmbeddingError("MALFORMED_RESPONSE", "응답에 data 배열이 없습니다.");
  }
  if (data.length === 0) {
    throw new EmbeddingError("EMPTY_RESPONSE", "벡터가 하나도 오지 않았습니다.");
  }
  if (data.length !== expected) {
    throw new EmbeddingError(
      "MALFORMED_RESPONSE",
      `${expected}개를 요청했는데 ${data.length}개가 왔습니다.`,
    );
  }

  const vectors: number[][] = [];
  for (const [i, entry] of data.entries()) {
    const vector = (entry as { embedding?: unknown } | null)?.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new EmbeddingError("MALFORMED_RESPONSE", `${i}번째 항목에 embedding이 없습니다.`);
    }
    if (!vector.every((v) => typeof v === "number" && Number.isFinite(v))) {
      throw new EmbeddingError("MALFORMED_RESPONSE", `${i}번째 벡터에 숫자가 아닌 값이 있습니다.`);
    }
    vectors.push(vector as number[]);
  }

  const width = vectors[0]!.length;
  if (vectors.some((v) => v.length !== width)) {
    throw new EmbeddingError(
      "DIMENSION_MISMATCH",
      "한 응답 안의 벡터 길이가 서로 다릅니다. 비교할 수 없습니다.",
    );
  }
  return vectors;
}

/** The gateway's embeddings endpoint. Reused across turns; never per-request. */
export function createHasaEmbeddingProvider(options: HasaEmbeddingOptions): EmbeddingProvider {
  const modelId = options.modelId ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const call = options.fetchImpl ?? fetch;
  const url = endpointFor(options.baseUrl, "/embeddings");

  return {
    embeddingModelId: modelId,
    providerId: "hasa",
    async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
      if (texts.length === 0) return [];

      // The caller's deadline and ours, whichever comes first. Without the
      // second one a hung gateway would hold a shadow observation open for as
      // long as the turn lasts.
      const deadline = AbortSignal.timeout(timeoutMs);
      const combined =
        signal === undefined ? deadline : AbortSignal.any([signal, deadline]);

      let response: Response;
      try {
        response = await call(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({ model: modelId, input: [...texts] }),
          signal: combined,
        });
      } catch (err) {
        if (combined.aborted) {
          throw new EmbeddingError("TIMEOUT", `임베딩 요청이 ${timeoutMs}ms 안에 끝나지 않았습니다.`);
        }
        throw new EmbeddingError("NETWORK_ERROR", (err as Error).message);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        if (response.status === 401 || response.status === 403) {
          throw new EmbeddingError(
            "UNAUTHORIZED",
            `이 키로 ${modelId} 임베딩을 쓸 수 없습니다.`,
            response.status,
          );
        }
        if (response.status === 404) {
          // The 404 that was actually seen came from a doubled `/v1`, not from
          // a missing model. Named so the next reader checks the URL first.
          throw new EmbeddingError(
            "MODEL_UNAVAILABLE",
            `${url} 이 404입니다. 모델이 없거나 경로가 잘못됐습니다.`,
            404,
          );
        }
        throw new EmbeddingError("HTTP_ERROR", `HTTP ${response.status}: ${body.slice(0, 120)}`, response.status);
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new EmbeddingError("MALFORMED_RESPONSE", "응답을 JSON으로 읽지 못했습니다.");
      }
      return readVectors(parsed, texts.length);
    },
  };
}

// ---------------------------------------------------------------------------
// What may be sent, and when
// ---------------------------------------------------------------------------

export type EmbeddingRefusal = "LOCAL_ONLY" | "NO_EXTERNAL_NETWORK" | "NO_RESEARCH";

/**
 * Whether this task permits calling an external service at all.
 *
 * Checked before the provider, not inside it. A user who said the work must
 * stay local has said something about *their* data, and a shadow measurement is
 * not an exception to it — "we only sent it for observability" is the kind of
 * sentence this codebase exists to make impossible to need.
 *
 * `noResearch` counts. It is the user forbidding the agent from going outside
 * for information, and an embedding request is going outside.
 */
export function embeddingRefusedBy(task: TaskProfile): EmbeddingRefusal | null {
  const constraints = task.constraints as {
    localOnly?: boolean;
    noExternalNetwork?: boolean;
    noResearch?: boolean;
  };
  if (constraints.localOnly === true) return "LOCAL_ONLY";
  if (constraints.noExternalNetwork === true) return "NO_EXTERNAL_NETWORK";
  if (constraints.noResearch === true) return "NO_RESEARCH";
  return null;
}
