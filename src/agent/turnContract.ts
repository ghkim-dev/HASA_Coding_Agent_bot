import { argText } from "./argValues.ts";
import { prohibitionsIn } from "./statedProhibitions.ts";
/**
 * What the user asked for, fixed into something the runtime owns.
 *
 * The gap this closes was found by reading the previous slice honestly: the
 * runtime kept an accurate record of what happened, but the list of *what was
 * wanted* still came from `update_plan` — the model's own account of how it
 * meant to proceed. So a model that never planned to touch Hugging Face
 * produced a task with no Hugging Face requirement, and the runtime tracked its
 * absence perfectly.
 *
 *   Plan is how. Requirement is what.
 *
 * A plan may be revised, abandoned or wrong. A requirement the user stated is
 * none of the runtime's business to drop.
 *
 * ## Where the boundary is
 *
 * Interpreting Korean prose is not something a runtime can do, and pretending
 * otherwise would mean a wall of keyword matching that is wrong in a different
 * way every week. The model does interpret. What changes is what happens next:
 *
 *     model interpretation
 *          ↓  schema validation
 *     TurnContract          ← from here the runtime owns it
 *          ↓
 *     requirements · constraints · corrections
 *
 * Below that line the model proposes actions and writes prose. It does not get
 * to quietly drop a requirement by planning around it, and it does not get to
 * decide that an instruction not to run anything no longer applies.
 */

/**
 * What the user wants done with this turn.
 *
 * A set rather than one value: "이 코드를 수정하고 테스트도 해줘" is two, and
 * flattening it to one loses whichever came second.
 */
export type TurnIntent =
  /** Talk about it. Answering may need no tool at all. */
  | "discuss"
  /** Look at the code and report what is there. */
  | "inspect"
  /** Put something in front of the user — the file, the output, the diff. */
  | "present"
  /** Change files. */
  | "modify"
  /** Run something. */
  | "execute"
  /** Run something *in order to find out whether it works*. */
  | "verify"
  /** Go and read outside the workspace. */
  | "research"
  /** Carry on with what was already happening. */
  | "continue";

export const TURN_INTENTS: readonly TurnIntent[] = [
  "discuss",
  "inspect",
  "present",
  "modify",
  "execute",
  "verify",
  "research",
  "continue",
];

/**
 * How this message relates to what came before.
 *
 * `correct` is the one that earns the type. Treated as an ordinary new message,
 * "아니 실행하라는 게 아니라 코드를 보여달라는 말이야" adds a request while the
 * old one stays live, and the agent keeps executing — which is exactly what
 * happened.
 */
export type TurnRelation = "new_task" | "continue" | "refine" | "correct" | "question";

export const TURN_RELATIONS: readonly TurnRelation[] = [
  "new_task",
  "continue",
  "refine",
  "correct",
  "question",
];

/**
 * A prohibition or obligation the user stated in words.
 *
 * Structured rather than left in the prose because prose does not survive
 * context compaction and cannot be enforced. "실행하지 마" is a fact about what
 * this turn may do, and the tool gate reads it.
 */
export type ConstraintKind =
  | "no_execute"
  | "no_modify"
  | "no_research"
  | "must_execute"
  | "present_only"
  | "other";

export interface Constraint {
  kind: ConstraintKind;
  /** The user's own words, so a refusal can quote what it is honouring. */
  text: string;
  sourceTurnId: string;
  /**
   * Recorded, but not enforced and not the user's words.
   *
   * Set when the runtime established that the model wrote this restriction on
   * its own while the user's message asked for the opposite — see
   * `adoptResearchDecision`. Kept in the record rather than deleted: the fact
   * that a model invented a prohibition is evidence, and the panel needs to be
   * able to show it as the model's rather than as the user's.
   *
   * Absent means an ordinary constraint. Nothing infers this; only a decision
   * made against the user's own text sets it.
   */
  quarantined?: true;
}

/** Where a requirement came from, so the runtime can tell one apart from its own. */
export interface Provenance {
  sourceTurnId: string;
  /** `explicit` when the user said it; `inferred` when the model read it in. */
  origin: "explicit" | "inferred";
  /**
   * The user's own words this came from, when the model quoted them.
   *
   * A weak check and worth naming as one: nothing verifies that the quote is
   * faithful, only that it appears in what the user actually typed. That is
   * enough to catch a requirement invented wholesale and attributed to them,
   * and it is not a solution to requirement completeness — a requirement the
   * model never noticed leaves no trace to check.
   */
  sourceText?: string;
}

export type RequirementLifecycle = "active" | "superseded";

/**
 * One thing the user asked for.
 *
 * Distinct from a plan step, and distinct from `RequirementState` in
 * `taskState.ts` — that one carries how far along the work is. This carries
 * what was asked and who asked it.
 */
export interface Requirement {
  id: string;
  description: string;
  /** False for something the agent proposed on its own initiative. */
  required: boolean;
  provenance: Provenance;
  lifecycle: RequirementLifecycle;
  /** The turn that superseded it, when it was. */
  supersededBy?: string;
}

export interface Deliverable {
  id: string;
  description: string;
  provenance: Provenance;
  lifecycle: RequirementLifecycle;
  /** The turn that retired it, when a correction did. */
  supersededBy?: string;
}

export interface TurnContract {
  turnId: string;
  intents: TurnIntent[];
  relation: TurnRelation;
  /** The user's request in one line, as the model understood it. */
  goal: string;
  requirements: Requirement[];
  deliverables: Deliverable[];
  constraints: Constraint[];
  /** What the model could not decide. Present so a caller can ask. */
  ambiguities?: string[];
}

// ---------------------------------------------------------------------------
// Reading one out of what the model sent
// ---------------------------------------------------------------------------

const MAX_ITEMS = 20;
const MAX_TEXT = 200;

function clip(value: unknown, limit = MAX_TEXT): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Splits a newline list the way `parsePlan` does.
 *
 * The text tool protocol writes parameters as tag bodies, where an array has no
 * natural spelling; models also add their own numbering, which would otherwise
 * be rendered as part of the requirement.
 *
 * An actual array is accepted too — see `argText`. It used to become an empty
 * list, so a model that sent `"requirements": ["a", "b"]` had its contract
 * refused for having no requirements, and the whole turn was deferred behind a
 * `TURN_CONTRACT_REQUIRED` it could not satisfy.
 */
function lines(raw: unknown): string[] {
  const text = argText(raw);
  if (text.length === 0) return [];
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_ITEMS)
    .map((line) => clip(line));
}

function intentsFrom(raw: unknown): TurnIntent[] {
  const found = lines(raw)
    .flatMap((line) => line.toLowerCase().split(/[\s,+/]+/))
    .filter((word): word is TurnIntent => (TURN_INTENTS as readonly string[]).includes(word));
  return [...new Set(found)];
}

function relationFrom(raw: unknown): TurnRelation | null {
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (TURN_RELATIONS as readonly string[]).includes(text) ? (text as TurnRelation) : null;
}

const CONSTRAINT_KINDS: readonly ConstraintKind[] = [
  "no_execute",
  "no_modify",
  "no_research",
  "must_execute",
  "present_only",
  "other",
];

/**
 * A constraint that says there is no constraint.
 *
 * Models fill the field rather than leave it out — "없음", "none", "-" — and a
 * panel that draws those as restrictions tells the user they asked for
 * something they did not. Dropped here rather than at the renderer, because a
 * recorded constraint is also read by the tool gate and a no-op has no business
 * in the record either.
 */
const EMPTY_CONSTRAINT = /^(?:없음|없습니다|해당\s*없음|특별히\s*없음|없다|무|none|n\/?a|nothing|-{1,3})[.·]?$/i;

function constraintsFrom(raw: unknown, turnId: string): Constraint[] {
  return lines(raw).filter((line) => !EMPTY_CONSTRAINT.test(line.trim())).map((line) => {
    // `kind: text`, with the kind optional. A model that writes only prose
    // still produces a constraint — as `other`, which is recorded and shown but
    // not enforced, because enforcing something nobody classified would be
    // guessing at what to forbid.
    const split = /^([a-z_]+)\s*[:=]\s*(.+)$/i.exec(line);
    const kind = split === null ? null : split[1]!.toLowerCase();
    return {
      kind: (CONSTRAINT_KINDS as readonly string[]).includes(kind ?? "") ? (kind as ConstraintKind) : "other",
      text: split === null ? line : split[2]!.trim(),
      sourceTurnId: turnId,
    };
  });
}

/** Why a contract could not be read, for the model to be told once. */
export interface ContractProblem {
  reason: string;
}

/**
 * Validates what the model sent into a contract, or says why not.
 *
 * The schema boundary the whole design rests on. Above it, prose the model
 * wrote; below it, something the runtime will hold to for the rest of the task.
 * A contract with no goal and no requirements is not a contract — it is a
 * shrug, and accepting it would put an empty requirement set into the record
 * with the authority of a real one.
 */
export function parseTurnContract(
  args: Record<string, unknown>,
  turnId: string,
): { ok: true; contract: TurnContract } | { ok: false; problem: ContractProblem } {
  const goal = clip(args["goal"]);
  const requirementText = lines(args["requirements"]);
  const relation = relationFrom(args["relation"]);
  const intents = intentsFrom(args["intents"]);

  if (goal.length === 0) {
    return { ok: false, problem: { reason: "요청을 한 줄로 요약한 goal이 필요합니다." } };
  }
  if (relation === null) {
    return {
      ok: false,
      problem: { reason: `relation은 ${TURN_RELATIONS.join(", ")} 중 하나여야 합니다.` },
    };
  }
  if (intents.length === 0) {
    return { ok: false, problem: { reason: `intents는 ${TURN_INTENTS.join(", ")} 중에서 고르십시오.` } };
  }
  // `continue` and `question` legitimately add nothing new; everything else
  // that claims to be a request has to say what was requested.
  if (requirementText.length === 0 && relation !== "continue" && relation !== "question") {
    return { ok: false, problem: { reason: "사용자가 요구한 것을 requirements에 한 줄씩 적으십시오." } };
  }

  const provenance: Provenance = { sourceTurnId: turnId, origin: "explicit" };
  return {
    ok: true,
    contract: {
      turnId,
      intents,
      relation,
      goal,
      requirements: requirementText.map((description, i) => ({
        id: `${turnId}-r${i + 1}`,
        description,
        required: true,
        provenance,
        lifecycle: "active",
      })),
      deliverables: lines(args["deliverables"]).map((description, i) => ({
        id: `${turnId}-d${i + 1}`,
        description,
        provenance,
        lifecycle: "active",
      })),
      constraints: constraintsFrom(args["constraints"], turnId),
      ...(lines(args["ambiguities"]).length === 0 ? {} : { ambiguities: lines(args["ambiguities"]) }),
    },
  };
}

// ---------------------------------------------------------------------------
// What the task holds, across turns
// ---------------------------------------------------------------------------

/**
 * Everything the user has asked for in this conversation, still standing.
 *
 * Accumulated rather than replaced. The failure that motivates every rule below
 * is the same one: a later turn quietly losing what an earlier turn asked for.
 */
export interface TaskContract {
  goal: string;
  requirements: Requirement[];
  deliverables: Deliverable[];
  constraints: Constraint[];
  /** The intents of the most recent turn. What the tool gate reads. */
  intents: TurnIntent[];
  relation: TurnRelation;
  lastTurnId: string;
}

export function emptyContract(): TaskContract {
  return {
    goal: "",
    requirements: [],
    deliverables: [],
    constraints: [],
    intents: [],
    relation: "new_task",
    lastTurnId: "",
  };
}

/**
 * Folds a turn's contract into the task's.
 *
 * The algebra, one relation at a time:
 *
 * - `new_task` replaces everything. The user started over and saying so.
 * - `refine` adds. "오픈소스 모델도 추가해줘" must not lose CNN and ViT, which
 *   is the case that made this a merge rather than an assignment.
 * - `correct` supersedes what it contradicts and adds what it asks for.
 *   Superseded rather than deleted: the history stays readable, and a
 *   requirement that was retracted is a different thing from one that never
 *   existed.
 * - `continue` and `question` add nothing. "이어서 해줘" is not a new request,
 *   and inventing requirements from it is how a continuation turns into a
 *   restart.
 *
 * Constraints follow their turn: a prohibition stated for one turn does not
 * silently govern the next, but one stated as a standing rule can be restated.
 */
export function mergeContract(task: TaskContract, turn: TurnContract): TaskContract {
  const next: TaskContract = {
    ...task,
    intents: turn.intents,
    relation: turn.relation,
    lastTurnId: turn.turnId,
    // Constraints are this turn's. Carrying them forever would mean a single
    // "실행하지 마" disables execution for the rest of the conversation.
    constraints: turn.constraints,
  };

  if (turn.relation === "new_task") {
    return {
      ...next,
      goal: turn.goal,
      requirements: turn.requirements,
      deliverables: turn.deliverables,
    };
  }

  if (turn.relation === "continue" || turn.relation === "question") {
    // Deliberately nothing. The goal stays whatever it was — a question about a
    // task is not a new goal for it.
    return next;
  }

  if (turn.relation === "correct") {
    // What the correction contradicts is the *current* turn's work, so the
    // deliverables of the turn being corrected are retired. Requirements from
    // earlier turns stand: correcting how a result should be shown does not
    // retract the request that produced it.
    const supersededDeliverables = task.deliverables.map((d) =>
      d.lifecycle === "active" && d.provenance.sourceTurnId === task.lastTurnId
        ? { ...d, lifecycle: "superseded" as const, supersededBy: turn.turnId }
        : d,
    );
    return {
      ...next,
      goal: turn.goal.length > 0 ? turn.goal : task.goal,
      requirements: addNew(task.requirements, turn.requirements),
      deliverables: [...supersededDeliverables, ...turn.deliverables],
    };
  }

  // refine
  return {
    ...next,
    goal: task.goal.length > 0 ? task.goal : turn.goal,
    requirements: addNew(task.requirements, turn.requirements),
    deliverables: [...task.deliverables, ...turn.deliverables],
  };
}

/** Adds what is not already there, by description rather than by id. */
function addNew<T extends { id: string; description: string }>(existing: T[], incoming: T[]): T[] {
  const seen = new Set(existing.map((r) => r.description.trim().toLowerCase()));
  return [...existing, ...incoming.filter((r) => !seen.has(r.description.trim().toLowerCase()))];
}

/** Requirements still standing. Superseded ones are kept but do not count. */
export function activeRequirements(contract: TaskContract): Requirement[] {
  return contract.requirements.filter((r) => r.lifecycle === "active");
}

// ---------------------------------------------------------------------------
// What the plan does and does not cover
// ---------------------------------------------------------------------------

/** A requirement no plan step appears to address. */
export interface CoverageGap {
  requirementId: string;
  description: string;
}

/**
 * Requirements the plan does not mention.
 *
 * Reported, never acted on. The temptation is to drop what the plan omits —
 * that is precisely the bug this layer exists to prevent, and it is how "Hugging
 * Face와 HASA도 활용" vanished from a task that had been given it.
 *
 * The matching is a word overlap and is meant to be loose. A false "covered" is
 * a missed warning; a false "not covered" is a warning the model can dismiss in
 * a sentence. The second is the cheaper mistake.
 */
export function planCoverage(contract: TaskContract, planSteps: readonly string[]): CoverageGap[] {
  const planText = planSteps.join(" ").toLowerCase();
  const planWords = planSteps.flatMap((step) => significantWords(step));
  const gaps: CoverageGap[] = [];

  for (const requirement of activeRequirements(contract)) {
    if (!requirement.required) continue;
    const words = significantWords(requirement.description);
    if (words.length === 0) continue;

    const hit = words.some(
      (word) =>
        planText.includes(word) ||
        // A Korean requirement and a Korean plan step rarely share a whole
        // token: "웹에서 내용 보충" against "웹 검색으로 보충" agrees on the
        // stem and differs by a particle. Matching stems in both directions
        // catches that without a morphological analyser.
        planWords.some((step) => step.startsWith(word) || word.startsWith(step)),
    );
    if (!hit) gaps.push({ requirementId: requirement.id, description: requirement.description });
  }
  return gaps;
}

/**
 * Words worth matching on.
 *
 * Two characters is the floor for CJK and three for everything else, because
 * they carry different amounts per character: "학습" and "추론" are whole
 * concepts, while a two-letter Latin token is almost always a preposition.
 * Getting this wrong in the Korean direction is what let a real requirement —
 * "웹에서 내용 보충" — read as covered by nothing.
 */
export function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}._-]+/u)
    .filter((word) => (/[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(word) ? word.length >= 2 : word.length >= 3))
    .slice(0, 8);
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * Reads a contract back out of an event.
 *
 * Validated again on the way in. A conversation file can be edited, restored
 * from a backup or written by a different build, and a contract that arrives
 * malformed must not become an empty one that silently drops requirements —
 * which is the failure this whole layer exists to prevent, arriving by another
 * route.
 */
export function readTurnContract(value: unknown): TurnContract | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;

  const turnId = typeof raw["turnId"] === "string" ? raw["turnId"] : "";
  const relation = relationFrom(raw["relation"]);
  const goal = clip(raw["goal"]);
  if (turnId.length === 0 || relation === null || goal.length === 0) return null;

  const intents = Array.isArray(raw["intents"])
    ? raw["intents"].filter((i): i is TurnIntent => (TURN_INTENTS as readonly string[]).includes(i as string))
    : [];
  if (intents.length === 0) return null;

  return {
    turnId,
    relation,
    goal,
    intents,
    requirements: readItems(raw["requirements"], turnId),
    deliverables: readItems(raw["deliverables"], turnId),
    constraints: readConstraints(raw["constraints"], turnId),
  };
}

function readItems(value: unknown, turnId: string): Requirement[] {
  if (!Array.isArray(value)) return [];
  const out: Requirement[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const description = clip(item["description"]);
    if (description.length === 0) continue;
    const source = typeof item["provenance"] === "object" && item["provenance"] !== null
      ? (item["provenance"] as Record<string, unknown>)
      : {};
    out.push({
      id: typeof item["id"] === "string" ? item["id"] : `${turnId}-r${out.length + 1}`,
      description,
      required: item["required"] !== false,
      provenance: {
        sourceTurnId: typeof source["sourceTurnId"] === "string" ? source["sourceTurnId"] : turnId,
        origin: source["origin"] === "inferred" ? "inferred" : "explicit",
        ...(typeof source["sourceText"] === "string" ? { sourceText: source["sourceText"] } : {}),
      },
      lifecycle: item["lifecycle"] === "superseded" ? "superseded" : "active",
      ...(typeof item["supersededBy"] === "string" ? { supersededBy: item["supersededBy"] } : {}),
    });
  }
  return out;
}

function readConstraints(value: unknown, turnId: string): Constraint[] {
  if (!Array.isArray(value)) return [];
  const out: Constraint[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const text = clip(item["text"]);
    if (text.length === 0) continue;
    const kind = item["kind"];
    out.push({
      kind: (CONSTRAINT_KINDS as readonly string[]).includes(kind as string) ? (kind as ConstraintKind) : "other",
      text,
      sourceTurnId: typeof item["sourceTurnId"] === "string" ? item["sourceTurnId"] : turnId,
      // Carried through the fold, or the quarantine lasts exactly as long as
      // the object that set it. `reduceContract` re-reads every contract event
      // from the record, so a flag this reader dropped was gone by the next
      // `restoreContract` — and the hallucinated ban the runtime had just
      // disarmed came back enforced, on the host path, every time.
      ...(item["quarantined"] === true ? { quarantined: true as const } : {}),
    });
  }
  return out;
}

/**
 * The task's contract, folded out of the conversation's events.
 *
 * The invariant this exists for:
 *
 *   reduceContract(events) === reduceContract(readBack(write(events)))
 *
 * Live and replayed are the same computation over the same inputs, so there is
 * nothing to keep in step. A reload, a timeout, a branch — each is a different
 * set of events through one function.
 */
export function reduceContract(events: readonly { type: string; contract?: unknown }[]): TaskContract {
  let task = emptyContract();
  for (const event of events) {
    if (event.type !== "turn_contract") continue;
    const contract = readTurnContract(event.contract);
    if (contract !== null) task = mergeContract(task, contract);
  }
  return task;
}

/**
 * Whether an explicit requirement's quote is really in what the user typed.
 *
 * Reported, not enforced. A model that paraphrases rather than quotes is being
 * unhelpful, not dishonest, and refusing the contract over it would trade a
 * whole requirement set for a formatting preference.
 */
export function unverifiedProvenance(
  contract: TurnContract,
  rawUserText: string,
): Requirement[] {
  const haystack = rawUserText.toLowerCase();
  return contract.requirements.filter(
    (r) =>
      r.provenance.origin === "explicit" &&
      r.provenance.sourceText !== undefined &&
      !haystack.includes(r.provenance.sourceText.toLowerCase().trim()),
  );
}


// ---------------------------------------------------------------------------
// Who is allowed to say the user forbade something
// ---------------------------------------------------------------------------

/**
 * A contract that forbids what the same turn asks for.
 *
 * The first version of this deleted the constraint, and that was a worse defect
 * than the one it fixed. The reasoning went: the user asked for the web, a
 * `no_research` appeared beside it, so the ban must be the model's invention.
 * But *both halves are the model's transcription*, and the goal is the half a
 * model writes most freely. So a hallucinated research goal could erase a
 * prohibition the user had actually typed — the runtime going online for
 * someone who had written "웹검색하지 마".
 *
 *   A model-authored goal, requirement, constraint or internal state may not
 *   release a prohibition the user stated in their own words.
 *
 * The authority is therefore the user's own message and nothing else, read by
 * the runtime through `statedProhibitions` — the same deny-only second opinion
 * the execute and modify classes already use. The model's goal is not consulted
 * here at all. What the model wrote can only ever be *quarantined*, and only
 * when the user's own sentence positively asks for the web.
 *
 * Five verdicts, because the honest answer is not binary:
 *
 *   none                 nothing forbids research; nothing to decide
 *   user_forbids         the user said so, so it stands whatever the goal claims
 *   model_only           the user asked for the web and forbade nothing, so the
 *                        ban is the model's alone and is quarantined
 *   needs_clarification  the user's own message says both, so nothing runs
 *   unresolved           the user's message says neither, so fail closed
 *
 * Only `none` and `model_only` let a web tool run. Every other verdict keeps
 * them shut, which is the direction a mistake here has to fail in.
 */
export type ResearchVerdict =
  | "none"
  | "user_forbids"
  | "model_only"
  | "needs_clarification"
  | "unresolved";

export interface ResearchDecision {
  verdict: ResearchVerdict;
  /** The research-banning constraints this decision is about. */
  constraints: Constraint[];
  /** Why the runtime believes the user forbade it, when it does. */
  forbiddenBy?: string;
  /** The user's own words that ask for the web, when they do. */
  demandedBy?: string;
}

/** Whether a web tool may run under this decision. Deny-biased by construction. */
export function researchAllowed(decision: ResearchDecision): boolean {
  return decision.verdict === "none" || decision.verdict === "model_only";
}

/**
 * Words that ask for the web.
 *
 * Read from the **user's** message only. It used to be read from the model's
 * goal and requirements as well, which is precisely how a hallucinated goal
 * came to outrank a real prohibition.
 */
const RESEARCH_DEMAND =
  /웹\s*검색|웹서치|인터넷\s*(?:검색|조사)|(?:웹|인터넷|온라인)에서[^.!?\n]{0,24}?(?:찾|검색|확인|조사|알아)|검색을\s*통해|검색해서\s*확인|검색\s*이후|검색으로\s*확인|hugging\s*face|허깅\s*페이스|web\s*search|search\s+the\s+web|research\s+(?:this\s+)?online|browse\s+the\s+web|look\s+(?:it\s+)?up\s+online/i;

/**
 * The user's message, split where a prohibition stops and an instruction starts.
 *
 * Sentence ends, and the `-말고` connective that is how Korean joins "do not do
 * X" to "do Y instead". Without the second split, "웹검색하지 말고 저장소에서
 * 찾아줘" is one string in which a *demand* pattern matches the word 웹검색
 * inside the prohibition — which is exactly how a ban came to read as a
 * request for the thing it banned.
 */
function clausesOf(text: string): string[] {
  return text
    .split(/(?<=말고)|(?<=[.!?。])\s+|\n+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

/**
 * The user's own words asking for the web, if any clause does.
 *
 * Per clause, and a clause that forbids research is never also a demand. The
 * whole-text version of this read "웹검색하지 마" as a request for web search,
 * because the demand pattern matched the noun inside the prohibition.
 */
function demandIn(text: string): string | null {
  for (const clause of clausesOf(text)) {
    if (isNegativeClause(clause)) continue;
    const match = RESEARCH_DEMAND.exec(clause);
    if (match !== null) return match[0];
  }
  return null;
}

/**
 * A clause that says *not* to do something, by shape rather than by class.
 *
 * The structural half of the guard, and the one that makes a pattern miss safe
 * again. `demandIn` used to skip a clause only when `prohibitionsIn` recognised
 * a research ban in it — so any phrasing the patterns missed was not merely
 * unrecognised, it was read as a *demand for the thing it forbade*: the web
 * noun sits inside the prohibition, `RESEARCH_DEMAND` matched it, and the
 * user's own ban became the evidence for quarantining itself.
 *
 * These endings are how Korean closes a negative clause, whatever the verb is
 * and whatever class it belongs to. A clause carrying one is never a request.
 */
const NEGATIVE_CLAUSE =
  /(?:지\s*(?:마|말|않)[가-힣]*|말고|말구|대신(?:에)?|없이|금지|빼고|제외하고)\s*[.!?。]*\s*$|(?:면|서는)\s*안\s*(?:돼|되|된|됩)|(?:without|avoid|instead\s+of|do\s+not|don'?t|never)/i;

function isNegativeClause(clause: string): boolean {
  return NEGATIVE_CLAUSE.test(clause.trim());
}

/** Any mention of leaving the machine, for the coarse ban-shape check. */
const MENTIONS_WEB = /웹|인터넷|온라인|허깅\s*페이스|hugging\s*face|web|internet|online/i;

/** A constraint shaped like a research ban — the enforced kind, or bare text. */
const RESEARCH_BAN_TEXT = /^no[_\s-]*research$|검색\s*금지|웹\s*금지|조사\s*금지|research\s*금지/i;

export function forbidsResearch(constraint: Constraint): boolean {
  if (constraint.kind === "no_research") return true;
  return constraint.kind === "other" && RESEARCH_BAN_TEXT.test(constraint.text.trim());
}

/**
 * Whether the user's own message contains this constraint's text.
 *
 * The weak check `unverifiedProvenance` already uses for requirements, weak for
 * the same reason: a model that paraphrases is unhelpful rather than dishonest.
 * Used only to *raise* confidence that a ban is the user's — never to lower it,
 * because a paraphrased prohibition is still a prohibition.
 */
function quotesUser(constraintText: string, userText: string): boolean {
  const needle = constraintText.trim().toLowerCase();
  if (needle.length < 4) return false;
  return userText.toLowerCase().includes(needle);
}

/**
 * Which way this turn's research question resolves.
 *
 * `userForbids` is supplied by the caller rather than computed here, so this
 * module does not depend on `statedProhibitions` and the two cannot drift into
 * two readings of one sentence. Callers pass
 * `prohibitionsIn(userText).has("research")`.
 */
export function decideResearch(
  contract: { constraints: readonly Constraint[] },
  opts: { userText: string },
): ResearchDecision {
  const banning = contract.constraints.filter((c) => forbidsResearch(c));
  if (banning.length === 0) return { verdict: "none", constraints: [] };

  // Three independent signals that the ban is the user's, any of which is
  // enough. A missed pattern must never downgrade a real prohibition, and this
  // is where that principle was broken: the forbid side read the whole text
  // while the demand side read clause by clause, so one polite `?` could kill
  // the forbid signal, leave the demand signal standing, and turn a refusal
  // into an allow that also filed the user's ban as the model's invention.
  //
  // Read per clause, the same way the demand is, so the two cannot disagree
  // about one sentence.
  // Whole text, not per clause. The clause-level scan that briefly sat beside
  // this was provably redundant — `RESEARCH_DIRECT` is unanchored, so a match in
  // any clause is a match in the whole string — and a defence a mutation cannot
  // tell from its absence is not a defence. What per-clause reading is actually
  // for is the *demand* side, where a negative clause must never be read as a
  // request; that lives in `demandIn`.
  const stated = prohibitionsIn(opts.userText).has("research");
  const grounded = banning.some((c) => quotesUser(c.text, opts.userText));
  // The last resort: the user's message contains a negative clause that names
  // the web at all. Deliberately coarse — it only ever adds to `forbids`, and
  // the cost of being wrong is a turn that asks instead of searching.
  const shapedAsBan = clausesOf(opts.userText).some(
    (clause) => isNegativeClause(clause) && MENTIONS_WEB.test(clause),
  );
  const forbids = stated || grounded || shapedAsBan;
  const demandMatch = demandIn(opts.userText);
  const forbiddenBy = stated ? "사용자 원문의 금지 표현" : (banning[0]?.text ?? "");

  if (forbids && demandMatch !== null) {
    return {
      verdict: "needs_clarification",
      constraints: banning,
      forbiddenBy,
      demandedBy: demandMatch,
    };
  }
  if (forbids) return { verdict: "user_forbids", constraints: banning, forbiddenBy };
  if (demandMatch !== null) {
    return { verdict: "model_only", constraints: banning, demandedBy: demandMatch };
  }
  // Neither. The model's contract disagrees with itself and the user's message
  // cannot settle it, so nothing is deleted and nothing goes online.
  return { verdict: "unresolved", constraints: banning };
}

/**
 * Applies the decision to the contract, without ever deleting a constraint.
 *
 * A quarantined constraint stays in the record with `quarantined: true`, so the
 * tool gate stops enforcing it and the panel stops presenting it as the user's
 * words — while the history still shows what the model wrote and what became of
 * it. Deleting it would destroy the evidence that the model invented it, which
 * is exactly what someone auditing this later needs to see.
 */
export function adoptResearchDecision(
  contract: TurnContract,
  opts: { userText: string },
): { contract: TurnContract; decision: ResearchDecision } {
  const decision = decideResearch(contract, opts);
  if (decision.verdict !== "model_only") return { contract, decision };

  const quarantine = new Set(decision.constraints);
  return {
    contract: {
      ...contract,
      constraints: contract.constraints.map((c) =>
        quarantine.has(c) ? { ...c, quarantined: true as const } : c,
      ),
    },
    decision,
  };
}

/** What to tell the user about a research decision. Null when there is nothing to say. */
export function describeResearchDecision(decision: ResearchDecision): string | null {
  switch (decision.verdict) {
    case "none":
    case "user_forbids":
      return null;
    case "model_only":
      return (
        `모델이 기록한 제약(${decision.constraints.map((c) => c.text).join(", ")})은 ` +
        "사용자 원문에서 확인되지 않아 강제하지 않습니다. " +
        `요청에 "${decision.demandedBy}"이(가) 있어 웹 도구는 사용할 수 있습니다.`
      );
    case "needs_clarification":
      return (
        "요청 안에서 웹 사용에 대한 지시가 서로 어긋납니다 — " +
        `금지: ${decision.forbiddenBy}, 요구: "${decision.demandedBy}". ` +
        "어느 쪽인지 알려주실 때까지 웹 도구를 쓰지 않습니다."
      );
    case "unresolved":
      return (
        `모델이 기록한 제약(${decision.constraints.map((c) => c.text).join(", ")})이 ` +
        "요청 내용과 어긋나지만 사용자 원문으로 판정할 수 없어, 안전하게 웹 도구를 쓰지 않습니다."
      );
  }
}
