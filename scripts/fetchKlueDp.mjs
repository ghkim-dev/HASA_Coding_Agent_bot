/**
 * KLUE-DP 검증셋을 내려받아 `.arena/klue-dp.json` 에 둔다.
 *
 * 목적어 명사구가 실제로 몇 어절인지를 우리 말뭉치 24문장이 아니라 수천 문장으로
 * 재기 위한 것이다. `deprel` 이 `NP_OBJ`/`NP_MOD` 를 달고 `head` 가 의존 트리를
 * 주므로, 동사가 거느린 목적어구의 경계가 사람 손으로 표시되어 있다.
 *
 * `.arena` 는 gitignore 대상이다 — 남의 데이터셋을 이 저장소에 복사해 두지 않는다.
 *
 *   node scripts/fetchKlueDp.mjs [행수]
 */

import { mkdirSync, writeFileSync } from "node:fs";

const WANT = Number(process.argv[2] ?? 3000);
const OUT = ".arena/klue-dp.json";
const BASE =
  "https://datasets-server.huggingface.co/rows?dataset=klue%2Fklue&config=dp&split=validation";

const rows = [];
let offset = 0;
while (rows.length < WANT) {
  const length = Math.min(100, WANT - rows.length);
  const res = await fetch(`${BASE}&offset=${offset}&length=${length}`);
  if (!res.ok) {
    console.error(`HTTP ${res.status} at offset ${offset}`);
    break;
  }
  const body = await res.json();
  const batch = body.rows ?? [];
  if (batch.length === 0) break;
  for (const r of batch) rows.push(r.row);
  offset += batch.length;
  process.stdout.write(`\r받는 중 ${rows.length}`);
}

mkdirSync(".arena", { recursive: true });
writeFileSync(OUT, JSON.stringify(rows), "utf8");
console.log(`\n${rows.length}문장 → ${OUT}`);
