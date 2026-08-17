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
 * Reads an answer without losing why it failed.
 *
 * `forbidden_field` items are still emitted as proposals, deliberately. The
 * refusal has to be *recorded* by the checker rather than avoided here — a
 * boundary that quietly drops the attempt is one nobody can audit.
 */
export function parseProposals(raw: string, turnId: string): ParseResult {
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

    if (typeof row["text"] !== "string" || typeof row["start"] !== "number" || typeof row["end"] !== "number") {
      itemOutcomes.push(reaching.length > 0 ? "forbidden_field" : "malformed_item");
      if (reaching.length > 0) forbiddenFieldItems += 1;
      continue;
    }

    const span: SourceSpan = { turnId, start: row["start"], end: row["end"] };
    proposals.push({
      text: row["text"],
      span,
      ...(typeof row["quote"] === "string" ? { quote: row["quote"] } : {}),
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
