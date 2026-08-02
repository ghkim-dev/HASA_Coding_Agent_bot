import * as vscode from "vscode";
import type { AgentEvent, AgentMode } from "../../../src/agent/types.ts";
import { AgentHost } from "./agentHost.ts";
import { ChatPanel, type PanelMessage, type PanelState } from "./chatPanel.ts";

/**
 * Joins the host to the panel.
 *
 * Deliberately thin. Everything that could be wrong — which model suits a mode,
 * which commands may run, when a checkpoint is taken — lives in `src/` where
 * `pnpm test` can reach it. What is left here is the part that needs VS Code,
 * and the rule for this file is that a bug in it should be visible by reading
 * it once.
 */
export class AgentController {
  private readonly host: AgentHost;
  private readonly context: vscode.ExtensionContext;
  private readonly log: vscode.OutputChannel;
  private panel: ChatPanel | null = null;

  constructor(context: vscode.ExtensionContext, log: vscode.OutputChannel) {
    this.context = context;
    this.log = log;
    this.host = new AgentHost(context, log);
  }

  async open(): Promise<void> {
    this.panel = ChatPanel.show(this.context.extensionUri, (message) => {
      void this.handle(message).catch((err) => this.fail(err));
    });
    this.panel.reveal();
    await this.push();
    // Checking the key on open rather than on first message: a user who typed
    // a wrong key should learn it now, not after writing a request.
    if ((await this.host.connectionState()).hasApiKey) {
      await this.host.validate();
      await this.push();
    }
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
  }

  async setApiKey(): Promise<void> {
    if (await this.host.promptForApiKey()) {
      await this.host.validate();
      await this.push();
    }
  }

  async clearApiKey(): Promise<void> {
    await this.host.clearApiKey();
    await this.push();
  }

  // -------------------------------------------------------------------------

  private async state(): Promise<PanelState> {
    const listing = await this.host.listModels();
    const changed = await this.host.changedFiles();
    return {
      connection: await this.host.connectionState(),
      mode: this.host.currentMode,
      modelLabel: this.host.modelLabel,
      models: (listing?.models ?? []).map((m) => ({
        id: m.id,
        // Measured, never inferred from the name — and "not measured" is not
        // the same claim as "not usable".
        verified: m.capabilities.chat !== "unknown",
        usable: m.capabilities.chat === true,
      })),
      anyVerified: (listing?.models ?? []).some((m) => m.capabilities.chat !== "unknown"),
      busy: this.host.busy,
      workspaceOpen: vscode.workspace.workspaceFolders !== undefined,
      changedFiles: changed,
      canUndo: changed.length > 0,
    };
  }

  private async push(): Promise<void> {
    this.panel?.post({ type: "state", state: await this.state() });
  }

  private fail(err: unknown): void {
    const text = err instanceof Error ? err.message : String(err);
    this.log.appendLine(`[hasa] ${text}`);
    this.panel?.post({ type: "notice", level: "error", text });
  }

  private async handle(message: PanelMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        await this.push();
        return;

      case "send":
        await this.send(message.prompt);
        return;

      case "cancel":
        this.host.cancel();
        return;

      case "setMode":
        this.host.setMode(message.mode as AgentMode);
        await this.push();
        return;

      case "setModel":
        this.host.selectModel(message.modelId);
        await this.push();
        return;

      case "connect":
        await this.setApiKey();
        return;

      case "changeKey":
        await this.setApiKey();
        return;

      case "refreshModels":
        await this.host.listModels(true);
        await this.push();
        return;

      case "verifyModels":
        await this.verify();
        return;

      case "viewDiff":
        await this.showDiff();
        return;

      case "undo":
        await this.undo();
        return;

      case "keep":
        this.host.keep();
        await this.push();
        this.panel?.post({ type: "notice", level: "info", text: "변경 사항을 적용했습니다." });
        return;

      case "newChat":
        this.host.newConversation();
        await this.push();
        return;
    }
  }

  /**
   * Measures the models, with a progress notification.
   *
   * A notification rather than a spinner in the panel: it takes several
   * seconds, and VS Code's own progress UI can be cancelled, which matters when
   * each step is a real request.
   */
  private async verify(): Promise<void> {
    const summary = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "HASA 모델 확인", cancellable: true },
      async (progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        return this.host.verifyModels(
          (done, total) => progress.report({ message: `${done}/${total}` }),
          controller.signal,
        );
      },
    );
    await this.push();
    this.panel?.post({ type: "notice", level: "info", text: summary });
  }

  /**
   * Shows a file the agent generated, rather than only naming it.
   *
   * An image whose only trace is the line "Saved assets/generated/x.png" is one
   * the user has to go and open. Since the point of generating it here was to
   * stay in the editor, it is rendered in the turn that made it.
   *
   * The path is matched against what the media tool writes and is checked for a
   * known extension before a URI is minted — the webview receives a
   * `vscode-webview:` URI it cannot turn back into a filesystem path.
   */
  private showArtifact(event: AgentEvent): void {
    if (event.type !== "tool_end" || !event.ok) return;
    if (event.name !== "generate_image" && event.name !== "generate_video") return;

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder === undefined) return;

    const relative = /^Saved (\S+) \(/.exec(event.detail)?.[1];
    if (relative === undefined || relative.includes("..")) return;

    const extension = /\.([a-z0-9]+)$/i.exec(relative)?.[1]?.toLowerCase() ?? "";
    const kind = ["png", "jpg", "jpeg", "webp", "gif"].includes(extension)
      ? "image"
      : ["webm", "mp4"].includes(extension)
        ? "video"
        : null;
    if (kind === null) return;

    const uri = vscode.Uri.joinPath(folder.uri, ...relative.split("/"));
    this.panel?.post({
      type: "artifact",
      callId: event.callId,
      kind,
      src: this.panel.webviewUri(uri),
      path: relative,
    });
  }

  private async send(prompt: string): Promise<void> {
    await this.push();
    const result = await this.host.send(prompt, (event: AgentEvent) => {
      this.panel?.post({ type: "event", event });
      this.showArtifact(event);
    });
    if (result === null) {
      this.panel?.post({
        type: "notice",
        level: "error",
        text: vscode.workspace.workspaceFolders === undefined
          ? "폴더를 먼저 열어 주세요."
          : "사용할 수 있는 모델을 찾지 못했습니다. 설정에서 API Key를 확인해 주세요.",
      });
    }
    await this.push();
  }

  /**
   * Shows the change as a normal diff tab.
   *
   * VS Code's own diff view rather than something rendered in the panel: it
   * brings colouring, find, folding and accessibility for free, and it makes
   * reviewing the agent's work identical to reviewing anyone else's.
   */
  private async showDiff(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder === undefined) return;
    const changed = await this.host.changedFiles();
    if (changed.length === 0) {
      void vscode.window.showInformationMessage("변경된 파일이 없습니다.");
      return;
    }
    // The source control view is where a user already knows how to read a
    // change set, so the single-file case opens the file and the rest defers
    // to git's own UI.
    if (changed.length === 1 && changed[0] !== undefined) {
      const uri = vscode.Uri.joinPath(folder.uri, changed[0]);
      await vscode.commands.executeCommand("git.openChange", uri).then(undefined, async () => {
        await vscode.window.showTextDocument(uri);
      });
      return;
    }
    await vscode.commands.executeCommand("workbench.view.scm");
  }

  private async undo(): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      "이 작업으로 변경된 내용을 모두 되돌립니다.",
      { modal: true, detail: "작업 시작 전 상태로 복원됩니다." },
      "되돌리기",
    );
    if (confirmed !== "되돌리기") return;
    const reverted = await this.host.undo();
    await this.push();
    this.panel?.post({
      type: "notice",
      level: reverted ? "info" : "error",
      text: reverted ? "되돌렸습니다." : "되돌릴 수 있는 변경 사항이 없습니다.",
    });
  }
}
