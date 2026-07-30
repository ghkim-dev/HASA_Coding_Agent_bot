import { z } from "zod";

/** Phase 1 ships `response` only. `code` lands in Phase 2. */
export const RunModeSchema = z.enum(["response", "code"]);
export type RunMode = z.infer<typeof RunModeSchema>;

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "evaluating",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const CandidateStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "excluded",
]);
export type CandidateStatus = z.infer<typeof CandidateStatusSchema>;

/**
 * Sampling settings shared by every candidate in a run.
 *
 * Fairness is structural: these live on the run, not on the candidate, so the
 * default path cannot produce an unfair comparison. Per-candidate `overrides`
 * exist only so that `assertFairness` has something to reject — see
 * docs/evaluation-protocol.md §1.
 */
export const SamplingSchema = z.object({
  temperature: z.number().min(0).max(2).default(0.2),
  topP: z.number().min(0).max(1).default(1),
  maxOutputTokens: z.number().int().positive().max(131072).default(2048),
});
export type Sampling = z.infer<typeof SamplingSchema>;

/**
 * A machine-checkable assertion about a response.
 *
 * Response mode had no evidence but the judge's reading, which is why every
 * decided run there once carried a request for human review: with one axis and
 * no way to corroborate it, "the judge said so" was the whole case. These are
 * the second axis. They are deliberately dull — no model runs them, they take
 * no network and no filesystem, and they answer questions with only one right
 * answer.
 *
 * They are declared before any candidate runs and applied identically to all of
 * them, or they would be a fairness hole rather than a fairness aid.
 */
export const CheckSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("must_include"), items: z.array(z.string().min(1)).min(1).max(50) }),
  z.object({ kind: z.literal("must_not"), items: z.array(z.string().min(1)).min(1).max(50) }),
  /** The whole response, or its single fenced block, must parse as JSON. */
  z.object({ kind: z.literal("json_parses") }),
  z.object({ kind: z.literal("max_words"), limit: z.number().int().positive() }),
  z.object({ kind: z.literal("min_words"), limit: z.number().int().positive() }),
  z.object({
    kind: z.literal("regex"),
    pattern: z.string().min(1).max(500),
    flags: z.string().max(8).default("i"),
    /** Whether a match is the passing outcome. */
    expect: z.boolean().default(true),
  }),
]);
export type Check = z.infer<typeof CheckSchema>;

export const CheckResultSchema = z.object({
  index: z.number().int().nonnegative(),
  kind: z.string(),
  passed: z.boolean(),
  detail: z.string().max(1_000),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const TaskSpecSchema = z.object({
  prompt: z.string().min(1).max(200_000),
  systemPrompt: z.string().max(50_000).optional(),
  systemPromptVersion: z.string().default("response-compare-v1"),
  /** Free-form note shown to the judge as task context. Must not identify candidates. */
  rubric: z.string().max(4_000).optional(),
  /** Objective assertions. Empty means the run has only the judge to go on. */
  checks: z.array(CheckSchema).max(20).default([]),
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

export const CandidateInputSchema = z.object({
  modelId: z.string().min(1),
  overrides: SamplingSchema.partial().optional(),
});
export type CandidateInput = z.infer<typeof CandidateInputSchema>;

export const JudgeConfigSchema = z.object({
  modelId: z.string().min(1),
  /** Parse retries before the verdict is abandoned as `no_winner`. */
  maxParseRetries: z.number().int().min(0).max(5).default(2),
  temperature: z.number().min(0).max(2).default(0),
  /**
   * S2 — how many times a contested pair is re-judged by the same model at
   * `selfConsistencyTemperature`. Zero disables the rung.
   *
   * The point is not to keep asking until the answer is convenient. It is that
   * one disagreement between AB and BA does not distinguish "these two are
   * genuinely hard to separate" from "the judge was noisy once", and those have
   * different right answers. Repetition measures which one it was.
   */
  selfConsistencyRounds: z.number().int().min(0).max(9).default(3),
  /** Zero would just reproduce the same disagreement; the rung needs variance. */
  selfConsistencyTemperature: z.number().min(0).max(2).default(0.7),
  /** Fraction of rounds that must agree before S2 is allowed to settle a pair. */
  agreementThreshold: z.number().min(0.5).max(1).default(0.67),
  /** S3 — other judge models consulted when the first one cannot settle it. */
  ensemble: z.array(z.string().min(1)).max(4).default([]),
  /**
   * Ceiling on judge calls for the whole run.
   *
   * A ladder without one turns every ambiguous pair into an open-ended bill.
   * Running out is reported as `budget_exhausted`, never as `undecidable` —
   * the first is a money problem that more budget fixes and the second is a
   * knowledge problem that it does not.
   */
  maxJudgeCalls: z.number().int().min(2).max(500).default(60),
  /**
   * Starting output budget. Doubled on a retry whose response came back empty
   * or truncated: reasoning-style models spend tokens before emitting anything
   * visible, and a verdict cut off mid-JSON is indistinguishable from a model
   * that cannot produce JSON at all.
   */
  maxOutputTokens: z.number().int().min(256).max(32_768).default(2048),
});
export type JudgeConfig = z.infer<typeof JudgeConfigSchema>;

/**
 * Turns the run from a tournament into a search.
 *
 * Absent, the run picks the best of N independent samples. Present, it then
 * tries to beat that winner with neighbours built from a critique of it, and
 * stops when it cannot — which is the only form in which "locally optimal" is
 * a claim rather than a figure of speech.
 */
export const RefineConfigSchema = z.object({
  /** Must differ from the judge and from every candidate. See core/refine.ts. */
  criticModelId: z.string().min(1),
  /** Zero disables refinement while leaving the config in the record. */
  maxRounds: z.number().int().min(0).max(5).default(2),
  temperature: z.number().min(0).max(2).default(0.2),
  maxOutputTokens: z.number().int().min(256).max(32_768).default(1024),
});
export type RefineConfig = z.infer<typeof RefineConfigSchema>;

export const RoundRecordSchema = z.object({
  round: z.number().int().positive(),
  neighbourLabel: z.string(),
  defects: z.array(z.string()),
  replaced: z.boolean(),
  detail: z.string(),
});
export type RoundRecord = z.infer<typeof RoundRecordSchema>;

export const CreateRunRequestSchema = z.object({
  mode: RunModeSchema.default("response"),
  taskSpec: TaskSpecSchema,
  candidates: z.array(CandidateInputSchema).min(2).max(8),
  sampling: SamplingSchema.default({
    temperature: 0.2,
    topP: 1,
    maxOutputTokens: 2048,
  }),
  judge: JudgeConfigSchema,
  refine: RefineConfigSchema.optional(),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

/** Fully resolved, persisted candidate configuration. */
export const CandidateSpecSchema = z.object({
  candidateId: z.string(),
  /** Stable public label (`cand-a`). Never shown to the judge. */
  label: z.string(),
  modelId: z.string(),
  systemPromptVersion: z.string(),
  temperature: z.number(),
  topP: z.number(),
  maxOutputTokens: z.number().int(),
  runtimeAdapter: z.literal("response"),
});
export type CandidateSpec = z.infer<typeof CandidateSpecSchema>;

export const MAX_REASON_CHARS = 600;
export const MAX_REASONS = 5;

/**
 * Verbosity is a formatting difference, not an invalid verdict.
 *
 * An earlier version rejected any reason longer than 400 characters, which
 * threw away well-formed judgments whose prose happened to run long — and at
 * temperature 0 the retry produced the identical text, so the run ended in
 * `no_winner` despite the judge having been decisive and consistent. Length is
 * now normalised, and only genuinely absurd payloads are refused.
 */
const ReasonSchema = z
  .string()
  .min(1)
  .max(8_000)
  .transform((s) => (s.length > MAX_REASON_CHARS ? `${s.slice(0, MAX_REASON_CHARS - 1)}…` : s));

const ReasonListSchema = z
  .array(ReasonSchema)
  .min(1)
  .max(50)
  .transform((list) => list.slice(0, MAX_REASONS));

export const JudgeVerdictSchema = z.object({
  /** 1 or 2 refer to presentation slots, never to candidates. */
  winner: z.union([z.literal(1), z.literal(2), z.null()]),
  confidence: z.number().min(0).max(1),
  reasons: ReasonListSchema,
  concerns: z
    .object({
      submission1: ReasonListSchema.optional(),
      submission2: ReasonListSchema.optional(),
    })
    .optional(),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export const RunOutcomeSchema = z.enum(["winner", "no_winner"]);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

/**
 * Why a verdict cannot stand on its own.
 *
 * `null` means the run reached a conclusion it can defend — not that the diff
 * should be applied unread. Applying always requires explicit approval, which
 * is a question of *authority* over the user's repository, not of the system's
 * confidence. Conflating the two made this flag true in almost every branch,
 * at which point it distinguished nothing and merely moved blame.
 */
export const ReviewReasonSchema = z.enum([
  /** One candidate cleared the gates, so no comparison actually happened. */
  "never_compared",
  /** The ladder settled on "these are equal". A conclusion, not a failure. */
  "tie",
  /**
   * No judge produced a parseable verdict, so there is nothing to be uncertain
   * about — the instrument never took a reading. Separate from `undecidable`
   * because a larger budget or another model fixes this and evidence does not.
   */
  "judge_unavailable",
  /**
   * Every rung of the ladder ran and the candidates are still not separated.
   * `ladderTrace` records what was attempted, which is what makes handing this
   * to a person a report rather than a shrug.
   */
  "undecidable",
  /** The call ceiling was reached first. Undecided, but not shown to be hard. */
  "budget_exhausted",
]);
export type ReviewReason = z.infer<typeof ReviewReasonSchema>;

/** Rungs of the decision ladder. See docs/redesign-plan.md §2.1. */
export const LadderStageSchema = z.enum(["S0", "S1", "S2", "S3", "S4"]);
export type LadderStage = z.infer<typeof LadderStageSchema>;

export const LadderStepSchema = z.object({
  stage: LadderStageSchema,
  pair: z.string(),
  winnerLabel: z.string().nullable(),
  /** `unstable` = it contradicted itself; `unavailable` = it never answered. */
  failure: z.enum(["unavailable", "unstable"]).nullable(),
  /** How often the rung's repetitions agreed. Only S2 and S3 report this. */
  agreement: z.number().nullable().default(null),
  judgeCalls: z.number().int(),
  detail: z.string(),
});
export type LadderStep = z.infer<typeof LadderStepSchema>;

/**
 * Which kinds of evidence the run had available at all.
 *
 * This is a property of the mode, not of the verdict: response mode has no
 * build to run, so `["judge"]` is true of every response run ever made. It
 * used to be reported per-run as `reviewReason: "judge_only"`, which meant the
 * field was non-null in every decided response run and therefore carried no
 * information — the exact defect that had already been removed from code mode.
 * Constant facts belong in metadata; `reviewReason` answers a question whose
 * answer varies.
 */
export const EvidenceAxisSchema = z.enum(["objective", "judge"]);
export type EvidenceAxis = z.infer<typeof EvidenceAxisSchema>;

export const RunResultSchema = z.object({
  outcome: RunOutcomeSchema,
  winnerCandidateId: z.string().nullable(),
  winnerLabel: z.string().nullable(),
  confidence: z.enum(["sole_survivor", "objective", "judge"]).nullable(),
  reason: z.string(),
  /** Null when the verdict is self-supporting. See ReviewReasonSchema. */
  reviewReason: ReviewReasonSchema.nullable().default(null),
  /** Derived: `reviewReason !== null`. Kept for display convenience. */
  requiresHumanReview: z.boolean(),
  /** What could corroborate this verdict. See EvidenceAxisSchema. */
  evidenceAxes: z.array(EvidenceAxisSchema).default(["judge"]),
  /** Which rung settled it, `null` when none did. */
  decidedAt: LadderStageSchema.nullable().default(null),
  /** Everything the ladder attempted, in order. The receipt for `reviewReason`. */
  ladderTrace: z.array(LadderStepSchema).default([]),
  judgeCallsSpent: z.number().int().default(0),
  /** Refinement rounds actually run. Empty when the run was a plain tournament. */
  rounds: z.array(RoundRecordSchema).default([]),
  /**
   * Why refinement stopped. `neighbour_not_better` is the interesting one: it
   * is the run reporting that it built an alternative and the alternative lost,
   * which is what makes the winner a measured local optimum rather than an
   * unexamined pick.
   */
  convergedBy: z
    .enum([
      "no_defects_found",
      "neighbour_not_better",
      "round_budget",
      "critic_unavailable",
      "neighbour_failed",
    ])
    .nullable()
    .default(null),
});
export type RunResult = z.infer<typeof RunResultSchema>;

/**
 * SSE payloads.
 *
 * There is deliberately no field anywhere in this union that can carry an API
 * key, a system prompt, or a raw request body. The browser is outside the trust
 * boundary (docs/security-policy.md §1.3), so the type system is the first
 * line of defence rather than a runtime filter.
 */
export type ArenaEvent =
  | { type: "run.status"; runId: string; status: RunStatus; at: number }
  | {
      type: "candidate.status";
      runId: string;
      candidateId: string;
      label: string;
      status: CandidateStatus;
      at: number;
      excludedReason?: string;
    }
  | {
      type: "candidate.progress";
      runId: string;
      candidateId: string;
      label: string;
      phase: "queued" | "requesting" | "streaming" | "done";
      at: number;
    }
  | {
      type: "gate.result";
      runId: string;
      candidateId: string;
      gate: string;
      passed: boolean;
      durationMs: number;
      at: number;
    }
  | {
      type: "judge.progress";
      runId: string;
      pair: string;
      order: "AB" | "BA";
      attempt: number;
      at: number;
    }
  | {
      type: "run.result";
      runId: string;
      result: RunResult;
      at: number;
    }
  | {
      type: "error";
      runId: string;
      scope: "run" | "candidate" | "judge";
      code: string;
      retryable: boolean;
      candidateId?: string;
      at: number;
    };
