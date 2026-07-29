import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { OutputChannel } from "vscode";
import type { ModelCatalogue, Problem, RunSnapshot, StartRunRequest } from "./types.js";

/**
 * Owns the orchestrator process and every request to it.
 *
 * This class is the trust boundary. The HASA key is handed to the child
 * process through its environment and never returned, logged, or forwarded; the
 * shared token that authenticates HTTP calls likewise stays here. The webview
 * talks to the extension host, and only the extension host talks to the
 * orchestrator.
 *
 * See docs/security-policy.md §1.3.
 */

export class OrchestratorError extends Error {
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(`${problem.title}: ${problem.detail}`);
    this.name = "OrchestratorError";
    this.problem = problem;
  }
}

function problemFor(status: number, body: string): Problem {
  const truncated = body.length > 400 ? `${body.slice(0, 400)}…` : body;
  switch (status) {
    case 401:
      return {
        kind: "unauthorized",
        title: "인증 실패 (401)",
        detail: "API Key가 없거나 유효하지 않습니다. 키를 다시 설정한 뒤 재시도하세요.",
        actions: [{ id: "setApiKey", label: "API Key 설정" }],
      };
    case 403:
      return {
        kind: "forbidden",
        title: "모델 접근 권한 없음 (403)",
        detail: `이 키에 해당 모델 권한이 없습니다. 다른 모델을 고르거나 관리 콘솔에서 권한을 확인하세요.\n${truncated}`,
        actions: [{ id: "refreshModels", label: "모델 목록 새로고침" }],
      };
    case 429:
      return {
        kind: "rate_limited",
        title: "요청 한도 초과 (429)",
        detail:
          "게이트웨이가 요청 한도를 알렸습니다. 오케스트레이터가 Retry-After를 준수해 자동으로 재시도합니다.",
        actions: [],
      };
    case 503:
      return {
        kind: "unavailable",
        title: "GPU 백엔드 사용 불가 (503)",
        detail: "모델 백엔드가 일시적으로 응답하지 않습니다. 자동 재시도 후에도 실패하면 잠시 뒤 다시 시도하세요.",
        actions: [],
      };
    case 400:
      return {
        kind: truncated.includes("unfair_run") ? "unfair_run" : "precondition",
        title: "요청이 거부되었습니다 (400)",
        detail: truncated,
        actions: [],
      };
    case 501:
      return {
        kind: "internal",
        title: "지원되지 않는 기능 (501)",
        detail: truncated,
        actions: [],
      };
    default:
      return {
        kind: "internal",
        title: `오케스트레이터 오류 (${status})`,
        detail: truncated,
        actions: [],
      };
  }
}

export interface OrchestratorOptions {
  /** Repository containing the arena sources, used when launching a process. */
  arenaRoot: string;
  /** Set to connect to an already-running orchestrator instead of spawning. */
  externalUrl: string;
  requestTimeoutMs: number;
  log: OutputChannel;
}

export class Orchestrator {
  private readonly opts: OrchestratorOptions;
  private child: ChildProcess | null = null;
  private token: string | null = null;
  private baseUrl: string | null = null;
  private eventAbort: AbortController | null = null;

  constructor(opts: OrchestratorOptions) {
    this.opts = opts;
  }

  get running(): boolean {
    return this.baseUrl !== null;
  }

  /**
   * Starts (or connects to) the orchestrator.
   *
   * The token is generated here and injected, rather than parsed back out of
   * the child's stdout: a value we chose cannot be raced, and it keeps the
   * secret off the log stream entirely.
   */
  async ensureStarted(apiKey: string): Promise<void> {
    if (this.baseUrl !== null) return;

    if (this.opts.externalUrl.trim().length > 0) {
      this.baseUrl = this.opts.externalUrl.replace(/\/+$/, "");
      this.token = process.env["ARENA_TOKEN"] ?? null;
      await this.waitForHealth();
      return;
    }

    const entry = join(this.opts.arenaRoot, "src", "server", "main.ts");
    if (!existsSync(entry)) {
      throw new OrchestratorError({
        kind: "orchestrator_unreachable",
        title: "오케스트레이터를 찾을 수 없습니다",
        detail:
          `${entry} 가 없습니다. 설정 hasaArena.orchestratorPath 에 HASA Agent Arena 체크아웃 경로를 지정하거나, ` +
          "hasaArena.orchestratorUrl 로 이미 실행 중인 오케스트레이터에 연결하세요.",
        actions: [],
      });
    }

    const token = randomBytes(24).toString("hex");
    const port = await freePort();

    this.opts.log.appendLine(`[arena] launching orchestrator on 127.0.0.1:${port}`);
    const child = spawn(process.execPath, [entry], {
      cwd: this.opts.arenaRoot,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        // The one place the key crosses a process boundary.
        HASA_API_KEY: apiKey,
        ARENA_TOKEN: token,
        ARENA_PORT: String(port),
        ARENA_HOST: "127.0.0.1",
        ARENA_LOG_LEVEL: "info",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // stdout carries the token banner; it must never reach the output channel.
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", (chunk: Buffer) => {
      this.opts.log.append(chunk.toString("utf8"));
    });
    child.on("exit", (code) => {
      this.opts.log.appendLine(`[arena] orchestrator exited with code ${code}`);
      this.child = null;
      this.baseUrl = null;
      this.token = null;
    });

    this.child = child;
    this.token = token;
    this.baseUrl = `http://127.0.0.1:${port}`;
    await this.waitForHealth();
  }

  private async waitForHealth(): Promise<void> {
    const deadline = Date.now() + 20_000;
    let lastError = "";
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.baseUrl}/healthz`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (res.ok) return;
        lastError = `HTTP ${res.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    this.baseUrl = null;
    throw new OrchestratorError({
      kind: "orchestrator_unreachable",
      title: "오케스트레이터에 연결할 수 없습니다",
      detail: `${lastError}. 출력 패널의 HASA Agent Arena 로그를 확인하세요.`,
      actions: [{ id: "showLog", label: "로그 보기" }],
    });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (this.baseUrl === null) {
      throw new OrchestratorError({
        kind: "orchestrator_unreachable",
        title: "오케스트레이터가 실행 중이 아닙니다",
        detail: "비교를 다시 시작하면 자동으로 기동됩니다.",
        actions: [],
      });
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.token !== null) headers["x-arena-token"] = this.token;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(this.opts.requestTimeoutMs),
      });
    } catch (err) {
      throw new OrchestratorError({
        kind: "orchestrator_unreachable",
        title: "오케스트레이터 통신 실패",
        detail: err instanceof Error ? err.message : String(err),
        actions: [{ id: "showLog", label: "로그 보기" }],
      });
    }
    if (!res.ok) throw new OrchestratorError(problemFor(res.status, await res.text()));
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text.length > 0 ? JSON.parse(text) : undefined) as T;
  }

  async models(): Promise<ModelCatalogue> {
    return this.request<ModelCatalogue>("/models");
  }

  async startRun(request: StartRunRequest): Promise<string> {
    if (request.mode === "code") {
      const body = {
        mode: "code",
        repoRoot: request.repoRoot,
        runtimeAdapter: request.runtimeAdapter,
        taskSpec: {
          prompt: request.prompt,
          acceptanceCommands: request.acceptanceCommands,
          writeScope: request.writeScope,
        },
        candidates: request.candidateModelIds.map((modelId) => ({ modelId })),
        judge: { modelId: request.judgeModelId },
      };
      const created = await this.request<{ runId: string }>("/code-runs", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return created.runId;
    }

    const created = await this.request<{ runId: string }>("/runs", {
      method: "POST",
      body: JSON.stringify({
        mode: "response",
        taskSpec: { prompt: request.prompt },
        candidates: request.candidateModelIds.map((modelId) => ({ modelId })),
        judge: { modelId: request.judgeModelId },
      }),
    });
    return created.runId;
  }

  async snapshot(runId: string): Promise<RunSnapshot> {
    const [run, candidates, verdicts] = await Promise.all([
      this.request<{
        runId: string;
        mode: RunSnapshot["mode"];
        status: string;
        result: RunSnapshot["result"];
      }>(`/runs/${runId}`),
      this.request<{ candidates: RunSnapshot["candidates"] }>(`/runs/${runId}/candidates`),
      this.request<{ verdicts: RunSnapshot["verdicts"] }>(`/runs/${runId}/verdicts`).catch(() => ({
        verdicts: [],
      })),
    ]);
    return {
      runId,
      mode: run.mode,
      status: run.status,
      baseCommit: (run as { baseCommit?: string | null }).baseCommit ?? null,
      candidates: candidates.candidates,
      verdicts: verdicts.verdicts,
      result: run.result,
    };
  }

  async cancel(runId: string): Promise<void> {
    await this.request(`/runs/${runId}/cancel`, { method: "POST" });
  }

  async diff(runId: string, candidateId: string): Promise<string> {
    if (this.baseUrl === null) return "";
    const headers: Record<string, string> = {};
    if (this.token !== null) headers["x-arena-token"] = this.token;
    const res = await fetch(`${this.baseUrl}/runs/${runId}/candidates/${candidateId}/diff`, {
      headers,
      signal: AbortSignal.timeout(this.opts.requestTimeoutMs),
    });
    if (!res.ok) throw new OrchestratorError(problemFor(res.status, await res.text()));
    return res.text();
  }

  async apply(
    runId: string,
    candidateId: string,
    expectedBaseCommit: string,
  ): Promise<{ label: string; changedFiles: string[]; revertRef: string | null }> {
    return this.request(`/runs/${runId}/apply`, {
      method: "POST",
      body: JSON.stringify({ candidateId, expectedBaseCommit }),
    });
  }

  async reject(runId: string): Promise<{ worktreesRemoved: number }> {
    return this.request(`/runs/${runId}/reject`, { method: "POST" });
  }

  /**
   * Consumes the run's SSE stream and hands decoded events to the caller.
   *
   * The stream is read here, in the extension host, rather than opened from the
   * webview: a webview connection would need the orchestrator token, which is
   * exactly the thing that must not cross into it.
   */
  subscribe(runId: string, onEvent: (event: { type: string; [k: string]: unknown }) => void): () => void {
    this.eventAbort?.abort();
    const controller = new AbortController();
    this.eventAbort = controller;

    void (async () => {
      if (this.baseUrl === null) return;
      const headers: Record<string, string> = { accept: "text/event-stream" };
      if (this.token !== null) headers["x-arena-token"] = this.token;
      try {
        const res = await fetch(`${this.baseUrl}/runs/${runId}/events`, {
          headers,
          signal: controller.signal,
        });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          let sep = buffer.indexOf("\n\n");
          while (sep !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (line) {
              try {
                onEvent(JSON.parse(line.slice(6)) as { type: string });
              } catch {
                // A malformed frame is not worth tearing the stream down for.
              }
            }
            sep = buffer.indexOf("\n\n");
          }
        }
      } catch {
        // Aborts and disconnects are expected; the caller polls a snapshot on
        // completion regardless.
      }
    })();

    return () => controller.abort();
  }

  dispose(): void {
    this.eventAbort?.abort();
    this.child?.kill();
    this.child = null;
    this.baseUrl = null;
    this.token = null;
  }
}

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
