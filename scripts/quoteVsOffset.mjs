/**
 * 모델에게 **글자 위치를 세게 할 것인가, 인용하게 할 것인가.**
 *
 * 지금 제안자 프롬프트는 근거 구간의 `start`/`end` 를 숫자로 요구하고 원문을 옮겨
 * 적는 것을 금지한다. 그것은 LLM 이 가장 못 하는 일 — 글자 세기 — 을 시키는 것이고,
 * 이 저장소가 쓰는 `pointed`(좌표가 맞은 비율) 축이 낮은 이유의 후보다.
 *
 * 반대쪽은 이렇다: 모델에게 원문에서 그대로 베낀 **인용문**을 받고, 위치는 런타임이
 * 찾는다. 지어낸 인용은 원문에 없으므로 그 자리에서 걸리고, 두 번 나오는 인용은
 * 어디를 가리키는지 모르므로 역시 걸린다 — `buildProposerCase` 가 이미 같은 검사를
 * 한다. 즉 위치를 숫자로 받아야만 얻을 수 있는 안전은 없다.
 *
 * 두 팔을 같은 모델·같은 사례·같은 채점기로 돌린다. B팔은 인용문을 좌표로 바꾼 뒤
 * 채점하므로, 인용문이 원문에 없거나 두 번 나오면 좌표가 없는 제안이 되어 A팔의
 * 틀린 좌표와 같은 방식으로 떨어진다.
 *
 *   node --env-file-if-exists=.env scripts/quoteVsOffset.mjs
 *   node --env-file-if-exists=.env scripts/quoteVsOffset.mjs --models exaone-4.0-32b,gpt-oss-20b
 */
import { mkdirSync, writeFileSync } from "node:fs";

const { SYSTEM } = await import("../src/design/modelProposer.ts");
const { scoreProposerCase, scoreProposer } = await import("../src/design/proposerMetrics.ts");
const { PROPOSER_SWEEP, PROPOSER_WANTS } = await import("../src/design/proposerCases.ts");

const BASE = process.env.HASA_BASE_URL ?? "https://open.hasa.re.kr/v1";
const KEY = process.env.HASA_API_KEY;
if (!KEY) {
  console.error("HASA_API_KEY 가 없습니다.");
  process.exit(2);
}
const HEADERS = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1];
};
const MAX_TOKENS = Number(argOf("--max-tokens") ?? 6000);

/**
 * B팔의 프롬프트. A팔과 다른 것은 근거를 어떻게 지목하느냐 **하나뿐**이다.
 *
 * 나머지 필드와 금지 사항은 글자까지 같게 두었다 — 두 프롬프트가 여러 군데
 * 다르면 차이가 어디서 왔는지 말할 수 없다.
 */
const SYSTEM_QUOTE = SYSTEM.replace(
  "요청 원문에서 근거가 되는 구간의 위치만 지목하고, 그 구간의 글자를 옮겨 적지 마십시오.",
  "각 요구사항의 근거가 되는 구간은 요청 원문에서 글자 그대로 베껴 적으십시오.",
)
  .replace("  start     요청 원문에서 근거 구간의 시작 위치 (0부터)\n", "")
  .replace(
    "  end       근거 구간의 끝 위치 (끝 글자 다음)",
    "  quote     근거가 되는 구간을 요청 원문에서 그대로 베낀 것",
  );

/**
 * C팔 — 좌표와 인용을 **둘 다** 요구한다.
 *
 * A/B 는 한 모델(exaone)이 반대로 움직였다. 인용을 요구하자 빈 배열을 돌려주고,
 * 좌표로는 19% 를 맞춘다. 나머지 셋은 정반대다. 형식을 하나로 고정하면 어느 쪽을
 * 골라도 누군가는 손해이므로, 둘 다 받아 두고 **런타임이 인용을 우선**하되 인용이
 * 없거나 못 찾으면 좌표로 떨어지는 쪽을 잰다.
 *
 * 이것이 A·B 어느 쪽보다도 낫다면 모델별 형식 선택 같은 기계는 필요 없다.
 */
const SYSTEM_BOTH = SYSTEM.replace(
  "요청 원문에서 근거가 되는 구간의 위치만 지목하고, 그 구간의 글자를 옮겨 적지 마십시오.",
  "각 요구사항의 근거가 되는 구간을 원문에서 글자 그대로 베껴 `quote` 에 넣고, 그 구간의 위치도 함께 적으십시오.",
).replace(
  "  end       근거 구간의 끝 위치 (끝 글자 다음)",
  "  end       근거 구간의 끝 위치 (끝 글자 다음)\n  quote     근거가 되는 구간을 요청 원문에서 그대로 베낀 것",
);

async function askOnce(modelId, system, text) {
  return fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
      temperature: 0,
      max_tokens: MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(300_000),
  });
}

async function ask(modelId, system, text) {
  try {
    let r = await askOnce(modelId, system, text);
    for (let attempt = 1; attempt <= 4 && r.status === 429; attempt += 1) {
      await r.text();
      await new Promise((res) => setTimeout(res, 3000 * attempt));
      r = await askOnce(modelId, system, text);
    }
    if (!r.ok) return { raw: null, truncated: false };
    const body = await r.json();
    const choice = body.choices?.[0] ?? {};
    return {
      raw: String(choice.message?.content ?? ""),
      truncated: choice.finish_reason === "length",
    };
  } catch {
    return { raw: null, truncated: false };
  }
}

/**
 * 인용문을 좌표로 바꾼다. 못 바꾸면 좌표 없이 남겨 둔다.
 *
 * 원문에 없으면 지어낸 것이고, 두 번 나오면 어디인지 모른다. 둘 다 그 제안의
 * 좌표를 비우는 쪽으로 처리한다 — A팔의 틀린 좌표와 같은 자리에서 떨어지게
 * 하려는 것이고, 이쪽만 살려 주면 비교가 아니다.
 */
function quotesToOffsets(raw, text, keepOffsets = false) {
  let parsed;
  try {
    const m = /\[[\s\S]*\]/.exec(raw);
    parsed = JSON.parse(m ? m[0] : raw);
  } catch {
    return { raw, located: 0, missing: 0, ambiguous: 0 };
  }
  if (!Array.isArray(parsed)) return { raw, located: 0, missing: 0, ambiguous: 0 };
  let located = 0;
  let missing = 0;
  let ambiguous = 0;
  const out = parsed.map((p) => {
    if (typeof p !== "object" || p === null) return p;
    const quote = typeof p.quote === "string" ? p.quote.trim() : null;
    const { quote: _drop, ...rest } = p;
    // `keepOffsets` 는 C팔이다. 인용이 자리를 못 잡으면 모델이 준 좌표가 남고,
    // 그것이 이 팔의 요점이다 — 둘 중 되는 쪽을 쓴다.
    const fallback = keepOffsets ? rest : { ...rest, start: undefined, end: undefined };
    if (quote === null || quote.length === 0) {
      missing += 1;
      return fallback;
    }
    const first = text.indexOf(quote);
    if (first === -1) {
      missing += 1;
      return fallback;
    }
    if (text.indexOf(quote, first + 1) !== -1) {
      ambiguous += 1;
      return fallback;
    }
    located += 1;
    return { ...rest, start: first, end: first + quote.length };
  });
  return { raw: JSON.stringify(out), located, missing, ambiguous };
}

async function arm(modelId, system, convert, keepOffsets = false) {
  const outcomes = [];
  let unanswered = 0;
  let truncated = 0;
  const located = { ok: 0, missing: 0, ambiguous: 0 };
  for (const testCase of PROPOSER_SWEEP) {
    const answer = await ask(modelId, system, testCase.text);
    if (answer.truncated) truncated += 1;
    if (answer.raw === null) {
      unanswered += 1;
      continue;
    }
    let raw = answer.raw;
    if (convert) {
      const c = quotesToOffsets(answer.raw, testCase.text, keepOffsets);
      raw = c.raw;
      located.ok += c.located;
      located.missing += c.missing;
      located.ambiguous += c.ambiguous;
    }
    outcomes.push(scoreProposerCase({ testCase, raw }));
  }
  return {
    score: scoreProposer({ modelId, outcomes, wantsTotal: PROPOSER_WANTS, unanswered, truncated }),
    located,
  };
}

const only = argOf("--models")?.split(",").map((s) => s.trim()).filter(Boolean);
let ids = only;
if (!ids) {
  const r = await fetch(`${BASE}/models`, { headers: HEADERS });
  const all = (await r.json()).data.map((m) => m.id);
  // 채팅에 답하는 것만. 임베딩·이미지 모델에 이 과제를 물을 이유가 없다.
  const probes = await Promise.all(
    all.map(async (id) => {
      const p = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ model: id, messages: [{ role: "user", content: "ok" }], max_tokens: 4 }),
      });
      await p.text();
      return p.ok ? id : null;
    }),
  );
  ids = probes.filter(Boolean);
}
console.log(`모델 ${ids.length}개 · 사례 ${PROPOSER_SWEEP.length} · 원하는 것 ${PROPOSER_WANTS} · 예산 ${MAX_TOKENS}\n`);

const pct = (r) => (r.value === null ? "  —  " : `${String(Math.round(r.value * 100)).padStart(3)}%`);
const rows = [];
console.log(
  "모델".padEnd(22) + " │ " + "A 좌표만".padEnd(23) + " │ " + "B 인용만".padEnd(23) + " │ C 둘 다",
);
console.log("".padEnd(22) + " │ shape named point inv │ shape named point inv │ shape named point inv  찾음/없음/모호");
console.log("─".repeat(120));
for (const id of ids) {
  const a = await arm(id, SYSTEM, false);
  const b = await arm(id, SYSTEM_QUOTE, true);
  const c = await arm(id, SYSTEM_BOTH, true, true);
  rows.push({ modelId: id, a: a.score, b: b.score, c: c.score, located: b.located, locatedC: c.located });
  const cell = (s) => `${pct(s.shape)} ${pct(s.named)} ${pct(s.pointed)} ${pct(s.invented)}`;
  console.log(
    `${id.padEnd(22)} │ ${cell(a.score)} │ ${cell(b.score)} │ ${cell(c.score)}  ${c.located.ok}/${c.located.missing}/${c.located.ambiguous}`,
  );
}

mkdirSync(".probe", { recursive: true });
writeFileSync(".probe/quoteVsOffset.json", JSON.stringify({ takenAt: Date.now(), maxTokens: MAX_TOKENS, rows }, null, 1), "utf8");

const sum = (pick) => rows.reduce((acc, r) => ({ hit: acc.hit + pick(r).hit, of: acc.of + pick(r).of }), { hit: 0, of: 0 });
const show = (label, x) => `${label} ${x.hit}/${x.of} (${x.of === 0 ? "—" : Math.round((x.hit / x.of) * 100) + "%"})`;
console.log("─".repeat(120));
for (const [label, pick] of [["A", (r) => r.a], ["B", (r) => r.b], ["C", (r) => r.c]]) {
  console.log(
    `합계 ${label}  ${show("pointed", sum((r) => pick(r).pointed))} · ${show("named", sum((r) => pick(r).named))} · ${show("shape", sum((r) => pick(r).shape))}`,
  );
}
