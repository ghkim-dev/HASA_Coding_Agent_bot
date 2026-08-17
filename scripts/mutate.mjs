import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * Applies each defence-removing mutation, runs the design tests, restores.
 *
 * Written as a script rather than a shell pipeline because the shell version
 * produced the defect that motivated it: a mutation whose search string did not
 * match ran the suite unchanged and was recorded as `fail 0`, which reads as
 * "the tests do not catch this" and meant "the mutation never happened". Every
 * entry here verifies the file actually changed before the suite runs, and a
 * mutation that does not apply is an error rather than a result.
 */

const FILES = [
  "src/design/requirementSpec.ts",
  "src/design/sourceSpan.ts",
  "src/design/semanticAlignment.ts",
  "src/design/scenarioBlueprint.ts",
  "src/design/coverageAudit.ts",
  "src/design/coverageClosure.ts",
  "src/design/functionalExtract.ts",
  "src/design/modelProposer.ts",
  "src/design/modelPermission.ts",
  "src/design/proposalParse.ts",
  "src/design/preview.ts",
  "src/design/previewMetrics.ts",
  "src/design/previewReport.ts",
];

/**
 * Which suite is run for a mutation.
 *
 * `demos.test.ts` alone was the whole harness, so every defence added after it
 * — the parser's outcomes, the permission gate, the question contract — was
 * mutated against a suite that never exercised it and dutifully reported "does
 * not bite". A mutation now runs the tests that own the file it touched.
 */
const SUITES = {
  demos: ["src/design/demos.test.ts"],
  preview: ["src/design/preview.test.ts"],
  parse: ["src/design/proposalParse.test.ts", "src/design/preview.test.ts"],
  permission: ["src/design/modelPermission.test.ts"],
  extract: ["src/design/functionalExtract.test.ts", "src/design/preview.test.ts"],
  metrics: ["src/design/preview.test.ts"],
};

const MUTATIONS = [
  ["M01", "span 범위 검사 제거", "src/design/sourceSpan.ts",
    'if (span.start < 0 || span.end > full.length) problems.push("out_of_range");', ""],
  ["M02", "correction merge 제거", "src/design/requirementSpec.ts",
    "const contradicted = incoming.some(", "const contradicted = false && incoming.some("],
  ["M03", "forbidden polarity 제거", "src/design/requirementSpec.ts",
    'polarity: "forbidden",', 'polarity: "required",'],
  ["M04", "requirementIds 추적 제거", "src/design/coverageAudit.ts",
    'if (scenario.requirementIds.length === 0 && scenario.generatedBy !== "baseline") {', "if (false) {"],
  ["M05", "정상 허용 반대 검사 제거", "src/design/coverageAudit.ts",
    "if (!scenarios.some((s) => s.oracle.requiredTools.length > 0)) {", "if (false) {"],
  ["M06", "oracle 결정론 검사 제거", "src/design/coverageAudit.ts",
    "if (readsProse(scenario)) {", "if (false) {"],
  ["M07", "permitted 모델 교집합 제거", "src/design/coverageAudit.ts",
    "if (!permitted.has(model)) {", "if (false) {"],
  ["M08", "Coverage Audit 우회", "src/design/coverageAudit.ts",
    "return audit.ok;", "return true;"],
  // Re-anchored when `confidence` split into axes. The old search string went
  // silent rather than failing — the exact class of defect this script exists
  // to make visible, arriving in the script itself.
  ["M09", "모델의 명시적 confirmed 를 신뢰", "src/design/requirementSpec.ts",
    'intent: intentFor({ derivedBy: "model_proposal" }),',
    'intent: proposal.confidence ?? intentFor({ derivedBy: "model_proposal" }),'],
  ["M10", "system_added 를 explicit 로", "src/design/requirementSpec.ts",
    'status: "system_added" as const,', 'status: "explicit" as const,'],
  ["M11", "derivedBy 위조 거부 제거", "src/design/requirementSpec.ts",
    "if (FORGEABLE.some((field) => carried[field] !== undefined)) {", "if (false) {"],
  ["M12", "sourceText 를 모델 문자열에서 사용", "src/design/requirementSpec.ts",
    "sourceText: check.text,", "sourceText: proposal.quote ?? check.text,"],
  ["M13", "의미·극성 불일치 검사 제거", "src/design/requirementSpec.ts",
    'if (alignment.verdict === "reversed") {', "if (false) {"],
  ["M14", "designRuleId 요구 제거", "src/design/coverageAudit.ts",
    "if (scenarios.some((s) => s.designRuleId === GENERIC_RULE)) {", "if (false) {"],
  ["M15", "generic 이 모든 must 를 덮도록", "src/design/scenarioBlueprint.ts",
    "designRuleId: GENERIC_RULE,", 'designRuleId: "covers-everything.v1",'],
  ["M16", "Closure 재감사 제거", "src/design/coverageClosure.ts",
    "    audit = run(scenarios);\n    if (pass === maxPasses) stoppedBecause = \"max_passes\";",
    '    if (pass === maxPasses) stoppedBecause = "max_passes";'],
  ["M17", "Closure 반복 제한 제거", "src/design/coverageClosure.ts",
    "for (let pass = 1; pass <= maxPasses; pass += 1) {", "for (let pass = 1; pass <= 9999; pass += 1) {"],
  ["M18", "미해결 조건을 실행 가능으로", "src/design/coverageAudit.ts",
    "if (spec.condition !== undefined) {", "if (false) {"],
  ["M19", "요구사항 충돌 무시", "src/design/coverageAudit.ts",
    "if (spec.conflicts.length > 0) {", "if (false) {"],
  ["M20", "부정 절단 검사 제거", "src/design/sourceSpan.ts",
    'if (NEGATION.test(after)) problems.push("negation_truncated");', ""],

  // --- dcd9172 이후 추가된 방어선 -------------------------------------------
  ["M21", "공개 모델 목록을 권한으로 승격", "src/design/modelPermission.ts",
    'found === undefined ? "unknown" : found.chat === "pass" ? "permitted" : found.chat === "denied" ? "denied" : "unknown";',
    '"permitted";', "permission"],
  ["M22", "권한 unknown 을 허용으로", "src/design/modelPermission.ts",
    'return catalogue.filter((id) => permissionFor(evidence, id).standing === "permitted");',
    'return catalogue.filter((id) => permissionFor(evidence, id).standing !== "denied");', "permission"],
  ["M23", "다른 키의 권한 기록을 수용", "src/design/modelPermission.ts",
    "if (matrix.keyFingerprint !== input.keyFingerprint) return null;", "", "permission"],
  ["M24", "malformed 를 empty 로 합침", "src/design/proposalParse.ts",
    'return items.length === 0 ? "empty_array" : "malformed_item";', 'return "empty_array";', "parse"],
  ["M25", "빈 응답과 파싱 실패를 합침", "src/design/proposalParse.ts",
    'if (raw.trim().length === 0) return none("empty_response");',
    'if (raw.trim().length === 0) return none("no_json_array");', "parse"],
  ["M26", "직접 명령의 intent 를 전부 ambiguous 로", "src/design/requirementSpec.ts",
    'case "runtime_action":\n    case "system_baseline":\n      return "confirmed";',
    'case "system_baseline":\n      return "confirmed";\n    case "runtime_action":\n      return "ambiguous";', "preview"],
  ["M27", "부정문에서 긍정 action 생성", "src/design/functionalExtract.ts",
    "if (NEGATED.test(clause.slice(match.index, match.index + match[0].length + 8))) continue;", "", "extract"],
  ["M28", "절 경계에서 -고 연결을 제거", "src/design/functionalExtract.ts",
    "|(?<=[가-힣]고\\s)", "", "extract"],
  // Removing an assertion from a test file cannot make that file fail, so a
  // mutation that deletes the required-question check would always read as
  // "does not bite". The check is load-bearing only if a production change it
  // is watching for does fail, which is what this mutates instead.
  ["M29", "대상 미결정을 질문하지 않음", "src/design/previewReport.ts",
    '  "TARGET_UNRESOLVED",\n]);', "]);", "preview"],
  ["M30", "fullyResolvedRate 를 remediableClosureRate 와 합침", "src/design/previewMetrics.ts",
    "fullyResolvedRate: ratio(\n      results.filter((r) => r.closure.audit.findings.length === 0).length,\n      results.length,\n    ),",
    "fullyResolvedRate: ratio(\n      results.filter((r) => r.closure.unresolved.length === r.closure.audit.findings.length).length,\n      results.length,\n    ),", "metrics"],
  ["M31", "target 미결정 finding 을 제거", "src/design/coverageAudit.ts",
    'if (spec.intent === "confirmed" && spec.binding === "unresolved") {', "if (false) {", "preview"],
];

/** Mutations that are allowed not to bite, with the reason recorded. */
const EXPECTED_SILENT = new Map([
  ["M17", "종료를 보장하는 것은 attempted 중복 방지이므로 pass 상한을 지워도 동작이 같다"],
]);

function suite(files = SUITES.demos) {
  try {
    const out = execFileSync("node", ["--test", ...files], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parse(out);
  } catch (err) {
    return parse(`${err.stdout ?? ""}${err.stderr ?? ""}`);
  }
}

/** CRLF to LF. Built from char codes so no escape can be mangled in transit. */
function normalise(text) {
  return text.split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10));
}

function parse(out) {
  const pass = Number(/^ℹ pass (\d+)$/m.exec(out)?.[1] ?? -1);
  const fail = Number(/^ℹ fail (\d+)$/m.exec(out)?.[1] ?? -1);
  return { pass, fail };
}

// Every target must be a file this script backs up.
//
// It was not, once. A mutation aimed at `preview.test.ts` — outside `FILES` —
// was applied and never restored, because the restore loop only knows about
// `FILES`. The edit stayed in the working tree, silently emptying the very
// assertion the mutation was meant to prove was load-bearing, and two later
// mutations then reported "does not bite" because the check they should have
// tripped was gone. A harness that can corrupt the thing it measures reports
// confidence it has not earned, so this is a hard error rather than a warning.
const unbacked = MUTATIONS.filter(([, , file]) => !FILES.includes(file));
if (unbacked.length > 0) {
  const names = unbacked.map(([id, , file]) => `${id} → ${file}`).join(", ");
  throw new Error(`백업 대상이 아닌 파일을 변이시키려 합니다: ${names}`);
}

for (const f of FILES) copyFileSync(f, `${f}.bak`);
const restore = () => {
  for (const f of FILES) copyFileSync(`${f}.bak`, f);
};

const lines = [];
const say = (s) => {
  lines.push(s);
  process.stdout.write(`${s}\n`);
};

const baseline = suite();
say(`기준선                                          pass ${baseline.pass}  fail ${baseline.fail}`);
say("-".repeat(78));

let notApplied = 0;
let unexpectedlySilent = 0;

for (const [id, label, file, from, to, suiteKey] of MUTATIONS) {
  // Normalised, because the working tree carries CRLF and a multi-line search
  // string written with a bare newline silently matches nothing. That is the
  // exact failure this script exists to make visible, and it caught itself.
  const before = normalise(readFileSync(file, "utf8"));
  if (!before.includes(from)) {
    say(`${id} ${label.padEnd(34)} !! 치환 문자열 없음 — 변이 미적용`);
    notApplied += 1;
    continue;
  }
  writeFileSync(file, before.split(from).join(to), "utf8");
  const after = readFileSync(file, "utf8");
  if (normalise(after) === before) {
    say(`${id} ${label.padEnd(34)} !! 파일이 바뀌지 않음 — 변이 미적용`);
    notApplied += 1;
    restore();
    continue;
  }
  const result = suite(SUITES[suiteKey ?? "demos"]);
  restore();

  const silent = result.fail === 0;
  const allowed = EXPECTED_SILENT.has(id);
  let note = "";
  if (silent && allowed) note = `  (예상된 무반응: ${EXPECTED_SILENT.get(id)})`;
  if (silent && !allowed) {
    note = "  << 물지 않음";
    unexpectedlySilent += 1;
  }
  say(`${id} ${label.padEnd(34)} pass ${String(result.pass).padStart(3)}  fail ${String(result.fail).padStart(2)}${note}`);
}

restore();
for (const f of FILES) unlinkSync(`${f}.bak`);

const after = suite();
say("-".repeat(78));
say(`복원 후                                         pass ${after.pass}  fail ${after.fail}`);
say("");
say(`변이 미적용        : ${notApplied}`);
say(`예상 밖 무반응     : ${unexpectedlySilent}`);
say(`허용된 무반응      : ${[...EXPECTED_SILENT.keys()].join(", ") || "없음"}`);

if (process.argv[2] !== undefined) {
  writeFileSync(process.argv[2], `${lines.join("\n")}\n`, "utf8");
}
process.exit(notApplied === 0 && unexpectedlySilent === 0 && after.fail === 0 ? 0 : 1);
