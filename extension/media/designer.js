// @ts-check
/**
 * The designer panel's view.
 *
 * Draws what the host computed and decides nothing. Every number here comes
 * from `designHarness`; this file chooses how to lay it out and nothing else —
 * the same rule the chat panel follows, and for the same reason: a second
 * opinion rendered in a webview is a second answer nobody tested.
 */

const vscode = acquireVsCodeApi();

const el = {
  req: /** @type {HTMLTextAreaElement} */ (document.getElementById("req")),
  go: /** @type {HTMLButtonElement} */ (document.getElementById("go")),
  models: /** @type {HTMLElement} */ (document.getElementById("models")),
  out: /** @type {HTMLElement} */ (document.getElementById("out")),
  summary: /** @type {HTMLElement} */ (document.getElementById("summary")),
  reqs: /** @type {HTMLElement} */ (document.getElementById("reqs")),
  conf: /** @type {HTMLElement} */ (document.getElementById("conf")),
  demands: /** @type {HTMLElement} */ (document.getElementById("demands")),
  intents: /** @type {HTMLElement} */ (document.getElementById("intents")),
  rec: /** @type {HTMLElement} */ (document.getElementById("rec")),
  qCard: /** @type {HTMLElement} */ (document.getElementById("qCard")),
  questions: /** @type {HTMLElement} */ (document.getElementById("questions")),
  err: /** @type {HTMLElement} */ (document.getElementById("err")),
};

/** What each capability is called where a person reads it. */
const CAPABILITY = {
  coding: "코드 작성",
  debugging: "디버깅",
  reasoning: "추론",
  architecture: "설계",
  codeReview: "코드 검토",
  toolUse: "도구 사용",
  commandExecution: "명령 실행",
  webResearch: "웹 조사",
  sourceGrounding: "출처 확인",
  instructionFollowing: "지시 준수",
  recovery: "실패 복구",
  multiTurnContinuity: "대화 연속성",
};

const INTENT = {
  discuss: "이야기",
  inspect: "살펴보기",
  present: "보여주기",
  modify: "수정",
  execute: "실행",
  verify: "검증",
  research: "조사",
  continue: "이어가기",
};

const CONSTRAINT = {
  no_execute: "실행 금지",
  no_modify: "수정 금지",
  no_research: "웹 조사 금지",
  present_only: "보여주기만",
  must_execute: "실행 필요",
  other: "기타",
};

function text(node, value) {
  node.textContent = value;
  return node;
}

function make(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

el.go.addEventListener("click", () => {
  const value = el.req.value.trim();
  if (value.length === 0) return;
  el.go.disabled = true;
  el.err.classList.add("hidden");
  vscode.postMessage({ type: "design", text: value });
});

el.req.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") el.go.click();
});

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "models") {
    el.models.textContent =
      message.source === "gateway"
        ? `모델 ${message.count}개를 대상으로 비교합니다`
        : message.detail;
    return;
  }
  if (message.type === "designing") {
    el.go.disabled = true;
    el.summary.textContent = "요구사항을 읽는 중…";
    el.out.classList.remove("hidden");
    return;
  }
  if (message.type === "error") {
    el.go.disabled = false;
    el.err.textContent = message.message;
    el.err.classList.remove("hidden");
    return;
  }
  if (message.type === "design") {
    el.go.disabled = false;
    render(message.design);
  }
});

function render(design) {
  el.out.classList.remove("hidden");
  el.summary.textContent = design.summary;

  // --- requirements -------------------------------------------------------
  el.reqs.textContent = "";
  for (const r of design.requirements) {
    const row = make("div", "req");
    if (r.grounded) row.classList.add("grounded");
    if (r.baseline) row.classList.add("baseline");
    if (r.forbidden) row.classList.add("forbidden");
    row.appendChild(
      make("span", "tag", r.forbidden ? "금지" : r.baseline ? "기본" : r.grounded ? "요청" : "추정"),
    );
    row.appendChild(make("span", "", r.text));
    el.reqs.appendChild(row);
  }
  const c = design.confidence;
  el.conf.textContent =
    `사용자의 말에서 직접 확인 ${c.grounded}건 · 런타임이 보탠 것 ${c.ungrounded}건` +
    (c.unresolved > 0 ? ` · 아직 정해지지 않음 ${c.unresolved}건` : "");

  // --- what the work demands ---------------------------------------------
  el.demands.textContent = "";
  const demands = Object.entries(design.demands)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  if (demands.length === 0) {
    el.demands.appendChild(make("p", "muted", "이 요청에서 특별히 요구되는 능력을 찾지 못했습니다."));
  }
  for (const [key, value] of demands) {
    const row = make("div", "demand");
    row.appendChild(make("span", "", CAPABILITY[key] ?? key));
    const bar = make("span", "bar");
    const fill = make("span", "fill");
    fill.style.width = `${Math.round(Math.min(1, value) * 100)}%`;
    bar.appendChild(fill);
    row.appendChild(bar);
    row.appendChild(make("span", "val", value.toFixed(2)));
    el.demands.appendChild(row);
  }
  const intents = design.intents.map((i) => INTENT[i] ?? i).join(", ");
  const bans = design.prohibitions.map((k) => CONSTRAINT[k] ?? k);
  el.intents.textContent =
    `읽어낸 의도: ${intents}` + (bans.length > 0 ? ` · 금지: ${bans.join(", ")}` : "");

  // --- the recommendation -------------------------------------------------
  el.rec.textContent = "";
  const rec = design.recommendation;
  if (rec === null) {
    el.rec.appendChild(
      make("p", "muted", "비교할 모델 목록이 없습니다. API Key를 설정하면 실제 모델을 대상으로 추천합니다."),
    );
  } else if (rec.selected === null) {
    el.rec.appendChild(make("p", "none", rec.unavailableReason ?? "이 요청을 맡길 수 있는 모델이 없습니다."));
    for (const f of rec.filteredOut) {
      el.rec.appendChild(make("div", "dropped", `제외 ${f.modelId} — ${f.reason}`));
    }
  } else {
    const pick = make("div", "pick");
    pick.appendChild(make("span", "id", rec.selected.modelId));
    pick.appendChild(make("span", "muted", `  점수 ${rec.selected.score.toFixed(2)}`));
    el.rec.appendChild(pick);
    for (const reason of rec.reasons) {
      el.rec.appendChild(make("div", "reason", reason));
    }
    if (rec.alternatives.length > 0) {
      el.rec.appendChild(make("h3", "muted", "다음 후보"));
      for (const a of rec.alternatives) {
        const row = make("div", "alt");
        row.appendChild(make("span", "", a.modelId));
        row.appendChild(make("span", "", a.score.toFixed(2)));
        el.rec.appendChild(row);
      }
    }
    for (const f of rec.filteredOut) {
      el.rec.appendChild(make("div", "dropped", `제외 ${f.modelId} — ${f.reason}`));
    }
  }

  // --- what is still open -------------------------------------------------
  el.questions.textContent = "";
  el.qCard.classList.toggle("hidden", design.questions.length === 0);
  for (const q of design.questions) {
    const box = make("div", "q");
    box.appendChild(make("div", "about", q.about));
    const opts = make("div", "opts");
    for (const option of q.options) opts.appendChild(make("span", "opt", option));
    box.appendChild(opts);
    el.questions.appendChild(box);
  }
}
