import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CapabilityMatrix, CapabilityName, ModelReport } from "../protocol/index.ts";
import { HasaClient, DEFAULT_BASE_URL } from "../hasa-client/client.ts";
import { HasaError } from "../hasa-client/errors.ts";
import { createLogger, type Logger } from "../hasa-client/logger.ts";
import { registerSecret } from "../hasa-client/redact.ts";
import { runProbes } from "./runner.ts";
import { SERVER_TOOLING_DISABLED_CODE } from "./probes.ts";
import { startMockHasa } from "../testing/mock-hasa.ts";

interface Args {
  models: string[] | null;
  deep: boolean;
  vision: boolean;
  mock: boolean;
  out: string;
  baseUrl: string | null;
  concurrency: number;
  timeoutMs: number;
  help: boolean;
}

const USAGE = `
pnpm probe — HASA capability probe

  --models <a,b>       Probe only these model ids (default: every id from GET /v1/models)
  --deep               Include slow probes (long_context, seed)
  --vision             Include the vision probe
  --mock               Run against an in-process mock gateway (no key, no network)
  --json <path>        Output path (default: .arena/capability-matrix.json)
  --base-url <url>     Override HASA_BASE_URL
  --concurrency <n>    Models probed in parallel (default: 2)
  --timeout <ms>       Per-request timeout (default: 120000)
  -h, --help           Show this

Environment:
  HASA_API_KEY         Required unless --mock. Never hardcode or commit this.
  HASA_BASE_URL        Defaults to ${DEFAULT_BASE_URL}
  HASA_MODELS          Comma-separated fallback for --models

Model ids are never hardcoded: they come from --models, HASA_MODELS, or the
live GET /v1/models response.
`.trim();

export const REAL_MATRIX_PATH = ".arena/capability-matrix.json";
/**
 * Mock results go somewhere else, and that is not tidiness.
 *
 * A synthetic run writes model ids that exist only in `testing/mock-hasa.ts`.
 * Landing them on the real path means the Arena's model picker offers
 * `mock/full` against the live gateway, every candidate 403s, and the run ends
 * `no_winner` for a reason that has nothing to do with any model. It happened.
 */
export const MOCK_MATRIX_PATH = ".arena/capability-matrix.mock.json";

function parseArgs(argv: string[]): Args {
  const args: Args = {
    models: null,
    deep: false,
    vision: false,
    mock: false,
    out: REAL_MATRIX_PATH,
    baseUrl: null,
    concurrency: 2,
    timeoutMs: 120_000,
    help: false,
  };
  let outWasGiven = false;
  for (let i = 0; i < argv.length; i += 1) {
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
      case "--deep":
        args.deep = true;
        break;
      case "--vision":
        args.vision = true;
        break;
      case "--mock":
        args.mock = true;
        break;
      case "--json":
        args.out = next();
        outWasGiven = true;
        break;
      case "--base-url":
        args.baseUrl = next();
        break;
      case "--concurrency":
        args.concurrency = Number(next());
        break;
      case "--timeout":
        args.timeoutMs = Number(next());
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  // A synthetic run must not land on the path everything else reads. An
  // explicit `--json` still wins: someone who names a file has said where.
  if (args.mock && !outWasGiven) args.out = MOCK_MATRIX_PATH;
  return args;
}

const SUMMARY_COLUMNS: CapabilityName[] = [
  "chat",
  "stream",
  "tools",
  "tools_roundtrip",
  "json_object",
  "max_output",
];

const MARK: Record<string, string> = {
  pass: "PASS",
  fail: "FAIL",
  denied: "403",
  unknown: "?",
  skipped: "-",
};

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}

function renderSummary(matrix: CapabilityMatrix): string {
  const idWidth = Math.max(8, ...matrix.models.map((m) => m.modelId.length));
  const header = [pad("model", idWidth), ...SUMMARY_COLUMNS.map((c) => pad(c, 16)), "eligible"].join(" ");
  const rows = matrix.models.map((m) => {
    const cells = SUMMARY_COLUMNS.map((c) => pad(MARK[m.capabilities[c]?.status ?? "unknown"] ?? "?", 16));
    const eligible: string[] = [];
    if (m.eligibility.responseCompare) eligible.push("response");
    if (m.eligibility.codingAgent) eligible.push("coding");
    if (m.eligibility.patchMode) eligible.push("patch");
    if (m.eligibility.judge) eligible.push("judge");
    return [pad(m.modelId, idWidth), ...cells, eligible.join(",") || "none"].join(" ");
  });
  return [header, "-".repeat(header.length), ...rows].join("\n");
}

function renderFailures(models: ModelReport[]): string {
  const lines: string[] = [];
  for (const m of models) {
    const problems = Object.entries(m.capabilities)
      .filter(([, r]) => r.status === "fail" || r.status === "denied" || r.status === "unknown")
      .map(([name, r]) => `    ${name}: ${r.status}${r.httpStatus ? ` (${r.httpStatus})` : ""} — ${r.evidence ?? "no detail"}`);
    if (problems.length === 0) continue;
    lines.push(`  ${m.modelId}`);
    lines.push(...problems);
  }
  return lines.length === 0 ? "  (none)" : lines.join("\n");
}

/**
 * PowerShell splits an unquoted `--models a,b,c` on the commas and rejoins the
 * pieces with spaces, so the probe receives one absurd model id and reports a
 * confusing 403. Catch it here rather than letting it look like a permissions
 * problem.
 */
function assertUsableModelIds(models: string[]): void {
  const malformed = models.filter((m) => /\s/.test(m));
  if (malformed.length === 0) return;
  throw new Error(
    `model id contains whitespace: ${JSON.stringify(malformed[0])}\n` +
      "Quote the list so the shell does not split it:\n" +
      '  PowerShell:  pnpm probe --models "a,b,c"\n' +
      "  bash:        pnpm probe --models a,b,c",
  );
}

/**
 * The same id, named once.
 *
 * Both sources can repeat one. `--models a,a` is a typo; a catalogue that lists
 * the same model twice is a gateway misconfiguration, and the live gateway did
 * exactly that on 2026-08-03 — `GET /v1/models` answered 22 records for 21
 * models, `wan2.2-i2v` twice.
 *
 * Probing the repeat is not merely redundant. It spends real inference requests
 * to overwrite an answer with itself, and the duplicate then reaches the matrix,
 * where it gives one model two rows in the summary and inflates the denominator
 * of "12/22 usable" — a count that should have read 12/21.
 *
 * Reported rather than silently corrected, for the reason in
 * `src/provider/hasa/hasaModelRegistry.ts`: the only person who can repair a
 * duplicated catalogue is the operator, and they cannot repair what no one says.
 */
export function dedupeModelIds(ids: readonly string[]): { ids: string[]; duplicated: string[] } {
  const seen = new Set<string>();
  const out: string[] = [];
  const duplicated: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      if (!duplicated.includes(id)) duplicated.push(id);
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return { ids: out, duplicated };
}

async function resolveModels(args: Args, client: HasaClient, log: Logger): Promise<string[]> {
  const requested = await (async (): Promise<string[]> => {
    if (args.models && args.models.length > 0) {
      assertUsableModelIds(args.models);
      return args.models;
    }
    const fromEnv = (process.env["HASA_MODELS"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (fromEnv.length > 0) {
      assertUsableModelIds(fromEnv);
      return fromEnv;
    }
    return client.listModels();
  })();

  const { ids, duplicated } = dedupeModelIds(requested);
  if (duplicated.length > 0) {
    log.warn("a model was listed more than once; probing it once", {
      received: requested.length,
      probing: ids.length,
      duplicated,
    });
  }
  return ids;
}

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${String(err instanceof Error ? err.message : err)}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const log = createLogger("probe");
  let apiKey = process.env["HASA_API_KEY"] ?? "";
  let baseUrl = args.baseUrl ?? process.env["HASA_BASE_URL"] ?? DEFAULT_BASE_URL;
  let closeMock: (() => Promise<void>) | null = null;

  if (args.mock) {
    // Deliberately varied: one healthy tool-calling model, one that ignores
    // tools, one the key cannot access, one that rate-limits first.
    const mock = await startMockHasa({
      models: [
        { id: "mock/full", tools: "native", multiTool: true, jsonObject: true, jsonSchema: true, maxTokensLimit: 16384 },
        { id: "mock/no-tools", tools: "none", jsonObject: true, maxTokensLimit: 8192 },
        { id: "mock/forbidden", behavior: "forbidden" },
        { id: "mock/flaky", behavior: "rate_limit_once", tools: "none", jsonObject: true, maxTokensLimit: 4096 },
      ],
    });
    apiKey = mock.apiKey;
    baseUrl = mock.url;
    closeMock = mock.close;
    log.warn("running against the in-process mock gateway — results are synthetic");
  }

  if (!apiKey) {
    process.stderr.write(
      "HASA_API_KEY is not set.\n" +
        "  PowerShell:  $env:HASA_API_KEY = '<key>'\n" +
        "  bash:        export HASA_API_KEY='<key>'\n" +
        "Or run `pnpm probe --mock` to exercise the probe without a key.\n",
    );
    return 2;
  }
  registerSecret(apiKey);

  const client = new HasaClient({
    apiKey,
    baseUrl,
    timeoutMs: args.timeoutMs,
    logger: log.child("client"),
  });

  try {
    const models = await resolveModels(args, client, log);
    if (models.length === 0) {
      process.stderr.write("no models to probe\n");
      return 1;
    }
    log.info("probing", { models: models.length, baseUrl });

    const matrix = await runProbes({
      client,
      apiKey,
      log,
      models,
      deep: args.deep,
      optIn: args.vision ? (["vision"] as CapabilityName[]) : [],
      concurrency: args.concurrency,
    });

    const outPath = resolve(process.cwd(), args.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");

    process.stdout.write(`\n${renderSummary(matrix)}\n`);
    process.stdout.write(`\nFailures and exclusions:\n${renderFailures(matrix.models)}\n`);
    process.stdout.write(`\nmatrix written to ${outPath}\n`);

    const usable = matrix.models.filter((m) => m.eligibility.responseCompare).length;
    const coding = matrix.models.filter((m) => m.eligibility.codingAgent).length;
    process.stdout.write(
      `\n${usable}/${matrix.models.length} usable for response compare, ${coding} for coding-agent mode\n`,
    );
    if (coding < 2) {
      process.stdout.write(
        "\nNOTE: fewer than 2 models support native tool calling. Phase 2 must run in patch-mode.\n",
      );
    }

    // Separated from ordinary capability failures because this one is fixable
    // by the gateway operator rather than by choosing a different model.
    const serverBlocked = matrix.models.filter(
      (m) => m.capabilities["tools"]?.errorCode === SERVER_TOOLING_DISABLED_CODE,
    );
    if (serverBlocked.length > 0) {
      process.stdout.write(
        `\nOPERATOR ACTION: ${serverBlocked.length} model(s) rejected every tool_choice because the gateway\n` +
          `was not started with --tool-call-parser / --enable-auto-tool-choice:\n` +
          serverBlocked.map((m) => `  - ${m.modelId}\n`).join("") +
          `These models are not tool-incapable; the deployment disables tool calling.\n`,
      );
    }
    return 0;
  } catch (err) {
    if (err instanceof HasaError && err.kind === "auth") {
      process.stderr.write("401 Unauthorized — the API key is missing or invalid. Aborting.\n");
      return 3;
    }
    log.error("probe failed", { error: err });
    return 1;
  } finally {
    await closeMock?.();
  }
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
