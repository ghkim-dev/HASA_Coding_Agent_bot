import { cosineSimilarity, spaceKey, type EmbeddingSpaceIdentity } from "../router/embedding.ts";
import type { ActionKind } from "./functionalExtract.ts";
import type { RequirementSpec } from "./requirementSpec.ts";

/**
 * What was asked before, what was done about it, and how it went.
 *
 * ## Why this is not the "no vector database" the router already decided
 *
 * `embedding.ts` argues against a vector store and is right about what it is
 * arguing about: thirty model descriptions, scanned in microseconds, where an
 * index saves work that does not exist. This is a different collection. Model
 * descriptions are a fixed handful; **requirements arrive forever**, one or
 * more per turn per user, and the whole point is that the pile grows.
 *
 * That reading matters because the existing comment could easily be taken as
 * "we decided against this", and it is not. Nothing here contradicts it — the
 * search is still a scan, for the same reason, until a measurement says
 * otherwise.
 *
 * ## The condition that makes it a memory rather than an index
 *
 * Every row carries an **outcome**. A table of requirement vectors with no
 * outcome is a search index: it can find a similar past request and has
 * nothing to say about it. What makes the pile worth keeping is that a
 * neighbour can answer *"and how did that go"*.
 *
 * The outcome has to be free, or it will not be collected. So it is taken from
 * two things the runtime already records without anyone being asked:
 *
 *     supersededBy   the user contradicted this requirement in a later turn
 *     provenance     the runtime refused the coordinates it arrived with
 *
 * A user's own correction is ground truth that costs nothing, and it is the
 * strongest signal available: a requirement the user immediately rewrote is one
 * the proposer misread. Nothing here asks anyone to label anything.
 *
 * ## What is stored, and what is refused
 *
 * `sourceText` only — the runtime's own cut from the user's message. Never the
 * model's `text`, which can echo the request and anything else in its context,
 * and which `requirementSpec` already refuses to accept from a proposal. A
 * memory is exactly the place that outlives the session it belonged to, so the
 * rule is stricter here, not looser.
 */

/**
 * How a requirement turned out.
 *
 * Ordered by what they cost: a correction is worse than a refusal, because the
 * refusal was caught by the runtime and the correction was caught by the user.
 */
export type RequirementOutcome =
  /** The user contradicted it later. The proposer read the request wrongly. */
  | "superseded"
  /** The runtime refused its coordinates — bad span, or forged provenance. */
  | "rejected"
  /** Accepted, and nothing has contradicted it. */
  | "accepted"
  /** Recorded before anything could happen to it. Carries no signal. */
  | "unconfirmed";

/** Worst first, so a fold over neighbours can take the worst known. */
const OUTCOME_RANK: Readonly<Record<RequirementOutcome, number>> = {
  superseded: 3,
  rejected: 2,
  accepted: 1,
  unconfirmed: 0,
};

export interface RememberedRequirement {
  /** The spec's own id — stable across turns, and already unique. */
  id: string;
  turnId: string;
  /** The runtime's cut. Never a model's string. */
  sourceText: string;
  act?: ActionKind;
  /**
   * The words the sentence bound to the verb, absent when it bound none.
   *
   * `string | undefined`, matching `RequirementSpec` — not `string | null`. The
   * corpora write an unbound target as `null` and the spec writes it as an
   * absent field, and a memory that accepted both would have two spellings of
   * one fact and no rule about which arrives.
   */
  target?: string;
  /**
   * Which model proposed it, or null when the deterministic layer read it.
   *
   * The reason the memory can say anything about models at all. A neighbour
   * that went badly is only evidence about a model if we know which one.
   */
  proposedBy: string | null;
  /**
   * The output budget that proposal ran under.
   *
   * Carried because `proposerEvidence` established that a model and its budget
   * are one fact: the same model is first at 6000 tokens and returns nothing at
   * 800. A neighbour recorded without its budget cannot be read as evidence
   * about the model.
   */
  budget: number | null;
  outcome: RequirementOutcome;
  /** Unit vector. Absent when embedding failed — absence is not a zero vector. */
  vector?: readonly number[];
  /** Which space the vector belongs to. Absent exactly when `vector` is. */
  space?: string;
  /** Epoch millis, from the caller's clock. */
  at: number;
}

/**
 * Reads a spec's outcome from what the runtime already recorded.
 *
 * Deliberately has no way to be told the answer. An outcome that a caller can
 * pass in is one a caller can get wrong or flatter, and the whole value of this
 * signal is that nobody chose it.
 */
export function outcomeOf(spec: RequirementSpec): RequirementOutcome {
  if (spec.supersededBy !== undefined) return "superseded";
  if (spec.provenance === "invalid") return "rejected";
  return "accepted";
}

/**
 * Turns this turn's specs into rows.
 *
 * `system_added` specs are skipped: they are the harness's own baselines, not
 * anything the user asked for, and `harnessDesign` already keeps them out of
 * the profile that ranks models for the same reason.
 */
export function remember(input: {
  specs: readonly RequirementSpec[];
  proposedBy: string | null;
  budget: number | null;
  at: number;
  vectors?: ReadonlyMap<string, readonly number[]>;
  space?: EmbeddingSpaceIdentity;
}): RememberedRequirement[] {
  const space = input.space === undefined ? undefined : spaceKey(input.space);
  const rows: RememberedRequirement[] = [];
  for (const spec of input.specs) {
    if (spec.status === "system_added") continue;
    const vector = input.vectors?.get(spec.id);
    rows.push({
      id: spec.id,
      turnId: spec.sourceTurnId,
      sourceText: spec.sourceText,
      ...(spec.act === undefined ? {} : { act: spec.act }),
      ...(spec.target === undefined ? {} : { target: spec.target }),
      proposedBy: input.proposedBy,
      budget: input.budget,
      outcome: outcomeOf(spec),
      // A vector without its space is not usable and not storable: a cosine
      // across two spaces produces a number that looks fine and means nothing.
      ...(vector !== undefined && space !== undefined ? { vector, space } : {}),
      at: input.at,
    });
  }
  return rows;
}

/**
 * A row's outcome, revised by what a later turn established.
 *
 * One-way. `superseded` never returns to `accepted`, because a user who
 * corrected a requirement corrected it — a third turn agreeing with the first
 * does not unmake the correction, it makes a new requirement. Letting the
 * transition run backwards would turn the one signal nobody chose into one that
 * drifts toward whatever was said most recently.
 */
export function revise(
  row: RememberedRequirement,
  outcome: RequirementOutcome,
): RememberedRequirement {
  return OUTCOME_RANK[outcome] > OUTCOME_RANK[row.outcome] ? { ...row, outcome } : row;
}

export interface Neighbour {
  row: RememberedRequirement;
  similarity: number;
}

/**
 * The k most similar past requirements, in the same vector space.
 *
 * Rows in another space are not "less similar", they are **not comparable**,
 * and are dropped rather than scored — the failure this guards is a number that
 * looks like an answer. Rows with no vector are dropped for the same reason and
 * are not thereby forgotten: they are still rows, and `outcomesFor` counts what
 * it was given.
 */
export function nearest(input: {
  vector: readonly number[];
  space: EmbeddingSpaceIdentity;
  rows: readonly RememberedRequirement[];
  k: number;
}): Neighbour[] {
  const space = spaceKey(input.space);
  const scored: Neighbour[] = [];
  for (const row of input.rows) {
    if (row.vector === undefined || row.space !== space) continue;
    // `cosineSimilarity` returns null on a length mismatch rather than throwing
    // or coercing, which is the second half of the same-space check: a stored
    // dimension can disagree with the live one when a backend is redeployed.
    const similarity = cosineSimilarity(input.vector, row.vector);
    if (similarity === null) continue;
    scored.push({ row, similarity });
  }
  return scored
    .sort((a, b) => b.similarity - a.similarity || a.row.id.localeCompare(b.row.id))
    .slice(0, Math.max(0, input.k));
}

/**
 * What a set of neighbours says about a model, if anything.
 *
 * `null` rather than a default when nothing is known, and "nothing is known"
 * has two shapes that a single number would merge: no neighbours at all, and
 * neighbours that were all recorded before anything happened to them. Both mean
 * the memory has no opinion, and a caller that shows an opinion here is showing
 * one nobody formed.
 */
export interface MemoryVerdict {
  modelId: string;
  budget: number | null;
  /** Neighbours proposed by this model at this budget. */
  seen: number;
  /** Of those, how many the user later corrected. */
  superseded: number;
  /** Of those, how many the runtime refused. */
  rejected: number;
  /** Null when `seen` is zero or every neighbour is `unconfirmed`. */
  rate: number | null;
}

export function verdictFor(
  neighbours: readonly Neighbour[],
  modelId: string,
  budget: number | null,
): MemoryVerdict {
  const mine = neighbours.filter(
    (n) => n.row.proposedBy === modelId && n.row.budget === budget,
  );
  const decided = mine.filter((n) => n.row.outcome !== "unconfirmed");
  const superseded = mine.filter((n) => n.row.outcome === "superseded").length;
  const rejected = mine.filter((n) => n.row.outcome === "rejected").length;
  return {
    modelId,
    budget,
    seen: mine.length,
    superseded,
    rejected,
    rate: decided.length === 0 ? null : (superseded + rejected) / decided.length,
  };
}
