import { z } from "zod";
import { CandidateInputSchema, JudgeConfigSchema, SamplingSchema } from "./run.ts";

/**
 * Code-candidate mode.
 *
 * The shape enforces the two rules that make the mode safe: every command a
 * candidate may run is declared up front, and nothing here can name a path
 * outside the repository.
 */

export const GATE_NAMES = [
  "no_change",
  "patch_applies",
  "install",
  "build",
  "test",
  "typecheck",
  "lint",
  "security",
  "diff_size",
  "cost",
] as const;
export type GateName = (typeof GATE_NAMES)[number];

/** Gates whose failure removes a candidate outright. */
export const HARD_GATES: GateName[] = ["no_change", "patch_applies", "build", "test"];

/**
 * `run` is not a gate in the Arena's sense — nothing is scored by it and it
 * appears in no `HARD_GATES`. It exists because the coding agent's allowlist
 * uses this same shape, and "run the program the user is looking at" is the
 * request a beginner actually makes.
 */
export const COMMAND_GATES = ["install", "build", "test", "typecheck", "lint", "run"] as const;
export type CommandGate = (typeof COMMAND_GATES)[number];

/**
 * Why a command exists changes how its baseline result is read.
 *
 * `regression` — should already pass at the base commit. If it does not, the
 * repository was broken before the run and no candidate may be blamed for it.
 *
 * `acceptance` — encodes the requested behaviour, so it is *expected* to fail
 * at the base commit. Excusing a candidate's failure here would let a candidate
 * that changed nothing useful pass the gate that defines the task.
 */
export const CommandKindSchema = z.enum(["regression", "acceptance"]);
export type CommandKind = z.infer<typeof CommandKindSchema>;

export const CommandSpecSchema = z.object({
  gate: z.enum(COMMAND_GATES),
  kind: CommandKindSchema.default("regression"),
  /** Executable name only. Never a shell line. */
  cmd: z.string().min(1).max(200),
  args: z.array(z.string().max(500)).max(50).default([]),
  timeoutMs: z.number().int().min(1_000).max(1_800_000).default(300_000),
});
export type CommandSpec = z.infer<typeof CommandSpecSchema>;

export const CodeTaskSpecSchema = z.object({
  prompt: z.string().min(1).max(200_000),
  systemPrompt: z.string().max(50_000).optional(),
  systemPromptVersion: z.string().default("coding-agent-v1"),
  rubric: z.string().max(4_000).optional(),
  /**
   * Ordered. Every command a candidate is permitted to run, and the only ones
   * the evaluator executes. An empty list means the run is judged on the diff
   * alone — allowed, but the objective gates then have very little to say.
   */
  acceptanceCommands: z.array(CommandSpecSchema).max(10).default([]),
  /** Repo-relative path prefixes a candidate may write to. Empty = whole tree. */
  writeScope: z.array(z.string().min(1).max(400)).max(50).default([]),
  /** Files handed to patch-mode candidates as context. */
  contextFiles: z.array(z.string().min(1).max(400)).max(50).default([]),
  /** Used to scale the diff-size penalty. */
  expectedDiffLines: z.number().int().positive().max(100_000).optional(),
  maxToolCalls: z.number().int().min(1).max(200).default(30),
  maxCommandRuns: z.number().int().min(0).max(50).default(20),
  candidateTimeoutMs: z.number().int().min(10_000).max(3_600_000).default(900_000),
  /** Retries for a candidate that fails for a transient reason. */
  maxCandidateRetries: z.number().int().min(0).max(3).default(1),
});
export type CodeTaskSpec = z.infer<typeof CodeTaskSpecSchema>;

export const RuntimeAdapterSchema = z.enum(["agent", "patch"]);
export type RuntimeAdapter = z.infer<typeof RuntimeAdapterSchema>;

export const CreateCodeRunRequestSchema = z.object({
  mode: z.literal("code"),
  /** Absolute path to the git repository root. */
  repoRoot: z.string().min(1),
  taskSpec: CodeTaskSpecSchema,
  candidates: z.array(CandidateInputSchema).min(2).max(6),
  sampling: SamplingSchema.default({ temperature: 0.2, topP: 1, maxOutputTokens: 4096 }),
  judge: JudgeConfigSchema,
  /**
   * Which runtime every candidate uses. Mixed runtimes are refused by the
   * fairness contract — see docs/evaluation-protocol.md §1.
   */
  runtimeAdapter: RuntimeAdapterSchema.default("agent"),
});
export type CreateCodeRunRequest = z.infer<typeof CreateCodeRunRequestSchema>;

export const GateResultSchema = z.object({
  gate: z.enum(GATE_NAMES),
  passed: z.boolean(),
  hard: z.boolean(),
  detail: z.string().max(2_000),
  durationMs: z.number().int().nonnegative(),
  /** Set when the gate passed only after a retry. */
  flaky: z.boolean().default(false),
});
export type GateResult = z.infer<typeof GateResultSchema>;

export const CandidateArtifactsSchema = z.object({
  diffPath: z.string().nullable(),
  diffLines: z.number().int().nonnegative(),
  changedFiles: z.array(z.string()),
  outOfScopeFiles: z.array(z.string()),
  commands: z.array(
    z.object({
      gate: z.string(),
      cmd: z.string(),
      args: z.array(z.string()),
      exitCode: z.number().nullable(),
      timedOut: z.boolean(),
      durationMs: z.number(),
    }),
  ),
  toolCalls: z.number().int().nonnegative(),
  worktreePath: z.string().nullable(),
  attempts: z.number().int().positive(),
});
export type CandidateArtifacts = z.infer<typeof CandidateArtifactsSchema>;

export const ApplyRequestSchema = z.object({
  candidateId: z.string().min(1),
  /** Must match the run's base commit; guards against an intervening commit. */
  expectedBaseCommit: z.string().min(7),
});
export type ApplyRequest = z.infer<typeof ApplyRequestSchema>;

export const ApplyResultSchema = z.object({
  applied: z.boolean(),
  candidateId: z.string(),
  label: z.string(),
  changedFiles: z.array(z.string()),
  /** Stash ref holding the pre-apply working tree, when one was needed. */
  revertRef: z.string().nullable(),
  baseCommit: z.string(),
});
export type ApplyResult = z.infer<typeof ApplyResultSchema>;
