import type { Finding, FindingCode } from "./coverageAudit.ts";
import type { PreviewResult } from "./preview.ts";
import { executionReadiness, type RequirementSpec } from "./requirementSpec.ts";

/**
 * The plan, in sentences somebody who does not work on this can read.
 *
 * The design engine's own vocabulary — `forbidden`, `ambiguous`,
 * `MODIFY_WITHOUT_REGRESSION`, `designRuleId` — is precise and belongs in the
 * audit. Putting it in front of a user asks them to learn the system before
 * they can check whether it understood them, which is exactly backwards: they
 * are the only one who knows whether it did.
 *
 * So the default output names no enum, no score and no rule id. `--advanced`
 * and `--json` carry all of it.
 */

/** Findings that become a question rather than a repair. */
const ASKABLE: ReadonlySet<FindingCode> = new Set<FindingCode>([
  "REQUIREMENT_CONFLICT",
  "UNRESOLVED_CONDITION",
  "SEMANTIC_ALIGNMENT_UNKNOWN",
  "NO_DESIGN_RULE",
  "AMBIGUOUS_DECIDED",
  "TARGET_UNRESOLVED",
]);

export interface Question {
  /** What is unclear, in the user's terms. */
  about: string;
  /** Choices, none of them pre-selected. */
  options: string[];
  /** The finding behind it. Advanced output only. */
  code: FindingCode;
  subject: string;
}

/**
 * Turns a finding into something answerable.
 *
 * Options are offered and never chosen. Picking one here would be the plan
 * deciding on the user's behalf and hiding that it did — the failure the whole
 * design exists to prevent, arriving through the report instead of the planner.
 */
export function questionsFrom(result: PreviewResult): Question[] {
  const byId = new Map(result.requirements.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const out: Question[] = [];

  for (const finding of result.closure.audit.findings) {
    if (!ASKABLE.has(finding.code)) continue;
    // One question per requirement, not per finding.
    //
    // A single extracted requirement can raise `AMBIGUOUS_DECIDED` and
    // `NO_DESIGN_RULE` and `UNRESOLVED_CONDITION` at once, and asking three
    // times about the same sentence is how a preview becomes an interrogation.
    // The first finding for a subject is the one worth asking about; the rest
    // are in `--advanced`.
    if (seen.has(finding.subject)) continue;
    seen.add(finding.subject);

    const spec = byId.get(finding.subject);
    const quoted = spec === undefined ? finding.subject : `"${spec.sourceText || spec.text}"`;

    switch (finding.code) {
      case "UNRESOLVED_CONDITION":
        out.push({
          about: `${quoted} 라는 조건을 이번 작업에서 어떻게 확인해야 할지 정해지지 않았습니다.`,
          options: [
            "조건이 성립한다고 보고 진행",
            "조건이 맞는지 먼저 확인",
            "이 조건은 이번 작업에서 제외",
          ],
          code: finding.code,
          subject: finding.subject,
        });
        break;
      case "REQUIREMENT_CONFLICT": {
        const others = (spec?.conflicts ?? []).map((id) => byId.get(id)?.text ?? id);
        out.push({
          about: `${spec?.text ?? finding.subject} 와(과) ${others.join(", ")} 은(는) 동시에 만족시킬 수 없습니다.`,
          options: [
            `${spec?.text ?? finding.subject} 를 우선`,
            `${others.join(", ")} 를 우선`,
            "두 요구사항을 다시 설명",
          ],
          code: finding.code,
          subject: finding.subject,
        });
        break;
      }
      case "SEMANTIC_ALIGNMENT_UNKNOWN":
        out.push({
          about: `${quoted} 에서 무엇을 요구하시는지 확실하지 않습니다.`,
          options: ["요구사항을 다시 설명", "이 부분은 이번 작업에서 제외"],
          code: finding.code,
          subject: finding.subject,
        });
        break;
      case "NO_DESIGN_RULE":
        out.push({
          about: `${spec?.text ?? finding.subject} 을(를) 어떻게 확인해야 통과라고 볼 수 있는지 정해진 방법이 없습니다.`,
          options: [
            "무엇을 보면 됐다고 볼 수 있는지 알려주기",
            "이 요구사항은 확인 없이 진행",
            "이번 작업에서 제외",
          ],
          code: finding.code,
          subject: finding.subject,
        });
        break;
      case "AMBIGUOUS_DECIDED":
        out.push({
          // Reaches here only when the *intent* is genuinely in doubt — in
          // practice, a model's paraphrase. A verb the user wrote themselves no
          // longer arrives here, and asking them to re-authorise their own
          // request was the largest single source of unnecessary questions.
          about: `${spec?.text ?? finding.subject} 은(는) 요청하신 내용이 맞습니까? 사용자가 직접 말한 것이 아니라 제안된 내용입니다.`,
          options: ["맞습니다", "다르게 이해해야 합니다", "이번 작업에서 제외"],
          code: finding.code,
          subject: finding.subject,
        });
        break;
      case "TARGET_UNRESOLVED":
        out.push({
          // The act is not in question, only what to do it to. Merged into the
          // question above, this asked the user to re-confirm a request they
          // had just made and buried the one thing actually missing.
          about: `"${spec?.sourceText ?? finding.subject}" 라고 하셨는데, 어떤 파일이나 대상을 말씀하시는지 알려주세요.`,
          options: [
            "대상을 알려주기",
            "저장소에서 찾아보고 후보를 먼저 제시",
            "이번 작업에서 제외",
          ],
          code: finding.code,
          subject: finding.subject,
        });
        break;
      default:
        break;
    }
  }
  return out;
}

const live = (specs: readonly RequirementSpec[]): RequirementSpec[] =>
  specs.filter((s) => s.supersededBy === undefined);

/** The everyday report. No enum, no id, no score. */
export function renderReport(result: PreviewResult): string {
  const specs = live(result.requirements);
  const explicit = specs.filter((s) => s.status === "explicit" || s.status === "inherited");
  const must = explicit.filter((s) => s.polarity === "required" && s.priority === "must");
  const optional = explicit.filter((s) => s.polarity === "required" && s.priority !== "must");
  const forbidden = explicit.filter((s) => s.polarity === "forbidden");
  const inherited = specs.filter((s) => s.status === "inherited");
  const questions = questionsFrom(result);

  const lines: string[] = [];
  const list = (items: readonly string[]): void => {
    if (items.length === 0) {
      lines.push("없습니다.");
      return;
    }
    items.forEach((item, i) => lines.push(`${i + 1}. ${item}`));
  };

  lines.push("요청을 다음과 같이 이해했습니다.");
  lines.push("");
  lines.push("반드시 필요한 작업");
  list(must.map((s) => s.text));
  lines.push("");

  if (optional.length > 0) {
    lines.push("가능하면 함께 할 작업");
    list(optional.map((s) => s.text));
    lines.push("");
  }

  lines.push("하지 않을 작업");
  list(forbidden.map((s) => s.text));
  lines.push("");

  if (inherited.length > 0) {
    lines.push("이전 요청에서 이어지는 조건");
    list(inherited.map((s) => s.text));
    lines.push("");
  }

  lines.push("검증 방법");
  // The harness's own conditions are always on and are not something the user
  // asked for. Listing them beside the checks derived from the request made a
  // plan that verifies nothing look like a plan.
  const mine = result.scenarios.filter((s) => s.generatedBy !== "baseline");
  list(mine.map((s) => s.title));
  lines.push("");

  lines.push("확인이 필요한 내용");
  if (questions.length === 0) {
    lines.push("없습니다.");
  } else {
    questions.forEach((q, i) => {
      lines.push(`${i + 1}. ${q.about}`);
      q.options.forEach((option, j) => lines.push(`   ${j + 1}) ${option}`));
    });
  }
  lines.push("");

  if (result.rejected.length > 0) {
    lines.push("요청에서 확인할 수 없어 제외한 내용");
    result.rejected.forEach((r, i) => {
      lines.push(`${i + 1}. "${r.proposal.text}" — ${plainReason(r.reasons)}`);
    });
    lines.push("");
  }

  lines.push("현재 상태");
  if (must.length === 0 && optional.length === 0 && forbidden.length === 0) {
    // Nothing was understood. Reporting a plan here would be reporting one for
    // requirements nobody has: the checks that exist are the harness's own.
    lines.push("요청에서 확인할 수 있는 작업을 찾지 못했습니다.");
    lines.push("무엇을 어떤 파일에서 해야 하는지 조금 더 알려주시면 계획을 만들 수 있습니다.");
    lines.push("아직 파일을 수정하거나 명령을 실행하지 않았습니다.");
  } else if (result.executable) {
    lines.push("검증 계획을 만들었습니다. 아직 파일을 수정하거나 명령을 실행하지 않았습니다.");
  } else {
    lines.push(
      questions.length > 0
        ? "위 확인이 끝나야 검증 계획을 확정할 수 있습니다. 아직 파일을 수정하거나 명령을 실행하지 않았습니다."
        : "검증 계획에 아직 빠진 부분이 있습니다. 아직 파일을 수정하거나 명령을 실행하지 않았습니다.",
    );
  }

  if (result.proposals.error !== null) {
    lines.push("");
    lines.push("참고");
    lines.push(`모델에 요구사항 후보를 물어보지 못했습니다 (${result.proposals.error}).`);
    lines.push("요청에서 직접 읽어낼 수 있는 내용만으로 위 계획을 만들었습니다.");
  }

  return lines.join("\n");
}

/** Why something was left out, without naming the rule that left it out. */
function plainReason(reasons: readonly string[]): string {
  if (reasons.includes("forged_provenance")) return "요청에 없는 근거가 붙어 있었습니다";
  if (reasons.includes("semantics_reversed")) return "인용한 문장과 뜻이 반대였습니다";
  if (reasons.includes("quote_mismatch")) return "요청의 문장과 일치하지 않았습니다";
  if (reasons.includes("negation_truncated")) return "'하지 마' 부분이 빠진 채 인용됐습니다";
  if (reasons.includes("condition_truncated")) return "조건 부분이 빠진 채 인용됐습니다";
  if (reasons.includes("too_slight")) return "근거로 삼은 부분이 너무 짧았습니다";
  return "요청에서 근거를 찾을 수 없었습니다";
}

/** Everything the report leaves out. For someone debugging the engine. */
export function renderAdvanced(result: PreviewResult): string {
  const lines: string[] = [];
  const rule = "-".repeat(74);

  lines.push("ADVANCED DETAILS");
  lines.push(rule);
  lines.push(`제안 출처   : ${result.proposals.source}`);
  lines.push(`모델        : ${result.proposals.modelId ?? "(없음)"}`);
  lines.push(`모델 호출   : ${result.proposals.calls}`);
  lines.push(`실행 가능   : ${result.executable}`);
  lines.push("");

  lines.push("TURNS");
  for (const turn of result.turns) lines.push(`  ${turn.turnId}  ${turn.relation.padEnd(9)} ${turn.text}`);
  lines.push("");

  lines.push("REQUIREMENTS");
  for (const spec of result.requirements) {
    const span = spec.span === undefined ? "-" : `${spec.span.turnId}:${spec.span.start}-${spec.span.end}`;
    lines.push(
      `  ${spec.id.padEnd(24)} ${spec.status.padEnd(12)} ${spec.polarity.padEnd(9)} ${spec.priority.padEnd(6)} ${spec.intent.padEnd(9)} ${spec.binding.padEnd(10)} ${executionReadiness(spec).padEnd(7)} ${spec.derivedBy.padEnd(20)} ${span}`,
    );
    if (spec.sourceText.length > 0) lines.push(`      원문 "${spec.sourceText}"`);
    if (spec.supersededBy !== undefined) lines.push(`      superseded by ${spec.supersededBy}`);
    if (spec.condition !== undefined) lines.push(`      condition ${spec.condition}`);
    if (spec.conflicts.length > 0) lines.push(`      conflicts ${spec.conflicts.join(", ")}`);
    if (spec.alignment !== undefined && spec.alignment.code !== "none") {
      lines.push(`      alignment ${spec.alignment.verdict}/${spec.alignment.code}`);
    }
    if (spec.modelClaimedConfidence !== undefined) {
      lines.push(`      모델 주장 confidence ${spec.modelClaimedConfidence} (반영하지 않음)`);
    }
  }
  lines.push("");

  if (result.rejected.length > 0) {
    lines.push("REJECTED PROPOSALS");
    for (const r of result.rejected) {
      lines.push(`  ${r.turnId}  ${r.reasons.join(", ")}`);
      lines.push(`      "${r.proposal.text}"`);
    }
    lines.push("");
  }

  lines.push("SCENARIOS");
  for (const s of result.scenarios) {
    lines.push(`  ${s.id.padEnd(28)} ${s.category.padEnd(11)} ${s.designRuleId.padEnd(24)} ← ${s.requirementIds.join(", ")}`);
    lines.push(`      oracle ${describeOracle(s.oracle)}`);
    if (s.oracleCoverage.length > 0) lines.push(`      covers ${s.oracleCoverage.join(", ")}`);
    if (s.unresolvedAspects.length > 0) lines.push(`      unresolved ${s.unresolvedAspects.join(", ")}`);
  }
  lines.push("");

  lines.push("AUDIT — 초기");
  lines.push(...findingLines(result.initialAudit.findings));
  lines.push(`  coverage ${result.initialAudit.coverage.covered}/${result.initialAudit.coverage.needed}`);
  lines.push("");

  lines.push("CLOSURE");
  lines.push(`  passes ${result.closure.passes}  stopped ${result.closure.stoppedBecause}`);
  for (const pass of result.closure.history) {
    for (const added of pass.added) {
      lines.push(`  pass ${pass.pass}  +${added.scenarioId}  (${added.because} on ${added.subject})`);
    }
  }
  lines.push("");

  lines.push("AUDIT — 보완 후");
  lines.push(...findingLines(result.closure.audit.findings));
  lines.push(`  coverage ${result.closure.audit.coverage.covered}/${result.closure.audit.coverage.needed}`);

  return lines.join("\n");
}

function findingLines(findings: readonly Finding[]): string[] {
  if (findings.length === 0) return ["  (없음)"];
  return findings.map((f) => `  ${f.code.padEnd(38)} ${f.subject}`);
}

function describeOracle(oracle: PreviewResult["scenarios"][number]["oracle"]): string {
  const parts: string[] = [];
  if (oracle.forbiddenTools.length > 0) parts.push(`forbid[${oracle.forbiddenTools.join(",")}]`);
  if (oracle.requiredTools.length > 0) parts.push(`require[${oracle.requiredTools.join(",")}]`);
  if (oracle.requiredEvidence.length > 0) parts.push(`evidence[${oracle.requiredEvidence.join(",")}]`);
  if (oracle.writeScope.length > 0) parts.push(`scope[${oracle.writeScope.join(",")}]`);
  if (oracle.workspaceChanged !== null) parts.push(`changed=${oracle.workspaceChanged}`);
  if (oracle.verifiedCompletion !== null) parts.push(`complete=${oracle.verifiedCompletion}`);
  return parts.length === 0 ? "(없음)" : parts.join(" ");
}

/**
 * The machine-readable form, with the chain intact.
 *
 *     turn → sourceSpan → requirementId → blueprintId → oracleCoverage
 *          → audit finding → closure history
 *
 * Every link is present for every requirement, so a consumer can answer "which
 * of my words produced this check" without guessing.
 */
export function renderJson(result: PreviewResult): unknown {
  return {
    turns: result.turns,
    executable: result.executable,
    proposals: result.proposals,
    requirements: result.requirements.map((spec) => ({
      id: spec.id,
      text: spec.text,
      sourceTurnId: spec.sourceTurnId,
      sourceSpan: spec.span ?? null,
      sourceText: spec.sourceText,
      kind: spec.kind,
      priority: spec.priority,
      polarity: spec.polarity,
      status: spec.status,
      provenance: spec.provenance,
      intent: spec.intent,
      binding: spec.binding,
      executionReadiness: executionReadiness(spec),
      modelClaimedConfidence: spec.modelClaimedConfidence ?? null,
      derivedBy: spec.derivedBy,
      condition: spec.condition ?? null,
      scope: spec.scope ?? null,
      conflicts: spec.conflicts,
      supersededBy: spec.supersededBy ?? null,
      alignment: spec.alignment ?? null,
      blueprintIds: result.scenarios.filter((s) => s.requirementIds.includes(spec.id)).map((s) => s.id),
    })),
    rejectedProposals: result.rejected.map((r) => ({
      turnId: r.turnId,
      text: r.proposal.text,
      span: r.proposal.span,
      reasons: r.reasons,
    })),
    scenarios: result.scenarios.map((s) => ({
      id: s.id,
      title: s.title,
      category: s.category,
      requirementIds: s.requirementIds,
      designRuleId: s.designRuleId,
      oracle: s.oracle,
      oracleCoverage: s.oracleCoverage,
      unresolvedAspects: s.unresolvedAspects,
      generatedBy: s.generatedBy,
    })),
    initialAudit: result.initialAudit,
    closure: {
      passes: result.closure.passes,
      stoppedBecause: result.closure.stoppedBecause,
      history: result.closure.history,
      unresolved: result.closure.unresolved,
    },
    finalAudit: result.closure.audit,
    questions: questionsFrom(result),
  };
}
