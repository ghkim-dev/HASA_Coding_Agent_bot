/**
 * 출력 예산이 얼마부터 답이 존재하는가.
 *
 * `modelProposer` 는 800을 보낸다. 그 아래에서 생각을 먼저 하는 모델은 예산을
 * 생각에 다 쓰고 **빈 문자열**을 돌려주고, 빈 문자열은 "못 한다" 와 글자가 같다 —
 * 첫 스윕이 네 모델을 0/16 으로 적은 이유다.
 *
 * 800이 낮다는 것은 알려져 있고, **얼마가 맞는지는 재지 않았다.** 6000은 스윕이
 * 쓰는 값이지 측정된 값이 아니다. 이 스크립트가 그 빈칸을 채운다: 같은 사례를
 * 예산을 올려 가며 물어 모델마다 **답이 존재하기 시작하는 자리**를 찾는다.
 *
 * 답의 품질이 아니라 존재를 잰다. 품질은 `proposerSweep` 이 예산을 고정해 놓고
 * 재는 것이고, 여기서 알고 싶은 것은 그 고정값을 얼마로 둘 것인가다.
 *
 *   node --env-file-if-exists=.env scripts/budgetFloor.mjs
 *   node --env-file-if-exists=.env scripts/budgetFloor.mjs --models ax-3.1
 */
import { mkdirSync, writeFileSync } from "node:fs";

const { SYSTEM } = await import("../src/design/modelProposer.ts");
const { PROPOSER_SWEEP } = await import("../src/design/proposerCases.ts");

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

/** 800이 지금 값이므로 거기서 시작한다. 두 배씩 올려 자리를 찾는다. */
const BUDGETS = [800, 1200, 1600, 2400, 3200, 4800, 6400];

/**
 * 세 사례로 본다. 한 사례만 보면 그 문단이 짧아서 답이 나온 것인지 예산이
 * 충분해서 나온 것인지 구별되지 않는다. 가장 긴 것 셋을 고른다 — 예산이 모자라는
 * 쪽이 먼저 드러나는 자리다.
 */
const CASES = [...PROPOSER_SWEEP].sort((a, b) => b.text.length - a.text.length).slice(0, 3);

async function ask(modelId, text, maxTokens) {
  try {
    let r;
    for (let attempt = 0; attempt <= 4; attempt += 1) {
      r = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: text },
          ],
          temperature: 0,
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(300_000),
      });
      if (r.status !== 429) break;
      await r.text();
      await new Promise((res) => setTimeout(res, 3000 * (attempt + 1)));
    }
    if (!r.ok) return { kind: "거부", chars: 0 };
    const body = await r.json();
    const choice = body.choices?.[0] ?? {};
    const raw = String(choice.message?.content ?? "").trim();
    if (raw.length === 0) return { kind: choice.finish_reason === "length" ? "예산소진" : "빈답", chars: 0 };
    // 배열이 하나라도 들어 있으면 "답이 존재한다" 로 친다. 맞는지는 여기서
    // 묻지 않는다 — 그것은 `proposerSweep` 의 일이다.
    return { kind: /\[[\s\S]*\]/.test(raw) ? "배열" : "글", chars: raw.length };
  } catch {
    return { kind: "거부", chars: 0 };
  }
}

const only = argOf("--models")?.split(",").map((s) => s.trim()).filter(Boolean);
let ids = only;
if (!ids) {
  const r = await fetch(`${BASE}/models`, { headers: HEADERS });
  const all = (await r.json()).data.map((m) => m.id);
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

console.log(`모델 ${ids.length}개 · 사례 ${CASES.length}개(가장 긴 것) · 예산 ${BUDGETS.join(", ")}\n`);
console.log("모델".padEnd(22) + BUDGETS.map((b) => String(b).padStart(7)).join("") + "   바닥");
console.log("─".repeat(22 + BUDGETS.length * 7 + 8));

const rows = [];
for (const id of ids) {
  const cells = [];
  let floor = null;
  for (const budget of BUDGETS) {
    const outs = [];
    for (const c of CASES) outs.push(await ask(id, c.text, budget));
    const arrays = outs.filter((o) => o.kind === "배열").length;
    cells.push(`${arrays}/${CASES.length}`);
    if (floor === null && arrays === CASES.length) floor = budget;
  }
  rows.push({ modelId: id, cells, floor });
  console.log(
    `${id.padEnd(22)}${cells.map((c) => c.padStart(7)).join("")}   ${floor === null ? "찾지 못함" : floor}`,
  );
}

mkdirSync(".probe", { recursive: true });
writeFileSync(".probe/budgetFloor.json", JSON.stringify({ takenAt: Date.now(), budgets: BUDGETS, rows }, null, 1), "utf8");

const floors = rows.map((r) => r.floor).filter((f) => f !== null);
console.log("─".repeat(22 + BUDGETS.length * 7 + 8));
console.log(
  floors.length === 0
    ? "어느 모델도 모든 사례에서 배열을 내지 못했습니다."
    : `모든 모델이 답을 내는 가장 낮은 예산: ${Math.max(...floors)} (바닥을 못 찾은 모델 ${rows.length - floors.length}개)`,
);
