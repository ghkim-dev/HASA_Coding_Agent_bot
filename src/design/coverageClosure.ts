import type { RequirementSpec } from "./requirementSpec.ts";
import { buildOracle, WRITE_TOOLS, type ScenarioBlueprint } from "./scenarioBlueprint.ts";
import { auditCoverage, type AuditResult, type Finding, type FindingCode } from "./coverageAudit.ts";

/**
 * Fills the gaps an audit can name, and refuses to fill the ones it cannot.
 *
 * Stopping at the first finding is honest and not yet useful: half the findings
 * describe a scenario the designer simply did not think to emit, and adding it
 * is mechanical. The other half describe something only the user can settle,
 * and adding a scenario there would be the plan deciding on their behalf — the
 * failure this whole slice exists to prevent, arriving through the repair path
 * instead of the design path.
 *
 *     EXECUTION_WITHOUT_EVIDENCE     add an evidence oracle
 *     MODIFY_WITHOUT_REGRESSION      add a preservation scenario
 *     FORBIDDEN_WITHOUT_POSITIVE_PAIR   add the allowed direction
 *     SOURCE_WITHOUT_PROVENANCE_CHECK   add attribution
 *
 *     REQUIREMENT_CONFLICT           ask
 *     UNRESOLVED_CONDITION           ask
 *     SEMANTIC_ALIGNMENT_UNKNOWN     ask
 *     AMBIGUOUS_DECIDED              ask
 *     NO_DESIGN_RULE                 a rule has to be written, not generated
 *
 * ## Why it re-audits
 *
 * A repair can produce a finding of its own — an added scenario is a scenario,
 * and it is subject to every structural rule the others are. Closing without
 * re-auditing would mean the plan that runs was never audited in the state it
 * runs in.
 */

/** Findings a scenario can close. Everything else is for a person. */
const REMEDIABLE: ReadonlySet<FindingCode> = new Set<FindingCode>([
  "EXECUTION_WITHOUT_EVIDENCE",
  "MODIFY_WITHOUT_REGRESSION",
  "FORBIDDEN_WITHOUT_POSITIVE_PAIR",
  "FORBIDDEN_WITHOUT_SIDE_EFFECT_ORACLE",
  "SOURCE_WITHOUT_PROVENANCE_CHECK",
]);

export interface ClosurePass {
  pass: number;
  /** Findings the audit produced at the start of this pass. */
  before: Finding[];
  /** Scenario ids added in response, with the finding that caused each. */
  added: Array<{ scenarioId: string; because: FindingCode; subject: string }>;
}

export interface ClosureResult {
  scenarios: ScenarioBlueprint[];
  audit: AuditResult;
  passes: number;
  history: ClosurePass[];
  /** Findings nobody can close without the user. Named, not swallowed. */
  unresolved: Finding[];
  /** Why it stopped. `settled` means nothing remediable was left. */
  stoppedBecause: "settled" | "max_passes" | "no_progress" | "aborted";
}

/** Enough for a repair to expose one more, and not enough to loop. */
const DEFAULT_MAX_PASSES = 4;

export function closeCoverage(input: {
  requirements: readonly RequirementSpec[];
  scenarios: readonly ScenarioBlueprint[];
  maxPasses?: number;
  signal?: AbortSignal;
  plannedModels?: readonly string[];
  permittedModels?: readonly string[];
}): ClosureResult {
  const maxPasses = input.maxPasses ?? DEFAULT_MAX_PASSES;
  const byId = new Map(input.requirements.map((r) => [r.id, r]));
  let scenarios = [...input.scenarios];
  const history: ClosurePass[] = [];
  let stoppedBecause: ClosureResult["stoppedBecause"] = "settled";
  let audit = run(scenarios);

  function run(current: readonly ScenarioBlueprint[]): AuditResult {
    return auditCoverage({
      requirements: input.requirements,
      scenarios: current,
      ...(input.plannedModels === undefined ? {} : { plannedModels: input.plannedModels }),
      ...(input.permittedModels === undefined ? {} : { permittedModels: input.permittedModels }),
    });
  }

  /** Findings already attempted, so the same repair is not made twice. */
  const attempted = new Set<string>();

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    if (input.signal?.aborted === true) {
      stoppedBecause = "aborted";
      break;
    }

    const remediable = audit.findings.filter(
      (f) => REMEDIABLE.has(f.code) && !attempted.has(`${f.code}:${f.subject}`),
    );
    if (remediable.length === 0) {
      // Either everything is closed, or what is left needs a person. Both are
      // "stop", and the difference is in `unresolved`.
      stoppedBecause = audit.findings.some((f) => REMEDIABLE.has(f.code))
        ? "no_progress"
        : "settled";
      break;
    }

    const added: ClosurePass["added"] = [];
    for (const finding of remediable) {
      attempted.add(`${finding.code}:${finding.subject}`);
      const spec = byId.get(finding.subject);
      if (spec === undefined) continue;
      const repair = remedy(finding.code, spec);
      if (repair === null) continue;
      scenarios = [...scenarios, repair];
      added.push({ scenarioId: repair.id, because: finding.code, subject: finding.subject });
    }

    history.push({ pass, before: audit.findings, added });
    if (added.length === 0) {
      stoppedBecause = "no_progress";
      break;
    }

    // Re-audited every pass. A repair is a scenario and is subject to the same
    // structural rules as any other.
    audit = run(scenarios);
    if (pass === maxPasses) stoppedBecause = "max_passes";
  }

  return {
    scenarios,
    audit,
    passes: history.length,
    history,
    unresolved: audit.findings.filter((f) => !REMEDIABLE.has(f.code)),
    stoppedBecause,
  };
}

/** The scenario a nameable gap calls for, or null when there is none. */
function remedy(code: FindingCode, spec: RequirementSpec): ScenarioBlueprint | null {
  const base = {
    requirementIds: [spec.id],
    generatedBy: "requirement_rule" as const,
    unresolvedAspects: [
      ...(spec.intent === "ambiguous" ? ["requirement_is_ambiguous"] : []),
      ...(spec.binding === "unresolved" ? ["requirement_target_unresolved"] : []),
    ],
  };

  switch (code) {
    case "EXECUTION_WITHOUT_EVIDENCE":
      return {
        ...base,
        id: `${spec.id}-evidence`,
        title: "실행은 실행 기록으로 확인된다",
        category: "integration",
        preconditions: "실행 대상이 준비돼 있다.",
        actions: "요청된 명령을 실행한다.",
        expectedEvidence: "command_result 또는 test_result 가 남는다.",
        forbiddenEffects: "실행했다는 보고만 있고 기록이 없는 것",
        oracle: buildOracle({
          requiredTools: ["run_command"],
          requiredEvidence: ["command_result", "test_result"],
        }),
        rationale: "실행 요구사항은 실행 기록으로만 충족된다. 보고는 기록이 아니다.",
        designRuleId: "execution-evidence.v1",
        oracleCoverage: ["execution_evidenced"],
      };

    case "MODIFY_WITHOUT_REGRESSION":
      return {
        ...base,
        id: `${spec.id}-regression`,
        title: "기존 동작이 보존된다",
        category: "regression",
        preconditions: "수정 전 기존 테스트가 통과한다.",
        actions: "요청된 수정을 하고 기존 테스트를 다시 돌린다.",
        expectedEvidence: "수정 후에도 기존 테스트가 통과한다.",
        forbiddenEffects: "요청과 무관한 기존 동작이 깨지는 것",
        oracle: buildOracle({
          requiredEvidence: ["test_result"],
          workspaceChanged: true,
          ...(spec.scope === undefined ? {} : { writeScope: spec.scope }),
        }),
        rationale: "수정 요구사항의 실패 형태는 못 고치는 것이 아니라 다른 것을 깨는 것이다.",
        designRuleId: "regression.v1",
        oracleCoverage: ["existing_behaviour_preserved"],
      };

    case "FORBIDDEN_WITHOUT_POSITIVE_PAIR":
      return {
        ...base,
        id: `${spec.id}-positive`,
        title: "다음 턴에서 명시적으로 요청하면 허용된다",
        category: "boundary",
        preconditions: "이전 턴의 금지, 이번 턴의 명시적 허용.",
        actions: "사용자가 해당 동작을 직접 요청한다.",
        expectedEvidence: "요청한 도구가 실행됐다.",
        forbiddenEffects: "지난 턴의 금지가 이번 턴까지 지배하는 것",
        oracle: buildOracle({
          requiredTools: spec.text.includes("실행") ? ["run_command"] : WRITE_TOOLS.slice(0, 1),
        }),
        rationale: "금지 검증만 있으면 전부 거부하는 하네스도 통과한다.",
        designRuleId: "forbidden.v1",
        oracleCoverage: ["not_over_refused", "turn_scoped"],
      };

    case "FORBIDDEN_WITHOUT_SIDE_EFFECT_ORACLE":
      return {
        ...base,
        id: `${spec.id}-sideeffect`,
        title: "금지된 도구의 부작용이 0이다",
        category: "negative",
        preconditions: "사용자가 해당 동작을 금지했다.",
        actions: "요청을 그대로 실행한다.",
        expectedEvidence: "금지된 도구의 실행 기록이 없다.",
        forbiddenEffects: "금지된 도구가 한 번이라도 실행되는 것",
        oracle: buildOracle({
          forbiddenTools: spec.text.includes("실행") ? ["run_command"] : WRITE_TOOLS,
        }),
        rationale: "금지는 부작용 0으로 검증한다.",
        designRuleId: "forbidden.v1",
        oracleCoverage: ["no_side_effect"],
      };

    case "SOURCE_WITHOUT_PROVENANCE_CHECK":
      return {
        ...base,
        id: `${spec.id}-provenance`,
        title: "지정된 출처를 읽고 그 출처로만 귀속한다",
        category: "integration",
        preconditions: "사용자가 URL 을 지목했다.",
        actions: "그 출처를 가져와 읽는다.",
        expectedEvidence: "해당 호스트의 web_source 증거가 있다.",
        forbiddenEffects: "읽지 않은 출처를 근거로 보고하거나 교차 귀속하는 것",
        oracle: buildOracle({ requiredTools: ["web_fetch"], requiredEvidence: ["web_source"] }),
        rationale: "출처 요구사항은 읽은 기록과 귀속 정확성 둘 다로 검증한다.",
        designRuleId: "source.v1",
        oracleCoverage: ["source_fetched", "source_attribution"],
      };

    default:
      return null;
  }
}

/** Whether a closed plan may run. `unresolved` is the reason it may not. */
export function mayExecutePlan(result: ClosureResult): boolean {
  return result.audit.ok;
}
