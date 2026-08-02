// @ts-check
"use strict";

/**
 * The chat webview.
 *
 * Outside the trust boundary: it renders what it is sent and sends what the
 * user did. There is no API key here, no gateway URL, and no message shape that
 * could carry one.
 *
 * What it shows during a turn is a progress line per tool, not a transcript.
 * The user reviews a diff at the end; a log of forty tool calls is something
 * they scroll past, and §29 is explicit that the result should read like a
 * colleague's summary rather than an execution trace.
 */

const vscode = acquireVsCodeApi();

const el = {
  bar: /** @type {HTMLElement} */ (document.getElementById("bar")),
  mode: /** @type {HTMLSelectElement} */ (document.getElementById("mode")),
  model: /** @type {HTMLSelectElement} */ (document.getElementById("model")),
  status: /** @type {HTMLElement} */ (document.getElementById("status")),
  newChat: /** @type {HTMLButtonElement} */ (document.getElementById("newChat")),
  verify: /** @type {HTMLButtonElement} */ (document.getElementById("verify")),
  connect: /** @type {HTMLElement} */ (document.getElementById("connect")),
  connectDetail: /** @type {HTMLElement} */ (document.getElementById("connectDetail")),
  connectBtn: /** @type {HTMLButtonElement} */ (document.getElementById("connectBtn")),
  transcript: /** @type {HTMLElement} */ (document.getElementById("transcript")),
  review: /** @type {HTMLElement} */ (document.getElementById("review")),
  reviewSummary: /** @type {HTMLElement} */ (document.getElementById("reviewSummary")),
  viewDiff: /** @type {HTMLButtonElement} */ (document.getElementById("viewDiff")),
  keep: /** @type {HTMLButtonElement} */ (document.getElementById("keep")),
  undo: /** @type {HTMLButtonElement} */ (document.getElementById("undo")),
  prompt: /** @type {HTMLTextAreaElement} */ (document.getElementById("prompt")),
  hint: /** @type {HTMLElement} */ (document.getElementById("hint")),
  cancel: /** @type {HTMLButtonElement} */ (document.getElementById("cancel")),
  send: /** @type {HTMLButtonElement} */ (document.getElementById("send")),
};

/** The agent turn being rendered, if one is open. */
let current = null;

function post(message) {
  vscode.postMessage(message);
}

function scrollToEnd() {
  el.transcript.scrollTop = el.transcript.scrollHeight;
}

function addUserTurn(text) {
  const node = document.createElement("div");
  node.className = "turn user";
  node.textContent = text;
  el.transcript.appendChild(node);
  scrollToEnd();
}

function openAgentTurn() {
  const node = document.createElement("div");
  node.className = "turn agent";
  const body = document.createElement("div");
  body.className = "body";
  node.appendChild(body);
  el.transcript.appendChild(node);
  current = { node, body, steps: new Map() };
  scrollToEnd();
  return current;
}

function stepLine(icon, text, className) {
  const line = document.createElement("div");
  line.className = className ? `step ${className}` : "step";
  const glyph = document.createElement("span");
  glyph.className = "icon";
  glyph.textContent = icon;
  const label = document.createElement("span");
  label.textContent = text;
  line.append(glyph, label);
  return line;
}

function notice(level, text) {
  const node = document.createElement("div");
  node.className = level === "error" ? "notice error" : "notice";
  node.textContent = text;
  el.transcript.appendChild(node);
  scrollToEnd();
}

/**
 * Renders one agent event.
 *
 * Only three of them produce a line the user sees. `step`, `reasoning` and the
 * token counters are deliberately silent: a progress display that narrates
 * every internal transition is one nobody reads.
 */
function renderEvent(event) {
  if (current === null) openAgentTurn();
  const turn = current;

  switch (event.type) {
    case "text":
      turn.body.textContent += event.delta;
      break;

    case "tool_start": {
      const line = stepLine("·", event.summary);
      turn.steps.set(event.callId, line);
      turn.node.appendChild(line);
      break;
    }

    case "tool_approval": {
      const line = turn.steps.get(event.callId);
      if (!line) break;
      if (event.outcome === "denied") {
        line.className = "step denied";
        line.lastChild.textContent += " — 사용자가 거부했습니다";
        line.firstChild.textContent = "✕";
      } else if (event.outcome === "blocked") {
        line.className = "step blocked";
        line.lastChild.textContent += " — 허용되지 않는 작업입니다";
        line.firstChild.textContent = "✕";
      }
      break;
    }

    case "tool_end": {
      const line = turn.steps.get(event.callId);
      if (!line || line.className !== "step") break;
      line.firstChild.textContent = event.ok ? "✓" : "!";
      if (!event.ok) line.className = "step failed";
      break;
    }

    case "checkpoint":
      turn.node.appendChild(stepLine("↩", event.detail));
      break;

    case "done":
      // The summary is the model's own words when it produced them, so an empty
      // body is filled rather than duplicated.
      if (turn.body.textContent.trim().length === 0) turn.body.textContent = event.summary;
      current = null;
      break;

    case "error":
      notice("error", event.message);
      current = null;
      break;

    default:
      break;
  }
  scrollToEnd();
}

function renderState(state) {
  const { connection } = state;

  el.connect.classList.toggle("hidden", connection.hasApiKey && connection.connected);
  el.connectDetail.textContent = connection.detail;
  el.connectBtn.textContent = connection.hasApiKey ? "다시 연결" : "연결";

  el.status.className = connection.connected ? "status ok" : "status off";
  el.status.textContent = connection.connected
    ? `${connection.modelCount}개 모델`
    : connection.hasApiKey
      ? "연결 안 됨"
      : "";

  el.mode.value = state.mode;

  // Rebuilt rather than patched: the list changes when the key changes, and a
  // stale option is a model the user cannot actually use.
  const chosen = el.model.value;
  el.model.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = state.modelLabel.startsWith("✨") ? state.modelLabel : "✨ Auto";
  el.model.appendChild(auto);
  for (const model of state.models) {
    const option = document.createElement("option");
    option.value = model.id;
    // Three states, not two. Before this said "확인되지 않음" for anything not
    // yet measured, which a user with full access read as "you have no
    // permission" — the one thing it does not mean.
    option.textContent = !model.verified
      ? model.id
      : model.usable
        ? `${model.id} ✓`
        : `${model.id} (사용 불가)`;
    el.model.appendChild(option);
  }
  el.model.value = state.models.some((m) => m.id === chosen) ? chosen : "";

  // Offered only when there is a key to measure with, and worth pointing at
  // while nothing has been measured yet.
  el.verify.disabled = state.busy || !connection.connected;
  el.verify.classList.toggle("hidden", !connection.connected);
  el.verify.classList.toggle("primary", connection.connected && !state.anyVerified);

  el.send.disabled = state.busy || !connection.connected || !state.workspaceOpen;
  el.cancel.classList.toggle("hidden", !state.busy);
  el.prompt.disabled = state.busy;

  el.hint.textContent = !state.workspaceOpen
    ? "폴더를 먼저 열어 주세요."
    : state.busy
      ? "작업 중…"
      : "Ctrl+Enter 로 전송";

  const changed = state.changedFiles;
  el.review.classList.toggle("hidden", changed.length === 0);
  if (changed.length > 0) {
    el.reviewSummary.innerHTML = "";
    const heading = document.createElement("div");
    heading.textContent = `${changed.length}개 파일이 변경되었습니다`;
    const files = document.createElement("div");
    files.className = "files";
    files.textContent = changed.slice(0, 12).join("\n") + (changed.length > 12 ? "\n…" : "");
    el.reviewSummary.append(heading, files);
  }
  el.undo.disabled = !state.canUndo;
}

// ---------------------------------------------------------------- intents

el.send.addEventListener("click", () => {
  const prompt = el.prompt.value.trim();
  if (prompt.length === 0) return;
  addUserTurn(prompt);
  el.prompt.value = "";
  openAgentTurn();
  post({ type: "send", prompt });
});

el.prompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    el.send.click();
  }
});

el.cancel.addEventListener("click", () => post({ type: "cancel" }));
el.mode.addEventListener("change", () => post({ type: "setMode", mode: el.mode.value }));
el.model.addEventListener("change", () => post({ type: "setModel", modelId: el.model.value || null }));
el.connectBtn.addEventListener("click", () => post({ type: "connect" }));
el.viewDiff.addEventListener("click", () => post({ type: "viewDiff" }));
el.keep.addEventListener("click", () => post({ type: "keep" }));
el.undo.addEventListener("click", () => post({ type: "undo" }));
el.verify.addEventListener("click", () => {
  post({ type: "verifyModels" });
});

el.newChat.addEventListener("click", () => {
  el.transcript.innerHTML = "";
  current = null;
  post({ type: "newChat" });
});

window.addEventListener("message", (e) => {
  const message = e.data;
  if (message.type === "state") renderState(message.state);
  else if (message.type === "event") renderEvent(message.event);
  else if (message.type === "notice") notice(message.level, message.text);
});

post({ type: "ready" });
