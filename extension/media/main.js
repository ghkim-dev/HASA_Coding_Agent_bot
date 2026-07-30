// @ts-check
/**
 * HASA Agent Arena panel.
 *
 * Deliberately dependency-free and rendered from a single state object: the
 * panel is a view over what the extension host sends and holds no truth of its
 * own. It has no network access at all (see the CSP in panel.ts), so there is
 * nothing here that could reach HASA even if it wanted to.
 */
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  /** @type {{state: any, catalogue: any, snapshot: any, problem: any, form: any, applied: any}} */
  const model = {
    state: { phase: "idle", hasApiKey: false, workspaceIsGitRepo: false, workspaceRoot: null, defaultCandidateCount: 2, busy: false },
    catalogue: { probedAt: null, staleness: [], models: [] },
    snapshot: null,
    problem: null,
    applied: null,
    form: {
      mode: "code",
      prompt: "",
      selected: /** @type {string[]} */ ([]),
      judge: "",
      runtimeAdapter: "agent",
      commands: /** @type {any[]} */ ([]),
      writeScope: "",
    },
  };

  const app = /** @type {HTMLElement} */ (document.getElementById("app"));

  // ---------- helpers ----------

  /**
   * @param {string} tag
   * @param {Record<string, any>} [attrs]
   * @param {(Node|string|null|undefined|false)[]} [children]
   */
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = String(value);
      else if (key === "text") node.textContent = String(value);
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) node.setAttribute(key, "");
      else node.setAttribute(key, String(value));
    }
    for (const child of children || []) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  function post(message) {
    vscode.postMessage(message);
  }

  function statusBadge(status) {
    const map = {
      queued: ["idle", "대기"],
      running: ["busy", "실행 중"],
      completed: ["ok", "완료"],
      failed: ["bad", "실패"],
      excluded: ["warn", "제외"],
    };
    const [cls, label] = map[status] || ["idle", status];
    return el("span", { class: `badge ${cls}` }, [label]);
  }

  function fmtMs(ms) {
    if (ms === null || ms === undefined) return "—";
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
  }

  // ---------- sections ----------

  function renderProblem() {
    if (!model.problem) return null;
    const p = model.problem;
    return el("div", { class: `problem ${p.kind}`, role: "alert" }, [
      el("strong", { text: p.title }),
      el("div", { class: "mono", text: p.detail }),
      el(
        "div",
        { class: "actions" },
        (p.actions || [])
          .map((a) => el("button", { class: "secondary", onclick: () => post({ type: "action", id: a.id }) }, [a.label]))
          .concat([
            el("button", { class: "secondary", onclick: () => post({ type: "dismissProblem" }) }, ["닫기"]),
          ]),
      ),
    ]);
  }

  function renderKeyGate() {
    return el("section", { "aria-labelledby": "key-h" }, [
      el("h2", { id: "key-h", text: "API Key가 필요합니다" }),
      el("p", {
        class: "muted",
        text: "키는 VS Code SecretStorage에만 저장되며 이 패널로는 전달되지 않습니다. 모델 호출은 별도 오케스트레이터 프로세스에서만 이루어집니다.",
      }),
      el("button", { onclick: () => post({ type: "setApiKey" }) }, ["HASA API Key 설정"]),
    ]);
  }

  function eligibleFor(entry) {
    return model.form.mode === "code"
      ? model.form.runtimeAdapter === "agent"
        ? entry.eligibility.codingAgent
        : entry.eligibility.patchMode || entry.eligibility.codingAgent
      : entry.eligibility.responseCompare;
  }

  function renderModelPicker() {
    const entries = model.catalogue.models;
    if (entries.length === 0) {
      return el("p", { class: "muted" }, [
        "capability matrix가 없습니다. 저장소에서 ",
        el("code", { class: "mono", text: "pnpm probe" }),
        " 를 먼저 실행하세요.",
      ]);
    }

    return el(
      "div",
      { class: "models", role: "group", "aria-labelledby": "cand-legend" },
      entries.map((entry) => {
        const eligible = eligibleFor(entry);
        const checked = model.form.selected.includes(entry.modelId);
        const id = `m-${entry.modelId.replace(/[^a-z0-9]/gi, "-")}`;
        // Ineligible models stay visible with their reason. Hiding them leaves
        // the user hunting for a model that a gateway setting removed.
        const why = eligible
          ? `최대 출력 ${entry.maxOutputTokens ?? "?"} 토큰${entry.latencyMs ? ` · p50 ${entry.latencyMs}ms` : ""}`
          : entry.toolsDetail === "server_tool_calling_disabled"
            ? "게이트웨이가 tool calling을 비활성화함 (모델 문제 아님)"
            : (entry.eligibility.reasons || []).join("; ") || "이 모드에 사용할 수 없음";

        return el("div", { class: `model${eligible ? "" : " ineligible"}` }, [
          el("input", {
            type: "checkbox",
            id,
            checked,
            disabled: !eligible,
            "aria-describedby": `${id}-why`,
            onchange: (e) => {
              const on = e.target.checked;
              model.form.selected = on
                ? model.form.selected.concat([entry.modelId])
                : model.form.selected.filter((m) => m !== entry.modelId);
              if (model.form.judge === entry.modelId) model.form.judge = "";
              render();
            },
          }),
          el("label", { for: id, style: "margin:0" }, [
            el("span", { class: "name", text: entry.modelId }),
            el("span", { class: "why", id: `${id}-why`, text: why }),
          ]),
        ]);
      }),
    );
  }

  function renderCommandsEditor() {
    const rows = model.form.commands.map((cmd, index) =>
      el("div", { class: "command-row" }, [
        el("div", {}, [
          el("label", { for: `g${index}`, text: "게이트" }),
          el(
            "select",
            {
              id: `g${index}`,
              onchange: (e) => {
                cmd.gate = e.target.value;
              },
            },
            ["install", "build", "test", "typecheck", "lint"].map((g) =>
              el("option", { value: g, selected: cmd.gate === g }, [g]),
            ),
          ),
        ]),
        el("div", {}, [
          el("label", { for: `k${index}`, text: "종류" }),
          el(
            "select",
            {
              id: `k${index}`,
              onchange: (e) => {
                cmd.kind = e.target.value;
              },
              title:
                "regression: base commit에서 통과해야 함. acceptance: base commit에서 실패하는 것이 정상.",
            },
            [
              el("option", { value: "regression", selected: cmd.kind === "regression" }, ["regression"]),
              el("option", { value: "acceptance", selected: cmd.kind === "acceptance" }, ["acceptance"]),
            ],
          ),
        ]),
        el("div", {}, [
          el("label", { for: `c${index}`, text: "실행 파일" }),
          el("input", {
            id: `c${index}`,
            type: "text",
            value: cmd.cmd,
            placeholder: "pnpm",
            oninput: (e) => {
              cmd.cmd = e.target.value;
            },
          }),
        ]),
        el("div", {}, [
          el("label", { for: `a${index}`, text: "인자 (공백 구분)" }),
          el("input", {
            id: `a${index}`,
            type: "text",
            value: cmd.argsText,
            placeholder: "test",
            oninput: (e) => {
              cmd.argsText = e.target.value;
            },
          }),
        ]),
        el(
          "button",
          {
            class: "secondary",
            "aria-label": `${index + 1}번째 명령 삭제`,
            onclick: () => {
              model.form.commands.splice(index, 1);
              render();
            },
          },
          ["삭제"],
        ),
      ]),
    );

    return el("div", {}, [
      el("p", { class: "muted" }, [
        "후보가 실행할 수 있는 명령은 여기 선언한 것뿐입니다. 셸을 거치지 않고 인자 배열로 그대로 전달됩니다.",
      ]),
      ...rows,
      el(
        "button",
        {
          class: "secondary",
          onclick: () => {
            model.form.commands.push({ gate: "test", kind: "regression", cmd: "", argsText: "", timeoutMs: 300000 });
            render();
          },
        },
        ["+ 명령 추가"],
      ),
    ]);
  }

  function renderSetup() {
    const running = ["starting", "running", "evaluating"].includes(model.state.phase);
    const judgeOptions = model.catalogue.models.filter(
      (m) => m.eligibility.judge && !model.form.selected.includes(m.modelId),
    );
    const count = model.form.selected.length;
    const canStart =
      !running &&
      count >= 2 &&
      model.form.judge !== "" &&
      model.form.prompt.trim().length > 0 &&
      (model.form.mode === "response" || model.state.workspaceIsGitRepo);

    return el("section", { "aria-labelledby": "setup-h" }, [
      el("h2", { id: "setup-h", text: "비교 설정" }),

      el("fieldset", {}, [
        el("legend", { text: "모드" }),
        el("div", { class: "row" }, [
          el("div", { class: "grow" }, [
            el("label", { for: "mode", text: "비교 대상" }),
            el(
              "select",
              {
                id: "mode",
                disabled: running,
                onchange: (e) => {
                  model.form.mode = e.target.value;
                  model.form.selected = [];
                  model.form.judge = "";
                  render();
                },
              },
              [
                el("option", { value: "code", selected: model.form.mode === "code" }, ["코드 변경 (worktree 격리)"]),
                el("option", { value: "response", selected: model.form.mode === "response" }, ["응답 비교 (파일 미수정)"]),
              ],
            ),
          ]),
          model.form.mode === "code" &&
            el("div", { class: "grow" }, [
              el("label", { for: "runtime", text: "런타임" }),
              el(
                "select",
                {
                  id: "runtime",
                  disabled: running,
                  onchange: (e) => {
                    model.form.runtimeAdapter = e.target.value;
                    model.form.selected = [];
                    render();
                  },
                },
                [
                  el("option", { value: "agent", selected: model.form.runtimeAdapter === "agent" }, [
                    "agent (tool calling)",
                  ]),
                  el("option", { value: "patch", selected: model.form.runtimeAdapter === "patch" }, [
                    "patch (diff 생성)",
                  ]),
                ],
              ),
            ]),
        ]),
        model.form.mode === "code" &&
          !model.state.workspaceIsGitRepo &&
          el("p", { class: "muted", role: "note" }, [
            "코드 모드는 git 저장소 루트가 열려 있어야 합니다. 현재 workspace: ",
            el("code", { class: "mono", text: model.state.workspaceRoot || "(없음)" }),
          ]),
      ]),

      el("fieldset", {}, [
        el("legend", { id: "cand-legend" }, [
          `후보 모델 (${count}개 선택됨, 최소 2개)`,
        ]),
        renderModelPicker(),
      ]),

      el("fieldset", {}, [
        el("legend", { text: "judge 모델" }),
        el("label", { for: "judge", class: "muted", text: "후보와 반드시 달라야 합니다 (자기 심사 금지)" }),
        el(
          "select",
          {
            id: "judge",
            disabled: running,
            onchange: (e) => {
              model.form.judge = e.target.value;
              render();
            },
          },
          [el("option", { value: "" }, ["— 선택 —"])].concat(
            judgeOptions.map((m) =>
              el("option", { value: m.modelId, selected: model.form.judge === m.modelId }, [m.modelId]),
            ),
          ),
        ),
      ]),

      el("fieldset", {}, [
        el("legend", { text: "과제" }),
        el("label", { for: "prompt", text: "모든 후보에게 동일하게 전달됩니다" }),
        el("textarea", {
          id: "prompt",
          disabled: running,
          placeholder: "예: src/app.ts 의 answer 를 42로 바꾸고 관련 테스트를 통과시켜라.",
          oninput: (e) => {
            model.form.prompt = e.target.value;
          },
        }, [model.form.prompt]),
      ]),

      model.form.mode === "code" &&
        el("fieldset", {}, [
          el("legend", { text: "acceptance 명령" }),
          renderCommandsEditor(),
          el("label", { for: "scope", class: "muted", text: "쓰기 허용 경로 (쉼표 구분, 비우면 전체)" }),
          el("input", {
            id: "scope",
            type: "text",
            value: model.form.writeScope,
            placeholder: "src, docs",
            oninput: (e) => {
              model.form.writeScope = e.target.value;
            },
          }),
        ]),

      el("div", { class: "row" }, [
        el(
          "button",
          {
            disabled: !canStart,
            onclick: () => {
              post({
                type: "start",
                request: {
                  mode: model.form.mode,
                  prompt: model.form.prompt,
                  candidateModelIds: model.form.selected,
                  judgeModelId: model.form.judge,
                  runtimeAdapter: model.form.runtimeAdapter,
                  writeScope: model.form.writeScope
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                  acceptanceCommands: model.form.commands
                    .filter((c) => c.cmd.trim().length > 0)
                    .map((c) => ({
                      gate: c.gate,
                      kind: c.kind,
                      cmd: c.cmd.trim(),
                      args: c.argsText.split(/\s+/).filter(Boolean),
                      timeoutMs: c.timeoutMs,
                    })),
                  repoRoot: model.state.workspaceRoot,
                },
              });
            },
          },
          ["비교 시작"],
        ),
        running && el("button", { class: "secondary", onclick: () => post({ type: "cancel" }) }, ["취소"]),
        el("button", { class: "secondary", onclick: () => post({ type: "refreshModels" }) }, ["모델 새로고침"]),
        model.catalogue.probedAt &&
          el("span", { class: "muted", text: `probe: ${new Date(model.catalogue.probedAt).toLocaleString()}` }),
      ]),

      model.catalogue.staleness.length > 0 &&
        el("p", { class: "muted", role: "note", text: `matrix 경고: ${model.catalogue.staleness.join("; ")}` }),
    ]);
  }

  function renderGates(candidate) {
    const gates = candidate.gates || [];
    if (gates.length === 0) return null;
    return el("table", {}, [
      el("caption", { text: "빌드 · 테스트 · 정적 분석" }),
      el("thead", {}, [
        el("tr", {}, [
          el("th", { scope: "col", text: "게이트" }),
          el("th", { scope: "col", text: "결과" }),
          el("th", { scope: "col", text: "내용" }),
        ]),
      ]),
      el(
        "tbody",
        {},
        gates.map((g) =>
          el("tr", {}, [
            el("td", { class: "mono", text: g.gate }),
            el("td", {}, [
              el("span", { class: `badge ${g.passed ? "ok" : "bad"}` }, [g.passed ? "통과" : "실패"]),
              g.flaky && el("span", { class: "badge warn" }, ["flaky"]),
            ]),
            el("td", { class: "detail", text: g.detail }),
          ]),
        ),
      ),
    ]);
  }

  function renderCandidate(candidate, result) {
    const isWinner = result && result.winnerCandidateId === candidate.candidateId;
    return el("article", { class: `candidate${isWinner ? " winner" : ""}`, "aria-label": `후보 ${candidate.label}` }, [
      el("header", {}, [
        el("h3", {}, [candidate.label, isWinner ? " · 승자" : ""]),
        statusBadge(candidate.status),
      ]),
      el("div", { class: "model-id", text: candidate.modelId }),

      candidate.excludedReason &&
        el("div", { class: "badge bad", text: `제외 사유: ${candidate.excludedReason}` }),

      // Only facts that exist for this mode. A response comparison has no
      // score, no diff and no tool calls, and printing "점수 —" for all of them
      // is noise the reader has to filter out every time.
      el("div", { class: "stats" }, [
        candidate.score !== null &&
          candidate.score !== undefined &&
          el("span", { text: `점수 ${candidate.score}` }),
        el("span", { text: `소요 ${fmtMs(candidate.latencyMs)}` }),
        candidate.tokensOut && el("span", { text: `출력 ${candidate.tokensOut} 토큰` }),
        candidate.diffLines !== undefined && el("span", { text: `diff ${candidate.diffLines}줄` }),
        candidate.changedFiles &&
          candidate.changedFiles.length > 0 &&
          el("span", { text: `변경 ${candidate.changedFiles.length}개 파일` }),
        candidate.toolCalls ? el("span", { text: `tool ${candidate.toolCalls}회` }) : null,
        candidate.attempts && candidate.attempts > 1 && el("span", { text: `재시도 ${candidate.attempts - 1}회` }),
      ]),

      candidate.outOfScopeFiles && candidate.outOfScopeFiles.length > 0 &&
        el("div", { class: "badge warn", text: `범위 밖 수정 ${candidate.outOfScopeFiles.length}개` }),

      candidate.summary && el("p", { class: "muted", text: candidate.summary }),
      // Full text, wrapped and scrolled inside the card. Truncating silently
      // would hide exactly the part a reviewer is comparing.
      candidate.responseText && el("pre", { text: candidate.responseText }),

      renderGates(candidate),

      (candidate.commands || []).length > 0 &&
        el("details", {}, [
          el("summary", { text: `실행한 명령 ${candidate.commands.length}개` }),
          el(
            "ul",
            { class: "mono" },
            candidate.commands.map((c) =>
              el("li", {
                text: `${c.gate}: ${c.cmd} ${c.args.join(" ")} → exit ${c.exitCode}${c.timedOut ? " (timeout)" : ""}`,
              }),
            ),
          ),
        ]),

      el("div", { class: "row" }, [
        candidate.diffLines !== undefined &&
          candidate.diffLines > 0 &&
          el(
            "button",
            {
              class: "secondary",
              onclick: () => post({ type: "openDiff", candidateId: candidate.candidateId, label: candidate.label }),
            },
            ["diff 보기"],
          ),
        // Long answers are easier to compare in a real editor, where find,
        // word wrap and side-by-side tabs already work.
        candidate.responseText &&
          candidate.responseText.length > 400 &&
          el(
            "button",
            {
              class: "secondary",
              onclick: () =>
                post({ type: "openResponse", candidateId: candidate.candidateId, label: candidate.label }),
            },
            ["에디터에서 열기"],
          ),
      ]),
    ]);
  }

  function renderResult(snapshot) {
    const result = snapshot.result;
    if (!result) return null;

    const winner = result.outcome === "winner";
    return el("section", { class: "result", "aria-labelledby": "res-h" }, [
      el("h2", { id: "res-h", text: "판정 결과" }),
      el("div", { class: "headline" }, [
        el("span", { class: `badge ${winner ? "ok" : "warn"}` }, [winner ? "winner" : "no_winner"]),
        " ",
        winner ? `${result.winnerLabel} 선정` : "승자 없음",
      ]),
      el("p", { text: result.reason }),
      result.confidence && el("p", { class: "muted", text: `근거 유형: ${result.confidence}` }),

      // Two different statements, deliberately kept apart. The first says the
      // verdict is weak and why; the second is unconditional and is about who
      // decides what lands in the repository, not about confidence.
      result.reviewReason &&
        el("p", { role: "note" }, [
          el("span", { class: "badge warn" }, ["검토 필요"]),
          " ",
          {
            never_compared: "게이트를 통과한 후보가 하나뿐이라 비교가 이루어지지 않았습니다.",
            unstable_judge: "순서를 뒤집자 judge가 판정을 바꿨습니다. 이 판정은 근거로 쓸 수 없습니다.",
            tie: "후보를 가를 근거가 없습니다.",
            judge_only: "객관 게이트 없이 judge 판단에만 의존한 결과입니다.",
          }[result.reviewReason] || result.reviewReason,
        ]),

      el("p", { class: "muted", text: "적용 여부는 항상 사용자가 결정합니다. Apply 전까지 workspace는 변경되지 않습니다." }),

      snapshot.verdicts.length > 0 &&
        el("details", { open: true }, [
          el("summary", { text: `blind pairwise 판정 ${snapshot.verdicts.length}건 (순서 뒤집기 포함)` }),
          el(
            "ul",
            { class: "verdicts" },
            snapshot.verdicts.map((v) =>
              el("li", {}, [
                el("span", { class: "mono", text: `${v.pair} [${v.presentationOrder}] ` }),
                v.winnerLabel ? `→ ${v.winnerLabel}` : "→ 무승부",
                v.confidence !== null ? ` (확신 ${v.confidence})` : "",
                v.parseAttempts > 1 ? ` · 파싱 재시도 ${v.parseAttempts - 1}회` : "",
                v.reasons && v.reasons.length > 0 ? el("div", { class: "muted", text: v.reasons.join(" / ") }) : null,
              ]),
            ),
          ),
        ]),

      el("div", { class: "row" }, [
        winner &&
          el(
            "button",
            { onclick: () => post({ type: "apply", candidateId: result.winnerCandidateId }) },
            ["Apply winner"],
          ),
        el("button", { class: "secondary", onclick: () => post({ type: "reject" }) }, ["Reject all"]),
        el("span", {
          class: "muted",
          text: "Apply를 누르기 전에는 workspace가 변경되지 않습니다.",
        }),
      ]),

      model.applied &&
        el("div", { class: "problem", role: "status", style: "border-left-color: var(--vscode-charts-green)" }, [
          el("strong", { text: `${model.applied.label} 적용 완료` }),
          el("div", { class: "mono", text: `변경 파일: ${model.applied.changedFiles.join(", ") || "(없음)"}` }),
          model.applied.revertRef &&
            el("div", { class: "mono", text: `되돌리기: git stash apply ${model.applied.revertRef}` }),
        ]),
    ]);
  }

  function renderRun() {
    const snapshot = model.snapshot;
    if (!snapshot) return null;
    return el("section", { "aria-labelledby": "run-h" }, [
      el("h2", { id: "run-h" }, [
        "진행 상황 ",
        el("span", { class: "badge busy", text: snapshot.status }),
      ]),
      el("p", { class: "muted mono", text: `run ${snapshot.runId}${snapshot.baseCommit ? ` · base ${snapshot.baseCommit.slice(0, 10)}` : ""}` }),
      el(
        "div",
        { class: "candidates" },
        snapshot.candidates.map((c) => renderCandidate(c, snapshot.result)),
      ),
    ]);
  }

  // ---------- root ----------

  function render() {
    const children = [
      el("div", {}, [
        el("h1", { text: "HASA Agent Arena" }),
        el("p", {
          class: "muted",
          text: "같은 과제를 여러 모델에게 독립적으로 시키고, 객관 지표와 blind judge로 비교한 뒤, 검토를 마친 뒤에만 적용합니다.",
        }),
      ]),
      renderProblem(),
      model.state.hasApiKey ? renderSetup() : renderKeyGate(),
      renderRun(),
      model.snapshot && renderResult(model.snapshot),
      // Announced to screen readers without stealing focus.
      el("div", { class: "sr-only", role: "status", "aria-live": "polite", id: "live" }),
    ].filter(Boolean);

    app.replaceChildren(...children);
  }

  // ---------- host messages ----------

  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
      case "state":
        model.state = message.state;
        if (model.form.commands.length === 0 && model.state.workspaceIsGitRepo) {
          model.form.commands = [
            { gate: "test", kind: "regression", cmd: "", argsText: "", timeoutMs: 300000 },
          ];
        }
        break;
      case "catalogue":
        model.catalogue = message.catalogue;
        break;
      case "runUpdate":
        model.snapshot = message.snapshot;
        break;
      case "problem":
        model.problem = message.problem;
        break;
      case "problemCleared":
        model.problem = null;
        break;
      case "applied":
        model.applied = message;
        break;
      case "rejected":
        model.snapshot = null;
        model.applied = null;
        break;
      case "activity": {
        const live = document.getElementById("live");
        if (live) live.textContent = message.message;
        return;
      }
      default:
        return;
    }
    render();
  });

  render();
  post({ type: "ready" });
})();
