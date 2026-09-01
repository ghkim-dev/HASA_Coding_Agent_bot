import type { TurnRelation } from "../agent/turnContract.ts";
import {
  executionReadiness,
  acceptProposals,
  markConflicts,
  mergeRequirements,
  runtimeRequirements,
  systemBaseline,
  type RejectedProposal,
  type RequirementProposal,
  type RequirementSpec,
} from "./requirementSpec.ts";
import { negatedActs } from "./functionalExtract.ts";
import { designScenarios, type ScenarioBlueprint } from "./scenarioBlueprint.ts";
import { auditCoverage, type AuditResult } from "./coverageAudit.ts";
import { closeCoverage, type ClosureResult } from "./coverageClosure.ts";
import type { ParseOutcome, ParseResult } from "./proposalParse.ts";

/**
 * What the design engine makes of a request, without doing any of it.
 *
 * The whole point is that a user can see the plan before anything happens. No
 * file is read or written, no command runs, and the only outbound request is
 * the optional one that asks a model for requirement *candidates* — which are
 * then checked exactly as hard as they would be anywhere else.
 *
 * Deterministic given the same turns and the same proposals. The model half is
 * injected so a test can supply proposals directly and `--offline` can supply
 * none.
 */

export interface PreviewTurn {
  turnId: string;
  text: string;
  relation: TurnRelation;
}

/**
 * Why a turn produced no usable model proposal.
 *
 * One bucket said "the model contributed nothing" and four different problems
 * were inside it, each fixed somewhere else. Separating them is what makes the
 * next two steps — choosing a better model, widening the offline extractor —
 * something other than guessing.
 */
export type ProposalOutcome =
  /** Every parse outcome, kept distinct. See `proposalParse.ts`. */
  | ParseOutcome
  /**
   * The answer claimed authority it does not have, and was refused for that.
   *
   * Its own outcome rather than a coordinate problem. A model that sends
   * `derivedBy`, `status`, `sourceText` or an `id` is not miscounting characters
   * — it is asserting that the runtime already confirmed something, and the two
   * failures have nothing in common but the word "rejected". Aggregating them
   * meant a prompt that leaks authority fields read as a span bug, so every fix
   * anyone reached for was the wrong one.
   */
  | "provenance_rejected"
  /** Parsed, and the coordinates did not survive the span check. */
  | "span_rejected"
  /** Coordinates were fine and the requirement said the opposite of them. */
  | "semantics_rejected"
  /** At least one proposal survived everything. */
  | "accepted"
  /** No model was asked. */
  | "not_asked";

export interface TurnProposalReport {
  turnId: string;
  outcome: ProposalOutcome;
  /** What the parser made of the answer, before any requirement check. */
  parseOutcome: ParseOutcome | "not_asked";
  /** Items present in the model's array, whatever became of them. */
  itemsSeen: number;
  /** Items that claimed authority they do not have. */
  forbiddenFieldItems: number;
  accepted: number;
  rejected: number;
  calls: number;
}

export interface PreviewResult {
  turns: PreviewTurn[];
  /** Everything that stands, including superseded entries kept for the record. */
  requirements: RequirementSpec[];
  /** Model suggestions the runtime refused, with why. */
  rejected: Array<RejectedProposal & { turnId: string }>;
  scenarios: ScenarioBlueprint[];
  /** Before closure. What the plan looked like as designed. */
  initialAudit: AuditResult;
  closure: ClosureResult;
  /** Whether a run could start. Never true while anything is unresolved. */
  executable: boolean;
  /**
   * Whether the runtime may run tools for this request at all.
   *
   * Narrower than `executable` and separate on purpose. `executable` is a verdict
   * about the *plan* — every requirement covered, nothing unresolved.
   * `mayExecute` is the permission a caller reads before proposing an action, and
   * it additionally insists that at least one of the user's own requirements is
   * ready. Without that clause a request holding nothing but the harness's
   * baselines came out ready to run: "고마워." was a plan with no findings, and no
   * findings read as permission.
   */
  mayExecute: boolean;
  /**
   * Tools this plan would run, from the oracles that ask for them.
   *
   * Empty whenever `mayExecute` is false — not as a formality, but because that is
   * the claim: a request with nothing in it has no tool plan, and an empty list is
   * the only honest answer a caller can act on.
   */
  plannedTools: string[];
  /** Where the proposals came from, and what went wrong if anything did. */
  proposals: {
    source: "offline" | "model";
    modelId: string | null;
    calls: number;
    error: string | null;
    /** Per turn, so a failure can be attributed rather than averaged. */
    perTurn: TurnProposalReport[];
  };
}

/**
 * How this turn relates to the last, read from the user's words.
 *
 * Normally the model classifies this and it gets it wrong — the correction
 * fixture was filed as `refine` once in six runs, and the constraints of the
 * turn then never entered the standing contract. Preview reads it itself so the
 * relation shown to the user is one the runtime stands behind.
 *
 * Deliberately coarse. `new_task` is the fallback, which is the reading that
 * keeps the fewest stale requirements standing.
 */
export function relationOf(text: string, isFirst: boolean): TurnRelation {
  if (isFirst) return "new_task";
  if (
    /정정|아니(?:야|요|라)|틀렸|취소할게|그게 아니라|correction|actually,? no/i.test(text) ||
    // "아니, 그게 아니라 …" — the commonest way a Korean speaker opens a
    // correction, and it was not read as one. Anchored to the start and
    // followed by a break, so "아니면 이렇게 해줘" — which is an alternative,
    // not a correction — is untouched.
    /^\s*아니[,\s]/u.test(text) ||
    // The English `아니,`. Anchored and followed by a break for the same reason:
    // "no longer needed" and "no web access" open with the word without
    // correcting anything.
    /^\s*no[,.]/i.test(text) ||
    /^\s*not\s+(?:that|this|quite)\b/i.test(text)
  ) {
    return "correct";
  }
  // "실행하라는 게 아니라 보여달라는 말이야" needs no rule of its own, which is
  // worth writing down because it looks like it should. `아니(?:야|요|라)` above
  // already matches the `아니라` that ends the construction, in every phrasing
  // any of the three corpora contain — a pattern for it was written, measured
  // against all of them, changed nothing, and was deleted. The forms it would
  // add (`아닌데`, `아님`) are speculation until a sentence turns up using one.
  if (/이어서|계속(?:해|하)|아까 하던|continue/i.test(text)) return "continue";
  // `\bhow\b`, not `how\b`. Without the opening boundary the pattern matched the
  // tail of **show**, so every English sentence containing it was filed as a
  // question — and `question` carries what is standing without adding anything,
  // so "just show me the design" contributed no requirement at all. `what\b`
  // did the same to `somewhat`; `which\b` was saved only by `sandwich` ending
  // in `wich`.
  if (/\?|무엇|뭐(?:야|예요|니)|어떻게|왜|알려줄래|\bwhich\b|\bwhat\b|\bhow\b/i.test(text)) {
    return "question";
  }
  if (/추가로|그리고|또한|한 가지 더|also\b|and also/i.test(text)) return "refine";

  // A follow-up starts a new task only when it says so.
  //
  // This used to be the fallback, and the fallback is where the damage was:
  // `new_task` discards everything standing, so any second sentence without a
  // connective silently threw away every requirement the user had already
  // given. Measured against the scenario corpus it was wrong four times out of
  // thirty-one, and all four errors ran that way — "좋은 오픈소스 모델하고 HASA
  // 모델도 추가해줘" and "https://…에 있는 모델도 후보에 넣어줘" both reset the
  // conversation they were adding to. The scenario that pins the first is
  // called "Refine adds without losing", which is what it was written for.
  //
  // The two directions are not symmetric. Carrying a requirement the user has
  // moved on from shows them something stale, which they can see and say so
  // about. Dropping one shows them nothing, and the requirement they stated is
  // simply gone — from the panel, from the plan, and from anything that would
  // have checked the work against it.
  //
  // So the marked case is the one that resets. Every follow-up in all three
  // corpora that a reader called a genuine new task announces itself: "이제
  // 완전히 다른 걸 하자". Nothing here reads a topic change out of the subject
  // matter — that would be the runtime deciding the user had finished.
  if (
    /이제\s*(?:완전히\s*)?다른|다른\s*걸|새로운?\s*(?:작업|일|주제)|그건\s*됐고|잊(?:어|고)/u.test(text) ||
    // The English half. `something completely different` is how a person
    // actually says it; `different task` alone matched nothing anybody writes.
    /forget\s+(?:that|it)|new\s+task|different\s+task|something\s+(?:completely\s+|entirely\s+)?(?:different|else)|move\s+on\s+to|instead,?\s+let'?s/i.test(
      text,
    )
  ) {
    return "new_task";
  }
  return "refine";
}

/** Asks a model for candidates. Injected so offline and tests supply their own. */
export type Proposer = (input: {
  turnId: string;
  text: string;
  signal?: AbortSignal;
}) => Promise<{
  proposals: RequirementProposal[];
  modelId: string | null;
  calls: number;
  /**
   * What the parser found. Supplied by the proposer because only it sees the
   * answer — and required, so an outcome cannot be invented downstream from a
   * proposal count.
   */
  parse: ParseResult;
}>;

export async function previewDesign(input: {
  turns: readonly string[];
  propose?: Proposer;
  signal?: AbortSignal;
}): Promise<PreviewResult> {
  const turns: PreviewTurn[] = input.turns.map((text, index) => ({
    turnId: `t${index + 1}`,
    text,
    relation: relationOf(text, index === 0),
  }));

  let standing: RequirementSpec[] = [];
  const rejected: PreviewResult["rejected"] = [];
  let modelId: string | null = null;
  let calls = 0;
  let error: string | null = null;
  const perTurn: TurnProposalReport[] = [];

  for (const turn of turns) {
    // What the runtime reads for itself. Never omitted by a model, because no
    // model is involved.
    const incoming: RequirementSpec[] = runtimeRequirements({ turnId: turn.turnId, text: turn.text });

    if (input.propose !== undefined && error === null) {
      try {
        const asked = await input.propose({
          turnId: turn.turnId,
          text: turn.text,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        modelId = asked.modelId;
        calls += asked.calls;
        const { accepted, rejected: refused } = acceptProposals({
          turnId: turn.turnId,
          userText: turn.text,
          proposals: asked.proposals,
        });
        incoming.push(...accepted);
        rejected.push(...refused.map((r) => ({ ...r, turnId: turn.turnId })));
        perTurn.push({
          turnId: turn.turnId,
          outcome: outcomeOf(asked.parse, accepted.length, refused),
          parseOutcome: asked.parse.outcome,
          itemsSeen: asked.parse.itemsSeen,
          forbiddenFieldItems: asked.parse.forbiddenFieldItems,
          accepted: accepted.length,
          rejected: refused.length,
          calls: asked.calls,
        });
      } catch (err) {
        // A model failure is reported, not fatal. The offline analysis is the
        // floor and it is already complete without it.
        error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      }
    }

    standing = mergeRequirements({
      standing,
      incoming,
      relation: turn.relation,
      turnId: turn.turnId,
      // What this turn took back, in the user's own words. Read every turn and
      // used only on a correction, so the reading and the policy stay apart.
      withdrawn: negatedActs({ turnId: turn.turnId, text: turn.text }),
    });
  }

  const withSystem = [...markConflicts(standing), ...systemBaseline(turns[turns.length - 1]?.turnId ?? "t1")];
  const designed = designScenarios(withSystem);
  const initialAudit = auditCoverage({ requirements: withSystem, scenarios: designed });
  const closure = closeCoverage({
    requirements: withSystem,
    scenarios: designed,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  // The user's own, live. `system_added` is the harness talking to itself.
  const ownRequirements = withSystem.filter(
    (spec) => spec.status !== "system_added" && spec.supersededBy === undefined,
  );
  const mayExecute =
    closure.audit.ok && ownRequirements.some((spec) => executionReadiness(spec) === "ready");
  const ownIds = new Set(ownRequirements.map((spec) => spec.id));
  const plannedTools = mayExecute
    ? [
        ...new Set(
          closure.scenarios
            .filter((scenario) => scenario.requirementIds.some((id) => ownIds.has(id)))
            .flatMap((scenario) => scenario.oracle.requiredTools),
        ),
      ].sort()
    : [];

  return {
    turns,
    requirements: withSystem,
    rejected,
    scenarios: closure.scenarios,
    initialAudit,
    closure,
    executable: closure.audit.ok,
    mayExecute,
    plannedTools,
    proposals: {
      source: input.propose === undefined ? "offline" : "model",
      modelId,
      calls,
      error,
      perTurn:
        input.propose === undefined
          ? turns.map((t) => ({
              turnId: t.turnId,
              outcome: "not_asked" as const,
              parseOutcome: "not_asked" as const,
              itemsSeen: 0,
              forbiddenFieldItems: 0,
              accepted: 0,
              rejected: 0,
              calls: 0,
            }))
          : perTurn,
    },
  };
}

/**
 * Which of the ways a turn's proposals failed, or that they did not.
 *
 * Ordered by what the failure *is*, not by where in the pipeline it was caught,
 * because that is what decides the fix. A turn refused for claiming authority is
 * a prompt that leaked fields the model may not send; one refused for its
 * coordinates is a prompt problem about offsets; one refused for meaning is the
 * model reading the request backwards; and nothing coming back at all is none of
 * those. Four fixes, four outcomes.
 *
 * Authority first when a turn produced both. It is the only one of these that is
 * an attempt to be believed rather than a mistake, and `acceptProposals` refuses
 * it before it looks at anything else — so an outcome that named the span
 * problem instead would be describing a check that never ran.
 */
function outcomeOf(
  parse: ParseResult,
  accepted: number,
  refused: readonly RejectedProposal[],
): ProposalOutcome {
  if (accepted > 0) return "accepted";
  // Nothing survived the requirement checks, so the parse outcome is the
  // answer — unless the checks are what rejected it, which is later and more
  // specific.
  if (refused.some((r) => r.reasons.includes("forged_provenance"))) return "provenance_rejected";
  if (refused.some((r) => r.reasons.includes("semantics_reversed"))) return "semantics_rejected";
  if (refused.length > 0) return "span_rejected";
  return parse.outcome;
}
