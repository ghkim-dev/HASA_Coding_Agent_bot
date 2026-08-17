/**
 * An answer the runtime wrote, in a form a model cannot produce.
 *
 * The distinction this exists for is *provenance*, not wording. The runtime and
 * a model can write the same sentence, and only one of them assembled it from
 * the record — so a check that reads the sentence cannot tell them apart, and
 * one that reads the type cannot fail to.
 *
 * ## Why a type rather than a flag
 *
 * The escape that motivated this was the runtime's own fallback being counted
 * as a false completion claim, twice, for two different reasons:
 *
 *     - 완료: 코드 실행                       ← a section label
 *     - 아직 실행 안 함: 완료 여부 확인 및 보고   ← a *requirement's own text*
 *
 * The first was the runtime's word choice and was fixable by choosing another
 * word. The second is not fixable that way at all: the string is a requirement
 * description, which is the user's or the model's words quoted back, and no
 * vocabulary discipline on this side can stop arbitrary text from containing
 * 완료. A summary that quotes is two different kinds of sentence in one blob,
 * and flattening them to a string is what made them indistinguishable.
 *
 *     verdict   the runtime asserts this        → judge it
 *     quoted    somebody else said this         → do not
 *
 * ## What a model cannot do
 *
 * `RUNTIME_AUTHORED` is a module-private symbol, so no object literal written
 * anywhere else can carry it, and no string a model emits can become one. The
 * boundary is model-versus-runtime: every caller of `composeRuntimeSummary` is
 * runtime code by construction, and a model's output reaches the loop as a
 * `string` that has no way to acquire the brand.
 *
 * The asymmetry is deliberate in the safe direction. An answer that fails to be
 * recognised as runtime-authored is merely validated like a model's, which is
 * the behaviour that existed before. There is no path that turns a model's text
 * into a trusted one.
 */

const RUNTIME_AUTHORED: unique symbol = Symbol("runtime-authored");

/**
 * Text taken from somewhere else and repeated.
 *
 * Requirement descriptions, issue details, file names. The runtime is
 * responsible for having recorded them accurately and not at all for what they
 * say — which is exactly why they are not assertions.
 */
export interface QuotedSection {
  label: string;
  items: readonly string[];
}

export interface RuntimeSummary {
  readonly [RUNTIME_AUTHORED]: true;
  /** Sentences the runtime asserts in its own voice. The only judgeable part. */
  readonly verdict: readonly string[];
  /** What it repeated from elsewhere. Never judged as a claim. */
  readonly quoted: readonly QuotedSection[];
  /** What the user sees. Derived from the two above, never the source of them. */
  readonly text: string;
}

/**
 * The only way to make one.
 *
 * Not because repo code is untrusted — it is all runtime code — but because a
 * single constructor is the thing that makes "was this authored here" a
 * question with an answer rather than a convention.
 */
export function composeRuntimeSummary(input: {
  verdict: readonly string[];
  quoted?: readonly QuotedSection[];
}): RuntimeSummary {
  const quoted = (input.quoted ?? []).filter((section) => section.items.length > 0);
  return {
    [RUNTIME_AUTHORED]: true,
    verdict: [...input.verdict],
    quoted,
    text: render(input.verdict, quoted),
  };
}

/**
 * Renders the two halves so a reader can tell them apart too.
 *
 * The machine separation is the point of the type; this is the same separation
 * for the person reading it. Without the heading, `- 확인됨: 코드 실행` sits in
 * the middle of the runtime's own prose and reads as the runtime saying so.
 */
function render(verdict: readonly string[], quoted: readonly QuotedSection[]): string {
  const lines: string[] = [];
  const [opening, ...rest] = verdict;
  if (opening !== undefined) lines.push(opening);

  if (quoted.length > 0) {
    lines.push("");
    lines.push("기록된 항목 (표현은 요청·계획에 적힌 그대로입니다):");
    for (const section of quoted) lines.push(`- ${section.label}: ${section.items.join(", ")}`);
    lines.push("");
  }

  for (const line of rest) lines.push(line);
  return lines.join("\n");
}

export function isRuntimeSummary(value: unknown): value is RuntimeSummary {
  if (typeof value !== "object" || value === null) return false;
  return (value as Record<PropertyKey, unknown>)[RUNTIME_AUTHORED] === true;
}

/**
 * Where a turn's final answer came from.
 *
 * Set by the loop from which branch produced it, never from anything in the
 * text and never from anything a model supplies.
 */
export type SummarySource = "model" | "runtime";
