import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  ApplyRequestSchema,
  CreateCodeRunRequestSchema,
  CreateRunRequestSchema,
} from "../protocol/index.ts";
import { createLogger, type Logger } from "../hasa-client/logger.ts";
import { FairnessError } from "../core/fairness.ts";
import { CodeRunPrecondition, type CodeRunManager } from "../core/codeRunManager.ts";
import type { EventHub } from "../core/events.ts";
import type { RunManager } from "../core/runManager.ts";
import type { Store } from "../core/store.ts";

export interface ServerDeps {
  runs: RunManager;
  /** Phase 2. Absent means code mode is unavailable and returns 501. */
  codeRuns?: CodeRunManager;
  store: Store;
  hub: EventHub;
  logger?: Logger;
  /** Shared secret required on every request. Null disables the check (tests). */
  token?: string | null;
}

interface RunParams {
  id: string;
}

/**
 * Orchestrator HTTP surface.
 *
 * Two rules shape every response here:
 *   - the API key exists only in this process; no route can return it, and no
 *     route accepts it either
 *   - system prompts and raw judge transcripts stay server-side; the browser
 *     receives status, candidate output, and verdict summaries
 *
 * See docs/security-policy.md §1.3 and §4.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const log = deps.logger ?? createLogger("server");
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

  const requireToken = deps.token ?? null;
  if (requireToken !== null) {
    app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.url === "/healthz") return;
      const provided = req.headers["x-arena-token"];
      if (provided !== requireToken) {
        await reply.code(401).send({ error: "unauthorized" });
      }
    });
  }

  app.setErrorHandler(async (err, _req, reply) => {
    if (err instanceof FairnessError) {
      await reply.code(400).send({ error: "unfair_run", violations: err.violations });
      return;
    }
    if (err instanceof CodeRunPrecondition) {
      await reply.code(400).send({ error: "precondition_failed", reasons: err.reasons });
      return;
    }
    log.error("request failed", { error: err });
    await reply.code(500).send({ error: "internal_error" });
  });

  app.get("/healthz", async () => ({ ok: true, sqlite: deps.store.sqliteEnabled }));

  app.post("/runs", async (req, reply) => {
    const parsed = CreateRunRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      await reply.code(400).send({
        error: "invalid_request",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      return;
    }
    const runId = deps.runs.create(parsed.data);
    await reply.code(202).send({ runId, status: "queued" });
  });

  app.post("/code-runs", async (req, reply) => {
    if (!deps.codeRuns) {
      await reply.code(501).send({ error: "code_mode_unavailable" });
      return;
    }
    const parsed = CreateCodeRunRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      await reply.code(400).send({
        error: "invalid_request",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      return;
    }
    const runId = await deps.codeRuns.create(parsed.data);
    await reply.code(202).send({ runId, status: "queued" });
  });

  app.get<{ Params: RunParams }>("/runs/:id/candidates/:cid/diff", async (req, reply) => {
    const { id } = req.params;
    const cid = (req.params as unknown as { cid: string }).cid;
    if (!deps.codeRuns || !deps.store.getRun(id)) {
      await reply.code(404).send({ error: "not_found" });
      return;
    }
    const diff = await deps.codeRuns.diffOf(id, cid);
    if (diff === null) {
      await reply.code(404).send({ error: "diff_not_available" });
      return;
    }
    await reply.type("text/plain; charset=utf-8").send(diff);
  });

  /**
   * The only route that writes to the user's workspace. It requires the caller
   * to name both the candidate and the base commit it was built against, so a
   * stale UI cannot apply a diff to a tree that has since moved.
   */
  app.post<{ Params: RunParams }>("/runs/:id/apply", async (req, reply) => {
    if (!deps.codeRuns) {
      await reply.code(501).send({ error: "code_mode_unavailable" });
      return;
    }
    if (!deps.store.getRun(req.params.id)) {
      await reply.code(404).send({ error: "not_found" });
      return;
    }
    const parsed = ApplyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: "invalid_request" });
      return;
    }
    const result = await deps.codeRuns.apply(req.params.id, parsed.data);
    await reply.send(result);
  });

  /** Explicit rejection: nothing is applied and the worktrees are released. */
  app.post<{ Params: RunParams }>("/runs/:id/reject", async (req, reply) => {
    if (!deps.codeRuns || !deps.store.getRun(req.params.id)) {
      await reply.code(404).send({ error: "not_found" });
      return;
    }
    const removed = await deps.codeRuns.cleanup(req.params.id);
    await reply.send({ rejected: true, worktreesRemoved: removed.length });
  });

  app.get("/runs", async () => ({
    runs: deps.store.listRuns().map((r) => ({
      runId: r.id,
      mode: r.mode,
      status: r.status,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
    })),
  }));

  app.get<{ Params: RunParams }>("/runs/:id", async (req, reply) => {
    const row = deps.store.getRun(req.params.id);
    if (!row) {
      await reply.code(404).send({ error: "not_found" });
      return;
    }
    const taskSpec = JSON.parse(row.taskSpec) as { prompt: string; systemPromptVersion: string };
    const judge = JSON.parse(row.judge) as { modelId: string };
    await reply.send({
      runId: row.id,
      mode: row.mode,
      status: row.status,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
      // The user's own prompt comes back; the system prompt does not.
      task: { prompt: taskSpec.prompt, systemPromptVersion: taskSpec.systemPromptVersion },
      sampling: JSON.parse(row.sampling),
      judgeModel: judge.modelId,
      result: row.result === null ? null : JSON.parse(row.result),
    });
  });

  app.get<{ Params: RunParams }>("/runs/:id/candidates", async (req, reply) => {
    const row = deps.store.getRun(req.params.id);
    if (!row) {
      await reply.code(404).send({ error: "not_found" });
      return;
    }
    // Code runs carry gates, diffs and command outcomes that the response-mode
    // view knows nothing about.
    const view =
      row.mode === "code" && deps.codeRuns
        ? deps.codeRuns.candidateView(req.params.id)
        : deps.runs.candidateView(req.params.id);
    await reply.send({ candidates: view });
  });

  app.get<{ Params: RunParams }>("/runs/:id/verdicts", async (req, reply) => {
    if (!deps.store.getRun(req.params.id)) {
      await reply.code(404).send({ error: "not_found" });
      return;
    }
    await reply.send({
      verdicts: deps.store.listVerdicts(req.params.id).map((v) => ({
        pair: v.pair,
        presentationOrder: v.presentationOrder,
        winnerLabel: v.winnerLabel,
        confidence: v.confidence,
        reasons: JSON.parse(v.reasons),
        parseAttempts: v.parseAttempts,
        // rawPath deliberately omitted: transcripts stay on the server
      })),
    });
  });

  app.post<{ Params: RunParams }>("/runs/:id/cancel", async (req, reply) => {
    if (!deps.store.getRun(req.params.id)) {
      await reply.code(404).send({ error: "not_found" });
      return;
    }
    const row = deps.store.getRun(req.params.id);
    const cancelled =
      row?.mode === "code" && deps.codeRuns
        ? deps.codeRuns.cancel(req.params.id)
        : deps.runs.cancel(req.params.id);
    await reply.send({ cancelled });
  });

  app.get<{ Params: RunParams }>("/runs/:id/events", (req, reply) => {
    const runId = req.params.id;
    if (!deps.store.getRun(runId)) {
      void reply.code(404).send({ error: "not_found" });
      return;
    }
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    raw.write(": connected\n\n");

    const lastHeader = req.headers["last-event-id"];
    const lastEventId = Number(Array.isArray(lastHeader) ? lastHeader[0] : (lastHeader ?? 0));

    const unsubscribe = deps.hub.forRun(runId).subscribe((event, id) => {
      raw.write(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
      if (event.type === "run.status" && ["completed", "failed", "cancelled"].includes(event.status)) {
        raw.end();
      }
    }, Number.isFinite(lastEventId) ? lastEventId : 0);

    const heartbeat = setInterval(() => raw.write(": ping\n\n"), 15_000);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.raw.on("close", cleanup);
    raw.on("close", cleanup);
  });

  return app;
}
