/**
 * Runs the proposer task against every chat model this credential reaches, and
 * scores the answers.
 *
 * This is the measurement `modelProposer` says it does not have. Its point is
 * one comparison: the designer picks **the first permitted model in catalogue
 * order**, and this asks whether catalogue order has anything to do with being
 * good at the job.
 *
 *     node --env-file-if-exists=.env scripts/proposerSweep.mjs
 *     node --env-file-if-exists=.env scripts/proposerSweep.mjs --models gpt-oss-20b,ax-3.1
 *
 * Writes `.probe/proposerSweep.json` and prints a table. The raw answers are
 * kept in that file deliberately — a score with no answer behind it cannot be
 * argued with — and `.probe/` is gitignored because those answers echo the
 * corpus and would otherwise outlive the run that produced them.
 */
import { writeFileSync, mkdirSync } from "node:fs";

const { SYSTEM } = await import("../src/design/modelProposer.ts");
const { scoreProposerCase, scoreProposer, rankByMeasurement } = await import(
  "../src/design/proposerMetrics.ts"
);
const { PROPOSER_CASES, PROPOSER_SWEEP, PROPOSER_WANTS } = await import(
  "../src/design/proposerCases.ts"
);

const BASE = process.env.HASA_BASE_URL ?? "https://open.hasa.re.kr/v1";
const KEY = process.env.HASA_API_KEY;
if (!KEY) {
  console.error("HASA_API_KEY 가 없습니다. .env 를 확인하십시오.");
  process.exit(2);
}
const HEADERS = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1];
};
const only = argOf("--models")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
/** Kept low on purpose. A sweep is not a load test on someone else's gateway. */
const POOL = Number(argOf("--pool") ?? 3);
/**
 * 6000, not the 800 `modelProposer` ships.
 *
 * At 1200 four models in this catalogue returned an empty string on every
 * case, and the first sweep wrote that down as 0/16 — a claim about the budget
 * printed as a claim about the models. They think first and the budget runs
 * out before they write. So the sweep asks at a budget that lets an answer
 * exist, reports truncation separately, and `--max-tokens 800` reproduces what
 * the shipped proposer would actually get.
 */
const MAX_TOKENS = Number(argOf("--max-tokens") ?? 6000);

/**
 * The catalogue, in the order the gateway returns it.
 *
 * NOT sorted. The order is the measured thing — `chooseProposerModel` takes the
 * first permitted entry, so re-sorting here would destroy the comparison this
 * script exists to make.
 */
async function catalogue() {
  const r = await fetch(`${BASE}/models`, { headers: HEADERS });
  if (!r.ok) throw new Error(`GET /models ${r.status}`);
  return (await r.json()).data.map((m) => m.id);
}

/** Answers chat, or does not. Asked rather than guessed from the id. */
async function answersChat(modelId) {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "ok" }], max_tokens: 4 }),
  });
  await r.text();
  return r.status !== 404;
}

/**
 * One case, one model.
 *
 * Returns `null` for "no answer came back" rather than an empty string, because
 * a refused call and a model that replied with nothing are different findings
 * and `scoreProposer` counts them in different places.
 */
/**
 * The gateway allows four calls at once and answers 429 past that.
 *
 * A 429 arrives as "no answer" and would be counted as `unanswered`, which
 * reads as a fact about the model. It is a fact about how many things were
 * running. So it waits and asks again, and only a refusal that survives the
 * wait is recorded.
 */
async function askOnce(modelId, testCase) {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: testCase.text },
      ],
      temperature: 0,
      max_tokens: MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(300_000),
  });
  return r;
}

async function ask(modelId, testCase) {
  try {
    let r = await askOnce(modelId, testCase);
    for (let attempt = 1; attempt <= 4 && r.status === 429; attempt += 1) {
      await r.text();
      await new Promise((res) => setTimeout(res, 3000 * attempt));
      r = await askOnce(modelId, testCase);
    }
    if (!r.ok) return { raw: null, note: `HTTP ${r.status}`, truncated: false };
    const body = await r.json();
    const choice = body.choices?.[0] ?? {};
    return {
      raw: String(choice.message?.content ?? ""),
      note: null,
      // 예산이 모자라 잘린 답과 못 쓴 답은 다르다. 같은 빈 문자열로 도착하므로
      // 여기서 갈라 두지 않으면 뒤에서는 영영 구분할 수 없다.
      truncated: choice.finish_reason === "length",
    };
  } catch (err) {
    return { raw: null, note: String(err).replace(/\s+/g, " ").slice(0, 90), truncated: false };
  }
}

async function sweepModel(modelId) {
  const outcomes = [];
  const answers = [];
  let unanswered = 0;
  let truncated = 0;
  for (const testCase of PROPOSER_SWEEP) {
    const answer = await ask(modelId, testCase);
    answers.push({ turnId: testCase.turnId, ...answer });
    if (answer.truncated) truncated += 1;
    if (answer.raw === null) {
      unanswered += 1;
      continue;
    }
    outcomes.push(scoreProposerCase({ testCase, raw: answer.raw }));
  }
  return {
    score: scoreProposer({ modelId, outcomes, wantsTotal: PROPOSER_WANTS, unanswered, truncated }),
    answers,
  };
}

/** A fixed-size pool, so the gateway sees a few calls at a time and not 18. */
async function pooled(items, size, run) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await run(items[i], i);
      }
    }),
  );
  return out;
}

const pct = (r) => (r.value === null ? "  —  " : `${String(Math.round(r.value * 100)).padStart(3)}%`);
const frac = (r) => `${r.hit}/${r.of}`;

const ids = await catalogue();
const chatIds = [];
for (const id of only ?? ids) {
  if (only !== null && !ids.includes(id)) {
    console.error(`카탈로그에 없는 모델: ${id}`);
    process.exit(2);
  }
  if (await answersChat(id)) chatIds.push(id);
}

console.log(
  `카탈로그 ${ids.length}개 중 대화형 ${chatIds.length}개 · 사례 ${PROPOSER_CASES.length} · 요구 ${PROPOSER_WANTS} · 출력 예산 ${MAX_TOKENS} 토큰 (배포본은 800)\n`,
);

const results = await pooled(chatIds, POOL, async (id) => {
  const r = await sweepModel(id);
  const s = r.score;
  console.log(
    `  ${id.padEnd(26)} 읽음 ${frac(s.named).padEnd(7)} 지목 ${frac(s.pointed).padEnd(7)} 지어냄 ${frac(s.invented).padEnd(7)} 형식 ${frac(s.shape).padEnd(7)} 무응답 ${s.unanswered} 잘림 ${s.truncated}`,
  );
  return r;
});

const measurement = {
  prompt: SYSTEM,
  takenAt: Date.now(),
  baseUrl: BASE,
  cases: PROPOSER_CASES.length,
  wants: PROPOSER_WANTS,
  maxTokens: MAX_TOKENS,
  scores: results.map((r) => r.score),
};

const measured = rankByMeasurement(measurement);
const chosen = chatIds[0];

console.log(`\n=== 순위 (읽음 ↓, 지어냄 ↑, 지목 ↓, 형식 ↓) ===`);
console.log("   #  모델                         읽음          지목         지어냄 옮겨적음 형식  무응답 잘림");
measured.forEach((id, i) => {
  const s = measurement.scores.find((x) => x.modelId === id);
  console.log(
    `  ${String(i + 1).padStart(2)}  ${id.padEnd(26)} ${pct(s.named)} ${frac(s.named).padEnd(7)} ` +
      `${pct(s.pointed)} ${frac(s.pointed).padEnd(7)} ${pct(s.invented)} ${pct(s.transcribed)}  ` +
      `${pct(s.shape)} ${String(s.unanswered).padStart(4)} ${String(s.truncated).padStart(4)}`,
  );
});

console.log(`\n=== 설계기의 선택과 대조 ===`);
console.log(`  설계기가 고르는 모델 (카탈로그 첫 대화형): ${chosen}`);
console.log(`  실측 1위                                 : ${measured[0]}`);
console.log(`  설계기 선택의 실측 순위                  : ${measured.indexOf(chosen) + 1} / ${measured.length}`);

mkdirSync(".probe", { recursive: true });
writeFileSync(
  ".probe/proposerSweep.json",
  `${JSON.stringify({ measurement, catalogueOrder: chatIds, measuredOrder: measured, answers: results.map((r) => r.answers) }, null, 1)}\n`,
);
console.log(`\n.probe/proposerSweep.json 에 원답변까지 기록했습니다.`);
console.log(
  `kind·priority·polarity 는 수집만 하고 채점하지 않습니다 — 이 말뭉치에 그 골드가 없습니다.`,
);
