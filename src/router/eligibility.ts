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

export interface EligibilityResult {
  eligible: ModelProfile[];
  filteredOut: FilteredModel[];
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

  return { eligible, filteredOut };
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
