import type { TurnRelation } from "../agent/turnContract.ts";
import {
  acceptProposals,
  markConflicts,
  mergeRequirements,
  runtimeRequirements,
  systemBaseline,
  type RejectedProposal,
  type RequirementProposal,
  type RequirementSpec,
} from "./requirementSpec.ts";
import { designScenarios, type ScenarioBlueprint } from "./scenarioBlueprint.ts";
import { auditCoverage, type AuditResult } from "./coverageAudit.ts";
import { closeCoverage, type ClosureResult } from "./coverageClosure.ts";

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
  /** The model answered with nothing parseable as a list. */
  | "no_response"
  /** A list came back and no item had the required shape. */
  | "malformed"
  /** Items had shape and their coordinates did not survive the span check. */
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
  /** Items the model returned, before any check. */
  returned: number;
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
  if (/정정|아니(?:야|요|라)|틀렸|취소할게|그게 아니라|correction|actually,? no/i.test(text)) return "correct";
  if (/이어서|계속(?:해|하)|아까 하던|continue/i.test(text)) return "continue";
  if (/\?|무엇|뭐(?:야|예요|니)|어떻게|왜|알려줄래|which\b|what\b|how\b/i.test(text)) return "question";
  if (/추가로|그리고|또한|한 가지 더|also\b|and also/i.test(text)) return "refine";
  return "new_task";
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
  /** Items the model returned before any of them were checked. */
  returned?: number;
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
          outcome: outcomeOf(asked.returned ?? asked.proposals.length, accepted.length, refused),
          returned: asked.returned ?? asked.proposals.length,
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

  return {
    turns,
    requirements: withSystem,
    rejected,
    scenarios: closure.scenarios,
    initialAudit,
    closure,
    executable: closure.audit.ok,
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
              returned: 0,
              accepted: 0,
              rejected: 0,
              calls: 0,
            }))
          : perTurn,
    },
  };
}

/**
 * Which of the four ways a turn's proposals failed, or that they did not.
 *
 * Ordered by where the failure happened, earliest first, because that is where
 * the fix goes. A turn whose items were refused for their coordinates is a
 * prompt problem; one refused for meaning is the model reading the request
 * backwards; and nothing coming back at all is neither.
 */
function outcomeOf(
  returned: number,
  accepted: number,
  refused: readonly RejectedProposal[],
): ProposalOutcome {
  if (accepted > 0) return "accepted";
  if (returned === 0) return "no_response";
  if (refused.length === 0) return "malformed";
  if (refused.some((r) => r.reasons.includes("semantics_reversed"))) return "semantics_rejected";
  return "span_rejected";
}
