import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CheckSchema,
  JudgeConfigSchema,
  RefineConfigSchema,
  type ArenaEvent,
  type CandidateArtifacts,
  type Check,
  type JudgeConfig,
  type RunResult,
} from "../protocol/index.ts";
import { clientFromEnv } from "../hasa-client/client.ts";
import { createLogger, nullLogger } from "../hasa-client/logger.ts";
import { CodeRunManager } from "../core/codeRunManager.ts";
import { EventHub } from "../core/events.ts";
import { ModelRegistry } from "../core/registry.ts";
import { RunManager } from "../core/runManager.ts";
import { Scheduler } from "../core/scheduler.ts";
import { Store } from "../core/store.ts";
import { GitRepo } from "../core/git.ts";

/**
 * One-shot command line for running a comparison.
 *
 * Exists because the HTTP API, while the right integration surface for the VS
 * Code extension, is a poor way to *try* the system: it asks the user to hand-
 * assemble JSON and poll for completion before they have seen it work once.
 * This runs the same orchestrator in-process and prints the outcome.
 */

const USAGE = `
pnpm arena — run one comparison and print the result

  pnpm arena compare --models <a,b> --judge <c> --prompt "<task>"
  pnpm arena compare --models <a,b> --judge <c> --prompt "<task>" --code \\
      --repo <path> --test "pnpm test" --accept

  pnpm arena models          자격이 확인된 모델 목록

Options
  --models <a,b>     후보 모델 (2개 이상, 쉼표 구분). 필수
  --judge <id>       judge 모델. 후보와 달라야 한다. 필수
  --prompt <text>    모든 후보에게 동일하게 전달되는 과제. 필수
  --prompt-file <p>  --prompt 대신 파일에서 읽기
  --code             코드 모드 (git worktree 격리). 기본은 응답 비교
  --repo <path>      코드 모드의 저장소 루트. 기본값은 현재 디렉터리
  --runtime <r>      agent | patch (기본 agent)
  --test "<cmd>"     acceptance 명령. 여러 번 지정 가능
  --accept           바로 앞의 --test 를 acceptance 로 표시 (기본은 regression)
  --scope <a,b>      쓰기 허용 경로
  --require <a,b>    응답이 반드시 포함해야 할 문구 (객관 검사, 사다리 S0)
  --forbid <a,b>     응답에 있으면 안 되는 문구
  --max-words <n>    응답 길이 상한 (단어)
  --ensemble <a,b>   판정이 갈렸을 때 의견을 물을 추가 judge 모델 (사다리 S3)
  --max-judge-calls  judge 호출 상한 (기본 60). 소진되면 budget_exhausted
  --critic <id>      승자를 개선해볼 비평가 모델. judge·후보와 모두 달라야 한다
  --rounds <n>       개선 라운드 상한 (기본 2). --critic 없으면 무시
  --json             결과를 JSON 으로 출력
  -h, --help

환경변수 HASA_API_KEY 필요 (.env 도 자동으로 읽는다).
모델 ID 는 하드코딩되어 있지 않다 — pnpm probe 결과에서 고른다.
`.trim();

interface Args {
  command: string;
  models: string[];
  judge: string;
  prompt: string;
  promptFile: string | null;
  code: boolean;
  repo: string;
  runtime: "agent" | "patch";
  commands: Array<{ cmd: string; args: string[]; kind: "regression" | "acceptance" }>;
  scope: string[];
  checks: Check[];
  ensemble: string[];
  maxJudgeCalls: number;
  critic: string;
  rounds: number;
  json: boolean;
  help: boolean;
}

/** Ladder settings other than these two stay at the schema's defaults. */
function judgeConfig(args: Args): JudgeConfig {
  return JudgeConfigSchema.parse({
    modelId: args.judge,
    ensemble: args.ensemble,
    maxJudgeCalls: args.maxJudgeCalls,
  });
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: argv[0] ?? "compare",
    models: [],
    judge: "",
    prompt: "",
    promptFile: null,
    code: false,
    repo: process.cwd(),
    runtime: "agent",
    commands: [],
    scope: [],
    checks: [],
    ensemble: [],
    maxJudgeCalls: 60,
    critic: "",
    rounds: 2,
    json: false,
    help: false,
  };
  for (let i = argv[0]?.startsWith("-") ? 0 : 1; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${flag} requires a value`);
      i += 1;
      return v;
    };
    switch (flag) {
      case "--models":
        args.models = next().split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--judge":
        args.judge = next();
        break;
      case "--prompt":
        args.prompt = next();
        break;
      case "--prompt-file":
        args.promptFile = next();
        break;
      case "--code":
        args.code = true;
        break;
      case "--repo":
        args.repo = resolve(next());
        break;
      case "--runtime":
        args.runtime = next() === "patch" ? "patch" : "agent";
        break;
      case "--test": {
        const parts = next().split(/\s+/).filter(Boolean);
        args.commands.push({
          cmd: parts[0] ?? "",
          args: parts.slice(1),
          kind: "regression",
        });
        break;
      }
      case "--accept": {
        const last = args.commands.at(-1);
        if (last) last.kind = "acceptance";
        break;
      }
      case "--scope":
        args.scope = next().split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--require":
        args.checks.push(
          CheckSchema.parse({ kind: "must_include", items: next().split(",").map((s) => s.trim()).filter(Boolean) }),
        );
        break;
      case "--forbid":
        args.checks.push(
          CheckSchema.parse({ kind: "must_not", items: next().split(",").map((s) => s.trim()).filter(Boolean) }),
        );
        break;
      case "--max-words":
        args.checks.push(CheckSchema.parse({ kind: "max_words", limit: Number.parseInt(next(), 10) }));
        break;
      case "--ensemble":
        args.ensemble = next().split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--critic":
        args.critic = next();
        break;
      case "--rounds":
        args.rounds = Number.parseInt(next(), 10);
        break;
      case "--max-judge-calls":
        args.maxJudgeCalls = Number.parseInt(next(), 10);
        break;
      case "--json":
        args.json = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  return args;
}

function bar(label: string, status: string): string {
  const mark =
    status === "completed" ? "OK  " : status === "running" ? "... " : status === "queued" ? "    " : "FAIL";
  return `  [${mark}] ${label}`;
}

async function listModels(): Promise<number> {
  // Scoped to the configured gateway: a matrix measured elsewhere describes
  // other software, and listing its models here would be a lie.
  const registry = await ModelRegistry.load(undefined, { baseUrl: clientFromEnv().baseUrl });
  const entries = registry.list();
  if (entries.length === 0) {
    process.stdout.write("capability matrix가 없습니다. 먼저 `pnpm probe`를 실행하세요.\n");
    return 1;
  }
  process.stdout.write(`probe: ${registry.probedAt}\n\n`);
  for (const e of entries) {
    const tags = [
      e.eligibility.responseCompare && "response",
      e.eligibility.codingAgent && "coding",
      e.eligibility.patchMode && "patch",
      e.eligibility.judge && "judge",
    ]
      .filter(Boolean)
      .join(",");
    if (tags.length === 0) continue;
    process.stdout.write(`  ${e.modelId.padEnd(26)} ${tags}\n`);
  }
  const blocked = entries.filter((e) => e.toolsDetail === "server_tool_calling_disabled");
  if (blocked.length > 0) {
    process.stdout.write(
      `\n게이트웨이가 tool calling을 막은 모델 (모델 문제 아님): ${blocked.map((b) => b.modelId).join(", ")}\n`,
    );
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help || args.command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (args.command === "models") return listModels();

  if (args.promptFile !== null) args.prompt = await readFile(args.promptFile, "utf8");
  const problems: string[] = [];
  if (args.models.length < 2) problems.push("--models 에 후보를 2개 이상 지정하세요");
  if (args.judge === "") problems.push("--judge 를 지정하세요");
  if (args.prompt.trim() === "") problems.push("--prompt 또는 --prompt-file 을 지정하세요");
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n\n${USAGE}\n`);
    return 2;
  }

  const log = createLogger("arena");
  const client = clientFromEnv();
  const store = await Store.open({ dbPath: ".arena/arena.db", artifactRoot: ".arena", logger: nullLogger });
  const hub = new EventHub();
  const scheduler = new Scheduler({ globalLimit: 4, perModelLimit: 1, logger: nullLogger });

  const seen = new Set<string>();
  const onEvent = (event: ArenaEvent): void => {
    if (args.json) return;
    if (event.type === "run.status") process.stdout.write(`run: ${event.status}\n`);
    else if (event.type === "candidate.status") {
      const key = `${event.label}:${event.status}`;
      if (!seen.has(key)) {
        seen.add(key);
        process.stdout.write(`${bar(event.label, event.status)}${event.excludedReason ? ` (${event.excludedReason})` : ""}\n`);
      }
    } else if (event.type === "gate.result") {
      process.stdout.write(`       gate ${event.gate}: ${event.passed ? "pass" : "FAIL"}\n`);
    } else if (event.type === "judge.progress") {
      process.stdout.write(`judge: ${event.pair} [${event.order}]\n`);
    }
  };

  let runId: string;
  try {
    if (args.code) {
      await GitRepo.open(args.repo);
      const codeRuns = new CodeRunManager({
        client,
        scheduler,
        store,
        hub,
        registry: await ModelRegistry.load(undefined, { baseUrl: client.baseUrl }),
        logger: log,
      });
      runId = await codeRuns.create({
        mode: "code",
        repoRoot: args.repo,
        runtimeAdapter: args.runtime,
        taskSpec: {
          prompt: args.prompt,
          systemPromptVersion: "coding-agent-v1",
          acceptanceCommands: args.commands.map((c) => ({
            gate: "test" as const,
            kind: c.kind,
            cmd: c.cmd,
            args: c.args,
            timeoutMs: 300_000,
          })),
          writeScope: args.scope,
          contextFiles: [],
          maxToolCalls: 30,
          maxCommandRuns: 20,
          candidateTimeoutMs: 900_000,
          maxCandidateRetries: 1,
        },
        candidates: args.models.map((modelId) => ({ modelId })),
        sampling: { temperature: 0.2, topP: 1, maxOutputTokens: 4096 },
        judge: judgeConfig(args),
      });
      hub.forRun(runId).subscribe(onEvent);
      await codeRuns.waitFor(runId);
      return report(store, runId, args.json, codeRuns.candidateView(runId));
    }

    const runs = new RunManager({ client, scheduler, store, hub, logger: log });
    runId = runs.create({
      mode: "response",
      taskSpec: { prompt: args.prompt, systemPromptVersion: "response-compare-v1", checks: args.checks },
      candidates: args.models.map((modelId) => ({ modelId })),
      sampling: { temperature: 0.2, topP: 1, maxOutputTokens: 2048 },
      judge: judgeConfig(args),
      ...(args.critic === ""
        ? {}
        : { refine: RefineConfigSchema.parse({ criticModelId: args.critic, maxRounds: args.rounds }) }),
    });
    hub.forRun(runId).subscribe(onEvent);
    await runs.waitFor(runId);
    return report(store, runId, args.json, runs.candidateView(runId));
  } catch (err) {
    process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    store.close();
  }
}

function report(
  store: Store,
  runId: string,
  asJson: boolean,
  candidates: Array<Record<string, unknown>>,
): number {
  const row = store.getRun(runId);
  const result = row?.result ? (JSON.parse(row.result) as RunResult) : null;

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ runId, result, candidates }, null, 2)}\n`);
    return result?.outcome === "winner" ? 0 : 1;
  }

  process.stdout.write("\n");
  for (const c of candidates) {
    const artifacts = c["changedFiles"] as string[] | undefined;
    process.stdout.write(
      `  ${String(c["label"]).padEnd(8)} ${String(c["modelId"]).padEnd(24)} ${String(c["status"]).padEnd(10)}` +
        `${c["score"] !== null && c["score"] !== undefined ? ` score ${c["score"]}` : ""}` +
        `${artifacts ? ` · ${artifacts.length} files` : ""}\n`,
    );
  }

  process.stdout.write("\n");
  if (!result) {
    process.stdout.write("결과가 기록되지 않았습니다.\n");
    return 1;
  }
  process.stdout.write(`${result.outcome === "winner" ? `winner: ${result.winnerLabel}` : "no_winner"}\n`);
  process.stdout.write(`이유: ${result.reason}\n`);
  if (result.requiresHumanReview) process.stdout.write("사람 검토가 필요합니다.\n");
  process.stdout.write(`\n산출물: .arena/runs/${runId}/\n`);
  return result.outcome === "winner" ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`${String(err)}\n`);
      process.exitCode = 1;
    });
}
