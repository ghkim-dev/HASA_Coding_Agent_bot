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
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
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

/**
 * How long one suite run may take before the mutation is presumed to hang.
 *
 * Flipping `<` to `<=` in a loop condition, or `&&` to `||` in a `while`, makes
 * code that never terminates. Without a timeout the child never exits, the
 * parent blocks on it forever, and the sweep stops dead with no output — which
 * is exactly what happened: two runs sat for over six hours at 0.3 seconds of
 * CPU, looking like slow progress rather than a hang.
 */
const RUN_TIMEOUT_MS = 120_000;

/**
 * Where the run says it is still alive.
 *
 * "Is it running?" was asked repeatedly during the first full sweep and could
 * not be answered from the artifacts: `process.stdout.write(".")` buffers when
 * redirected, so the log froze while work continued. Falling back to inspecting
 * the process list produced the opposite error — a liveness probe that returned
 * empty was read as "the process is gone", and a healthy run was declared dead
 * and a second one started on top of it.
 *
 * So the run states its own progress, unbuffered, on every step. A stale
 * timestamp means stopped; a moving one means working. Nobody has to guess from
 * a process table again.
 */
const HEARTBEAT = ".audit-operators-progress.json";

function beat(phase, done, total, detail) {
  try {
    writeFileSync(
      HEARTBEAT,
      `${JSON.stringify({ phase, done, total, detail, at: new Date().toISOString() }, null, 1)}\n`,
      "utf8",
    );
  } catch {
    // 진행 표시를 못 썼다고 감사를 멈추지는 않는다.
  }
}


function verdict(tests) {
  let out;
  let timedOut = false;
  try {
    out = execFileSync("node", ["--test", ...tests], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    // A killed child is a hang, not a verdict about assertions. Counted as
    // caught — a mutation that makes the suite never finish is not one that
    // slipped past it — but marked so a reader is not told a test failed.
    if (err.killed === true || err.signal !== null && err.signal !== undefined) timedOut = true;
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  if (timedOut) return { pass: 0, fail: 1, timedOut: true };
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
      beat("1단계", applied, null, `${file}:${s.line}`);
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
/**
 * Verdicts already reached, so a killed run does not start over.
 *
 * This tool has died mid-run three times — twice hung on a mutation with no
 * timeout, once killed outright at candidate 479 of 577 — and each death threw
 * away hours because everything lived in memory. Each verdict is now appended
 * as it is decided, and a restart skips what the file already holds.
 *
 * Keyed by file, line and operator: the same candidate re-derived from the same
 * source produces the same key, and a source edit changes the line and so
 * correctly invalidates it.
 */
const RESUME = ".audit-operators-resume.jsonl";
const done = new Map();
if (existsSync(RESUME)) {
  for (const line of readFileSync(RESUME, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line);
      done.set(`${row.file}:${row.at}:${row.label}:${row.to}`, row);
    } catch {
      // 반쯤 쓰이다 끊긴 줄. 버리고 다시 잰다.
    }
  }
  console.log(`이어붙임: ${done.size}건은 이미 판정되어 있습니다 (${RESUME})\n`);
}

/**
 * Keyed on the byte offset, not the line.
 *
 * `a === b && c === d` is two `===` sites on one line, and a key of
 * file+line+operator collapses them into one — so a resumed run skips the
 * second and hands it the first's verdict. That is a measurement nobody made,
 * reported as one that was. The completed run measured every site individually,
 * so the 577/577 result is unaffected; the next resume would not have been.
 *
 * An offset also invalidates correctly: edit the file and every site after the
 * edit shifts, so a stale verdict drops out rather than being reused against
 * code it was never about.
 */
const keyOf = (c) => `${c.file}:${c.at}:${c.label}:${c.to}`;

try {
  for (const [i, c] of candidates.entries()) {
    const key = keyOf(c);
    const already = done.get(key);
    if (already !== undefined) {
      if (already.alive) survivors.push(c);
      continue;
    }
    const original = byFile.get(c.file);
    writeFileSync(c.file, original.slice(0, c.at) + c.to + original.slice(c.at + c.len), "utf8");
    const r = verdict(FULL);
    writeFileSync(c.file, original, "utf8");
    const alive = r.fail === 0;
    if (alive) survivors.push(c);
    // 판정 직후에 쓴다. 다음 변이에서 죽어도 이건 남는다.
    appendFileSync(
      RESUME,
      `${JSON.stringify({ file: c.file, at: c.at, line: c.line, label: c.label, to: c.to, alive, fail: r.fail, timedOut: r.timedOut === true })}\n`,
      "utf8",
    );
    console.log(
      `  [${String(i + 1).padStart(3)}/${candidates.length}] ${c.file}:${c.line} ${c.label}→${c.to.trim()}` +
        `  ${alive ? "살아남음" : `다른 시험이 잡음 (fail ${r.fail})`}`,
    );
    beat("2단계", i + 1, candidates.length, `${c.file}:${c.line}`);
  }
} finally {
  for (const [file, text] of byFile) writeFileSync(file, text, "utf8");
}

console.log(`\n=== 최종: 전체 스위트를 뚫고 살아남은 변이 ${survivors.length}개 ===`);
for (const s of survivors) console.log(`  ${s.file}:${s.line}  ${s.label} → ${s.to.trim()}  (${s.phase1})`);
