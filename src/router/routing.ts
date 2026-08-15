import type { WorkerSelectedEvent, SessionEvent } from "../agent/sessionEvents.ts";
import {
  mergeContract,
  reduceContract,
  type TaskContract,
  type TurnContract,
} from "../agent/turnContract.ts";
import type { ModelProfile } from "./modelProfile.ts";
import { projectTaskProfile, type ProjectOptions, type TaskProfile } from "./taskProfile.ts";
import { recommendModel, type ModelRecommendation, type RecommendOptions } from "./recommend.ts";

/**
 * Turning a read request into the model that will answer it, once per turn.
 *
 * Three separable things live here and are kept separable on purpose:
 *
 *   1. deciding whether this turn needs a *new* worker at all
 *   2. running the recommendation when it does
 *   3. writing down what was decided, so a reload does not have to guess
 *
 * The third is the one that is easy to get wrong. A stored decision that gets
 * recomputed on read is not a record, it is a cache — and it answers with
 * today's catalogue rather than the one that was there. The brief's §31 asks
 * for the opposite, and `selectedWorkerFor` reads the event.
 */

/** Bumped when a change would make a stored decision unreproducible. */
export const ROUTER_VERSION = "r3.1";

/**
 * Why a turn is or is not choosing a model.
 *
 * Named rather than boolean because these end up in an event and a person reads
 * them later. "Because the user picked one" and "because the task did not
 * change" are different facts about the same non-decision.
 */
export type RoutingTrigger =
  /** No worker yet. Always recommends. */
  | "first_turn"
  /** The user started something else. */
  | "new_task"
  /** A refinement or correction changed what is eligible. */
  | "eligibility_changed"
  /** The user asked for a different model. */
  | "user_requested"
  /** Same task, same constraints — the worker stays. */
  | "carried"
  /** The user picked the model; the router does not overrule that. */
  | "manual";

export interface WorkerDecision {
  trigger: RoutingTrigger;
  /** Null only when nothing was eligible or bootstrap failed. */
  modelId: string | null;
  origin: WorkerSelectedEvent["selectionOrigin"];
  /** Present when this turn actually ran a recommendation. */
  recommendation?: ModelRecommendation;
  taskProfile?: TaskProfile;
  unavailableReason?: string;
}

// ---------------------------------------------------------------------------
// Reading past decisions
// ---------------------------------------------------------------------------

/**
 * The worker a chain last settled on, from what was written down.
 *
 * Reads the events rather than recomputing, which is the whole point: replaying
 * a decision through today's registry answers a question nobody asked, and the
 * answer would differ from the one the turn actually used. This also gives
 * branch isolation for free — the caller passes the chain's events, and events
 * on another branch are not in it.
 */
export function selectedWorkerFor(
  events: readonly SessionEvent[],
): { modelId: string; origin: WorkerSelectedEvent["selectionOrigin"]; turnId: string } | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type !== "worker_selected") continue;
    if (event.selectedModelId === null) continue;
    return { modelId: event.selectedModelId, origin: event.selectionOrigin, turnId: event.turnId };
  }
  return null;
}

/** Every routing decision on a chain, oldest first. For audit and eval. */
export function routingHistory(events: readonly SessionEvent[]): WorkerSelectedEvent[] {
  return events.filter((e): e is WorkerSelectedEvent => e.type === "worker_selected");
}

// ---------------------------------------------------------------------------
// Whether to choose again
// ---------------------------------------------------------------------------

/**
 * Whether this turn should pick a worker, or keep the one it has.
 *
 * The failure being avoided is oscillation. Scores move a little as evaluation
 * data arrives, and a router that re-ranks every turn will hand turn 1 to A,
 * turn 2 to B and turn 3 back to A — three different models inside one task,
 * each with a different reading of the conversation it inherited.
 *
 * So the default is affinity: the same task keeps the same worker. A change of
 * worker needs a reason that is *about the task*, not about the scores.
 *
 * A correction is deliberately not a trigger on its own. "아니, 실행하지 말고
 * 보여줘" is the same task being clarified, and swapping models mid-correction
 * is how a user gets a different voice answering the message they sent to fix
 * the last one. It becomes a trigger only when it changes what is *eligible* —
 * a new hard constraint — which is a fact about candidacy rather than about
 * ranking.
 */
export function routingTriggerFor(input: {
  currentWorker: string | null;
  previous: TaskContract;
  turn: TurnContract;
  previousProfile?: TaskProfile;
  nextProfile: TaskProfile;
  userRequestedModel?: string | null;
}): RoutingTrigger {
  if (input.userRequestedModel != null) return "manual";
  if (input.currentWorker === null) return "first_turn";
  if (input.turn.relation === "new_task") return "new_task";
  if (input.previousProfile === undefined) return "eligibility_changed";
  return sameHardConstraints(input.previousProfile, input.nextProfile)
    ? "carried"
    : "eligibility_changed";
}

/**
 * Whether two profiles would admit the same candidates.
 *
 * Only the hard set is compared. Demands and priorities move with every
 * refinement and comparing those would make every turn a re-recommendation,
 * which is the thrashing this exists to stop. What matters for candidacy is
 * what the filter reads.
 */
export function sameHardConstraints(a: TaskProfile, b: TaskProfile): boolean {
  const key = (p: TaskProfile): string =>
    JSON.stringify([
      p.constraints.noExecute ?? false,
      p.constraints.noModify ?? false,
      p.constraints.noResearch ?? false,
      p.constraints.presentOnly ?? false,
      p.constraints.minContextWindow ?? null,
      [...(p.constraints.requiredProtocol ?? [])].sort(),
      [...(p.constraints.allowedModels ?? [])].sort(),
      [...(p.constraints.forbiddenModels ?? [])].sort(),
    ]);
  return key(a) === key(b);
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * The profile the task had before this turn, derived rather than remembered.
 *
 * This used to be a field on the host, and being a field is exactly what broke
 * it: the process exits, the field is gone, and the first turn after a reload
 * saw no previous profile and re-recommended — for a task that had not changed
 * and already had a worker.
 *
 * Nothing needed storing. The contract events are persisted, `reduceContract`
 * folds them, and the projection is pure — so the profile a task had is a
 * function of its own history and comes back exactly. A new field in the file
 * would have been a second copy of something already there.
 */
export function previousProfileFrom(
  events: readonly SessionEvent[],
  options: ProjectOptions = {},
): TaskProfile | undefined {
  const contract = reduceContract(events as readonly { type: string; contract?: unknown }[]);
  return contract.lastTurnId === "" ? undefined : projectTaskProfile(contract, options);
}

export interface RouteTurnInput {
  /** The contract this turn produced, from bootstrap or from the worker. */
  turn: TurnContract;
  /** What the task held before this turn. */
  previous: TaskContract;
  /** The worker in use, if any, from `selectedWorkerFor`. */
  currentWorker: string | null;
  /**
   * True when `currentWorker` came from a stored record rather than from a
   * session already running. Only changes what the decision is *called* —
   * `restored` rather than `carried` — because "we never re-chose" and "we read
   * back what was chosen before the process restarted" are different facts and
   * a reader of the history should be able to tell them apart.
   */
  currentWorkerRestored?: boolean;
  previousProfile?: TaskProfile;
  profiles: readonly ModelProfile[];
  /** Set when the user picked a model. The router does not overrule it. */
  userRequestedModel?: string | null;
  project?: ProjectOptions;
  recommend?: RecommendOptions;
}

/**
 * One turn's worker, with the profile and the recommendation that produced it.
 *
 * The manual case returns early and *without* a recommendation, deliberately.
 * Computing one anyway and discarding it would put a "we would have chosen X"
 * into the record beside a user who chose Y, and the next reader would have to
 * work out which one ran.
 */
export async function routeTurn(input: RouteTurnInput): Promise<WorkerDecision> {
  if (input.userRequestedModel != null && input.userRequestedModel.length > 0) {
    return { trigger: "manual", modelId: input.userRequestedModel, origin: "user_manual" };
  }

  const merged = mergeContract(input.previous, input.turn);
  const taskProfile = projectTaskProfile(merged, input.project ?? {});
  const trigger = routingTriggerFor({
    currentWorker: input.currentWorker,
    previous: input.previous,
    turn: input.turn,
    ...(input.previousProfile === undefined ? {} : { previousProfile: input.previousProfile }),
    nextProfile: taskProfile,
  });

  if (trigger === "carried" && input.currentWorker !== null) {
    return {
      trigger,
      modelId: input.currentWorker,
      origin: input.currentWorkerRestored === true ? "restored" : "carried",
      taskProfile,
    };
  }

  const recommendation = await recommendModel(taskProfile, input.profiles, input.recommend ?? {});
  return {
    trigger,
    modelId: recommendation.selected?.modelId ?? null,
    origin: "auto_recommendation",
    recommendation,
    taskProfile,
    ...(recommendation.unavailableReason === undefined
      ? {}
      : { unavailableReason: recommendation.unavailableReason }),
  };
}

// ---------------------------------------------------------------------------
// Writing it down
// ---------------------------------------------------------------------------

/**
 * A short, stable identifier for the profile a decision answered.
 *
 * Not a hash of the whole thing: the parts that decide candidacy and ranking
 * are what a later reader needs to know were the same. Deterministic, because
 * two identical profiles have to produce the same fingerprint for a replay test
 * to mean anything.
 */
export function taskProfileFingerprint(profile: TaskProfile): string {
  const material = JSON.stringify([
    profile.complexity,
    profile.contextDemand,
    Object.entries(profile.demands).sort(([a], [b]) => a.localeCompare(b)),
    Object.entries(profile.constraints).sort(([a], [b]) => a.localeCompare(b)),
  ]);
  // A small, dependency-free digest. Collisions do not lose data — the event
  // carries the decision itself; this only says "the same inputs".
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < material.length; i += 1) {
    const c = material.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `tpf-${h1.toString(36)}${h2.toString(36)}`;
}

export interface RoutingEventInput {
  id: string;
  turnId: string;
  at: number;
  decision: WorkerDecision;
  bootstrapModelId?: string;
  /** Model calls the interpretation spent, kept off the worker's account. */
  bootstrapModelCalls?: number;
  /** A shadow observation, if one was taken. Never read by the router. */
  shadow?: unknown;
}

/**
 * The decision as a `SessionEvent`.
 *
 * Carries the breakdown and the filter reasons and *not* the profiles. A
 * conversation that copied the whole registry into every turn would hold a
 * second copy of something the registry owns, and the two would diverge the
 * first time a model was re-evaluated.
 */
export function routingEvent(input: RoutingEventInput): WorkerSelectedEvent {
  const { decision } = input;
  const recommendation = decision.recommendation;
  return {
    type: "worker_selected",
    id: input.id,
    turnId: input.turnId,
    at: input.at,
    selectionOrigin: decision.origin,
    selectedModelId: decision.modelId,
    routerVersion: ROUTER_VERSION,
    ...(input.bootstrapModelId === undefined ? {} : { bootstrapModelId: input.bootstrapModelId }),
    ...(input.bootstrapModelCalls === undefined
      ? {}
      : { bootstrapModelCalls: input.bootstrapModelCalls }),
    ...(input.shadow === undefined ? {} : { shadow: input.shadow }),
    ...(decision.taskProfile === undefined
      ? {}
      : { taskProfileFingerprint: taskProfileFingerprint(decision.taskProfile) }),
    ...(recommendation === undefined
      ? {}
      : {
          alternatives: recommendation.alternatives.map((a) => ({
            modelId: a.modelId,
            score: a.score,
          })),
          filteredOut: recommendation.filteredOut.map((f) => ({
            modelId: f.modelId,
            code: f.code,
          })),
          reasons: recommendation.reasons.map((r) => r.code),
          routerPolicyId: recommendation.policyId,
          ...(recommendation.selected === null
            ? {}
            : {
                scoreBreakdown: {
                  semantic: recommendation.selected.breakdown.semantic,
                  capability: recommendation.selected.breakdown.capability,
                  evaluation: recommendation.selected.breakdown.evaluation,
                  efficiency: recommendation.selected.breakdown.efficiency,
                  total: recommendation.selected.breakdown.total,
                },
              }),
        }),
    ...(decision.unavailableReason === undefined
      ? {}
      : { unavailableReason: decision.unavailableReason }),
  };
}

/**
 * The event for a turn that never got a profile.
 *
 * A bootstrap failure must not be written down as a completed
 * requirement-aware recommendation. The origin is `fallback` and the reason
 * names what was missing, so a later reader can tell a routed turn from one
 * that went the old way.
 */
export function unroutedEvent(input: {
  id: string;
  turnId: string;
  at: number;
  modelId: string | null;
  reason: string;
  bootstrapModelId?: string;
}): WorkerSelectedEvent {
  return {
    type: "worker_selected",
    id: input.id,
    turnId: input.turnId,
    at: input.at,
    selectionOrigin: "fallback",
    selectedModelId: input.modelId,
    routerVersion: ROUTER_VERSION,
    unavailableReason: input.reason,
    ...(input.bootstrapModelId === undefined ? {} : { bootstrapModelId: input.bootstrapModelId }),
  };
}
