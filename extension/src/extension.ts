import { existsSync } from "node:fs";
import { DesignerHost } from "./design/designerHost.ts";
import { join } from "node:path";
import * as vscode from "vscode";
import { AgentController } from "./agent/controller.js";
import { Orchestrator, OrchestratorError } from "./orchestrator.js";
import { ArenaPanel } from "./panel.js";
import type { Problem, RunSnapshot, StartRunRequest, WebviewMessage, WebviewState } from "./types.js";

const SECRET_KEY = "hasaArena.apiKey";

let orchestrator: Orchestrator | null = null;
let agent: AgentController | null = null;
let log: vscode.OutputChannel;
let currentRunId: string | null = null;
let currentBaseCommit: string | null = null;
let unsubscribe: (() => void) | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

/**
 * Two surfaces, one key.
 *
 * `hasa.chat` is the Coding Agent and is what a developer opens. `hasaArena.*`
 * is the model comparison, unchanged, and becomes the Harness's evaluation
 * engine later — §3 of the brief is explicit that it is kept, not replaced.
 *
 * They share `SECRET_KEY`, so a user who connected once has connected for both.
 */
let designer: DesignerHost | null = null;

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel("HASA Coding Agent");
  context.subscriptions.push(log);
  agent = new AgentController(context, log);

  context.subscriptions.push(
    // The Coding Agent.
    vscode.commands.registerCommand("hasa.chat", () => agent?.open()),
    vscode.commands.registerCommand("hasa.setApiKey", () => agent?.setApiKey()),
    vscode.commands.registerCommand("hasa.clearApiKey", async () => {
      await agent?.clearApiKey();
      vscode.window.showInformationMessage("HASA API Key를 삭제했습니다.");
      await pushState(context);
    }),

    // The designer. Reads a request and recommends a model for it; runs nothing.
    vscode.commands.registerCommand("hasa.designHarness", () => {
      designer ??= new DesignerHost({
        extensionUri: context.extensionUri,
        models: async () => (await agent?.modelProfiles()) ?? null,
        log: (line) => log.appendLine(line),
      });
      designer.open();
    }),

    // The Arena. Still here, now as the comparison engine behind the designer
    // rather than the product's front door.
    vscode.commands.registerCommand("hasaArena.compare", () => openPanel(context)),
    vscode.commands.registerCommand("hasaArena.setApiKey", () => promptForApiKey(context)),
    vscode.commands.registerCommand("hasaArena.clearApiKey", async () => {
      await context.secrets.delete(SECRET_KEY);
      orchestrator?.dispose();
      orchestrator = null;
      vscode.window.showInformationMessage("HASA API Key를 삭제했습니다.");
      await pushState(context);
    }),
    vscode.commands.registerCommand("hasaArena.showLog", () => log.show(true)),
    new vscode.Disposable(() => {
      unsubscribe?.();
      if (refreshTimer) clearInterval(refreshTimer);
      orchestrator?.dispose();
      agent?.dispose();
      designer?.dispose();
    }),
  );
}

export function deactivate(): void {
  unsubscribe?.();
  if (refreshTimer) clearInterval(refreshTimer);
  orchestrator?.dispose();
  agent?.dispose();
}

/**
 * The key lives in VS Code's SecretStorage and is read only when a process is
 * launched. It is never returned to the webview, written to the output channel,
 * or stored in settings. See docs/security-policy.md §1.2.
 */
async function promptForApiKey(context: vscode.ExtensionContext): Promise<boolean> {
  const value = await vscode.window.showInputBox({
    title: "HASA API Key",
    prompt: "키는 VS Code SecretStorage에 저장되며 패널이나 설정 파일에는 노출되지 않습니다.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (input) => (input.trim().length < 8 ? "키가 너무 짧습니다." : null),
  });
  if (value === undefined) return false;
  await context.secrets.store(SECRET_KEY, value.trim());
  // A new key may carry different model permissions, so anything running under
  // the old one is torn down rather than silently reused.
  orchestrator?.dispose();
  orchestrator = null;
  vscode.window.showInformationMessage("HASA API Key를 저장했습니다.");
  await pushState(context);
  return true;
}

function workspaceRoot(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

function workspaceIsGitRepo(): boolean {
  const root = workspaceRoot();
  return root !== null && existsSync(join(root, ".git"));
}

function arenaRoot(context: vscode.ExtensionContext): string {
  const configured = vscode.workspace.getConfiguration("hasaArena").get<string>("orchestratorPath", "");
  if (configured.trim().length > 0) return configured.trim();
  // The extension ships inside the arena checkout, one directory down.
  return join(context.extensionPath, "..");
}

function ensureOrchestrator(context: vscode.ExtensionContext): Orchestrator {
  if (orchestrator !== null) return orchestrator;
  const config = vscode.workspace.getConfiguration("hasaArena");
  orchestrator = new Orchestrator({
    arenaRoot: arenaRoot(context),
    externalUrl: config.get<string>("orchestratorUrl", ""),
    requestTimeoutMs: config.get<number>("requestTimeoutSeconds", 30) * 1000,
    log,
  });
  return orchestrator;
}

async function stateFor(context: vscode.ExtensionContext, phase: WebviewState["phase"]): Promise<WebviewState> {
  const key = await context.secrets.get(SECRET_KEY);
  return {
    phase: key ? phase : "needs-key",
    hasApiKey: Boolean(key),
    workspaceIsGitRepo: workspaceIsGitRepo(),
    workspaceRoot: workspaceRoot(),
    defaultCandidateCount: vscode.workspace
      .getConfiguration("hasaArena")
      .get<number>("defaultCandidateCount", 2),
    busy: false,
  };
}

async function pushState(
  context: vscode.ExtensionContext,
  phase: WebviewState["phase"] = "idle",
): Promise<void> {
  ArenaPanel.active?.post({ type: "state", state: await stateFor(context, phase) });
}

function reportProblem(problem: Problem): void {
  log.appendLine(`[arena] ${problem.kind}: ${problem.title} — ${problem.detail}`);
  ArenaPanel.active?.post({ type: "problem", problem });
}

function problemOf(err: unknown): Problem {
  if (err instanceof OrchestratorError) return err.problem;
  return {
    kind: "internal",
    title: "예기치 못한 오류",
    detail: err instanceof Error ? err.message : String(err),
    actions: [{ id: "showLog", label: "로그 보기" }],
  };
}

async function openPanel(context: vscode.ExtensionContext): Promise<void> {
  const panel = ArenaPanel.show(context.extensionUri, (message) => {
    void handleMessage(context, message);
  });
  panel.reveal();
  await pushState(context);
  await loadModels(context);
}

async function loadModels(context: vscode.ExtensionContext): Promise<void> {
  const key = await context.secrets.get(SECRET_KEY);
  if (!key) {
    await pushState(context, "needs-key");
    return;
  }
  try {
    const client = ensureOrchestrator(context);
    await client.ensureStarted(key);
    ArenaPanel.active?.post({ type: "catalogue", catalogue: await client.models() });
    ArenaPanel.active?.post({ type: "problemCleared" });
  } catch (err) {
    reportProblem(problemOf(err));
  }
}

async function handleMessage(context: vscode.ExtensionContext, message: WebviewMessage): Promise<void> {
  switch (message.type) {
    case "ready":
      await pushState(context);
      await loadModels(context);
      return;

    case "setApiKey":
      if (await promptForApiKey(context)) await loadModels(context);
      return;

    case "refreshModels":
      await loadModels(context);
      return;

    case "start":
      await startRun(context, message.request);
      return;

    case "cancel":
      if (currentRunId !== null) {
        try {
          await ensureOrchestrator(context).cancel(currentRunId);
          ArenaPanel.active?.post({ type: "activity", message: "취소 요청을 보냈습니다." });
        } catch (err) {
          reportProblem(problemOf(err));
        }
      }
      return;

    case "openDiff":
      await openDiff(context, message.candidateId, message.label);
      return;

    case "openResponse":
      await openResponse(context, message.candidateId, message.label);
      return;

    case "apply":
      await applyWinner(context, message.candidateId);
      return;

    case "reject":
      await rejectAll(context);
      return;

    case "dismissProblem":
      ArenaPanel.active?.post({ type: "problemCleared" });
      return;

    case "action":
      if (message.id === "setApiKey") await promptForApiKey(context);
      else if (message.id === "refreshModels") await loadModels(context);
      else if (message.id === "showLog") log.show(true);
      return;
  }
}

async function startRun(context: vscode.ExtensionContext, request: StartRunRequest): Promise<void> {
  const key = await context.secrets.get(SECRET_KEY);
  if (!key) {
    reportProblem({
      kind: "no_api_key",
      title: "API Key가 설정되지 않았습니다",
      detail: "비교를 시작하려면 먼저 HASA API Key를 설정하세요.",
      actions: [{ id: "setApiKey", label: "API Key 설정" }],
    });
    return;
  }

  try {
    const client = ensureOrchestrator(context);
    await client.ensureStarted(key);
    ArenaPanel.active?.post({ type: "problemCleared" });
    await pushState(context, "starting");

    const runId = await client.startRun({ ...request, repoRoot: request.repoRoot ?? workspaceRoot() });
    currentRunId = runId;
    currentBaseCommit = null;
    log.appendLine(`[arena] run ${runId} started (${request.mode})`);

    unsubscribe?.();
    unsubscribe = client.subscribe(runId, () => {
      // Events drive *when* to refresh; the snapshot is the single source of
      // truth for *what* the panel shows, so partial event payloads can never
      // desynchronise the view.
      void refresh(context, runId);
    });

    if (refreshTimer) clearInterval(refreshTimer);
    // A safety net for a dropped stream — cheap, and the run is local.
    refreshTimer = setInterval(() => void refresh(context, runId), 3000);
    await refresh(context, runId);
  } catch (err) {
    reportProblem(problemOf(err));
    await pushState(context, "idle");
  }
}

async function refresh(context: vscode.ExtensionContext, runId: string): Promise<void> {
  if (currentRunId !== runId) return;
  try {
    const snapshot: RunSnapshot = await ensureOrchestrator(context).snapshot(runId);
    currentBaseCommit = snapshot.baseCommit;
    ArenaPanel.active?.post({ type: "runUpdate", snapshot });

    const terminal = ["completed", "failed", "cancelled"].includes(snapshot.status);
    if (terminal) {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = null;
      unsubscribe?.();
      unsubscribe = null;
      await pushState(context, snapshot.result ? "reviewing" : "done");
    }
  } catch (err) {
    reportProblem(problemOf(err));
  }
}

/**
 * Opens a candidate's diff in a normal editor tab.
 *
 * Rendering it as a `diff` document rather than inside the panel gets VS Code's
 * own colouring, find, and accessibility behaviour for free — and keeps the
 * review surface identical to any other patch the user reads.
 */
async function openDiff(
  context: vscode.ExtensionContext,
  candidateId: string,
  label: string,
): Promise<void> {
  if (currentRunId === null) return;
  try {
    const patch = await ensureOrchestrator(context).diff(currentRunId, candidateId);
    if (patch.trim().length === 0) {
      vscode.window.showInformationMessage(`${label}: 변경 사항이 없습니다.`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument({ content: patch, language: "diff" });
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  } catch (err) {
    reportProblem(problemOf(err));
  }
}

/**
 * Opens a candidate's answer in a Markdown tab.
 *
 * The panel shows the full text already, but comparing two long answers is a
 * job for real editor tabs — find, word wrap and side-by-side already work
 * there, and nothing in a webview will match that.
 */
async function openResponse(
  context: vscode.ExtensionContext,
  candidateId: string,
  label: string,
): Promise<void> {
  if (currentRunId === null) return;
  try {
    const snapshot = await ensureOrchestrator(context).snapshot(currentRunId);
    const candidate = snapshot.candidates.find((c) => c.candidateId === candidateId);
    const text = candidate?.responseText ?? candidate?.summary ?? "";
    if (text.trim().length === 0) {
      vscode.window.showInformationMessage(`${label}: 표시할 응답이 없습니다.`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument({
      content: `# ${label} · ${candidate?.modelId ?? ""}\n\n${text}\n`,
      language: "markdown",
    });
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  } catch (err) {
    reportProblem(problemOf(err));
  }
}

async function applyWinner(context: vscode.ExtensionContext, candidateId: string): Promise<void> {
  if (currentRunId === null || currentBaseCommit === null) return;

  // A modal, and the diff first. Applying is the only action in the product
  // that writes to the user's tree, so it asks in the way VS Code reserves for
  // decisions that matter.
  const choice = await vscode.window.showWarningMessage(
    "선택한 후보의 diff를 현재 workspace에 적용합니다.",
    { modal: true, detail: "적용 전 상태는 git stash로 보존되어 되돌릴 수 있습니다." },
    "diff 먼저 보기",
    "적용",
  );
  if (choice === undefined) return;
  if (choice === "diff 먼저 보기") {
    await openDiff(context, candidateId, "winner");
    return;
  }

  try {
    const result = await ensureOrchestrator(context).apply(currentRunId, candidateId, currentBaseCommit);
    ArenaPanel.active?.post({
      type: "applied",
      label: result.label,
      changedFiles: result.changedFiles,
      revertRef: result.revertRef,
    });
    const message =
      result.revertRef === null
        ? `${result.label}을(를) 적용했습니다. 변경 파일 ${result.changedFiles.length}개.`
        : `${result.label}을(를) 적용했습니다. 이전 상태는 ${result.revertRef} 에 보존되었습니다.`;
    vscode.window.showInformationMessage(message);
    await pushState(context, "done");
  } catch (err) {
    reportProblem(problemOf(err));
  }
}

async function rejectAll(context: vscode.ExtensionContext): Promise<void> {
  if (currentRunId === null) return;
  const confirmed = await vscode.window.showWarningMessage(
    "이 실행의 모든 후보를 기각하고 worktree를 정리합니다.",
    { modal: true, detail: "workspace는 변경되지 않습니다. 후보 diff는 더 이상 열람할 수 없습니다." },
    "기각",
  );
  if (confirmed !== "기각") return;

  try {
    const result = await ensureOrchestrator(context).reject(currentRunId);
    ArenaPanel.active?.post({ type: "rejected", worktreesRemoved: result.worktreesRemoved });
    vscode.window.showInformationMessage(`기각했습니다. worktree ${result.worktreesRemoved}개를 정리했습니다.`);
    await pushState(context, "done");
  } catch (err) {
    reportProblem(problemOf(err));
  }
}
