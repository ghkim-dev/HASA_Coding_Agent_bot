import type { RequirementSpec } from "./requirementSpec.ts";
import { GENERIC_RULE, type ScenarioBlueprint } from "./scenarioBlueprint.ts";

/**
 * Whether a plan is fit to run, decided before anything runs.
 *
 * The check this exists to replace is a model saying "이 테스트면 충분합니다".
 * That is a claim about a plan by the thing that wrote it, and this codebase
 * has already measured what such claims are worth: a model that overclaims
 * completion in two runs of three will overclaim coverage too.
 *
 * Every finding below is derived from the plan's own structure. Nothing reads
 * prose, nothing asks a model, and a plan that fails does not run — the point
 * of auditing before execution is that eight hours spent on an incomplete plan
 * produces eight hours of data that has to be thrown away, which has happened
 * here once already.
 */

export type FindingCode =
  | "MUST_WITHOUT_SCENARIO"
  | "FORBIDDEN_WITHOUT_SIDE_EFFECT_ORACLE"
  | "FORBIDDEN_WITHOUT_POSITIVE_PAIR"
  | "MODIFY_WITHOUT_REGRESSION"
  | "SOURCE_WITHOUT_PROVENANCE_CHECK"
  | "EXECUTION_WITHOUT_EVIDENCE"
  | "AMBIGUOUS_DECIDED"
  /** The user asked for this act and never said what to do it to. */
  | "TARGET_UNRESOLVED"
  | "SCENARIO_OVERLOADED"
  | "SCENARIO_WITHOUT_REQUIREMENT"
  | "ORACLE_READS_PROSE"
  | "INVENTED_REQUIREMENT"
  /** No design rule covers this requirement; only a generic placeholder exists. */
  | "NO_DESIGN_RULE"
  | "UNSUPPORTED_REQUIREMENT_KIND"
  /** A scenario exists and its oracle decides nothing about the requirement. */
  | "ORACLE_INSUFFICIENT"
  | "SOURCE_SPAN_INVALID"
  | "SEMANTIC_ALIGNMENT_UNKNOWN"
  | "REQUIREMENT_CONFLICT"
  | "UNRESOLVED_CONDITION"
  | "MODEL_MAY_NOT_BE_CALLED";

export interface Finding {
  code: FindingCode;
  /** What it is about — a requirement id, a scenario id. */
  subject: string;
  detail: string;
}

export interface AuditResult {
  ok: boolean;
  findings: Finding[];
  /** Requirements with at least one scenario, over requirements that need one. */
  coverage: { covered: number; needed: number };
}

/** More than this in one scenario and a failure cannot be attributed. */
const MAX_REQUIREMENTS_PER_SCENARIO = 3;

/**
 * An oracle that would judge on wording.
 *
 * Kept as a structural check rather than a warning: an oracle with a text
 * pattern in it passes whichever model writes in the style it was built
 * against, and reports that as the model being good.
 */
function readsProse(scenario: ScenarioBlueprint): boolean {
  const oracle = scenario.oracle as unknown as Record<string, unknown>;
  return Object.entries(oracle).some(([key, value]) => {
    if (value instanceof RegExp) return true;
    if (key === "harnessInvariants") return false;
    // A string field on the oracle is a phrase to match. The declared fields
    // are all lists of tool or evidence names; anything else is prose.
    return typeof value === "string";
  });
}

export function auditCoverage(input: {
  requirements: readonly RequirementSpec[];
  scenarios: readonly ScenarioBlueprint[];
  /** Model ids the plan intends to run on, and which of them may be called. */
  plannedModels?: readonly string[];
  permittedModels?: readonly string[];
}): AuditResult {
  const findings: Finding[] = [];
  const live = input.requirements.filter((r) => r.supersededBy === undefined);
  const byRequirement = new Map<string, ScenarioBlueprint[]>();
  for (const scenario of input.scenarios) {
    for (const id of scenario.requirementIds) {
      byRequirement.set(id, [...(byRequirement.get(id) ?? []), scenario]);
    }
  }

  // Every `must` needs at least one check.
  const needing = live.filter((r) => r.priority === "must");
  for (const spec of needing) {
    if ((byRequirement.get(spec.id) ?? []).length === 0) {
      findings.push({
        code: "MUST_WITHOUT_SCENARIO",
        subject: spec.id,
        detail: `must 요구사항에 시나리오가 없습니다: ${spec.text}`,
      });
    }
  }

  for (const spec of live) {
    const scenarios = byRequirement.get(spec.id) ?? [];

    // The harness's own conditions are covered by `system.v1` and by the
    // invariants every scenario carries. Running the prohibition rules over
    // them produced a second, duplicate pair of repairs beside the user's own —
    // and one of them told the user their request forbade something it did not.
    if (spec.polarity === "forbidden" && spec.status !== "system_added") {
      // A prohibition is verified by zero side effects, not by an assertion.
      if (!scenarios.some((s) => s.oracle.forbiddenTools.length > 0)) {
        findings.push({
          code: "FORBIDDEN_WITHOUT_SIDE_EFFECT_ORACLE",
          subject: spec.id,
          detail: "금지 요구사항에 부작용 0을 검사하는 oracle이 없습니다.",
        });
      }
      // And the other direction, or the plan passes for a harness that refuses
      // everything.
      if (!scenarios.some((s) => s.oracle.requiredTools.length > 0)) {
        findings.push({
          code: "FORBIDDEN_WITHOUT_POSITIVE_PAIR",
          subject: spec.id,
          detail:
            "금지 검증만 있고 정상 허용을 확인하는 시나리오가 없습니다. 전부 거부하는 하네스도 통과합니다.",
        });
      }
    }

    // Intent only. Asking "이 요구사항이 맞습니까?" about a verb the user
    // wrote is asking them to re-authorise their own request; the target is a
    // separate question and gets its own finding below.
    if (spec.intent === "ambiguous" && scenarios.length > 0) {
      const decided = scenarios.some(
        (s) => s.oracle.verifiedCompletion === true || s.oracle.workspaceChanged === true,
      );
      if (decided) {
        findings.push({
          code: "AMBIGUOUS_DECIDED",
          subject: spec.id,
          detail: "모호한 요구사항을 확정된 것처럼 판정하는 시나리오가 있습니다.",
        });
      }
    }

    // The act was asked for and has nothing to act on. Distinct from
    // AMBIGUOUS_DECIDED because the answer is a target, not a yes.
    if (spec.intent === "confirmed" && spec.binding === "unresolved") {
      findings.push({
        code: "TARGET_UNRESOLVED",
        subject: spec.id,
        detail: "요청한 작업은 분명하지만 그 대상이 무엇인지 정해지지 않았습니다.",
      });
    }

    if (spec.kind === "validation" && spec.derivedBy === "runtime_source") {
      if (!scenarios.some((s) => s.oracle.requiredEvidence.includes("web_source"))) {
        findings.push({
          code: "SOURCE_WITHOUT_PROVENANCE_CHECK",
          subject: spec.id,
          detail: "출처 요구사항에 web_source 증거를 요구하는 oracle이 없습니다.",
        });
      }
    }

    // A request to change files needs something that notices the change and
    // something that notices what else changed with it.
    if (spec.polarity === "required" && /수정|고치|추가|구현/.test(spec.text)) {
      if (!scenarios.some((s) => s.category === "regression")) {
        findings.push({
          code: "MODIFY_WITHOUT_REGRESSION",
          subject: spec.id,
          detail: "수정 요구사항에 기존 기능 회귀 시나리오가 없습니다.",
        });
      }
    }

    // A request to run something is verified by an execution record, not by a
    // report of one.
    if (spec.polarity === "required" && /실행|테스트|검증/.test(spec.text)) {
      const evidenced = scenarios.some(
        (s) =>
          s.oracle.requiredEvidence.includes("command_result") ||
          s.oracle.requiredEvidence.includes("test_result"),
      );
      if (!evidenced) {
        findings.push({
          code: "EXECUTION_WITHOUT_EVIDENCE",
          subject: spec.id,
          detail: "실행 요구사항에 실제 실행 증거를 요구하는 oracle이 없습니다.",
        });
      }
    }
  }

  // Design-rule coverage. "A scenario exists" and "the requirement can be
  // verified" are different claims, and the gap between them was written down
  // as a known risk: a generic happy-path attached to everything answers the
  // first for every requirement and the second for none.
  for (const spec of live) {
    const scenarios = byRequirement.get(spec.id) ?? [];
    if (scenarios.length === 0) continue;

    // The presence of a generic placeholder *is* the signal: the designer emits
    // one only when no rule matched. Asking whether some non-generic scenario
    // exists let the always-attached completion check mask a missing rule.
    if (scenarios.some((s) => s.designRuleId === GENERIC_RULE)) {
      findings.push({
        code: "NO_DESIGN_RULE",
        subject: spec.id,
        detail: `generic 시나리오만 있습니다. 이 요구사항 유형(${spec.kind}/${spec.polarity})을 덮은 것으로 표시하지 않습니다.`,
      });
      findings.push({
        code: "UNSUPPORTED_REQUIREMENT_KIND",
        subject: spec.id,
        detail: `설계기가 ${spec.kind}/${spec.polarity} 를 다루는 규칙을 갖고 있지 않습니다.`,
      });
    }

    // An oracle that decides nothing about this requirement is a scenario that
    // runs and answers a different question.
    if (spec.priority === "must" && !scenarios.some((s) => s.oracleCoverage.length > 0)) {
      findings.push({
        code: "ORACLE_INSUFFICIENT",
        subject: spec.id,
        detail: "must 요구사항의 성공을 입증하는 oracle 이 없습니다.",
      });
    }
  }

  // What the runtime could not settle. Reported rather than decided, because
  // deciding it is what a plan must not do on the user's behalf.
  for (const spec of live) {
    if (spec.span === undefined && spec.status !== "system_added") {
      findings.push({
        code: "SOURCE_SPAN_INVALID",
        subject: spec.id,
        detail: "사용자 원문 좌표가 없습니다. 근거를 다시 확인할 수 없습니다.",
      });
    }
    if (spec.alignment?.verdict === "unknown") {
      findings.push({
        code: "SEMANTIC_ALIGNMENT_UNKNOWN",
        subject: spec.id,
        detail: `인용 구절과 요구사항의 대응을 확인할 수 없습니다: ${spec.alignment.detail}`,
      });
    }
    if (spec.conflicts.length > 0) {
      findings.push({
        code: "REQUIREMENT_CONFLICT",
        subject: spec.id,
        detail: `${spec.conflicts.join(", ")} 와(과) 동시에 만족될 수 없습니다. 사용자 확인이 필요합니다.`,
      });
    }
    if (spec.condition !== undefined) {
      findings.push({
        code: "UNRESOLVED_CONDITION",
        subject: spec.id,
        detail: "조건이 확인되기 전에는 무조건 규칙으로 확정할 수 없습니다.",
      });
    }
  }

  const known = new Set(live.map((r) => r.id));
  for (const scenario of input.scenarios) {
    if (scenario.requirementIds.length === 0 && scenario.generatedBy !== "baseline") {
      findings.push({
        code: "SCENARIO_WITHOUT_REQUIREMENT",
        subject: scenario.id,
        detail: "요구사항에 연결되지 않은 시나리오입니다. baseline이면 근거를 표시하십시오.",
      });
    }
    if (scenario.requirementIds.length > MAX_REQUIREMENTS_PER_SCENARIO) {
      findings.push({
        code: "SCENARIO_OVERLOADED",
        subject: scenario.id,
        detail: `요구사항 ${scenario.requirementIds.length}개가 한 시나리오에 묶여 실패 원인을 구분할 수 없습니다.`,
      });
    }
    if (readsProse(scenario)) {
      findings.push({
        code: "ORACLE_READS_PROSE",
        subject: scenario.id,
        detail: "oracle이 문장이나 패턴에 의존합니다. 모델의 표현 방식을 평가하게 됩니다.",
      });
    }
    for (const id of scenario.requirementIds) {
      if (!known.has(id) && !input.requirements.some((r) => r.id === id)) {
        findings.push({
          code: "INVENTED_REQUIREMENT",
          subject: scenario.id,
          detail: `존재하지 않는 요구사항 ${id} 을(를) 참조합니다.`,
        });
      }
    }
  }

  // A plan that intends to call a model this credential may not call is a plan
  // that will spend its first request on a 403.
  if (input.plannedModels !== undefined && input.permittedModels !== undefined) {
    const permitted = new Set(input.permittedModels);
    for (const model of input.plannedModels) {
      if (!permitted.has(model)) {
        findings.push({
          code: "MODEL_MAY_NOT_BE_CALLED",
          subject: model,
          detail: `실행 계획에 호출 권한이 없는 모델이 포함돼 있습니다: ${model}`,
        });
      }
    }
  }

  const covered = needing.filter((r) => (byRequirement.get(r.id) ?? []).length > 0).length;
  return {
    ok: findings.length === 0,
    findings,
    coverage: { covered, needed: needing.length },
  };
}

/** A plan may run only when the audit is clean. Stated as a function, not a habit. */
export function mayExecute(audit: AuditResult): boolean {
  return audit.ok;
}
