import * as vscode from "vscode";
import type { DesignPayload } from "../../../src/design/designerPayload.ts";

/**
 * The designer window.
 *
 * A panel rather than a chat: nothing here starts a turn, so there is no
 * conversation to keep and no history to restore. One request goes in, one
 * design comes out, and the user reads it before deciding whether to run
 * anything at all.
 *
 * Deliberately the same shape as `ChatPanel` — created on demand, revealed if it
 * already exists, and silent about a `postMessage` that lands after the window
 * closed. The one difference worth naming is `localResourceRoots`: this panel
 * shows no workspace files, so the workspace is not a resource root and the
 * webview cannot address anything but `media/`.
 */

/** What the webview asks the host to do. */
export type DesignerMessage =
  | { type: "design"; text: string }
  | { type: "cancel" }
  | { type: "openSettings" }
  /**
   * Start the coding agent on the design that is on screen.
   *
   * Carries nothing. The host holds the design it just produced and the text it
   * produced it from; a webview that sent its own copy of either would be the
   * second place either one lives, and the two could disagree.
   */
  | { type: "handoff" };

/** What the host tells the webview. */
export type DesignerHostMessage =
  | { type: "designing" }
  /**
   * The design, typed.
   *
   * It was `unknown`, which meant the view could read any field name it liked
   * and get `undefined` — the failure `tsconfig.webview.json` was written for,
   * where `message.turns` survived a rename to `message.events` and every
   * reopened conversation drew a blank screen while the data was fine.
   * `DesignPayload` is where every field is decided, so it is what crosses.
   */
  | { type: "design"; design: DesignPayload }
  | { type: "error"; message: string }
  | { type: "models"; count: number; source: "gateway" | "none"; detail: string };

export class DesignerPanel {
  static active: DesignerPanel | null = null;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private closed = false;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    onMessage: (m: DesignerMessage) => void,
  ) {
    this.panel = panel;
    this.panel.webview.html = render(panel.webview, extensionUri);
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((m: DesignerMessage) => onMessage(m)),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  static show(
    extensionUri: vscode.Uri,
    onMessage: (m: DesignerMessage) => void,
  ): DesignerPanel {
    if (DesignerPanel.active !== null) {
      DesignerPanel.active.panel.reveal(vscode.ViewColumn.Active);
      return DesignerPanel.active;
    }
    const panel = vscode.window.createWebviewPanel(
      "hasaDesigner.design",
      "하네스 설계",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        // Only the extension's own media. A design shows no workspace file, so
        // the webview is given no way to address one.
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      },
    );
    DesignerPanel.active = new DesignerPanel(panel, extensionUri, onMessage);
    return DesignerPanel.active;
  }

  post(message: DesignerHostMessage): void {
    if (this.closed) return;
    void Promise.resolve(this.panel.webview.postMessage(message)).catch(() => {});
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    if (DesignerPanel.active === this) DesignerPanel.active = null;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}

function render(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const media = (name: string): vscode.Uri =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", name));
  const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
<link rel="stylesheet" href="${media("designer.css")}" />
<title>하네스 설계</title>
</head>
<body>
  <header class="head">
    <h1>하네스 자동 설계</h1>
    <p class="lede">무엇을 만들고 싶은지 그대로 쓰세요. 요구사항을 읽어 필요한 능력을 뽑고,
      가진 모델 중 어느 것이 그 일에 맞는지 근거와 함께 보여드립니다.
      <strong>여기서는 아무것도 실행되지 않습니다.</strong></p>
  </header>

  <section class="ask">
    <textarea id="req" rows="4" placeholder="예: 로그인 오류를 수정하고 테스트해줘."></textarea>
    <div class="askRow">
      <button id="go">설계하기</button>
      <button id="key" class="ghost hidden">API Key 설정</button>
      <span id="models" class="muted"></span>
    </div>
  </section>

  <section id="out" class="out hidden">
    <div id="summary" class="summary"></div>

    <div class="card">
      <h2>읽어낸 요구사항</h2>
      <div id="reqs" class="reqs"></div>
      <p id="conf" class="muted"></p>
    </div>

    <div class="card">
      <h2>이 일이 모델에게 요구하는 것</h2>
      <div id="demands" class="demands"></div>
      <p id="intents" class="muted"></p>
    </div>

    <div class="card" id="recCard">
      <h2>추천 모델</h2>
      <div id="rec"></div>
    </div>

    <div class="card hidden" id="qCard">
      <h2>확인이 필요한 것</h2>
      <p class="muted">아래는 런타임이 대신 정하지 않고 남겨둔 것입니다.
        아직 여기서 고를 수는 없습니다 — 요청에 한 줄 덧붙여 다시 설계하시면 반영됩니다.</p>
      <div id="questions"></div>
    </div>

    <div class="card">
      <h2>이 설계로 시작하기</h2>
      <p class="muted">요청과 추천 모델을 그대로 들고 코딩 에이전트를 엽니다.
        보내지는 않습니다 — 실행 여부는 그쪽 창에서 정하시면 됩니다.</p>
      <button id="handoff" type="button">코딩 에이전트로 넘기기</button>
      <p id="handoffWhy" class="muted"></p>
    </div>
  </section>

  <div id="err" class="err hidden"></div>

<script nonce="${nonce}" src="${media("designer.js")}"></script>
</body>
</html>`;
}
