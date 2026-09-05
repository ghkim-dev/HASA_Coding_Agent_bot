/**
 * Which test blocks never execute an assertion.
 *
 *     node scripts/auditAssertions.mjs
 *
 * `mutate.mjs` asks whether a defence is load-bearing and `answers.mjs` asks
 * whether a written answer is. Neither asks the blunter question underneath
 * both: **does this test check anything at all?** A block whose assertions
 * never run passes no matter what the code does, and nothing in a green suite
 * distinguishes it from one that guards something.
 *
 * ## How it answers, rather than guesses
 *
 * A regex looking for `assert` in the body would call a block covered when its
 * only assertion sits inside a loop over an empty array, or after an early
 * `return`, or in a callback nothing invokes. Those are exactly the shapes that
 * hide. So this runs the suite once with `node:assert` instrumented through a
 * resolve hook — **the repo's own source is never edited**, because an audit
 * that modifies its subject is not an audit — and records every `file:line` an
 * assertion actually fired from.
 *
 * Every frame in the stack that belongs to a test file is recorded, not only
 * the innermost. A block asserting through a shared helper would otherwise
 * leave a mark on the helper's line and none on its own, and a perfectly good
 * test would be reported as checking nothing.
 *
 * ## What a silent block means, and what it does not
 *
 * It means nothing was checked *in this run*. Several legitimate shapes land
 * here and are not defects:
 *
 *   - opt-in tests gated on a credential or an artifact that is absent
 *   - tests skipped where the OS refuses (symlink creation without privilege)
 *   - implicit "does not throw" — the call is the assertion
 *   - tripwires looping over a table that is currently empty
 *
 * The output is a list to read, not a list to delete. Each entry needs a person
 * to open it and say which of those it is.
 */
import { readdirSync, readFileSync, statSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const TRACE = ".arena/assert-trace.log";
const SHIM = ".arena/assert-shim.mjs";
const HOOK = ".arena/assert-hook.mjs";
const RESOLVER = ".arena/assert-resolve.mjs";

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "out") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".test.ts")) out.push(p.split("\\").join("/"));
  }
  return out;
}

/** One `it(...)`/`test(...)` call, cut by paren balance so nesting is safe. */
function blocks(text) {
  const out = [];
  const re = /(?:^|[\s;{}])(it|test)(?:\.\w+)?\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`]*)`)/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[2] ?? m[3] ?? m[4] ?? "";
    let depth = 0;
    let i = text.indexOf("(", m.index + m[0].indexOf(m[1]));
    const start = i;
    let inStr = null;
    for (; i < text.length; i += 1) {
      const c = text[i];
      if (inStr !== null) {
        if (c === inStr && text[i - 1] !== "\\") inStr = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
      if (c === "(") depth += 1;
      else if (c === ")") { depth -= 1; if (depth === 0) break; }
    }
    out.push({
      name,
      from: text.slice(0, start).split("\n").length,
      to: text.slice(0, i + 1).split("\n").length,
    });
  }
  return out;
}

// --- the instrumentation, written where it is gitignored ---------------------

const shimSource = `import * as real from "node:assert";
import { appendFileSync } from "node:fs";
const OUT = ${JSON.stringify(TRACE)};
function origins() {
  const stack = new Error().stack ?? "";
  const out = [];
  for (const line of stack.split("\\n").slice(2)) {
    const m = /\\(?(?:file:\\/\\/\\/)?([A-Za-z]:[^):]*\\.test\\.ts|\\/[^):]*\\.test\\.ts):(\\d+):\\d+\\)?/.exec(line);
    if (m) out.push(m[1].split("\\\\").join("/") + ":" + m[2]);
  }
  return out;
}
const seen = new Set();
function record() {
  const fresh = origins().filter((at) => !seen.has(at));
  if (fresh.length === 0) return;
  for (const at of fresh) seen.add(at);
  try { appendFileSync(OUT, fresh.join("\\n") + "\\n"); } catch {}
}
function wrap(fn) {
  if (typeof fn !== "function") return fn;
  const w = function (...args) { record(); return fn.apply(this, args); };
  for (const k of Object.keys(fn)) w[k] = fn[k];
  return w;
}
function wrapNs(ns) {
  const out = wrap(ns);
  for (const k of Object.getOwnPropertyNames(ns)) {
    if (k === "length" || k === "name" || k === "prototype") continue;
    const v = ns[k];
    out[k] = typeof v === "function" ? wrap(v) : (v !== null && typeof v === "object" ? wrapNs(v) : v);
  }
  return out;
}
const wrapped = wrapNs(real.default ?? real);
wrapped.strict = wrapNs(real.strict);
if (real.strict) wrapped.strict.strict = wrapped.strict;
export default wrapped;
export const strict = wrapped.strict;
for (const key of Object.keys(wrapped)) {}
export const { ok, equal, notEqual, deepEqual, notDeepEqual, deepStrictEqual,
  notDeepStrictEqual, strictEqual, notStrictEqual, throws, doesNotThrow,
  rejects, doesNotReject, match, doesNotMatch, fail, ifError } = wrapped;
export const AssertionError = real.AssertionError;
`;

const resolverSource = `import { pathToFileURL } from "node:url";
const SHIM = pathToFileURL(process.cwd() + "/${SHIM}").href;
export async function resolve(specifier, context, next) {
  const isAssert = specifier === "node:assert" || specifier === "assert" || specifier === "node:assert/strict";
  if (isAssert && (context.parentURL ?? "").endsWith(".test.ts")) {
    return { url: SHIM, shortCircuit: true, format: "module" };
  }
  return next(specifier, context);
}
`;

const hookSource = `import { register } from "node:module";
import { pathToFileURL } from "node:url";
register(pathToFileURL("./${RESOLVER}").href, import.meta.url);
`;

const { mkdirSync, writeFileSync } = await import("node:fs");
mkdirSync(".arena", { recursive: true });
writeFileSync(SHIM, shimSource, "utf8");
writeFileSync(RESOLVER, resolverSource, "utf8");
writeFileSync(HOOK, hookSource, "utf8");
rmSync(TRACE, { force: true });

process.stdout.write("계측한 채로 전체 스위트를 한 번 돌립니다…\n");
let out;
try {
  out = execFileSync(
    "node",
    ["--import", `./${HOOK}`, "--test", "src/**/*.test.ts", "extension/**/*.test.ts"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 },
  );
} catch (err) {
  out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
}
const pass = /^ℹ pass (\d+)$/m.exec(out)?.[1] ?? "?";
const fail = /^ℹ fail (\d+)$/m.exec(out)?.[1] ?? "?";
process.stdout.write(`통과 ${pass} · 실패 ${fail}\n\n`);

const trace = new Map();
for (const line of (existsSync(TRACE) ? readFileSync(TRACE, "utf8") : "").split("\n")) {
  const m = /^(.*\.test\.ts):(\d+)$/.exec(line.trim());
  if (m === null) continue;
  const key = m[1].toLowerCase();
  if (!trace.has(key)) trace.set(key, new Set());
  trace.get(key).add(Number(m[2]));
}

const files = [...walk("src"), ...walk("extension")];
const silent = [];
let total = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const lines = trace.get(resolve(file).split("\\").join("/").toLowerCase()) ?? new Set();
  for (const b of blocks(text)) {
    total += 1;
    if (![...lines].some((n) => n >= b.from && n <= b.to)) silent.push({ file, ...b });
  }
}

console.log(`시험 파일 ${files.length}개 · 블록 ${total}개`);
console.log(`단언이 실행된 블록 ${total - silent.length}개 · 실행되지 않은 블록 ${silent.length}개\n`);
for (const s of silent) console.log(`  ${s.file}:${s.from}  «${s.name}»`);
console.log(
  `\n위 목록은 지울 목록이 아니라 열어 볼 목록입니다 — 자격증명·권한·산출물에 걸려` +
    `\n건너뛴 것, 예외가 안 난다는 것으로 주장하는 것, 아직 비어 있는 표 위의` +
    `\n트립와이어가 모두 여기 섞여 있습니다.`,
);
process.exitCode = fail === "0" ? 0 : 1;
