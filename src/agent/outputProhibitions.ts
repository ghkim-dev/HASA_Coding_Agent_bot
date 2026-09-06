/**
 * What the user forbade the *answer* to contain.
 *
 * `statedProhibitions` reads the three classes that can change a machine, and
 * its header says why it is shaped that way: it exists to give the action gate
 * a second opinion the model cannot omit. Every class it knows names a tool.
 *
 * This is the other kind of prohibition, and it had no reader at all:
 *
 *     후보 솔루션을 비교해 주세요.
 *     다만 특정 벤더의 제품명은 결론에 넣지 말아 주세요.
 *
 * `prohibitionsIn` returns an empty set for that second sentence — correctly,
 * because it gates no tool — and `functionalExtract` refuses to make a positive
 * requirement out of a negated verb, also correctly. The result was that the
 * sentence was read by nothing: the plan showed "하지 않을 작업: 없습니다" under
 * a request that had just stated one, and the user had no way to tell whether
 * the constraint had been understood or dropped.
 *
 * ## Why not a fourth `ProhibitedClass`
 *
 * Five call sites consume that enum and all five ask the same question of it —
 * which tool do I refuse. A class that answers "none" would have to be special-
 * cased in every one of them, and the first time somebody forgot, an output
 * constraint would silently disarm a tool gate or be disarmed by one.
 *
 * They also differ in what a member *is*. An act class is a closed set, so its
 * requirement text can be a constant. What a user bans from an answer is open
 * and specific — a vendor's name, a price, a competitor, an unverified guess —
 * so a reader that loses the subject has read nothing worth showing.
 *
 * ## What it costs to be wrong
 *
 * Not what being wrong costs the tool gate. A miss here leaves the plan as
 * silent as it already was; a false positive shows the user a line they did not
 * ask for, in a panel whose whole purpose is to be corrected. So this is
 * allowed to reach for a sentence the gate would not touch — but it still
 * requires the negation to attach to the verb, because a constraint invented
 * out of a passing mention is not a smaller error than a missed one, it is a
 * louder one.
 */

/** A constraint on the deliverable, as the user stated it. */
export interface OutputProhibition {
  /** What may not appear, in the user's own words. */
  subject: string;
  /**
   * Where the user said it may not appear — "결론", "보고서" — or null.
   *
   * Carried rather than discarded because the requirement sentence is built
   * from it. Assuming the answer was the place turned "이 값은 DB에 넣지 마"
   * into "…결과물에 넣지 않는다", which is a different instruction from the one
   * the user gave, written in the panel that exists to show them what was
   * understood.
   */
  place: string | null;
  /** The clause it was stated in. Offsets into the text that was read. */
  start: number;
  end: number;
}

/**
 * Verbs about what appears in an answer, rather than what is done to a machine.
 *
 * `쓰` is the ambiguous one — it is both "write" and "use" — and it stays in
 * because the disambiguation is done elsewhere and better: a sentence the act
 * classes already claimed is never re-read here. "웹 검색은 쓰지 마세요" is a
 * research ban and leaves through that door, so `쓰` reaching this list only
 * ever sees the sentences that door left behind.
 */
const CONTENT_VERB = "(?:넣|포함하|기재하|적|쓰|언급하|노출하|삽입하|담|다루)";

/**
 * The negation, matching `statedProhibitions`' own `NEG` and for its reasons.
 *
 * `못` and `않았` are excluded there because they report a failure rather than
 * forbid an act, and the same sentence in the same request must not mean two
 * things to two readers.
 */
const NEG = "(?:마|말|않고|않도록|않게)";

/**
 * "…넣지 마", "…포함하지 말아 주세요", "…쓰지 않도록".
 *
 * The `지` is required and carries the particle family `statedProhibitions`
 * documents — 넣지는 마, 넣지도 마 — for the same reason it does: Korean marks
 * contrast on the negated verb, and a reader that demands the two be adjacent
 * misses every politely contrastive ban.
 */
const NEGATED_CONTENT = new RegExp(`${CONTENT_VERB}지(?:[는도를은])?\\s*${NEG}`, "g");

/**
 * A word that names the thing being produced.
 *
 * The qualifier this module needs, and the same device `statedProhibitions`
 * uses on its research class: a bare 검색 is not the web, so `WEB` requires
 * 웹/인터넷 in front of it. A bare removal is not a constraint on the answer,
 * so `REMOVAL` requires one of these in the same clause.
 */
const DELIVERABLE =
  "(?:결론|결과물|산출물|보고서|리포트|요약|답변|응답|문서|정리|출력|본문|초안|summary|report|conclusion|answer|output)";

/** The same list, for testing a place the user named. */
const IS_DELIVERABLE = new RegExp(DELIVERABLE, "i");

/**
 * "…는 결론에서 빼 주세요" — the removal stated without a negation.
 *
 * Kept apart from `NEGATED_CONTENT` because there is no `지` to anchor on, and
 * the qualifier is not decoration. Without it this matched "낡은 핸들러를
 * 삭제해줘" and turned an ordinary request to delete a handler into a
 * prohibition — six holdout cases and the whole precision suite said so, and
 * the module header had already named that as the only way this can hurt.
 *
 * The act verbs are gone with it. 삭제·숨김·차단 are things done to a machine,
 * and if a user forbids one of those the class that gates the tool is the one
 * that should read it. What is left — 빼다, 제외하다, 생략하다 — is ambiguous
 * on its own, which is exactly why it may only fire next to a deliverable.
 *
 * The locative has to sit directly in front of the verb, which gives up "벤더
 * 이름은 빼고 보고서를 정리해줘" — a real constraint, stated with the
 * deliverable on the far side of the verb. Given up on purpose: reaching for it
 * meant a lookahead over the rest of the clause, and a pattern that scans
 * twenty characters for a noun will eventually find one in a sentence that
 * meant something else. The negated phrasing is both commoner and unambiguous,
 * and `NEGATED_CONTENT` reads it without any of this.
 */
const REMOVAL = new RegExp(`(?:은|는|을|를)?\\s*(${DELIVERABLE})(?:에서|에는|에)\\s*(?:빼|제외|생략)`, "g");

/**
 * Where a clause the reader may claim begins.
 *
 * Sentence punctuation, a newline, and the discourse markers that open a
 * qualification. "다만" and "단" are the two that carry a Korean constraint
 * onto the end of a request, which is exactly the shape this module was written
 * for, and a clause that starts at "다만" reads back to the user as the
 * sentence they wrote rather than the paragraph it sat in.
 *
 * The comma is here for the reason `IMPERATIVE_START` gives next door: Korean
 * lists instructions across commas, so a clause that reaches back over one
 * collects the previous instruction's topic. "보고서는 짧게, 벤더 이름은 빼고"
 * forbids the vendor name, and without the comma this read the ban as being
 * about 보고서 — the subject of the clause before it.
 */
const CLAUSE_START = /[.!?。\n,]|(?:^|\s)(?:다만|단|그리고|그러나|또한|그런데|대신|참고로)\s/g;

/**
 * A locative tail: "결론에", "보고서에는", "요약에".
 *
 * Stripped from the end of a subject because it says where the thing may not
 * go, not what the thing is. "제품명은 결론에" forbids the product name, and a
 * subject of "제품명은 결론" would show the user a constraint about their
 * conclusion.
 */
const LOCATIVE_TAIL = /\s*([\w가-힣]+)에(?:서|는|도|만)?\s*$/;

/**
 * The same phrase in front: "결론에 벤더 제품명 넣지 마세요".
 *
 * Korean puts it on either side of the subject and it means the same thing in
 * both places, so a reader that only stripped the tail returned "결론에 벤더
 * 제품명" — a subject that names the user's conclusion as the forbidden thing.
 * Only stripped when something is left over, because "결론에 넣지 마세요" with
 * no subject at all is a sentence this module should decline rather than
 * answer with an empty string.
 *
 * Same character class as the tail, so "DB에 이 값 넣지 마" is read the same way
 * whichever side the place is written on. A Latin place is not a deliverable,
 * so what this actually buys is that the caller rejects the sentence rather
 * than reading "DB에 이 값" as the forbidden phrase.
 */
const LOCATIVE_HEAD = /^\s*([\w가-힣]+)에(?:서|는|도|만)?\s+/;

/** The subject marker, taken at its last occurrence before the verb. */
const SUBJECT_MARKER = /(?:은|는|을|를|도)(?=\s|$)/g;

/**
 * Trailing politeness and connectives that are not part of what was forbidden.
 *
 * A subject reaches the panel as the user's words, so it must not arrive with
 * "주세요" attached — but it must also not be paraphrased, which is why this
 * only ever trims and never rewrites.
 */
const TRIM = /^[\s,·]+|[\s,·]+$/g;

/** Where the clause containing `index` begins. */
function clauseStart(text: string, index: number): number {
  let start = 0;
  CLAUSE_START.lastIndex = 0;
  for (const match of text.matchAll(CLAUSE_START)) {
    const at = match.index + match[0].length;
    if (at > index) break;
    start = at;
  }
  return start;
}

/** Where the clause containing `index` ends. */
function clauseEnd(text: string, index: number): number {
  const rest = text.slice(index);
  const stop = /[.!?。\n]/.exec(rest);
  return stop === null ? text.length : index + stop.index + 1;
}

/**
 * What the clause says may not appear.
 *
 * The last subject marker before the verb, because Korean puts the topic first
 * and any earlier marker belongs to a different phrase: in "분량은 짧게 하고
 * 벤더 이름은 결론에 넣지 마" the second marker is the one the ban attaches to,
 * and taking the first names the length of the report as the forbidden thing.
 */
function subjectIn(clause: string): { subject: string; place: string | null } | null {
  // The clause ends where the verb begins, so a locative that qualifies the
  // verb is the last thing in it — and it sits *after* the subject marker, not
  // before. "특정 벤더의 제품명은 결론에" marks the subject at 제품명은 and puts
  // 결론에 between that and 넣지, so a reader that looked only at the head
  // dropped the place from exactly the sentence this module was written for.
  const tail = LOCATIVE_TAIL.exec(clause);
  const place = tail?.[1] ?? null;
  const body = tail === null ? clause : clause.slice(0, tail.index);

  let marker = -1;
  SUBJECT_MARKER.lastIndex = 0;
  for (const match of body.matchAll(SUBJECT_MARKER)) marker = match.index;

  // No marker at all — "결론에 벤더 제품명 넣지 마세요". The clause minus its
  // locative is the honest answer: it is the user's words, and a reader that
  // returned nothing here would drop the constraint it had just recognised.
  const head = (marker === -1 ? body : body.slice(0, marker)).replace(TRIM, "");
  if (head.length === 0) return null;

  const lead = LOCATIVE_HEAD.exec(head);
  const withoutLead = head.replace(LOCATIVE_HEAD, "").replace(TRIM, "");
  // Only when something survives. "결론에 넣지 마세요" names no subject, and a
  // reader that stripped its way to an empty string would report that the user
  // forbade nothing at all under a sentence that forbade something.
  if (lead !== null && withoutLead.length > 0) {
    return { subject: withoutLead, place: place ?? lead[1] ?? null };
  }
  return { subject: head, place };
}

/**
 * "don't include X", "do not mention X", "exclude X".
 *
 * The English subject follows the verb rather than preceding it, so it is read
 * forward to the end of the clause instead of backward from the negation.
 */
const ENGLISH = /(?:don'?t|do not|never|please)\s+(?:include|mention|name|list|cite|reference)\s+([^.!?\n]+)/gi;

/**
 * The English locative, which follows rather than precedes: "pricing in the
 * summary", "vendor names from the conclusion".
 *
 * Same cut as `LOCATIVE_HEAD` makes in Korean and for the same reason — the
 * phrase says where, not what — and it matters more here because the subject
 * is about to be handed to `topicParticle`, which would attach a Korean
 * particle to the tail of an English prepositional phrase.
 */
const ENGLISH_LOCATIVE = /\s+(?:in|into|from|within|on|under|throughout)\s+(?:the|our|your|any|my)?\s*[\w\s-]*$/i;

/**
 * Constraints this text places on the answer.
 *
 * `claimedSpans` are the character ranges another reader has already taken —
 * in practice the sentences `prohibitionsIn` recognised as act prohibitions.
 * A sentence is read by one of the two, never both, so "웹 검색은 쓰지 마세요"
 * stays a research ban and does not also become a constraint on the answer.
 */
export function outputProhibitionsIn(
  text: string,
  claimedSpans: ReadonlyArray<{ start: number; end: number }> = [],
): readonly OutputProhibition[] {
  if (text.length === 0) return [];

  const claimed = (at: number): boolean =>
    claimedSpans.some((span) => at >= span.start && at < span.end);

  const out: OutputProhibition[] = [];
  const seen = new Set<number>();

  const take = (
    read: { subject: string; place: string | null } | null,
    start: number,
    end: number,
  ): void => {
    if (read === null || seen.has(start)) return;
    seen.add(start);
    out.push({ subject: read.subject, place: read.place, start, end });
  };

  for (const pattern of [NEGATED_CONTENT, REMOVAL]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const at = match.index;
      if (claimed(at)) continue;
      const start = clauseStart(text, at);
      const end = clauseEnd(text, at + match[0].length);
      const read = subjectIn(text.slice(start, at));
      // `REMOVAL` swallows the deliverable it required, so the clause handed to
      // `subjectIn` no longer contains it. The capture puts it back — the whole
      // reason that branch fires is the noun it matched on, and dropping it
      // produced "경쟁사 이름은 넣지 않는다" for a sentence that said where.
      if (read !== null && match[1] !== undefined) read.place ??= match[1];
      // A named place has to be the thing being produced.
      //
      // 쓰다 and 넣다 mean both "write in the answer" and "write to a file", and
      // nothing in the verb separates them — but the place does. "API Key는
      // 설정 파일에는 쓰지 마" forbids a write to a file, which is the modify
      // gate's business and not this module's, and reading it here produced a
      // constraint on the answer out of an instruction about storage.
      //
      // Silence about the place is *not* treated as a file. "추측은 쓰지 말아
      // 주세요" names nowhere and means the answer, which is the commonest form
      // of the thing this module is for.
      if (read !== null && read.place !== null && !IS_DELIVERABLE.test(read.place)) continue;
      take(read, start, end);
    }
  }

  ENGLISH.lastIndex = 0;
  for (const match of text.matchAll(ENGLISH)) {
    if (claimed(match.index)) continue;
    const start = clauseStart(text, match.index);
    const subject = match[1].replace(ENGLISH_LOCATIVE, "").replace(TRIM, "");
    if (subject.length === 0) continue;
    take({ subject, place: null }, start, clauseEnd(text, match.index));
  }

  return out.sort((a, b) => a.start - b.start);
}

/**
 * `은` or `는` for a Korean word, by whether its last syllable closes.
 *
 * The subject is the user's own noun and it is about to be put in a sentence,
 * so the sentence has to agree with it. Hangul syllables are contiguous from
 * U+AC00 and the final jamo is the remainder mod 28, which is 0 exactly when
 * the syllable has no closing consonant. Anything that is not a Hangul
 * syllable — a Latin product name, a number — takes `은` as the neutral form
 * rather than guessing at how the user would pronounce it.
 */
export function topicParticle(word: string): "은" | "는" {
  const last = word.codePointAt(word.length - 1);
  if (last === undefined || last < 0xac00 || last > 0xd7a3) return "은";
  return (last - 0xac00) % 28 === 0 ? "는" : "은";
}

/**
 * The requirement text for a constraint on the answer.
 *
 * The place is the user's word when they gave one and is simply left out when
 * they did not, rather than being filled in with "결과물". The panel this ends
 * up in is where a user checks whether they were understood, so a sentence that
 * adds a noun they never said is the one failure mode that matters here.
 */
export function outputProhibitionText(subject: string, place: string | null = null): string {
  const where = place === null ? "" : `${place}에 `;
  return `${subject}${topicParticle(subject)} ${where}넣지 않는다`;
}
