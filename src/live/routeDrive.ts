import { mkdtemp, rm, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHasaProvider } from "../provider/hasa/createProvider.ts";
import { HasaCatalog, canConverse, type Modality } from "../provider/hasa/hasaCatalog.ts";
import { createMediaTransport } from "../provider/hasa/hasaMediaTransport.ts";
import { conversabilityFor, fingerprint } from "../router/conversability.ts";
import { createModelFor } from "../agent/hasaModel.ts";
import { chooseModel, protocolFor } from "../agent/autoModel.ts";
import { AgentSession } from "../agent/session.ts";
import { allowingApprovalPort } from "../agent/approval.ts";
import { TurnRecorder } from "../agent/sessionRecorder.ts";
import { emptyContract, mergeContract, reduceContract } from "../agent/turnContract.ts";
import { readSession, writeSession } from "../agent/sessionLog.ts";
import { SESSION_SCHEMA_VERSION, type SessionEvent } from "../agent/sessionEvents.ts";
import { completedTurn } from "../agent/conversationGraph.ts";
import { reduceTask } from "../agent/taskReducer.ts";
import { describeTask } from "../agent/taskState.ts";
import { describeViolations, safeFallback, taskDisposition, validateFinalClaims } from "../agent/finalClaims.ts";
import { interpretRequest } from "../router/bootstrap.ts";
import { buildRegistry } from "../router/modelRegistry.ts";
import { loadEvidence } from "../router/evaluationStore.ts";
import { routeTurn, routingEvent, selectedWorkerFor } from "../router/routing.ts";
import { recommendModel } from "../router/recommend.ts";
import { projectTaskSemanticProfile } from "../router/semanticProfile.ts";
import { ShadowRunner } from "../router/shadowRunner.ts";
import { actionLedger, summarizeActions } from "../router/actionLedger.ts";
import { coverageReport } from "../router/modelSemanticCatalog.ts";
import type { AgentEvent } from "../agent/types.ts";

/**
 * One real turn through the *routing* path, against the real gateway.
 *
 * `drive.ts` opens a session on a model chosen by hand. This runs what the
 * product actually does since R3: read the request with a bootstrap model,
 * project a profile, filter, rank, and hand the turn to the worker that came
 * out — then observe the semantic term in shadow and replay the whole thing
 * from what was persisted.
 *
 * It exists because everything about that path has so far been verified by
 * controlled tests. Twelve thousand of them pass and none of them has ever
 * called the gateway, so the one thing still unmeasured is whether the wiring
 * runs at all against a real model.
 *
 *   node --env-file-if-exists=.env src/live/routeDrive.ts <scenario> [steps]
 *
 * Costs real inference requests and needs a credential, so it is opt-in and
 * not part of `pnpm test`. The workspace is a fresh temporary directory this
 * script fills itself and removes on exit; set KEEP to inspect it. No file of
 * the user's is read or written, and no credential or header is printed.
 *
 * Scenarios are fixtures. The workspace is a fresh temporary directory with
 * files this script writes itself — nothing of the user's is read or changed.
 */

type ScenarioId =
  | "analysis-only"
  | "simple-coding"
  | "recovery"
  | "python-recovery"
  | "python-deps";

interface Scenario {
  id: ScenarioId;
  prompt: string;
  /** Files laid down in the disposable workspace before the turn. */
  fixture: Array<{ path: string; content: string }>;
  expectation: string;
  /**
   * Commands this scenario allows, beyond the default.
   *
   * Every one is resolved inside the disposable workspace. Nothing here
   * installs anything globally or touches the system interpreter — a
   * `python -m venv .venv` writes into the temp directory and dies with it.
   */
  commands?: Array<{ gate: "test"; kind: "regression"; cmd: string; args: string[]; timeoutMs: number }>;
  /**
   * Work done before the turn, so the scenario measures what it means to.
   *
   * `python-recovery` provisions the interpreter itself: the thing under test
   * there is whether a worker can drive a failing test to green, and a worker
   * that spends its budget on `pip` never reaches the question. `python-deps`
   * deliberately provisions nothing, because *that* is its question.
   */
  provision?: (root: string) => Promise<string[]>;
}

const SCENARIOS: Record<ScenarioId, Scenario> = {
  "analysis-only": {
    id: "analysis-only",
    prompt:
      "실행하거나 수정하지 말고, src/inventory.py 의 구조적 문제만 분석해서 알려주세요.",
    fixture: [
      {
        path: "src/inventory.py",
        content: [
          "import json",
          "",
          "ITEMS = {}",
          "",
          "def add(name, qty):",
          "    ITEMS[name] = ITEMS.get(name, 0) + qty",
          "    with open('db.json', 'w') as f:",
          "        json.dump(ITEMS, f)",
          "",
          "def remove(name, qty):",
          "    ITEMS[name] = ITEMS[name] - qty",
          "    with open('db.json', 'w') as f:",
          "        json.dump(ITEMS, f)",
          "",
          "def total():",
          "    return sum(ITEMS.values())",
          "",
        ].join("\n"),
      },
    ],
    expectation:
      "no_execute and no_modify recorded; no write or command action executed",
  },
  "simple-coding": {
    id: "simple-coding",
    prompt: "src/greet.py 에 이름을 받아 인사말을 돌려주는 greet 함수를 추가해 주세요.",
    fixture: [{ path: "src/greet.py", content: '"""Greetings."""\n' }],
    expectation: "one file written; no command run",
  },
  recovery: {
    id: "recovery",
    prompt:
      "src/calc.py 의 divide 함수에 0으로 나누는 버그가 있습니다. 고치고 python -m pytest 로 확인해 주세요.",
    fixture: [
      {
        path: "src/calc.py",
        content: ["def divide(a, b):", "    return a / b", ""].join("\n"),
      },
      {
        path: "test_calc.py",
        content: [
          "from src.calc import divide",
          "",
          "def test_divide():",
          "    assert divide(6, 3) == 2",
          "",
          "def test_divide_by_zero():",
          "    assert divide(1, 0) is None",
          "",
        ].join("\n"),
      },
    ],
    expectation: "a failing test observed, a fix attempted, the test re-run",
  },
  "python-recovery": {
    id: "python-recovery",
    prompt:
      "pytest 가 실패하고 있습니다. .venv/Scripts/python -m pytest -q 로 확인하고, " +
      "src/stats.py 를 고쳐서 통과시켜 주세요.",
    fixture: [
      {
        path: "src/__init__.py",
        content: "",
      },
      {
        // Two bugs, so a fix that is not read carefully leaves one behind and
        // the second run still fails. `fail→fix→pass` is only a measurement
        // when passing takes more than one guess.
        path: "src/stats.py",
        content: [
          "def mean(values):",
          "    return sum(values) / len(values)",
          "",
          "def median(values):",
          "    s = sorted(values)",
          "    return s[len(s) // 2]",
          "",
        ].join("\n"),
      },
      {
        path: "test_stats.py",
        content: [
          "from src.stats import mean, median",
          "",
          "def test_mean_empty():",
          "    assert mean([]) == 0",
          "",
          "def test_median_even():",
          "    assert median([1, 2, 3, 4]) == 2.5",
          "",
          "def test_mean_basic():",
          "    assert mean([2, 4]) == 3",
          "",
        ].join("\n"),
      },
    ],
    expectation: "two failing tests driven to exit 0, with fresh evidence for the passing run",
    commands: [
      { gate: "test", kind: "regression", cmd: ".venv/Scripts/python", args: ["-m", "pytest", "-q"], timeoutMs: 120_000 },
      { gate: "test", kind: "regression", cmd: ".venv/bin/python", args: ["-m", "pytest", "-q"], timeoutMs: 120_000 },
    ],
    provision: provisionVenv,
  },
  "python-deps": {
    id: "python-deps",
    prompt:
      "src/stats.py 의 mean 이 빈 리스트에서 터집니다. 고치고 pytest 로 확인해 주세요. " +
      "이 작업 공간에는 pytest 가 설치되어 있지 않습니다.",
    fixture: [
      { path: "src/__init__.py", content: "" },
      {
        path: "src/stats.py",
        content: ["def mean(values):", "    return sum(values) / len(values)", ""].join("\n"),
      },
      {
        path: "test_stats.py",
        content: [
          "from src.stats import mean",
          "",
          "def test_mean_empty():",
          "    assert mean([]) == 0",
          "",
        ].join("\n"),
      },
    ],
    expectation:
      "the missing dependency diagnosed, a workspace-local venv created and used — never a global install",
    commands: [
      { gate: "test", kind: "regression", cmd: "python", args: ["-m", "venv", ".venv"], timeoutMs: 180_000 },
      { gate: "test", kind: "regression", cmd: ".venv/Scripts/python", args: ["-m", "pip", "install", "pytest"], timeoutMs: 300_000 },
      { gate: "test", kind: "regression", cmd: ".venv/bin/python", args: ["-m", "pip", "install", "pytest"], timeoutMs: 300_000 },
      { gate: "test", kind: "regression", cmd: ".venv/Scripts/python", args: ["-m", "pytest", "-q"], timeoutMs: 120_000 },
      { gate: "test", kind: "regression", cmd: ".venv/bin/python", args: ["-m", "pytest", "-q"], timeoutMs: 120_000 },
      { gate: "test", kind: "regression", cmd: "python", args: ["-m", "pytest", "-q"], timeoutMs: 60_000 },
    ],
  },
};

/**
 * A virtualenv inside the disposable workspace, with pytest in it.
 *
 * Inside, never outside. `python -m venv .venv` writes only into the temp
 * directory the driver made and removes on exit, and `pip` is invoked through
 * that interpreter so nothing reaches the system site-packages. The user
 * approved installation in a disposable fixture and nowhere else.
 */
async function provisionVenv(root: string): Promise<string[]> {
  const { spawn } = await import("node:child_process");
  const log: string[] = [];
  const run = (cmd: string, args: string[]): Promise<number> =>
    new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd: root, shell: false });
      child.on("error", () => resolve(-1));
      child.on("close", (code) => resolve(code ?? -1));
    });

  const venv = await run("python", ["-m", "venv", ".venv"]);
  log.push(`python -m venv .venv → ${venv}`);
  if (venv !== 0) return log;

  const py = process.platform === "win32" ? ".venv\\Scripts\\python.exe" : ".venv/bin/python";
  const pip = await run(py, ["-m", "pip", "install", "-q", "pytest"]);
  log.push(`${py} -m pip install pytest → ${pip}`);
  return log;
}

const scenarioId = (process.argv[2] ?? "analysis-only") as ScenarioId;
const scenario = SCENARIOS[scenarioId];
if (scenario === undefined) {
  process.stdout.write(`unknown scenario: ${scenarioId}\n`);
  process.stdout.write(`available: ${Object.keys(SCENARIOS).join(", ")}\n`);
  process.exit(2);
}
const maxSteps = Number(process.argv[3] ?? 12);

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const section = (title: string): void => out(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);

// ---------------------------------------------------------------------------

const provider = createHasaProvider({
  apiKey: process.env["HASA_API_KEY"] ?? "",
  ...(process.env["HASA_BASE_URL"] ? { baseUrl: process.env["HASA_BASE_URL"] } : {}),
});

const root = await mkdtemp(join(tmpdir(), `hasa-route-${scenario.id}-`));
for (const file of scenario.fixture) {
  const full = join(root, file.path);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, file.content, "utf8");
}

if (scenario.provision !== undefined) {
  for (const line of await scenario.provision(root)) out(`provision  : ${line}`);
}

out(`scenario   : ${scenario.id}`);
out(`workspace  : ${root}   (disposable; no user file is read or changed)`);
out(`expectation: ${scenario.expectation}`);

const turnId = "t1";
const recorded: SessionEvent[] = [];
const recorder = new TurnRecorder({ turnId });
recorder.userMessage(scenario.prompt).forEach((e) => recorded.push(e));

// --- catalogue -------------------------------------------------------------
const listing = await provider.listModels();
// What the portal catalogue knows about each model. Unknown stays unknown;
// only an explicit non-chat modality becomes evidence.
const origin = (process.env["HASA_BASE_URL"] ?? "").replace(/\/v1\/?$/, "");
const catalog = new HasaCatalog(
  createMediaTransport({ origin, apiKey: process.env["HASA_API_KEY"] ?? "" }),
);
const converses = new Map<string, boolean>();
// The modality itself, not just the boolean it implies. `canConverse` answers
// whether the endpoint takes a conversation; pool membership is a different
// question and needs the modality to answer it — see `poolEligibility.ts`.
const modality = new Map<string, Modality>();
for (const entry of await catalog.all()) {
  modality.set(entry.id, entry.modality);
  if (!canConverse(entry.modality)) converses.set(entry.id, false);
  else if (entry.callable === false) converses.set(entry.id, false);
}
// Invocation evidence outranks the catalogue: these were called and answered
// 404 in a run where another model answered 200 on the same path.
for (const [id, value] of conversabilityFor({
  baseUrlFingerprint: fingerprint(process.env["HASA_BASE_URL"] ?? ""),
  credentialFingerprint: fingerprint(process.env["HASA_API_KEY"] ?? ""),
})) {
  converses.set(id, value);
}
// Whatever a sweep has measured against this gateway, if anything.
//
// The second argument was `[]` at every call site for three slices, which is
// why `selectionBasis` has always come back `eligibility_then_deterministic_
// tie_break`: with no evaluation the capability, evaluation and efficiency
// terms are all neutral for every candidate and the ranking has nothing to
// rank on. An empty result here is reported, not hidden — a recommendation
// that lost its evidence and one that never had any produce the same list and
// very different explanations.
const evidence = await loadEvidence({
  baseUrl: process.env["HASA_BASE_URL"] ?? "",
  now: Date.now(),
});
const registry = buildRegistry(listing.models, evidence.summaries, { converses, modality });
// The observation registry exists only to report what the quarantined dataset
// *would* have chosen. It is built separately and never handed to `routeTurn`.
const shadowRegistry =
  evidence.quarantined.length === 0
    ? null
    : buildRegistry(listing.models, evidence.quarantined, { converses, modality });
out(
  `evidence   : ${
    evidence.unusable ??
    evidence.quarantine ??
    `${evidence.summaries.length} model summaries from ${evidence.file?.measuredAt ?? "?"}`
  }`,
);
if (evidence.quarantine !== null) {
  out(`           : ${evidence.quarantined.length} summaries held back from production ranking`);
}

// --- bootstrap -------------------------------------------------------------
section("BOOTSTRAP");
const bootstrapChoice = await chooseModel({ models: listing.models, mode: "code" });
if (bootstrapChoice === null) {
  out("no usable model for bootstrap");
  process.exit(1);
}
out(`bootstrap model : ${bootstrapChoice.modelId} (${bootstrapChoice.toolProtocol})`);

const bootstrapModel = createModelFor({
  provider,
  modelId: bootstrapChoice.modelId,
  toolProtocol: bootstrapChoice.toolProtocol,
});

const bootstrapStarted = Date.now();
const interpreted = await interpretRequest({
  model: bootstrapModel,
  prompt: scenario.prompt,
  turnId,
});
const bootstrapMs = Date.now() - bootstrapStarted;
out(`bootstrap calls : ${interpreted.attempts}   latency: ${bootstrapMs}ms`);

if (!interpreted.ok) {
  out(`BOOTSTRAP FAILED: ${interpreted.failure} — ${interpreted.detail}`);
  out("no TaskProfile, so no requirement-aware selection. Stopping.");
  if (process.env["KEEP"] === undefined) await rm(root, { recursive: true, force: true });
  process.exit(1);
}

const contract = interpreted.contract;
section("TURN CONTRACT");
out(`goal        : ${contract.goal}`);
out(`relation    : ${contract.relation}   intents: ${contract.intents.join("+")}`);
out(`requirements: ${contract.requirements.length}`);
for (const r of contract.requirements) out(`   - ${r.description}`);
out(`constraints : ${contract.constraints.length === 0 ? "(none)" : ""}`);
for (const c of contract.constraints) out(`   ⊘ ${c.kind}: ${c.text}`);

recorded.push({ type: "turn_contract", id: "e-contract", turnId, at: Date.now(), contract });

// --- routing ---------------------------------------------------------------
const decision = await routeTurn({
  turn: contract,
  previous: emptyContract(),
  currentWorker: null,
  profiles: registry,
});

section("TASK PROFILE");
const profile = decision.taskProfile;
if (profile !== undefined) {
  out(`complexity : ${profile.complexity}   contextDemand: ${profile.contextDemand}`);
  const demanded = Object.entries(profile.demands)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v.toFixed(2)}`);
  out(`demands    : ${demanded.join(", ")}`);
  out(`constraints: ${JSON.stringify(profile.constraints)}`);
  out(`priorities : ${JSON.stringify(profile.priorities)}`);
}

section("ELIGIBILITY");
const recommendation = decision.recommendation;
out(`catalogue offered : ${listing.models.length}`);
out(`filtered out      : ${recommendation?.filteredOut.length ?? 0}`);
for (const f of recommendation?.filteredOut ?? []) {
  out(`   ✗ ${f.modelId.padEnd(26)} ${f.code}`);
}
const candidateCount =
  (recommendation?.alternatives.length ?? 0) + (recommendation?.selected === null ? 0 : 1);
out(`candidates        : ${candidateCount}`);

section("SELECTION");
const breakdown = recommendation?.selected?.breakdown;
const allNeutral =
  breakdown !== undefined &&
  Math.abs(breakdown.semantic - 0.5) < 1e-9 &&
  Math.abs(breakdown.capability - 0.5) < 1e-9 &&
  Math.abs(breakdown.evaluation - 0.5) < 1e-9 &&
  Math.abs(breakdown.efficiency - 0.5) < 1e-9;

const scores = [
  ...(recommendation?.selected === null || recommendation?.selected === undefined
    ? []
    : [recommendation.selected]),
  ...(recommendation?.alternatives ?? []),
].map((r) => r.score);
const tieBroken = scores.length > 1 && Math.abs((scores[0] ?? 0) - (scores[1] ?? 0)) < 1e-9;

out(`selected worker : ${decision.modelId ?? "(none)"}`);
out(`trigger/origin  : ${decision.trigger} / ${decision.origin}`);
out(`policy          : ${recommendation?.policyId ?? "-"}`);
out(`score breakdown : ${breakdown === undefined ? "-" : JSON.stringify(breakdown)}`);
// Which signal is actually deciding, not merely which is non-neutral.
//
// The first version of this line read `weighted_signals` whenever any term
// moved off 0.5, and a catalogue-declared capability moves it — so a run with
// its evaluation dataset quarantined still reported `weighted_signals`, which
// reads as evidence-backed and is not.
const evaluationApplied = breakdown !== undefined && Math.abs(breakdown.evaluation - 0.5) >= 1e-9;
out(
  `selectionBasis  : ${
    allNeutral
      ? "eligibility_then_deterministic_tie_break"
      : evaluationApplied
        ? "weighted_signals_with_evaluation"
        : "weighted_signals_declared_only (evaluation term neutral)"
  }`,
);
// What the quarantined numbers would have picked, reported beside the decision
// and never inside it. If these two ever agree by accident that is interesting;
// if this line is what production used, the quarantine failed.
if (shadowRegistry !== null && profile !== undefined) {
  const observed = await recommendModel(profile, shadowRegistry);
  out(`evaluationShadowBasis : weighted_signals_quarantined`);
  out(`  would have selected  : ${observed.selected?.modelId ?? "(none)"}`);
  out(
    `  production selected  : ${decision.modelId ?? "(none)"}   ${
      observed.selected?.modelId === decision.modelId ? "(same)" : "(differs — quarantine is load-bearing)"
    }`,
  );
}
out(`tie-break used  : ${tieBroken ? "yes (top two scores identical)" : "no"}`);
for (const r of recommendation?.reasons ?? []) out(`   · ${r.code}: ${r.detail}`);

const coverage = coverageReport({
  catalogListed: listing.models.map((m) => m.id),
  keyAllowed: listing.models.map((m) => m.id),
  chatCallable: registry.filter((p) => p.availability.protocol !== null).map((p) => p.modelId),
  embeddingCallable: [],
});
out(
  `coverage        : codingPool total=${coverage.codingPool.total} ` +
    `reviewed=${coverage.codingPool.reviewed.length} ` +
    `unreviewed=${coverage.codingPool.unreviewed.length} ` +
    `coldStart=${coverage.codingPool.coldStart.length}`,
);

if (decision.modelId === null) {
  out("no eligible worker. Stopping.");
  if (process.env["KEEP"] === undefined) await rm(root, { recursive: true, force: true });
  process.exit(1);
}

// --- shadow ----------------------------------------------------------------
section("SHADOW");
const runner = new ShadowRunner({
  apiKey: async () => process.env["HASA_API_KEY"] ?? null,
  baseUrl: () => process.env["HASA_BASE_URL"] ?? "",
  taskContract: () => mergeContract(emptyContract(), contract),
});
const shadowStarted = Date.now();
const shadow = await runner.observe(decision, registry);
const shadowMs = Date.now() - shadowStarted;
if (shadow === null) {
  out("no observation (no provider, or nothing to observe)");
} else {
  out(`status        : ${shadow.status}${shadow.failure === undefined ? "" : ` (${shadow.failure})`}`);
  out(`space         : ${JSON.stringify(shadow.embeddingSpace)}`);
  out(`method        : ${shadow.method}   calibrated: ${shadow.calibrated}`);
  out(`embedding calls: ${shadow.embeddingCalls}   latency: ${shadowMs}ms`);
  for (const c of shadow.candidates) {
    out(
      `   ${c.modelId.padEnd(26)} raw=${c.rawCosine?.toFixed(4) ?? "-"} ` +
        `norm=${c.normalized.toFixed(4)} prod#${c.productionRank} shadow#${c.shadowRank} ` +
        `[${c.profileStatus}]`,
    );
  }
  out(`shadow would pick: ${shadow.shadowSelectedModelId ?? "-"} (not acted on)`);
}

recorded.push(
  routingEvent({
    id: "e-routing",
    turnId,
    at: Date.now(),
    decision,
    bootstrapModelId: interpreted.bootstrapModelId,
    bootstrapModelCalls: interpreted.attempts,
    ...(shadow === null ? {} : { shadow }),
  }),
);

// --- the worker turn -------------------------------------------------------
section("WORKER TURN");
const capabilities = await provider.capabilities.capabilitiesOf(decision.modelId);
const workerProtocol = protocolFor(capabilities) ?? "text";
out(`worker model : ${decision.modelId} (${workerProtocol})`);

let lastTermination: string | undefined;
const session = await AgentSession.open({
  workspaceRoot: root,
  model: createModelFor({ provider, modelId: decision.modelId, toolProtocol: workerProtocol }),
  approvalPort: allowingApprovalPort,
  approvalMode: "auto",
  mode: "code",
  commands: scenario.commands ?? [
    { gate: "test", kind: "regression", cmd: "python", args: ["-m", "pytest", "-q"], timeoutMs: 90_000 },
  ],
  budget: { maxSteps, timeoutMs: 240_000 },
  taskRecord: () => {
    const task = reduceTask(recorded, "live");
    return task === null || task.requirements.length === 0 ? null : describeTask(task);
  },
  // The boundary the extension host wires and this driver did not.
  //
  // Its absence made every live drive so far a measurement of a harness the
  // user does not have — the routing path was exercised end to end with the
  // one gate that decides what the user is told switched off. `eval/runner.ts`
  // has wired it since C4.7 and this file was written after it, which is how
  // the omission survived: nothing compares the two.
  taskComplete: () =>
    taskDisposition(reduceTask(recorded, "live"), lastTermination) === "completed",
  finalClaims: {
    validate: (text: string) => {
      const task = reduceTask(recorded, "live");
      const verdict = validateFinalClaims({
        task,
        disposition: taskDisposition(task, lastTermination),
        text,
        ...(lastTermination === undefined ? {} : { termination: lastTermination }),
      });
      return verdict.valid ? null : describeViolations(verdict.violations);
    },
    fallback: () => {
      const task = reduceTask(recorded, "live");
      return safeFallback(task, taskDisposition(task, lastTermination), lastTermination);
    },
  },
});

// The worker inherits the contract the bootstrap pass already validated.
session.restoreContract(recorded);

let workerCalls = 0;
session.setEventSink((event: AgentEvent) => {
  recorder.record(event).forEach((e) => recorded.push(e));
  if (event.type === "error") {
    // The whole point of this run:  is a summary, and the
    // event that produced it carries the code and the message.
    out(`   ✗ ERROR EVENT  code=${event.code}`);
    out(`     message: ${event.message.slice(0, 400)}`);
  }
  if (event.type === "phase") out(`   · phase: ${event.label}`);
  if (event.type === "tool_start") out(`   → ${event.name}: ${event.summary}`);
  if (event.type === "tool_end") {
    out(`   ${event.ok ? "✓" : "✗"} ${event.name}: ${event.detail.replace(/\s+/g, " ").slice(0, 110)}`);
  }
});

const workerStarted = Date.now();
let result;
try {
  result = await session.send(scenario.prompt, AbortSignal.timeout(300_000));
} catch (err) {
  out("");
  out(`   ✗ send() THREW: ${(err as Error).name}: ${(err as Error).message}`);
  out((err as Error).stack?.split("\n").slice(0, 8).join("\n") ?? "");
  throw err;
}
const workerMs = Date.now() - workerStarted;
lastTermination = result.reason;
workerCalls = result.modelCalls;

out("");
out(`reason       : ${result.reason}`);
out(`steps        : ${result.steps}   modelCalls: ${result.modelCalls}   toolCalls: ${result.toolCalls}`);
out(`latency      : ${workerMs}ms`);
out(`files now    : ${(await readdir(root, { recursive: true }).catch(() => [])).join(", ")}`);

// --- actions ---------------------------------------------------------------
section("ACTIONS");
const ledger = actionLedger(recorded);
for (const a of ledger) {
  out(
    `   ${a.actionId.padEnd(12)} ${a.toolName.padEnd(16)} ${a.state.padEnd(10)} ` +
      `executed=${String(a.executed).padEnd(5)} model=${a.modelId ?? "-"}`,
  );
}
const summary = summarizeActions(ledger);
out(`summary      : ${JSON.stringify(summary)}`);

// --- verified result -------------------------------------------------------
section("VERIFIED RESULT");
const task = reduceTask(recorded, "live");
if (task === null) out("no task ledger");
else {
  out(`requirements : ${task.requirements.map((r) => `${r.description}=${r.status}`).join(" | ") || "(none)"}`);
  out(`evidence     : ${task.evidence.length} item(s)`);
  out(`open issues  : ${task.issues.length}`);
}
out(`answer       : ${result.summary.slice(0, 400)}`);

// --- extraction omission ---------------------------------------------------
section("EXTRACTION");
const promptForbids = /하지\s*마|말고|않고|없이/.test(scenario.prompt);
out(`prompt contains a prohibition : ${promptForbids}`);
out(`constraints recorded          : ${contract.constraints.length}`);
out(
  `omission suspected            : ${
    promptForbids && contract.constraints.length === 0 ? "YES — the request forbids something the contract does not carry" : "no"
  }`,
);

// --- replay ----------------------------------------------------------------
section("REPLAY");
const turn = {
  ...completedTurn({
    id: turnId,
    startedAt: Date.now(),
    completedAt: Date.now(),
    events: recorded,
    messageDelta: session.history() as never,
    reason: (lastTermination ?? "finished") as never,
  }),
  parentTurnId: null,
};
const file = writeSession({
  version: SESSION_SCHEMA_VERSION,
  id: "live-route",
  title: scenario.id,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  turns: [turn],
  branches: [{ id: "main", name: "main", headTurnId: turnId, createdAt: 0, updatedAt: 0 }],
  checkpoints: [],
  activeBranchId: "main",
  events: [],
  messages: [],
});
const reloaded = readSession(file);
if (reloaded === null) out("REPLAY FAILED: the session did not read back");
else {
  const back = reloaded.session.events;
  out(`events written/read : ${recorded.length} / ${back.length}`);
  out(`worker recovered    : ${selectedWorkerFor(back)?.modelId ?? "-"}`);
  out(`contract recovered  : ${reduceContract(back).requirements.length} requirement(s)`);
  const ledgerBack = actionLedger(back);
  out(`action ledger match : ${JSON.stringify(summarizeActions(ledgerBack)) === JSON.stringify(summary)}`);
}

section("CALL COUNTS");
out(`bootstrap : ${interpreted.attempts} call(s), ${bootstrapMs}ms`);
out(`worker    : ${workerCalls} call(s), ${workerMs}ms`);
out(`embedding : ${shadow?.embeddingCalls ?? 0} call(s), ${shadowMs}ms`);

if (process.env["KEEP"] === undefined) await rm(root, { recursive: true, force: true });
else out(`\nkept: ${root}`);
