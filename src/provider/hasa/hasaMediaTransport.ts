import type { MediaTransport } from "./hasaMedia.ts";
import type { CatalogPort } from "./hasaCatalog.ts";

/**
 * The media endpoints over plain `fetch`.
 *
 * Separate from `hasaTransport.ts` because the shapes are not OpenAI's: images
 * return base64 in one response, video returns a job to poll, and the artifact
 * is a binary GET against a path the job hands back. Folding that into the chat
 * transport would put three non-standard behaviours behind an interface whose
 * whole promise is that any OpenAI-compatible gateway satisfies it.
 *
 * The catalogue is reachable through the same object but deliberately without
 * the key: `GET /api/catalog` is public, and sending a credential to an
 * endpoint that does not need one is how credentials end up in logs that were
 * never meant to hold them.
 */

export interface HasaMediaTransportOptions {
  /** Gateway origin, without `/v1`. */
  origin: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Applies to a single request, not to a video job as a whole. */
  requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;

export class HasaHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HasaHttpError";
    this.status = status;
  }
}

/** Trims a body to something loggable without pasting a base64 image into a log. */
function briefly(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed;
}

export function createMediaTransport(
  opts: HasaMediaTransportOptions,
): MediaTransport & CatalogPort {
  const doFetch = opts.fetchImpl ?? fetch;
  const origin = opts.origin.replace(/\/+$/, "");
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const url = (path: string): string => `${origin}${path.startsWith("/") ? path : `/${path}`}`;

  /** Joins the caller's signal to a per-request timeout without losing either. */
  const withTimeout = (signal?: AbortSignal): { signal: AbortSignal; done: () => void } => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort);
    return {
      signal: controller.signal,
      done: () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      },
    };
  };

  const request = async (
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> => {
    const scope = withTimeout(signal);
    try {
      return await doFetch(url(path), { ...init, signal: scope.signal });
    } finally {
      scope.done();
    }
  };

  const authed = (extra: Record<string, string> = {}): Record<string, string> => ({
    Authorization: `Bearer ${opts.apiKey}`,
    ...extra,
  });

  return {
    async postJson(path, body, signal) {
      const res = await request(
        path,
        {
          method: "POST",
          headers: authed({ "Content-Type": "application/json" }),
          body: JSON.stringify(body),
        },
        signal,
      );
      const text = await res.text();
      if (!res.ok) throw new HasaHttpError(res.status, `${res.status}: ${briefly(text)}`);
      return text.length === 0 ? {} : JSON.parse(text);
    },

    async getJson(path, signal) {
      const res = await request(path, { headers: authed() }, signal);
      const text = await res.text();
      if (!res.ok) throw new HasaHttpError(res.status, `${res.status}: ${briefly(text)}`);
      return text.length === 0 ? {} : JSON.parse(text);
    },

    /**
     * Fetches an artifact, or returns null when the gateway will not serve it.
     *
     * The null case is not hypothetical. `/files/{name}` answers **200** with a
     * JSON body of `{"detail":"not found"}` and a `video/webm` content type for
     * an API key, whether or not the file exists — so the status line cannot be
     * trusted and the body has to be inspected. A caller that wrote this
     * straight to disk would produce a 22-byte `.webm` that plays nowhere.
     */
    async getBinary(path, signal) {
      const res = await request(path, { headers: authed() }, signal);
      if (!res.ok) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length === 0) return null;

      // A JSON object where a media container should start. Every real
      // container this gateway returns begins with a binary magic number, and
      // none of them begin with `{`.
      if (bytes[0] === 0x7b) return null;
      return bytes;
    },

    /**
     * The public catalogue. No credential is sent: it does not need one, and
     * attaching it anyway would widen where the key can leak for no gain.
     */
    async fetchJson(path) {
      const scope = withTimeout();
      try {
        const res = await doFetch(url(path), { signal: scope.signal });
        if (!res.ok) throw new HasaHttpError(res.status, `catalogue: ${res.status}`);
        return await res.json();
      } finally {
        scope.done();
      }
    },
  };
}
