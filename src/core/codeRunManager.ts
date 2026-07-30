import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  type ApplyRequest,
  type ApplyResult,
  type ArenaEvent,
  type CandidateArtifacts,
  type CandidateSpec,
  type CommandSpec,
  type CreateCodeRunRequest,
  type GateResult,
  type RunResult,
  type RunStatus,
} from "../protocol/index.ts";
import type { HasaClient } from "../hasa-client/client.ts";
import { HasaError } from "../hasa-client/errors.ts";
import { createLogger, type Logger } from "../hasa-client/logger.ts";
import { redactString } from "../hasa-client/redact.ts";
import { candidateEnv, runCommand, type CommandOutcome } from "./commands.ts";
import { EventHub } from "./events.ts";
import { assertFairness, resolveCandidateSpecs, shuffled } from "./fairness.ts";
import {
  SCORING_VERSION,
  evaluateGates,
  scanDiffForSecrets,
  scoreCandidate,
  type BaselineMeasurement,
} from "./gates.ts";
import { decide } from "./decide.ts";
import { GitRepo, worktreePathFor } from "./git.ts";
import { scrubIdentifiers } from "./judge.ts";
import { ModelRegistry } from "./registry.ts";
import { Sandbox } from "./sandbox.ts";
import type { Scheduler } from "./scheduler.ts";
import type { CandidateRow, Store } from "./store.ts";
import { ToolCallingRunner } from "../runtime/agentRunner.ts";
import { PatchGenerationRunner } from "../runtime/patchRunner.ts";
import type { AgentRunner } from "../runtime/types.ts";

/**
 * Code mode measures the candidates before it asks anyone's opinion, so a
 * verdict here can be corroborated by something that is not a language model.
 */
const CODE_EVIDENCE_AXES: RunResult["evidenceAxes"] = ["objective", "judge"];

/**
 * A verdict reached without the ladder — no candidate survived, only one did,
 * or the objective score settled it outright. The trace is empty because
 * nothing was judged.
 */
const NO_LADDER = (): Pick<RunResult, "decidedAt" | "ladderTrace" | "judgeCallsSpent"> => ({
  decidedAt: null,
  ladderTrace: [],
  judgeCallsSpent: 0,
});


export interface CodeRunManagerOptions {
  client: HasaClient;
  scheduler: Scheduler;
  store: Store;
  hub: EventHub;
  logger?: Logger;
  random?: () => number;
  now?: () => number;
  /** Overridable for tests that need a deterministic runner. */
  runners?: AgentRunner[];
  /** Enforces measured capability before a model may enter a runtime. */
  registry?: ModelRegistry;
}

interface RunContext {
  controller: AbortController;
  done: Promise<void>;
  repo: GitRepo;
  baseCommit: string;
  worktrees: Map<string, string>;
  request: CreateCodeRunRequest;
}

export class CodeRunPrecondition extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`code run preconditions not met: ${reasons.join("; ")}`);
    this.name = "CodeRunPrecondition";
    this.reasons = reasons;
  }
}

/**
 * Code-candidate mode.
 *
 * The invariants this class exists to hold:
 *   - the main workspace is read-only until an explicit apply
 *   - every candidate starts from one frozen base commit, in its own worktree
 *   - worktrees survive until the user has reviewed, then are cleaned up
 *   - `no_winner` is a normal outcome
 *
 * See docs/architecture.md §7 and docs/evaluation-protocol.md §2.
 */
export class CodeRunManager {
  private readonly client: HasaClient;
  private readonly scheduler: Scheduler;
  private readonly store: Store;
  private readonly hub: EventHub;
  private readonly log: Logger;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly runners: Map<string, AgentRunner>;
  private readonly registry: ModelRegistry;
  private readonly contexts = new Map<string, RunContext>();

  constructor(opts: CodeRunManagerOptions) {
    this.client = opts.client;
    this.scheduler = opts.scheduler;
    this.store = opts.store;
    this.hub = opts.hub;
    this.log = opts.logger ?? createLogger("code-run");
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
    const runners = opts.runners ?? [new ToolCallingRunner(), new PatchGenerationRunner()];
    this.runners = new Map(runners.map((r) => [r.id, r]));
    this.registry = opts.registry ?? ModelRegistry.empty();
  }

  /**
   * Validates, freezes the base commit, creates worktrees, then starts.
   *
   * Everything that can refuse the run happens before any worktree exists, so a
   * rejected request leaves no trace in the user's repository.
   */
  async create(req: CreateCodeRunRequest): Promise<string> {
    assertFairness({ candidates: req.candidates, sampling: req.sampling, judge: req.judge });
    if (!this.runners.has(req.runtimeAdapter)) {
      throw new CodeRunPrecondition([`unknown runtime adapter: ${req.runtimeAdapter}`]);
    }

    // A model that cannot call tools must not silently enter the agent league;
    // the refusal names the alternative rather than just saying no.
    const objections = this.registry.objectionsFor(
      req.candidates.map((c) => c.modelId),
      req.runtimeAdapter,
    );
    if (objections.length > 0) throw new CodeRunPrecondition(objections);

    const repo = await GitRepo.open(req.repoRoot).catch((err: unknown) => {
      throw new CodeRunPrecondition([
        `${req.repoRoot} is not a git repository root: ${err instanceof Error ? err.message : String(err)}`,
      ]);
    });

    // A dirty tree makes "what did the candidate change" unanswerable and puts
    // the user's uncommitted work at risk during apply.
    const dirty = await repo.status();
    if (dirty.length > 0) {
      throw new CodeRunPrecondition([
        `working tree is not clean (${dirty.length} entries). Commit or stash before starting a code run.`,
      ]);
    }

    const baseCommit = await repo.headSha();
    const runId = randomUUID();
    const specs = resolveCandidateSpecs(runId, req.candidates, req.sampling, {
      prompt: req.taskSpec.prompt,
      systemPromptVersion: req.taskSpec.systemPromptVersion,
    });
    const createdAt = this.now();

    this.store.insertRun({
      id: runId,
      mode: "code",
      status: "queued",
      taskSpec: JSON.stringify(req.taskSpec),
      sampling: JSON.stringify(req.sampling),
      judge: JSON.stringify(req.judge),
      createdAt,
      finishedAt: null,
      result: null,
      repoRoot: repo.root,
      baseCommit,
    });

    const order = shuffled(specs, this.random);
    for (const spec of specs) {
      this.store.insertCandidate({
        id: spec.candidateId,
        runId,
        label: spec.label,
        modelId: spec.modelId,
        spec: JSON.stringify({ ...spec, runtimeAdapter: req.runtimeAdapter }),
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
    const context: RunContext = {
      controller,
      done: Promise.resolve(),
      repo,
      baseCommit,
      worktrees: new Map(),
      request: req,
    };
    context.done = this.execute(runId, context, specs, order)
      .catch((err: unknown) => {
        this.log.error("code run failed", { runId, error: err });
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
    this.contexts.set(runId, context);
    return runId;
  }

  cancel(runId: string): boolean {
    const ctx = this.contexts.get(runId);
    if (!ctx) return false;
    ctx.controller.abort(new Error("cancelled by user"));
    this.setStatus(runId, "cancelled");
    return true;
  }

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
    ctx: RunContext,
    specs: CandidateSpec[],
    order: CandidateSpec[],
  ): Promise<void> {
    const { repo, baseCommit, request } = ctx;
    this.setStatus(runId, "running");

    const baseline = await this.measureBaseline(runId, ctx);
    if (ctx.controller.signal.aborted) return;

    // Worktrees are created up front so a failure to isolate is detected before
    // any model call is paid for.
    for (const spec of order) {
      const path = worktreePathFor(repo.root, runId, spec.label);
      const handle = await repo.addWorktree(path, baseCommit, spec.label);
      ctx.worktrees.set(spec.candidateId, handle.path);
    }

    await Promise.all(order.map((spec) => this.runCandidate(runId, ctx, spec, baseline)));
    if (ctx.controller.signal.aborted) return;

    this.setStatus(runId, "evaluating");
    const result = await this.evaluate(runId, ctx, specs);
    if (ctx.controller.signal.aborted) return;

    this.store.updateRun(runId, { result: JSON.stringify(result) });
    await this.writeRunRecord(runId, request, result);
    this.emit(runId, { type: "run.result", runId, result, at: this.now() });
    this.setStatus(runId, "completed");
    await this.store.flush();
  }

  /**
   * Measures the declared commands on an untouched worktree.
   *
   * Without this, a repository whose tests already fail would disqualify every
   * candidate for a defect none of them introduced.
   */
  private async measureBaseline(runId: string, ctx: RunContext): Promise<BaselineMeasurement> {
    const { repo, baseCommit, request } = ctx;
    const exitCodes = new Map<string, number | null>();
    const brokenAtBase = new Set<string>();
    if (request.taskSpec.acceptanceCommands.length === 0) return { exitCodes, brokenAtBase };

    const path = worktreePathFor(repo.root, runId, "baseline");
    const handle = await repo.addWorktree(path, baseCommit, "baseline");
    ctx.worktrees.set("baseline", handle.path);
    try {
      for (const command of request.taskSpec.acceptanceCommands) {
        if (ctx.controller.signal.aborted) break;
        const outcome = await runCommand(command, request.taskSpec.acceptanceCommands, {
          cwd: handle.path,
          signal: ctx.controller.signal,
          env: candidateEnv(),
        });
        exitCodes.set(command.gate, outcome.exitCode);
        if (outcome.exitCode !== 0) brokenAtBase.add(command.gate);
        await this.store.writeArtifact(
          runId,
          `baseline/${command.gate}.log`,
          `$ ${command.cmd} ${command.args.join(" ")}\nexit=${outcome.exitCode}\n\n${outcome.stdout}\n${outcome.stderr}\n`,
        );
      }
      if (brokenAtBase.size > 0) {
        this.log.warn("baseline gates already failing", { runId, gates: [...brokenAtBase] });
      }
    } finally {
      // The baseline worktree has served its purpose and holds no evidence a
      // reviewer needs; candidate worktrees are the ones that must survive.
      await repo.removeWorktree(handle.path).catch(() => {});
      ctx.worktrees.delete("baseline");
    }
    return { exitCodes, brokenAtBase };
  }

  private async runCandidate(
    runId: string,
    ctx: RunContext,
    spec: CandidateSpec,
    baseline: BaselineMeasurement,
  ): Promise<void> {
    const { repo, baseCommit, request } = ctx;
    const base = { runId, candidateId: spec.candidateId, label: spec.label };
    const worktree = ctx.worktrees.get(spec.candidateId);
    if (!worktree) return;

    const runner = this.runners.get(request.runtimeAdapter);
    if (!runner) return;

    this.store.updateCandidate(spec.candidateId, { status: "running" });
    this.emit(runId, { type: "candidate.status", ...base, status: "running", at: this.now() });

    const sandbox = new Sandbox({ root: worktree, writeScope: request.taskSpec.writeScope });
    const started = this.now();
    let attempt = 0;
    let lastError: unknown = null;

    while (attempt <= request.taskSpec.maxCandidateRetries) {
      attempt += 1;
      if (ctx.controller.signal.aborted) return;

      // Each attempt gets its own deadline; the run-level signal still wins.
      const timeout = AbortSignal.timeout(request.taskSpec.candidateTimeoutMs);
      const signal = AbortSignal.any([ctx.controller.signal, timeout]);
      const commands: CommandOutcome[] = [];

      try {
        const result = await runner.run({
          spec,
          taskSpec: request.taskSpec,
          sandbox,
          client: this.client,
          log: this.log.child(spec.label),
          signal,
          onEvent: (event) =>
            this.emit(runId, {
              type: "candidate.progress",
              ...base,
              phase: event.phase === "done" ? "done" : "streaming",
              at: this.now(),
            }),
          dispatch: (modelId, fn) =>
            this.scheduler.submit({ modelId, priority: 0, signal, run: fn }),
          runCommand: async (command: CommandSpec) => {
            const outcome = await runCommand(command, request.taskSpec.acceptanceCommands, {
              cwd: worktree,
              signal,
              env: candidateEnv(),
            });
            commands.push(outcome);
            return outcome;
          },
          applyPatch: (patch: string) => repo.applyPatch(patch, worktree),
        });

        const artifacts = await this.collectArtifacts(
          runId,
          ctx,
          spec,
          worktree,
          baseCommit,
          result.toolCalls,
          [...commands, ...result.commands],
          attempt,
        );

        const gateOutcome = await evaluateGates({
          taskSpec: request.taskSpec,
          artifacts,
          baseline,
          diffSecrets: artifacts.diffLines > 0 ? await this.secretsFor(runId, spec.label) : [],
          run: (command) =>
            runCommand(command, request.taskSpec.acceptanceCommands, {
              cwd: worktree,
              signal,
              env: candidateEnv(),
            }),
          onGate: (gate) => this.persistGate(runId, spec.candidateId, gate),
          signal,
        });

        artifacts.commands = [...artifacts.commands, ...gateOutcome.commandOutcomes.map(toCommandRecord)];

        this.store.updateCandidate(spec.candidateId, {
          status: gateOutcome.survived ? "completed" : "failed",
          responseText: result.summary,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          latencyMs: this.now() - started,
          errorCode: gateOutcome.failedHardGate,
          excludedReason: gateOutcome.failedHardGate,
          artifacts: JSON.stringify(artifacts),
        });
        this.emit(runId, {
          type: "candidate.status",
          ...base,
          status: gateOutcome.survived ? "completed" : "failed",
          at: this.now(),
          ...(gateOutcome.failedHardGate ? { excludedReason: gateOutcome.failedHardGate } : {}),
        });
        return;
      } catch (err) {
        lastError = err;
        const hasa = err instanceof HasaError ? err : null;
        if (hasa?.kind === "rate_limit") {
          this.scheduler.pauseModel(spec.modelId, hasa.retryAfterMs ?? 5_000);
        }
        // A permission or configuration failure will not improve on retry.
        const retryable = hasa === null ? true : hasa.retryable;
        if (!retryable || attempt > request.taskSpec.maxCandidateRetries) break;
        this.log.warn("retrying candidate", { label: spec.label, attempt, code: hasa?.code });
      }
    }

    const hasa = lastError instanceof HasaError ? lastError : null;
    const excluded = hasa?.terminal === true;
    this.store.updateCandidate(spec.candidateId, {
      status: excluded ? "excluded" : "failed",
      excludedReason: hasa?.code ?? "runner_error",
      errorCode: hasa?.code ?? "runner_error",
      latencyMs: this.now() - started,
      artifacts: JSON.stringify(emptyArtifacts(worktree, attempt)),
    });
    this.emit(runId, {
      type: "candidate.status",
      ...base,
      status: excluded ? "excluded" : "failed",
      at: this.now(),
      excludedReason: hasa?.code ?? "runner_error",
    });
    this.emit(runId, {
      type: "error",
      runId,
      scope: "candidate",
      candidateId: spec.candidateId,
      code: hasa?.code ?? "runner_error",
      retryable: hasa?.retryable ?? false,
      at: this.now(),
    });
  }

  private async secretsFor(runId: string, label: string): Promise<string[]> {
    const dir = this.store.runDir(runId);
    if (dir === null) return [];
    try {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const diff = await readFile(join(dir, "candidates", `${label}.diff`), "utf8");
      return scanDiffForSecrets(diff);
    } catch {
      return [];
    }
  }

  private persistGate(runId: string, candidateId: string, gate: GateResult): void {
    this.store.insertGateResult({
      id: randomUUID(),
      runId,
      candidateId,
      gate: gate.gate,
      passed: gate.passed ? 1 : 0,
      hard: gate.hard ? 1 : 0,
      flaky: gate.flaky ? 1 : 0,
      detail: gate.detail,
      durationMs: gate.durationMs,
    });
    this.emit(runId, {
      type: "gate.result",
      runId,
      candidateId,
      gate: gate.gate,
      passed: gate.passed,
      durationMs: gate.durationMs,
      at: this.now(),
    });
  }

  private async collectArtifacts(
    runId: string,
    ctx: RunContext,
    spec: CandidateSpec,
    worktree: string,
    baseCommit: string,
    toolCalls: number,
    commands: CommandOutcome[],
    attempt: number,
  ): Promise<CandidateArtifacts> {
    const diff = await ctx.repo.diffWorktree(worktree, baseCommit);
    const changedFiles = await ctx.repo.changedFiles(worktree, baseCommit);
    const scope = ctx.request.taskSpec.writeScope;
    const outOfScopeFiles =
      scope.length === 0
        ? []
        : changedFiles.filter((f) => !scope.some((p) => f === p || f.startsWith(`${p}/`)));

    const diffPath = await this.store.writeArtifact(runId, `candidates/${spec.label}.diff`, diff);
    for (const outcome of commands) {
      await this.store.writeArtifact(
        runId,
        `candidates/${spec.label}/${outcome.gate}.log`,
        `$ ${outcome.cmd} ${outcome.args.join(" ")}\nexit=${outcome.exitCode}\n\n${outcome.stdout}\n${outcome.stderr}\n`,
      );
    }

    return {
      diffPath,
      diffLines: diff.length === 0 ? 0 : diff.split("\n").length,
      changedFiles,
      outOfScopeFiles,
      commands: commands.map(toCommandRecord),
      toolCalls,
      worktreePath: worktree,
      attempts: attempt,
    };
  }

  private async evaluate(
    runId: string,
    ctx: RunContext,
    specs: CandidateSpec[],
  ): Promise<RunResult> {
    const rows = this.store.listCandidates(runId);
    const survivors = rows.filter((r) => r.status === "completed");

    if (survivors.length === 0) {
      return {
        outcome: "no_winner",
        winnerCandidateId: null,
        winnerLabel: null,
        confidence: null,
        reason: `모든 후보가 기준 미달: ${rows
          .map((r) => `${r.label}=${r.status}${r.errorCode ? `(${r.errorCode})` : ""}`)
          .join(", ")}`,
        reviewReason: null,
        requiresHumanReview: false,
        evidenceAxes: CODE_EVIDENCE_AXES,
        ...NO_LADDER(),
      };
    }

    const parsed = survivors.map((row) => ({
      row,
      artifacts: JSON.parse(row.artifacts ?? "{}") as CandidateArtifacts,
    }));
    const diffLines = parsed.map((p) => p.artifacts.diffLines ?? 0).sort((a, b) => a - b);
    const medianDiff = diffLines[Math.floor(diffLines.length / 2)] ?? 1;
    const tokens = parsed.map((p) => (p.row.tokensIn ?? 0) + (p.row.tokensOut ?? 0));
    const sortedTokens = [...tokens].sort((a, b) => a - b);
    const medianTokens = sortedTokens[Math.floor(sortedTokens.length / 2)] ?? 0;

    for (const entry of parsed) {
      const gates = this.store.listGateResults(entry.row.id);
      const { score } = scoreCandidate({
        artifacts: entry.artifacts,
        results: gates.map((g) => ({
          gate: g.gate as GateResult["gate"],
          passed: g.passed === 1,
          hard: g.hard === 1,
          flaky: g.flaky === 1,
          detail: g.detail,
          durationMs: g.durationMs,
        })),
        expectedDiffLines: ctx.request.taskSpec.expectedDiffLines ?? 0,
        medianDiffLines: medianDiff,
        medianTokens,
        tokens: (entry.row.tokensIn ?? 0) + (entry.row.tokensOut ?? 0),
      });
      this.store.updateCandidate(entry.row.id, { score });
    }

    const scored = this.store
      .listCandidates(runId)
      .filter((r) => r.status === "completed")
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    if (scored.length === 1) {
      const only = scored[0];
      return {
        outcome: "winner",
        winnerCandidateId: only?.id ?? null,
        winnerLabel: only?.label ?? null,
        confidence: "sole_survivor",
        reason: "게이트를 통과한 후보가 1개뿐이다 — 비교가 이루어지지 않았다",
        reviewReason: "never_compared",
        requiresHumanReview: true,
        evidenceAxes: CODE_EVIDENCE_AXES,
        ...NO_LADDER(),
      };
    }

    const top = scored[0];
    const second = scored[1];
    const gap = (top?.score ?? 0) - (second?.score ?? 0);
    if (top && gap >= 10) {
      return {
        outcome: "winner",
        winnerCandidateId: top.id,
        winnerLabel: top.label,
        confidence: "objective",
        reason: `객관 점수 차이 ${gap.toFixed(1)}점 (${SCORING_VERSION}) — judge 생략`,
        // Gates and score decided this. Flagging it anyway would make the flag
        // true in every branch, and a flag that never varies is not a signal —
        // it just moves blame. Applying still requires explicit approval.
        reviewReason: null,
        requiresHumanReview: false,
        evidenceAxes: CODE_EVIDENCE_AXES,
        // Gates and score settled this outright; the ladder was never entered.
        ...NO_LADDER(),
      };
    }

    return this.judgeSurvivors(runId, ctx, scored, specs);
  }

  /** Blind pairwise over the diffs, AB and BA, exactly as in response mode. */
  private async judgeSurvivors(
    runId: string,
    ctx: RunContext,
    survivors: CandidateRow[],
    specs: CandidateSpec[],
  ): Promise<RunResult> {
    const identifiers = ctx.request.candidates.map((c) => c.modelId);
    const subjects = [];
    for (const row of survivors) {
      subjects.push({
        id: row.id,
        label: row.label,
        text: await this.diffFor(runId, row.label, identifiers),
      });
    }

    const decision = await decide(
      this.client,
      {
        taskPrompt: ctx.request.taskSpec.prompt,
        ...(ctx.request.taskSpec.rubric ? { rubric: ctx.request.taskSpec.rubric } : {}),
        subjects,
        forbidden: identifiers,
        judge: ctx.request.judge,
        kind: "model",
      },
      {
        logger: this.log,
        signal: ctx.controller.signal,
        dispatch: (modelId, fn) =>
          this.scheduler.submit({ modelId, priority: 1, signal: ctx.controller.signal, run: fn }),
        onProgress: (pair, order) =>
          this.emit(runId, { type: "judge.progress", runId, pair, order, attempt: 1, at: this.now() }),
        onVerdict: (record) => {
          this.store.insertVerdict({
            id: randomUUID(),
            runId,
            judgeModel: record.judgeModel,
            pair: record.pair,
            presentationOrder: record.presentationOrder,
            winnerLabel: record.winnerLabel,
            confidence: record.confidence,
            reasons: JSON.stringify(record.reasons),
            parseAttempts: record.parseAttempts,
            rawPath: null,
          });
        },
      },
    );

    const ladder = {
      decidedAt: decision.decidedAt,
      ladderTrace: decision.trace,
      judgeCallsSpent: decision.judgeCallsSpent,
    };

    if (decision.winnerLabel === null) {
      return {
        outcome: "no_winner",
        winnerCandidateId: null,
        winnerLabel: null,
        confidence: null,
        reason: decision.detail,
        reviewReason: decision.reviewReason,
        requiresHumanReview: decision.reviewReason !== null,
        evidenceAxes: CODE_EVIDENCE_AXES,
        ...ladder,
      };
    }

    return {
      outcome: "winner",
      winnerCandidateId: decision.winnerId,
      winnerLabel: decision.winnerLabel,
      confidence: "judge",
      reason: `blind pairwise 판정 (후보 ${specs.length}개 중 ${survivors.length}개 생존, ${decision.detail})`,
      // Every survivor cleared the hard gates and the judge agreed in both
      // presentation orders — the strongest evidence this system produces.
      // Saying "review required" here would say it everywhere.
      reviewReason: decision.reviewReason,
      requiresHumanReview: decision.reviewReason !== null,
      evidenceAxes: CODE_EVIDENCE_AXES,
      ...ladder,
    };
  }

  private async diffFor(runId: string, label: string, identifiers: string[]): Promise<string> {
    const dir = this.store.runDir(runId);
    if (dir === null) return "";
    try {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const diff = await readFile(join(dir, "candidates", `${label}.diff`), "utf8");
      // Worktree paths embed the candidate label, which would identify the
      // submission to the judge.
      return scrubIdentifiers(diff.replace(/\.arena[\\/]wt[\\/][^\s"']+/g, "[WORKTREE]"), identifiers);
    } catch {
      return "";
    }
  }

  /**
   * Applies a candidate's diff to the main workspace.
   *
   * This is the only code path in the system that writes to the user's tree,
   * and it runs solely in response to an explicit request naming the candidate
   * and the base commit it was built against.
   */
  async apply(runId: string, request: ApplyRequest): Promise<ApplyResult> {
    const ctx = this.contexts.get(runId);
    const row = this.store.getRun(runId);
    if (!row || row.mode !== "code" || row.repoRoot === null || row.baseCommit === null) {
      throw new CodeRunPrecondition(["run is not an applicable code run"]);
    }
    if (request.expectedBaseCommit !== row.baseCommit) {
      throw new CodeRunPrecondition([
        `base commit mismatch: run was built on ${row.baseCommit}, request claims ${request.expectedBaseCommit}`,
      ]);
    }

    const candidate = this.store.listCandidates(runId).find((c) => c.id === request.candidateId);
    if (!candidate) throw new CodeRunPrecondition([`unknown candidate ${request.candidateId}`]);
    if (candidate.status !== "completed") {
      throw new CodeRunPrecondition([
        `candidate ${candidate.label} did not pass its gates (status=${candidate.status})`,
      ]);
    }

    const repo = ctx?.repo ?? (await GitRepo.open(row.repoRoot));
    const head = await repo.headSha();
    if (head !== row.baseCommit) {
      throw new CodeRunPrecondition([
        `workspace HEAD moved from ${row.baseCommit} to ${head} since the run started. Re-run against the new base.`,
      ]);
    }

    const artifacts = JSON.parse(candidate.artifacts ?? "{}") as CandidateArtifacts;
    const dir = this.store.runDir(runId);
    if (dir === null || artifacts.diffPath === null) {
      throw new CodeRunPrecondition(["candidate diff is not available on disk"]);
    }
    const { readFile } = await import("node:fs/promises");
    const diff = await readFile(artifacts.diffPath, "utf8");

    if (!(await repo.canApply(diff))) {
      throw new CodeRunPrecondition([
        `candidate ${candidate.label}'s diff no longer applies to the workspace`,
      ]);
    }
    // Snapshot first so the user can undo. Clean trees need no snapshot, and a
    // dirty tree was already refused at run creation.
    const revertRef = await repo.snapshot(`arena pre-apply ${runId}`);
    await repo.applyPatch(diff);

    const result: ApplyResult = {
      applied: true,
      candidateId: candidate.id,
      label: candidate.label,
      changedFiles: artifacts.changedFiles ?? [],
      revertRef,
      baseCommit: row.baseCommit,
    };
    this.store.updateRun(runId, { status: "completed" });
    await this.store.appendJsonl(`runs/${runId}/run.jsonl`, { type: "apply", at: this.now(), ...result });
    this.emit(runId, { type: "run.status", runId, status: "completed", at: this.now() });
    return result;
  }

  /**
   * Releases a run's worktrees.
   *
   * Deliberately not automatic: a reviewer comparing diffs needs the trees to
   * still exist. Cleanup happens when the user says they are done.
   */
  async cleanup(runId: string): Promise<string[]> {
    const ctx = this.contexts.get(runId);
    const row = this.store.getRun(runId);
    if (!row || row.repoRoot === null) return [];
    const repo = ctx?.repo ?? (await GitRepo.open(row.repoRoot));
    const removed: string[] = [];
    for (const [id, path] of ctx?.worktrees ?? new Map<string, string>()) {
      try {
        await repo.removeWorktree(path);
        removed.push(path);
      } catch {
        await rm(path, { recursive: true, force: true }).catch(() => {});
      }
      ctx?.worktrees.delete(id);
    }
    await repo.pruneWorktrees().catch(() => {});
    return removed;
  }

  candidateView(runId: string): Array<Record<string, unknown>> {
    return this.store.listCandidates(runId).map((row) => {
      const artifacts = row.artifacts === null ? null : (JSON.parse(row.artifacts) as CandidateArtifacts);
      return {
        candidateId: row.id,
        label: row.label,
        modelId: row.modelId,
        status: row.status,
        excludedReason: row.excludedReason,
        errorCode: row.errorCode,
        latencyMs: row.latencyMs,
        tokensIn: row.tokensIn,
        tokensOut: row.tokensOut,
        score: row.score,
        summary: row.responseText === null ? null : redactString(row.responseText),
        changedFiles: artifacts?.changedFiles ?? [],
        outOfScopeFiles: artifacts?.outOfScopeFiles ?? [],
        diffLines: artifacts?.diffLines ?? 0,
        toolCalls: artifacts?.toolCalls ?? 0,
        attempts: artifacts?.attempts ?? 0,
        commands: artifacts?.commands ?? [],
        gates: this.store.listGateResults(row.id).map((g) => ({
          gate: g.gate,
          passed: g.passed === 1,
          hard: g.hard === 1,
          flaky: g.flaky === 1,
          detail: g.detail,
          durationMs: g.durationMs,
        })),
        // Deliberately absent: worktree path and diff body. Both are fetched
        // through dedicated endpoints rather than pushed into list responses.
      };
    });
  }

  async diffOf(runId: string, candidateId: string): Promise<string | null> {
    const candidate = this.store.listCandidates(runId).find((c) => c.id === candidateId);
    if (!candidate?.artifacts) return null;
    const artifacts = JSON.parse(candidate.artifacts) as CandidateArtifacts;
    if (artifacts.diffPath === null) return null;
    try {
      const { readFile } = await import("node:fs/promises");
      return await readFile(artifacts.diffPath, "utf8");
    } catch {
      return null;
    }
  }

  private async writeRunRecord(
    runId: string,
    req: CreateCodeRunRequest,
    result: RunResult,
  ): Promise<void> {
    const row = this.store.getRun(runId);
    const candidates = this.store.listCandidates(runId);
    const at = this.now();

    await this.store.appendJsonl(`runs/${runId}/run.jsonl`, {
      type: "run",
      at,
      runId,
      mode: "code",
      repoRoot: row?.repoRoot,
      baseCommit: row?.baseCommit,
      runtimeAdapter: req.runtimeAdapter,
      prompt: req.taskSpec.prompt,
      systemPromptVersion: req.taskSpec.systemPromptVersion,
      acceptanceCommands: req.taskSpec.acceptanceCommands,
      sampling: req.sampling,
      judgeModel: req.judge.modelId,
      scoringVersion: SCORING_VERSION,
    });
    for (const c of candidates) {
      await this.store.appendJsonl(`runs/${runId}/run.jsonl`, {
        type: "candidate",
        at,
        runId,
        label: c.label,
        modelId: c.modelId,
        status: c.status,
        score: c.score,
        excludedReason: c.excludedReason,
        artifacts: c.artifacts === null ? null : (JSON.parse(c.artifacts) as CandidateArtifacts),
        gates: this.store.listGateResults(c.id),
      });
    }
    await this.store.appendJsonl(`runs/${runId}/run.jsonl`, { type: "result", at, runId, ...result });
    await this.store.appendJsonl("runs.jsonl", {
      at,
      runId,
      mode: "code",
      outcome: result.outcome,
      winnerLabel: result.winnerLabel,
      requiresHumanReview: result.requiresHumanReview,
      reason: result.reason,
    });
  }
}

function toCommandRecord(outcome: CommandOutcome): CandidateArtifacts["commands"][number] {
  return {
    gate: outcome.gate,
    cmd: outcome.cmd,
    args: outcome.args,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    durationMs: outcome.durationMs,
  };
}

function emptyArtifacts(worktree: string | null, attempts: number): CandidateArtifacts {
  return {
    diffPath: null,
    diffLines: 0,
    changedFiles: [],
    outOfScopeFiles: [],
    commands: [],
    toolCalls: 0,
    worktreePath: worktree,
    attempts,
  };
}
