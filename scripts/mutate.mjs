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
];

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
  ["M09", "모델의 명시적 confirmed 를 신뢰", "src/design/requirementSpec.ts",
    'confidence: confidenceFor({\n        derivedBy: "model_proposal",',
    'confidence: proposal.confidence ?? confidenceFor({\n        derivedBy: "model_proposal",'],
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
];

/** Mutations that are allowed not to bite, with the reason recorded. */
const EXPECTED_SILENT = new Map([
  ["M17", "종료를 보장하는 것은 attempted 중복 방지이므로 pass 상한을 지워도 동작이 같다"],
]);

function suite() {
  try {
    const out = execFileSync("node", ["--test", "src/design/demos.test.ts"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parse(out);
  } catch (err) {
    return parse(`${err.stdout ?? ""}${err.stderr ?? ""}`);
  }
}

function parse(out) {
  const pass = Number(/^ℹ pass (\d+)$/m.exec(out)?.[1] ?? -1);
  const fail = Number(/^ℹ fail (\d+)$/m.exec(out)?.[1] ?? -1);
  return { pass, fail };
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

for (const [id, label, file, from, to] of MUTATIONS) {
  const before = readFileSync(file, "utf8");
  if (!before.includes(from)) {
    say(`${id} ${label.padEnd(34)} !! 치환 문자열 없음 — 변이 미적용`);
    notApplied += 1;
    continue;
  }
  writeFileSync(file, before.split(from).join(to), "utf8");
  const result = suite();
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
