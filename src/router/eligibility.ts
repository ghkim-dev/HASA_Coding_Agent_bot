import type { ModelProfile } from "./modelProfile.ts";
import type { TaskProfile } from "./taskProfile.ts";

/**
 * Who is allowed to be considered at all.
 *
 * This runs before any score exists, and that ordering is the point. A hard
 * constraint is not a strong preference: a model with a 32k context cannot do a
 * task that needs 128k, and no similarity score should be able to buy its way
 * past that. §31 of the brief states it as a rule — "hard constraint가
 * embedding score에 지면 안 된다" — and the only way to guarantee it is for the
 * filter to run first and for the ranker to receive a list the ineligible are
 * already absent from.
 *
 * Every exclusion is machine-readable and carries what was asked for against
 * what the model has, because "no eligible models" with no reason is the same
 * dead end as an agent that says it could not do something.
 */

export type ExclusionCode =
  | "MODEL_UNAVAILABLE"
  | "CANNOT_CONVERSE"
  /** Deployed to be something other than an agent worker. */
  | "NOT_A_WORKER"
  | "CONTEXT_TOO_SMALL"
  | "TOOL_CALLING_REQUIRED"
  | "PROTOCOL_INCOMPATIBLE"
  | "USER_FORBIDDEN"
  | "NOT_IN_ALLOWLIST";

export interface FilteredModel {
  modelId: string;
  code: ExclusionCode;
  /** One line naming what was required and what the model has. */
  detail: string;
}

/** A claim that was recorded but was not allowed to remove anything. */
export interface EligibilityAdvisory {
  modelId: string;
  detail: string;
}

export interface EligibilityResult {
  eligible: ModelProfile[];
  filteredOut: FilteredModel[];
  /** Kept so a ranking can say what it heard and chose not to act on. */
  advisories: EligibilityAdvisory[];
}

/**
 * Applies the task's hard constraints to a catalogue.
 *
 * Order matters only for which reason is reported when several apply; the
 * outcome does not depend on it. Checks run cheapest-first so the reported
 * reason is the most basic one true of the model — a model that is unavailable
 * is reported as unavailable rather than as having too small a context.
 */
export function filterEligible(
  profiles: readonly ModelProfile[],
  task: TaskProfile,
): EligibilityResult {
  const eligible: ModelProfile[] = [];
  const filteredOut: FilteredModel[] = [];
  const advisories: EligibilityAdvisory[] = [];
  const constraints = task.constraints;

  const forbidden = new Set(constraints.forbiddenModels ?? []);
  const allowed = constraints.allowedModels;

  for (const profile of profiles) {
    const exclude = (code: ExclusionCode, detail: string): void => {
      filteredOut.push({ modelId: profile.modelId, code, detail });
    };

    if (forbidden.has(profile.modelId)) {
      exclude("USER_FORBIDDEN", "이 대화에서 사용하지 않기로 한 모델입니다.");
      continue;
    }
    if (allowed !== undefined && !allowed.includes(profile.modelId)) {
      exclude("NOT_IN_ALLOWLIST", `허용된 모델 목록에 없습니다: ${allowed.join(", ")}`);
      continue;
    }
    if (!profile.availability.available) {
      exclude("MODEL_UNAVAILABLE", "게이트웨이가 사용할 수 없는 상태로 보고했습니다.");
      continue;
    }
    // No protocol at all means the loop cannot be driven by it — an embedding
    // or reranking endpoint. Distinct from "cannot call tools natively", which
    // the text protocol handles and which is not a disqualification.
    if (profile.availability.protocol === null) {
      exclude("CANNOT_CONVERSE", "대화를 주고받을 수 없는 모델입니다.");
      continue;
    }

    // Being able to answer is not the same as being for this.
    //
    // The capability probe measures whether a model holds a conversation and
    // calls a tool, and a safety classifier does both — so it arrives here
    // looking like a candidate. Leaving it in and hoping a low similarity score
    // pushes it down would be using a 0.15 term to correct a candidate list,
    // against a 0.40 capability term that would happily rate it well.
    //
    // Two conditions, and both are needed. There has to be a claim that this
    // model is out of this pool, *and* the claim has to rest on something that
    // may exclude — a measurement or the provider's own documentation. An
    // assertion is recorded and reported and removes nothing, which is what
    // keeps "nobody reviewed this" from becoming a licence to drop models.
    const use = profile.intendedUse;
    if (use !== undefined && use.poolExclusionReason !== null) {
      if (use.routingEffect === "hard_exclude") {
        exclude(
          "NOT_A_WORKER",
          `${use.poolExclusionReason} (근거 ${use.evidenceStatus}${
            use.verifiedAt === undefined ? "" : `, ${use.verifiedAt} 확인`
          })`,
        );
        continue;
      }
      // Advisory: the model stays, and the claim is on the record.
      advisories.push({
        modelId: profile.modelId,
        detail: `${use.poolExclusionReason} — 다만 근거가 ${use.evidenceStatus} 뿐이라 후보에서 빼지 않았습니다.`,
      });
    }

    const required = constraints.requiredProtocol;
    if (required !== undefined && required.length > 0) {
      if (!required.includes(profile.availability.protocol)) {
        exclude(
          "PROTOCOL_INCOMPATIBLE",
          `${required.join(" 또는 ")} 프로토콜이 필요한데 이 모델은 ${profile.availability.protocol} 입니다.`,
        );
        continue;
      }
      if (required.length === 1 && required[0] === "native" && !profile.availability.supportsNativeTools) {
        exclude("TOOL_CALLING_REQUIRED", "네이티브 도구 호출이 필요한데 이 모델은 지원이 확인되지 않았습니다.");
        continue;
      }
    }

    const minimum = constraints.minContextWindow;
    if (minimum !== undefined) {
      const window = profile.availability.contextWindow;
      // An unknown context window is not treated as too small. Excluding a
      // model because the catalogue was silent would drop candidates for a
      // fact nobody measured — the same rule Auto already applies to an
      // unmeasured capability.
      if (window !== null && window < minimum) {
        exclude(
          "CONTEXT_TOO_SMALL",
          `${minimum.toLocaleString()} 토큰이 필요한데 이 모델은 ${window.toLocaleString()} 입니다.`,
        );
        continue;
      }
    }

    eligible.push(profile);
  }

  return { eligible, filteredOut, advisories };
}

/**
 * Whether a task's constraints leave a model able to do the work at all.
 *
 * Separate from `filterEligible` because it is a different question: this asks
 * whether the *task* is coherent, not whether a model qualifies. A turn that
 * forbids both executing and modifying still needs a model — one that reads and
 * explains — so nothing is excluded for it. Kept as a named function so the
 * distinction is visible rather than implied by its absence.
 */
export function requiresWriteCapableModel(task: TaskProfile): boolean {
  if (task.constraints.presentOnly === true) return false;
  if (task.constraints.noModify === true && task.constraints.noExecute === true) return false;
  return task.demands.coding >= 0.5 || task.demands.commandExecution >= 0.5;
}
