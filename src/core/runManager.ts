import { randomUUID } from "node:crypto";
import {
  type ArenaEvent,
  type CandidateSpec,
  type CreateRunRequest,
  type JudgeVerdict,
  type RunResult,
  type RunStatus,
} from "../protocol/index.ts";
import type { HasaClient } from "../hasa-client/client.ts";
import { HasaError } from "../hasa-client/errors.ts";
import { createLogger, type Logger } from "../hasa-client/logger.ts";
import { redactString } from "../hasa-client/redact.ts";
import type { Scheduler } from "./scheduler.ts";
import type { CandidateRow, Store } from "./store.ts";
import type { EventHub } from "./events.ts";
import { assertFairness, resolveCandidateSpecs, shuffled } from "./fairness.ts";
import { runJudge, scrubIdentifiers, type Submission } from "./judge.ts";

export interface RunManagerOptions {
  client: HasaClient;
  scheduler: Scheduler;
  store: Store;
  hub: EventHub;
  logger?: Logger;
  random?: () => number;
  now?: () => number;
}

interface RunContext {
  controller: AbortController;
  done: Promise<void>;
}

interface PairOutcome {
  pair: string;
  winnerLabel: string | null;
  stable: boolean;
  detail: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text?: unknown }).text ?? "") : ""))
      .join("");
  }
  return "";
}

export class RunManager {
  private readonly client: HasaClient;
  private readonly scheduler: Scheduler;
  private readonly store: Store;
  private readonly hub: EventHub;
  private readonly log: Logger;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly contexts = new Map<string, RunContext>();

  constructor(opts: RunManagerOptions) {
    this.client = opts.client;
    this.scheduler = opts.scheduler;
    this.store = opts.store;
    this.hub = opts.hub;
    this.log = opts.logger ?? createLogger("run");
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
  }

  /** Throws FairnessError before anything is persisted. */
  create(req: CreateRunRequest): string {
    assertFairness({ candidates: req.candidates, sampling: req.sampling, judge: req.judge });

    const runId = randomUUID();
    const specs = resolveCandidateSpecs(runId, req.candidates, req.sampling, req.taskSpec);
    const createdAt = this.now();

    this.store.insertRun({
      id: runId,
      mode: req.mode,
      status: "queued",
      taskSpec: JSON.stringify(req.taskSpec),
      sampling: JSON.stringify(req.sampling),
      judge: JSON.stringify(req.judge),
      createdAt,
      finishedAt: null,
      result: null,
      repoRoot: null,
      baseCommit: null,
    });

    // Execution order is randomised; labels stay in declaration order so the
    // user can still map cand-a back to the model they asked for.
    const order = shuffled(specs, this.random);
    for (const spec of specs) {
      this.store.insertCandidate({
        id: spec.candidateId,
        runId,
        label: spec.label,
        modelId: spec.modelId,
        spec: JSON.stringify(spec),
        status: "queued",
        orderIndex: order.findIndex((s) => s.candidateId === spec.candidateId),
        excludedReason: null,
        responseText: null,
        tokensIn: null,
        tokensOut: null,
        latencyMs: null,
        errorCode: null,
        artifacts: null,
        score: null,
      });
    }

    this.emit(runId, { type: "run.status", runId, status: "queued", at: createdAt });

    const controller = new AbortController();
    const done = this.execute(runId, req, specs, order, controller.signal)
      .catch((err: unknown) => {
        this.log.error("run failed", { runId, error: err });
        this.setStatus(runId, "failed");
        this.emit(runId, {
          type: "error",
          runId,
          scope: "run",
          code: err instanceof HasaError ? err.code : "internal",
          retryable: false,
          at: this.now(),
        });
      })
      .then(() => this.store.flush());
    this.contexts.set(runId, { controller, done });
    return runId;
  }

  cancel(runId: string): boolean {
    const ctx = this.contexts.get(runId);
    if (!ctx) return false;
    ctx.controller.abort(new Error("cancelled by user"));
    this.setStatus(runId, "cancelled");
    return true;
  }

  /** Test/CLI helper — resolves once the run reaches a terminal state. */
  async waitFor(runId: string): Promise<void> {
    await this.contexts.get(runId)?.done;
  }

  private emit(runId: string, event: ArenaEvent): void {
    this.hub.forRun(runId).publish(event);
    void this.store.appendEvent(runId, event);
  }

  private setStatus(runId: string, status: RunStatus): void {
    const finished = status === "completed" || status === "failed" || status === "cancelled";
    this.store.updateRun(runId, { status, finishedAt: finished ? this.now() : null });
    this.emit(runId, { type: "run.status", runId, status, at: this.now() });
  }

  private async execute(
    runId: string,
    req: CreateRunRequest,
    specs: CandidateSpec[],
    order: CandidateSpec[],
    signal: AbortSignal,
  ): Promise<void> {
    this.setStatus(runId, "running");

    await Promise.all(order.map((spec) => this.runCandidate(runId, req, spec, signal)));
    if (signal.aborted) return;

    this.setStatus(runId, "evaluating");
    const result = await this.evaluate(runId, req, specs, signal);
    if (signal.aborted) return;

    this.store.updateRun(runId, { result: JSON.stringify(result) });
    await this.store.writeArtifact(runId, "result.json", `${JSON.stringify(result, null, 2)}\n`);
    await this.writeRunRecord(runId, req, result);
    this.emit(runId, { type: "run.result", runId, result, at: this.now() });
    this.setStatus(runId, "completed");
    // Events are emitted fire-and-forget so a slow disk never stalls a run;
    // the run is not "done" until they have actually landed.
    await this.store.flush();
  }

  private async runCandidate(
    runId: string,
    req: CreateRunRequest,
    spec: CandidateSpec,
    signal: AbortSignal,
  ): Promise<void> {
    const base = { runId, candidateId: spec.candidateId, label: spec.label };
    this.store.updateCandidate(spec.candidateId, { status: "running" });
    this.emit(runId, { type: "candidate.status", ...base, status: "running", at: this.now() });

    const started = this.now();
    try {
      const response = await this.scheduler.submit({
        modelId: spec.modelId,
        priority: 0,
        signal,
        run: (jobSignal) => {
          this.emit(runId, { type: "candidate.progress", ...base, phase: "requesting", at: this.now() });
          return this.client.chat(
            {
              model: spec.modelId,
              messages: [
                ...(req.taskSpec.systemPrompt
                  ? [{ role: "system" as const, content: req.taskSpec.systemPrompt }]
                  : []),
                { role: "user" as const, content: req.taskSpec.prompt },
              ],
              temperature: spec.temperature,
              top_p: spec.topP,
              max_tokens: spec.maxOutputTokens,
            },
            jobSignal ? { signal: jobSignal } : {},
          );
        },
      });

      const text = textOf(response.choices[0]?.message?.content);
      const empty = text.trim().length === 0;
      this.store.updateCandidate(spec.candidateId, {
        status: empty ? "failed" : "completed",
        responseText: text,
        tokensIn: response.usage?.prompt_tokens ?? null,
        tokensOut: response.usage?.completion_tokens ?? null,
        latencyMs: this.now() - started,
        errorCode: empty ? "empty_response" : null,
      });
      await this.store.writeArtifact(runId, `candidates/${spec.label}.txt`, text);
      this.emit(runId, {
        type: "candidate.status",
        ...base,
        status: empty ? "failed" : "completed",
        at: this.now(),
        ...(empty ? { excludedReason: "empty_response" } : {}),
      });
      this.emit(runId, { type: "candidate.progress", ...base, phase: "done", at: this.now() });
    } catch (err) {
      const hasa = err instanceof HasaError ? err : null;
      // A rate-limited model is quarantined rather than hammered; the rest of
      // the run continues at full speed.
      if (hasa?.kind === "rate_limit") {
        this.scheduler.pauseModel(spec.modelId, hasa.retryAfterMs ?? 5_000);
      }
      const excluded = hasa?.terminal === true;
      this.store.updateCandidate(spec.candidateId, {
        status: excluded ? "excluded" : "failed",
        excludedReason: hasa?.code ?? "error",
        errorCode: hasa?.code ?? "error",
        latencyMs: this.now() - started,
      });
      this.emit(runId, {
        type: "candidate.status",
        ...base,
        status: excluded ? "excluded" : "failed",
        at: this.now(),
        excludedReason: hasa?.code ?? "error",
      });
      this.emit(runId, {
        type: "error",
        runId,
        scope: "candidate",
        candidateId: spec.candidateId,
        code: hasa?.code ?? "internal",
        retryable: hasa?.retryable ?? false,
        at: this.now(),
      });
    }
  }

  private async evaluate(
    runId: string,
    req: CreateRunRequest,
    specs: CandidateSpec[],
    signal: AbortSignal,
  ): Promise<RunResult> {
    const rows = this.store.listCandidates(runId);
    const survivors = rows.filter(
      (r) => r.status === "completed" && (r.responseText ?? "").trim().length > 0,
    );

    if (survivors.length === 0) {
      return {
        outcome: "no_winner",
        winnerCandidateId: null,
        winnerLabel: null,
        confidence: null,
        reason: `모든 후보가 기준 미달: ${rows.map((r) => `${r.label}=${r.status}${r.errorCode ? `(${r.errorCode})` : ""}`).join(", ")}`,
        reviewReason: null,
        requiresHumanReview: false,
      };
    }
    if (survivors.length === 1) {
      const only = survivors[0];
      return {
        outcome: "winner",
        winnerCandidateId: only?.id ?? null,
        winnerLabel: only?.label ?? null,
        confidence: "sole_survivor",
        reason: "생존 후보가 1개뿐이다 — 비교가 이루어지지 않았다",
        reviewReason: "never_compared",
        requiresHumanReview: true,
      };
    }

    const outcomes: PairOutcome[] = [];
    for (let i = 0; i < survivors.length; i += 1) {
      for (let j = i + 1; j < survivors.length; j += 1) {
        const a = survivors[i];
        const b = survivors[j];
        if (!a || !b) continue;
        outcomes.push(await this.judgePair(runId, req, a, b, signal));
      }
    }

    const wins = new Map<string, number>();
    for (const outcome of outcomes) {
      if (outcome.winnerLabel) wins.set(outcome.winnerLabel, (wins.get(outcome.winnerLabel) ?? 0) + 1);
    }
    const unstable = outcomes.filter((o) => !o.stable);
    if (unstable.length > 0) {
      return {
        outcome: "no_winner",
        winnerCandidateId: null,
        winnerLabel: null,
        confidence: null,
        reason: `judge 불안정: ${unstable.map((o) => `${o.pair}(${o.detail})`).join(", ")}`,
        reviewReason: "unstable_judge",
        requiresHumanReview: true,
      };
    }

    const ranked = [...wins.entries()].sort((x, y) => y[1] - x[1]);
    const top = ranked[0];
    const runnerUp = ranked[1];
    if (!top || (runnerUp && runnerUp[1] === top[1])) {
      return {
        outcome: "no_winner",
        winnerCandidateId: null,
        winnerLabel: null,
        confidence: null,
        reason: "판정 결과가 동률이다",
        reviewReason: "tie",
        requiresHumanReview: true,
      };
    }

    const winner = survivors.find((s) => s.label === top[0]);
    return {
      outcome: "winner",
      winnerCandidateId: winner?.id ?? null,
      winnerLabel: top[0],
      confidence: "judge",
      reason: `blind pairwise 판정: ${outcomes.map((o) => `${o.pair}→${o.winnerLabel ?? "tie"}`).join(", ")}`,
      // Response mode has no objective gate to corroborate the judge, so the
      // verdict rests entirely on one model's reading of prose. That is a real
      // limitation of the mode, not a hedge — and it is the same for 2
      // candidates as for 5, which the old `specs.length > 2` rule got wrong.
      reviewReason: "judge_only",
      requiresHumanReview: true,
    };
  }

  /**
   * Runs the same pair twice with the order flipped. A judge that changes its
   * mind when the submissions swap places has told us nothing, so disagreement
   * is recorded as instability rather than resolved by picking one.
   */
  private async judgePair(
    runId: string,
    req: CreateRunRequest,
    a: CandidateRow,
    b: CandidateRow,
    signal: AbortSignal,
  ): Promise<PairOutcome> {
    const pair = `${a.label}|${b.label}`;
    // Every candidate's model id is scrubbed from every submission, not just
    // its own — otherwise "unlike GPT-x, I…" still identifies the field.
    const identifiers = req.candidates.map((c) => c.modelId);
    const subA: Submission = { label: a.label, text: scrubIdentifiers(a.responseText ?? "", identifiers) };
    const subB: Submission = { label: b.label, text: scrubIdentifiers(b.responseText ?? "", identifiers) };
    const orders: Array<{ order: "AB" | "BA"; first: Submission; second: Submission }> = [
      { order: "AB", first: subA, second: subB },
      { order: "BA", first: subB, second: subA },
    ];

    const decisions: Array<string | null> = [];
    for (const leg of orders) {
      this.emit(runId, { type: "judge.progress", runId, pair, order: leg.order, attempt: 1, at: this.now() });
      const result = await runJudge(
        this.client,
        req.judge,
        {
          taskPrompt: req.taskSpec.prompt,
          ...(req.taskSpec.rubric ? { rubric: req.taskSpec.rubric } : {}),
          first: leg.first,
          second: leg.second,
          forbidden: identifiers,
        },
        {
          logger: this.log,
          signal,
          // Judging shares the scheduler so its calls obey the same caps, at a
          // higher priority — a run stuck waiting to be judged holds worktrees.
          dispatch: (modelId, fn) => this.scheduler.submit({ modelId, priority: 1, signal, run: fn }),
        },
      );

      const decided = this.decisionOf(result.verdict, leg.first.label, leg.second.label);
      decisions.push(decided);

      const rawPath = await this.store.writeArtifact(
        runId,
        `verdicts/${pair.replace("|", "-")}-${leg.order}.json`,
        `${JSON.stringify({ verdict: result.verdict, attempts: result.attempts, raw: result.rawResponses }, null, 2)}\n`,
      );
      this.store.insertVerdict({
        id: randomUUID(),
        runId,
        judgeModel: req.judge.modelId,
        pair,
        presentationOrder: leg.order,
        winnerLabel: decided,
        confidence: result.verdict?.confidence ?? null,
        reasons: JSON.stringify(result.verdict?.reasons ?? [result.failureReason ?? "unparseable"]),
        parseAttempts: result.attempts,
        rawPath,
      });

      if (!result.verdict) {
        return { pair, winnerLabel: null, stable: false, detail: "judge 출력 파싱 실패 → no_winner" };
      }
    }

    const [first, second] = decisions;
    if (first === null && second === null) {
      return { pair, winnerLabel: null, stable: true, detail: "양쪽 순서 모두 tie" };
    }
    if (first !== second) {
      return { pair, winnerLabel: null, stable: false, detail: `AB=${first ?? "tie"} BA=${second ?? "tie"}` };
    }
    return { pair, winnerLabel: first ?? null, stable: true, detail: "AB/BA 일치" };
  }

  private decisionOf(
    verdict: JudgeVerdict | null,
    firstLabel: string,
    secondLabel: string,
  ): string | null {
    if (!verdict || verdict.winner === null) return null;
    return verdict.winner === 1 ? firstLabel : secondLabel;
  }

  /**
   * The complete, self-contained record of a run.
   *
   * Written to JSONL alongside SQLite because the two failure modes are
   * different: a corrupt database loses everything at once, whereas an
   * append-only file loses at most the last line. It also makes a run
   * greppable and diffable without a SQL client.
   */
  private async writeRunRecord(
    runId: string,
    req: CreateRunRequest,
    result: RunResult,
  ): Promise<void> {
    const row = this.store.getRun(runId);
    const candidates = this.store.listCandidates(runId);
    const verdicts = this.store.listVerdicts(runId);
    const at = this.now();

    const lines: unknown[] = [
      {
        type: "run",
        at,
        runId,
        mode: req.mode,
        // The prompt is recorded so a result can be reproduced; the system
        // prompt is referenced by version only.
        prompt: req.taskSpec.prompt,
        systemPromptVersion: req.taskSpec.systemPromptVersion,
        sampling: req.sampling,
        judgeModel: req.judge.modelId,
        createdAt: row?.createdAt ?? at,
      },
      ...candidates.map((c) => ({
        type: "candidate",
        at,
        runId,
        label: c.label,
        modelId: c.modelId,
        status: c.status,
        orderIndex: c.orderIndex,
        excludedReason: c.excludedReason,
        errorCode: c.errorCode,
        latencyMs: c.latencyMs,
        tokensIn: c.tokensIn,
        tokensOut: c.tokensOut,
        responseText: c.responseText,
      })),
      ...verdicts.map((v) => ({
        type: "verdict",
        at,
        runId,
        pair: v.pair,
        presentationOrder: v.presentationOrder,
        winnerLabel: v.winnerLabel,
        confidence: v.confidence,
        reasons: JSON.parse(v.reasons) as unknown,
        parseAttempts: v.parseAttempts,
      })),
      { type: "result", at, runId, ...result },
    ];

    for (const line of lines) {
      await this.store.appendJsonl(`runs/${runId}/run.jsonl`, line);
    }
    // Flat index across all runs, so a whole experiment can be read with one
    // pass instead of walking per-run directories.
    await this.store.appendJsonl("runs.jsonl", {
      at,
      runId,
      mode: req.mode,
      judgeModel: req.judge.modelId,
      candidates: candidates.map((c) => ({ label: c.label, modelId: c.modelId, status: c.status })),
      outcome: result.outcome,
      winnerLabel: result.winnerLabel,
      confidence: result.confidence,
      requiresHumanReview: result.requiresHumanReview,
      reason: result.reason,
    });
  }

  /** API view. Response text is swept once more before it can reach a browser. */
  candidateView(runId: string): Array<Record<string, unknown>> {
    return this.store.listCandidates(runId).map((row) => ({
      candidateId: row.id,
      label: row.label,
      modelId: row.modelId,
      status: row.status,
      excludedReason: row.excludedReason,
      errorCode: row.errorCode,
      latencyMs: row.latencyMs,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      responseText: row.responseText === null ? null : redactString(row.responseText),
    }));
  }
}
