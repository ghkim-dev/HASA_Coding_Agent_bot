import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Runs every fixture twice — once offline, once with a real model — and reports
 * the two separately.
 *
 * Separately on purpose. The offline half is what holds when the model is
 * wrong, and averaging the two would report the floor and the model's
 * contribution as one number. Fifteen fixtures cannot establish a model's
 * quality; what they can show is where the engine leaves things undecided and
 * what it refuses.
 */

const { previewDesign } = await import("../src/design/preview.ts");
const { measurePreviews, renderMetrics } = await import("../src/design/previewMetrics.ts");
const { createModelProposer } = await import("../src/design/modelProposer.ts");

const DIR = "examples/design-preview";
const files = (await readdir(DIR)).filter((f) => f.endsWith(".json")).sort();

const turnsOf = async (file) => {
  const parsed = JSON.parse(await readFile(join(DIR, file), "utf8"));
  return parsed.turns;
};

const lines = [];
const say = (s = "") => {
  lines.push(s);
  process.stdout.write(`${s}\n`);
};

say(`fixtures : ${files.length}`);
say("");

// --- offline -----------------------------------------------------------------

const offline = [];
for (const file of files) offline.push(await previewDesign({ turns: await turnsOf(file) }));
say(renderMetrics(measurePreviews(offline)));
say("");

// --- model -------------------------------------------------------------------

const apiKey = process.env["HASA_API_KEY"] ?? "";
const baseUrl = process.env["HASA_BASE_URL"] ?? "";

if (apiKey.trim().length === 0) {
  say("모델 경로 : HASA_API_KEY 없음 — 실행하지 않음");
} else {
  let propose = null;
  let setup = null;
  try {
    propose = await createModelProposer({ apiKey, baseUrl });
  } catch (err) {
    setup = err instanceof Error ? err.message : String(err);
  }

  if (propose === null) {
    say(`모델 경로 : 사용할 수 없음 — ${setup}`);
  } else {
    const withModel = [];
    const perCase = [];
    for (const file of files) {
      const result = await previewDesign({ turns: await turnsOf(file), propose });
      withModel.push(result);
      perCase.push({
        file,
        accepted: result.requirements.filter((s) => s.derivedBy === "model_proposal").length,
        rejected: result.rejected.length,
        outcomes: result.proposals.perTurn.map((t) => t.outcome),
        calls: result.proposals.calls,
        error: result.proposals.error,
      });
    }
    say(renderMetrics(measurePreviews(withModel)));
    say("");
    // The four ways a proposal fails, counted. One bucket said "the model
    // contributed nothing" and each of these is fixed somewhere else.
    const tally = {};
    for (const row of perCase) for (const o of row.outcomes) tally[o] = (tally[o] ?? 0) + 1;
    say("제안 결과 분포 (턴 단위)");
    say("-".repeat(60));
    for (const [k, v] of Object.entries(tally).sort()) say(`  ${k.padEnd(22)} ${v}`);
    say("");
    say("사례별 모델 제안 처리");
    say("-".repeat(72));
    for (const row of perCase) {
      say(
        `  ${row.file.replace(".json", "").padEnd(32)} ${row.outcomes.join(",").padEnd(20)} 수용 ${row.accepted}  거부 ${row.rejected}  호출 ${row.calls}` +
          (row.error === null ? "" : `  실패 ${row.error}`),
      );
    }
  }
}

const out = process.argv[2];
if (out !== undefined) await writeFile(out, `${lines.join("\n")}\n`, "utf8");
