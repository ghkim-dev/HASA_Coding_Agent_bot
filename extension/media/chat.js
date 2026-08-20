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
import { reduceSession } from "../../src/agent/sessionView.ts";

// `HostMessage` and `acquireVsCodeApi` come from `webview.d.ts`, which is where
// everything this file gets from outside the page is written down.
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
  requirements: /** @type {HTMLElement} */ (document.getElementById("requirements")),
  reqToggle: /** @type {HTMLButtonElement} */ (document.getElementById("reqToggle")),
  reqCaret: /** @type {HTMLElement} */ (document.getElementById("reqCaret")),
  reqCount: /** @type {HTMLElement} */ (document.getElementById("reqCount")),
  reqState: /** @type {HTMLElement} */ (document.getElementById("reqState")),
  reqBody: /** @type {HTMLElement} */ (document.getElementById("reqBody")),
  reqGoal: /** @type {HTMLElement} */ (document.getElementById("reqGoal")),
  reqList: /** @type {HTMLElement} */ (document.getElementById("reqList")),
  reqExtras: /** @type {HTMLElement} */ (document.getElementById("reqExtras")),
  progress: /** @type {HTMLElement} */ (document.getElementById("progress")),
  progSteps: /** @type {HTMLElement} */ (document.getElementById("progSteps")),
  progNow: /** @type {HTMLElement} */ (document.getElementById("progNow")),
  progMeta: /** @type {HTMLElement} */ (document.getElementById("progMeta")),
  progToggle: /** @type {HTMLButtonElement} */ (document.getElementById("progToggle")),
  progCaret: /** @type {HTMLElement} */ (document.getElementById("progCaret")),
  progList: /** @type {HTMLElement} */ (document.getElementById("progList")),
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

/**
 * Starts a fresh paragraph for whatever the model says next.
 *
 * A turn is a sequence of prose and steps in the order they happened, so the
 * prose is a series of blocks rather than one. `turn.body` is the block being
 * written into now; `turn.raw` is that block's source, because Markdown cannot
 * be rendered incrementally and each delta re-renders from the accumulated
 * text.
 */
function openProse(turn) {
  flushRender(turn);
  // A model that calls two tools without saying anything between them would
  // otherwise leave an empty block, and an empty block is still a margin.
  if (turn.body.childNodes.length === 0) turn.body.remove();
  const body = document.createElement("div");
  body.className = "body";
  turn.node.insertBefore(body, turn.activity);
  turn.body = body;
  turn.raw = "";
  return body;
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

/**
 * The plan, rewritten in place each time it changes.
 *
 * State rather than a log: the model sends the whole list every time, so the
 * block is rebuilt rather than appended to. Three marks, and the third is the
 * one that was missing — a user could see what had been done and what was
 * happening, but never what the agent intended to do next.
 *
 * It sits above the prose and stays there for the turn, because "what is
 * happening" is a question asked at arbitrary moments, and an answer that has
 * scrolled away is not an answer.
 */
/**
 * The plan as an element, built once and used by both paths.
 *
 * Every step is rendered. The data layer keeps all of them — a plan longer than
 * the display limit used to be cut at the source, so the steps past it were
 * gone rather than hidden — and if a limit is ever wanted it belongs here,
 * where it is a display decision that can be undone by scrolling.
 */
function planBlock(steps, current) {
  const plan = document.createElement("div");
  plan.className = "plan";
  for (const [index, step] of steps.entries()) {
    const position = index + 1;
    const done = position < current;
    const now = position === current;
    const line = document.createElement("div");
    line.className = done ? "plan-step done" : now ? "plan-step now" : "plan-step next";

    const mark = document.createElement("span");
    mark.className = "icon";
    mark.textContent = done ? "✓" : now ? "▸" : "·";
    const label = document.createElement("span");
    label.textContent = step;
    line.append(mark, label);
    plan.appendChild(line);
  }
  return plan;
}

/** A reasoning summary, collapsed: it is context, not the answer. */
function reasoningBlock(block) {
  const details = document.createElement("details");
  details.className = "reasoning";
  const summary = document.createElement("summary");
  summary.textContent = block.phase ? `${PHASE_LABEL[block.phase] ?? block.phase} 과정 보기` : "생각한 내용 보기";
  const body = document.createElement("div");
  body.textContent = block.summary;
  details.append(summary, body);
  return details;
}

const PHASE_LABEL = { analysis: "분석", planning: "계획", execution: "실행", verification: "검증" };

function renderPlan(turn, steps, current) {
  const plan = planBlock(steps, current);
  if (turn.plan) turn.plan.replaceWith(plan);
  else turn.node.insertBefore(plan, turn.body);
  turn.plan = plan;

  // The current step is also what the activity line should be counting against:
  // "생각하는 중" is true and useless once there is a plan saying what for.
  const step = steps[current - 1];
  if (step !== undefined) setActivity(turn, step);
  scrollToEnd();
}

/**
 * What a command actually printed, under the line that ran it.
 *
 * The panel's rule has been "a progress line per tool, not a transcript", and
 * for reading a file that is right — nobody asked to render the file. For a
 * command it was wrong in a way a user named exactly: three ticks, a paragraph
 * of the model's prose, and no way to check any of it. The output *is* what
 * they asked for.
 *
 * Collapsed by default so forty tool calls stay a list, open when the command
 * failed because that is the one nobody should have to go looking for.
 *
 * `textContent` throughout, as everywhere else here: this is bytes a process on
 * the user's machine wrote, which is exactly the kind of thing that must never
 * become markup.
 */
function outputBlock(output, open) {
  const block = document.createElement("details");
  block.className = "tool-output";
  block.open = open === true;

  const label = document.createElement("summary");
  const lines = output.split("\n").length;
  label.textContent = open === true ? "출력" : `출력 ${lines}줄 보기`;
  block.appendChild(label);

  const pre = document.createElement("pre");
  pre.textContent = output;
  block.appendChild(pre);
  return block;
}

function attachOutput(turn, line, output, open) {
  line.insertAdjacentElement("afterend", outputBlock(output, open));
  scrollToEnd();
}

/**
 * Why a turn stopped, when it did not simply finish.
 *
 * Said as a fact about the run rather than as an apology, and separately from
 * the model's own words — a model that was cut off mid-thought does not know it
 * was, so its last paragraph cannot be the explanation.
 */
const STOP_REASON = {
  denied: "요청하신 작업을 중단했습니다. 승인하지 않으신 단계가 있습니다.",
  // Drawn like the other unfinished endings on purpose. The agent stopping to
  // say it could not do something must not look like the agent doing it.
  blocked: "요청하신 것을 완료하지 못했습니다. 위에 막힌 지점과 이유가 있습니다.",
  aborted: "작업을 취소했습니다.",
  timeout: "시간이 초과되어 중단했습니다. 작업을 더 작게 나누어 다시 요청해 주세요.",
  loop_detected: "같은 시도를 반복하고 있어 중단했습니다. 요청을 조금 더 구체적으로 알려 주세요.",
  // Deliberately generic: the specific reason travels in `detail`, which the
  // panel shows beneath this line. Saying "요청을 구체적으로 알려 주세요" here
  // told a user their perfectly specific request was vague, when what had
  // repeated was the agent mistyping a pip command.
  no_progress: "진전이 없어 중단했습니다. 아래에 이유와 어디까지 됐는지 남아 있습니다.",
  protocol_error:
    "모델의 도구 호출 형식을 읽지 못해 중단했습니다. 실행된 작업은 없습니다.",
  max_steps: "한 번에 처리할 수 있는 단계 수를 넘어 중단했습니다.",
  max_model_calls: "한 번에 처리할 수 있는 모델 호출 수를 넘어 중단했습니다.",
  max_tool_calls: "한 번에 처리할 수 있는 도구 호출 수를 넘어 중단했습니다.",
  error: "오류로 중단했습니다.",
};

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

  // One construction site, and the tag comes from `message.kind` — that exact
  // shape is what `extensionBoundary.test.ts` looks for, because media that
  // loads a URL must be built from a host message and never from model text.
  // Splitting it into two branches to satisfy the type checker silently removed
  // the thing the check was checking, so the cast is here and the shape stays.
  const media = /** @type {HTMLImageElement & HTMLVideoElement} */ (
    document.createElement(message.kind === "video" ? "video" : "img")
  );
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
/**
 * Draws a whole conversation from its events.
 *
 * This used to take `{role, text}[]` — a projection the host had already made,
 * from an array that never held the plan, the reasoning, the tool steps, the
 * file changes or the reason a run stopped. So reopening a conversation showed
 * prose and nothing else, and no amount of care in here could have recovered
 * what was not sent.
 *
 * It now folds the events through `reduceSession`, the same reducer a live turn
 * uses, and renders the result. One projection, one renderer: a live turn and a
 * reopened one cannot disagree because there is nothing left to disagree.
 */
function renderTranscript(events) {
  el.transcript.textContent = "";
  current = null;
  const view = reduceSession(events ?? []);
  for (const turn of view.turns) renderTurn(turn);
  scrollToEnd();
}

/** One turn of a projected conversation, block by block, in order. */
function renderTurn(turn) {
  if (turn.role === "user") {
    const text = turn.blocks.filter((b) => b.kind === "text").map((b) => b.text).join("\n");
    if (text.trim().length > 0) addUserTurn(text);
    return;
  }

  const node = document.createElement("div");
  node.className = "turn agent";

  for (const block of turn.blocks) {
    switch (block.kind) {
      case "text": {
        const body = document.createElement("div");
        body.className = "body";
        renderMarkdown(body, block.text);
        node.appendChild(body);
        break;
      }
      case "reasoning":
        node.appendChild(reasoningBlock(block));
        break;
      case "plan":
        node.appendChild(planBlock(block.steps, block.current));
        break;
      case "tool": {
        const line = stepLine(markFor(block.status), block.summary, classFor(block.status));
        node.appendChild(line);
        if (block.output) {
          const output = outputBlock(block.output, block.status !== "success");
          node.appendChild(output);
        }
        if (block.meta?.truncated) node.appendChild(stepLine("…", truncationNote(block.meta), "muted"));
        break;
      }
      case "notice":
        node.appendChild(stepLine(block.level === "error" ? "✕" : "!", block.text, block.level === "error" ? "failed" : "muted"));
        break;
    }
  }

  if (turn.termination !== undefined && turn.termination.tone !== "ok") {
    node.appendChild(
      stepLine("!", [turn.termination.label, turn.termination.detail].filter(Boolean).join(" — "), "failed"),
    );
  }
  el.transcript.appendChild(node);
}

/** The mark for a finished call. Never a string comparison in the caller. */
function markFor(status) {
  if (status === undefined) return "·";
  return status === "success" ? "✓" : status === "denied" || status === "blocked" ? "✕" : "!";
}

function classFor(status) {
  if (status === undefined || status === "success") return undefined;
  return status === "denied" || status === "blocked" ? "denied" : "failed";
}

function truncationNote(meta) {
  const of = meta.originalLength ? ` (전체 ${meta.originalLength}자 중 일부)` : "";
  return `결과가 잘렸습니다${of}`;
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
      // Numbered from the second round. "생각하는 중" for the fourth time in a
      // turn looks identical to the first, which is how a loop going nowhere
      // passes for one making progress.
      setActivity(turn, event.step <= 1 ? "모델 응답을 기다리는 중" : `모델 응답을 기다리는 중 (${event.step}번째)`);
      break;

    case "phase":
      // Setup, before the loop. This is the work that used to happen with
      // nothing to say about it while the clock climbed.
      setActivity(turn, event.label);
      break;

    case "reasoning": {
      // Emitted by the loop and thrown away here, for as long as the event has
      // existed. Collapsed, because it is context rather than the answer and a
      // reader should meet the answer first.
      const block = reasoningBlock({ summary: event.delta });
      turn.node.insertBefore(block, turn.activity);
      openProse(turn);
      break;
    }

    case "plan":
      renderPlan(turn, event.steps, event.current);
      break;

    case "tool_start": {
      const line = stepLine("·", event.summary);
      turn.steps.set(event.callId, line);
      turn.node.insertBefore(line, turn.activity);
      // Whatever prose came before this step is now finished, so the next delta
      // starts a fresh paragraph *after* the step rather than being appended to
      // the one above it. Without this every step line sank below every
      // sentence, and the transcript read as an essay followed by a list of
      // ticks — the reader could not tell which sentence went with which call.
      openProse(turn);
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
      // The output, when the tool asked for it to be shown. Open on failure and
      // closed on success: a command that worked is a tick, and a command that
      // did not is the thing the user needs to read without hunting for it.
      if (event.output) attachOutput(turn, line, event.output, !event.ok);
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
      // A turn stopped for looping, a timeout or a budget looked exactly like
      // one that finished: `reason` was never read, and by the time a loop is
      // detected the model has produced several paragraphs, so the explanation
      // in `summary` was discarded as "the body is not empty". The reason is
      // the part the user cannot infer from the prose.
      if (event.reason !== "finished") {
        turn.node.appendChild(stepLine("!", STOP_REASON[event.reason] ?? event.summary, "failed"));
      }
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


// ---------------------------------------------------------------------------
// What the user asked for
// ---------------------------------------------------------------------------

/**
 * The four states a requirement is drawn in.
 *
 * A glyph and a colour, never a colour alone. `unplanned` is the one worth
 * noticing: the runtime is still holding that requirement and the model's plan
 * does not mention it — which is the failure the whole contract layer exists
 * to prevent, made visible while there is still time to act on it.
 */
const REQ_MARK = {
  done: { glyph: "\u2713", label: "확인됨" },
  in_progress: { glyph: "\u25CB", label: "진행 중" },
  failed: { glyph: "\u2715", label: "실패" },
  unplanned: { glyph: "!", label: "계획에 없음" },
};

const DISPOSITION_KO = {
  completed: "모두 확인됨",
  partial: "일부 남음",
  blocked: "막힘",
  aborted: "중단됨",
  active: "진행 중",
};

/** Kept across renders so a user who collapsed the panel keeps it collapsed. */
let reqCollapsed = false;

el.reqToggle?.addEventListener("click", () => {
  reqCollapsed = !reqCollapsed;
  el.reqBody.classList.toggle("hidden", reqCollapsed);
  el.reqCaret.textContent = reqCollapsed ? "\u25B8" : "\u25BE";
  el.reqToggle.setAttribute("aria-expanded", reqCollapsed ? "false" : "true");
});

function chip(text, className) {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
}

// ---------------------------------------------------------------------------
// How far the work got
// ---------------------------------------------------------------------------

/**
 * The phases a user is shown, in order, with the label each carries.
 *
 * Eight steps rather than the projection's twelve: the four endings share the
 * last slot, because "완료" and "중단됨" are the same *position* in the sequence
 * and differ in outcome, which the label says. Nothing here decides anything —
 * `progressView.ts` owns the phase and this file owns where it sits.
 */
// One label per step key the projection reports. The *states* come from the
// projection too — each step carries its own evidence-backed state, and this
// file draws exactly that. It used to infer states from position (everything
// left of the current phase drew as done), and a live turn that executed
// nothing ended with 실행·검증·마무리 all green over "변경 파일 0".
const STEP_LABEL = {
  interpret: "요청 분석",
  requirements: "요구사항 확인",
  worker: "모델 선택",
  response: "모델 응답",
  plan: "계획",
  execute: "실행",
  verify: "검증",
  finish: "마무리",
};

const STEP_STATE_CLASS = {
  not_started: "todo",
  in_progress: "now",
  done: "done",
  warning: "warn",
  blocked: "held",
  failed: "bad",
};

const STEP_STATE_TITLE = {
  not_started: "아직 시작되지 않았습니다",
  in_progress: "진행 중입니다",
  done: "기록으로 확인되었습니다",
  warning: "기록은 있지만 확인이 필요합니다",
  blocked: "실행이 보류되었습니다",
  failed: "여기서 실패했습니다",
};

/** Named apart from the reasoning-phase labels above, which are a different set. */
const PROGRESS_PHASE_LABEL = {
  interpreting: "요청 분석 중",
  contract_ready: "요청 분석 완료",
  selecting_worker: "모델 선택 중",
  worker_selected: "모델 응답 대기 중",
  planning: "계획 수립 중",
  executing: "작업 실행 중",
  verifying: "검증 중",
  completed: "완료",
  partial: "일부만 완료",
  blocked: "막힘",
  failed: "중단됨",
  stalled: "응답 없음",
};

const PLAN_ABSENCE_LABEL = {
  waiting_for_worker: "아직 모델을 선택하는 중입니다",
  worker_streaming: "모델 응답을 기다리는 중입니다",
  direct_execution_strategy: "계획 없이 바로 실행하고 있습니다",
  protocol_error: "모델이 보낸 도구 호출을 읽지 못했습니다",
  worker_error: "모델 또는 게이트웨이 오류로 계획을 받지 못했습니다",
  stalled: "응답이 멈춘 상태입니다",
};

const ACTION_LABEL = {
  PROPOSED: "제안됨",
  DEFERRED: "승인 대기",
  DENIED: "거부됨",
  EXECUTING: "실행 중",
  SUCCEEDED: "완료",
  FAILED: "실패",
};

/** Phases where nothing is running any more. No spinner, no "진행 중". */
const TERMINAL_PHASES = new Set(["completed", "partial", "blocked", "failed"]);

/** Kept across renders so a user who opened the activity list keeps it open. */
let progCollapsed = true;

el.progToggle?.addEventListener("click", () => {
  progCollapsed = !progCollapsed;
  el.progList.classList.toggle("hidden", progCollapsed);
  el.progCaret.textContent = progCollapsed ? "▸" : "▾";
  el.progToggle.setAttribute("aria-expanded", progCollapsed ? "false" : "true");
});

function seconds(ms) {
  if (ms < 1000) return "0초";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}초`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return s === 0 ? `${m}분` : `${m}분 ${s}초`;
}

/**
 * Draws where the work got to.
 *
 * Every value comes from `progressView` and none is computed here — a second
 * opinion about the phase would be a second answer to a question that already
 * has one. What this file decides is only how it looks.
 */
function renderProgress(progress) {
  if (progress === null || progress === undefined) {
    el.progress.classList.add("hidden");
    return;
  }
  el.progress.classList.remove("hidden");

  const terminal = TERMINAL_PHASES.has(progress.phase);

  el.progSteps.textContent = "";
  for (const step of progress.steps ?? []) {
    const node = document.createElement("span");
    node.className = `progStep ${STEP_STATE_CLASS[step.state] ?? "todo"}`;
    node.textContent = STEP_LABEL[step.key] ?? step.key;
    node.title = STEP_STATE_TITLE[step.state] ?? "";
    el.progSteps.appendChild(node);
  }

  // What is happening, and why there is no plan when there is none. An empty
  // "계획이 아직 없습니다" was the whole complaint.
  const label = PROGRESS_PHASE_LABEL[progress.phase] ?? progress.phase;
  const because =
    progress.planAbsence === null || progress.planAbsence === undefined
      ? ""
      : ` · ${PLAN_ABSENCE_LABEL[progress.planAbsence] ?? progress.planAbsence}`;
  el.progNow.textContent = `${label}${because}`;
  el.progNow.className = `progNow ${terminal ? "settled" : "running"}`;

  // Requirements and evidence, with their own denominators. No percentage: the
  // counts are the claim, and a percentage would invent one.
  const parts = [
    `요구사항 ${progress.completedRequirementCount}/${progress.totalRequirementCount} 확인됨`,
    `증거로 검증 ${progress.verifiedRequirementCount}/${progress.totalRequirementCount}`,
  ];
  // Two cursors, two facts. The grounded one is what the record supports; the
  // model's own `current` is shown only when it runs ahead of the record, and
  // labelled as its claim rather than as the state.
  if (progress.plan) {
    const claim =
      progress.plan.claimedCurrent > progress.plan.groundedCurrent
        ? ` (모델 주장 ${progress.plan.claimedCurrent})`
        : "";
    parts.push(`계획 ${progress.plan.groundedCurrent}/${progress.plan.steps.length} 확인됨${claim}`);
  }
  if (progress.stateContradictionCount > 0) {
    parts.push(`설명 번복 ${progress.stateContradictionCount}건`);
  }
  if (progress.workerModelId) parts.push(`모델 ${progress.workerModelId}`);
  parts.push(terminal ? `소요 ${seconds(progress.elapsedMs)}` : `경과 ${seconds(progress.elapsedMs)}`);
  // Only said while something is still expected to happen, and only from real
  // event times: `lastActivityAt` moves when an event does and never otherwise.
  if (!terminal) parts.push(`최근 활동 ${seconds(progress.idleMs)} 전`);
  el.progMeta.textContent = parts.join(" · ");

  // The last ten, newest first, one line per event. Older ones are behind the
  // toggle rather than dropped.
  el.progList.textContent = "";
  const recent = progress.timeline.slice(-10).reverse();
  for (const entry of recent) {
    const row = document.createElement("li");
    row.className = `progItem ${entry.kind}`;
    row.textContent = entry.text;
    el.progList.appendChild(row);
  }
  for (const action of progress.actions.slice(-5).reverse()) {
    const row = document.createElement("li");
    row.className = `progItem action ${action.state.toLowerCase()}`;
    row.textContent = `${ACTION_LABEL[action.state] ?? action.state} — ${action.summary}`;
    el.progList.appendChild(row);
  }
  el.progToggle.classList.toggle("hidden", recent.length === 0);
}

/**
 * Redraws the panel from the runtime's own view.
 *
 * Every value here is computed in `src/agent/requirementsView.ts` and tested
 * there. Nothing is decided in this file — a second implementation of the join
 * between a requirement and a plan step would be a second answer to a question
 * that already has one.
 */
function renderRequirements(view) {
  if (view === null || view === undefined) {
    el.requirements.classList.add("hidden");
    return;
  }
  el.requirements.classList.remove("hidden");

  el.reqGoal.textContent = view.goal;
  el.reqGoal.classList.toggle("hidden", view.goal.length === 0);
  el.reqCount.textContent = view.total === 0 ? "" : `${view.done}/${view.total}`;
  el.reqState.textContent = DISPOSITION_KO[view.disposition] ?? view.disposition;
  el.reqState.className = `reqState ${view.disposition}`;

  el.reqList.replaceChildren();
  for (const requirement of view.requirements) {
    const mark = REQ_MARK[requirement.progress] ?? REQ_MARK.in_progress;
    const item = document.createElement("li");
    item.className = requirement.progress + (requirement.superseded ? " superseded" : "");

    const glyph = document.createElement("span");
    glyph.className = "mark";
    glyph.textContent = mark.glyph;
    // The colour carries meaning, so the meaning is also in the tree for a
    // screen reader and in the tooltip for everyone else.
    glyph.title = mark.label;
    glyph.setAttribute("aria-label", mark.label);

    const what = document.createElement("span");
    what.className = "what";
    what.textContent = requirement.text;

    if (requirement.progress === "unplanned") {
      const via = document.createElement("span");
      via.className = "via";
      via.textContent = "계획에 아직 없습니다";
      what.appendChild(via);
    } else if (typeof requirement.step === "string" && requirement.step !== requirement.text) {
      const via = document.createElement("span");
      via.className = "via";
      via.textContent = `\u2192 ${requirement.step}`;
      what.appendChild(via);
    }
    if (typeof requirement.detail === "string" && requirement.detail.length > 0) {
      const why = document.createElement("span");
      why.className = "why";
      why.textContent = requirement.detail;
      what.appendChild(why);
    }

    item.append(glyph, what);
    el.reqList.appendChild(item);
  }

  el.reqExtras.replaceChildren();

  if (view.constraints.length > 0) {
    const row = document.createElement("div");
    row.className = "reqExtra";
    const enforcedRows = view.constraints.filter((c) => c.enforced);
    const quarantined = view.constraints.filter((c) => c.quarantined);
    const recordedOnly = view.constraints.filter((c) => !c.enforced && !c.quarantined);
    if (enforcedRows.length > 0) row.appendChild(chip("하지 말라고 하신 것", "label"));
    for (const constraint of enforcedRows) {
      // `enforced` is not decoration: those kinds are refused by the tool gate
      // before anything runs. A constraint the gate does not enforce must not
      // sit under "하지 말라고 하신 것" — a live run rendered a hallucinated,
      // unenforced no_research there, telling the user they forbade the very
      // thing they asked for.
      const node = chip(constraint.text, "reqChip enforced");
      node.title = "런타임이 실행 전에 막습니다";
      row.appendChild(node);
    }
    if (recordedOnly.length > 0) {
      row.appendChild(chip("기록만 된 제약 (강제되지 않음)", "label"));
      for (const constraint of recordedOnly) {
        const node = chip(constraint.text, "reqChip");
        node.title = "분류되지 않아 기록만 됩니다. 런타임이 막지 않습니다.";
        row.appendChild(node);
      }
    }
    if (quarantined.length > 0) {
      // Not the user's words. The runtime established that the model wrote
      // this while the request asked for the opposite, so it is shown as the
      // model's and enforces nothing.
      row.appendChild(chip("모델이 기록했지만 요청에서 확인되지 않음", "label"));
      for (const constraint of quarantined) {
        const node = chip(constraint.text, "reqChip");
        node.title = "사용자 요청에서 확인되지 않아 강제하지 않습니다.";
        row.appendChild(node);
      }
    }
    el.reqExtras.appendChild(row);
  }

  if (view.sources.length > 0) {
    const row = document.createElement("div");
    row.className = "reqExtra";
    row.appendChild(chip("지정하신 출처", "label"));
    for (const source of view.sources) {
      const label = source.status === "fetched" ? "읽음" : source.status === "attempted" ? "가져오지 못함" : "아직 안 읽음";
      const node = chip(`${source.url} · ${label}`, `reqChip ${source.status}`);
      row.appendChild(node);
    }
    el.reqExtras.appendChild(row);
  }

  if (view.openIssues.length > 0) {
    const row = document.createElement("div");
    row.className = "reqExtra";
    row.appendChild(chip("미해결 오류", "label"));
    for (const issue of view.openIssues) {
      const node = document.createElement("div");
      node.className = "reqIssue";
      // The same failure three times is one problem, counted. Three identical
      // lines read as three problems, which is what the panel showed.
      const times = issue.count > 1 ? ` (×${issue.count})` : "";
      node.textContent = `${issue.summary} — ${issue.detail}${times}`;
      row.appendChild(node);
    }
    el.reqExtras.appendChild(row);
  }
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
  // Typed, so a field the host does not send is a compile error rather than an
  // `undefined` that renders as nothing. This read `message.turns` for a
  // message that carries `events` — the payload was renamed and this one call
  // site was not — and every reopened conversation drew
  // `reduceSession(undefined ?? [])`: a blank screen, silently, with the
  // conversation correctly restored underneath it. `e.data` is `any`, so
  // nothing was going to catch that until it was named.
  const message = /** @type {HostMessage} */ (e.data);
  if (message.type === "requirements") renderRequirements(message.view);
  else if (message.type === "progress") renderProgress(message.progress);
  else if (message.type === "state") renderState(message.state);
  else if (message.type === "event") renderEvent(message.event);
  else if (message.type === "notice") notice(message.level, message.text);
  else if (message.type === "artifact") showArtifact(message);
  else if (message.type === "transcript") renderTranscript(message.events);
});

post({ type: "ready" });
