import {
  activeRequirements,
  type Constraint,
  type TaskContract,
  type TurnIntent,
} from "../agent/turnContract.ts";

/**
 * What this task needs of a model, projected from what the user asked for.
 *
 * The load-bearing word is *projected*. A `TaskProfile` is not a second reading
 * of the user's message — it is a view of the `TaskContract` that the contract
 * layer already validated. Re-interpreting the prose here would put a second
 * interpreter in the system, and two interpreters of the same sentence are two
 * places for the answer to differ. `turnContract.ts` owns "what was asked";
 * this owns "what that implies about a model", and nothing else.
 *
 * That boundary is why every field below can name the contract element it came
 * from. If it cannot be derived from the contract, it does not belong here.
 *
 * ## Two kinds of information, deliberately not mixed
 *
 * `demands` and `priorities` are scored — more is better, less is worse, and a
 * model weak in one can make up for it elsewhere.
 *
 * `constraints` are not scored at all. "Do not execute" is not a preference
 * that a high enough score can outweigh; it is a filter, applied before any
 * ranking happens. Mixing the two is how a model that cannot satisfy a hard
 * requirement wins on points — see `eligibility.ts`.
 */

/** How much of a capability the task calls for. 0 = irrelevant, 1 = central. */
export type Demand = number;

/**
 * The capabilities a task can ask for.
 *
 * Kept to what the contract can actually justify. There is no `creativity` or
 * `helpfulness` here because no intent or constraint implies one, and a field
 * nothing can fill is a field that gets filled by guessing.
 */
export interface CapabilityDemand {
  coding: Demand;
  debugging: Demand;
  reasoning: Demand;
  architecture: Demand;
  codeReview: Demand;
  toolUse: Demand;
  commandExecution: Demand;
  webResearch: Demand;
  sourceGrounding: Demand;
  instructionFollowing: Demand;
  recovery: Demand;
  multiTurnContinuity: Demand;
}

export const CAPABILITY_KEYS: readonly (keyof CapabilityDemand)[] = [
  "coding",
  "debugging",
  "reasoning",
  "architecture",
  "codeReview",
  "toolUse",
  "commandExecution",
  "webResearch",
  "sourceGrounding",
  "instructionFollowing",
  "recovery",
  "multiTurnContinuity",
];

export type Complexity = "low" | "medium" | "high";
export type ContextDemand = "small" | "medium" | "large";

/**
 * What no score may overrule.
 *
 * Every field is either absent or a fact taken from the contract. There is no
 * "probably" here: a constraint the model did not record is simply not present,
 * and §8 of the brief is explicit that we do not invent one to cover the gap.
 */
export interface HardConstraints {
  noExecute?: boolean;
  noModify?: boolean;
  noResearch?: boolean;
  /** The turn may only show things — the strictest reading of `present_only`. */
  presentOnly?: boolean;
  /** Set by a caller that knows the workspace needs it, not by the projection. */
  minContextWindow?: number;
  requiredProtocol?: Array<"native" | "text">;
  allowedModels?: string[];
  forbiddenModels?: string[];
}

/**
 * How much of the request the extraction is known to have captured.
 *
 * Both fields are optional and **stay absent in production**, because the
 * runtime does not know them. Knowing that a constraint was missed requires
 * knowing what the user actually said, which is the thing the runtime cannot
 * read — that is the whole reason the model does the interpreting.
 *
 * The evaluator is different: a scenario declares its expected requirements, so
 * `src/eval` can fill these in and a router test can ask what happens when the
 * input is known to be incomplete. Populating them anywhere else would be a
 * fabricated confidence, which is worse than no confidence at all.
 *
 * The live meeting-ASR run is the case this exists to record: the same sentence
 * produced a `no_execute` constraint from one model and nothing at all from
 * another. The router's input is only as complete as that extraction.
 */
export interface ExtractionQuality {
  requirementCoverage?: number;
  constraintCoverage?: number;
}

export interface TaskProfile {
  id: string;
  demands: CapabilityDemand;
  /** What the user wants optimised, as opposed to what the work requires. */
  priorities: {
    quality: number;
    speed: number;
    cost: number;
  };
  complexity: Complexity;
  contextDemand: ContextDemand;
  constraints: HardConstraints;
  /**
   * One line describing the task, for a future semantic matcher.
   *
   * Built from the contract's goal and requirements — the words the user's own
   * request was reduced to — never from the raw message. The next slice embeds
   * this; nothing in this one reads it beyond passing it along.
   */
  semanticDescription: string;
  extractionQuality?: ExtractionQuality;
  /** Which contract, and which requirements, this was projected from. */
  provenance: {
    lastTurnId: string;
    requirementIds: string[];
    constraintKinds: string[];
  };
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

function zeroDemand(): CapabilityDemand {
  return {
    coding: 0,
    debugging: 0,
    reasoning: 0,
    architecture: 0,
    codeReview: 0,
    toolUse: 0,
    commandExecution: 0,
    webResearch: 0,
    sourceGrounding: 0,
    instructionFollowing: 0,
    recovery: 0,
    multiTurnContinuity: 0,
  };
}

/**
 * What each intent asks of a model.
 *
 * A table for the same reason `terminationView` is a table: a new intent
 * becomes one row here, and an intent nobody mapped contributes nothing rather
 * than silently inheriting another's demands.
 *
 * The numbers are a starting calibration, not a measurement — they say
 * "modify implies coding matters more than web research", which is a claim
 * about the vocabulary rather than about any model. Tests assert the ordering
 * these produce, never the constants themselves.
 */
const INTENT_DEMAND: Readonly<Record<TurnIntent, Partial<CapabilityDemand>>> = {
  discuss: { reasoning: 0.6, instructionFollowing: 0.4 },
  inspect: { reasoning: 0.7, codeReview: 0.7, architecture: 0.4, toolUse: 0.3 },
  present: { instructionFollowing: 0.8, reasoning: 0.3 },
  modify: { coding: 0.9, toolUse: 0.7, instructionFollowing: 0.5, recovery: 0.4 },
  execute: { commandExecution: 0.9, toolUse: 0.8, recovery: 0.6 },
  verify: { debugging: 0.8, commandExecution: 0.7, toolUse: 0.7, recovery: 0.8 },
  research: { webResearch: 0.9, sourceGrounding: 0.9, toolUse: 0.5 },
  continue: { multiTurnContinuity: 0.9, instructionFollowing: 0.4 },
};

/**
 * What a stated constraint implies about what the model must be good at.
 *
 * A constraint is a filter, and it is *also* evidence about the work: a user
 * who says "do not execute" has told us that following instructions matters
 * more than usual in this turn, because there is now a specific way to fail
 * them. Both readings are kept, in their own fields.
 */
const CONSTRAINT_DEMAND: Readonly<Record<string, Partial<CapabilityDemand>>> = {
  no_execute: { instructionFollowing: 0.9 },
  no_modify: { instructionFollowing: 0.9 },
  no_research: { instructionFollowing: 0.8 },
  present_only: { instructionFollowing: 0.9, reasoning: 0.4 },
  must_execute: { commandExecution: 0.8, toolUse: 0.6 },
};

function raise(into: CapabilityDemand, from: Partial<CapabilityDemand>): void {
  for (const key of CAPABILITY_KEYS) {
    const value = from[key];
    // The strongest claim wins rather than the sum. Two intents that both want
    // coding do not want it twice as much, and adding would let a long intent
    // list saturate every field.
    if (value !== undefined && value > into[key]) into[key] = value;
  }
}

/** Hard constraints, read from the kinds the contract layer classified. */
export function hardConstraintsFrom(constraints: readonly Constraint[]): HardConstraints {
  const out: HardConstraints = {};
  for (const constraint of constraints) {
    // `other` is deliberately absent from every branch: it is prose nobody
    // classified, and enforcing an unclassified constraint means guessing what
    // to forbid. It is recorded in provenance and forbids nothing.
    if (constraint.kind === "no_execute") out.noExecute = true;
    if (constraint.kind === "no_modify") out.noModify = true;
    if (constraint.kind === "no_research") out.noResearch = true;
    if (constraint.kind === "present_only") {
      out.presentOnly = true;
      out.noExecute = true;
      out.noModify = true;
    }
  }
  return out;
}

/**
 * How big the work is.
 *
 * Driven by how much was asked for, not by which intents were named. An intent
 * says what *kind* of work this is and nothing about its size: "README의 오타만
 * 고쳐줘" is `modify`, which implies coding and tool use, and reading that as a
 * heavy task would recommend a large model for a one-line edit — the exact
 * thing §28 forbids.
 *
 * The breadth of demand still escalates, but only when it is broad enough to be
 * evidence on its own, and never past the level the requirement count supports
 * by more than one step.
 */
function complexityOf(requirementCount: number, demands: CapabilityDemand): Complexity {
  const heavy = CAPABILITY_KEYS.filter((k) => demands[k] >= 0.7).length;
  const base: Complexity = requirementCount >= 4 ? "high" : requirementCount >= 2 ? "medium" : "low";
  if (heavy < 5) return base;
  // One request that touches many distinct capabilities at once — analyse and
  // fix and run and check, all in a sentence. Worth one step, not two.
  return base === "low" ? "medium" : "high";
}

function contextOf(complexity: Complexity, requirementCount: number): ContextDemand {
  if (complexity === "high" || requirementCount >= 5) return "large";
  if (complexity === "medium") return "medium";
  return "small";
}

/**
 * What the user wants optimised.
 *
 * Derived from the shape of the work rather than asked for, because no field of
 * the contract says "be fast". A one-requirement task with no execution is
 * where speed and cost are worth preferring; a four-requirement task that has
 * to run things is where they are not, and saying otherwise would recommend a
 * cheap model for work it will fail.
 */
function prioritiesOf(complexity: Complexity): TaskProfile["priorities"] {
  if (complexity === "high") return { quality: 1, speed: 0.2, cost: 0.2 };
  if (complexity === "medium") return { quality: 0.7, speed: 0.5, cost: 0.5 };
  return { quality: 0.4, speed: 0.9, cost: 0.9 };
}

function describe(contract: TaskContract, requirements: readonly { description: string }[]): string {
  const parts = [contract.goal, ...requirements.map((r) => r.description)]
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return parts.join(". ");
}

export interface ProjectOptions {
  /** Set by a caller that knows the workspace is large. Not guessed here. */
  minContextWindow?: number;
  requiredProtocol?: Array<"native" | "text">;
  allowedModels?: string[];
  forbiddenModels?: string[];
  /** Only the evaluator has this. See `ExtractionQuality`. */
  extractionQuality?: ExtractionQuality;
}

/**
 * Projects a validated contract into what it asks of a model.
 *
 * Pure, total and deterministic: the same contract yields the same profile, so
 * a recommendation can be replayed from the events that produced it.
 */
export function projectTaskProfile(
  contract: TaskContract,
  options: ProjectOptions = {},
): TaskProfile {
  const requirements = activeRequirements(contract);
  const demands = zeroDemand();

  for (const intent of contract.intents) raise(demands, INTENT_DEMAND[intent] ?? {});
  for (const constraint of contract.constraints) {
    raise(demands, CONSTRAINT_DEMAND[constraint.kind] ?? {});
  }

  // More separate requirements is more to hold together across a turn, and
  // recovery is what a turn needs when one of several parts fails.
  if (requirements.length >= 3) {
    raise(demands, { recovery: 0.6, multiTurnContinuity: 0.5, instructionFollowing: 0.6 });
  }

  const complexity = complexityOf(requirements.length, demands);
  const constraints: HardConstraints = {
    ...hardConstraintsFrom(contract.constraints),
    ...(options.minContextWindow === undefined ? {} : { minContextWindow: options.minContextWindow }),
    ...(options.requiredProtocol === undefined ? {} : { requiredProtocol: options.requiredProtocol }),
    ...(options.allowedModels === undefined ? {} : { allowedModels: options.allowedModels }),
    ...(options.forbiddenModels === undefined ? {} : { forbiddenModels: options.forbiddenModels }),
  };

  return {
    id: `tp-${contract.lastTurnId || "none"}`,
    demands,
    priorities: prioritiesOf(complexity),
    complexity,
    contextDemand: contextOf(complexity, requirements.length),
    constraints,
    semanticDescription: describe(contract, requirements),
    ...(options.extractionQuality === undefined ? {} : { extractionQuality: options.extractionQuality }),
    provenance: {
      lastTurnId: contract.lastTurnId,
      requirementIds: requirements.map((r) => r.id),
      constraintKinds: contract.constraints.map((c) => c.kind),
    },
  };
}
