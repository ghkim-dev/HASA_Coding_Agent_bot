import type { RequirementProposal } from "./requirementSpec.ts";
import type { SourceSpan } from "./sourceSpan.ts";

/**
 * What became of a model's answer, in enough detail to act on.
 *
 * `readProposals` returned an array. An empty array meant six different things
 * and the metric collapsed all of them into `no_response`, which reads as "the
 * model said nothing" and covered "the model wrote prose", "it wrote an object
 * instead of a list", and "it wrote items with no coordinates". Those are three
 * prompts and one model change apart.
 *
 *     empty_response    nothing came back at all
 *     no_json_array     text, but no array in it
 *     json_parse_error  an array-shaped thing that will not parse
 *     wrong_top_level   parsed, and it is not an array
 *     empty_array       a well-formed answer of no candidates
 *     malformed_item    items present, none with the required fields
 *     forbidden_field   an item claimed authority it does not have
 *     parsed_candidate  survived parsing; the checks come next
 *
 * ## Nothing of the answer is kept
 *
 * Counts and reasons only. A model's reply can echo the user's request and
 * anything else in its context, and a diagnostic file is exactly the place that
 * would outlive the session it belonged to.
 */

export type ParseOutcome =
  | "empty_response"
  | "no_json_array"
  | "json_parse_error"
  | "wrong_top_level"
  | "empty_array"
  | "malformed_item"
  | "forbidden_field"
  | "parsed_candidate";

export interface ParseResult {
  /** The one outcome that describes the answer as a whole. */
  outcome: ParseOutcome;
  proposals: RequirementProposal[];
  /** Per-item outcomes, so a partly-usable answer is not reported as a failure. */
  itemOutcomes: ParseOutcome[];
  /** Items that carried a field the model may not decide. */
  forbiddenFieldItems: number;
  /** Items present in the array, whatever became of them. */
  itemsSeen: number;
}

/** Fields a proposal may not carry. Their presence is an attempt at authority. */
const FORBIDDEN_FIELDS = [
  "confirmed",
  "confidence",
  "derivedBy",
  "status",
  "sourceText",
  "id",
  "executable",
  "supersededBy",
];

function tally(items: readonly ParseOutcome[]): ParseOutcome {
  if (items.includes("parsed_candidate")) return "parsed_candidate";
  if (items.includes("forbidden_field")) return "forbidden_field";
  return items.length === 0 ? "empty_array" : "malformed_item";
}

/**
 * Where a quote sits in the turn, or nowhere this can use.
 *
 * Null for three different situations that all mean the same thing here — the
 * quote does not identify one place in the text: it is absent (the model made
 * it up), it appears twice (it names two places), or there is no text to look
 * in. The caller falls back to the coordinates the model gave.
 *
 * Exactly the check `buildProposerCase` runs when a case is written, which is
 * the point: a quote is safe to trust *because* it can be verified, and the
 * verification already existed.
 */
function locate(quote: string, text: string | undefined): { start: number; end: number } | null {
  if (text === undefined || quote.length === 0) return null;
  const first = text.indexOf(quote);
  if (first === -1) return null;
  if (text.indexOf(quote, first + 1) !== -1) return null;
  return { start: first, end: first + quote.length };
}

/**
 * Reads an answer without losing why it failed.
 *
 * `forbidden_field` items are still emitted as proposals, deliberately. The
 * refusal has to be *recorded* by the checker rather than avoided here — a
 * boundary that quietly drops the attempt is one nobody can audit.
 *
 * ## Why `text` is here
 *
 * So a model can point at its evidence by **quoting** it instead of counting
 * characters to it. Measured across four models on this gateway, ten cases
 * each, `scripts/quoteVsOffset.mjs`:
 *
 *     근거를 어떻게 지목하는가   pointed
 *     좌표만 (예전)             10/64
 *     인용만                    33/64
 *     둘 다, 인용 우선           32/64
 *
 * Two of the four — `ax-3.1` and `qwen2.5-coder-32b` — score **zero** on
 * coordinates and 56%/69% on quotes. They are not bad at the task; they cannot
 * count characters. And `ax-3.1` is what the designer picks by catalogue order.
 *
 * A third read the other way: `exaone-4.0-32b` returns empty arrays when asked
 * for quotes only. So neither format is right for everyone, and the shipped
 * prompt asks for both. This function prefers the quote when it locates one and
 * keeps the model's coordinates when it does not, which is the only arrangement
 * where no model does worse than it did before.
 *
 * `text` stays optional because two callers — the fixtures and the sweep — have
 * always passed the raw answer alone, and a required parameter would make them
 * pass something they do not have.
 */
export function parseProposals(raw: string, turnId: string, text?: string): ParseResult {
  const none = (outcome: ParseOutcome): ParseResult => ({
    outcome,
    proposals: [],
    itemOutcomes: [],
    forbiddenFieldItems: 0,
    itemsSeen: 0,
  });

  if (raw.trim().length === 0) return none("empty_response");

  // The whole answer first, fences removed. Going straight to the brackets
  // reads `{"items": [...]}` as the array inside it and reports a malformed
  // list — when what happened is that the model answered with an object. That
  // is a prompt fix, and mining the brackets hides which one is needed.
  const body = raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

  let parsed: unknown;
  let read = false;
  try {
    parsed = JSON.parse(body);
    read = true;
  } catch {
    // Prose around the array, which is the common case worth recovering from.
  }

  if (!read) {
    const start = body.indexOf("[");
    const end = body.lastIndexOf("]");
    if (start === -1 || end <= start) return none("no_json_array");
    try {
      parsed = JSON.parse(body.slice(start, end + 1));
    } catch {
      return none("json_parse_error");
    }
  }
  if (!Array.isArray(parsed)) return none("wrong_top_level");

  const proposals: RequirementProposal[] = [];
  const itemOutcomes: ParseOutcome[] = [];
  let forbiddenFieldItems = 0;

  for (const item of parsed) {
    if (typeof item !== "object" || item === null) {
      itemOutcomes.push("malformed_item");
      continue;
    }
    const row = item as Record<string, unknown>;
    const reaching = FORBIDDEN_FIELDS.filter((f) => row[f] !== undefined);

    const quote = typeof row["quote"] === "string" ? row["quote"].trim() : null;
    const located = quote === null ? null : locate(quote, text);
    const hasOffsets = typeof row["start"] === "number" && typeof row["end"] === "number";

    // A quote that landed is enough on its own. A model that quotes well and
    // counts badly used to be rejected here for the counting.
    if (typeof row["text"] !== "string" || (located === null && !hasOffsets)) {
      itemOutcomes.push(reaching.length > 0 ? "forbidden_field" : "malformed_item");
      if (reaching.length > 0) forbiddenFieldItems += 1;
      continue;
    }

    // The quote wins when it landed. It is the one of the two that was checked
    // against the text rather than asserted about it.
    const span: SourceSpan =
      located === null
        ? { turnId, start: row["start"] as number, end: row["end"] as number }
        : { turnId, start: located.start, end: located.end };
    proposals.push({
      text: row["text"],
      span,
      ...(quote === null ? {} : { quote }),
      ...(typeof row["kind"] === "string" ? { kind: row["kind"] as never } : {}),
      ...(typeof row["priority"] === "string" ? { priority: row["priority"] as never } : {}),
      ...(typeof row["polarity"] === "string" ? { polarity: row["polarity"] as never } : {}),
      // Forwarded on purpose so `acceptProposals` records `forged_provenance`.
      ...(reaching.length > 0 ? ({ derivedBy: "model_proposal" } as never) : {}),
    });
    if (reaching.length > 0) forbiddenFieldItems += 1;
    itemOutcomes.push(reaching.length > 0 ? "forbidden_field" : "parsed_candidate");
  }

  return {
    outcome: tally(itemOutcomes),
    proposals,
    itemOutcomes,
    forbiddenFieldItems,
    itemsSeen: parsed.length,
  };
}
