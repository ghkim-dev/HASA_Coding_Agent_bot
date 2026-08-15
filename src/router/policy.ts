import type { RouterWeights } from "./recommend.ts";

/**
 * How the four terms are weighed, as a named and versioned thing.
 *
 * The weights were constants in `recommend.ts`, which made them look like
 * facts. They are not. `0.40` for capability is a starting policy chosen
 * before any usage data existed, and it is meant to move once there is some.
 *
 * What breaks when a constant moves silently: a recommendation recorded last
 * month cannot be explained. "Why was A chosen then and B now, on the same
 * profile?" has two possible answers — the registry changed, or the policy did
 * — and with an unnamed constant there is no way to tell them apart. Naming the
 * policy and storing its id with the decision makes that a question with an
 * answer.
 */
export interface RouterPolicy {
  /** Stored on every decision. Changing weights means changing this. */
  id: string;
  weights: RouterWeights;
  /** Why these numbers, for whoever changes them next. */
  rationale: string;
}

/**
 * The first policy.
 *
 * Capability heaviest because it is the most direct answer to "can this model
 * do what is being asked". Evaluation next, because what the harness measured
 * is stronger evidence than what a catalogue declares, but it covers fewer
 * models. Semantic and efficiency are deliberately small: semantic is a
 * similarity between two short descriptions and should nudge rather than
 * decide, and efficiency is already scaled by the task's own priorities so a
 * cheap model cannot win heavy work by being cheap.
 */
export const REQUIREMENT_ROUTER_V1: RouterPolicy = {
  id: "requirement-router-v1",
  weights: { semantic: 0.15, capability: 0.4, evaluation: 0.3, efficiency: 0.15 },
  rationale:
    "Capability first as the most direct answer to the request; evaluation second as stronger " +
    "but sparser evidence; semantic and efficiency small so neither can decide alone.",
};

export const DEFAULT_POLICY = REQUIREMENT_ROUTER_V1;

const POLICIES = new Map<string, RouterPolicy>([[REQUIREMENT_ROUTER_V1.id, REQUIREMENT_ROUTER_V1]]);

/**
 * A policy by id, for reading a stored decision back.
 *
 * Returns null for an unknown id rather than falling back to the current one.
 * A decision made under a policy this build does not have is not a decision
 * this build can explain, and answering with today's weights would be a
 * confident wrong account of why a model was chosen.
 */
export function policyById(id: string): RouterPolicy | null {
  return POLICIES.get(id) ?? null;
}

/** Every policy this build knows. */
export function knownPolicies(): readonly RouterPolicy[] {
  return [...POLICIES.values()];
}

/** The weights must be a partition of the score, or the total means nothing. */
export function policyIsWellFormed(policy: RouterPolicy): boolean {
  const { semantic, capability, evaluation, efficiency } = policy.weights;
  const total = semantic + capability + evaluation + efficiency;
  if (Math.abs(total - 1) > 1e-9) return false;
  return [semantic, capability, evaluation, efficiency].every((w) => w >= 0);
}
