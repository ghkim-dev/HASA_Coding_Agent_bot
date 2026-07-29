/**
 * The extension host ↔ webview message contract.
 *
 * The webview is outside the trust boundary. There is deliberately no field in
 * either direction that can carry the HASA API key, the orchestrator token, or
 * a system prompt — the type system is the first line of defence rather than a
 * runtime filter. See docs/security-policy.md §1.3.
 */

export type RunMode = "response" | "code";

export interface ModelEntry {
  modelId: string;
  eligibility: {
    responseCompare: boolean;
    codingAgent: boolean;
    patchMode: boolean;
    judge: boolean;
    reasons: string[];
  };
  maxOutputTokens: number | null;
  latencyMs: number | null;
  toolsStatus: string;
  toolsDetail: string | null;
}

export interface ModelCatalogue {
  probedAt: string | null;
  staleness: string[];
  models: ModelEntry[];
}

export interface AcceptanceCommandInput {
  gate: "install" | "build" | "test" | "typecheck" | "lint";
  kind: "regression" | "acceptance";
  cmd: string;
  args: string[];
  timeoutMs: number;
}

export interface StartRunRequest {
  mode: RunMode;
  prompt: string;
  candidateModelIds: string[];
  judgeModelId: string;
  runtimeAdapter: "agent" | "patch";
  acceptanceCommands: AcceptanceCommandInput[];
  writeScope: string[];
  repoRoot: string | null;
}

export interface GateView {
  gate: string;
  passed: boolean;
  hard: boolean;
  flaky: boolean;
  detail: string;
  durationMs: number;
}

export interface CommandView {
  gate: string;
  cmd: string;
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export interface CandidateView {
  candidateId: string;
  label: string;
  modelId: string;
  status: "queued" | "running" | "completed" | "failed" | "excluded";
  excludedReason: string | null;
  errorCode: string | null;
  latencyMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  score: number | null;
  summary: string | null;
  responseText?: string | null;
  changedFiles?: string[];
  outOfScopeFiles?: string[];
  diffLines?: number;
  toolCalls?: number;
  attempts?: number;
  commands?: CommandView[];
  gates?: GateView[];
}

export interface RunResultView {
  outcome: "winner" | "no_winner";
  winnerCandidateId: string | null;
  winnerLabel: string | null;
  confidence: "sole_survivor" | "objective" | "judge" | null;
  reason: string;
  requiresHumanReview: boolean;
}

export interface VerdictView {
  pair: string;
  presentationOrder: "AB" | "BA";
  winnerLabel: string | null;
  confidence: number | null;
  reasons: string[];
  parseAttempts: number;
}

export interface RunSnapshot {
  runId: string;
  mode: RunMode;
  status: string;
  baseCommit: string | null;
  candidates: CandidateView[];
  verdicts: VerdictView[];
  result: RunResultView | null;
}

/** Errors the UI must show distinctly rather than as a generic failure. */
export type ProblemKind =
  | "no_api_key"
  | "orchestrator_unreachable"
  | "unauthorized" // 401 — key missing or invalid
  | "forbidden" // 403 — key lacks access to a model
  | "rate_limited" // 429
  | "unavailable" // 503
  | "precondition" // dirty tree, not a repo, HEAD moved
  | "unfair_run"
  | "invalid_request"
  | "cancelled"
  | "internal";

export interface Problem {
  kind: ProblemKind;
  title: string;
  detail: string;
  /** Steps the user can actually take. Empty when there is nothing to do. */
  actions: Array<{ id: string; label: string }>;
}

/** Extension host → webview. */
export type HostMessage =
  | { type: "state"; state: WebviewState }
  | { type: "catalogue"; catalogue: ModelCatalogue }
  | { type: "runUpdate"; snapshot: RunSnapshot }
  | { type: "activity"; message: string }
  | { type: "problem"; problem: Problem }
  | { type: "problemCleared" }
  | { type: "applied"; label: string; changedFiles: string[]; revertRef: string | null }
  | { type: "rejected"; worktreesRemoved: number };

export interface WebviewState {
  phase: "needs-key" | "idle" | "starting" | "running" | "evaluating" | "reviewing" | "done";
  hasApiKey: boolean;
  workspaceIsGitRepo: boolean;
  workspaceRoot: string | null;
  defaultCandidateCount: number;
  busy: boolean;
}

/** Webview → extension host. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "setApiKey" }
  | { type: "refreshModels" }
  | { type: "start"; request: StartRunRequest }
  | { type: "cancel" }
  | { type: "openDiff"; candidateId: string; label: string }
  | { type: "apply"; candidateId: string }
  | { type: "reject" }
  | { type: "dismissProblem" }
  | { type: "action"; id: string };
