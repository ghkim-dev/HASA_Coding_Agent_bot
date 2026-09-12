/**
 * 목적어구의 왼쪽 경계를 표면에서 무엇이 표시하는가.
 *
 * `measureObjectSpan` 이 고정 폭 창은 양쪽으로 똑같이 틀린다는 것을 보였다. 폭을
 * 바꿔서 될 일이 아니면 남는 질문은 하나다 — **어절 하나를 보고 그것이 목적어구
 * 안인지 밖인지 말할 수 있는가.**
 *
 * 그래서 두 무리를 세운다. 목적어구 **안**에 있는 어절(머리 제외)과, 구 바로
 * **왼쪽**에 붙어 있는 어절. 각각의 마지막 형태소 태그 분포를 보면, 어떤 조사가
 * 경계를 긋고 어떤 어미가 안으로 잇는지가 숫자로 나온다.
 *
 * 태그는 세종 계열이다: JKS 주격, JKO 목적격, JKG 관형격(의), JKB 부사격(에/로),
 * JX 보조사(는/도/만), ETM 관형형 전성어미(-는/-은/-ㄹ), NNG/NNP 명사, XSN 접미사.
 *
 *   node scripts/measureObjectEdge.mjs
 */

import { readFileSync } from "node:fs";

const rows = JSON.parse(readFileSync(".arena/klue-dp.json", "utf8"));

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

/** 그 어절의 마지막 형태소 태그. */
const lastTag = (posField) => {
  const parts = posField.split("+");
  return parts[parts.length - 1] ?? "?";
};

const inside = new Map();
const leftOf = new Map();
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

for (const r of rows) {
  const { deprel, head, pos } = r;
  for (let i = 0; i < deprel.length; i += 1) {
    if (deprel[i] !== "NP_OBJ") continue;
    const span = subtree(head, i);
    if (span[span.length - 1] - span[0] + 1 !== span.length) continue;
    for (const w of span) {
      if (w === i) continue;
      bump(inside, lastTag(pos[w]));
    }
    const before = span[0] - 1;
    if (before >= 0) bump(leftOf, lastTag(pos[before]));
  }
}

const show = (title, m) => {
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  console.log(`\n${title} (${total}어절)`);
  for (const [tag, n] of [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${tag.padEnd(6)} ${String(n).padStart(5)}  ${((n / total) * 100).toFixed(1).padStart(5)}%`);
  }
};

show("목적어구 **안**의 어절 (머리 제외) — 마지막 태그", inside);
show("목적어구 바로 **왼쪽** 어절 — 마지막 태그", leftOf);

// 한 태그를 보고 안/밖을 가를 때의 정밀도. 안쪽에만 몰리는 태그가 곧 규칙이다.
console.log("\n태그별 — 안에 있을 확률");
const tags = new Set([...inside.keys(), ...leftOf.keys()]);
const scored = [...tags]
  .map((t) => {
    const i = inside.get(t) ?? 0;
    const o = leftOf.get(t) ?? 0;
    return { t, i, o, p: i / (i + o) };
  })
  .filter((x) => x.i + x.o >= 20)
  .sort((a, b) => b.p - a.p);
for (const x of scored) {
  console.log(`  ${x.t.padEnd(6)} 안 ${String(x.i).padStart(5)} · 밖 ${String(x.o).padStart(4)} → ${(x.p * 100).toFixed(1).padStart(5)}%`);
}
