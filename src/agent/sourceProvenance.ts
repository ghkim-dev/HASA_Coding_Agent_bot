/**
 * Where a fact came from, kept apart from what it is a fact about.
 *
 * The failure, from use:
 *
 *     User:  "Hugging Face와 open.hasa.re.kr에서 활용할 수 있는 모델도 찾아서 사용해줘."
 *     Agent: [web_search "HASA image classification model"]
 *            → results from huggingface.co
 *            → "HASA에서 활용할 수 있는 모델은 다음과 같습니다: …"
 *
 * Every step of that was recorded. The runtime knew a search had run and knew
 * it had succeeded, and that was all it knew — the result URLs never became
 * facts, so nothing could notice that the question was about one service and
 * the answer came from another.
 *
 *   QUERY SUBJECT ≠ RESULT SOURCE
 *
 * And underneath it, four distinctions that the word "사용 가능" collapses:
 *
 *   Search Result       ≠ Fetched Source
 *   Fetched Source      ≠ Claim Support
 *   Catalog Presence    ≠ API Accessibility
 *   API Accessibility   ≠ Successful Invocation
 *
 * This file is the vocabulary for keeping them apart. It holds no state and
 * decides nothing on its own; `taskState.ts` records provenance as part of
 * evidence, `taskReducer.ts` settles source requirements from it, and the claim
 * gate below is read at the one moment it matters — before the model writes its
 * answer, not after.
 *
 * ## What it deliberately is not
 *
 * Not a truth engine. Nothing here scores a source, ranks it, or decides
 * whether a page is trustworthy. The only judgements are the ones with an
 * objective answer: which host answered, whether the body was read or only
 * described by a search engine, whether it arrived whole.
 */

// ---------------------------------------------------------------------------
// Hostnames, with a boundary
// ---------------------------------------------------------------------------

/**
 * Whether `hostname` is `domain` or a subdomain of it.
 *
 * A dot boundary, not a substring. `hostname.includes("hasa.re.kr")` is true of
 * `open.hasa.re.kr.evil.example.com`, which is a host somebody else controls
 * with a name chosen to be read carelessly — and reading it carelessly is how
 * an attacker's page becomes "confirmed on the official site".
 */
export function hostMatches(hostname: string, domain: string): boolean {
  const host = normalizeHost(hostname);
  const target = normalizeHost(domain);
  if (host.length === 0 || target.length === 0) return false;
  return host === target || host.endsWith(`.${target}`);
}

/** Lowercased, trailing dot removed, port stripped. */
export function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
}

/**
 * Labels that identify a public suffix or a role rather than a service.
 *
 * Used only to name a service for reading prose — never to decide whether two
 * hosts are the same. `hostMatches` is what does that, and it needs no list.
 */
const SUFFIX_LABELS = new Set([
  "com", "net", "org", "io", "ai", "co", "dev", "app", "me", "xyz", "info", "biz",
  "kr", "jp", "cn", "us", "uk", "de", "fr", "eu", "in", "au", "ca", "br",
  "re", "or", "go", "ac", "ne", "edu", "gov", "mil", "int",
]);

const ROLE_LABELS = new Set(["www", "open", "api", "docs", "doc", "hub", "m", "en", "ko", "cdn", "static", "web"]);

/**
 * A short name for a service, for finding claims about it in prose.
 *
 * `open.hasa.re.kr` → `hasa`; `huggingface.co` → `huggingface`. A heuristic,
 * and only ever used to *look* for a sentence — never to decide that two URLs
 * are the same service.
 */
export function serviceName(hostname: string): string {
  const labels = normalizeHost(hostname).split(".").filter((l) => l.length > 0);
  const meaningful = labels.filter((l) => !SUFFIX_LABELS.has(l) && !ROLE_LABELS.has(l));
  if (meaningful.length > 0) {
    return meaningful.reduce((longest, l) => (l.length > longest.length ? l : longest));
  }
  return labels.filter((l) => !SUFFIX_LABELS.has(l)).at(0) ?? labels.at(0) ?? "";
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/** Who chose this URL. Not the same question as whether it is official. */
export type SourceOrigin = "user_supplied" | "model_discovered" | "search_result";

/**
 * How the content — if any — was obtained.
 *
 * The distinction the whole file exists for. `search_discovery` means a search
 * engine said this URL exists and wrote a sentence about it. `fetched` means
 * the bytes were read.
 */
export type SourceRetrieval = "search_discovery" | "fetched";

export interface WebSourceProvenance {
  /** The URL as asked for. Differs from `finalUrl` across a redirect. */
  requestedUrl?: string;
  /** Where the content actually came from, after redirects. */
  finalUrl?: string;
  /** Of `finalUrl` when there is one, else of `requestedUrl`. Always present. */
  hostname: string;
  sourceOrigin: SourceOrigin;
  retrieval: SourceRetrieval;
  retrievedAt: number;
  status?: number;
  contentType?: string;
  /** True when the body was cut, at either cap. A partial page proves less. */
  truncated?: boolean;
  /** The search that produced this, when it was a search result. */
  query?: string;
  /**
   * A cheap digest of what was read, so the same page fetched twice is one
   * observation. Not a hash for integrity — a hash for novelty.
   */
  contentFingerprint?: string;
}

/** Reads a hostname out of a URL, or says it could not. */
export function parseSourceUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Query parameters whose value is a secret often enough to assume it is.
 *
 * Matched as whole words within the parameter name, so `apiKey`, `api_key` and
 * `X-Api-Key` all land, and `keyboard_layout` does not.
 */
const SECRET_PARAM = /(?:^|[_\-.])(?:key|apikey|api_key|token|secret|password|passwd|pwd|sig|signature|auth|credential)s?(?:$|[_\-.])|^(?:key|apikey|token|secret|password|auth)s?$/i;

/**
 * A URL safe to write into a conversation file.
 *
 * Provenance is persisted, and a URL is one of the few places a credential
 * arrives looking like ordinary text — `https://user:pass@host/`, or a signed
 * link with the signature in the query string. The rule this repository has
 * held to since C1 is that no key material is ever written to storage, and a
 * new persisted field does not get an exception for being convenient.
 *
 * The host and path survive, because those are what provenance is *for*.
 */
export function redactUrl(raw: string): string {
  const url = parseSourceUrl(raw);
  if (url === null) return raw;
  if (url.username.length > 0 || url.password.length > 0) {
    url.username = "";
    url.password = "";
  }
  for (const name of [...url.searchParams.keys()]) {
    if (SECRET_PARAM.test(name)) url.searchParams.set(name, "[redacted]");
  }
  return url.toString();
}

/** A digest of a body, for telling a re-fetch from a discovery. */
export function fingerprint(text: string): string {
  // FNV-1a. Not cryptographic and does not need to be: the question it answers
  // is "is this the same page I already read", where a collision costs one
  // missed novelty and a wrong answer costs nothing at all.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

// ---------------------------------------------------------------------------
// Strength, and why nothing promotes
// ---------------------------------------------------------------------------

/**
 * What a source has been shown to be worth.
 *
 * Four steps, each of which has to be earned separately:
 *
 * - `discovered` — a search engine listed it.
 * - `fetched` — its content was read.
 * - `supported` — its content actually says the thing being claimed.
 * - `execution_verified` — the thing was done, not read about.
 *
 * There is deliberately no function in this file that raises one to the next.
 * Promotion is what the failure was.
 */
export type SourceStrength = "discovered" | "fetched" | "supported" | "execution_verified";

/**
 * How available something has been shown to be, on a particular service.
 *
 * `listed` is the one that gets overstated. A model ID appearing in a catalog
 * is a fact about the catalog page; it is not a fact about whether the API will
 * answer, and it is very much not a fact about whether this machine's
 * credential may call it.
 */
export type AvailabilityLevel = "discovered" | "listed" | "accessible" | "invocation_verified";

const LEVEL_ORDER: Record<AvailabilityLevel, number> = {
  discovered: 0,
  listed: 1,
  accessible: 2,
  invocation_verified: 3,
};

/** Whether `level` reaches `required`. Comparison, not promotion. */
export function atLeast(level: AvailabilityLevel | null, required: AvailabilityLevel): boolean {
  return level !== null && LEVEL_ORDER[level] >= LEVEL_ORDER[required];
}

export function describeLevel(level: AvailabilityLevel): string {
  switch (level) {
    case "discovered":
      return "검색 결과에서 언급됨 (페이지를 읽지는 않음)";
    case "listed":
      return "해당 사이트에서 직접 읽음";
    case "accessible":
      return "해당 사이트의 API가 응답함";
    case "invocation_verified":
      return "실제 호출이 성공함";
  }
}

// ---------------------------------------------------------------------------
// What the user pointed at
// ---------------------------------------------------------------------------

/**
 * A source the user named, which nothing else can stand in for.
 *
 * "open.hasa.re.kr/models에 있는 모델을 확인해줘" is not a topic to search for.
 * It is a page, and a requirement that names it is not met by finding out what
 * a search engine thinks about the subject.
 */
export interface SourceRequirement {
  kind: "exact_url";
  url: string;
  hostname: string;
}

/**
 * Top-level labels common enough to recognise a bare host by.
 *
 * Only consulted when the user wrote no scheme, and deliberately missing
 * everything that is also a file extension. `main.py`, `main.go` and `app.rs`
 * are files, and turning one into a source the agent is then held to for the
 * rest of the task would be the runtime inventing a requirement.
 *
 * With a scheme, no list is consulted at all: `https://` means a URL, whatever
 * comes after it.
 */
const COMMON_TLDS = new Set([
  "com", "net", "org", "io", "ai", "co", "dev", "app", "cloud", "tech", "online", "site",
  "kr", "jp", "cn", "us", "uk", "de", "fr", "eu", "au", "ca", "br", "nl", "se", "es", "it",
  "gov", "edu", "info", "biz", "me", "xyz", "news", "blog", "wiki",
]);

/**
 * URLs in something the user typed.
 *
 * Bare hosts count — `open.hasa.re.kr/models` without a scheme is how people
 * write them, and refusing to see it would make the whole mechanism depend on
 * the user typing `https://`.
 */
export function exactSourcesIn(text: string): SourceRequirement[] {
  const found: SourceRequirement[] = [];
  const seen = new Set<string>();
  const pattern = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s,)"'<>]*)?/gi;

  for (const match of text.matchAll(pattern)) {
    const raw = match[0].replace(/[.,;:)\]]+$/, "");
    const explicit = /^https?:\/\//i.test(raw);
    const url = parseSourceUrl(explicit ? raw : `https://${raw}`);
    if (url === null) continue;
    const hostname = normalizeHost(url.hostname);
    const labels = hostname.split(".");
    const tld = labels.at(-1) ?? "";
    if (labels.length < 2) continue;
    // Without a scheme the last label has to look like somewhere on the
    // internet rather than like a file.
    if (!explicit && !COMMON_TLDS.has(tld)) continue;
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ kind: "exact_url", url: key, hostname });
  }
  return found;
}

// ---------------------------------------------------------------------------
// HTTP failures
// ---------------------------------------------------------------------------

/**
 * Why a fetch did not produce a source.
 *
 * The distinctions here are the ones that were being lost, and each of them
 * changes what a turn should do next:
 *
 *   404 is not a network failure — the network worked and said no.
 *   No search results is not a blocker — the search worked and found nothing.
 *   429 is not absence — it is the same page, later.
 *
 * Aligned with `commandSemantics.FailureKind` in spirit: a fact about what
 * happened, from which eligibility follows, rather than a verdict.
 */
export type WebFailureKind =
  | "auth_required"
  | "access_denied"
  | "source_not_found"
  | "rate_limited"
  | "network_failure"
  | "remote_service_failure"
  | "not_readable"
  | "no_results"
  | "unknown_failure";

/** Maps a status code to what it means. Only the unambiguous ones. */
export function classifyStatus(status: number): WebFailureKind {
  if (status === 401) return "auth_required";
  if (status === 403) return "access_denied";
  if (status === 404 || status === 410) return "source_not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status < 600) return "remote_service_failure";
  return "unknown_failure";
}

/**
 * Reads a fetch failure message for what it says about the cause.
 *
 * A status code in the text is believed; prose is read only for the markers
 * that are unambiguous. Everything else stays `unknown_failure` — the same
 * conservatism as `classifyFailure`, and for the same reason: a guess that
 * turns a wrong URL into "the network is down" hands the user someone else's
 * problem.
 */
export function classifyWebFailure(detail: string): WebFailureKind {
  const text = detail.toLowerCase();
  const status = /\banswered (\d{3})\b/.exec(text)?.[1] ?? /\bhttp (\d{3})\b/.exec(text)?.[1];
  if (status !== undefined) {
    const kind = classifyStatus(Number(status));
    if (kind !== "unknown_failure") return kind;
  }
  if (/\bno results for\b|검색 결과가 없/.test(text)) return "no_results";
  if (/did not answer in time|timed out|timeout|etimedout|econnrefused|enotfound|getaddrinfo/.test(text)) {
    return "network_failure";
  }
  if (/which is not text|no readable text|not readable/.test(text)) return "not_readable";
  if (/\brefused:/.test(text)) return "access_denied";
  return "unknown_failure";
}

/**
 * Whether this failure is something outside the agent's control.
 *
 * `no_results` and `source_not_found` are pointedly absent. A search that found
 * nothing and a URL that does not exist are both answers, and reporting either
 * as a blocker is the web spelling of the mistake e613c05 closed for commands.
 */
const WEB_BLOCKERS: ReadonlySet<WebFailureKind> = new Set([
  "auth_required",
  "access_denied",
  "rate_limited",
  "network_failure",
  "remote_service_failure",
]);

export function isWebBlocker(kind: WebFailureKind): boolean {
  return WEB_BLOCKERS.has(kind);
}

export function describeWebFailure(kind: WebFailureKind): string {
  switch (kind) {
    case "auth_required":
      return "인증이 필요한 페이지입니다. 자격 증명 없이는 읽을 수 없습니다.";
    case "access_denied":
      return "접근이 거부되었습니다.";
    case "source_not_found":
      return "그 주소에는 페이지가 없습니다. 네트워크 문제가 아니라 주소 문제입니다.";
    case "rate_limited":
      return "요청 한도에 걸렸습니다. 페이지가 없는 것이 아니라 잠시 뒤에 다시 시도해야 합니다.";
    case "network_failure":
      return "네트워크에서 응답을 받지 못했습니다.";
    case "remote_service_failure":
      return "상대 서버가 오류를 반환했습니다.";
    case "not_readable":
      return "텍스트로 읽을 수 있는 내용이 아닙니다.";
    case "no_results":
      return "검색 결과가 없습니다. 검색이 실패한 것이 아니라 결과가 없는 것입니다.";
    case "unknown_failure":
      return "가져오지 못했습니다.";
  }
}
