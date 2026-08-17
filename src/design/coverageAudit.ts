import type { RequirementSpec } from "./requirementSpec.ts";
import type { ScenarioBlueprint } from "./scenarioBlueprint.ts";

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
  | "SCENARIO_OVERLOADED"
  | "SCENARIO_WITHOUT_REQUIREMENT"
  | "ORACLE_READS_PROSE"
  | "INVENTED_REQUIREMENT";

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

    if (spec.polarity === "forbidden") {
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

    if (spec.confidence === "ambiguous" && scenarios.length > 0) {
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
          code: "SCENARIO_WITHOUT_REQUIREMENT",
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
