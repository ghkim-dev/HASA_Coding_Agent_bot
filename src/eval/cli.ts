import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SCENARIOS, scenarioById } from "./scenarios.ts";
import { liveModels, referenceModels } from "./models.ts";
import { serializeSweep, sweep, type ModelUnderTest } from "./sweep.ts";
import { renderBreakdown, renderScoreboard } from "./report.ts";
import { evaluationEvidence } from "./evidence.ts";
import { buildEvidenceFile, saveEvidence } from "../router/evaluationStore.ts";

/**
 * `pnpm eval:agent`
 *
 * Reference models by default; `--live` asks the configured gateway what it has
 * and compares those instead. There is no model name in this file, and there is
 * no fallback that invents one: if the gateway cannot be reached the sweep says
 * so and runs nothing, because a row for a model nobody called would look like
 * a measurement.
 *
 *   pnpm eval:agent
 *   pnpm eval:agent --live --runs 3
 *   pnpm eval:agent --scenario S05-no-execute
 *   pnpm eval:agent --json out/eval.json
 */

interface Args {
  scenario?: string;
  runs: number;
  live: boolean;
  models: number;
  json?: string;
  evidence?: string;
  breakdown: boolean;
}

function parse(argv: readonly string[]): Args {
  const args: Args = { runs: 1, live: false, models: 3, breakdown: true };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--scenario" && value !== undefined) args.scenario = value;
    else if (flag === "--runs" && value !== undefined) args.runs = Math.max(1, Number(value) || 1);
    else if (flag === "--models" && value !== undefined) args.models = Math.max(1, Number(value) || 3);
    else if (flag === "--json" && value !== undefined) args.json = value;
    else if (flag === "--evidence" && value !== undefined) args.evidence = value;
    else if (flag === "--live") args.live = true;
    else if (flag === "--quiet") args.breakdown = false;
  }
  return args;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parse(argv);
  const scenarios = args.scenario === undefined ? SCENARIOS : [scenarioById(args.scenario)].filter((s) => s !== undefined);
  if (scenarios.length === 0) {
    process.stdout.write(`No such scenario: ${args.scenario}\n`);
    return 2;
  }

  let models: ModelUnderTest[] = referenceModels();
  let conversability: ReadonlyMap<string, boolean> = new Map();
  let note = "MODE: controlled (reference models only)";
  if (args.live) {
    const live = await liveModels({ limit: args.models });
    if (live.unavailable !== null) {
      // Said plainly and once. Not "0 models scored", not an empty table with a
      // footnote — a run that did not happen.
      process.stdout.write(`\nLIVE MODEL EVAL: NOT RUN — ${live.unavailable}\n\n`);
      note = `MODE: controlled (live requested, unavailable: ${live.unavailable})`;
    } else {
      models = live.models;
      conversability = live.conversability;
      note = `MODE: controlled world, live models — ${live.models.map((m) => m.id).join(", ")}`;
    }
  }

  process.stdout.write(`${note}\n`);
  process.stdout.write(`${scenarios.length} scenarios × ${models.length} models × ${args.runs} runs\n\n`);

  const result = await sweep({
    scenarios,
    models,
    runs: args.runs,
    onProgress: (line) => process.stderr.write(`  ${line}\n`),
  });

  process.stdout.write(`${renderScoreboard(result.summaries)}\n\n`);

  if (result.harnessFailures.length === 0) {
    process.stdout.write("HARNESS INVARIANT FAILURES: none\n");
  } else {
    process.stdout.write(`HARNESS INVARIANT FAILURES: ${result.harnessFailures.length}\n`);
    for (const failure of result.harnessFailures) {
      process.stdout.write(`  ${failure.scenario.id} · ${failure.metrics.model} · ${failure.harness.join(",")}\n`);
    }
  }

  if (args.breakdown) {
    for (const summary of result.summaries) {
      process.stdout.write(
        `\n${renderBreakdown(
          summary.model,
          result.results.filter((r) => r.metrics.model === summary.model),
        )}\n`,
      );
    }
  }

  for (const skipped of result.skipped) {
    process.stdout.write(`\nSKIPPED ${skipped.model}: ${skipped.reason}\n`);
  }

  if (args.json !== undefined) {
    await writeFile(args.json, serializeSweep(result), "utf8");
    process.stdout.write(`\nWrote ${args.json}\n`);
  }

  // The numbers a recommendation ranks on, written where the router looks.
  //
  // Only from a live sweep. The reference models are calibration fixtures with
  // hand-written behaviour, and `buildRegistry` refuses them by name anyway —
  // but writing an evidence file full of them would produce a file that looks
  // like a measurement of the gateway and is not one.
  if (args.evidence !== undefined) {
    if (!args.live) {
      process.stdout.write("\nNo evidence written: --evidence needs --live. Reference models are not model data.\n");
    } else {
      const measured = evaluationEvidence(result.results, new Date(result.startedAt).toISOString());
      const { file, refused } = buildEvidenceFile({
        measuredAt: new Date(result.startedAt).toISOString(),
        baseUrl: process.env["HASA_BASE_URL"] ?? "",
        scenarioIds: scenarios.map((s) => s.id),
        runsPerCell: args.runs,
        summaries: measured,
        conversability,
      });
      await saveEvidence(file, args.evidence);
      for (const drop of refused) {
        process.stdout.write(`\nREFUSED ${drop.modelId}: ${drop.reason}\n`);
      }
      process.stdout.write(
        `\nWrote evidence for ${file.summaries.length} model(s) to ${args.evidence}\n`,
      );
      for (const summary of file.summaries) {
        const numbers = Object.entries(summary.sampleCounts ?? {})
          .map(([k, n]) => `${k}=${String(summary.metrics[k as keyof typeof summary.metrics])}(n${n})`)
          .join(" ");
        process.stdout.write(`  ${summary.modelId.padEnd(28)} ${numbers}\n`);
      }
    }
  }

  // A harness invariant failure fails the command. A model scoring badly does
  // not — that is a measurement, and the whole point of taking it.
  return result.harnessFailures.length > 0 ? 1 : 0;
}

// `pathToFileURL`, not string concatenation. On Windows `argv[1]` is a drive
// path and a URL for it needs three slashes, so the hand-built form never
// matched and the command printed nothing at all.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err: Error) => {
      process.stderr.write(`${err.stack ?? err.message}\n`);
      process.exit(2);
    },
  );
}
