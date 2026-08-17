/**
 * Where in the user's message a requirement came from.
 *
 * The previous version took a `sourceText` string from the model and checked it
 * was *somewhere* in the transcript. That is a weaker check than it looks:
 *
 *     사용자 : 실행하지 말고 코드만 분석해줘.
 *     제안   : 실행이 필수 요구사항이다.   sourceText: "실행"
 *
 * "실행" is in the message. It is in the message as the thing being forbidden,
 * and a substring test cannot see the difference. The same shape turns
 * "기존 API 호환성을 유지하면서" into evidence for "기존 API를 제거한다".
 *
 * So the model does not supply the words. It supplies coordinates, and the
 * runtime cuts the text itself. What the model sends back as `quote` is checked
 * against that cut — a mismatch means the model is describing a different span
 * than the one it selected, and there is no reason to guess which it meant.
 *
 * ## Offsets are UTF-16 code units
 *
 * JavaScript string indices, so `text.slice(start, end)` is the definition
 * rather than an approximation of it. Korean syllables are one unit each and
 * emoji outside the BMP are two, which is the case the tests pin — a span that
 * lands mid-surrogate is invalid rather than silently producing a replacement
 * character.
 */

export interface SourceSpan {
  turnId: string;
  /** Inclusive. UTF-16 code units. */
  start: number;
  /** Exclusive. UTF-16 code units. */
  end: number;
}

export type SpanProblem =
  | "out_of_range"
  | "empty"
  | "reversed"
  | "split_surrogate"
  | "quote_mismatch"
  | "wrong_turn"
  | "too_slight"
  | "negation_truncated"
  | "condition_truncated";

export interface SpanCheck {
  ok: boolean;
  /** What the runtime cut, when the coordinates were usable at all. */
  text: string;
  problems: SpanProblem[];
}

/**
 * A span so small it cannot support anything.
 *
 * "실행" on its own names a subject and asserts nothing about it. A `must`
 * requirement resting on two characters is a requirement resting on the
 * model's paraphrase, which is what the coordinates were introduced to avoid.
 */
const MIN_MEANINGFUL = 6;

/** Negations that reverse the clause they sit in. Cutting one inverts it. */
const NEGATION = /(?:하지\s*(?:마|말|않)|않은\s*채|없이|말고|안\s|not\b|don't|without)/;

/** A condition that scopes the clause. Cutting it makes a rule unconditional. */
/**
 * A condition that scopes the clause. Cutting it makes a rule unconditional.
 *
 * `하면서` and `이면서` are excluded: they mean "while doing", not "if". The
 * first version matched `하면` inside `유지하면서` and refused a perfectly good
 * span for being conditional on nothing.
 */
const CONDITION = /(?:라면|이면(?!서)|하면(?!서)|경우|한해|일\s*때|if\b|when\b|unless\b)/;

/**
 * Whether a span, cut from the turn it names, can carry a requirement.
 *
 * `full` is the whole user message for `span.turnId`. Everything here is
 * decided from the two, so the same inputs always give the same answer.
 */
export function checkSpan(input: {
  span: SourceSpan;
  turnId: string;
  full: string;
  /** What the model says it selected. Compared against what was cut. */
  quote?: string;
}): SpanCheck {
  const { span, full } = input;
  const problems: SpanProblem[] = [];

  if (span.turnId !== input.turnId) problems.push("wrong_turn");
  if (!Number.isInteger(span.start) || !Number.isInteger(span.end)) {
    return { ok: false, text: "", problems: [...problems, "out_of_range"] };
  }
  if (span.start < 0 || span.end > full.length) problems.push("out_of_range");
  if (span.end <= span.start) problems.push("reversed");
  if (problems.length > 0) return { ok: false, text: "", problems };

  // A cut through a surrogate pair yields half a character. Rejected rather
  // than repaired: the model meant one of the two boundaries and guessing
  // which is how an offset convention quietly becomes approximate.
  if (isLowSurrogate(full.charCodeAt(span.start)) || isHighSurrogate(full.charCodeAt(span.end - 1))) {
    problems.push("split_surrogate");
  }

  const text = full.slice(span.start, span.end);
  if (text.trim().length === 0) problems.push("empty");
  if (text.trim().length < MIN_MEANINGFUL) problems.push("too_slight");

  if (input.quote !== undefined && normalise(input.quote) !== normalise(text)) {
    problems.push("quote_mismatch");
  }

  // Truncation is about *adjacency*, not about the sentence.
  //
  // The first version flagged any span in a sentence that contained a negation
  // anywhere, which condemned "코드만 설명해줘" for sitting beside
  // "실행하지 말고" — a different clause the negation does not govern. What
  // matters is whether the cut landed just before the negation that would have
  // reversed it:
  //
  //     실행|하지 말고        the cut drops the negation      → truncated
  //     실행하지 말고 |코드만  the negation is not this clause → fine
  const after = full.slice(span.end, span.end + 8);
  if (NEGATION.test(after)) problems.push("negation_truncated");

  // A condition usually precedes what it scopes, so the cut to look at is the
  // one on the left.
  const before = full.slice(Math.max(0, span.start - 10), span.start);
  if (CONDITION.test(before) && !CONDITION.test(text)) problems.push("condition_truncated");

  return { ok: problems.length === 0, text, problems };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The sentence containing an offset, for truncation checks. */
export function sentenceAround(full: string, offset: number): string {
  const before = full.slice(0, offset);
  const start = Math.max(
    before.lastIndexOf("."),
    before.lastIndexOf("!"),
    before.lastIndexOf("?"),
    before.lastIndexOf("\n"),
  );
  const rest = full.slice(offset);
  const stop = rest.search(/[.!?\n]/);
  return full.slice(start + 1, stop === -1 ? full.length : offset + stop + 1).trim();
}

/**
 * Every occurrence of a string, as spans.
 *
 * Offered so a caller that has words rather than coordinates can turn them into
 * coordinates *explicitly*, and see when there is more than one candidate. The
 * previous substring check silently picked the first, which for a word like
 * "실행" appearing twice with opposite senses is a coin toss dressed as
 * provenance.
 */
export function spansOf(full: string, needle: string, turnId: string): SourceSpan[] {
  const out: SourceSpan[] = [];
  if (needle.length === 0) return out;
  let from = 0;
  for (;;) {
    const at = full.indexOf(needle, from);
    if (at === -1) return out;
    out.push({ turnId, start: at, end: at + needle.length });
    from = at + 1;
  }
}
