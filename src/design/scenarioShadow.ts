import type { EvalScenario, EvalTurn } from "../eval/scenario.ts";
import { CLEAN } from "../eval/scenario.ts";
import type { PreviewResult } from "./preview.ts";
import type { ScenarioBlueprint } from "./scenarioBlueprint.ts";
import type { DerivedBy, RequirementSpec } from "./requirementSpec.ts";

/**
 * What the design engine's plan would look like as an `EvalScenario`, and
 * nothing else.
 *
 * The point of shadow mode is to find out whether the mapping is any good before
 * anything depends on it. So this is deliberately built as a *computation over a
 * finished `PreviewResult`* rather than as a stage in a pipeline: there is no
 * port to inject, no store to write to, no client to call, and therefore no
 * version of this that quietly starts mattering.
 *
 * ## What it may not do, and why the shape is the guarantee
 *
 *     0 files written        — nothing here can write; there is no `fs` import
 *     0 commands run         — nor a `child_process` one
 *     0 network calls        — nor a `fetch`, a provider or a client
 *     0 effect on model choice — it never touches permission or the proposer
 *     0 effect on approval   — nor the tool gate, nor `actionPolicy`
 *
 * Those are asserted from the source in `scenarioShadow.test.ts`, because a
 * comment claiming purity is not purity. The reason for reading it structurally
 * rather than trusting the review: every one of these guarantees is about code
 * that does *not* exist, and the only way to keep checking that is to check.
 *
 * ## Failure is a result
 *
 * `shadowScenarioFrom` does not throw. A shadow measurement that could end a
 * user's turn would be a new failure mode bought in exchange for a number nobody
 * is acting on yet — the same argument `router/shadow.ts` makes. Anything
 * unexpected comes back as `adapter_failed` with the reason attached.
 *
 * ## And it records what it could not do
 *
 * `notMapped` and `unresolved` are the honest half. A `WorldSpec` cannot be
 * derived from a request — nobody knows which files exist or what the commands
 * would print — so the shadow says so rather than inventing a world, and a
 * requirement whose target the user never named produces no recall string
 * instead of a guessed one.
 */

export type ShadowStatus =
  /** A scenario was produced. It is data; nothing ran it. */
  | "mapped"
  /** The plan holds no user requirement, so there is nothing to map. */
  | "nothing_to_map"
  /** Something went wrong in here. The user's turn is unaffected. */
  | "adapter_failed";

export interface RequirementSource {
  requirementId: string;
  /** The turn the words came from. */
  turnId: string;
  /** Where in that turn, when the requirement was cut from it. */
  span: { start: number; end: number } | null;
  /** The user's own words, as the runtime cut them. Never a model's string. */
  sourceText: string;
  /** What established it. `model_proposal` is carried and never promoted. */
  derivedBy: DerivedBy;
  /** The act the runtime read, when it read one. */
  act?: string;
}

/**
 * One name per cause, whichever layer noticed it.
 *
 * The blueprint and the audit describe the same problems in two vocabularies —
 * `requirement_target_unresolved` and `TARGET_UNRESOLVED`, and a
 * `NO_DESIGN_RULE` that always arrives with `UNSUPPORTED_REQUIREMENT_KIND` beside
 * it. Deduplicating the strings left all of those standing, so one open target
 * counted as two problems and "미해결 7건" described five.
 *
 * So the two vocabularies are mapped onto one, and the raw names are kept on the
 * item. Nothing is merged that the map does not name: an unrecognised code
 * becomes its own cause rather than quietly joining another.
 */
export type UnresolvedCause =
  | "target_unresolved"
  | "condition_unsettled"
  | "requirement_conflict"
  | "semantic_alignment_unknown"
  | "requirement_ambiguous"
  | "no_design_rule"
  | "no_user_requirement"
  /** A code this map does not know. Carried as-is; never merged. */
  | `other:${string}`;

const CAUSE_OF_ASPECT: Readonly<Record<string, UnresolvedCause>> = {
  requirement_target_unresolved: "target_unresolved",
  condition_unsettled: "condition_unsettled",
  conflicts_with_another_requirement: "requirement_conflict",
  semantic_alignment_unknown: "semantic_alignment_unknown",
  requirement_is_ambiguous: "requirement_ambiguous",
  no_design_rule_for_this_requirement: "no_design_rule",
};

const CAUSE_OF_FINDING: Readonly<Record<string, UnresolvedCause>> = {
  TARGET_UNRESOLVED: "target_unresolved",
  UNRESOLVED_CONDITION: "condition_unsettled",
  REQUIREMENT_CONFLICT: "requirement_conflict",
  SEMANTIC_ALIGNMENT_UNKNOWN: "semantic_alignment_unknown",
  AMBIGUOUS_DECIDED: "requirement_ambiguous",
  NO_DESIGN_RULE: "no_design_rule",
  // The audit emits this one beside `NO_DESIGN_RULE`, always and only. Two names
  // for "the designer has no rule for this kind", not two problems.
  UNSUPPORTED_REQUIREMENT_KIND: "no_design_rule",
  NO_USER_REQUIREMENT: "no_user_requirement",
};

export interface UnresolvedItem {
  requirementId: string;
  cause: UnresolvedCause;
  /** Which layer noticed it. Both, when both did. */
  origins: Array<"blueprint" | "audit">;
  /** The raw names, so a reader can trace the cause back to its source. */
  aspects: string[];
}

export interface ShadowScenarioResult {
  status: ShadowStatus;
  /**
   * The scenario the plan maps to. Never registered, never run, never scored.
   *
   * Null unless `status` is `mapped`.
   */
  scenario: EvalScenario | null;
  /** Where every mapped requirement came from. */
  requirementSources: RequirementSource[];
  /** Which design rules produced the blueprints behind it, sorted. */
  designRulesUsed: string[];
  /** Which aspects the blueprints' oracles decide, sorted. */
  oracleCoverage: string[];
  /** What nobody could settle, per requirement. */
  unresolved: UnresolvedItem[];
  /** What the mapping could not carry across, and why. */
  notMapped: Array<{ subject: string; reason: string }>;
  /** Set whenever `status` is not `mapped`. */
  failure?: string;
  detail?: string;
}

const WRITE_TOOLS = new Set(["write_file", "create_file", "apply_patch", "delete_file"]);

/** The user's own requirements. Baselines and superseded entries are not mapped. */
function ownRequirements(preview: PreviewResult): RequirementSpec[] {
  return preview.requirements.filter(
    (spec) => spec.status !== "system_added" && spec.supersededBy === undefined,
  );
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Maps a finished preview onto an `EvalScenario`, or says why it did not.
 *
 * `id` comes from the caller. Deriving one from a hash of the turns would be
 * deterministic and unreadable, and inventing a title from the request's prose
 * would be the design engine writing its own answer key — the one thing
 * `eval/scenario.ts` says a fixture may never be.
 */
export function shadowScenarioFrom(input: {
  id: string;
  preview: PreviewResult;
}): ShadowScenarioResult {
  const empty = (
    status: ShadowStatus,
    extra: Partial<ShadowScenarioResult> = {},
  ): ShadowScenarioResult => ({
    status,
    scenario: null,
    requirementSources: [],
    designRulesUsed: [],
    oracleCoverage: [],
    unresolved: [],
    notMapped: [],
    ...extra,
  });

  try {
    const { preview } = input;
    const specs = ownRequirements(preview);
    if (specs.length === 0) {
      return empty("nothing_to_map", {
        failure: "no_user_requirement",
        detail: "설계 미리보기에 사용자 요구사항이 없습니다.",
      });
    }

    const byRequirement = new Map<string, ScenarioBlueprint[]>();
    for (const blueprint of preview.scenarios) {
      for (const id of blueprint.requirementIds) {
        byRequirement.set(id, [...(byRequirement.get(id) ?? []), blueprint]);
      }
    }

    const notMapped: ShadowScenarioResult["notMapped"] = [];
    const requirementSources: RequirementSource[] = [];
    const rules: string[] = [];
    const coverage: string[] = [];

    // One entry per requirement and cause, folded as it is collected rather than
    // filtered at the end. The previous version deduplicated the array on the way
    // out and left `about` counting the raw list, so the sentence a user reads
    // disagreed with the data beside it: "미해결 4건" over two items.
    const causes = new Map<string, UnresolvedItem>();
    const noteUnresolved = (
      requirementId: string,
      raw: string,
      origin: "blueprint" | "audit",
    ): void => {
      const cause =
        (origin === "blueprint" ? CAUSE_OF_ASPECT[raw] : CAUSE_OF_FINDING[raw]) ??
        (`other:${raw}` as UnresolvedCause);
      const key = `${requirementId}|${cause}`;
      const existing = causes.get(key);
      if (existing === undefined) {
        causes.set(key, { requirementId, cause, origins: [origin], aspects: [raw] });
        return;
      }
      if (!existing.origins.includes(origin)) existing.origins.push(origin);
      if (!existing.aspects.includes(raw)) existing.aspects.push(raw);
    };

    for (const spec of specs) {
      requirementSources.push({
        requirementId: spec.id,
        turnId: spec.span?.turnId ?? spec.sourceTurnId,
        span: spec.span === undefined ? null : { start: spec.span.start, end: spec.span.end },
        sourceText: spec.sourceText,
        derivedBy: spec.derivedBy,
        ...(spec.act === undefined ? {} : { act: spec.act }),
      });

      const blueprints = byRequirement.get(spec.id) ?? [];
      if (blueprints.length === 0) {
        notMapped.push({ subject: spec.id, reason: "이 요구사항을 덮는 시나리오가 없습니다." });
        continue;
      }
      for (const blueprint of blueprints) {
        rules.push(blueprint.designRuleId);
        coverage.push(...blueprint.oracleCoverage);
        for (const aspect of blueprint.unresolvedAspects) {
          noteUnresolved(spec.id, aspect, "blueprint");
        }
      }
    }

    // Findings the closure could not repair are unresolved whether or not a
    // blueprint mentioned them.
    for (const finding of preview.closure.unresolved) {
      noteUnresolved(finding.subject, finding.code, "audit");
    }

    // Computed once, here, and used by every reader below — the count in `about`,
    // the array in the result, and therefore the JSON and the advanced output.
    const unresolved = [...causes.values()];

    const turns: EvalTurn[] = preview.turns.map((turn) => {
      const here = specs.filter((spec) => (spec.span?.turnId ?? spec.sourceTurnId) === turn.turnId);
      const blueprints = here.flatMap((spec) => byRequirement.get(spec.id) ?? []);

      // Only the user's stated prohibitions become `forbids`, and only from the
      // scenarios whose oracle asserts an *absence*.
      //
      // Two narrowings, each for a wrong answer this produced. Reading every
      // requirement rather than the forbidden ones made an `inspect` request —
      // whose oracle forbids the write tools — declare a modification
      // prohibition the user never stated. And reading every scenario of a
      // prohibition swept in `-later-allowed`, which forbids the *other* class
      // precisely because it is about a turn where this one is permitted again;
      // "실행하지 말고 코드만 보여줘" came out forbidding execution and
      // modification both.
      const forbiddenTools = new Set(
        here
          .filter((spec) => spec.polarity === "forbidden")
          .flatMap((spec) => byRequirement.get(spec.id) ?? [])
          .filter((b) => b.category === "negative" && b.oracleCoverage.includes("no_side_effect"))
          .flatMap((b) => b.oracle.forbiddenTools),
      );
      const forbids: Array<"execute" | "modify"> = [];
      if (forbiddenTools.has("run_command")) forbids.push("execute");
      if ([...forbiddenTools].some((tool) => WRITE_TOOLS.has(tool))) forbids.push("modify");

      // The evaluator matches a requirement by asking whether the recorded
      // description *contains* this string (`covers`, in `eval/metrics.ts`), so
      // what belongs here is the short phrase the user typed — `로그인 오류`. The
      // runtime already recorded exactly that as the requirement's `target`.
      //
      // Not derived from the requirement's own sentence, which was the first
      // attempt: taking the longest word out of the cut span picked the verb, so
      // the answer key for "로그인 오류를 수정하고 테스트해줘" came out as
      // `수정하고` — a matcher that would score a model on having said "수정".
      const requirements: string[] = [];
      for (const spec of here) {
        if (spec.polarity === "forbidden") continue;
        // A source requirement is carried by `exactSources`, which is the field
        // the evaluator checks hostnames with.
        if (spec.derivedBy === "runtime_source") continue;
        if (spec.target === undefined) {
          notMapped.push({
            subject: spec.id,
            reason:
              spec.binding === "unresolved"
                ? "대상이 정해지지 않아 recall 대조 문자열을 만들 수 없습니다."
                : "런타임이 이 요구사항의 대상을 기록하지 않아 대조 문자열이 없습니다.",
          });
          continue;
        }
        if (!turn.text.includes(spec.target)) {
          notMapped.push({
            subject: spec.id,
            reason: "기록된 대상이 사용자의 말에 그대로 나타나지 않아 대조 문자열로 쓸 수 없습니다.",
          });
          continue;
        }
        requirements.push(spec.target);
      }

      // A tool this same turn forbids is not a sensible first action, whatever a
      // scenario about a later turn requires. Without this subtraction the
      // corrected turn above asked for `run_command` first — in a turn whose
      // whole point was that running is forbidden.
      const requiredTools = sorted(
        blueprints
          .flatMap((b) => b.oracle.requiredTools)
          .filter((tool) => !forbiddenTools.has(tool))
          .filter((tool) => !(forbids.includes("modify") && WRITE_TOOLS.has(tool))),
      );

      return {
        user: turn.text,
        expectedRelation: turn.relation,
        ...(requiredTools.length === 0 ? {} : { expectedFirstAction: requiredTools }),
        ...(forbids.length === 0 ? {} : { forbids }),
        ...(requirements.length === 0 ? {} : { requirements }),
        ...(exactSourcesOf(here).length === 0 ? {} : { exactSources: exactSourcesOf(here) }),
      };
    });

    const requiredEvidence = sorted(
      preview.scenarios.flatMap((b) => b.oracle.requiredEvidence),
    ) as EvalScenario["requiredEvidence"];

    // No `world`. Which files exist, what a command prints and what a page
    // contains are facts about a workspace, and a request does not carry them —
    // a shadow that filled them in would be scoring the agent against a world it
    // had made up.
    notMapped.push({
      subject: "world",
      reason: "요청만으로는 파일·명령 출력·페이지 내용을 알 수 없어 world 를 만들지 않습니다.",
    });

    const scenario: EvalScenario = {
      id: input.id,
      title: `${preview.turns[0]?.text.slice(0, 40) ?? input.id}`,
      about:
        `설계 미리보기에서 그림자 변환됨 — 요구사항 ${specs.length}개, ` +
        `설계 규칙 ${sorted(rules).length}개, 미해결 ${unresolved.length}건.`,
      turns,
      ...(requiredEvidence === undefined || requiredEvidence.length === 0 ? {} : { requiredEvidence }),
      // Not the plan's opinion of itself: `executable` is the audit's verdict,
      // and a plan that cannot start is one where finishing is not the point.
      completionExpected: preview.executable,
      // Zero-valued by construction, exactly as every hand-written fixture is.
      // The blueprints carry the same invariants, so this is a translation rather
      // than a decision.
      oracle: CLEAN,
    };

    return {
      status: "mapped",
      scenario,
      requirementSources,
      designRulesUsed: sorted(rules),
      oracleCoverage: sorted(coverage),
      unresolved,
      notMapped,
    };
  } catch (err) {
    // Never rethrown. See the header: a shadow that can break a turn is worse
    // than no shadow.
    return empty("adapter_failed", {
      failure: "adapter_threw",
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  }
}

/** Hostnames a source requirement named, read from the requirement's own text. */
function exactSourcesOf(specs: readonly RequirementSpec[]): string[] {
  return sorted(
    specs
      .filter((spec) => spec.derivedBy === "runtime_source")
      .map((spec) => spec.text.split(" ")[0] ?? "")
      .filter((host) => host.length > 0),
  );
}
