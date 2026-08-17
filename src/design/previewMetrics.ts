import type { PreviewResult } from "./preview.ts";
import { executionReadiness } from "./requirementSpec.ts";
import { questionsFrom } from "./previewReport.ts";

/**
 * What a batch of previews says about the design engine.
 *
 * Diagnostic, not a verdict. Fifteen fixtures cannot establish a model's
 * quality and are not asked to; what they can show is *where* the engine leaves
 * things undecided, which kinds of request produce rejections, and whether
 * anything is being invented.
 *
 * Offline and model-backed runs are counted separately throughout. Mixing them
 * would report the engine's floor and the model's contribution as one number,
 * and the floor is the part that holds when the model is wrong.
 *
 * ## Every name here is the thing it computes
 *
 * The previous version had three names that promised more than the arithmetic
 * delivered, and each one was read as a result:
 *
 *     explicitRequirements   a count of what was produced, read as "20 correct"
 *     closureSuccessRate     1 whenever nothing remediable was left, including
 *                            when nothing was ever resolved and when there was
 *                            nothing to resolve
 *     inventedRequirements   only proposals the checks refused; an invention by
 *                            the offline extractor was never in it
 *
 * A count is now named `...Count`. A rate carries the denominator it was taken
 * over, so nobody has to guess whether 1.0 means "all fifteen" or "the one case
 * that had any". And what this data cannot answer is listed in `unmeasured`
 * rather than approximated — recall and precision need a gold annotation that
 * these fixtures do not carry, and a number invented for them would be worse
 * than their absence.
 */

/**
 * A count and what it was counted out of.
 *
 * `value` is null when `of` is zero. Neither 0 nor 1 is right for "no
 * denominator": 0 reads as total failure, 1 as total success, and the honest
 * answer is that nothing was measured. Making it null forces every reader to
 * decide what to do about that, which is the point.
 */
export interface Ratio {
  hit: number;
  of: number;
  value: number | null;
}

export interface PreviewMetrics {
  source: "offline" | "model";
  cases: number;

  // --- counts. Counts, not accuracy. ---------------------------------------

  /**
   * Requirements the runtime read from the user's own words. Not a recall.
   *
   * Excludes accepted model proposals, which `acceptProposals` also stamps
   * `explicit`; counting those here reported the same requirement twice, once
   * on this row and once on the model row beneath it.
   */
  extractedRequirementCount: number;
  forbiddenConstraintCount: number;
  /** Model suggestions that survived every check. */
  acceptedProposalCount: number;
  rejectedProposalCount: number;
  rejectionReasons: Record<string, number>;
  /**
   * Proposals refused for having no support in the transcript.
   *
   * Model proposals only — a requirement the offline extractor invented is not
   * in this number, because nothing checks the offline extractor against a
   * gold list. See `unmeasured`.
   */
  refusedProposalInventionCount: number;

  // --- what became of the model's answers ----------------------------------

  /** Parse outcomes per turn, so a prompt problem is not read as a model one. */
  parseOutcomes: Record<string, number>;
  /** The full outcome per turn, parse and the checks after it. */
  proposalOutcomes: Record<string, number>;

  // --- rates, each over a stated denominator -------------------------------

  /**
   * Requirements whose *intent* the runtime could not settle, over the user's
   * own requirements. Separate from the target being open — see below.
   */
  ambiguousIntentRate: Ratio;
  /** Requirements whose act was asked for and whose target is still open. */
  unresolvedBindingRate: Ratio;
  /** Requirements nothing can start on yet, whatever the reason. */
  blockedRate: Ratio;
  semanticUnknownRate: Ratio;
  /** Requirements whose only coverage was a generic placeholder. */
  noDesignRuleRate: Ratio;

  /** Cases that produced at least one question. Over cases. */
  questionCases: Ratio;
  /** Mean questions per case. A rate of 1.0 says nothing about how many. */
  questionsPerCase: number;

  /**
   * Cases where closure removed every finding it is allowed to repair.
   *
   * This is what `closureSuccessRate` computed. It is true of a case with
   * twenty findings left, as long as all twenty need the user. It is also true
   * of a case that never had a finding. Both are honest under this name and
   * neither was under the old one.
   */
  remediableClosureRate: Ratio;
  /** Cases with no finding left at all. The stricter reading of "closed". */
  fullyResolvedRate: Ratio;
  /** Mean findings left needing the user, per case. */
  unresolvedFindingsPerCase: number;
  /** Cases the engine considers ready to run. Over cases. */
  executableRate: Ratio;

  priorities: Record<string, number>;
  polarities: Record<string, number>;
  relations: Record<string, number>;

  /**
   * What these fixtures cannot answer, named so its absence is deliberate.
   *
   * Printing a zero or a guess for these is how "we do not know" becomes "we
   * measured it and it was fine".
   */
  unmeasured: readonly string[];
}

/** Needs a gold annotation these fixtures do not carry. Not computed. */
const NEEDS_GOLD_ANNOTATION: readonly string[] = [
  "requirementRecall — 놓친 요구사항을 세려면 정답 목록이 있어야 한다",
  "requirementPrecision — 잘못 만든 요구사항을 세려면 정답 목록이 있어야 한다",
  "spanAccuracy — 정답 span 이 없다",
  "actionAccuracy / objectAccuracy — 정답 action·object 가 없다",
  "questionPrecision — 물었어야 할 질문의 정답 집합이 없다",
  "offlineInventionRate — 결정론적 추출기의 발명은 어떤 검사도 세지 않는다",
];

const ratio = (hit: number, of: number): Ratio => ({
  hit,
  of,
  value: of === 0 ? null : Math.round((hit / of) * 1000) / 1000,
});

const mean = (total: number, of: number): number =>
  of === 0 ? 0 : Math.round((total / of) * 1000) / 1000;

export function measurePreviews(results: readonly PreviewResult[]): PreviewMetrics {
  const source = results.some((r) => r.proposals.source === "model") ? "model" : "offline";
  const live = results.flatMap((r) => r.requirements.filter((s) => s.supersededBy === undefined));
  // The user's own requirements — the denominator every rate below wants.
  //
  // `live` also holds two harness baselines per run, which are `confirmed`,
  // `resolved` and never semantically unknown by construction. Sixteen fixtures
  // contributed 32 of them to a population of 52, diluting every rate by the
  // fraction of the batch that was the harness talking to itself.
  const userSpecs = live.filter((s) => s.status !== "system_added");
  const extracted = userSpecs.filter((s) => s.derivedBy !== "model_proposal");

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
    for (const spec of userSpecs) out[pick(spec)] = (out[pick(spec)] ?? 0) + 1;
    return out;
  };

  const relations: Record<string, number> = {};
  const parseOutcomes: Record<string, number> = {};
  const proposalOutcomes: Record<string, number> = {};
  for (const result of results) {
    for (const turn of result.turns) relations[turn.relation] = (relations[turn.relation] ?? 0) + 1;
    for (const turn of result.proposals.perTurn) {
      parseOutcomes[turn.parseOutcome] = (parseOutcomes[turn.parseOutcome] ?? 0) + 1;
      proposalOutcomes[turn.outcome] = (proposalOutcomes[turn.outcome] ?? 0) + 1;
    }
  }

  // Counted per result, then summed.
  //
  // A Set of requirement ids pooled across fixtures was silently merging them:
  // ids are only unique within one run, so `t1-act-modify-1` from three
  // different fixtures collapsed to one and nine findings were reported as
  // seven — against a denominator that was never deduplicated.
  const noRule = results.reduce(
    (total, r) =>
      total +
      new Set(
        r.closure.audit.findings.filter((f) => f.code === "NO_DESIGN_RULE").map((f) => f.subject),
      ).size,
    0,
  );
  const unknown = userSpecs.filter((s) => s.alignment?.verdict === "unknown").length;

  const questionCounts = results.map((r) => questionsFrom(r).length);
  const unresolvedCounts = results.map((r) => r.closure.unresolved.length);
  const sum = (ns: readonly number[]): number => ns.reduce((a, b) => a + b, 0);

  return {
    source,
    cases: results.length,

    extractedRequirementCount: extracted.length,
    forbiddenConstraintCount: userSpecs.filter((s) => s.polarity === "forbidden").length,
    acceptedProposalCount: userSpecs.filter((s) => s.derivedBy === "model_proposal").length,
    rejectedProposalCount: rejected,
    rejectionReasons,
    refusedProposalInventionCount: invented,

    parseOutcomes,
    proposalOutcomes,

    ambiguousIntentRate: ratio(userSpecs.filter((s) => s.intent === "ambiguous").length, userSpecs.length),
    unresolvedBindingRate: ratio(userSpecs.filter((s) => s.binding === "unresolved").length, userSpecs.length),
    blockedRate: ratio(
      userSpecs.filter((s) => executionReadiness(s) === "blocked").length,
      userSpecs.length,
    ),
    semanticUnknownRate: ratio(unknown, userSpecs.length),
    noDesignRuleRate: ratio(noRule, userSpecs.length),

    questionCases: ratio(questionCounts.filter((n) => n > 0).length, results.length),
    questionsPerCase: mean(sum(questionCounts), results.length),

    // Every finding that is left is one nobody may repair without the user.
    remediableClosureRate: ratio(
      results.filter((r) => r.closure.unresolved.length === r.closure.audit.findings.length).length,
      results.length,
    ),
    fullyResolvedRate: ratio(
      results.filter((r) => r.closure.audit.findings.length === 0).length,
      results.length,
    ),
    unresolvedFindingsPerCase: mean(sum(unresolvedCounts), results.length),
    executableRate: ratio(results.filter((r) => r.executable).length, results.length),

    priorities: count((s) => s.priority),
    polarities: count((s) => s.polarity),
    relations,

    unmeasured: NEEDS_GOLD_ANNOTATION,
  };
}

/** A rate and the denominator it was taken over, never the rate alone. */
function showRatio(r: Ratio): string {
  return r.value === null ? `측정 불가 (분모 0)` : `${r.value}  (${r.hit}/${r.of})`;
}

export function renderMetrics(metrics: PreviewMetrics): string {
  const lines: string[] = [];
  const row = (label: string, value: string | number): void =>
    void lines.push(`  ${label.padEnd(34)} ${value}`);

  lines.push(`요구사항 처리 지표 — ${metrics.source}`);
  lines.push("-".repeat(66));
  lines.push("  [개수]");
  row("사례 수", metrics.cases);
  row("추출된 요구사항 수", metrics.extractedRequirementCount);
  row("금지 요구사항 수", metrics.forbiddenConstraintCount);
  row("수용된 모델 제안 수", metrics.acceptedProposalCount);
  row("거부된 모델 제안 수", metrics.rejectedProposalCount);
  row("거부된 제안 중 발명", metrics.refusedProposalInventionCount);
  lines.push("");
  lines.push("  [비율 — 분자/분모 표기]");
  row("의도 모호 비율", showRatio(metrics.ambiguousIntentRate));
  row("대상 미결정 비율", showRatio(metrics.unresolvedBindingRate));
  row("실행 차단 비율", showRatio(metrics.blockedRate));
  row("의미 미확정 비율", showRatio(metrics.semanticUnknownRate));
  row("설계 규칙 없음 비율", showRatio(metrics.noDesignRuleRate));
  row("질문이 생긴 사례 비율", showRatio(metrics.questionCases));
  row("사례당 질문 수", metrics.questionsPerCase);
  row("보완 가능 finding 해소 비율", showRatio(metrics.remediableClosureRate));
  row("finding 전부 해소 비율", showRatio(metrics.fullyResolvedRate));
  row("사례당 미해결 finding", metrics.unresolvedFindingsPerCase);
  row("실행 가능 비율", showRatio(metrics.executableRate));
  lines.push("");
  row("우선순위", JSON.stringify(metrics.priorities));
  row("극성", JSON.stringify(metrics.polarities));
  row("턴 관계", JSON.stringify(metrics.relations));
  if (Object.keys(metrics.parseOutcomes).length > 0) {
    row("응답 파싱 결과", JSON.stringify(metrics.parseOutcomes));
  }
  if (Object.keys(metrics.proposalOutcomes).length > 0) {
    row("제안 처리 결과", JSON.stringify(metrics.proposalOutcomes));
  }
  if (Object.keys(metrics.rejectionReasons).length > 0) {
    row("거부 사유", JSON.stringify(metrics.rejectionReasons));
  }
  lines.push("");
  lines.push("  [이 fixture 로는 계산할 수 없는 값]");
  for (const item of metrics.unmeasured) lines.push(`    - ${item}`);
  return lines.join("\n");
}
