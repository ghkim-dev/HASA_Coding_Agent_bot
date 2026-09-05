import { prohibitionsIn } from "../agent/statedProhibitions.ts";
import { exactSourcesIn } from "../agent/sourceProvenance.ts";
import type { TurnRelation } from "../agent/turnContract.ts";
import type { ActionKind } from "./functionalExtract.ts";
import { executionReadiness, runtimeRequirements, type RequirementPolarity } from "./requirementSpec.ts";
import { relationOf, type PreviewResult } from "./preview.ts";
import { questionsFrom } from "./previewReport.ts";
import type { FindingCode } from "./coverageAudit.ts";

/**
 * Answers written down before the system was asked, so a rate means something.
 *
 * What was here before was `expect` blocks on sixteen fixtures, and every one of
 * them was a *floor*: `mustContainKinds`, `mustNotInvent`, `maxQuestions`. A
 * floor is a useful regression guard and it cannot produce a recall or a
 * precision, because neither has a denominator until somebody writes down the
 * complete answer. `previewMetrics` was honest about this — it listed
 * `requirementRecall` under `unmeasured` rather than printing a number — and
 * that honesty is the thing this file is here to end, by supplying the missing
 * half rather than by relaxing the standard.
 *
 * ## What a gold case records
 *
 * Per turn: the requirements a careful reader finds in it, each with its
 * polarity, its act, its target, and the words it is grounded in — plus how the
 * turn relates to the one before it. Per case: the questions the plan should
 * ask, and whether a run could start with nothing further from the user.
 *
 * ## Written from the sentence, not from the output
 *
 * The gold says what the Korean means. Where the extractor is known to fall
 * short of that, the miss is listed in `KNOWN_MISSES` with a reason and a
 * verdict — `by_design` for a limitation this codebase argued for on purpose,
 * `defect` for one that is simply wrong. A gold set edited until it matches the
 * implementation measures nothing but the implementation's self-consistency, so
 * misses are recorded rather than removed.
 *
 * ## What stays unmeasured
 *
 * Anything this set does not pin down keeps saying so. `UNMEASURED` below is
 * part of the output, not a footnote: a missing number that is named is a piece
 * of information, and one replaced by a zero is a lie with a decimal point.
 */

/** The acts a requirement can ask for, including the two that forbid. */
export type GoldAction =
  | ActionKind
  | "forbid_execute"
  | "forbid_modify"
  /** Read a named external source and report only what it said. */
  | "read_source";

export interface GoldRequirement {
  action: GoldAction;
  polarity: RequirementPolarity;
  /**
   * What the act applies to, exactly as the sentence names it — or null when the
   * sentence names none.
   *
   * `null` is an answer, not a gap: Korean drops the object constantly, and a
   * gold that filled it in would be scoring the extractor for inventing.
   */
  target: string | null;
  /** The words this requirement is grounded in. Must fall inside its span. */
  quote: string;
}

export interface GoldTurn {
  text: string;
  relation: TurnRelation;
  requirements: readonly GoldRequirement[];
}

export type GoldCategory =
  | "explicit"
  | "prohibition"
  | "correction"
  | "refinement"
  | "question"
  | "continuation"
  | "compound"
  | "particle"
  | "omitted_object"
  | "past_failure"
  | "conditional"
  | "preserve"
  | "inspect"
  | "mixed_script"
  | "wrong_binding"
  | "question_restraint"
  | "no_invention";

export interface GoldCase {
  id: string;
  category: GoldCategory;
  /** Why this case is in the set. One sentence, in the sentence's own terms. */
  why: string;
  turns: readonly GoldTurn[];
  questions: {
    /**
     * Every code the plan should raise for this case, and nothing else.
     *
     * The complete answer, so a question outside it is a false positive and a
     * missing one is a false negative. An empty list means the plan should ask
     * nothing at all.
     */
    expected: readonly FindingCode[];
    /** How many questions a person should be asked here, at most. */
    max: number;
  };
  /**
   * Whether the *request* was understood well enough to begin.
   *
   * Judged by the definition in `executionReadiness`: at least one requirement,
   * every one of them grounded, intended, targeted, unconditional and
   * unconflicted. This is a claim about reading Korean, and nothing else.
   */
  startable: boolean;
  /**
   * Whether the *harness* could run it — a different claim, kept separate.
   *
   * Startability says the sentence was understood. Executability additionally
   * requires that every requirement have a verification rule with a runtime
   * oracle behind it, and that the audit found nothing it could not close. The
   * two were reported as one number, which made "we understood the request" read
   * as "we can safely run it": `startability 42/43` said nothing about whether a
   * single one of those plans was runnable.
   *
   * Answered here by the definition rather than by observation — startable, plus a
   * design rule for every requirement — so the cross-tabulation in `GoldScore` can
   * show where the engine disagrees.
   */
  executable: boolean;
}

/** Codes that must never be asked about a verb the user wrote themselves. */
export const NEVER_ASKED: readonly FindingCode[] = ["AMBIGUOUS_DECIDED"];

export interface KnownGap {
  caseId: string;
  /** Which measurement it costs. */
  axis: "requirement" | "target" | "question" | "startability";
  /** Whether this is a decision or a bug. Only the second one is a to-do. */
  verdict: "defect" | "by_design";
  reason: string;
}

/**
 * Where the gold and the implementation still disagree **on these four axes**,
 * with a verdict.
 *
 * Listed rather than removed, and the test asserts this list is *exactly* the
 * set of disagreements — so closing one of these means deleting a line here, and
 * opening a new one fails the build. A gold set with no such table is a gold set
 * that was edited until it agreed.
 *
 * The four axes are the four in `KnownGap.axis`, and that is not every axis this
 * set scores. `relation` is measured — 47 of 48 — and cannot be written down
 * here, so the sentence above said "exactly the set of disagreements" while
 * being silent about a whole axis with a live mismatch in it. The other half
 * lives in `RELATION_AS_BUILT` in the test file, under the same discipline: a
 * verdict, a reason longer than a line, a key that has to name a real turn, and
 * a check that refuses a row agreeing with the gold.
 *
 * Two tables rather than one because a relation is a property of a turn and a
 * `KnownGap` is a property of a case, and merging them would have to invent a
 * shape for one of the two. What keeps a new relation mismatch from hiding is
 * not this table: it is the pinned `47/48` and the per-turn test, which fail
 * together the moment a turn is read differently.
 */
export const KNOWN_MISSES: readonly KnownGap[] = [
  // Empty, and that is a measurement rather than a claim: the test below asserts
  // this list is *exactly* the set of remaining disagreements, so an empty table
  // is only green while every one of the 43 cases agrees on all nine axes.
  //
  // The two entries that were here — `preserve-and-modify` on questions and on
  // startability — were one defect: `markConflicts` could not see a rename that
  // contradicts a keep, because `sharedSubject` filters `이름` out of its noun
  // list and `이름` is the noun those two sentences share. Closed by reading the
  // acts and their targets instead of two texts sharing a word; see `actsCollide`
  // in `requirementSpec.ts`.
];

/**
 * What this gold set does not answer, named so nobody reads a zero into it.
 *
 * Each line is a metric that would need an annotation this set does not carry.
 * Adding a number here without adding the annotation is the failure mode the
 * whole file exists to prevent.
 */
export const UNMEASURED: readonly string[] = [
  "priority(must/should/may) — 정답 우선순위를 기록하지 않았다",
  "kind(functional/validation/…) — 정답 분류를 기록하지 않았다",
  "span 정확도 — 근거 구간의 포함만 확인하고, 최소 구간인지는 기록하지 않았다",
  "모델 제안의 recall/precision — Gold 는 오프라인 추출기만 대상으로 한다",
  "Oracle coverage — 요구사항별 검증 규칙의 정답은 designRules 쪽에서 따로 센다",
  "다중 턴 요구사항 승계 — merge 후 남아야 하는 집합의 정답을 기록하지 않았다",
];

// ---------------------------------------------------------------------------
// What the runtime actually extracted, on the same axes
// ---------------------------------------------------------------------------

export interface ExtractedRequirement {
  specId: string;
  action: GoldAction;
  polarity: RequirementPolarity;
  target: string | null;
  /** The words the runtime cut for it. */
  sourceText: string;
  ready: boolean;
}

/**
 * Reads one turn's extraction onto the gold's axes.
 *
 * Uses only exported behaviour — `runtimeRequirements` for the requirements and
 * the act and target it recorded, `prohibitionsIn` and `exactSourcesIn` for the
 * other two origins. Nothing here parses an id: an id is an identifier, and
 * reading `t1-act-modify-1` for the word `modify` would make the measurement
 * depend on a naming convention rather than on behaviour.
 */
export function readExtraction(input: { turnId: string; text: string }): ExtractedRequirement[] {
  const specs = runtimeRequirements(input);
  // Same order the requirements were pushed in, because both iterate the same
  // sets in the same direction.
  const prohibitions = [...prohibitionsIn(input.text)];
  const sources = exactSourcesIn(input.text);
  let prohibitionAt = 0;
  let sourceAt = 0;

  const out: ExtractedRequirement[] = [];
  for (const spec of specs) {
    const common = {
      specId: spec.id,
      polarity: spec.polarity,
      sourceText: spec.sourceText,
      ready: executionReadiness(spec) === "ready",
    };
    switch (spec.derivedBy) {
      case "runtime_prohibition": {
        const klass = prohibitions[prohibitionAt];
        prohibitionAt += 1;
        out.push({
          ...common,
          action: klass === "execute" ? "forbid_execute" : "forbid_modify",
          // A prohibition's target is the act class itself, which is not a
          // sentence target. Recorded as none so it cannot match a positive
          // requirement's target by accident.
          target: null,
        });
        break;
      }
      case "runtime_action": {
        out.push({ ...common, action: spec.act ?? "inspect", target: spec.target ?? null });
        break;
      }
      case "runtime_source": {
        const source = sources[sourceAt];
        sourceAt += 1;
        out.push({ ...common, action: "read_source", target: source?.hostname ?? null });
        break;
      }
      default:
        // A model proposal cannot appear here: `runtimeRequirements` is the
        // offline path and this gold set scores only that.
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matching, and the four rates it supports
// ---------------------------------------------------------------------------

export interface Ratio {
  hit: number;
  of: number;
  /** Null rather than zero when the denominator is empty. */
  value: number | null;
}

const ratio = (hit: number, of: number): Ratio => ({
  hit,
  of,
  value: of === 0 ? null : Math.round((hit / of) * 1000) / 1000,
});

/** Whitespace-normalised, because "로그인  오류" and "로그인 오류" are one target. */
function normaliseTarget(target: string | null): string | null {
  return target === null ? null : target.replace(/\s+/g, " ").trim();
}

export interface Pairing {
  gold: GoldRequirement;
  got: ExtractedRequirement | null;
  /** Whether the runtime's own words cover the gold's quote. */
  grounded: boolean;
  targetMatch: boolean;
}

/**
 * Pairs a turn's gold requirements with what came out, one to one.
 *
 * Identity is the act and its polarity — that is what makes two requirements the
 * same requirement. Target and grounding are then *measured* over the pairs
 * rather than being part of the key: folding them in would report a wrong target
 * as a missing requirement, and those are two different failures with two
 * different fixes.
 *
 * Preference decides between several candidates of the same act, so a turn with
 * two `inspect`s pairs each with the one whose words it actually came from.
 */
export function pairRequirements(
  gold: readonly GoldRequirement[],
  got: readonly ExtractedRequirement[],
): { pairs: Pairing[]; unmatched: ExtractedRequirement[] } {
  const used = new Set<number>();
  const pairs: Pairing[] = [];

  for (const want of gold) {
    let best: { index: number; score: number } | null = null;
    got.forEach((candidate, index) => {
      if (used.has(index)) return;
      if (candidate.action !== want.action || candidate.polarity !== want.polarity) return;
      const grounded = candidate.sourceText.includes(want.quote);
      const sameTarget = normaliseTarget(candidate.target) === normaliseTarget(want.target);
      const score = (grounded ? 2 : 0) + (sameTarget ? 1 : 0);
      if (best === null || score > best.score) best = { index, score };
    });

    if (best === null) {
      pairs.push({ gold: want, got: null, grounded: false, targetMatch: false });
      continue;
    }
    const chosen = got[(best as { index: number }).index];
    used.add((best as { index: number }).index);
    pairs.push({
      gold: want,
      got: chosen ?? null,
      grounded: chosen?.sourceText.includes(want.quote) ?? false,
      targetMatch: normaliseTarget(chosen?.target ?? null) === normaliseTarget(want.target),
    });
  }

  return { pairs, unmatched: got.filter((_, index) => !used.has(index)) };
}

export interface GoldScore {
  cases: number;
  turns: number;
  /** Gold requirements found, over gold requirements written down. */
  requirementRecall: Ratio;
  /** Extracted requirements that answer a gold one, over everything extracted. */
  requirementPrecision: Ratio;
  /** Matched pairs whose target agrees, over matched pairs. */
  targetAccuracy: Ratio;
  /** Matched pairs whose cut words cover the gold quote, over matched pairs. */
  spanGrounding: Ratio;
  /** Turns whose relation was read correctly, over turns. */
  relationAccuracy: Ratio;
  /** Expected questions that were asked, over expected questions. */
  questionRecall: Ratio;
  /** Asked questions that were expected, over questions asked. */
  questionPrecision: Ratio;
  /** Cases within their question ceiling, over cases. */
  questionCeiling: Ratio;
  /**
   * Cases whose *requirement startability* was read correctly, over cases.
   *
   * A measure of reading the request. Not a measure of whether anything could
   * safely run — see `harnessExecutability`, which is the claim people actually
   * want when they read a number like this one.
   */
  requirementStartability: Ratio;
  /** Cases whose *harness executability* the engine got right, over cases. */
  harnessExecutability: Ratio;
  /**
   * The two axes crossed, because the interesting cases are the disagreements.
   *
   * `executableWithoutUserRequirement` must be zero. It is the invariant the
   * audit's `NO_USER_REQUIREMENT` finding exists for: a request holding nothing
   * but the harness's own baselines passed every check and came out ready to run.
   */
  cross: {
    startableNotExecutable: string[];
    executableNotStartable: string[];
    executableWithoutUserRequirement: string[];
  };
  /** Every gold requirement nothing answered, for naming rather than counting. */
  missed: Array<{ caseId: string; turnId: string; gold: GoldRequirement }>;
  /** Everything extracted that no gold requirement asked for. */
  spurious: Array<{ caseId: string; turnId: string; got: ExtractedRequirement }>;
  /** Questions asked that the case did not expect. */
  unexpectedQuestions: Array<{ caseId: string; code: FindingCode; subject: string }>;
  /** Expected questions that were never asked. */
  missingQuestions: Array<{ caseId: string; code: FindingCode }>;
  unmeasured: readonly string[];
}

/**
 * Scores the gold set against the offline extractor and the preview it feeds.
 *
 * `previews` is passed in rather than built here so the caller owns the async
 * boundary and so the same previews can be reused by other measurements — and
 * so this function stays pure and synchronous, which is what lets it run inside
 * an ordinary assertion.
 */
export function scoreGold(
  cases: readonly GoldCase[],
  previews: ReadonlyMap<string, PreviewResult>,
): GoldScore {
  let goldTotal = 0;
  let extractedTotal = 0;
  let matched = 0;
  let targetHits = 0;
  let groundedHits = 0;
  let turns = 0;
  let relationHits = 0;
  let expectedQuestions = 0;
  let askedQuestions = 0;
  let questionHits = 0;
  let withinCeiling = 0;
  let startableHits = 0;
  let executableHits = 0;
  const cross: GoldScore["cross"] = {
    startableNotExecutable: [],
    executableNotStartable: [],
    executableWithoutUserRequirement: [],
  };

  const missed: GoldScore["missed"] = [];
  const spurious: GoldScore["spurious"] = [];
  const unexpectedQuestions: GoldScore["unexpectedQuestions"] = [];
  const missingQuestions: GoldScore["missingQuestions"] = [];

  for (const gold of cases) {
    gold.turns.forEach((turn, index) => {
      const turnId = `t${index + 1}`;
      turns += 1;
      if (relationOf(turn.text, index === 0) === turn.relation) relationHits += 1;

      const got = readExtraction({ turnId, text: turn.text });
      goldTotal += turn.requirements.length;
      extractedTotal += got.length;

      const { pairs, unmatched } = pairRequirements(turn.requirements, got);
      for (const pair of pairs) {
        if (pair.got === null) {
          missed.push({ caseId: gold.id, turnId, gold: pair.gold });
          continue;
        }
        matched += 1;
        if (pair.targetMatch) targetHits += 1;
        if (pair.grounded) groundedHits += 1;
      }
      for (const extra of unmatched) spurious.push({ caseId: gold.id, turnId, got: extra });
    });

    // --- the questions, and whether a run could start ----------------------
    const preview = previews.get(gold.id);
    if (preview === undefined) continue;

    const asked = questionsFrom(preview);
    const expected = new Set(gold.questions.expected);
    expectedQuestions += expected.size;
    askedQuestions += asked.length;
    for (const question of asked) {
      if (expected.has(question.code)) questionHits += 1;
      else unexpectedQuestions.push({ caseId: gold.id, code: question.code, subject: question.subject });
    }
    for (const code of expected) {
      if (!asked.some((q) => q.code === code)) missingQuestions.push({ caseId: gold.id, code });
    }
    if (asked.length <= gold.questions.max) withinCeiling += 1;

    const startable = startableOf(preview);
    if (startable === gold.startable) startableHits += 1;
    if (preview.executable === gold.executable) executableHits += 1;

    // The two axes crossed. Read from the engine's own verdicts, so a
    // disagreement names a case rather than moving a decimal.
    if (startable && !preview.executable) cross.startableNotExecutable.push(gold.id);
    if (preview.executable && !startable) cross.executableNotStartable.push(gold.id);
    const own = preview.requirements.filter(
      (spec) => spec.status !== "system_added" && spec.supersededBy === undefined,
    );
    if (own.length === 0 && preview.executable) cross.executableWithoutUserRequirement.push(gold.id);
  }

  // Recall counts the gold rows an extraction answered; precision counts the
  // extracted rows that answered one. The two share a numerator on purpose —
  // one-to-one pairing is what makes that legitimate — and never a denominator.
  return {
    cases: cases.length,
    turns,
    requirementRecall: ratio(matched, goldTotal),
    requirementPrecision: ratio(matched, extractedTotal),
    targetAccuracy: ratio(targetHits, matched),
    spanGrounding: ratio(groundedHits, matched),
    relationAccuracy: ratio(relationHits, turns),
    // Over distinct expected codes per case, which is what `expected` is a set
    // of. Two `TARGET_UNRESOLVED` questions in one case answer one expectation.
    questionRecall: ratio(expectedQuestions - missingQuestions.length, expectedQuestions),
    questionPrecision: ratio(questionHits, askedQuestions),
    questionCeiling: ratio(withinCeiling, cases.length),
    requirementStartability: ratio(startableHits, cases.length),
    harnessExecutability: ratio(executableHits, cases.length),
    cross,
    missed,
    spurious,
    unexpectedQuestions,
    missingQuestions,
    unmeasured: UNMEASURED,
  };
}

/**
 * Whether a run could start on this plan, by the requirement-level definition.
 *
 * The engine's own `executable` is stricter — it also demands that every
 * requirement have a verification rule — and that half is measured where the
 * rules are, not here. Mixing the two would let a missing design rule read as a
 * misunderstood sentence.
 */
export function startableOf(preview: PreviewResult): boolean {
  const own = preview.requirements.filter(
    (spec) => spec.status !== "system_added" && spec.supersededBy === undefined,
  );
  if (own.length === 0) return false;
  return own.every((spec) => executionReadiness(spec) === "ready");
}
