import * as vscode from "vscode";
import type { AgentEvent, AgentMode } from "../../../src/agent/types.ts";
import { AgentHost } from "./agentHost.ts";
import { ChatPanel, type PanelMessage, type PanelState } from "./chatPanel.ts";
import { parseSavedArtifact } from "../../../src/agent/tools/mediaTools.ts";
import {
  imageTypeFor,
  looksSensitive,
  type Attachment,
} from "../../../src/agent/attachments.ts";

/**
 * Whether a frame may reach the gateway for the model catalogue.
 *
 * Only one caller says no, and only once: the frame drawn on open, before
 * `validate()` fetches the same list. Every other frame wants the catalogue.
 */
type CatalogueLoad = "with-catalogue" | "without-catalogue";

/** A file staged for the next message, with what the panel needs to show it. */
interface StagedAttachment {
  id: string;
  name: string;
  attachment: Attachment;
  note: string;
}

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
  /**
   * Files staged for the next message.
   *
   * Held here, not in the webview: the contents never cross the boundary. The
   * panel is told a name and a size and sends back an id.
   */
  private staged: StagedAttachment[] = [];
  private staleId = 0;

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

    // Checking the key on open rather than on first message: a user who typed
    // a wrong key should learn it now, not after writing a request.
    if (!(await this.host.connectionState()).hasApiKey) {
      await this.push();
      return;
    }

    // Drawn without the catalogue, because `validate()` is about to fetch it.
    // Loading it here spent a `GET /v1/models` whose answer the push below
    // replaced about 200ms later — two round trips to draw one list. It also
    // made the first frame wait on a request the user was not waiting for; now
    // the panel appears at once and the model picker fills in behind it.
    await this.push("without-catalogue");
    await this.host.validate();
    await this.push();
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

  private async state(catalogue: CatalogueLoad = "with-catalogue"): Promise<PanelState> {
    const withCatalogue = catalogue === "with-catalogue";
    // The two things here that reach the gateway. Everything below is local, so
    // a frame drawn without them is still a complete frame — mode, history,
    // staged files and connection state all appear.
    const listing = withCatalogue ? await this.host.conversationModels() : null;
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
      canGenerateMedia: withCatalogue ? await this.host.canGenerateMedia() : false,
      attachments: this.staged.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.attachment.kind,
        note: s.note,
      })),
      history: await this.host.listConversations(),
      openConversationId: this.host.currentConversationId,
      busy: this.host.busy,
      workspaceOpen: vscode.workspace.workspaceFolders !== undefined,
      changedFiles: changed,
      canUndo: changed.length > 0,
    };
  }

  private async push(catalogue: CatalogueLoad = "with-catalogue"): Promise<void> {
    this.panel?.post({ type: "state", state: await this.state(catalogue) });
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

      case "attach":
        await this.attach(message.source);
        return;

      case "removeAttachment":
        this.staged = this.staged.filter((s) => s.id !== message.id);
        await this.push();
        return;

      case "openHistory":
        await this.push();
        return;

      case "openConversation":
        await this.openConversation(message.id);
        return;

      case "deleteConversation":
        await this.host.deleteConversation(message.id);
        await this.push();
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
   * `parseSavedArtifact` lives beside the tool that writes the message, so the
   * format is one contract rather than a regex here and a string there. It also
   * rejects anything that is not a workspace-relative path, so only a file the
   * agent just wrote can become a URI.
   */
  private showArtifact(event: AgentEvent): void {
    if (event.type !== "tool_end" || !event.ok) return;
    if (event.name !== "generate_image" && event.name !== "generate_video") return;

    const folder = vscode.workspace.workspaceFolders?.[0];
    const panel = this.panel;
    if (folder === undefined || panel === null) return;

    const saved = parseSavedArtifact(event.detail);
    if (saved === null) return;

    const uri = vscode.Uri.joinPath(folder.uri, ...saved.path.split("/"));
    panel.post({
      type: "artifact",
      callId: event.callId,
      kind: saved.kind,
      src: panel.webviewUri(uri),
      path: saved.path,
    });
  }

  /**
   * Stages a file for the next message.
   *
   * Two doors, and they are not the same. The workspace picker stays inside the
   * folder the user opened; "from computer" is any file on disk, which is the
   * one that can pick up `.env` by accident — so that door asks first. It is
   * their file and they may mean it; what they must not do is send it without
   * noticing.
   */
  private async attach(source: "file" | "workspace"): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const picked =
      source === "workspace" && folder !== undefined
        ? await vscode.window.showOpenDialog({
            canSelectMany: true,
            defaultUri: folder.uri,
            openLabel: "첨부",
          })
        : await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: "첨부" });
    if (picked === undefined) return;

    for (const uri of picked) {
      const name =
        folder === undefined ? uri.path.split("/").pop() ?? "file" : vscode.workspace.asRelativePath(uri, false);

      if (looksSensitive(uri.fsPath)) {
        const go = await vscode.window.showWarningMessage(
          `${name} 은(는) 자격증명 파일로 보입니다.`,
          { modal: true, detail: "첨부하면 그 내용이 HASA 게이트웨이로 전송됩니다." },
          "그래도 첨부",
        );
        if (go !== "그래도 첨부") continue;
      }

      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const mediaType = imageTypeFor(name);
        this.staleId += 1;
        const id = `a${this.staleId}`;

        if (mediaType !== null) {
          this.staged.push({
            id,
            name,
            note: `${Math.max(1, Math.round(bytes.byteLength / 1024))} KB`,
            attachment: { kind: "image", name, mediaType, base64: Buffer.from(bytes).toString("base64") },
          });
          continue;
        }

        const text = Buffer.from(bytes).toString("utf8");
        // A file full of replacement characters is a binary the model cannot
        // read; inlining it would spend the context window on noise.
        const replacements = (text.match(/�/g) ?? []).length;
        if (replacements > text.length / 100) {
          void vscode.window.showWarningMessage(`${name} 은(는) 텍스트 파일이 아니라 첨부하지 않았습니다.`);
          continue;
        }
        this.staged.push({
          id,
          name,
          note: `${text.split("\n").length}줄`,
          attachment: { kind: "text", name, text },
        });
      } catch (err) {
        this.fail(err);
      }
    }
    await this.push();
  }

  /** Reopens a stored conversation and redraws the transcript from it. */
  private async openConversation(id: string): Promise<void> {
    if (!(await this.host.openConversation(id))) {
      this.panel?.post({ type: "notice", level: "error", text: "대화를 열지 못했습니다." });
      return;
    }
    const messages = await this.host.openConversationMessages();
    this.panel?.post({ type: "transcript", turns: transcriptOf(messages) });
    await this.push();
  }

  private async send(prompt: string): Promise<void> {
    const attachments = this.staged.map((s) => s.attachment);
    // Cleared before the turn, not after: a failed send should not silently
    // re-attach the same files to whatever the user types next.
    this.staged = [];
    await this.push();

    const result = await this.host.send(prompt, (event: AgentEvent) => {
      this.panel?.post({ type: "event", event });
      this.showArtifact(event);
    }, attachments);

    const attachmentProblem = this.host.takeAttachmentProblem();
    if (attachmentProblem !== null) {
      this.panel?.post({ type: "notice", level: "error", text: attachmentProblem });
    }
    if (result === null) {
      // A specific reason beats a generic one: "this model cannot converse" is
      // something the user can act on, "no usable model" is not.
      const problem = this.host.takeModelProblem();
      this.panel?.post({
        type: "notice",
        level: "error",
        text: problem ?? (vscode.workspace.workspaceFolders === undefined
          ? "폴더를 먼저 열어 주세요."
          : "사용할 수 있는 모델을 찾지 못했습니다. 설정에서 API Key를 확인해 주세요."),
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

/**
 * A stored conversation as turns the panel can draw.
 *
 * Tool calls and tool results are dropped. They were progress lines during the
 * turn, not part of the conversation, and §29's rule that the transcript reads
 * like a colleague's summary applies just as much when it is reopened a week
 * later.
 */
function transcriptOf(messages: readonly unknown[]): Array<{ role: "user" | "assistant"; text: string }> {
  const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const raw of messages) {
    if (raw === null || typeof raw !== "object") continue;
    const message = raw as { role?: unknown; content?: unknown };
    if (message.role !== "user" && message.role !== "assistant") continue;

    const text =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter((p): p is { type: "text"; text: string } =>
                p !== null && typeof p === "object" && (p as { type?: unknown }).type === "text")
              .map((p) => p.text)
              .join("\n")
          : "";
    if (text.trim().length === 0) continue;
    turns.push({ role: message.role, text });
  }
  return turns;
}
