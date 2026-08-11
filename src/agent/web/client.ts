import { assertFetchableUrl, AddressRefused, type AddressCheckOptions } from "./address.ts";
import { htmlToText, tidy, type PageText } from "./html.ts";

/**
 * Fetching, with every hop checked.
 *
 * Redirects are followed by hand — `redirect: "manual"` — because the point of
 * `address.ts` is lost if the runtime follows a 302 for us. A public URL that
 * redirects to `http://127.0.0.1:7801` is the whole attack, and it is the
 * default behaviour of every HTTP client unless you turn it off.
 *
 * Nothing here sends the HASA key. These requests go to third parties, and the
 * credential belongs to one gateway.
 */

export class FetchFailed extends Error {
  readonly guidance: string;
  /**
   * The status the server answered with, when there was one.
   *
   * Kept because 404 and a timeout are different facts and the prose was the
   * only place they differed. `classifyWebFailure` reads this distinction, and a
   * blocked report is allowed to rest on one of them and not the other.
   */
  readonly status?: number;
  constructor(guidance: string, status?: number) {
    super(guidance);
    this.name = "FetchFailed";
    this.guidance = guidance;
    if (status !== undefined) this.status = status;
  }
}

/** Long enough for a slow docs site, short enough not to hang a turn. */
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
/** Read cap, before text extraction. A 60 MB PDF is not worth a context window. */
const MAX_BYTES = 5 * 1024 * 1024;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36";

export interface WebClientOptions extends AddressCheckOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface FetchedPage {
  /**
   * The URL that was asked for, before any redirect.
   *
   * Kept separately from `url` because a cross-domain redirect changes who
   * answered. Asking `open.hasa.re.kr` and being sent to somewhere else means
   * the content is that somewhere else's, and only these two fields together
   * say so.
   */
  requestedUrl: string;
  /** Where the content actually came from, after redirects. */
  url: string;
  status: number;
  contentType: string;
  page: PageText;
  /** True when the body was cut at the byte cap. */
  truncated: boolean;
}

/**
 * Types worth reading. Anything else is refused by name rather than decoded as
 * text, because a model handed 5 MB of latin1-decoded PNG will describe it.
 */
function readable(contentType: string): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type.startsWith("text/")) return true;
  return [
    "application/json",
    "application/xml",
    "application/xhtml+xml",
    "application/javascript",
    "application/x-yaml",
    "application/yaml",
  ].includes(type);
}

export async function fetchPage(rawUrl: string, opts: WebClientOptions = {}): Promise<FetchedPage> {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    let current = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      // Re-checked every hop. This is the line that makes manual redirects worth
      // the trouble.
      const url = await assertFetchableUrl(current, opts);

      const res = await doFetch(url.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
          "accept-language": "ko,en;q=0.9",
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (location === null) throw new FetchFailed(`${url.host} redirected without saying where.`);
        current = new URL(location, url).toString();
        continue;
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!res.ok) {
        throw new FetchFailed(
          `${url.host} answered ${res.status}. The page may be gone, or may not allow automated reading.`,
          res.status,
        );
      }
      if (!readable(contentType)) {
        throw new FetchFailed(
          `${url.toString()} is ${contentType.split(";")[0] || "an unknown type"}, which is not text. ` +
            "Fetch a page, not a binary.",
        );
      }

      const buffer = await res.arrayBuffer();
      const truncated = buffer.byteLength > maxBytes;
      const body = new TextDecoder("utf-8").decode(
        truncated ? buffer.slice(0, maxBytes) : buffer,
      );
      const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
      const page =
        type === "text/html" || type === "application/xhtml+xml"
          ? htmlToText(body)
          : { title: null, text: tidy(body) };

      return { requestedUrl: rawUrl, url: url.toString(), status: res.status, contentType, page, truncated };
    }
    throw new FetchFailed(`${rawUrl} redirected more than ${MAX_REDIRECTS} times.`);
  } catch (err) {
    if (err instanceof AddressRefused || err instanceof FetchFailed) throw err;
    if ((err as { name?: string }).name === "AbortError") {
      throw new FetchFailed(`${rawUrl} did not answer in time.`);
    }
    throw new FetchFailed(`${rawUrl} could not be fetched: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Where results come from.
 *
 * DuckDuckGo's HTML endpoint, because it needs no API key and the product's
 * promise is that a user enters one HASA key and starts working — a second
 * credential, for a second vendor, to look something up would break that.
 *
 * The gateway has its own `web_search` behind `POST /v1/agent/chat`, and if it
 * is ever configured that is the better source. It is not: as of 2026-08-04 it
 * answers with results marked `(MOCK)` and the note `실검색은 GW_SEARCH_API_URL/KEY
 * 설정 시`. Building on it today would ship an agent that researches example.com.
 */
const SEARCH_URL = "https://html.duckduckgo.com/html/?q=";

/** Undoes the redirector results are wrapped in, so the model gets the real URL. */
export function unwrapResultUrl(href: string): string | null {
  const decoded = href.replace(/&amp;/g, "&");
  const target = /[?&]uddg=([^&]+)/.exec(decoded)?.[1];
  if (target !== undefined) {
    try {
      return decodeURIComponent(target);
    } catch {
      return null;
    }
  }
  if (decoded.startsWith("http://") || decoded.startsWith("https://")) return decoded;
  return null;
}

/** Reads results out of the HTML. Returns an empty list rather than guessing. */
export function parseSearchResults(html: string, limit: number): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  const blocks = html.split(/<div[^>]*class="[^"]*\bresult\b[^"]*"/i).slice(1);

  for (const block of blocks) {
    if (out.length >= limit) break;
    const href = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"/i.exec(block)?.[1];
    if (href === undefined) continue;
    const url = unwrapResultUrl(href);
    if (url === null || seen.has(url)) continue;

    const titleHtml = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block)?.[1] ?? "";
    const snippetHtml = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block)?.[1] ?? "";
    const strip = (text: string): string => htmlToText(text).text.replace(/\n+/g, " ").trim();

    const title = strip(titleHtml);
    if (title.length === 0) continue;
    seen.add(url);
    out.push({ title, url, snippet: strip(snippetHtml) });
  }
  return out;
}

export async function searchWeb(
  query: string,
  limit: number,
  opts: WebClientOptions = {},
): Promise<SearchResult[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await doFetch(`${SEARCH_URL}${encodeURIComponent(query)}`, {
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, "accept-language": "ko,en;q=0.9" },
    });
    if (!res.ok) {
      throw new FetchFailed(
        `The search service answered ${res.status}. It may be rate-limiting; try again, or fetch a URL directly.`,
        res.status,
      );
    }
    return parseSearchResults(await res.text(), limit);
  } catch (err) {
    if (err instanceof FetchFailed) throw err;
    if ((err as { name?: string }).name === "AbortError") throw new FetchFailed("The search timed out.");
    throw new FetchFailed(`The search failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}
