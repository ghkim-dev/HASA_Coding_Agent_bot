import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
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
 *
 * ## What this script owes the working tree
 *
 * It edits the user's source files in place, which means every failure mode has
 * to end with the tree as it was found:
 *
 *   1. Restores and `.bak` cleanup happen in `finally`, so a throw anywhere —
 *      an unreadable suite, a `Ctrl-C`-shaped error, a bug in this script —
 *      cannot leave a mutation behind. The previous version restored on the
 *      normal path only, so one thrown error left a defence deleted in the
 *      working tree and every later run measured the wrong code.
 *   2. The original bytes are hashed before anything is touched and verified
 *      after the last restore. "It looks restored" is not the same claim as
 *      "these are the same bytes", and only the second one is checkable.
 *   3. A test output whose `pass`/`fail` lines cannot be read is never turned
 *      into a number. It used to become `-1`, which then flowed into
 *      comparisons — and `fail === -1` is not `fail === 0`, so a run that never
 *      reported was recorded as a mutation that bit. Unreadable output stops
 *      the run instead.
 *   4. Nothing is mutated until the baseline is green and readable. Mutation
 *      results are only meaningful as a difference from a passing suite; against
 *      a red baseline every mutation "bites" and none of it means anything.
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
  "src/design/scenarioShadow.ts",
  // Not design files, and here for the same reason the others are: the stall
  // detector's blindness to a tool that *throws* and the prohibition forms the
  // runtime could not read were both real regressions, and a fix nothing mutates
  // is a fix nobody has checked is load-bearing.
  "src/agent/loop.ts",
  "src/agent/statedProhibitions.ts",
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
  gold: ["src/design/goldRequirements.test.ts"],
  rules: ["src/design/designRules.test.ts"],
  shadow: ["src/design/scenarioShadow.test.ts"],
  progress: ["src/agent/progress.test.ts"],
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
  // M21 and M22 were re-anchored when the freshness policy split `permissionFor`
  // into explicit branches. Left as they were, both would have reported "치환
  // 문자열 없음" — visible, which is the point of the check that produces it.
  ["M21", "권한 기록 없음을 permitted 로 승격", "src/design/modelPermission.ts",
    'if (evidence === null || found === undefined) return decide("unknown", "never_probed", modelId, null);',
    'if (evidence === null || found === undefined) return decide("permitted", "chat_succeeded", modelId, null);',
    "permission"],
  ["M22", "권한 unknown 을 허용으로", "src/design/modelPermission.ts",
    'return catalogue.filter((id) => permissionFor(evidence, id, now).standing === "permitted");',
    'return catalogue.filter((id) => permissionFor(evidence, id, now).standing !== "denied");', "permission"],
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
  // Re-anchored when `ASKABLE` became a ranked list. The old search string named
  // the end of a `Set` literal that no longer exists, and the script said so
  // rather than reporting a mutation it had not made.
  ["M29", "대상 미결정을 질문하지 않음", "src/design/previewReport.ts",
    '  "TARGET_UNRESOLVED",\n  "SEMANTIC_ALIGNMENT_UNKNOWN",', '  "SEMANTIC_ALIGNMENT_UNKNOWN",', "preview"],
  ["M30", "fullyResolvedRate 를 remediableClosureRate 와 합침", "src/design/previewMetrics.ts",
    "fullyResolvedRate: ratio(\n      results.filter((r) => r.closure.audit.findings.length === 0).length,\n      results.length,\n    ),",
    "fullyResolvedRate: ratio(\n      results.filter((r) => r.closure.unresolved.length === r.closure.audit.findings.length).length,\n      results.length,\n    ),", "metrics"],
  ["M31", "target 미결정 finding 을 제거", "src/design/coverageAudit.ts",
    'if (spec.intent === "confirmed" && spec.binding === "unresolved") {', "if (false) {", "preview"],

  // --- aa0874c 이후 추가된 방어선 -------------------------------------------
  ["M32", "예외를 던진 도구를 진전 관측에서 제외", "src/agent/loop.ts",
    `      observeAction(state.progress, {
        toolName: call.name,
        args,
        outcome: "failed",
        detail,
        changedFiles: [],
      });
      return detail;
    }
  }
}`,
    `      return detail;
    }
  }
}`, "progress"],
  ["M33", "권한 기록 유효기간 제거", "src/design/modelPermission.ts",
    'if (ageMs > PERMISSION_MAX_AGE_MS) return { problem: "expired" };', "", "permission"],
  ["M34", "미래 시각 거부 제거", "src/design/modelPermission.ts",
    'if (ageMs < -PERMISSION_MAX_FUTURE_SKEW_MS) return { problem: "future_dated" };', "", "permission"],
  ["M35", "읽을 수 없는 측정 시각 허용", "src/design/modelPermission.ts",
    'if (!Number.isFinite(at)) return { problem: "unreadable_time" };', "", "permission"],
  ["M36", "실측 403 을 기록에 반영하지 않음", "src/design/modelPermission.ts",
    '    chat: "denied",\n    observedAt: new Date(at).toISOString(),',
    '    chat: "pass",\n    observedAt: new Date(at).toISOString(),', "permission"],
  ["M37", "403 을 받은 모델을 계속 사용", "src/design/modelProposer.ts",
    "        revoked = modelId;", "        revoked = null;", "permission"],
  ["M38", "권한 위조를 span 거부로 집계", "src/design/preview.ts",
    '  if (refused.some((r) => r.reasons.includes("forged_provenance"))) return "provenance_rejected";',
    "", "parse"],

  // --- Gold 기준선과 설계 규칙 -----------------------------------------------
  ["M39", "목적어 구 경계를 무시", "src/design/functionalExtract.ts",
    `    if (token.grammar) {
      if (kept.length === 0) continue;
      break;
    }`,
    `    if (token.grammar) {
      continue;
    }`, "gold"],
  ["M40", "주제 조사가 붙은 앞말도 목적어로", "src/design/functionalExtract.ts",
    "    if (kept.length > 0 && /[은는]$/u.test(token.text)) break;", "", "gold"],
  ["M41", "때를 나타내는 말을 목적어로", "src/design/functionalExtract.ts",
    "|오늘|어제|내일)$/", ")$/", "extract"],
  ["M42", "금지 축약형(하진) 을 다시 놓침", "src/agent/statedProhibitions.ts",
    'const STEM = "하[지진]";', 'const STEM = "하지";', "gold"],
  ["M43", "'하면 안 돼' 금지를 다시 놓침", "src/agent/statedProhibitions.ts",
    'const MYEON_AN = "(?:면|서는)\\\\s*안\\\\s*(?:돼|되|된|됩)(?![^.!。\\\\n]*[?？])";',
    'const MYEON_AN = "(?!)";', "gold"],
  ["M44", "'하면 안 돼' 를 다시 조건으로", "src/design/semanticAlignment.ts",
    "  /라면|이면(?!서)|하면(?!서)(?!\\s*안\\s*(?:돼|되|된|됩))|경우|한해|일\\s*때|if\\b|when\\b|unless\\b/;",
    "  /라면|이면(?!서)|하면(?!서)|경우|한해|일\\s*때|if\\b|when\\b|unless\\b/;", "gold"],
  ["M45", "질문 우선순위를 감사 순서로", "src/design/previewReport.ts",
    "    .sort((a, b) => askRank(a.finding.code) - askRank(b.finding.code) || a.index - b.index);",
    "    .sort((a, b) => a.index - b.index);", "gold"],
  ["M46", "inspect 설계 규칙 제거", "src/design/scenarioBlueprint.ts",
    '  if (spec.act === "inspect") {', "  if (false) {", "rules"],
  ["M47", "preserve 설계 규칙 제거", "src/design/scenarioBlueprint.ts",
    '  if (spec.act === "preserve") {', "  if (false) {", "rules"],
  ["M48", "런타임이 읽은 act 기록 제거", "src/design/requirementSpec.ts",
    "      act: candidate.action,", "", "rules"],
  ["M49", "inspect oracle 에서 읽은 기록 요구 제거", "src/design/scenarioBlueprint.ts",
    "oracle: oracle({ requiredTools: READ_TOOLS, workspaceChanged: false }),",
    "oracle: oracle({ workspaceChanged: false }),", "rules"],
  ["M50", "preserve oracle 에서 실행 증거 요구 제거", "src/design/scenarioBlueprint.ts",
    'oracle: oracle({ requiredTools: ["run_command"], requiredEvidence: ["test_result"] }),',
    "oracle: oracle({}),", "rules"],
  ["M51", "preserve 의 반대 방향 시나리오를 무력화", "src/design/scenarioBlueprint.ts",
    'oracle: oracle({ requiredEvidence: ["test_result"], workspaceChanged: true }),',
    'oracle: oracle({ requiredEvidence: ["test_result"] }),', "rules"],

  // --- Shadow -----------------------------------------------------------------
  ["M52", "금지를 모든 시나리오에서 수집", "src/design/scenarioShadow.ts",
    '          .filter((b) => b.category === "negative" && b.oracleCoverage.includes("no_side_effect"))',
    "", "shadow"],
  ["M53", "대조 문자열을 런타임 문장으로", "src/design/scenarioShadow.ts",
    "        requirements.push(spec.target);", "        requirements.push(spec.text);", "shadow"],
  ["M54", "Shadow 실패를 사용자에게 전파", "src/design/scenarioShadow.ts",
    '    return empty("adapter_failed", {', '    if (err !== null) throw err;\n    return empty("adapter_failed", {',
    "shadow"],
  ["M55", "금지된 도구를 첫 행동으로 제안", "src/design/scenarioShadow.ts",
    "          .filter((tool) => !forbiddenTools.has(tool))", "", "shadow"],
  ["M56", "미해결 중복 제거 제거", "src/design/scenarioShadow.ts",
    "      unresolved: dedupe(unresolved),", "      unresolved,", "shadow"],
];

/** Mutations that are allowed not to bite, with the reason recorded. */
const EXPECTED_SILENT = new Map([
  ["M17", "종료를 보장하는 것은 attempted 중복 방지이므로 pass 상한을 지워도 동작이 같다"],
]);

/** Thrown when a test run produced no readable verdict. Never turned into -1. */
class UnreadableTestOutput extends Error {
  constructor(files, out) {
    const head = out.split("\n").filter((l) => l.trim().length > 0).slice(0, 12).join("\n");
    super(`테스트 출력에서 pass/fail 을 읽지 못했습니다: ${files.join(", ")}\n${head}`);
    this.name = "UnreadableTestOutput";
  }
}

/**
 * Reads a verdict, or refuses to invent one.
 *
 * The old version defaulted both numbers to `-1` on a failed match, and `-1`
 * behaves like a real count everywhere downstream: `fail === 0` is false, so a
 * suite that never reported read as "the mutation was caught". A missing verdict
 * is not a verdict.
 */
function parseVerdict(files, out) {
  const pass = /^ℹ pass (\d+)$/m.exec(out);
  const fail = /^ℹ fail (\d+)$/m.exec(out);
  if (pass === null || fail === null) throw new UnreadableTestOutput(files, out);
  return { pass: Number(pass[1]), fail: Number(fail[1]) };
}

function suite(files = SUITES.demos) {
  let out;
  try {
    out = execFileSync("node", ["--test", ...files], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // A non-zero exit is the ordinary case for a failing suite; its verdict is
    // on stdout exactly as it is on success.
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  return parseVerdict(files, out);
}

/** CRLF to LF. Built from char codes so no escape can be mangled in transit. */
function normalise(text) {
  return text.split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10));
}

/** The bytes on disk, not the text. Restoration is a claim about bytes. */
function digestOf(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
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

// A leftover `.bak` is evidence that a previous run did not finish restoring.
// Overwriting it would destroy the only copy of the original.
const leftovers = FILES.filter((f) => existsSync(`${f}.bak`));
if (leftovers.length > 0) {
  throw new Error(
    `이전 실행이 남긴 .bak 파일이 있습니다. 원본을 확인한 뒤 지우고 다시 실행하십시오: ${leftovers.join(", ")}`,
  );
}

const lines = [];
const say = (s) => {
  lines.push(s);
  process.stdout.write(`${s}\n`);
};

const write = (path) => {
  if (path !== undefined) writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
};

// The baseline comes first, before a single byte is copied or changed.
//
// Every mutation result is a *difference* from this run. Against a red baseline
// each one "bites" for reasons that have nothing to do with the mutation, and
// against an unreadable one there is no number to compare with at all.
let baseline;
try {
  baseline = suite();
} catch (err) {
  say(`기준선 측정 실패: ${err.message}`);
  say("변이를 시작하지 않았습니다. 작업 트리는 그대로입니다.");
  write(process.argv[2]);
  process.exit(2);
}

say(`기준선                                          pass ${baseline.pass}  fail ${baseline.fail}`);
if (baseline.fail !== 0 || baseline.pass === 0) {
  say(
    baseline.pass === 0
      ? "기준선에서 통과한 테스트가 없습니다. 변이를 시작하지 않았습니다."
      : "기준선이 실패했습니다. 변이를 시작하지 않았습니다. 먼저 기준선을 초록으로 만드십시오.",
  );
  write(process.argv[2]);
  process.exit(2);
}
say("-".repeat(78));

/** What the tree held before this script touched it. Verified after restore. */
const original = new Map(FILES.map((f) => [f, digestOf(f)]));
for (const f of FILES) copyFileSync(f, `${f}.bak`);

const restore = () => {
  for (const f of FILES) copyFileSync(`${f}.bak`, f);
};

let notApplied = 0;
let unexpectedlySilent = 0;
let aborted = null;

try {
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

    let result;
    // Per mutation, so one thrown error restores this file before anything else
    // reads it — and so the outer `finally` is never the first restore to run.
    try {
      writeFileSync(file, before.split(from).join(to), "utf8");
      const after = readFileSync(file, "utf8");
      if (normalise(after) === before) {
        say(`${id} ${label.padEnd(34)} !! 파일이 바뀌지 않음 — 변이 미적용`);
        notApplied += 1;
        continue;
      }
      result = suite(SUITES[suiteKey ?? "demos"]);
    } finally {
      restore();
    }

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
} catch (err) {
  // An unreadable suite under a mutation is not a result either. Recorded and
  // the run stops, rather than being averaged into a number.
  aborted = err;
} finally {
  restore();

  // "Restored" is a claim about bytes, so it is checked as one. A file that does
  // not match keeps its `.bak`: that copy is the only remaining route back, and
  // deleting it to satisfy a tidiness rule would be the worst outcome here.
  const mismatched = FILES.filter((f) => digestOf(f) !== original.get(f));
  for (const f of FILES) {
    if (mismatched.includes(f)) continue;
    try {
      unlinkSync(`${f}.bak`);
    } catch (err) {
      say(`.bak 삭제 실패: ${f}.bak — ${err.message}`);
    }
  }

  if (mismatched.length > 0) {
    say("-".repeat(78));
    say(`!! 복원 후 원본과 다른 파일이 있습니다: ${mismatched.join(", ")}`);
    say("   해당 .bak 파일은 복구용으로 남겨 두었습니다.");
    write(process.argv[2]);
    process.exit(3);
  }
}

if (aborted !== null) {
  say("-".repeat(78));
  say(`변이 실행 중단: ${aborted.message}`);
  say("작업 트리는 원본 바이트로 복원되었습니다.");
  write(process.argv[2]);
  process.exit(2);
}

// Not a formality: it is the only thing that shows the numbers above were
// measured against the code that is on disk now.
let after;
try {
  after = suite();
} catch (err) {
  say(`복원 후 측정 실패: ${err.message}`);
  write(process.argv[2]);
  process.exit(2);
}

say("-".repeat(78));
say(`복원 후                                         pass ${after.pass}  fail ${after.fail}`);
say("");
say(`변이 적용          : ${MUTATIONS.length - notApplied} / ${MUTATIONS.length}`);
say(`변이 미적용        : ${notApplied}`);
say(`예상 밖 무반응     : ${unexpectedlySilent}`);
say(`허용된 무반응      : ${[...EXPECTED_SILENT.keys()].join(", ") || "없음"}`);

write(process.argv[2]);
process.exit(notApplied === 0 && unexpectedlySilent === 0 && after.fail === 0 ? 0 : 1);
