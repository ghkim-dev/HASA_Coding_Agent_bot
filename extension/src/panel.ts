import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { HostMessage, WebviewMessage } from "./types.js";

/**
 * The comparison panel.
 *
 * Everything the webview knows arrives through `post`. It has no network
 * access, no key, and no orchestrator token — the CSP below blocks outbound
 * connections outright, so even a compromised script in the panel cannot
 * exfiltrate what it is never given.
 */
export class ArenaPanel {
  static readonly viewType = "hasaArena.compare";
  private static current: ArenaPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onMessage: (message: WebviewMessage) => void;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    onMessage: (message: WebviewMessage) => void,
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.onMessage = onMessage;

    this.panel.webview.html = this.render();
    this.panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.onMessage(message),
      null,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  static show(
    extensionUri: vscode.Uri,
    onMessage: (message: WebviewMessage) => void,
  ): ArenaPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (ArenaPanel.current) {
      ArenaPanel.current.panel.reveal(column);
      return ArenaPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      ArenaPanel.viewType,
      "HASA Agent Arena",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      },
    );
    ArenaPanel.current = new ArenaPanel(panel, extensionUri, onMessage);
    return ArenaPanel.current;
  }

  static get active(): ArenaPanel | undefined {
    return ArenaPanel.current;
  }

  post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  reveal(): void {
    this.panel.reveal();
  }

  dispose(): void {
    ArenaPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length > 0) this.disposables.pop()?.dispose();
  }

  private render(): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString("base64");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "main.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "main.css"));

    // `connect-src 'none'` is the load-bearing directive: the panel renders
    // state it is handed and cannot reach the orchestrator, HASA, or anywhere
    // else on its own.
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      "connect-src 'none'",
      "img-src 'none'",
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${style}" rel="stylesheet" />
  <title>HASA Agent Arena</title>
</head>
<body>
  <div id="app" class="app">
    <p class="loading" role="status">불러오는 중…</p>
  </div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
