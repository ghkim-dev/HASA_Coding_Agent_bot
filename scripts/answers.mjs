import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * Whether each written answer is actually checked.
 *
 * `scripts/mutate.mjs` asks one half of the question: take a defence out of the
 * source and see whether a test notices. Every hole this project has found in
 * its own tests came from the other half, which nothing was asking:
 *
 *     못 박은 답을 바꿨는데 아무도 실패하지 않는다면, 그 답은 검사되지 않는다.
 *
 * The holes all had that shape. A ratio test asserting `hit <= of`, true of
 * every wrong answer. A pinned string the runtime never produces, so the test
 * could not fail. A table row nobody counts. A turn with no gold, compared as an
 * empty array against an empty array. Nine axes reported per case and two of
 * them asserted. Each was found by hand, one at a time — and five of six such
 * reports turned out to describe one file's blindness rather than the project's,
 * because a hand check is scoped to whatever the checker happened to open.
 *
 * So this is the symmetric harness. It perturbs the **answers** rather than the
 * code and requires the suite to go red. Where it stays green, the answer is
 * decoration: written down, read by a person, verified by nothing.
 *
 * ## Why every perturbation is verified before it counts
 *
 * The first version of this file measured nothing and reported 64 of 66 answers
 * checked. Two faults, and both are the fault this project keeps finding in its
 * own instruments: the replacement re-quoted the same string, so the file was
 * byte-identical; and the scan matched `action: ActionKind` in a type
 * declaration, so where it did edit, it corrupted the file and the parse error
 * was counted as the answer being checked.
 *
 * So a perturbation now has to prove itself before its verdict is read:
 *
 *   1. the file still parses — the module is imported and its exports walked;
 *   2. the exported data actually changed — compared against the original;
 *   3. only then are the tests run, and only a `fail` counts as a catch.
 *
 * A perturbation that fails 1 or 2 is reported as unusable, never as a catch.
 *
 * ## What a green result does not mean
 *
 * That the answers are right — only that they are load-bearing. An answer can be
 * wrong and checked, and this reports it as checked. Correctness is what the
 * corpora and their written arguments are for.
 *
 * One literal is perturbed at a time, so an answer that is only checked in
 * combination with another is invisible here. The number is a floor.
 */

/**
 * Answers that are deliberately not checked, and why.
 *
 * The mirror of `EXPECTED_SILENT` in `scripts/mutate.mjs`. An answer belongs
 * here only when not checking it is the decision — never because writing the
 * test is inconvenient. Keyed exactly as the report prints it.
 */
const EXPECTED_UNCHECKED = new Map([
  [
    'src/design/mediaCases.ts:213 :: requirements = "create"',
    "m-user-chooses 의 답이다. 그 문장(`사용자가 이미지와 영상 중에 고를 수 있게 해줘`)은 " +
      "일부러 읽지 않는다 — `고르다` 가 어떤 행위인지 문장이 말하지 않기 때문이다. 답은 " +
      "'읽었다면 이랬을 것' 을 적어 둔 것이고, 테스트는 그 반대(아무것도 나오지 않는다)를 " +
      "못 박는다. 그래서 이 답을 바꿔도 아무도 실패하지 않는 것이 맞다.",
  ],
  [
    'src/design/mediaCases.ts:213 :: requirements = "이미지와 영상"',
    "위와 같은 사례의 대상 쪽. 같은 이유로 검사되지 않는다.",
  ],
  [
    'src/eval/scenarios.ts:206 :: expectedRelation = "continue"',
    "S08-face-blocker#2 와 S20-mixed-stress#6 의 답이다. 둘 다 런타임이 `refine` 으로 " +
      "읽고, 그 어긋남은 `evalScenarioRecall.test.ts` 의 " +
      "SCENARIO_RELATION_AS_BUILT 에 판정과 이유를 달아 못 박혀 있다. 못이 as-built 값을 " +
      "주장하므로 정답 쪽을 바꿔도 실패하지 않는 것이 맞다 — 정답과 같아지는 순간에는 " +
      "그 못이 실패한다.",
  ],
  [
    'src/eval/scenarios.ts:457 :: expectedRelation = "continue"',
    "위와 같다 — S20-mixed-stress#6 쪽.",
  ],
  [
    'src/design/consultingCases.ts:122 :: requirements = "PoC부터 전사 확산까지 단계"',
    "두 어절 창이 이 명사구를 자르는 자리다. `consultingCases.test.ts` 의 " +
      "KNOWN_TARGET_MISS 가 잘린 값을 못 박고 있으므로, 테스트는 정답이 아니라 못을 " +
      "주장한다 — 정답 쪽을 바꿔도 실패하지 않는 것이 맞고, 창이 넓어져 정답과 " +
      "같아지는 순간 그 못이 실패한다.",
  ],
  [
    'src/design/consultingCases.ts:267 :: requirements = "장애 복구 시간"',
    "위와 같다 — 세 어절 명사구의 앞머리가 잘리는 자리이고, 잘린 값이 못 박혀 있다.",
  ],
  [
    'src/design/consultingCases.ts:298 :: requirements = "벤더 세 곳의 제안서"',
    "위와 같다 — 수량 구가 남고 머리 명사가 잘리는 자리이고, 잘린 값이 못 박혀 있다.",
  ],
  [
    'src/design/goldCases.ts:517 :: relation = "new_task"',
    "past-failure-retry 의 두 번째 턴이다. `RELATION_AS_BUILT` 가 이 턴을 `refine` 으로 " +
      "못 박아 두었으므로 테스트는 정답이 아니라 못을 주장하고, 그래서 정답 쪽을 바꿔도 " +
      "실패하지 않는다. 알려진 어긋남을 못 박으면 그 자리의 정답이 검사되지 않게 되는 것은 " +
      "피할 수 없고, 그 대가는 「as-built 표에는 정답과 어긋나는 줄만 있다」 테스트가 " +
      "막는다 — 런타임이 다시 정답과 같아지는 순간 그 테스트가 실패해서 못을 지우게 만든다.",
  ],
]);

/** Fields that carry an answer. Everything else in these files is prose. */
const ANSWER_KEYS = [
  "action",
  "target",
  "relation",
  "expectedRelation",
  "standing",
  "superseded",
  "prohibitions",
  "requirements",
  "exactSources",
  "expectWinner",
  "becauseCapability",
  "quote",
  "polarity",
  "mustContainKinds",
  "mustContainText",
  "forbiddenActions",
  "requiredQuestionCodes",
  "forbiddenQuestionCodes",
  "exactQuestionSubjects",
  "mustNotInvent",
];

const CORPORA = [
  { file: "src/design/mediaCases.ts", tests: ["src/design/mediaCases.test.ts"] },
  { file: "src/design/consultingCases.ts", tests: ["src/design/consultingCases.test.ts"] },
  { file: "src/design/mediaCasesEnglish.ts", tests: ["src/design/mediaCasesEnglish.test.ts"] },
  { file: "src/design/mediaConversations.ts", tests: ["src/design/mediaConversations.test.ts"] },
  { file: "src/design/mediaConversationsEnglish.ts", tests: ["src/design/mediaConversations.test.ts"] },
  {
    file: "src/eval/scenarios.ts",
    tests: ["src/design/evalScenarioRecall.test.ts", "src/design/scenarioShadow.test.ts"],
  },
  {
    file: "src/design/goldCases.ts",
    tests: ["src/design/goldRequirements.test.ts", "src/design/executability.test.ts"],
  },
  { file: "src/design/holdoutCases.ts", tests: ["src/design/holdoutCases.test.ts"] },
  { file: "src/design/recommendationCases.ts", tests: ["src/design/recommendationCases.test.ts"] },
];

for (const name of readdirSync("examples/design-preview").filter((f) => f.endsWith(".json")).sort()) {
  CORPORA.push({ file: join("examples/design-preview", name), tests: ["src/design/preview.test.ts"] });
}

/** A string literal sitting under an answer key, and where it is in the text. */
function answersIn(text) {
  const out = [];
  const keyPattern = new RegExp(`(?:"?(${ANSWER_KEYS.join("|")})"?)\\s*:\\s*`, "g");
  let match;
  while ((match = keyPattern.exec(text)) !== null) {
    const key = match[1];
    const at = match.index + match[0].length;
    if (text[at] === "[") {
      let depth = 0;
      for (let i = at; i < text.length; i += 1) {
        const c = text[i];
        if (c === "[") depth += 1;
        else if (c === "]") {
          depth -= 1;
          if (depth === 0) break;
        } else if (c === '"') {
          const end = closingQuote(text, i);
          if (end === -1) break;
          out.push({ key, start: i, end, value: text.slice(i + 1, end) });
          i = end;
        }
      }
      continue;
    }
    if (text[at] === '"') {
      const end = closingQuote(text, at);
      if (end !== -1) out.push({ key, start: at, end, value: text.slice(at + 1, end) });
      continue;
    }
    if (text.startsWith("null", at)) out.push({ key, start: at, end: at + 3, value: null });
  }
  const seen = new Set();
  return out
    .filter((a) => {
      if (seen.has(a.start)) return false;
      seen.add(a.start);
      return true;
    })
    .sort((a, b) => a.start - b.start);
}

function closingQuote(text, openAt) {
  for (let i = openAt + 1; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === '"') return i;
    if (text[i] === "\n") return -1;
  }
  return -1;
}

/**
 * Answers that say what must **not** happen.
 *
 * These need the opposite probe. A positive answer is checked by making it
 * wrong; a negative answer made "wrong" is only made weaker — "must not invent
 * 배포" perturbed to "must not invent 배포ᬛ변조" still passes, because neither
 * word appears. Perturbing toward absence proves nothing about a rule whose job
 * is to notice presence.
 *
 * So a negative answer is perturbed toward something the fixture *does*
 * produce: a question code it actually raises, an act it actually reads, a word
 * that is actually in one of its requirements. If that does not turn the suite
 * red, nothing is reading the field.
 *
 * Where a fixture produces nothing to point at — no questions, no requirements
 * — the probe is impossible rather than failed, and it is reported as unusable.
 */
const NEGATIVE_KEYS = new Set(["forbiddenQuestionCodes", "mustNotInvent", "forbiddenActions"]);

/**
 * The answer, said differently.
 *
 * A marker rather than a plausible alternative, so the change is never a second
 * correct answer. `null` becomes a string, because a target the sentence does
 * not name and a target it does are the two things that answer distinguishes.
 */
const MARK = "ᬛ변조";
function perturb(answer, occurring) {
  if (NEGATIVE_KEYS.has(answer.key)) {
    const present = occurring?.[answer.key] ?? [];
    const other = present.find((v) => v !== answer.value);
    return other === undefined ? null : JSON.stringify(other);
  }
  if (answer.value === null) return JSON.stringify(MARK);
  return JSON.stringify(`${answer.value}${MARK}`);
}

/** What this fixture actually produces, for the negative probes above. */
async function occurrencesFor(file) {
  if (!file.endsWith(".json")) return null;
  const spec = JSON.parse(readFileSync(file, "utf8"));
  const { previewDesign } = await import(pathToFileURL("src/design/preview.ts").href);
  const { questionsFrom } = await import(pathToFileURL("src/design/previewReport.ts").href);
  const result = await previewDesign({ turns: spec.turns });
  // 물러난 요구사항은 뺀다. 검사가 보는 목록과 같아야 한다 — 정정으로 물러난
  // 문장의 낱말을 골라 놓고 '검사되지 않는다' 고 보고하면 그것은 검사의 구멍이
  // 아니라 이 하네스의 구멍이다.
  const stated = result.requirements.filter(
    (r) => r.status !== "system_added" && r.supersededBy === undefined,
  );
  return {
    forbiddenQuestionCodes: [...new Set(questionsFrom(result).map((q) => q.code))],
    forbiddenActions: [...new Set(stated.map((r) => r.act).filter((a) => a !== undefined))],
    mustNotInvent: [
      ...new Set(stated.flatMap((r) => r.text.split(/\s+/)).filter((w) => w.length >= 2)),
    ],
  };
}

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** What the corpus exports, as a comparable string — or null if it will not load. */
let loadCount = 0;
async function shapeOf(file) {
  try {
    if (file.endsWith(".json")) return JSON.stringify(JSON.parse(readFileSync(file, "utf8")));
    loadCount += 1;
    const mod = await import(`${pathToFileURL(file).href}?answers=${loadCount}`);
    return JSON.stringify(Object.fromEntries(Object.entries(mod).map(([k, v]) => [k, v])));
  } catch {
    return null;
  }
}

function verdict(tests) {
  let out;
  try {
    out = execFileSync("node", ["--test", ...tests], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  const pass = /^ℹ pass (\d+)$/m.exec(out);
  const fail = /^ℹ fail (\d+)$/m.exec(out);
  const cancelled = /^ℹ cancelled (\d+)$/m.exec(out);
  if (pass === null || fail === null) {
    throw new Error(`테스트 출력에서 pass/fail 을 읽지 못했습니다: ${tests.join(", ")}`);
  }
  const stopped = cancelled === null ? 0 : Number(cancelled[1]);
  return { pass: Number(pass[1]), fail: Number(fail[1]) + stopped, cancelled: stopped };
}

const lines = [];
const say = (text) => {
  lines.push(text);
  process.stdout.write(`${text}\n`);
};

const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const work = only === undefined ? CORPORA : CORPORA.filter((c) => c.file.includes(only));
if (work.length === 0) throw new Error(`--only=${only} 에 해당하는 말뭉치가 없습니다`);

const leftovers = work.filter((c) => existsSync(`${c.file}.answerbak`));
if (leftovers.length > 0) {
  throw new Error(`이전 실행이 남긴 .answerbak 이 있습니다: ${leftovers.map((c) => c.file).join(", ")}`);
}

let checked = 0;
let allowed = 0;
let unusable = 0;
let total = 0;
const unchecked = [];

for (const corpus of work) {
  const original = readFileSync(corpus.file, "utf8");
  const digest = sha(corpus.file);
  const found = answersIn(original);
  if (found.length === 0) {
    say(`${corpus.file.padEnd(48)} 답이 없습니다`);
    continue;
  }

  const baseShape = await shapeOf(corpus.file);
  if (baseShape === null) {
    say(`${corpus.file}: 말뭉치를 읽지 못했습니다 — 건너뜁니다`);
    continue;
  }
  const occurring = await occurrencesFor(corpus.file);
  const base = verdict(corpus.tests);
  if (base.fail !== 0) {
    say(`${corpus.file}: 기준선이 이미 빨갛습니다 (fail ${base.fail}) — 건너뜁니다`);
    continue;
  }

  copyFileSync(corpus.file, `${corpus.file}.answerbak`);
  const missed = [];
  let bad = 0;
  try {
    for (const answer of found) {
      total += 1;
      const replacement = perturb(answer, occurring);
      if (replacement === null) {
        // 가리킬 것이 없어 시험 자체가 불가능하다. 놓친 것이 아니라 못 잰 것이다.
        unusable += 1;
        continue;
      }
      const mutated = original.slice(0, answer.start) + replacement + original.slice(answer.end + 1);
      writeFileSync(corpus.file, mutated);
      let usable = false;
      let result = null;
      try {
        // 1. it still parses, and 2. the data actually moved. A perturbation
        // that fails either is not a measurement of anything.
        const shape = await shapeOf(corpus.file);
        usable = shape !== null && shape !== baseShape;
        if (usable) result = verdict(corpus.tests);
      } finally {
        writeFileSync(corpus.file, original);
      }
      if (!usable) {
        bad += 1;
        unusable += 1;
        continue;
      }
      if (result.fail > 0) checked += 1;
      else missed.push(answer);
    }
  } finally {
    writeFileSync(corpus.file, original);
    if (sha(corpus.file) !== digest) {
      say(`!! ${corpus.file} 복원 실패 — .answerbak 를 남겨 둡니다`);
      process.exitCode = 3;
    } else {
      unlinkSync(`${corpus.file}.answerbak`);
    }
  }

  // The same string the report prints, so a line can be moved from one to the
  // other. They were built by two different expressions once, and the allow-list
  // silently matched nothing.
  const keyOf = (a) =>
    `${corpus.file}:${original.slice(0, a.start).split("\n").length} :: ${a.key} = ${JSON.stringify(a.value)}`;
  const surprising = missed.filter((a) => !EXPECTED_UNCHECKED.has(keyOf(a)));
  allowed += missed.length - surprising.length;
  const usable = found.length - bad;
  const note =
    surprising.length > 0
      ? `  << 검사되지 않는 답 ${surprising.length}개`
      : missed.length > 0
        ? `  (의도된 것 ${missed.length}개)`
        : "";
  say(
    `${corpus.file.padEnd(48)} ${String(usable - missed.length).padStart(4)}/${String(usable).padEnd(4)}` +
      `${bad > 0 ? ` (쓸 수 없는 변조 ${bad})` : ""}${note}`,
  );
  for (const answer of surprising) unchecked.push(keyOf(answer));
}

say("-".repeat(78));
say(`검사되는 답            : ${checked} / ${total - unusable}`);
say(`의도적으로 안 보는 답     : ${allowed}`);
say(`쓸 수 없는 변조         : ${unusable}`);
say(`예상 밖으로 안 보는 답    : ${unchecked.length}`);
for (const line of unchecked) say(`   ${line}`);

const report = process.argv[2];
if (report !== undefined && !report.startsWith("--")) {
  writeFileSync(report, `${lines.join("\n")}\n`, "utf8");
}
if (unchecked.length > 0) process.exitCode = 1;
