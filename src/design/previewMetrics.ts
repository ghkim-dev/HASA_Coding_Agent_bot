import type { PreviewResult } from "./preview.ts";
import { questionsFrom } from "./previewReport.ts";

/**
 * What a batch of previews says about the design engine.
 *
 * Diagnostic, not a verdict. Fifteen fixtures cannot establish a model's
 * quality and are not asked to; what they can show is *where* the engine leaves
 * things undecided, which kinds of request produce rejections, and whether
 * anything is being invented. Those are the questions worth answering before
 * the plan is allowed to drive anything.
 *
 * Offline and model-backed runs are counted separately throughout. Mixing them
 * would report the engine's floor and the model's contribution as one number,
 * and the floor is the part that holds when the model is wrong.
 */

export interface PreviewMetrics {
  source: "offline" | "model";
  cases: number;
  /** Requirements the runtime read from the user's own words. */
  explicitRequirements: number;
  /** Model suggestions that survived the checks. */
  acceptedProposals: number;
  /** Model suggestions refused, by reason. */
  rejectedProposals: number;
  rejectionReasons: Record<string, number>;
  /** Proposals refused for having no support in the transcript. */
  inventedRequirements: number;
  forbiddenConstraints: number;
  /** Requirements left `ambiguous`, over all live requirements. */
  ambiguousRate: number;
  /** Cases that produced at least one question for the user. */
  userConfirmationRate: number;
  /** Cases where closure removed every remediable finding. */
  closureSuccessRate: number;
  /** Requirements whose only coverage was a generic placeholder. */
  noDesignRuleRate: number;
  /** Requirements whose meaning the runtime could not settle. */
  semanticUnknownRate: number;
  /** Cases the engine considers ready to run. */
  executableRate: number;
  priorities: Record<string, number>;
  polarities: Record<string, number>;
  relations: Record<string, number>;
}

const rate = (hit: number, total: number): number =>
  total === 0 ? 0 : Math.round((hit / total) * 1000) / 1000;

export function measurePreviews(results: readonly PreviewResult[]): PreviewMetrics {
  const source = results.some((r) => r.proposals.source === "model") ? "model" : "offline";
  const live = results.flatMap((r) => r.requirements.filter((s) => s.supersededBy === undefined));
  const explicit = live.filter((s) => s.status === "explicit" || s.status === "inherited");

  const rejectionReasons: Record<string, number> = {};
  let rejected = 0;
  let invented = 0;
  for (const result of results) {
    for (const r of result.rejected) {
      rejected += 1;
      for (const reason of r.reasons) rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
      // "No support in what the user wrote" is the invention case, whatever
      // shape it arrived in.
      if (
        r.reasons.includes("quote_mismatch") ||
        r.reasons.includes("out_of_range") ||
        r.reasons.includes("semantics_reversed")
      ) {
        invented += 1;
      }
    }
  }

  const count = (pick: (spec: (typeof live)[number]) => string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const spec of live) out[pick(spec)] = (out[pick(spec)] ?? 0) + 1;
    return out;
  };

  const relations: Record<string, number> = {};
  for (const result of results) {
    for (const turn of result.turns) relations[turn.relation] = (relations[turn.relation] ?? 0) + 1;
  }

  const noRule = new Set(
    results.flatMap((r) =>
      r.closure.audit.findings.filter((f) => f.code === "NO_DESIGN_RULE").map((f) => f.subject),
    ),
  );
  const unknown = live.filter((s) => s.alignment?.verdict === "unknown").length;

  return {
    source,
    cases: results.length,
    explicitRequirements: explicit.length,
    acceptedProposals: live.filter((s) => s.derivedBy === "model_proposal").length,
    rejectedProposals: rejected,
    rejectionReasons,
    inventedRequirements: invented,
    forbiddenConstraints: live.filter((s) => s.polarity === "forbidden").length,
    ambiguousRate: rate(live.filter((s) => s.confidence === "ambiguous").length, live.length),
    userConfirmationRate: rate(results.filter((r) => questionsFrom(r).length > 0).length, results.length),
    closureSuccessRate: rate(
      results.filter((r) => r.closure.unresolved.length === r.closure.audit.findings.length).length,
      results.length,
    ),
    noDesignRuleRate: rate(noRule.size, live.length),
    semanticUnknownRate: rate(unknown, live.length),
    executableRate: rate(results.filter((r) => r.executable).length, results.length),
    priorities: count((s) => s.priority),
    polarities: count((s) => s.polarity),
    relations,
  };
}

export function renderMetrics(metrics: PreviewMetrics): string {
  const lines: string[] = [];
  const row = (label: string, value: string | number): void =>
    void lines.push(`  ${label.padEnd(34)} ${value}`);

  lines.push(`요구사항 정확성 지표 — ${metrics.source}`);
  lines.push("-".repeat(60));
  row("사례 수", metrics.cases);
  row("명시 요구사항", metrics.explicitRequirements);
  row("금지 요구사항", metrics.forbiddenConstraints);
  row("수용된 모델 제안", metrics.acceptedProposals);
  row("거부된 모델 제안", metrics.rejectedProposals);
  row("발명된 요구사항", metrics.inventedRequirements);
  row("모호 비율", metrics.ambiguousRate);
  row("의미 미확정 비율", metrics.semanticUnknownRate);
  row("사용자 확인 필요 비율", metrics.userConfirmationRate);
  row("Closure 성공 비율", metrics.closureSuccessRate);
  row("설계 규칙 없음 비율", metrics.noDesignRuleRate);
  row("실행 가능 비율", metrics.executableRate);
  lines.push("");
  row("우선순위", JSON.stringify(metrics.priorities));
  row("극성", JSON.stringify(metrics.polarities));
  row("턴 관계", JSON.stringify(metrics.relations));
  if (Object.keys(metrics.rejectionReasons).length > 0) {
    row("거부 사유", JSON.stringify(metrics.rejectionReasons));
  }
  return lines.join("\n");
}
