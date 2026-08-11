import { fingerprint, hostMatches, normalizeHost, parseSourceUrl, redactUrl } from "./sourceProvenance.ts";

/**
 * What a page actually said, about a thing, kept apart from what page it was.
 *
 * b49f845 recorded which host answered, which closed the failure where a
 * service nobody visited got credited with a search result. It left one open,
 * and the gap is narrow enough to state exactly:
 *
 *     web_fetch huggingface.co  → Model A
 *     web_fetch open.hasa.re.kr → Model B
 *     answer: "Model A는 HASA에서 제공됩니다."
 *
 * Both hosts were read, so every service-level check passes. Nothing knew that
 * Model A came from one of them and the sentence names the other.
 *
 *   SERVICE FETCHED ≠ ENTITY LISTED
 *
 * ## Why this is not a scraper
 *
 * The runtime does not parse HTML looking for model names. That would be a
 * general semantic parser for arbitrary pages, wrong differently every week,
 * and it is not what makes the record trustworthy anyway.
 *
 * The same shape as `turnContract.ts` is used instead:
 *
 *     fetched page
 *          ↓  model reads it
 *     record_source_fact
 *          ↓  span checked against the bytes that arrived
 *     SourceFact          ← from here the runtime owns it
 *
 * The model interprets, because reading a catalog page is interpretation. What
 * it cannot do is assert a fact about a page it did not read, or quote a span
 * that is not in it: both are checked here against the body the fetch actually
 * returned, before anything is recorded.
 */

/**
 * What a source says about a subject.
 *
 * Three, and deliberately not more. An ontology is a thing that grows until
 * nobody can say what a term means, and the distinction that carries this
 * slice is only the first one: whether the page named the thing at all.
 */
export type SourcePredicate =
  /** The page names it. Nothing more — a blog post mentioning a model. */
  | "mentioned"
  /** The service's own catalog carries it. */
  | "listed"
  /** The page offers it for download. */
  | "downloadable";

export const SOURCE_PREDICATES: readonly SourcePredicate[] = ["mentioned", "listed", "downloadable"];

export interface SourceFact {
  id: string;
  /** The thing the page is being read as saying something about. */
  subject: string;
  predicate: SourcePredicate;
  /** The host whose page this came from. Compared on a dot boundary. */
  hostname: string;
  /** Redacted, like every other stored URL. */
  sourceUrl: string;
  /**
   * The digest of the body this was read out of.
   *
   * How a fact finds its evidence. An id would have to be threaded from the
   * fetch through the tool loop to a later call, and the fingerprint is already
   * on both ends — content-addressed, so it survives replay without anything
   * being carried.
   */
  sourceFingerprint: string;
  /** A short quote from the page, checked against it. Absent when inferred. */
  sourceText?: string;
  /** `explicit` when the model quoted the page; `inferred` when it did not. */
  origin: "explicit" | "inferred";
  at: number;
}

/** Why a proposed fact was refused, for the model to be told once. */
export interface FactProblem {
  reason: string;
}

const MAX_SUBJECT = 120;
const MAX_SPAN = 200;

// ---------------------------------------------------------------------------
// The pages this turn actually read
// ---------------------------------------------------------------------------

interface Page {
  url: string;
  hostname: string;
  fingerprint: string;
  body: string;
}

/**
 * The bodies of recently fetched pages, so a quote can be checked.
 *
 * In memory and bounded, and it never reaches storage. A conversation file
 * holding the full text of every page an agent read would be a privacy problem
 * and a size problem, and it is not needed: what has to persist is the fact and
 * a bounded span, and what has to exist *at the moment the fact is recorded* is
 * the body it claims to come from.
 *
 * So the ledger lives as long as the session and holds the last few pages. A
 * fact about something older is refused rather than accepted unchecked — see
 * `verify`.
 */
export class SourceLedger {
  private readonly pages: Page[] = [];
  private readonly limit: number;

  constructor(limit = 8) {
    this.limit = limit;
  }

  /** Called by `web_fetch` with what it just read. */
  remember(url: string, hostname: string, body: string): void {
    const page: Page = { url: redactUrl(url), hostname: normalizeHost(hostname), fingerprint: fingerprint(body), body };
    const existing = this.pages.findIndex((p) => p.fingerprint === page.fingerprint && p.hostname === page.hostname);
    if (existing >= 0) this.pages.splice(existing, 1);
    this.pages.push(page);
    while (this.pages.length > this.limit) this.pages.shift();
  }

  /** The page a URL refers to, newest first, matching on host and path. */
  find(url: string): Page | null {
    const parsed = parseSourceUrl(url);
    if (parsed === null) return null;
    const host = normalizeHost(parsed.hostname);
    const path = parsed.pathname;
    for (let i = this.pages.length - 1; i >= 0; i -= 1) {
      const page = this.pages[i];
      if (page === undefined) continue;
      if (!hostMatches(page.hostname, host) && !hostMatches(host, page.hostname)) continue;
      const pagePath = parseSourceUrl(page.url)?.pathname ?? "";
      // The path has to agree, or "I read the site" would settle a fact about
      // any page on it. Either direction, because a fetch may have been
      // redirected to a longer path than the model remembers asking for.
      if (pagePath === path || pagePath.startsWith(path) || path.startsWith(pagePath)) return page;
    }
    return null;
  }

  /** Hosts read this session, for telling a model what it may record about. */
  hosts(): string[] {
    return [...new Set(this.pages.map((p) => p.hostname))];
  }

  get size(): number {
    return this.pages.length;
  }
}

// ---------------------------------------------------------------------------
// Checking a proposed fact against the page it names
// ---------------------------------------------------------------------------

/** Collapses whitespace and case so a quote survives HTML-to-text tidying. */
function loose(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export interface ProposedFact {
  url: string;
  subject: string;
  predicate: string;
  sourceText?: string;
}

/**
 * Turns what the model sent into a fact, or says why not.
 *
 * The four refusals, and each is a way the gap could be reopened:
 *
 * - A page that was never fetched. A fact has to come from a source, and a
 *   source the runtime did not see is the model's memory wearing a URL.
 * - A subject that is not in the page. This is the load-bearing one: it is
 *   exactly the cross-attribution that motivated the slice, and it is checkable
 *   because the body is right here.
 * - A quote that is not in the page. Stated separately from the subject so the
 *   message says which of the two was wrong.
 * - A predicate nobody defined.
 *
 * A fact whose subject is present but which quotes nothing is accepted as
 * `inferred` — a catalog rendered as a table may not contain any span worth
 * quoting, and refusing those would push the model towards inventing quotes.
 */
export function verifyFact(
  proposed: ProposedFact,
  ledger: SourceLedger,
  at: number,
  id: string,
): { ok: true; fact: SourceFact } | { ok: false; problem: FactProblem } {
  const subject = proposed.subject.trim().slice(0, MAX_SUBJECT);
  if (subject.length === 0) {
    return { ok: false, problem: { reason: "무엇에 대한 사실인지 subject에 적으십시오." } };
  }
  if (!(SOURCE_PREDICATES as readonly string[]).includes(proposed.predicate)) {
    return {
      ok: false,
      problem: { reason: `predicate는 ${SOURCE_PREDICATES.join(", ")} 중 하나여야 합니다.` },
    };
  }

  const page = ledger.find(proposed.url);
  if (page === null) {
    const read = ledger.hosts();
    return {
      ok: false,
      problem: {
        reason:
          `${proposed.url} 은(는) 이번 세션에서 읽은 페이지가 아닙니다. ` +
          (read.length === 0
            ? "web_fetch로 먼저 읽은 다음에 기록하십시오."
            : `읽은 곳: ${read.join(", ")}. 먼저 web_fetch로 읽으십시오.`),
      },
    };
  }

  const body = loose(page.body);
  if (!body.includes(loose(subject))) {
    return {
      ok: false,
      problem: {
        reason:
          `"${subject}" 은(는) ${page.hostname} 에서 가져온 내용에 없습니다. ` +
          "다른 출처에서 본 것을 이 출처의 사실로 기록할 수 없습니다.",
      },
    };
  }

  const quoted = (proposed.sourceText ?? "").trim().slice(0, MAX_SPAN);
  if (quoted.length > 0 && !body.includes(loose(quoted))) {
    return {
      ok: false,
      problem: {
        reason: `인용한 sourceText가 ${page.hostname} 의 내용에 없습니다. 실제 문구를 그대로 옮기거나 생략하십시오.`,
      },
    };
  }

  return {
    ok: true,
    fact: {
      id,
      subject,
      predicate: proposed.predicate as SourcePredicate,
      hostname: page.hostname,
      sourceUrl: page.url,
      sourceFingerprint: page.fingerprint,
      // Redacted like every other stored string. A span lifted out of a page
      // can carry whatever the page had in it.
      ...(quoted.length === 0 ? {} : { sourceText: redactSpan(quoted) }),
      origin: quoted.length === 0 ? "inferred" : "explicit",
      at,
    },
  };
}

/**
 * Removes anything key-shaped from a quoted span.
 *
 * The span comes from a third party's page and is written to the conversation
 * file. `redactUrl` handles a URL; this handles the rest — an assignment whose
 * right-hand side is long and opaque is the shape a credential has.
 */
export function redactSpan(text: string): string {
  return text
    .replace(/\bhttps?:\/\/\S+/gi, (url) => redactUrl(url.replace(/[.,;:)\]"']+$/, "")))
    .replace(
      /((?:api[_-]?key|token|secret|password|authorization|bearer)\s*[:=]\s*)(["']?)([A-Za-z0-9_\-.]{8,})\2/gi,
      "$1$2[redacted]$2",
    );
}

/** Two facts are the same fact when they say the same thing about the same page. */
export function factKey(fact: Pick<SourceFact, "subject" | "predicate" | "hostname" | "sourceFingerprint">): string {
  return `${fact.hostname}|${fact.sourceFingerprint}|${fact.predicate}|${fact.subject.toLowerCase()}`;
}

/** Facts a service's own pages carry, at the strength a claim needs. */
export function factsFor(
  facts: readonly SourceFact[],
  hostname: string,
  subject?: string,
): SourceFact[] {
  const wanted = subject === undefined ? null : loose(subject);
  return facts.filter(
    (f) => hostMatches(f.hostname, hostname) && (wanted === null || loose(f.subject) === wanted),
  );
}

/** Every subject any source has been recorded as carrying. */
export function knownSubjects(facts: readonly SourceFact[]): string[] {
  return [...new Set(facts.map((f) => f.subject))];
}
