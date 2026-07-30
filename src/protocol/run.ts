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

export const TaskSpecSchema = z.object({
  prompt: z.string().min(1).max(200_000),
  systemPrompt: z.string().max(50_000).optional(),
  systemPromptVersion: z.string().default("response-compare-v1"),
  /** Free-form note shown to the judge as task context. Must not identify candidates. */
  rubric: z.string().max(4_000).optional(),
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
   * Starting output budget. Doubled on a retry whose response came back empty
   * or truncated: reasoning-style models spend tokens before emitting anything
   * visible, and a verdict cut off mid-JSON is indistinguishable from a model
   * that cannot produce JSON at all.
   */
  maxOutputTokens: z.number().int().min(256).max(32_768).default(2048),
});
export type JudgeConfig = z.infer<typeof JudgeConfigSchema>;

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
  /** The judge changed its answer when the presentation order flipped. */
  "unstable_judge",
  /** Nothing separated the candidates. */
  "tie",
  /** The judge decided, but on prose alone — no objective gate corroborated it. */
  "judge_only",
]);
export type ReviewReason = z.infer<typeof ReviewReasonSchema>;

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
