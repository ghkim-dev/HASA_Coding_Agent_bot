/**
 * Three ways to pick the proposer model, on one corpus, side by side.
 *
 *     node scripts/roleAssign.mjs
 *
 * The question is whether routing a *role* to a *measured* model beats what the
 * designer does now. It needs three columns, not two, because there are two
 * things wrong with the current pick and only one of them is the algorithm:
 *
 *     A  카탈로그 순서   what `chooseProposerModel` does — first permitted model
 *     B  라우터 · 선언   the router, on the evidence this gateway actually has
 *     C  라우터 · 실측   the router, on evidence from `proposerSweep`
 *
 * B is the column that matters for honesty. If the router with `declared`
 * constants picks as badly as catalogue order, then swapping in the router is
 * not the improvement — the *evidence* is, and saying so keeps the credit where
 * it belongs.
 *
 * Reads the two sweeps this repo produces at different output budgets. It does
 * not call the gateway: every number here was measured by `proposerSweep` and
 * this only re-reads it, so the comparison is reproducible without a key.
 */
import { readFileSync, existsSync } from "node:fs";

const { evidenceFrom, starvedAt, indistinguishable } = await import(
  "../src/design/proposerEvidence.ts"
);
const { recommendModel } = await import("../src/router/recommend.ts");
const { profileOf } = await import("../src/design/recommendationCases.ts");

const LOW = ".probe/final800.json";
const HIGH = ".probe/final6000.json";
for (const file of [LOW, HIGH]) {
  if (existsSync(file)) continue;
  console.error(
    `${file} 이 없습니다. 먼저 실측을 돌리십시오:\n` +
      `  node --env-file-if-exists=.env scripts/proposerSweep.mjs --max-tokens 6000\n` +
      `  node --env-file-if-exists=.env scripts/proposerSweep.mjs --max-tokens 800`,
  );
  process.exit(2);
}

const load = (file) => JSON.parse(readFileSync(file, "utf8"));
const low = load(LOW);
const high = load(HIGH);
const evidence = evidenceFrom([low.measurement, high.measurement]);
/** Catalogue order, as the gateway returns it — the thing strategy A rides on. */
const catalogue = high.catalogueOrder;
const scoreOf = new Map(high.measurement.scores.map((s) => [s.modelId, s]));
const lowScoreOf = new Map(low.measurement.scores.map((s) => [s.modelId, s]));

/**
 * The proposer task, as demands.
 *
 * Written here rather than projected from a contract because the proposer task
 * is not a user request — it is a fixed job the designer does on every turn,
 * and its demands are what `modelProposer.SYSTEM` asks for: ground every
 * candidate in the source, and emit exactly the shape specified.
 */
const zero = {
  coding: 0, debugging: 0, reasoning: 0, architecture: 0, codeReview: 0,
  toolUse: 0, commandExecution: 0, webResearch: 0, sourceGrounding: 0,
  instructionFollowing: 0, recovery: 0, multiTurnContinuity: 0,
};
const TASK = {
  id: "proposer-task",
  demands: { ...zero, sourceGrounding: 1, instructionFollowing: 0.8, reasoning: 0.3 },
  priorities: { quality: 1, speed: 0.2, cost: 0.2 },
  complexity: "medium",
  contextDemand: "small",
  constraints: {},
  semanticDescription: "요청 문단에서 요구사항 후보와 그 근거 구간을 찾아 JSON 배열로 낸다",
  provenance: { lastTurnId: "t1", requirementIds: [], constraintKinds: [] },
};

/**
 * What `modelRegistry` gives an unevaluated gateway.
 *
 * Every chat model gets the same two declared constants, because the registry
 * derives them from boolean capability flags and every chat model on this
 * gateway carries the same flags. That is not a strawman — it is what column B
 * is for, and the tie it produces is the point.
 */
const declaredProfiles = catalogue.map((id) =>
  profileOf({ id, declared: { reasoning: 0.75 }, samples: 0 }),
);

/** The same models, carrying what the sweep measured. */
const measuredProfiles = evidence.map((e) => {
  const declared = { reasoning: 0.75 };
  const strong = {};
  for (const [key, m] of Object.entries(e.capabilities)) {
    if (m.origin === "harness_eval") strong[key] = m.value;
    else declared[key] = m.value;
  }
  return profileOf({ id: e.modelId, declared, strong, samples: e.samples });
});

const pct = (r) => (r?.value === null || r?.value === undefined ? "  — " : `${String(Math.round(r.value * 100)).padStart(3)}%`);

function report(label, modelId, note) {
  const s = scoreOf.get(modelId);
  const l = lowScoreOf.get(modelId);
  console.log(`\n  ${label}`);
  console.log(`    고른 모델   ${modelId ?? "(없음)"}${note ? `  ${note}` : ""}`);
  if (s === undefined) {
    console.log(`    실측        없음 — 이 모델은 스윕에 없습니다`);
    return;
  }
  console.log(
    `    6000토큰    읽음 ${String(s.named.hit).padStart(2)}/${s.named.of}` +
      `  지목 ${String(s.pointed.hit).padStart(2)}/${s.pointed.of}` +
      `  지어냄 ${pct(s.invented)}  형식 ${pct(s.shape)}`,
  );
  console.log(
    `    800토큰     읽음 ${String(l?.named.hit ?? 0).padStart(2)}/${l?.named.of ?? 0}` +
      `  잘림 ${l?.truncated ?? "?"}/10${l?.shape.hit === 0 ? "   ← 배포 예산에서 아무것도 못 냄" : ""}`,
  );
}

console.log(`역할 배정 비교 · 사례 ${high.measurement.cases} · 요구 ${high.measurement.wants} · 후보 ${catalogue.length}`);
console.log("=".repeat(78));

// --- A ---------------------------------------------------------------------
const pickA = catalogue[0];
report("A  카탈로그 순서 (현재 chooseProposerModel)", pickA, "— 순위를 매기지 않음");

// --- B ---------------------------------------------------------------------
const recB = await recommendModel(TASK, declaredProfiles);
report(
  "B  라우터 · 선언 증거만",
  recB.selected?.modelId,
  recB.tiedWith?.length ? `— ${recB.tiedWith.length + 1}개 동점, 정렬 순서가 정함` : "",
);

// --- C ---------------------------------------------------------------------
const recC = await recommendModel(TASK, measuredProfiles);
report(
  "C  라우터 · 실측 증거",
  recC.selected?.modelId,
  recC.tiedWith?.length ? `— ${recC.tiedWith.length + 1}개 동점` : "",
);

if (recC.selected !== null) {
  console.log(`\n    왜 이 모델인가`);
  for (const r of recC.reasons.slice(0, 4)) {
    console.log(`      · ${typeof r === "string" ? r : JSON.stringify(r)}`);
  }
  console.log(`\n    다음 후보`);
  for (const alt of recC.alternatives.slice(0, 4)) {
    const s = scoreOf.get(alt.modelId);
    console.log(
      `      ${alt.modelId.padEnd(24)} 점수 ${alt.score.toFixed(3)}` +
        `  읽음 ${s?.named.hit ?? "?"}/${s?.named.of ?? "?"}`,
    );
  }
}

// --- D ---------------------------------------------------------------------
// 배포 예산에서 굶는 모델을 후보에서 빼고 다시 고른다. 이것이 「모델 추천과
// 하네스 설계는 한 결정」이라는 주장을 코드로 말하는 자리다.
const HARNESS_BUDGET = 800;
const starvedIds = starvedAt(HARNESS_BUDGET, evidence).map((s) => s.modelId);
const recD = await recommendModel(
  { ...TASK, constraints: { forbiddenModels: starvedIds } },
  measuredProfiles,
);
report(
  `D  라우터 · 실측 증거 + 하네스 예산 ${HARNESS_BUDGET}토큰 제약`,
  recD.selected?.modelId,
  `— ${starvedIds.length}개 후보 제외`,
);

// --- 말뭉치가 가를 수 없는 것 -------------------------------------------------
console.log(`\n${"=".repeat(78)}`);
const tied = indistinguishable(evidence);
console.log(`이 말뭉치가 갈라내지 못하는 상위 후보`);
for (const e of tied) {
  const g = e.capabilities.sourceGrounding;
  console.log(
    `  ${e.modelId.padEnd(24)} 근거 ${g.value.toFixed(3)}  ±${e.resolution.toFixed(3)}` +
      `  예산바닥 ${e.budget.tokens ?? "없음"}`,
  );
}
console.log(
  `\n  ${tied.length}개가 표준오차 안에 있습니다. C의 1위는 A·B보다 확실히 낫지만,` +
    `\n  C 안에서의 순위는 사례 ${high.measurement.cases}개·요구 ${high.measurement.wants}개로는 정해지지 않습니다.` +
    `\n  라우터는 samples 를 동점 깨기에만 쓰고 동점 폭을 넓히지 않으므로, 이 사실은` +
    `\n  추천 안에 들어가지 않고 여기서만 보입니다.`,
);

// --- 예산 -------------------------------------------------------------------
console.log(`\n${"=".repeat(78)}`);
console.log(`배포 예산(800토큰)에서 굶는 모델`);
const starved = starvedAt(800, evidence);
if (starved.length === 0) {
  console.log(`  없음`);
} else {
  for (const s of starved) {
    console.log(
      `  ${s.modelId.padEnd(24)} ${s.needs === null ? `측정한 어느 예산에서도 못 냄 (${s.measured.join("·")})` : `${s.needs}토큰 이상 필요`}`,
    );
  }
}
console.log(
  `\n  ${starved.length}/${evidence.length} 개가 배포 예산에서 아무것도 내지 못합니다.` +
    ` 모델만 고르고 예산을 말하지 않는 추천은 이들에게 빈 문자열을 받게 합니다.`,
);
