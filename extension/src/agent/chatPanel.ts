import * as vscode from "vscode";
import type { AgentEvent, AgentMode } from "../../../src/agent/types.ts";
import { MODE_DEFINITIONS } from "../../../src/agent/modes.ts";
import type { ConnectionState } from "./agentHost.ts";

/**
 * The chat surface.
 *
 * What is deliberately absent is as much of the design as what is present:
 * there is no judge model, no candidate count, no S0–S4, no consensus. §24 of
 * the brief is explicit that the default screen is a mode, a model that says
 * "✨ Auto", and a box to type in. Everything the Arena knows how to show is
 * still there, behind the Arena's own command.
 *
 * The webview is outside the trust boundary. It receives rendered state and
 * sends intents; it never sees the key, and there is no message shape that
 * could carry one.
 */

export type PanelMessage =
  | { type: "ready" }
  | { type: "send"; prompt: string }
  | { type: "cancel" }
  | { type: "setMode"; mode: AgentMode }
  | { type: "setApprovalMode"; mode: "safe" | "balanced" | "auto" }
  | { type: "revokeGrants" }
  | { type: "setModel"; modelId: string | null }
  | { type: "connect" }
  | { type: "changeKey" }
  | { type: "refreshModels" }
  | { type: "verifyModels" }
  | { type: "attach"; source: "file" | "workspace" }
  | { type: "removeAttachment"; id: string }
  | { type: "openHistory" }
  | { type: "openConversation"; id: string }
  | { type: "deleteConversation"; id: string }
  | { type: "viewDiff" }
  | { type: "undo" }
  | { type: "keep" }
  | { type: "newChat" };

export interface PanelState {
  connection: ConnectionState;
  mode: AgentMode;
  modelLabel: string;
  /**
   * `verified` is what has been measured, not what is permitted. The two were
   * conflated once and a user with full access read it as having none.
   */
  models: Array<{ id: string; verified: boolean; usable: boolean }>;
  anyVerified: boolean;
  /**
   * Whether the gateway offers image or video generation.
   *
   * The picker deliberately does not list those models — selecting one sent the
   * turn to the chat endpoint and got a 404. So the panel has to say, once,
   * that they exist and how to reach them: by asking.
   */
  canGenerateMedia: boolean;
  /** Files staged for the next message. Names only — no contents cross over. */
  attachments: Array<{ id: string; name: string; kind: "text" | "image" | "audio"; note: string }>;
  /**
   * How much runs without asking, and what has been permanently allowed.
   *
   * In the panel rather than only in settings.json, because it is a decision
   * people make *while watching the agent work* — after ten minutes of correct
   * edits, not before the first one.
   */
  approvalMode: "safe" | "balanced" | "auto";
  standingGrants: string[];
  /** Past conversations for the key in use. */
  history: Array<{ id: string; title: string; updatedAt: number; messageCount: number }>;
  openConversationId: string | null;
  busy: boolean;
  workspaceOpen: boolean;
  changedFiles: string[];
  canUndo: boolean;
}

export type HostMessage =
  | { type: "state"; state: PanelState }
  | { type: "event"; event: AgentEvent }
  | { type: "notice"; level: "info" | "error"; text: string }
  /**
   * A file the agent generated, ready to show.
   *
   * Sent separately from the tool event because only the extension host can
   * mint a `vscode-webview:` URI, and the webview must never be handed a
   * filesystem path it could try to resolve itself.
   */
  | { type: "artifact"; callId: string; kind: "image" | "video"; src: string; path: string }
  /** Redraw the transcript from a conversation the user reopened. */
  | { type: "transcript"; turns: Array<{ role: "user" | "assistant"; text: string }> };

export class ChatPanel {
  static active: ChatPanel | null = null;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, onMessage: (m: PanelMessage) => void) {
    this.panel = panel;
    this.panel.webview.html = render(panel.webview, extensionUri);
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((m: PanelMessage) => onMessage(m)),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  static show(extensionUri: vscode.Uri, onMessage: (m: PanelMessage) => void): ChatPanel {
    if (ChatPanel.active !== null) {
      ChatPanel.active.panel.reveal(vscode.ViewColumn.Beside);
      return ChatPanel.active;
    }
    const panel = vscode.window.createWebviewPanel(
      "hasaAgent.chat",
      "HASA Coding Agent",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        // The workspace is a resource root so a generated image can be shown
        // where it was saved. Read-only and scoped to the folder the user
        // already opened — the webview gets a `vscode-webview:` URI, never a
        // path it could turn into a file read of its own.
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "media"),
          ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
        ],
      },
    );
    ChatPanel.active = new ChatPanel(panel, extensionUri, onMessage);
    return ChatPanel.active;
  }

  post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  /** Converts a workspace file into something the webview may load. */
  webviewUri(uri: vscode.Uri): string {
    return this.panel.webview.asWebviewUri(uri).toString();
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside);
  }

  dispose(): void {
    ChatPanel.active = null;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}

function render(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const media = (name: string): vscode.Uri =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", name));
  const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");

  const modeOptions = Object.values(MODE_DEFINITIONS)
    .map((m) => `<option value="${m.mode}">${m.label}</option>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource}; media-src ${webview.cspSource};">
<link rel="stylesheet" href="${media("chat.css")}">
<title>HASA Coding Agent</title>
</head>
<body>
  <header id="bar">
    <div class="field">
      <label for="mode">Mode</label>
      <select id="mode">${modeOptions}</select>
    </div>
    <div class="field">
      <label for="model">Model</label>
      <select id="model"><option value="">✨ Auto</option></select>
      <button id="verify" class="ghost" title="이 키로 쓸 수 있는 모델을 확인합니다">모델 확인</button>
    </div>
    <div class="field">
      <label for="approval">권한</label>
      <select id="approval" title="어디까지 확인 없이 진행할지 정합니다">
        <option value="safe">확인하고 진행</option>
        <option value="balanced">수정은 자동</option>
        <option value="auto">전부 자동</option>
      </select>
      <button id="revoke" class="ghost hidden" title="항상 허용해 둔 항목을 취소합니다"></button>
    </div>
    <div class="spacer"></div>
    <span id="status" class="status"></span>
    <button id="historyBtn" class="ghost" title="이전 대화">기록</button>
    <button id="newChat" class="ghost" title="새 대화">새 대화</button>
  </header>

  <section id="history" class="card hidden">
    <h2>이전 대화</h2>
    <p class="muted">이 API Key로 나눈 대화만 보입니다. 이 컴퓨터에만 저장됩니다.</p>
    <ul id="historyList"></ul>
    <div class="row">
      <div class="spacer"></div>
      <button id="historyClose" class="ghost">닫기</button>
    </div>
  </section>

  <section id="connect" class="card hidden">
    <h2>HASA Coding Agent</h2>
    <p id="connectDetail">시작하려면 HASA API Key를 입력해 주세요.</p>
    <button id="connectBtn" class="primary">연결</button>
  </section>

  <main id="transcript"></main>

  <section id="review" class="card hidden">
    <div id="reviewSummary"></div>
    <div class="row">
      <button id="viewDiff">변경 내용 보기</button>
      <button id="keep" class="primary">적용</button>
      <button id="undo">되돌리기</button>
    </div>
  </section>

  <footer>
    <div id="attachments" class="attachments hidden"></div>
    <textarea id="prompt" rows="3" placeholder="무엇을 만들어 드릴까요?"></textarea>
    <div class="row">
      <button id="attach" class="ghost" title="파일 첨부">＋</button>
      <div id="attachMenu" class="menu hidden" role="menu">
        <button data-source="file" role="menuitem">내 컴퓨터에서 올리기</button>
        <button data-source="workspace" role="menuitem">작업 공간에서 고르기</button>
      </div>
      <span id="hint" class="hint"></span>
      <div class="spacer"></div>
      <button id="cancel" class="ghost hidden">중지</button>
      <button id="send" class="primary">Send</button>
    </div>
  </footer>

  <script nonce="${nonce}" src="${media("chat.bundle.js")}"></script>
</body>
</html>`;
}
