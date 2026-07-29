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
