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

import { parseMarkdown } from "../../src/agent/markdown.ts";

const vscode = acquireVsCodeApi();

/**
 * Renders parsed Markdown into a container.
 *
 * Every piece of text goes in through `textContent` and every element is built
 * with `createElement`. There is no `innerHTML` anywhere in this function, and
 * that is not belt-and-braces: this text comes from a model, which is to say
 * from whatever it read in the user's repository. The CSP would stop a script
 * from running, but the rule that model output is never HTML is cheaper to keep
 * than to reason about each time.
 */
function renderMarkdown(container, source) {
  container.textContent = "";
  appendBlocks(container, parseMarkdown(source));
}

function appendBlocks(container, blocks) {
  for (const block of blocks) {
    switch (block.kind) {
      case "heading": {
        // Rendered as emphasised text rather than a real <h1>. The model is
        // answering inside a chat turn, not authoring a document, and a page
        // heading in the middle of a conversation reads as a mistake.
        const node = document.createElement("p");
        node.className = "md-heading";
        appendInlines(node, block.inlines);
        container.appendChild(node);
        break;
      }

      case "list": {
        const list = document.createElement(block.ordered ? "ol" : "ul");
        for (const item of block.items) {
          const li = document.createElement("li");
          appendInlines(li, item.inlines);
          // Sub-items nest. Flattening them into the parent renumbered them as
          // siblings, which told the user a structure the model did not write.
          appendBlocks(li, item.children);
          list.appendChild(li);
        }
        container.appendChild(list);
        break;
      }

      case "code": {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = block.text;
        if (block.language) code.dataset.language = block.language;
        pre.appendChild(code);
        container.appendChild(pre);
        break;
      }

      default: {
        const node = document.createElement("p");
        appendInlines(node, block.inlines);
        container.appendChild(node);
        break;
      }
    }
  }
}

function appendInlines(parent, inlines) {
  for (const inline of inlines) {
    if (inline.kind === "text") {
      parent.appendChild(document.createTextNode(inline.text));
      continue;
    }
    if (inline.kind === "code") {
      const node = document.createElement("code");
      node.textContent = inline.text;
      parent.appendChild(node);
      continue;
    }
    // Emphasis holds spans, not a string, so `code` inside bold stays code.
    const node = document.createElement(inline.kind === "strong" ? "strong" : "em");
    appendInlines(node, inline.children);
    parent.appendChild(node);
  }
}

const el = {
  bar: /** @type {HTMLElement} */ (document.getElementById("bar")),
  mode: /** @type {HTMLSelectElement} */ (document.getElementById("mode")),
  approval: /** @type {HTMLSelectElement} */ (document.getElementById("approval")),
  revoke: /** @type {HTMLButtonElement} */ (document.getElementById("revoke")),
  model: /** @type {HTMLSelectElement} */ (document.getElementById("model")),
  status: /** @type {HTMLElement} */ (document.getElementById("status")),
  newChat: /** @type {HTMLButtonElement} */ (document.getElementById("newChat")),
  verify: /** @type {HTMLButtonElement} */ (document.getElementById("verify")),
  attach: /** @type {HTMLButtonElement} */ (document.getElementById("attach")),
  attachMenu: /** @type {HTMLElement} */ (document.getElementById("attachMenu")),
  attachments: /** @type {HTMLElement} */ (document.getElementById("attachments")),
  historyBtn: /** @type {HTMLButtonElement} */ (document.getElementById("historyBtn")),
  history: /** @type {HTMLElement} */ (document.getElementById("history")),
  historyList: /** @type {HTMLElement} */ (document.getElementById("historyList")),
  historyClose: /** @type {HTMLButtonElement} */ (document.getElementById("historyClose")),
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
  // The raw text is kept because Markdown cannot be rendered incrementally:
  // a `**` is only emphasis once its partner arrives, so each delta re-renders
  // from the accumulated source rather than appending to the DOM.
  // A live line at the bottom of the turn saying what is happening now.
  //
  // Without it the panel showed prose, then nothing, and a user could not tell
  // a model thinking for forty seconds from a request that had died — which is
  // exactly what was reported. The elapsed seconds are the part that carries
  // that: a number that keeps moving is the difference between "slow" and
  // "stuck", and no amount of spinner animation says it.
  const activity = document.createElement("div");
  activity.className = "step activity";
  const spinner = document.createElement("span");
  spinner.className = "icon";
  spinner.textContent = "◐";
  const label = document.createElement("span");
  activity.append(spinner, label);
  node.appendChild(activity);

  current = {
    node,
    body,
    steps: new Map(),
    raw: "",
    frame: 0,
    activity,
    activityLabel: label,
    activitySpinner: spinner,
    startedAt: Date.now(),
    what: "생각하는 중",
    ticker: 0,
  };
  startTicking(current);
  scrollToEnd();
  return current;
}

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];

/** Keeps the activity line moving, so a long step reads as slow rather than dead. */
function startTicking(turn) {
  let frame = 0;
  turn.ticker = setInterval(() => {
    frame = (frame + 1) % SPINNER_FRAMES.length;
    turn.activitySpinner.textContent = SPINNER_FRAMES[frame];
    const seconds = Math.round((Date.now() - turn.startedAt) / 1000);
    turn.activityLabel.textContent = seconds < 2 ? turn.what : `${turn.what} · ${seconds}초`;
  }, 250);
}

function setActivity(turn, what) {
  turn.what = what;
  turn.startedAt = Date.now();
  turn.activityLabel.textContent = what;
  turn.node.appendChild(turn.activity); // stays last, below whatever just landed
}

function stopTicking(turn) {
  if (turn.ticker !== 0) clearInterval(turn.ticker);
  turn.ticker = 0;
  turn.activity.remove();
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

/**
 * Coalesces re-renders to one per frame.
 *
 * Deltas arrive per token, and rebuilding the body for each one would rebuild
 * it hundreds of times a second to no visible effect.
 */
function scheduleRender(turn) {
  if (turn.frame !== 0) return;
  turn.frame = requestAnimationFrame(() => {
    turn.frame = 0;
    renderMarkdown(turn.body, turn.raw);
    scrollToEnd();
  });
}

/** Renders now, so the finished turn cannot be left a frame behind. */
function flushRender(turn) {
  if (turn.frame !== 0) cancelAnimationFrame(turn.frame);
  turn.frame = 0;
  renderMarkdown(turn.body, turn.raw);
}

/**
 * Renders a generated image or clip under the step that made it.
 *
 * The src is a vscode-webview: URI minted by the extension host; this file
 * never sees a filesystem path and could not read one if it did.
 */
function showArtifact(message) {
  const anchor = current && current.steps.get(message.callId);
  const host = anchor ? anchor.parentNode : el.transcript;

  const figure = document.createElement("figure");
  figure.className = "artifact";

  const media = document.createElement(message.kind === "video" ? "video" : "img");
  media.src = message.src;
  if (message.kind === "video") {
    media.controls = true;
    media.playsInline = true;
  } else {
    media.alt = message.path;
  }

  const caption = document.createElement("figcaption");
  caption.textContent = message.path;
  figure.append(media, caption);

  if (anchor && anchor.nextSibling) host.insertBefore(figure, anchor.nextSibling);
  else host.appendChild(figure);
  scrollToEnd();
}

/** The staged files, as chips with a way to take one back off. */
function renderAttachments(list) {
  el.attachments.textContent = "";
  el.attachments.classList.toggle("hidden", list.length === 0);
  for (const item of list) {
    const chip = document.createElement("span");
    chip.className = "chip";

    const icon = document.createElement("span");
    icon.textContent = item.kind === "image" ? "🖼" : "📄";
    const label = document.createElement("span");
    // textContent, not innerHTML: this is a filename from the user's disk.
    label.textContent = `${item.name} · ${item.note}`;

    const remove = document.createElement("button");
    remove.className = "chip-x";
    remove.textContent = "✕";
    remove.title = "빼기";
    remove.addEventListener("click", () => post({ type: "removeAttachment", id: item.id }));

    chip.append(icon, label, remove);
    el.attachments.appendChild(chip);
  }
}

/** Past conversations for the key in use. */
function renderHistory(state) {
  el.historyList.textContent = "";
  if (state.history.length === 0) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = "아직 저장된 대화가 없습니다.";
    el.historyList.appendChild(empty);
    return;
  }

  for (const item of state.history) {
    const row = document.createElement("li");
    row.className = item.id === state.openConversationId ? "history-row on" : "history-row";

    const open = document.createElement("button");
    open.className = "history-open";
    open.textContent = item.title;
    open.addEventListener("click", () => post({ type: "openConversation", id: item.id }));

    const meta = document.createElement("span");
    meta.className = "history-meta";
    meta.textContent = `${item.messageCount}개 · ${new Date(item.updatedAt).toLocaleDateString()}`;

    const remove = document.createElement("button");
    remove.className = "ghost";
    remove.textContent = "삭제";
    remove.addEventListener("click", () => post({ type: "deleteConversation", id: item.id }));

    row.append(open, meta, remove);
    el.historyList.appendChild(row);
  }
}

/** Redraws the whole transcript from a conversation that was reopened. */
function renderTranscript(turns) {
  el.transcript.textContent = "";
  current = null;
  for (const turn of turns) {
    if (turn.role === "user") {
      addUserTurn(turn.text);
      continue;
    }
    const node = document.createElement("div");
    node.className = "turn agent";
    const body = document.createElement("div");
    body.className = "body";
    renderMarkdown(body, turn.text);
    node.appendChild(body);
    el.transcript.appendChild(node);
  }
  scrollToEnd();
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
      turn.raw += event.delta;
      scheduleRender(turn);
      break;

    case "step":
      setActivity(turn, "생각하는 중");
      break;

    case "tool_start": {
      const line = stepLine("·", event.summary);
      turn.steps.set(event.callId, line);
      turn.node.insertBefore(line, turn.activity);
      setActivity(turn, event.summary);
      break;
    }

    case "tool_approval": {
      const line = turn.steps.get(event.callId);
      if (!line) break;
      if (event.outcome === "standing") {
        // Said out loud rather than passed over. A user who allowed something
        // permanently should keep seeing that it is being used, or "항상 허용"
        // becomes a decision they made once and then forgot they made.
        line.lastChild.textContent += " — 허용해 두신 항목입니다";
      } else if (event.outcome === "denied") {
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
      turn.node.insertBefore(stepLine("↩", event.detail), turn.activity);
      break;

    case "done":
      // The summary is the model's own words when it produced them, so an empty
      // body is filled rather than duplicated.
      if (turn.raw.trim().length === 0) turn.raw = event.summary;
      stopTicking(turn);
      flushRender(turn);
      current = null;
      break;

    case "error":
      // Stopped before the notice: a spinner still turning under an error
      // message is the panel contradicting itself.
      stopTicking(turn);
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
  el.approval.value = state.approvalMode;

  // Only shown when there is something to take back. A permanently visible
  // "취소" for a list that is usually empty is a button people learn to ignore.
  const grants = state.standingGrants ?? [];
  el.revoke.classList.toggle("hidden", grants.length === 0);
  if (grants.length > 0) {
    el.revoke.textContent = `허용 ${grants.length}건 취소`;
    el.revoke.title = `항상 허용해 둔 항목: ${grants.join(", ")}`;
  }

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
  renderAttachments(state.attachments);
  renderHistory(state);
  el.attach.disabled = state.busy || !connection.connected;
  el.historyBtn.disabled = !connection.connected;

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
      // The image model is not in the picker on purpose, so the one place a
      // user would look for it has to say where it went.
      : state.canGenerateMedia
        ? "Ctrl+Enter 로 전송 · 그림이나 영상은 말로 요청하세요"
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
el.approval.addEventListener("change", () => post({ type: "setApprovalMode", mode: el.approval.value }));
el.revoke.addEventListener("click", () => post({ type: "revokeGrants" }));
el.model.addEventListener("change", () => post({ type: "setModel", modelId: el.model.value || null }));
el.connectBtn.addEventListener("click", () => post({ type: "connect" }));
el.viewDiff.addEventListener("click", () => post({ type: "viewDiff" }));
el.keep.addEventListener("click", () => post({ type: "keep" }));
el.undo.addEventListener("click", () => post({ type: "undo" }));
el.attach.addEventListener("click", (event) => {
  event.stopPropagation();
  el.attachMenu.classList.toggle("hidden");
});

for (const button of el.attachMenu.querySelectorAll("button")) {
  button.addEventListener("click", () => {
    el.attachMenu.classList.add("hidden");
    post({ type: "attach", source: button.dataset.source });
  });
}

// A menu that only closes on its own items is one that stays open by accident.
document.addEventListener("click", () => el.attachMenu.classList.add("hidden"));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") el.attachMenu.classList.add("hidden");
});

el.historyBtn.addEventListener("click", () => {
  el.history.classList.toggle("hidden");
  post({ type: "openHistory" });
});

el.historyClose.addEventListener("click", () => el.history.classList.add("hidden"));

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
  else if (message.type === "artifact") showArtifact(message);
  else if (message.type === "transcript") renderTranscript(message.turns);
});

post({ type: "ready" });
