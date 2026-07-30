import type { JudgeConfig, ReviewReason } from "../protocol/index.ts";
import type { HasaClient } from "../hasa-client/client.ts";
import { nullLogger, type Logger } from "../hasa-client/logger.ts";
import { runJudge, type Submission } from "./judge.ts";

/**
 * The decision ladder.
 *
 * Both run managers used to carry their own copy of "judge this pair in both
 * orders, tally the wins, decide what the tally means" — two implementations of
 * one protocol, already drifting. They are one implementation here, so that the
 * ladder's later rungs can be added once rather than twice.
 *
 * The organising idea is that **deferring to a human is a conclusion, and a
 * conclusion needs evidence**. A run that gives up after a single disagreement
 * has not established that the question is hard; it has established that it
 * asked once. Each rung produces evidence at a cost, and `trace` records what
 * was actually spent, so "I could not decide" can be read back and checked.
 *
 * See docs/redesign-plan.md §2.1.
 */

/** Which question a comparison is answering. See docs/redesign-plan.md §2.3. */
export type ComparisonKind = "model" | "refinement";

export type LadderStage = "S0" | "S1" | "S2" | "S3" | "S4";

export type PairFailure = "unavailable" | "unstable" | null;

export interface DecisionSubject {
  id: string;
  /** Internal label (`cand-a`). Never reaches the judge. */
  label: string;
  text: string;
}

export interface LadderStep {
  stage: LadderStage;
  pair: string;
  winnerLabel: string | null;
  failure: PairFailure;
  judgeCalls: number;
  detail: string;
}

export interface VerdictRecord {
  pair: string;
  presentationOrder: "AB" | "BA";
  winnerLabel: string | null;
  confidence: number | null;
  reasons: string[];
  parseAttempts: number;
  rawResponses: string[];
}

export interface DecisionInput {
  taskPrompt: string;
  rubric?: string;
  /** Already scrubbed of anything that could identify a candidate. */
  subjects: DecisionSubject[];
  /** Terms asserted absent from the assembled judge prompt. */
  forbidden: string[];
  judge: JudgeConfig;
  kind: ComparisonKind;
}

export interface Decision {
  winnerLabel: string | null;
  winnerId: string | null;
  /** Which rung settled it. `null` when nothing did. */
  decidedAt: LadderStage | null;
  reviewReason: ReviewReason | null;
  trace: LadderStep[];
  /** Human-readable account, used as the run's `reason`. */
  detail: string;
}

export interface DecideOptions {
  logger?: Logger;
  signal?: AbortSignal;
  dispatch?: <T>(modelId: string, fn: () => Promise<T>) => Promise<T>;
  /** Persist one leg of one pair. Awaited, so ordering is the caller's. */
  onVerdict?: (record: VerdictRecord) => Promise<void> | void;
  onProgress?: (pair: string, order: "AB" | "BA") => void;
}

interface PairOutcome {
  pair: string;
  winnerLabel: string | null;
  /**
   * `null` when the pair was settled on the judge's own terms.
   *
   * `unavailable` and `unstable` stay apart because they call for opposite
   * remedies: a judge that never returned parseable JSON has said nothing about
   * the candidates and needs a bigger budget or a different model, while a judge
   * that answered twice and contradicted itself has measured its own
   * unreliability and needs more evidence, not more retries.
   */
  failure: PairFailure;
  judgeCalls: number;
  detail: string;
}

/**
 * One pair, both presentation orders.
 *
 * A judge that changes its mind when the submissions swap places has told us
 * nothing, so disagreement is recorded as instability rather than resolved by
 * picking one of the two answers.
 */
async function judgePair(
  client: HasaClient,
  input: DecisionInput,
  a: DecisionSubject,
  b: DecisionSubject,
  opts: DecideOptions,
): Promise<PairOutcome> {
  const pair = `${a.label}|${b.label}`;
  const subA: Submission = { label: a.label, text: a.text };
  const subB: Submission = { label: b.label, text: b.text };
  const legs: Array<{ order: "AB" | "BA"; first: Submission; second: Submission }> = [
    { order: "AB", first: subA, second: subB },
    { order: "BA", first: subB, second: subA },
  ];

  const decisions: Array<string | null> = [];
  let judgeCalls = 0;

  for (const leg of legs) {
    opts.onProgress?.(pair, leg.order);
    const result = await runJudge(
      client,
      input.judge,
      {
        taskPrompt: input.taskPrompt,
        ...(input.rubric ? { rubric: input.rubric } : {}),
        first: leg.first,
        second: leg.second,
        forbidden: input.forbidden,
      },
      {
        logger: opts.logger ?? nullLogger,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.dispatch ? { dispatch: opts.dispatch } : {}),
      },
    );
    judgeCalls += result.attempts;

    const decided =
      result.verdict === null || result.verdict.winner === null
        ? null
        : result.verdict.winner === 1
          ? leg.first.label
          : leg.second.label;

    await opts.onVerdict?.({
      pair,
      presentationOrder: leg.order,
      winnerLabel: decided,
      confidence: result.verdict?.confidence ?? null,
      reasons: result.verdict?.reasons ?? [result.failureReason ?? "unparseable"],
      parseAttempts: result.attempts,
      rawResponses: result.rawResponses,
    });

    if (!result.verdict) {
      return {
        pair,
        winnerLabel: null,
        failure: "unavailable",
        judgeCalls,
        detail: `${result.attempts}회 시도 후에도 판정 JSON을 얻지 못했다`,
      };
    }
    decisions.push(decided);
  }

  const [first, second] = decisions;
  if (first === null && second === null) {
    return { pair, winnerLabel: null, failure: null, judgeCalls, detail: "양쪽 순서 모두 tie" };
  }
  if (first !== second) {
    return {
      pair,
      winnerLabel: null,
      failure: "unstable",
      judgeCalls,
      detail: `AB=${first ?? "tie"} BA=${second ?? "tie"}`,
    };
  }
  return { pair, winnerLabel: first ?? null, failure: null, judgeCalls, detail: "AB/BA 일치" };
}

/** S1 — blind pairwise round robin. Every pair is judged in both orders. */
async function stageS1(
  client: HasaClient,
  input: DecisionInput,
  opts: DecideOptions,
): Promise<PairOutcome[]> {
  const outcomes: PairOutcome[] = [];
  for (let i = 0; i < input.subjects.length; i += 1) {
    for (let j = i + 1; j < input.subjects.length; j += 1) {
      const a = input.subjects[i];
      const b = input.subjects[j];
      if (!a || !b) continue;
      outcomes.push(await judgePair(client, input, a, b, opts));
    }
  }
  return outcomes;
}

function stepsOf(stage: LadderStage, outcomes: PairOutcome[]): LadderStep[] {
  return outcomes.map((o) => ({
    stage,
    pair: o.pair,
    winnerLabel: o.winnerLabel,
    failure: o.failure,
    judgeCalls: o.judgeCalls,
    detail: o.detail,
  }));
}

export async function decide(
  client: HasaClient,
  input: DecisionInput,
  opts: DecideOptions = {},
): Promise<Decision> {
  const outcomes = await stageS1(client, input, opts);
  const trace = stepsOf("S1", outcomes);
  const idOf = (label: string): string | null =>
    input.subjects.find((s) => s.label === label)?.id ?? null;

  const unavailable = outcomes.filter((o) => o.failure === "unavailable");
  if (unavailable.length > 0) {
    return {
      winnerLabel: null,
      winnerId: null,
      decidedAt: null,
      reviewReason: "judge_unavailable",
      trace,
      detail: `judge 응답을 판정으로 읽을 수 없었다: ${unavailable
        .map((o) => `${o.pair}(${o.detail})`)
        .join(", ")}`,
    };
  }

  const unstable = outcomes.filter((o) => o.failure === "unstable");
  if (unstable.length > 0) {
    return {
      winnerLabel: null,
      winnerId: null,
      decidedAt: null,
      reviewReason: "unstable_judge",
      trace,
      detail: `judge 불안정: ${unstable.map((o) => `${o.pair}(${o.detail})`).join(", ")}`,
    };
  }

  const wins = new Map<string, number>();
  for (const outcome of outcomes) {
    if (outcome.winnerLabel) wins.set(outcome.winnerLabel, (wins.get(outcome.winnerLabel) ?? 0) + 1);
  }
  const ranked = [...wins.entries()].sort((x, y) => y[1] - x[1]);
  const top = ranked[0];
  const runnerUp = ranked[1];
  if (!top || (runnerUp && runnerUp[1] === top[1])) {
    return {
      winnerLabel: null,
      winnerId: null,
      decidedAt: null,
      reviewReason: "tie",
      trace,
      detail: "판정 결과가 동률이다",
    };
  }

  return {
    winnerLabel: top[0],
    winnerId: idOf(top[0]),
    decidedAt: "S1",
    reviewReason: null,
    trace,
    detail: `blind pairwise 판정: ${outcomes
      .map((o) => `${o.pair}→${o.winnerLabel ?? "tie"}`)
      .join(", ")}`,
  };
}
