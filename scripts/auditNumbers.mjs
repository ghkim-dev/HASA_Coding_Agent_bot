/**
 * Whether the numbers the README claims are still the numbers.
 *
 *     node scripts/auditNumbers.mjs
 *
 * The README states corpus sizes and harness counts as bold figures, and those
 * are the project's public claim. They go stale silently: a corpus grows, a
 * mutation is added, and the number in the README keeps asserting the old one
 * with no test anywhere that disagrees.
 *
 * A month without review produced exactly that — the README said 277 mutations
 * when there were 313, and 920/928 answers when there were 936/944, while every
 * corpus size in the same table was still correct.
 *
 * Each claim is written here beside the expression that recomputes it, so the
 * check fails rather than the document quietly lying.
 */
let failures = 0;
const say = (label, claimed, actual) => {
  const ok = String(claimed) === String(actual);
  console.log(`  ${ok ? "✔" : "✘"} ${label.padEnd(40)} 주장 ${String(claimed).padEnd(12)} 실제 ${actual}`);
  if (!ok) failures += 1;
  return ok;
};

console.log("=== 말뭉치 크기 ===");
const gold = await import("../src/design/goldCases.ts");
const goldCases = gold.GOLD_CASES ?? [];
say("Gold 사례", 43, goldCases.length);

const holdout = await import("../src/design/holdoutCases.ts");
say("Holdout 사례", 33, (holdout.HOLDOUT_CASES ?? []).length);

const scen = await import("../src/eval/scenarios.ts");
const scenarios = scen.SCENARIOS ?? scen.EVAL_SCENARIOS ?? [];
say("평가기 시나리오 대화", 20, scenarios.length);
say(
  "평가기 시나리오 턴",
  31,
  scenarios.reduce((n, s) => n + (s.turns?.length ?? 0), 0),
);

const media = await import("../src/design/mediaCases.ts");
const mediaCases = media.MEDIA_CASES ?? [];
say("미디어(한국어) 문장", 31, mediaCases.length);
say(
  "미디어(한국어) 요구",
  33,
  mediaCases.reduce((n, c) => n + (c.requirements?.length ?? 0), 0),
);

const mediaEn = await import("../src/design/mediaCasesEnglish.ts");
const enCases = mediaEn.ENGLISH_MEDIA_CASES ?? [];
say("미디어(영어) 문장", 25, enCases.length);
say(
  "미디어(영어) 요구",
  30,
  enCases.reduce((n, c) => n + (c.requirements?.length ?? 0), 0),
);

const consulting = await import("../src/design/consultingCases.ts");
const cCases = consulting.CONSULTING_CASES ?? [];
say("컨설팅 문장", 25, cCases.length);
say(
  "컨설팅 요구",
  33,
  cCases.reduce((n, c) => n + (c.requirements?.length ?? 0), 0),
);

const conv = await import("../src/design/mediaConversations.ts");
const convEn = await import("../src/design/mediaConversationsEnglish.ts");
const ko = conv.MEDIA_CONVERSATIONS ?? [];
const en = convEn.ENGLISH_MEDIA_CONVERSATIONS ?? [];
say("여러 턴 대화 (한국어)", 8, ko.length);
say("여러 턴 대화 (영어)", 5, en.length);

const rec = await import("../src/design/recommendationCases.ts");
say("모델 추천 사례", 20, (rec.RECOMMENDATION_CASES ?? []).length);

console.log("\n=== 하네스 규모 ===");
const mutateSrc = (await import("node:fs")).readFileSync("scripts/mutate.mjs", "utf8");
const mutationCount = (mutateSrc.split("const MUTATIONS = [")[1] ?? "").split("const EXPECTED_SILENT")[0].match(/^  \["M\d+"/gm)?.length ?? 0;
const ok = say("변이 개수", 313, mutationCount);
process.exitCode = failures === 0 ? 0 : 1;
