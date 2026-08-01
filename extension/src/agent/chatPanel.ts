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
  | { type: "setModel"; modelId: string | null }
  | { type: "connect" }
  | { type: "changeKey" }
  | { type: "refreshModels" }
  | { type: "viewDiff" }
  | { type: "undo" }
  | { type: "keep" }
  | { type: "newChat" };

export interface PanelState {
  connection: ConnectionState;
  mode: AgentMode;
  modelLabel: string;
  models: Array<{ id: string; capable: boolean }>;
  busy: boolean;
  workspaceOpen: boolean;
  changedFiles: string[];
  canUndo: boolean;
}

export type HostMessage =
  | { type: "state"; state: PanelState }
  | { type: "event"; event: AgentEvent }
  | { type: "notice"; level: "info" | "error"; text: string };

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
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      },
    );
    ChatPanel.active = new ChatPanel(panel, extensionUri, onMessage);
    return ChatPanel.active;
  }

  post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
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
    </div>
    <div class="spacer"></div>
    <span id="status" class="status"></span>
    <button id="newChat" class="ghost" title="새 대화">새 대화</button>
  </header>

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
    <textarea id="prompt" rows="3" placeholder="무엇을 만들어 드릴까요?"></textarea>
    <div class="row">
      <span id="hint" class="hint"></span>
      <div class="spacer"></div>
      <button id="cancel" class="ghost hidden">중지</button>
      <button id="send" class="primary">Send</button>
    </div>
  </footer>

  <script nonce="${nonce}" src="${media("chat.js")}"></script>
</body>
</html>`;
}
