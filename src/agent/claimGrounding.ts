import type { Evidence } from "./taskState.ts";
import { factsFor, knownSubjects, type SourceFact } from "./sourceFacts.ts";
import {
  atLeast,
  describeLevel,
  hostMatches,
  normalizeHost,
  serviceName,
  type AvailabilityLevel,
  type WebSourceProvenance,
} from "./sourceProvenance.ts";

/**
 * Whether the answer says more than the record does.
 *
 * `taskState.describeTask` already hands the model what actually happened
 * before it writes. That closes the general case and did not close this one,
 * because the overstatement here is not "I ran the tests" — it is a sentence
 * that is true about one service and gets written about another:
 *
 *     evidence: huggingface.co, fetched
 *     answer:   "이 모델은 Open HASA에서 사용할 수 있습니다."
 *
 * Nothing in the record contradicts that sentence. Nothing in the record
 * supports it either, and the difference between those two is what this file
 * is for.
 *
 * ## Narrow on purpose
 *
 * It only asks about services this task actually touched — a host the user
 * named or a host something was fetched from. It only recognises three claim
 * shapes, all of them about availability rather than about content. Anything it
 * is unsure of, it says nothing about: a false accusation costs the user a
 * correct answer rewritten into a hedge, which is worse than the sentence it
 * would have removed.
 */

export type ClaimKind =
  /** "X를 여기서 쓸 수 있다" — needs the service's own page to have been read. */
  | "availability"
  /** "여기서 호출했다 / 실행했다" — needs an execution, not a page. */
  | "invocation"
  /** "여기는 X를 지원하지 않는다" — needs to have seen the whole of it. */
  | "absence";

export interface ServiceKnowledge {
  hostname: string;
  /** The short name a sentence would use. See `serviceName`. */
  name: string;
  /** Null for a service the user named that nothing was ever read from. */
  level: AvailabilityLevel | null;
  /** True when something read from this host arrived cut. */
  truncated: boolean;
  /** The evidence ids behind `level`, so a claim can be traced to them. */
  evidenceIds: string[];
}

export interface UnsupportedClaim {
  kind: ClaimKind;
  /** The entity the sentence is about, when it names one the runtime knows. */
  subject?: string;
  /** The host the sentence is about. */
  hostname: string;
  name: string;
  /** What the record actually reaches, or null when nothing does. */
  have: AvailabilityLevel | null;
  needed: AvailabilityLevel;
  /** The sentence, so a correction can quote it rather than paraphrase. */
  sentence: string;
}

// ---------------------------------------------------------------------------
// What the record knows about each service
// ---------------------------------------------------------------------------

function sourcesOf(evidence: readonly Evidence[]): WebSourceProvenance[] {
  return evidence.flatMap((e) => e.sources ?? []);
}

/**
 * The level reached for one host, from evidence alone.
 *
 * Each step is read from a different kind of fact, and no step is inferred from
 * the one below it:
 *
 * - `invocation_verified` — a *non-web* observation that succeeded and names
 *   this host. A command that called the API is the only thing that produces
 *   it, which is the point: a catalog page cannot.
 * - `fetched` — a page on this host was read. What was *on* it is a separate
 *   question, answered by `entityLevel` and by nothing here.
 * - `discovered` — a search result pointed here and nobody opened it.
 *
 * `listed` is deliberately unreachable from evidence alone. It used to be what
 * a read page earned, and that is what let a model seen on one site inherit
 * another site's standing: both hosts were `listed`, so a sentence about either
 * passed.
 */
export function levelFor(evidence: readonly Evidence[], hostname: string): AvailabilityLevel | null {
  const host = normalizeHost(hostname);
  const name = serviceName(host);
  let best: AvailabilityLevel | null = null;
  const take = (level: AvailabilityLevel): void => {
    if (!atLeast(best, level)) best = level;
  };

  for (const item of evidence) {
    // An execution that names the host. `web_source` is excluded by kind rather
    // than by hoping its text does not mention the host — reading a page about
    // an API is exactly the thing being kept apart from calling it.
    if (item.kind !== "web_source" && item.status === "passed") {
      const text = item.observation.toLowerCase();
      if (text.includes(host) || (name.length > 2 && text.includes(name))) take("invocation_verified");
    }
    for (const source of item.sources ?? []) {
      if (!hostMatches(source.hostname, host)) continue;
      take(source.retrieval === "fetched" ? "fetched" : "discovered");
    }
  }
  return best;
}

/**
 * Whether this host's own API answered a request.
 *
 * Beside the ladder rather than on it. A catalog endpoint returning JSON is a
 * fact about the endpoint and says nothing about any particular model; when it
 * sat above `listed` in the ordering, one successful GET outranked having
 * actually found the thing being claimed.
 */
export function serviceApiAnswered(evidence: readonly Evidence[], hostname: string): boolean {
  return sourcesOf(evidence).some(
    (s) =>
      hostMatches(s.hostname, hostname) &&
      s.retrieval === "fetched" &&
      (s.contentType ?? "").toLowerCase().includes("json"),
  );
}

/**
 * How far one *thing* on one service has been shown to go.
 *
 * The distinction the previous slice could not draw. `fetched` says the page
 * was read; only a fact recorded out of that page — checked against its bytes,
 * see `sourceFacts.verifyFact` — raises a particular subject to `listed`, and
 * only an execution naming it reaches the top.
 */
export function entityLevel(
  evidence: readonly Evidence[],
  facts: readonly SourceFact[],
  hostname: string,
  subject: string,
): AvailabilityLevel | null {
  const executed = evidence.some(
    (e) =>
      e.kind !== "web_source" &&
      e.status === "passed" &&
      e.observation.toLowerCase().includes(subject.toLowerCase()) &&
      mentionsHost(e.observation, hostname),
  );
  if (executed) return "invocation_verified";
  if (factsFor(facts, hostname, subject).length > 0) return "listed";
  // Known nowhere on this host: it falls back to whatever the *service* reached,
  // which is what stops a fetched page from carrying an entity it never named.
  return levelFor(evidence, hostname);
}

function mentionsHost(text: string, hostname: string): boolean {
  const lower = text.toLowerCase();
  const name = serviceName(hostname);
  return lower.includes(normalizeHost(hostname)) || (name.length > 2 && lower.includes(name));
}

/**
 * Every service in play, whether or not anything was read from it.
 *
 * `named` is the load-bearing half and was missing at first, which made the
 * check useless against the exact failure it was written for: the agent
 * searched, got Hugging Face, and wrote a sentence about a service it had never
 * touched. A host with no evidence is not a host with no claims about it — it
 * is the host most likely to be claimed about, because nothing observed can
 * contradict a sentence when nothing was observed.
 */
export function knownServices(
  evidence: readonly Evidence[],
  named: readonly { hostname: string }[] = [],
  facts: readonly SourceFact[] = [],
): ServiceKnowledge[] {
  const hosts = new Set<string>();
  for (const source of sourcesOf(evidence)) hosts.add(normalizeHost(source.hostname));
  for (const source of named) hosts.add(normalizeHost(source.hostname));
  for (const fact of facts) hosts.add(normalizeHost(fact.hostname));

  const out: ServiceKnowledge[] = [];
  for (const hostname of hosts) {
    const level = levelFor(evidence, hostname);
    out.push({
      hostname,
      name: serviceName(hostname),
      level,
      truncated: sourcesOf(evidence).some(
        (s) => hostMatches(s.hostname, hostname) && s.retrieval === "fetched" && s.truncated === true,
      ),
      evidenceIds: evidence.filter((e) => (e.sources ?? []).some((s) => hostMatches(s.hostname, hostname))).map((e) => e.id),
    });
  }
  return out.sort((a, b) => a.hostname.localeCompare(b.hostname));
}

// ---------------------------------------------------------------------------
// Reading the answer
// ---------------------------------------------------------------------------

/**
 * Splits on a sentence end followed by space, never on a bare dot.
 *
 * `open.hasa.re.kr에서 사용할 수 있습니다` is one sentence containing three
 * dots. Splitting on `.` would separate the host from the claim about it and
 * the check would find neither.
 */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** "여기서 쓸 수 있다". Present tense, about the service. */
const AVAILABILITY = /사용할 수 있|사용 가능|이용할 수 있|이용 가능|활용할 수 있|활용 가능|쓸 수 있|접근 가능|제공(?:하고 있|합니|됩니|하는)|지원(?:하고 있|합니|됩니|하는)|available on|available (?:at|from|through|via)|accessible (?:on|at|via)|can be used (?:on|with|via)/i;

/** "호출했다 / 실행했다". Past tense, about a call that happened. */
const INVOCATION =
  /(?:호출|실행|추론|inference|invoke|invocation|call)[^.!?\n]{0,24}(?:성공|완료|했습니다|하였습니다|되었습니다|verified|succeeded|successful)|(?:성공적으로|정상적으로)[^.!?\n]{0,24}(?:호출|실행|추론)/i;

/**
 * The same claim, in words that can only be about a model service.
 *
 * Used when the sentence names no service at all, and only when exactly one is
 * in play. "테스트를 실행했고 모두 통과했습니다" is about the workspace and must
 * not be touched; "inference를 성공적으로 실행했습니다" in a task whose only
 * service is a model catalog is about that catalog, and it is the sentence
 * §31 is written against.
 */
const MODEL_INVOCATION =
  /(?:inference|추론|모델\s*호출|api\s*호출)[^.!?\n]{0,24}(?:성공|완료|했습니다|하였습니다|되었습니다|succeeded|successful|verified)|(?:성공적으로|정상적으로)[^.!?\n]{0,16}(?:inference|추론|모델\s*호출|api\s*호출)/i;

/** "지원하지 않는다". A claim about the whole of a service. */
const ABSENCE =
  /지원하지 않|제공하지 않|없습니다|존재하지 않|찾을 수 없습니다|does not (?:support|provide|have|offer)|is not (?:supported|available|provided)|no (?:such )?model/i;

/** "확인한 범위에서는" — a qualified negative, which is the honest form. */
const QUALIFIED = /확인한 (?:범위|목록|부분)|읽은 (?:범위|부분)|일부만|중에서는|가져온 (?:범위|부분)|among (?:the|those)|in what (?:i|we) (?:read|checked)|of the (?:ones|results) (?:i|we)/i;

/**
 * Whether a sentence is about this service.
 *
 * The hostname, or the short name as a whole word. `hasa` must not match
 * `hasachusetts`, and the Korean particle that follows a name — `hasa에서` — is
 * not a word boundary in the regex sense, so the boundary is asserted against
 * ASCII letters only.
 */
function mentions(sentence: string, service: ServiceKnowledge): boolean {
  const text = sentence.toLowerCase();
  if (text.includes(service.hostname)) return true;
  if (service.name.length < 3) return false;
  return wholeWord(text, service.name);
}

/**
 * Whether a sentence is about a recorded entity.
 *
 * The same boundary rule, and it matters more here: model ids are substrings of
 * each other often enough — `vit-base` inside `vit-base-patch16` — that a
 * substring test would attribute a claim about one to the other.
 */
function mentionsSubject(sentence: string, subject: string): boolean {
  return subject.length >= 3 && wholeWord(sentence.toLowerCase(), subject.toLowerCase());
}

/** A boundary against ASCII word characters, so Korean particles do not block it. */
function wholeWord(text: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
}

/**
 * Sentences that claim more about a service than was observed.
 *
 * Returns nothing when there is nothing to say — which is the common case, and
 * has to stay the common case for this to be worth having.
 */
export function unsupportedClaims(
  evidence: readonly Evidence[],
  text: string,
  named: readonly { hostname: string }[] = [],
  facts: readonly SourceFact[] = [],
): UnsupportedClaim[] {
  const services = knownServices(evidence, named, facts);
  if (services.length === 0) return [];
  /** The one service a sentence can be about without naming it. */
  const only = services.length === 1 ? services[0] : undefined;
  const subjects = knownSubjects(facts);

  const out: UnsupportedClaim[] = [];
  for (const sentence of sentences(text)) {
    // A model call claimed with no service named, where there is only one it
    // could mean.
    if (
      only !== undefined &&
      !mentions(sentence, only) &&
      MODEL_INVOCATION.test(sentence) &&
      !atLeast(only.level, "invocation_verified")
    ) {
      out.push({ kind: "invocation", hostname: only.hostname, name: only.name, have: only.level, needed: "invocation_verified", sentence });
      continue;
    }
    for (const service of services) {
      if (!mentions(sentence, service)) continue;

      // Which recorded entities this sentence is about. Only names the runtime
      // has seen on *some* source count — a name it has never encountered
      // cannot be checked, and guessing at one would be the scraper this
      // deliberately is not.
      const named = subjects.filter((s) => mentionsSubject(sentence, s));
      const level = (subject?: string): AvailabilityLevel | null =>
        subject === undefined ? service.level : entityLevel(evidence, facts, service.hostname, subject);

      // Invocation first: "HASA에서 호출에 성공했습니다" is also an availability
      // sentence, and the stronger reading is the one to answer.
      if (INVOCATION.test(sentence)) {
        for (const subject of named.length > 0 ? named : [undefined]) {
          if (atLeast(level(subject), "invocation_verified")) continue;
          out.push({
            kind: "invocation",
            hostname: service.hostname,
            name: service.name,
            have: level(subject),
            needed: "invocation_verified",
            sentence,
            ...(subject === undefined ? {} : { subject }),
          });
        }
        continue;
      }
      if (AVAILABILITY.test(sentence)) {
        // The cross-attribution case. A subject the runtime knows from another
        // source needs a fact from *this* one; a sentence naming nothing needs
        // only that the service's own page was read.
        for (const subject of named.length > 0 ? named : [undefined]) {
          const needed: AvailabilityLevel = subject === undefined ? "fetched" : "listed";
          if (atLeast(level(subject), needed)) continue;
          out.push({
            kind: "availability",
            hostname: service.hostname,
            name: service.name,
            have: level(subject),
            needed,
            sentence,
            ...(subject === undefined ? {} : { subject }),
          });
        }
        continue;
      }
      // A negative claim about the whole of a service. "확인한 목록에서는
      // 없었습니다" is fine and is what QUALIFIED lets through; a flat denial
      // needs the service to have been enumerated, and a page that arrived cut
      // was not enumerated whatever was recorded from it.
      if (ABSENCE.test(sentence) && !QUALIFIED.test(sentence)) {
        const enumerated = factsFor(facts, service.hostname).length > 0 && !service.truncated;
        if (!enumerated) {
          out.push({
            kind: "absence",
            hostname: service.hostname,
            name: service.name,
            have: service.level,
            needed: "listed",
            sentence,
            ...(named[0] === undefined ? {} : { subject: named[0] }),
          });
        }
      }
    }
  }
  return out;
}

/**
 * What to tell the model, once, when a claim outran the record.
 *
 * Says what was actually established and what the sentence would need, rather
 * than only refusing. A correction the model cannot act on produces a hedge in
 * place of an answer, and a hedge is not more honest — it is less informative
 * about the same facts.
 */
export function describeUnsupportedClaims(claims: readonly UnsupportedClaim[]): string {
  const lines: string[] = [
    "다음 문장은 지금까지 관측된 근거보다 강한 주장입니다. 근거에 맞게 고쳐서 다시 답하십시오.",
  ];
  const seen = new Set<string>();
  for (const claim of claims) {
    if (seen.has(claim.sentence)) continue;
    seen.add(claim.sentence);
    const have =
      claim.have === null ? "이 서비스에 대해 확인된 것이 없습니다" : describeLevel(claim.have);
    lines.push(
      `- "${claim.sentence}"\n` +
        `  ${claim.hostname}에 대해 확인된 것: ${have}.\n` +
        `  ${needText(claim)}`,
    );
  }
  return lines.join("\n");
}

function needText(claim: UnsupportedClaim): string {
  switch (claim.kind) {
    case "invocation":
      return (
        `실제 호출 결과가 없으므로 "${claim.name}에서 실행했다"고 쓸 수 없습니다. ` +
        "목록에 있다는 것과 호출에 성공했다는 것은 다른 사실입니다."
      );
    case "availability":
      // The two shapes are genuinely different problems. One is "you never
      // opened that site"; the other is "you opened it, and this is not what
      // you found there".
      return claim.subject === undefined
        ? `${claim.hostname}의 페이지를 직접 읽지 않았으므로 그곳에서 사용할 수 있다고 쓸 수 없습니다. ` +
          "다른 사이트에서 찾은 것은 그 사이트에서 찾은 것입니다."
        : `${claim.hostname}의 내용에서 ${claim.subject} 을(를) 확인한 기록이 없습니다. ` +
          `다른 출처에서 본 것을 ${claim.name}의 것으로 쓸 수 없습니다. ` +
          `실제로 그 페이지에 있다면 record_source_fact로 먼저 기록하십시오.`;
    case "absence":
      return (
        "그 출처에 무엇이 있었는지 기록되지 않았거나 내용이 잘렸으므로, 전체에 없다고 쓸 수 없습니다. " +
        '"확인한 범위에서는 찾지 못했습니다"처럼 범위를 밝히십시오.'
      );
  }
}

// ---------------------------------------------------------------------------
// Counting what happened
// ---------------------------------------------------------------------------

/**
 * What a task's web work amounted to.
 *
 * Derived from the record rather than counted as it goes, for the same reason
 * `TaskState` is a projection: a counter kept alongside the events is a second
 * source of truth that disagrees after a reload or a branch switch.
 *
 * Everything here is a fact about observations. How many claims a turn had to
 * be corrected on is a fact about a *turn*, lives in the loop, and is not in
 * this object pretending to be derivable.
 */
export interface SourceMetrics {
  userSuppliedUrls: number;
  successfulExactFetches: number;
  unreadUserSources: number;
  genericSearches: number;
  searchResults: number;
  fetchedSources: number;
  /** Re-reads of a page whose content had not changed. */
  duplicateFetches: number;
  truncatedFetches: number;
  listedServices: number;
  invocationVerifiedServices: number;
  /** Entities recorded out of a page, checked against it. */
  recordedFacts: number;
  /** Distinct things any source was recorded as carrying. */
  distinctSubjects: number;
}

export function sourceMetrics(
  evidence: readonly Evidence[],
  named: readonly { hostname: string; status?: string }[] = [],
  facts: readonly SourceFact[] = [],
): SourceMetrics {
  const sources = sourcesOf(evidence);
  const searches = sources.filter((s) => s.retrieval === "search_discovery");
  const fetches = sources.filter((s) => s.retrieval === "fetched");

  const seen = new Set<string>();
  let duplicates = 0;
  for (const source of fetches) {
    const key = `${source.hostname}@${source.contentFingerprint ?? source.finalUrl ?? ""}`;
    if (seen.has(key)) duplicates += 1;
    seen.add(key);
  }

  const services = knownServices(evidence, named, facts);
  return {
    userSuppliedUrls: named.length,
    successfulExactFetches: named.filter((n) => n.status === "fetched").length,
    unreadUserSources: named.filter((n) => n.status !== undefined && n.status !== "fetched").length,
    genericSearches: new Set(searches.map((s) => s.query ?? "")).size,
    searchResults: searches.length,
    fetchedSources: fetches.length,
    duplicateFetches: duplicates,
    truncatedFetches: fetches.filter((s) => s.truncated === true).length,
    // A service counts as `listed` when something was actually recorded out of
    // its own pages — not when one of its pages was opened.
    listedServices: services.filter((s) => factsFor(facts, s.hostname).length > 0).length,
    invocationVerifiedServices: services.filter((s) => atLeast(s.level, "invocation_verified")).length,
    recordedFacts: facts.length,
    distinctSubjects: knownSubjects(facts).length,
  };
}

/**
 * What each service was actually shown to be, for the pre-answer brief.
 *
 * Given to the model before it writes, beside the rest of the record. The
 * correction path above exists for the case where this was not enough; giving
 * the fact first is what usually means the sentence is never written.
 */
export function describeSources(
  evidence: readonly Evidence[],
  named: readonly { hostname: string }[] = [],
  facts: readonly SourceFact[] = [],
): string | null {
  const services = knownServices(evidence, named, facts);
  if (services.length === 0) return null;

  const lines = ["출처별로 확인된 것:"];
  for (const service of services) {
    const cut = service.truncated ? " (내용이 잘렸으므로 전체를 본 것은 아닙니다)" : "";
    const level = service.level === null ? "확인된 것이 없습니다" : describeLevel(service.level);
    // What was actually found there, by name. This is the line that lets a
    // model group its answer correctly instead of being corrected afterwards.
    const found = factsFor(facts, service.hostname).map((f) => f.subject);
    const carried =
      found.length > 0
        ? `\n  이 출처에서 확인된 항목: ${[...new Set(found)].join(", ")}`
        : atLeast(service.level, "fetched")
          ? "\n  이 출처에서 기록된 항목이 없습니다. 여기서 무엇을 찾았는지는 " +
            "record_source_fact로 남겨야 근거가 됩니다."
          : "";
    lines.push(`- ${service.hostname}: ${level}${cut}${carried}`);
  }
  if (services.length > 1) {
    lines.push(
      "한 사이트에서 확인한 것을 다른 사이트에서 확인했다고 쓰지 마십시오. " +
        "사이트별로 나누어 적으십시오.",
    );
  }
  return lines.join("\n");
}
