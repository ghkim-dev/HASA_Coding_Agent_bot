import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger, type Logger } from "../hasa-client/logger.ts";
import type { ArenaEvent } from "../protocol/index.ts";

/**
 * Persistence.
 *
 * Three layers, deliberately:
 *   - in-memory index — what the HTTP API reads, so responses never depend on
 *     SQL shape drift
 *   - SQLite — the durable record, rehydrated on boot
 *   - JSONL per run — append-only forensic trail that survives a corrupted DB
 *
 * SQLite comes from `node:sqlite`. If the runtime does not expose it the store
 * degrades to memory + JSONL and says so loudly, rather than failing to start.
 */

export interface RunRow {
  id: string;
  mode: string;
  status: string;
  taskSpec: string;
  sampling: string;
  judge: string;
  createdAt: number;
  finishedAt: number | null;
  result: string | null;
  /** Code mode only. */
  repoRoot: string | null;
  baseCommit: string | null;
}

export interface CandidateRow {
  id: string;
  runId: string;
  label: string;
  modelId: string;
  spec: string;
  status: string;
  orderIndex: number;
  excludedReason: string | null;
  responseText: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number | null;
  errorCode: string | null;
  /** Code mode: serialised CandidateArtifacts. */
  artifacts: string | null;
  score: number | null;
}

export interface GateResultRow {
  id: string;
  runId: string;
  candidateId: string;
  gate: string;
  passed: number;
  hard: number;
  flaky: number;
  detail: string;
  durationMs: number;
}

export interface VerdictRow {
  id: string;
  runId: string;
  judgeModel: string;
  pair: string;
  presentationOrder: string;
  winnerLabel: string | null;
  confidence: number | null;
  reasons: string;
  parseAttempts: number;
  rawPath: string | null;
}

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  task_spec TEXT NOT NULL,
  sampling TEXT NOT NULL,
  judge TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  result TEXT,
  repo_root TEXT,
  base_commit TEXT
);
CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  label TEXT NOT NULL,
  model_id TEXT NOT NULL,
  spec TEXT NOT NULL,
  status TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  excluded_reason TEXT,
  response_text TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  latency_ms INTEGER,
  error_code TEXT,
  artifacts TEXT,
  score REAL,
  UNIQUE(run_id, label)
);
CREATE TABLE IF NOT EXISTS gate_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  gate TEXT NOT NULL,
  passed INTEGER NOT NULL,
  hard INTEGER NOT NULL,
  flaky INTEGER NOT NULL,
  detail TEXT NOT NULL,
  duration_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gates_candidate ON gate_results(candidate_id);
CREATE TABLE IF NOT EXISTS verdicts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  judge_model TEXT NOT NULL,
  pair TEXT NOT NULL,
  presentation_order TEXT NOT NULL,
  winner_label TEXT,
  confidence REAL,
  reasons TEXT NOT NULL,
  parse_attempts INTEGER NOT NULL,
  raw_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_candidates_run ON candidates(run_id);
CREATE INDEX IF NOT EXISTS idx_verdicts_run ON verdicts(run_id);
`;

export interface StoreOptions {
  /** Absolute or cwd-relative path. ":memory:" keeps SQLite without a file. */
  dbPath?: string | null;
  /** Root for per-run JSONL and artefacts. Null disables file output. */
  artifactRoot?: string | null;
  logger?: Logger;
}

async function openSqlite(dbPath: string, log: Logger): Promise<SqliteDatabase | null> {
  try {
    const mod = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
    if (dbPath !== ":memory:") await mkdir(dirname(dbPath), { recursive: true });
    const db = new mod.DatabaseSync(dbPath);
    db.exec(SCHEMA);
    return db;
  } catch (err) {
    log.warn("node:sqlite unavailable — falling back to memory + JSONL only", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export class Store {
  private readonly runs = new Map<string, RunRow>();
  private readonly candidates = new Map<string, CandidateRow[]>();
  private readonly verdicts = new Map<string, VerdictRow[]>();
  private readonly gates = new Map<string, GateResultRow[]>();
  private readonly log: Logger;
  private readonly artifactRoot: string | null;
  private db: SqliteDatabase | null = null;
  private writes: Promise<void> = Promise.resolve();

  private constructor(opts: StoreOptions) {
    this.log = opts.logger ?? createLogger("store");
    this.artifactRoot = opts.artifactRoot ?? null;
  }

  static async open(opts: StoreOptions = {}): Promise<Store> {
    const store = new Store(opts);
    if (opts.dbPath !== null) {
      store.db = await openSqlite(opts.dbPath ?? ".arena/arena.db", store.log);
      store.hydrate();
    }
    return store;
  }

  get sqliteEnabled(): boolean {
    return this.db !== null;
  }

  private hydrate(): void {
    if (!this.db) return;
    for (const row of this.db.prepare("SELECT * FROM runs").all() as Record<string, unknown>[]) {
      const run: RunRow = {
        id: String(row["id"]),
        mode: String(row["mode"]),
        status: String(row["status"]),
        taskSpec: String(row["task_spec"]),
        sampling: String(row["sampling"]),
        judge: String(row["judge"]),
        createdAt: Number(row["created_at"]),
        finishedAt: row["finished_at"] === null ? null : Number(row["finished_at"]),
        result: row["result"] === null ? null : String(row["result"]),
        repoRoot: row["repo_root"] == null ? null : String(row["repo_root"]),
        baseCommit: row["base_commit"] == null ? null : String(row["base_commit"]),
      };
      this.runs.set(run.id, run);
    }
    for (const row of this.db.prepare("SELECT * FROM candidates").all() as Record<string, unknown>[]) {
      const candidate: CandidateRow = {
        id: String(row["id"]),
        runId: String(row["run_id"]),
        label: String(row["label"]),
        modelId: String(row["model_id"]),
        spec: String(row["spec"]),
        status: String(row["status"]),
        orderIndex: Number(row["order_index"]),
        excludedReason: row["excluded_reason"] === null ? null : String(row["excluded_reason"]),
        responseText: row["response_text"] === null ? null : String(row["response_text"]),
        tokensIn: row["tokens_in"] === null ? null : Number(row["tokens_in"]),
        tokensOut: row["tokens_out"] === null ? null : Number(row["tokens_out"]),
        latencyMs: row["latency_ms"] === null ? null : Number(row["latency_ms"]),
        errorCode: row["error_code"] === null ? null : String(row["error_code"]),
        artifacts: row["artifacts"] == null ? null : String(row["artifacts"]),
        score: row["score"] == null ? null : Number(row["score"]),
      };
      const list = this.candidates.get(candidate.runId) ?? [];
      list.push(candidate);
      this.candidates.set(candidate.runId, list);
    }
    this.log.info("store hydrated", { runs: this.runs.size });
  }

  insertRun(row: RunRow): void {
    this.runs.set(row.id, row);
    this.db
      ?.prepare(
        "INSERT OR REPLACE INTO runs (id, mode, status, task_spec, sampling, judge, created_at, finished_at, result, repo_root, base_commit) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        row.id,
        row.mode,
        row.status,
        row.taskSpec,
        row.sampling,
        row.judge,
        row.createdAt,
        row.finishedAt,
        row.result,
        row.repoRoot,
        row.baseCommit,
      );
  }

  updateRun(id: string, patch: Partial<Pick<RunRow, "status" | "finishedAt" | "result">>): void {
    const existing = this.runs.get(id);
    if (!existing) return;
    const next: RunRow = { ...existing, ...patch };
    this.runs.set(id, next);
    this.db
      ?.prepare("UPDATE runs SET status = ?, finished_at = ?, result = ? WHERE id = ?")
      .run(next.status, next.finishedAt, next.result, id);
  }

  getRun(id: string): RunRow | null {
    return this.runs.get(id) ?? null;
  }

  listRuns(limit = 50): RunRow[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  insertCandidate(row: CandidateRow): void {
    const list = this.candidates.get(row.runId) ?? [];
    list.push(row);
    this.candidates.set(row.runId, list);
    this.db
      ?.prepare(
        "INSERT OR REPLACE INTO candidates (id, run_id, label, model_id, spec, status, order_index, excluded_reason, response_text, tokens_in, tokens_out, latency_ms, error_code, artifacts, score) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        row.id,
        row.runId,
        row.label,
        row.modelId,
        row.spec,
        row.status,
        row.orderIndex,
        row.excludedReason,
        row.responseText,
        row.tokensIn,
        row.tokensOut,
        row.latencyMs,
        row.errorCode,
        row.artifacts,
        row.score,
      );
  }

  updateCandidate(id: string, patch: Partial<Omit<CandidateRow, "id" | "runId">>): void {
    for (const [runId, list] of this.candidates) {
      const index = list.findIndex((c) => c.id === id);
      if (index === -1) continue;
      const current = list[index];
      if (!current) return;
      const next: CandidateRow = { ...current, ...patch };
      list[index] = next;
      this.candidates.set(runId, list);
      this.db
        ?.prepare(
          "UPDATE candidates SET status = ?, excluded_reason = ?, response_text = ?, tokens_in = ?, tokens_out = ?, latency_ms = ?, error_code = ?, artifacts = ?, score = ? WHERE id = ?",
        )
        .run(
          next.status,
          next.excludedReason,
          next.responseText,
          next.tokensIn,
          next.tokensOut,
          next.latencyMs,
          next.errorCode,
          next.artifacts,
          next.score,
          id,
        );
      return;
    }
  }

  listCandidates(runId: string): CandidateRow[] {
    return [...(this.candidates.get(runId) ?? [])].sort((a, b) => a.label.localeCompare(b.label));
  }

  insertVerdict(row: VerdictRow): void {
    const list = this.verdicts.get(row.runId) ?? [];
    list.push(row);
    this.verdicts.set(row.runId, list);
    this.db
      ?.prepare(
        "INSERT OR REPLACE INTO verdicts (id, run_id, judge_model, pair, presentation_order, winner_label, confidence, reasons, parse_attempts, raw_path) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        row.id,
        row.runId,
        row.judgeModel,
        row.pair,
        row.presentationOrder,
        row.winnerLabel,
        row.confidence,
        row.reasons,
        row.parseAttempts,
        row.rawPath,
      );
  }

  listVerdicts(runId: string): VerdictRow[] {
    return [...(this.verdicts.get(runId) ?? [])];
  }

  insertGateResult(row: GateResultRow): void {
    const list = this.gates.get(row.candidateId) ?? [];
    list.push(row);
    this.gates.set(row.candidateId, list);
    this.db
      ?.prepare(
        "INSERT OR REPLACE INTO gate_results (id, run_id, candidate_id, gate, passed, hard, flaky, detail, duration_ms) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        row.id,
        row.runId,
        row.candidateId,
        row.gate,
        row.passed,
        row.hard,
        row.flaky,
        row.detail,
        row.durationMs,
      );
  }

  listGateResults(candidateId: string): GateResultRow[] {
    return [...(this.gates.get(candidateId) ?? [])];
  }

  runDir(runId: string): string | null {
    return this.artifactRoot === null ? null : join(this.artifactRoot, "runs", runId);
  }

  /**
   * All file appends run through one chain.
   *
   * Two reasons: an append-only trail whose lines interleave is worthless for
   * reconstructing what happened, and callers that fire-and-forget need
   * something to await before they declare a run finished.
   */
  private enqueue(work: () => Promise<void>): Promise<void> {
    this.writes = this.writes.then(work, work);
    return this.writes;
  }

  /** Resolves once every queued append has hit disk. */
  async flush(): Promise<void> {
    await this.writes;
  }

  /** Append-only event trail. Best effort: a full disk must not kill a run. */
  appendEvent(runId: string, event: ArenaEvent): Promise<void> {
    const dir = this.runDir(runId);
    if (dir === null) return Promise.resolve();
    return this.enqueue(async () => {
      try {
        await mkdir(dir, { recursive: true });
        await appendFile(join(dir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
      } catch (err) {
        this.log.warn("failed to append event jsonl", { runId, error: err });
      }
    });
  }

  /**
   * Appends one JSON object per line. Used for the complete run record, which
   * is written to both SQLite and JSONL: SQLite answers queries, JSONL survives
   * a schema change or a corrupted database and can be diffed and grepped.
   */
  async appendJsonl(relativePath: string, record: unknown): Promise<string | null> {
    if (this.artifactRoot === null) return null;
    const full = join(this.artifactRoot, relativePath);
    let ok = true;
    await this.enqueue(async () => {
      try {
        await mkdir(dirname(full), { recursive: true });
        await appendFile(full, `${JSON.stringify(record)}\n`, "utf8");
      } catch (err) {
        ok = false;
        this.log.warn("failed to append jsonl", { relativePath, error: err });
      }
    });
    return ok ? full : null;
  }

  async writeArtifact(runId: string, relativePath: string, contents: string): Promise<string | null> {
    const dir = this.runDir(runId);
    if (dir === null) return null;
    const full = join(dir, relativePath);
    try {
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents, "utf8");
      return full;
    } catch (err) {
      this.log.warn("failed to write artifact", { runId, relativePath, error: err });
      return null;
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
