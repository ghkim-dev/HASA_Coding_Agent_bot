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
  "src/cli/permissionEvidenceFile.ts",
  // Not design files, and here for the same reason the others are: the stall
  // detector's blindness to a tool that *throws* and the prohibition forms the
  // runtime could not read were both real regressions, and a fix nothing mutates
  // is a fix nobody has checked is load-bearing.
  "src/agent/loop.ts",
  "src/agent/statedProhibitions.ts",
  "src/agent/harnessShadow.ts",
  "src/agent/progressView.ts",
  // C4.9: the continuity layer. Every entry is a defence against a follow-up
  // turn resetting the task, prose masquerading as execution, or markup
  // masquerading as an answer — each one seen live before it was built.
  "src/agent/continuity.ts",
  "src/agent/textTools.ts",
  "src/agent/finalClaims.ts",
  "src/agent/taskReducer.ts",
  "src/agent/session.ts",
  "src/agent/tools/requestTool.ts",
  "src/agent/turnContract.ts",
  // C4.10: contract adoption atomicity and progress truth.
  "src/agent/actionPolicy.ts",
  "src/router/bootstrap.ts",
  // C4.11: the safety invariant — a model-authored anything may not release a
  // prohibition the user stated in their own words.
  //
  // `extension/src/agent/agentHost.ts` is deliberately absent: it imports
  // `vscode`, nothing in `node --test` can load it, and a mutation of it would
  // report "does not bite" for want of a suite rather than for want of a
  // defence.
  //
  // The conversation adoption ordering used to be the thing that note was
  // apologising for. It is now `src/agent/conversationAdoption.ts`, listed
  // below with a suite behind it — the host assigns what that function returns
  // and decides nothing itself. What remains uncovered here is the rest of the
  // host, and that is still an uncovered defence rather than a verified one.
  //
  // `statedProhibitions.ts` belongs to this slice too and is listed once,
  // above with `loop.ts`. It was listed twice until the duplicate produced a
  // spurious cleanup failure — see the uniqueness check below.
  "src/agent/requirementsView.ts",
  "src/agent/issueText.ts",
  "src/agent/sessionLog.ts",
  // C4.12: the designer. Every entry below is a defence against the design
  // claiming something the runtime did not establish.
  "src/design/harnessDesign.ts",
  // The ranker itself, now that a corpus scores it — see recommendationCases.
  "src/router/recommend.ts",
  // C4.14: moving the session onto a stored conversation. Lifted out of
  // `agentHost.ts` for exactly this reason — the note above says a defence
  // that module holds cannot be mutated for want of a suite, and this one
  // now has both.
  "src/agent/conversationAdoption.ts",
  // C4.14: what crosses from the designer to the agent. Every defence here is
  // against the handoff saying something the design did not.
  "src/design/harnessHandoff.ts",
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
  // What is still standing when the conversation stops. A different failure
  // surface from extraction: every turn can be read perfectly while a
  // requirement quietly falls out between two of them.
  conversation: [
    "src/design/mediaConversations.test.ts",
    "src/design/preview.test.ts",
    "src/design/holdoutCases.test.ts",
  ],
  parse: ["src/design/proposalParse.test.ts", "src/design/preview.test.ts"],
  permission: ["src/design/modelPermission.test.ts"],
  extract: [
    "src/design/functionalExtract.test.ts",
    "src/design/preview.test.ts",
    // The generated corpus, in the suite that owns the negation guard. A
    // hand-written case can only forbid what somebody thought to write down;
    // this one puts a prohibition next to its own positive form thousands of
    // times a run, which is the collision the guard exists for.
    "src/design/functionalExtract.fuzz.test.ts",
  ],
  adoptconv: ["src/agent/conversationAdoption.test.ts"],
  handoff: ["src/design/harnessHandoff.test.ts"],
  recall: [
    "src/design/functionalExtract.test.ts",
    "src/design/evalScenarioRecall.test.ts",
    "src/design/extractInvariants.test.ts",
    // The generative-media corpus. Three project topics the extractor had never
    // been asked to read, and the numbers it scores there are what most of the
    // mutations below are measured against.
    "src/design/mediaCases.test.ts",
  ],
  metrics: ["src/design/preview.test.ts"],
  gold: ["src/design/goldRequirements.test.ts"],
  rules: ["src/design/designRules.test.ts"],
  shadow: ["src/design/scenarioShadow.test.ts"],
  holdout: ["src/design/holdoutCases.test.ts"],
  executable: ["src/design/executability.test.ts", "src/design/goldRequirements.test.ts"],
  store: ["src/design/permissionStore.test.ts", "src/design/modelPermission.test.ts"],
  conflict: ["src/design/goldRequirements.test.ts", "src/design/holdoutCases.test.ts"],
  progress: ["src/agent/progress.test.ts"],
  observer: ["src/agent/harnessShadow.test.ts"],
  progressui: ["src/agent/progressView.test.ts"],
  continuity: ["src/agent/continuity.test.ts"],
  textproto: ["src/agent/textTools.test.ts"],
  claims: ["src/agent/finalClaims.test.ts"],
  loop: ["src/agent/loop.test.ts"],
  sessioncont: ["src/agent/session.test.ts"],
  contuiplus: ["src/agent/progressView.test.ts", "src/agent/continuity.test.ts"],
  contract: ["src/agent/turnContract.test.ts", "src/agent/continuity.test.ts"],
  adoption: ["src/agent/contractAdoption.test.ts"],
  adoptionui: ["src/agent/contractAdoption.test.ts", "src/agent/progressView.test.ts"],
  safety: [
    "src/agent/contractAdoption.test.ts",
    "src/agent/statedProhibitions.test.ts",
    // The generated prohibition corpus. It is here because it catches what the
    // hand-written file next to it does not: reverting either of the two stem
    // widenings — the `하진` contraction and the particle before the negation —
    // leaves that file green and turns this one red.
    "src/agent/statedProhibitions.fuzz.test.ts",
  ],
  prohibit: [
    "src/agent/statedProhibitions.test.ts",
    "src/agent/contractAdoption.test.ts",
    "src/agent/statedProhibitions.fuzz.test.ts",
  ],
  issues: ["src/agent/requirementsView.test.ts"],
  replaylog: ["src/agent/contractReplay.test.ts"],
  designer: ["src/design/harnessDesign.test.ts"],
  recommend: ["src/design/recommendationCases.test.ts"],
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
      if (run.length === 0) continue;
      break;
    }`,
    `    if (token.grammar) {
      continue;
    }`, "gold"],
  ["M41", "때를 나타내는 말을 목적어로", "src/design/functionalExtract.ts",
    "|오늘|어제|내일|왜", "|왜", "extract"],
  // Repointed when `STEM` gained the particle slot — the line it names is the
  // same defence, and only the contraction is taken away here. M185 removes the
  // other half of the same line; the two do not overlap.
  ["M42", "금지 축약형(하진) 을 다시 놓침", "src/agent/statedProhibitions.ts",
    'const STEM = "하[지진](?:[는도를은])?";', 'const STEM = "하지(?:[는도를은])?";', "gold"],
  ["M43", "'하면 안 돼' 금지를 다시 놓침", "src/agent/statedProhibitions.ts",
    'const MYEON_AN = "(?:면|서는)\\\\s*안\\\\s*(?:돼|되|된|됩)(?![^.!。\\\\n]*[?？])";',
    'const MYEON_AN = "(?!)";', "gold"],
  // Anchored on the alternation rather than on the whole lookahead: a search
  // string carrying `\s` has to survive being written, read and compared, and one
  // lost backslash turns this into a mutation that silently never applies. The
  // negation's alternatives are unique in this file and contain no escapes, and
  // emptying them makes the lookahead vacuous — which is exactly the old bug.
  ["M44", "'하면 안 돼' 를 다시 조건으로", "src/design/semanticAlignment.ts",
    "(?:돼|되|된|됩)", "(?:x)", "gold"],
  ["M45", "질문 우선순위를 감사 순서로", "src/design/previewReport.ts",
    "    .sort((a, b) => askRank(a.finding.code) - askRank(b.finding.code) || a.index - b.index);",
    "    .sort((a, b) => a.index - b.index);", "executable"],
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
  // `about` must not go back to counting something other than the array. Written
  // as a second, unfolded list so the sentence and the data disagree again.
  ["M56", "미해결 개수를 중복 제거 전 값으로", "src/design/scenarioShadow.ts",
    "        `설계 규칙 ${sorted(rules).length}개, 미해결 ${unresolved.length}건.`,",
    "        `설계 규칙 ${sorted(rules).length}개, 미해결 ${unresolved.length + 1}건.`,",
    "shadow"],

  // --- PHASE A~G: 실행 판정·충돌·403·질문·Shadow·Holdout ----------------------
  ["M57", "사용자 요구사항 0개인데 실행 허용", "src/design/coverageAudit.ts",
    '  if (!live.some((spec) => spec.status !== "system_added")) {', "  if (false) {", "executable"],
  ["M58", "system_added 만으로 mayExecute 허용", "src/design/preview.ts",
    "    closure.audit.ok && ownRequirements.some((spec) => executionReadiness(spec) === \"ready\");",
    "    closure.audit.ok;", "executable"],
  ["M59", "막힌 계획에도 도구 실행 계획을 남김", "src/design/preview.ts",
    "  const plannedTools = mayExecute", "  const plannedTools = closure.audit.ok || true", "executable"],
  ["M60", "rename 과 preserve 충돌 무시", "src/design/requirementSpec.ts",
    "      if (actsCollide(a, b)) {", "      if (false) {", "conflict"],
  ["M61", "대상이 달라도 충돌로 오판", "src/design/requirementSpec.ts",
    "  return sameTargetPhrase(a.target, b.target);", "  return true;", "conflict"],
  ["M62", "머리 명사가 달라도 같은 대상으로 취급", "src/design/requirementSpec.ts",
    "  if (a.head.length === 0 || a.head !== b.head) return false;", "  if (a.head.length === 0) return false;",
    "conflict"],
  ["M63", "403 을 저장소에 기록하지 않음", "src/design/modelProposer.ts",
    "        if (options.store !== undefined && permission !== null) {", "        if (false) {", "store"],
  ["M64", "403 기록을 다음 프로세스가 읽지 않음", "src/cli/permissionEvidenceFile.ts",
    "      for (const fact of mine.models) merged.set(fact.modelId, fact);", "", "store"],
  ["M65", "403 후 다른 모델로 자동 우회", "src/design/modelProposer.ts",
    "        revoked = modelId;", "        revoked = null;", "store"],
  ["M66", "server_forbidden 을 만료로 되돌림", "src/design/modelPermission.ts",
    '  if (found.chat === "denied" && !("problem" in age && age.problem !== "expired")) {',
    '  if (found.chat === "denied" && !("problem" in age)) {', "store"],
  // Hiding the finding behind a rule id is M14 and M15; this is the other
  // direction — the five act rules removed at once, so every one of those
  // requirements falls back to `generic` and the audit says so again.
  ["M67", "act 규칙 다섯 개를 한꺼번에 제거", "src/design/scenarioBlueprint.ts",
    "  if (actRule !== null) return actRule;", "  if (false) return actRule ?? [];", "rules"],
  ["M68", "질문을 전부 제거해 precision 을 만듦", "src/design/previewReport.ts",
    "  for (const { finding } of askable) {", "  for (const { finding } of []) {", "executable"],
  ["M69", "절 종결 어미를 마지막 음절로 판정", "src/design/functionalExtract.ts",
    "const CLAUSE_ENDING = /(?:[하되지으우이라]면|[해어아여]서|[하되이]며|는지|은지|을지|인지)$/u;",
    "const CLAUSE_ENDING = /(?:면|서|며|지)$/u;", "holdout"],
  ["M70", "관형형 수식어를 다시 버림", "src/design/functionalExtract.ts",
    '    const bare = out.replace(/[은는만이가]$/u, "");',
    '    const bare = out;', "conflict"],
  ["M71", "'가능하면' 을 다시 조건으로", "src/design/semanticAlignment.ts",
    "/(?<!가능)(?:", "/(?:", "holdout"],

  // --- 제품 경로에 붙은 Shadow Observer --------------------------------------
  // Reaching back into the production outcome is the one thing this observer must
  // never do, so the mutation does exactly that: writes the loop's stop reason
  // from the shadow's own verdict.
  ["M72", "Shadow 결과를 Production 결정에 반영", "src/agent/harnessShadow.ts",
    "    const mapped = shadowScenarioFrom({ id: `shadow-${input.turnId}`, preview });",
    '    input.production.reason = preview.mayExecute ? input.production.reason : "no_progress";\n' +
      "    const mapped = shadowScenarioFrom({ id: `shadow-${input.turnId}`, preview });",
    "observer"],
  ["M73", "Shadow 실패를 사용자 턴으로 전파", "src/agent/harnessShadow.ts",
    "    return base(empty, [], err instanceof Error",
    "    if (err !== null) throw err;\n    return base(empty, [], err instanceof Error",
    "observer"],
  ["M74", "Production 과의 차이를 기록하지 않음", "src/agent/harnessShadow.ts",
    '      differences.push("production_changed_files_while_design_withheld_execution");', "",
    "observer"],
  ["M75", "관찰 기록에서 요구사항 출처를 제거", "src/agent/harnessShadow.ts",
    "        requirementSources: mapped.requirementSources,", "        requirementSources: [],",
    "observer"],

  // --- UX1: 관측 가능한 진행 상태 ---------------------------------------------
  // The reported screen, as a mutation: a turn that ended reads as one still
  // running. This is the defect `progressView` was written for.
  ["M76", "끝난 turn 을 계속 진행 중으로", "src/agent/progressView.ts",
    "  if (input.terminalReason !== null) {", "  if (false) {", "progressui"],
  ["M77", "session 존재만으로 진행 중 표시", "src/agent/progressView.ts",
    "        return input.terminalReason === \"finished\" ? \"partial\" : \"failed\";",
    "        return \"executing\";", "progressui"],
  ["M78", "provider 오류 후에도 진행 중 유지", "src/agent/progressView.ts",
    '        return "failed";', '        return "executing";', "progressui"],
  ["M79", "같은 event 를 두 번 렌더", "src/agent/progressView.ts",
    "    if (seen.has(event.id)) continue;", "    if (false) continue;", "progressui"],
  ["M80", "보류를 실행 중으로 표시", "src/agent/progressView.ts",
    '      return "DEFERRED";', '      return "EXECUTING";', "progressui"],
  ["M81", "정책 거부를 실행 실패로", "src/agent/progressView.ts",
    '      return "DENIED";', '      return "FAILED";', "progressui"],
  ["M82", "replay 의 과거 활동을 현재 활동으로", "src/agent/progressView.ts",
    "  const lastActivityAt = turn.events.reduce((latest, e) => Math.max(latest, e.at), startedAt);",
    "  const lastActivityAt = input.now;", "progressui"],
  ["M83", "형제 branch 의 action 까지 수집", "src/agent/progressView.ts",
    "  const actions = actionsFrom(turn.events);", "  const actions = actionsFrom(input.events);",
    "progressui"],
  ["M84", "계획 없음의 이유를 뭉갬", "src/agent/progressView.ts",
    '  if (hadProtocolProblem(input.turnEvents)) return "protocol_error";', "", "progressui"],
  ["M85", "내부 protocol 이름을 그대로 노출", "src/agent/progressView.ts",
    '      return { kind: "interpreted", text: "요청 분석 완료" };',
    '      return { kind: "interpreted", text: `record_request: ${event.type}` };', "progressui"],
  ["M87", "시간 경과만으로 turn 을 종료 처리", "src/agent/progressView.ts",
    "  if (input.idleMs > STALL_DISPLAY_MS) return \"stalled\";", "  if (input.idleMs > 0) return \"failed\";",
    "progressui"],
  // ---- C4.9: multi-turn continuity & grounded execution -------------------
  ["M88", "relation guard 전체 해제 — 모든 후속 턴을 모델 판정대로", "src/agent/continuity.ts",
    "  const hasPriorTask = opts.priorTask.lastTurnId.length > 0;",
    "  const hasPriorTask = false;", "continuity"],
  ["M89", "bare continuation 인식 제거", "src/agent/continuity.ts",
    "  return CONTINUATION_SHAPES.some((shape) => shape.test(body));",
    "  return false;", "continuity"],
  ["M90", "status question 인식 제거", "src/agent/continuity.ts",
    "  return STATUS_SHAPES.some((shape) => shape.test(body));",
    "  return false;", "continuity"],
  ["M91", "같은 작업 재진술을 새 작업으로", "src/agent/continuity.ts",
    "  return restated / incoming.length >= 0.6;",
    "  return false;", "continuity"],
  ["M92", "interpreter 에 history 를 주지 않음", "src/agent/continuity.ts",
    "  return history.slice(-HISTORY_TURN_LIMIT * 2);",
    "  return [];", "continuity"],
  ["M93", "선언용 도구를 실행 실적으로 계산", "src/agent/continuity.ts",
    '    if (event.type !== "tool_completed" || DECLARATIVE_TOOLS.has(event.toolName)) continue;',
    '    if (event.type !== "tool_completed") continue;', "continuity"],
  ["M94", "빈 턴 반복 challenge 제거", "src/agent/continuity.ts",
    "  if (barren < BARREN_TURN_CHALLENGE_AT) return null;",
    "  return null;", "continuity"],
  ["M95", "설명 번복 탐지 제거", "src/agent/continuity.ts",
    "      if (notStarted) {",
    "      if (false) {", "contuiplus"],
  ["M96", "번복 사이의 evidence 를 무시", "src/agent/continuity.ts",
    "          if (observedBetween) continue;",
    "", "continuity"],
  ["M97", "<function=…> 호출을 프로즈로 취급", "src/agent/textTools.ts",
    "  const fnEnvelope = chosen === null && envelope === null ? readFunctionEnvelope(text, byName) : null;",
    "  const fnEnvelope = null;", "textproto"],
  ["M98", "function markup 을 답변에 그대로 노출", "src/agent/textTools.ts",
    String.raw`  out = out.replace(/<function\s*=\s*["']?[\w.-]+["']?\s*>[\s\S]*?<\/function>/gi, "");`,
    "", "textproto"],
  ["M99", "진행형 활동 주장 게이트 제거", "src/agent/finalClaims.ts",
    "    if (ACTIVITY_CLAIM.test(sentence)) {",
    "    if (false) {", "claims"],
  ["M100", "모니터링 약속 게이트 제거", "src/agent/finalClaims.ts",
    "    if (MONITORING_PROMISE.test(sentence)) {",
    "    if (false) {", "claims"],
  ["M101", "실행 기록 없이 학습 완료 허용", "src/agent/finalClaims.ts",
    "    if (TRAINING_CLAIM.test(sentence) && !NEGATED_COMPLETION.test(sentence) && !hasAnyRun(task)) {",
    "    if (false) {", "claims"],
  ["M102", "protocol_error 를 finished 로 종료", "src/agent/loop.ts",
    '          return "protocol_error";',
    '          return "finished";', "loop"],
  ["M103", "protocol 봉쇄를 통째로 제거", "src/agent/loop.ts",
    "        if (state.executed === 0 && completion.text.trim().length === 0) {",
    "        if (false) {", "loop"],
  ["M104", "worker 의 중복 record_request 허용", "src/agent/tools/requestTool.ts",
    "      if (opts.alreadyRecorded?.() === true) {",
    "      if (false) {", "sessioncont"],
  ["M105", "턴 시작 런타임 기록 주입 제거", "src/agent/session.ts",
    "    const opening = this.opts.turnOpening?.() ?? null;",
    "    const opening = null;", "sessioncont"],
  ["M106", "worker 경로의 relation guard 제거", "src/agent/session.ts",
    "          const guarded = guardRelation(contract, {",
    "          const guarded = { contract, override: null } ?? guardRelation(contract, {", "sessioncont"],
  ["M107", "plan grounded cursor 를 모델 주장으로", "src/agent/progressView.ts",
    "          groundedCurrent: groundedCursor(plan.steps, task),",
    "          groundedCurrent: plan.current,", "progressui"],
  ["M108", "continue 병합이 계약을 교체", "src/agent/turnContract.ts",
    '  if (turn.relation === "continue" || turn.relation === "question") {',
    '  if (false) {', "contract"],
  ["M109", "모델 프로즈로 요구사항 상태 이동", "src/agent/taskReducer.ts",
    '      task.requirements.push({ id, description, status: "pending", required: true, evidence: [] });',
    '      task.requirements.push({ id, description, status: "passed", required: true, evidence: [] });',
    "contuiplus"],
  // ---- C4.10: contract adoption atomicity & progress truth -----------------
  // M110/M111 lived here and were retired in C4.11: the gate's
  // `recordedThisTurn` override became provably identical to its own
  // `contract.lastTurnId === turnId` comparison, so removing it changed
  // nothing. A defence a mutation cannot distinguish from its absence is not a
  // defence, and the parameter went with it.
  ["M113", "호출자의 turn id 를 버리고 자체 id 사용", "src/agent/session.ts",
    "    this.turnId = opts.turnId ?? `t${this.turnOrdinal++}`;",
    "    this.turnId = `t${this.turnOrdinal++}`;", "adoption"],
  ["M118", "요구 절 커버리지 검사 제거", "src/agent/continuity.ts",
    "  if (clauses.length <= 1) return [];",
    "  return [];", "adoptionui"],
  ["M119", "한 단어 겹침을 커버로 인정", "src/agent/continuity.ts",
    "      return hits >= 2;", "      return hits >= 1;", "adoption"],
  ["M120", "bootstrap 교정 라운드 생략", "src/router/bootstrap.ts",
    "      const clean = stillUnclassified.length === 0 && conflicts.length === 0 && gaps.length === 0;",
    "      const clean = true;", "adoption"],
  ["M121", "plan 없이 계획 단계 완료", "src/agent/progressView.ts",
    '  const planStep: StepState = input.hasPlan ? "done" : "not_started";',
    '  const planStep: StepState = "done";', "progressui"],
  ["M122", "보류를 실행 완료로 표시", "src/agent/progressView.ts",
    '        ? "blocked"', '        ? "done"', "progressui"],
  ["M123", "evidence 0 인데 검증 단계 완료", "src/agent/progressView.ts",
    '  const verify: StepState = verified ? "done" : "not_started";',
    '  const verify: StepState = "done";', "progressui"],
  ["M125", "요구사항 단계의 warning 억제", "src/agent/progressView.ts",
    '        ? "warning"', '        ? "done"', "progressui"],
  ["M126", "동일 실패를 매번 새 이슈로", "src/agent/taskReducer.ts",
    "  if (same !== undefined) {", "  if (false) {", "adoption"],
  ["M127", "검증 단계가 오래된 증거를 인정", "src/agent/progressView.ts",
    '    (e) => VERIFYING_EVIDENCE.has(e.kind) && e.status === "passed" && e.at >= changedAt,',
    '    (e) => VERIFYING_EVIDENCE.has(e.kind) && e.status === "passed",', "progressui"],
  ["M128", "이전 턴의 제약이 다음 턴으로 누출", "src/agent/turnContract.ts",
    "    constraints: turn.constraints,",
    "    constraints: [...task.constraints, ...turn.constraints],", "adoption"],
  // ---- C4.11: a model may not release what the user forbade ---------------
  ["M129", "사용자 원문 research 2차 방어선 제거", "src/agent/statedProhibitions.ts",
    '  if (RESEARCH_DIRECT.test(text)) out.add("research");', "", "safety"],
  ["M130", "research 클래스가 웹 도구를 덮지 않음", "src/agent/statedProhibitions.ts",
    '  research: ["web_search", "web_fetch"],', "  research: [],", "prohibit"],
  ["M132", "사용자 금지보다 모델 goal 을 우선", "src/agent/turnContract.ts",
    "  if (forbids) return { verdict: \"user_forbids\", constraints: banning, forbiddenBy };",
    "  if (demandMatch !== null) return { verdict: \"model_only\", constraints: banning };", "safety"],
  ["M133", "제약 인용 근거 검사 제거", "src/agent/turnContract.ts",
    "  const grounded = banning.some((c) => quotesUser(c.text, opts.userText));",
    "  const grounded = false;", "safety"],
  ["M135", "미판정 충돌을 허용으로", "src/agent/turnContract.ts",
    '  return decision.verdict === "none" || decision.verdict === "model_only";',
    "  return true;", "safety"],
  ["M136", "격리 대신 삭제로 되돌림", "src/agent/turnContract.ts",
    "        quarantine.has(c) ? { ...c, quarantined: true as const } : c,",
    "        c,", "safety"],
  ["M137", "게이트가 격리를 무시하고 강제", "src/agent/actionPolicy.ts",
    "    if (constraint.quarantined === true) continue;", "", "safety"],
  ["M138", "게이트가 research 결정을 무시", "src/agent/session.ts",
    "        if (!researchAllowed(this.researchDecision) && WEB_TOOLS.has(toolName)) {",
    "        if (false) {", "safety"],
  ["M139", "turnId 일치 검사 제거 — 마커가 아무 턴이나 연다", "src/agent/session.ts",
    "    const byHost = this.contractRecordedForTurn !== null && this.contractRecordedForTurn === this.turnId;",
    "    const byHost = this.contractRecordedForTurn !== null;", "adoption"],
  ["M140", "mismatch 에서 게이트를 연다", "src/agent/session.ts",
    "    return { recorded: byFold, mismatch: byHost && !byFold };",
    "    return { recorded: byFold || byHost, mismatch: byHost && !byFold };", "adoption"],
  ["M141", "대화 이동 시 마커가 살아남음", "src/agent/session.ts",
    "    this.contractRecordedForTurn = null;", "", "adoption"],
  ["M143", "requestTool 이 제안 계약을 설명", "src/agent/tools/requestTool.ts",
    "      const adopted = opts.onContract(parsed.contract) ?? null;",
    "      const adopted = (opts.onContract(parsed.contract), null);", "safety"],
  ["M144", "검증 단계를 대화 전체 evidence 로 되돌림", "src/agent/progressView.ts",
    '  const turnTask = reduceTask(input.turnEvents, "turn");', "  const turnTask = input.task;", "progressui"],
  ["M145", "runtime 응답을 해석 실패로 표시", "src/agent/progressView.ts",
    '  const runtimeAnswered = input.turnEvents.some((e) => e.type === "runtime_answer");',
    "  const runtimeAnswered = false;", "progressui"],
  ["M146", "blocked/partial 종료를 failed 로 합침", "src/agent/progressView.ts",
    '        : disposition === "partial"', "        : false", "progressui"],
  ["M147", "이전 턴 요구사항으로 이번 턴을 완료 처리", "src/agent/progressView.ts",
    "    : !hasContractHere", "    : false", "progressui"],
  ["M148", "내부 프로토콜 코드를 그대로 노출", "src/agent/issueText.ts",
    "  const found = CODES.find((entry) => detail.includes(entry.code));",
    "  const found = undefined;", "issues"],
  ["M149", "반복 횟수 표시 제거", "src/agent/requirementsView.ts",
    "      ...((i.count ?? 1) > 1 ? { count: i.count } : {}),", "", "issues"],
  // ---- C4.11b: what the adversarial review found in C4.11 -----------------
  ["M150", "정중한 의문형 금지를 무력화 (절 전체 ? 억제)", "src/agent/statedProhibitions.ts",
    "const ASKING_WHETHER = \"(?!\\\\s*(?:아야|아도|까)?\\\\s*(?:하나요|할까요|되나요|될까요|한가요|하죠|해요)?\\\\s*[?？])\";",
    "const ASKING_WHETHER = \"(?![^.!。\\n]*[?？])\";", "prohibit"],
  ["M151", "명사+말고/대신 금지형 제거", "src/agent/statedProhibitions.ts",
    "    `${WEB}(?:\\\\s*검색|\\\\s*조사)?(?:도|은|는|을|를|만)?\\\\s*(?:말고|말구|대신(?:에)?)`,", "", "safety"],
  ["M152", "부정 절 구조 가드 제거 — 금지문이 요구로 읽힘", "src/agent/turnContract.ts",
    "    if (isNegativeClause(clause)) continue;", "", "safety"],
  ["M154", "금지 형태(shape) 최후 방어선 제거", "src/agent/turnContract.ts",
    "  const forbids = stated || grounded || shapedAsBan;",
    "  const forbids = stated || grounded;", "safety"],
  ["M155", "격리 표시가 fold 를 넘지 못함", "src/agent/turnContract.ts",
    '      ...(item["quarantined"] === true ? { quarantined: true as const } : {}),', "", "safety"],
  ["M156", "격리된 제약을 패널이 강제됨으로 표시", "src/agent/requirementsView.ts",
    "      enforced: c.quarantined !== true && ENFORCED.has(c.kind),",
    "      enforced: ENFORCED.has(c.kind),", "issues"],
  ["M157", "runtime_answer 를 replay 에서 폐기", "src/agent/sessionLog.ts",
    '  "runtime_answer",', "", "replaylog"],
  ["M158", "내부 코드 일부만 치환", "src/agent/issueText.ts",
    "    text = text.split(entry.code).join(\" \");",
    "    text = text.replace(entry.code, \" \");", "issues"],
  // ---- C4.12: the designer says only what it established ------------------
  ["M159", "못 읽은 요청을 이해한 것으로 표시", "src/design/harnessDesign.ts",
    "  const understood = stated.length > 0;",
    "  const understood = true;", "designer"],
  ["M160", "못 읽은 요청에도 모델을 추천", "src/design/harnessDesign.ts",
    "    !understood || input.models === undefined || input.models.length === 0",
    "    input.models === undefined || input.models.length === 0", "designer"],
  ["M161", "요약이 못 읽었다는 사실을 숨김", "src/design/harnessDesign.ts",
    "  if (!design.understood) {",
    "  if (false) {", "designer"],
  ["M162", "baseline 을 사용자 요구사항으로 셈", "src/design/harnessDesign.ts",
    "  const stated = design.requirements.filter((r) => r.status !== \"system_added\").length;",
    "  const stated = design.requirements.length;", "designer"],
  ["M163", "baseline 을 계약에 밀어넣어 복잡도 왜곡", "src/design/harnessDesign.ts",
    "    if (spec.status === \"system_added\") continue;",
    "", "designer"],
  ["M164", "unresolved 를 다시 텍스트로 키잉 (죽은 필드)", "src/design/harnessDesign.ts",
    "      unresolved: standing.filter((r) => unresolvedSubjects.has(r.id)).length,",
    "      unresolved: standing.filter((r) => unresolvedSubjects.has(r.text)).length,", "designer"],
  ["M165", "웹 수요를 자체 명사 스캔으로 되돌림", "src/design/harnessDesign.ts",
    "    statedResearchDemand(text) !== null &&",
    "    /웹|검색|최신/.test(text) &&", "designer"],
  ["M166", "금지가 같은 요청의 act 를 다시 삭제", "src/design/harnessDesign.ts",
    "  if (intents.size === 0) intents.add(\"inspect\");",
    "  if (forbidden.has(\"no_modify\")) intents.delete(\"modify\");\n  if (intents.size === 0) intents.add(\"inspect\");", "designer"],
  ["M167", "디자이너가 금지 형태 최후 방어선을 잃음", "src/design/harnessDesign.ts",
    "    !looksLikeResearchBan(text)",
    "    true", "designer"],
  // ---- C4.13: the recommender, against its own denominator ----------------
  ["M168", "능력 수요를 무시하고 모든 능력을 동등 취급", "src/router/recommend.ts",
    "    if (demand <= 0) continue;",
    "    if (false) continue;", "recommend"],
  ["M169", "측정된 능력치를 읽지 않음 — 모두 중립값", "src/router/recommend.ts",
    "    weighted += demand * (known?.value ?? 0.5);",
    "    weighted += demand * 0.5;", "recommend"],
  ["M170", "능력 항을 점수에서 제거", "src/router/recommend.ts",
    "      weights.capability * capability +",
    "      0 * capability +", "recommend"],
  ["M171", "적격 필터를 건너뜀 — 못 쓰는 모델도 후보", "src/router/recommend.ts",
    "  const { eligible, filteredOut } = filterEligible(profiles, task);",
    "  const { eligible, filteredOut } = { eligible: [...profiles], filteredOut: [] };", "recommend"],
  // ---- C4.14: what the designer reads back, and how much of it -----------
  ["M172", "나열을 두 토큰에서 다시 자름", "src/design/functionalExtract.ts",
    "  const kept = coordinated ? run : units.slice(-2).join(\" \").split(/\\s+/);",
    "  const kept = units.slice(-2).join(\" \").split(/\\s+/);", "recall"],
  ["M173", "범위 조사를 다시 위치로 읽음", "src/design/functionalExtract.ts",
    "      ? token.replace(/(?:안에서만|에서만|에서|안에)$/u, \"\")",
    "      ? token.replace(/(?:안에서만|에서만|에서|안에|까지|부터)$/u, \"\")", "recall"],
  ["M174", "사용자 동사를 버리고 분류 대표어로 씀", "src/design/functionalExtract.ts",
    "          : `${shown}${objectParticle(shown)} ${manner === \"\" ? \"\" : `${manner} `}${phrase ?? ACTION_TEXT[action]}`;",
    "          : `${shown}${objectParticle(shown)} ${manner === \"\" ? \"\" : `${manner} `}${ACTION_TEXT[action]}`;", "recall"],
  ["M175", "`-라는 게 아니라` 정정을 요청으로 읽음", "src/design/functionalExtract.ts",
    "  /(?:지|진)(?:는|도|를|은)?\\s*(?:마|말|않|못|안)|(?:면|서는)\\s*안|(?:라|다|자|란)는?\\s*(?:게|것이|건|말이)\\s*아니/;",
    "  /(?:지|진)(?:는|도|를|은)?\\s*(?:마|말|않|못|안)|(?:면|서는)\\s*안/;", "extract"],
  ["M176", "접속 조사 뒤에 이어질 말이 없어도 나열로 봄", "src/design/functionalExtract.ts",
    "  const coordinated = run.some((token, i) => i < run.length - 1 && COORDINATOR.test(token));",
    "  const coordinated = run.some((token) => COORDINATOR.test(token));", "recall"],
  // ---- C4.14: which conversation is open, in one place --------------------
  ["M177", "이전 대화의 미전송 이벤트를 새 대화로 넘김", "src/agent/conversationAdoption.ts",
    "    pendingEvents: [],",
    "    pendingEvents: [...(stored.events ?? [])],", "adoptconv"],
  ["M178", "저장된 메시지 배열을 그대로 넘겨줌", "src/agent/conversationAdoption.ts",
    "    pendingRestore: [...stored.messages],",
    "    pendingRestore: stored.messages,", "adoptconv"],
  ["M179", "다음 턴 id 를 턴 그래프만 보고 셈 — 빈 그래프면 0", "src/agent/conversationAdoption.ts",
    `    turnOrdinal: Math.max(
      stored.turns?.length ?? 0,
      new Set(recorded.map((event) => event.turnId)).size,
    ),`,
    "    turnOrdinal: stored.turns?.length ?? new Set(recorded.map((e) => e.turnId)).size,", "adoptconv"],
  ["M180", "작업 폴더를 대화가 아니라 창에서 가져옴", "src/agent/conversationAdoption.ts",
    "    boundRoot: stored.workspace?.boundRoot ?? null,",
    "    boundRoot: null,", "adoptconv"],
  // ---- C4.14: the handoff, and what it refuses to carry -------------------
  ["M181", "설계가 읽지 못한 요청도 조용히 넘김", "src/design/harnessHandoff.ts",
    "  if (!design.understood) {",
    "  if (false) {", "handoff"],
  ["M182", "미정 질문을 넘기기 전에 알리지 않음", "src/design/harnessHandoff.ts",
    "  for (const question of design.questions) {",
    "  for (const question of []) {", "handoff"],
  ["M183", "동점을 숨기고 임의 선택을 추천으로 제시", "src/design/harnessHandoff.ts",
    "  if (tied.length > 0) {",
    "  if (false) {", "handoff"],
  ["M184", "원문 대신 설계가 이해한 것을 넘김", "src/design/harnessHandoff.ts",
    "    prompt: text,",
    "    prompt: design.requirements.map((r) => r.text).join(\" \"),", "handoff"],
  // ---- C4.14: the prohibition forms a generated corpus found ---------------
  ["M185", "부정 앞의 조사를 다시 놓침 (하지는 마세요)", "src/agent/statedProhibitions.ts",
    "const STEM = \"하[지진](?:[는도를은])?\";",
    "const STEM = \"하[지진]\";", "prohibit"],
  // ---- C4.15: the designer on a domain it had never read --------------------
  ["M186", "`으로` 에서 `로` 만 떼어 조각을 남김", "src/design/functionalExtract.ts",
    "    kept[lastAt] = (kept[lastAt] ?? \"\").replace(/(?:까지|부터|으로|만|[이가은는의로])$/u, \"\");",
    "    kept[lastAt] = (kept[lastAt] ?? \"\").replace(/(?:까지|부터|만|[이가은는의로])$/u, \"\");", "recall"],
  ["M187", "도구격 구를 대상에 다시 붙임", "src/design/functionalExtract.ts",
    "    const located = !marksItsObject",
    "    const located = true", "recall"],
  ["M188", "측정 명사에서 `도` 를 조사로 떼어냄", "src/design/functionalExtract.ts",
    "    if (out.endsWith(\"도\") && dropped.length >= 2 && !MEASURE_NOUN.test(out)) out = dropped;",
    "    if (out.endsWith(\"도\") && dropped.length >= 2) out = dropped;", "recall"],
  ["M189", "관형절의 동사를 명사구의 일부로 봄", "src/design/functionalExtract.ts",
    "        VERB_ADNOMINAL.test(token),",
    "        false,", "recall"],
  ["M190", "수사+단위를 두 낱말로 세어 대상을 자름", "src/design/functionalExtract.ts",
    "    if (NUMERAL.test(token) && next !== undefined) {",
    "    if (false && next !== undefined) {", "recall"],
  ["M191", "`-ㄹ 수 있게 해줘` 를 다시 읽지 못함", "src/design/functionalExtract.ts",
    "    const clause = plainImperative(source);",
    "    const clause = source;", "recall"],
  ["M192", "조건절의 동사를 요청으로 읽음", "src/design/functionalExtract.ts",
    "    const preferred = ordered.filter((found) => !conditional(found.match));",
    "    const preferred = ordered;", "recall"],
  ["M193", "목적어 표시를 문장 끝에서만 찾음", "src/design/functionalExtract.ts",
    "    if (/[을를]$/u.test(token)) {",
    "    if (/[을를]$/u.test(token) && i === beforeTokens.length - 1) {", "recall"],
  ["M194", "조건절을 넘어가서 목적어를 가져옴", "src/design/functionalExtract.ts",
    "    if (CLAUSE_ENDING.test(token) || conditionalVerbToken(token)) break;",
    "    if (false) break;", "recall"],
  ["M195", "맨 수식어를 대상으로 삼음", "src/design/functionalExtract.ts",
    "  if (!runMarked && trailing?.grammar === true && trailing.carriesNoun) run.length = 0;",
    "  if (false) run.length = 0;", "recall"],
  // ---- C4.16: what survives the conversation --------------------------------
  ["M196", "표지 없는 후속 턴을 다시 새 작업으로 (앞 요구사항 전부 폐기)", "src/design/preview.ts",
    "  return \"refine\";\r",
    "  return \"new_task\";", "conversation"],
  ["M197", "새 작업 표지를 무시 — 주제를 바꿔도 이어붙임", "src/design/preview.ts",
    "  if (/이제\\s*(?:완전히\\s*)?다른|다른\\s*걸|새로운?\\s*(?:작업|일|주제)|그건\\s*됐고|잊(?:어|고)|forget (?:that|it)|new task|different task|instead,? let'?s/i.test(text)) {\r",
    "  if (false) {", "conversation"],
  ["M198", "`아니,` 로 시작하는 정정을 놓침", "src/design/preview.ts",
    "    /^\\s*아니[,\\s]/u.test(text)\r",
    "    false", "conversation"],
  ["M200", "철회된 행위가 서 있는 요구사항을 물러나게 하지 못함", "src/design/requirementSpec.ts",
    "      (spec.act !== undefined && withdrawn.has(spec.act));",
    "      false;", "conversation"],
  ["M201", "부정된 동사를 철회로 보고하지 않음", "src/design/functionalExtract.ts",
    "        out.add(action);",
    "        void action;", "conversation"],
];

/** Mutations that are allowed not to bite, with the reason recorded. */
const EXPECTED_SILENT = new Map([
  [
    "M168",
    "demand<=0 인 능력은 분자에 0*value 를, 분모에 0 을 더하므로 건너뛰든 아니든 " +
      "capabilityScore 의 값이 같다 — 산술적으로 동등한 변이다",
  ],
  [
    "M146",
    "partial 은 termination 이 finished 일 때만 도달 가능한데(taskDisposition), 그 경우 아래 " +
      "finished 분기도 같은 warning 을 돌려주므로 분기를 지워도 결과가 같다",
  ],
  ["M17", "종료를 보장하는 것은 attempted 중복 방지이므로 pass 상한을 지워도 동작이 같다"],
  [
    "M86",
    "verified 집계의 evidence 조건은 현재 이벤트 모델에서 위반될 수 없다. reduceTask 는 도구 관측이 " +
      "요구사항을 settle 할 때만 passed 로 올리므로 evidence 가 빈 passed 는 만들어지지 않는다. " +
      "TaskState 를 직접 주입할 공개 경로가 없어 단위로도 재현할 수 없어, 미래의 reducer 변경에 대비한 " +
      "방어 조건으로 남긴다 (M86 은 제거됨)",
  ],
  [
    "M58",
    "mayExecute 의 두 번째 조건은 현재 중복이다. audit.ok 가 true 이면 NO_USER_REQUIREMENT·" +
      "TARGET_UNRESOLVED·UNRESOLVED_CONDITION·REQUIREMENT_CONFLICT 가 모두 없다는 뜻이므로 " +
      "ready 인 사용자 요구사항이 반드시 하나는 있다. 같은 불변식은 감사 쪽 방어선(M57)이 물어서 " +
      "확인하며, 이 조건은 감사가 놓칠 때를 위한 두 번째 벨트로 남긴다",
  ],
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

// A file listed twice is backed up twice, restored twice, and has its `.bak`
// unlinked twice — the second unlink throws ENOENT and prints `.bak 삭제 실패`,
// which is the identical line a genuine cleanup failure prints. The duplicate
// corrupts nothing; what it costs is the ability to tell a real failure from
// noise at the end of a run, so it is refused here rather than tolerated there.
const duplicated = [...new Set(FILES.filter((f, i) => FILES.indexOf(f) !== i))];
if (duplicated.length > 0) {
  throw new Error(`FILES 에 같은 파일이 두 번 있습니다: ${duplicated.join(", ")}`);
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
