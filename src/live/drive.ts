import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHasaProvider } from "../provider/hasa/createProvider.ts";
import { createModelFor } from "../agent/hasaModel.ts";
import { AgentSession } from "../agent/session.ts";
import { allowingApprovalPort } from "../agent/approval.ts";
import { TurnRecorder } from "../agent/sessionRecorder.ts";
import { reduceTask } from "../agent/taskReducer.ts";
import { describeTask } from "../agent/taskState.ts";
import { requirementsView } from "../agent/requirementsView.ts";
import {
  describeViolations, safeFallback, taskDisposition, validateFinalClaims,
} from "../agent/finalClaims.ts";
import type { SessionEvent } from "../agent/sessionEvents.ts";
import type { AgentEvent } from "../agent/types.ts";

/**
 * One real turn, against a real model, in a real workspace.
 *
 * Not a test and not part of `pnpm test`: it costs money, needs a credential,
 * and a model is not deterministic. It exists because the controlled evaluator
 * cannot see everything. `src/eval` drives the production session with fake
 * models, and fake models hand back `NormalizedToolCall` objects — so the
 * protocol adapter, the one piece between a real model and the runtime, was the
 * only part of the pipeline nothing exercised. Four defects were sitting there,
 * and all four were found by running this.
 *
 *   node --env-file-if-exists=.env src/live/drive.ts <model> <text|native> "<prompt>" [steps]
 *
 * The key is read from the environment and never written anywhere. The
 * workspace is a temporary directory, removed unless `KEEP` is set.
 */

const modelId = process.argv[2] ?? "exaone-4.0-32b";
const protocol = (process.argv[3] ?? "text") as "text" | "native";
const prompt = process.argv[4] ?? "개와 고양이를 분류하는 모델을 학습하고 추론한 성능을 비교해줘. CNN부터 Transformer 모델에 이르기까지 다양한 모델들에 대해서 만들어줘.";
const steps = Number(process.argv[5] ?? 10);

const provider = createHasaProvider({
  apiKey: process.env["HASA_API_KEY"] ?? "",
  ...(process.env["HASA_BASE_URL"] ? { baseUrl: process.env["HASA_BASE_URL"] } : {}),
});
const root = await mkdtemp(join(tmpdir(), "hasa-live-"));
const recorded: SessionEvent[] = [];
const recorder = new TurnRecorder({ turnId: "t0" });
recorder.userMessage(prompt).forEach((e) => recorded.push(e));

let lastTermination: string | undefined;
const session = await AgentSession.open({
  workspaceRoot: root,
  model: createModelFor({ provider, modelId, toolProtocol: protocol, maxOutputTokens: 4096 }),
  approvalPort: allowingApprovalPort,
  approvalMode: "auto",
  logger: {
    debug: () => {},
    info: (m, f) => process.stdout.write(`  [info] ${m} ${f ? JSON.stringify(f) : ""}
`),
    warn: (m, f) => process.stdout.write(`  [warn] ${m} ${f ? JSON.stringify(f) : ""}
`),
    error: (m, f) => process.stdout.write(`  [error] ${m} ${f ? JSON.stringify(f) : ""}
`),
    child() { return this; },
  },
  mode: "code",
  commands: [
    { gate: "run", kind: "regression", cmd: "python", args: ["--version"], timeoutMs: 60_000 },
    { gate: "test", kind: "regression", cmd: "python", args: ["-m", "pytest"], timeoutMs: 120_000 },
  ],
  budget: { maxSteps: steps, timeoutMs: 240_000 },
  taskRecord: () => {
    const task = reduceTask(recorded, "live");
    return task === null || task.requirements.length + task.issues.length === 0 ? null : describeTask(task);
  },
  taskComplete: () => taskDisposition(reduceTask(recorded, "live"), lastTermination) === "completed",
  finalClaims: {
    validate: (text) => {
      const task = reduceTask(recorded, "live");
      const v = validateFinalClaims({ task, disposition: taskDisposition(task, lastTermination), text });
      return v.valid ? null : describeViolations(v.violations);
    },
    fallback: () => {
      const task = reduceTask(recorded, "live");
      return safeFallback(task, taskDisposition(task, lastTermination), lastTermination);
    },
  },
});

const seen: AgentEvent[] = [];
session.setEventSink((event) => {
  seen.push(event);
  recorder.record(event).forEach((e) => recorded.push(e));
  if (event.type === "tool_start") process.stdout.write(`  → ${event.name}: ${event.summary}\n`);
  if (event.type === "tool_end") {
    process.stdout.write(`  ${event.ok ? "✓" : "✗"} ${event.name}: ${event.detail.replace(/\s+/g, " ").slice(0, 150)}\n`);
  }
  if (event.type === "contract") {
    const c = event.contract as { relation: string; requirements: unknown[] };
    process.stdout.write(`  ⊙ contract: relation=${c.relation} requirements=${c.requirements.length}\n`);
  }
  if (event.type === "plan") process.stdout.write(`  ⊞ plan: ${event.steps.join(" / ")}\n`);
});

process.stdout.write(`\nmodel=${modelId} protocol=${protocol} workspace=${root}\n\n`);
const started = Date.now();
const result = await session.send(prompt, AbortSignal.timeout(300_000));
lastTermination = result.reason;

process.stdout.write(`\n--- reason=${result.reason} steps=${result.steps} modelCalls=${result.modelCalls} toolCalls=${result.toolCalls} repairs=${result.claimRepairs} fallback=${result.safeFallback ?? false} ${Math.round((Date.now()-started)/1000)}s\n`);
process.stdout.write(`--- files: ${(await readdir(root, { recursive: true }).catch(() => [])).join(", ") || "(none)"}\n`);
process.stdout.write(`--- answer:\n${result.summary}\n`);

// The panel's own projection, printed so the visual half can be checked
// against a real turn rather than only against fixtures.
const view = requirementsView(reduceTask(recorded, "live"), session.taskContract, result.reason);
if (view !== null) {
  process.stdout.write(`
--- panel: ${view.goal} · ${view.done}/${view.total} · ${view.disposition}
`);
  const mark = { done: "✓", in_progress: "○", failed: "✗", unplanned: "!" };
  for (const r of view.requirements) {
    const via = r.step !== undefined && r.step !== r.text ? `  → ${r.step}` : r.progress === "unplanned" ? "  → 계획에 아직 없습니다" : "";
    process.stdout.write(`      ${mark[r.progress]} ${r.text}${via}
`);
  }
  for (const c of view.constraints) process.stdout.write(`      ⊘ ${c.text}${c.enforced ? " (강제)" : ""}
`);
  for (const s2 of view.sources) process.stdout.write(`      ⌾ ${s2.url} · ${s2.status}
`);
}

const task = reduceTask(recorded, "live");
if (task !== null) {
  process.stdout.write(`--- disposition: ${taskDisposition(task, result.reason)}\n`);
  process.stdout.write(`--- requirements: ${task.requirements.map((r) => `${r.description}=${r.status}`).join(" | ") || "(none)"}\n`);
}
if (process.env["KEEP"] === undefined) await rm(root, { recursive: true, force: true }).catch(() => {});
else process.stdout.write(`--- kept: ${root}
`);
