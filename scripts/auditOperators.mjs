/**
 * Which operators no test defends.
 *
 *     node scripts/auditOperators.mjs src/design/*.ts
 *     node scripts/auditOperators.mjs --count src/design/*.ts src/router/*.ts
 *
 * `mutate.mjs` runs 313 mutations somebody chose. This runs every one there is:
 * each `===`/`!==`, `>=`/`>`, `<=`/`<`, `&&`/`||` outside comments and strings
 * is flipped in turn, and a mutation the suite still passes is a place the
 * tests do not defend.
 *
 * Two phases, because the honest check is slow. A candidate is first filtered
 * against the file's paired test — fast, and it kills most of them — and only
 * survivors are re-run against the **whole** suite. A mutation another file
 * catches is not a hole, and reporting it as one would send someone to write a
 * test that already exists.
 *
 * ## Run it in a worktree
 *
 * This edits source files and restores them. An interrupted run leaves a
 * mutation behind, and that is not hypothetical: one rode into a commit before
 * this warning was written. Use a throwaway worktree so the real tree cannot be
 * touched at all:
 *
 *     git worktree add ../audit-wt HEAD
 *     cd ../audit-wt && node scripts/auditOperators.mjs src/design/*.ts
 *
 * ## Survivors are not all defects
 *
 * Some are equivalent mutants — a flip that cannot change behaviour, so no test
 * can kill it. `proposerMetrics.ts` carries one at its `indexOf(..., first + 1)
 * >= 0`, documented at the line for exactly this reason. Read each survivor
 * before writing a test for it; the ones worth closing are the ones where the
 * flipped code would do something different and nobody would notice.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** 구문을 깨지 않는 치환만. 주석·문자열 안은 건드리지 않는다. */
const OPERATORS = [
  [/ === /g, " !== ", "==="],
  [/ !== /g, " === ", "!=="],
  [/ >= /g, " > ", ">="],
  [/ <= /g, " < ", "<="],
  [/ && /g, " || ", "&&"],
  [/ \|\| /g, " && ", "||"],
];

/** 주석과 문자열 리터럴 구간을 가려낸다. 그 안의 `===` 는 코드가 아니다. */
function maskedRanges(text) {
  const ranges = [];
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === "//") {
      const end = text.indexOf("\n", i);
      ranges.push([i, end === -1 ? text.length : end]);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      ranges.push([i, end === -1 ? text.length : end + 2]);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && !(text[j] === c && text[j - 1] !== "\\")) j += 1;
      ranges.push([i, j + 1]);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return ranges;
}

const inMask = (ranges, at) => ranges.some(([a, b]) => at >= a && at < b);

export function sitesIn(text) {
  const mask = maskedRanges(text);
  const out = [];
  for (const [re, to, label] of OPERATORS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (inMask(mask, m.index)) continue;
      out.push({ at: m.index, len: m[0].length, to, label, line: text.slice(0, m.index).split("\n").length });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

const args = process.argv.slice(2);
const countOnly = args.includes("--count");
/**
 * Test files are never targets.
 *
 * A glob like `src/design/*.ts` sweeps them in, and mutating a test asks
 * nothing worth knowing: the suite changing when you change the suite is not a
 * finding. Worse, a test file has no *paired* test, so every one of its sites
 * skipped the cheap filter and went straight to the full-suite phase — a run
 * that spent most of its budget on candidates that meant nothing.
 */
const targets = args
  .filter((a) => !a.startsWith("--"))
  .filter((a) => !/\.(test|fuzz\.test)\.ts$/.test(a));

if (countOnly) {
  let total = 0;
  for (const file of targets) {
    const n = sitesIn(readFileSync(file, "utf8")).length;
    total += n;
    console.log(`${String(n).padStart(4)}  ${file}`);
  }
  console.log(`합계 ${total}자리`);
  process.exit(0);
}

function testFileFor(source) {
  const t = source.replace(/\.ts$/, ".test.ts");
  return existsSync(t) ? t : null;
}

function verdict(tests) {
  let out;
  try {
    out = execFileSync("node", ["--test", ...tests], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  const pass = /^ℹ pass (\d+)$/m.exec(out);
  const fail = /^ℹ fail (\d+)$/m.exec(out);
  const cancelled = /^ℹ cancelled (\d+)$/m.exec(out);
  return { pass: Number(pass?.[1] ?? 0), fail: Number(fail?.[1] ?? 0) + Number(cancelled?.[1] ?? 0) };
}

/** 전체 스위트. 느리므로 1단계를 살아남은 변이에만 쓴다. */
const FULL = ["src/**/*.test.ts", "extension/**/*.test.ts"];

const candidates = [];
let applied = 0;

// --- 1단계: 짝 시험으로 빠르게 거른다 -----------------------------------------
for (const file of targets) {
  const paired = testFileFor(file);
  const original = readFileSync(file, "utf8");
  const sites = sitesIn(original);
  if (sites.length === 0) continue;

  // 짝 시험이 없으면 1단계를 건너뛰고 전부 2단계로 넘긴다 — 「시험 파일이 없다」
  // 는 이유로 감사에서 빠지면, 가장 안 지켜지는 파일이 가장 조용해진다.
  if (paired === null) {
    for (const s of sites) candidates.push({ file, ...s, phase1: "짝 시험 없음" });
    console.log(`${file}  자리 ${sites.length}개  → 짝 시험 없음, 전부 2단계로`);
    continue;
  }
  const base = verdict([paired]);
  if (base.fail !== 0) {
    console.log(`${file}: 기준선이 이미 빨갛다 — 건너뜀`);
    continue;
  }
  process.stdout.write(`${file}  자리 ${sites.length}개  `);
  let killed = 0;
  try {
    for (const s of sites) {
      writeFileSync(file, original.slice(0, s.at) + s.to + original.slice(s.at + s.len), "utf8");
      applied += 1;
      if (verdict([paired]).fail > 0) { killed += 1; process.stdout.write("."); }
      else { candidates.push({ file, ...s, phase1: "짝 시험 통과" }); process.stdout.write("S"); }
    }
  } finally {
    writeFileSync(file, original, "utf8");
  }
  console.log(`  잡음 ${killed}/${sites.length}`);
}

console.log(`\n1단계: ${applied}개 적용 · ${candidates.length}개가 짝 시험을 통과했다`);
console.log(`2단계: 그 ${candidates.length}개를 전체 스위트로 확증한다 (느림)\n`);

// --- 2단계: 다른 파일이 잡는지 확인한다 ---------------------------------------
const survivors = [];
const byFile = new Map();
for (const c of candidates) {
  if (!byFile.has(c.file)) byFile.set(c.file, readFileSync(c.file, "utf8"));
}
try {
  for (const [i, c] of candidates.entries()) {
    const original = byFile.get(c.file);
    writeFileSync(c.file, original.slice(0, c.at) + c.to + original.slice(c.at + c.len), "utf8");
    const r = verdict(FULL);
    writeFileSync(c.file, original, "utf8");
    const alive = r.fail === 0;
    if (alive) survivors.push(c);
    console.log(
      `  [${String(i + 1).padStart(3)}/${candidates.length}] ${c.file}:${c.line} ${c.label}→${c.to.trim()}` +
        `  ${alive ? "살아남음" : `다른 시험이 잡음 (fail ${r.fail})`}`,
    );
  }
} finally {
  for (const [file, text] of byFile) writeFileSync(file, text, "utf8");
}

console.log(`\n=== 최종: 전체 스위트를 뚫고 살아남은 변이 ${survivors.length}개 ===`);
for (const s of survivors) console.log(`  ${s.file}:${s.line}  ${s.label} → ${s.to.trim()}  (${s.phase1})`);
