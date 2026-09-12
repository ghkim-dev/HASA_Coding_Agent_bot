/**
 * 목적어 명사구가 실제로 몇 어절인가 — 사람이 표시해 둔 정답으로.
 *
 * 우리 추출기는 동사 앞 **두 어절**을 목적어로 잡는다. 그 폭이 옳은지는 지금까지
 * 우리 말뭉치 안에서만 다퉜고, 말뭉치는 우리가 쓴 것이다. KLUE-DP 는 남이 쓴
 * 2,000문장에 의존 트리를 달아 두었으므로, 같은 질문을 우리 바깥에서 물을 수 있다.
 *
 * 목적어구 = `deprel` 이 `NP_OBJ` 인 어절 + 그것에 **이행적으로** 매달린 어절들.
 * "홍정희의 탈락에 눈물을 흘렸다" 에서 `눈물을` 이 NP_OBJ 이고 거기 매달린 것이
 * 없으면 한 어절, "이상 징후를 탐지하는 파이프라인을" 이면 셋이다.
 *
 *   node scripts/measureObjectSpan.mjs
 */

import { readFileSync } from "node:fs";

const rows = JSON.parse(readFileSync(".arena/klue-dp.json", "utf8"));

/** 그 어절에 이행적으로 매달린 어절 인덱스 전부(자기 자신 포함). */
function subtree(head, at) {
  const kids = new Map();
  for (let i = 0; i < head.length; i += 1) {
    const h = head[i] - 1;
    if (h >= 0) kids.set(h, [...(kids.get(h) ?? []), i]);
  }
  const out = [];
  const stack = [at];
  while (stack.length > 0) {
    const n = stack.pop();
    out.push(n);
    for (const k of kids.get(n) ?? []) stack.push(k);
  }
  return out.sort((a, b) => a - b);
}

const lengths = new Map();
let objects = 0;
let contiguous = 0;
/** 두 어절 창이 정답 구를 그대로 집는 경우. */
let windowExact = 0;
/** 두 어절 창이 정답의 일부만 집는 경우(잘림). */
let windowTruncated = 0;
/** 두 어절 창이 정답 밖의 어절을 끌어오는 경우(과잉). */
let windowOverreach = 0;

for (const r of rows) {
  const { deprel, head, word_form: words } = r;
  for (let i = 0; i < deprel.length; i += 1) {
    if (deprel[i] !== "NP_OBJ") continue;
    objects += 1;
    const span = subtree(head, i);
    // 연속 구간인지. 한국어 목적어구는 거의 언제나 연속이고, 아닌 것은
    // 우리 창 방식으로는 애초에 잡을 수 없는 모양이라 따로 센다.
    const isContiguous = span[span.length - 1] - span[0] + 1 === span.length;
    if (isContiguous) contiguous += 1;
    const n = span.length;
    lengths.set(n, (lengths.get(n) ?? 0) + 1);

    if (!isContiguous) continue;
    // 우리 방식의 근사: 목적어 어절에서 왼쪽으로 두 어절.
    const winStart = Math.max(0, i - 1);
    const winEnd = i;
    const trueStart = span[0];
    const trueEnd = span[span.length - 1];
    if (winStart === trueStart && winEnd === trueEnd) windowExact += 1;
    else if (winStart > trueStart) windowTruncated += 1;
    else windowOverreach += 1;
    void words;
  }
}

const pct = (n, d) => `${n}/${d} (${((n / d) * 100).toFixed(1)}%)`;

console.log(`문장 ${rows.length} · 목적어구 ${objects}개 · 연속 ${pct(contiguous, objects)}`);
console.log();
console.log("목적어구 길이(어절) 분포");
const total = [...lengths.values()].reduce((a, b) => a + b, 0);
let cum = 0;
for (const n of [...lengths.keys()].sort((a, b) => a - b)) {
  const c = lengths.get(n);
  cum += c;
  const bar = "█".repeat(Math.round((c / total) * 60));
  console.log(`  ${String(n).padStart(2)}어절  ${String(c).padStart(5)}  누적 ${((cum / total) * 100).toFixed(1).padStart(5)}%  ${bar}`);
}
console.log();
console.log("두 어절 창이 연속 목적어구를 얼마나 집는가");
console.log(`  정확히 일치 ${pct(windowExact, contiguous)}`);
console.log(`  잘림        ${pct(windowTruncated, contiguous)}`);
console.log(`  과잉        ${pct(windowOverreach, contiguous)}`);
