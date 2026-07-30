import type { CandidateInput, CandidateSpec, JudgeConfig, Sampling, TaskSpec } from "../protocol/index.ts";

/**
 * The fairness contract.
 *
 * A comparison in which candidates differ by anything other than `modelId` is
 * not a model comparison, and no amount of downstream judging repairs that.
 * So this runs before a run is accepted and rejects with 400 — a run that
 * cannot be fair is never started.
 *
 * See docs/evaluation-protocol.md §1.
 */
export class FairnessError extends Error {
  readonly violations: string[];

  constructor(violations: string[]) {
    super(`unfair run configuration: ${violations.join("; ")}`);
    this.name = "FairnessError";
    this.violations = violations;
  }
}

export interface FairnessInput {
  candidates: CandidateInput[];
  sampling: Sampling;
  judge: JudgeConfig;
}

export function assertFairness(input: FairnessInput): void {
  const violations: string[] = [];
  const { candidates, sampling, judge } = input;

  if (candidates.length < 2) {
    violations.push("후보가 2개 미만이면 비교가 성립하지 않는다");
  }

  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.modelId)) {
      violations.push(`중복 모델: ${c.modelId} (self-consistency 모드에서만 허용)`);
    }
    seen.add(c.modelId);
  }

  for (const c of candidates) {
    for (const [key, value] of Object.entries(c.overrides ?? {})) {
      const shared = sampling[key as keyof Sampling];
      if (value !== undefined && value !== shared) {
        violations.push(
          `${c.modelId}의 ${key}=${String(value)}가 공통값 ${String(shared)}와 다르다 — 후보별 샘플링 차이는 허용되지 않는다`,
        );
      }
    }
  }

  if (seen.has(judge.modelId)) {
    violations.push(`judge 모델(${judge.modelId})이 후보에 포함되어 있다 — 자기 심사 금지`);
  }

  if (violations.length > 0) throw new FairnessError(violations);
}

/**
 * Fairness is a property of a comparison, not of a run.
 *
 * `assertFairness` above answers "is this a model comparison?" and is right to
 * demand that nothing but `modelId` varies. But a refinement round compares one
 * model's draft against the same model's revision, where the *input* is
 * deliberately different — under the run-level rule that comparison is unfair
 * by definition, and the loop it enables becomes inexpressible.
 *
 * So the question moves to the pair. Each kind names what must hold for its own
 * question to be answerable, and the two kinds never share a ranking: mixing
 * "which model is better" with "did this get better" contaminates both answers.
 */
export type ComparisonKind = "model" | "refinement";

export interface ComparableSide {
  modelId: string;
  temperature: number;
  topP: number;
  maxOutputTokens: number;
  systemPromptVersion: string;
}

export function assertComparable(a: ComparableSide, b: ComparableSide, kind: ComparisonKind): void {
  const violations: string[] = [];

  // Sampling and system prompt must match either way: they change the output
  // for reasons that have nothing to do with the question being asked.
  if (a.temperature !== b.temperature) violations.push(`temperature ${a.temperature} vs ${b.temperature}`);
  if (a.topP !== b.topP) violations.push(`topP ${a.topP} vs ${b.topP}`);
  if (a.maxOutputTokens !== b.maxOutputTokens) {
    violations.push(`maxOutputTokens ${a.maxOutputTokens} vs ${b.maxOutputTokens}`);
  }
  if (a.systemPromptVersion !== b.systemPromptVersion) {
    violations.push(`systemPromptVersion ${a.systemPromptVersion} vs ${b.systemPromptVersion}`);
  }

  if (kind === "model" && a.modelId === b.modelId) {
    violations.push(`같은 모델(${a.modelId})끼리는 모델 비교가 되지 않는다`);
  }
  if (kind === "refinement" && a.modelId !== b.modelId) {
    // Otherwise the round measures a model swap and reports it as an
    // improvement — the loop would "converge" on whichever model happened to
    // produce the neighbour.
    violations.push(`개선 비교인데 모델이 다르다: ${a.modelId} vs ${b.modelId}`);
  }

  if (violations.length > 0) throw new FairnessError(violations);
}

const LABEL_ALPHABET = "abcdefghijklmnopqrstuvwxyz";

export function labelFor(index: number): string {
  const letter = LABEL_ALPHABET[index];
  return `cand-${letter ?? String(index + 1)}`;
}

/**
 * Produces the persisted specs. Labels follow declaration order so a user can
 * map results back; execution order is randomised separately.
 */
export function resolveCandidateSpecs(
  runId: string,
  candidates: CandidateInput[],
  sampling: Sampling,
  taskSpec: TaskSpec,
): CandidateSpec[] {
  return candidates.map((c, index) => ({
    candidateId: `${runId}-${labelFor(index)}`,
    label: labelFor(index),
    modelId: c.modelId,
    systemPromptVersion: taskSpec.systemPromptVersion,
    temperature: sampling.temperature,
    topP: sampling.topP,
    maxOutputTokens: sampling.maxOutputTokens,
    runtimeAdapter: "response",
  }));
}

/**
 * Fisher-Yates over a caller-supplied RNG so tests can pin the order.
 * Execution order is randomised to blunt cache and warm-up advantages.
 */
export function shuffled<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}
