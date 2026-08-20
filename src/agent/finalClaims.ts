import { assessCompletion, type RequirementState, type TaskState } from "./taskState.ts";
import { unsupportedClaims } from "./claimGrounding.ts";
import { isExternalBlocker, classifyFailure } from "./commandSemantics.ts";
import type { SourceRequirement } from "./sourceProvenance.ts";
import type { SourceFact } from "./sourceFacts.ts";
import { composeRuntimeSummary, type QuotedSection, type RuntimeSummary } from "./runtimeSummary.ts";

/**
 * The last thing between the model's answer and the user.
 *
 * C4.7 measured what was left, and it was two numbers:
 *
 *     unsupportedClaimEscaped   =  2 / 40
 *     falseCompletionEscaped    = 26 / 40
 *
 * Both had the same shape of cause. The source gate ran *once per turn*, so a
 * model that repeated the sentence got it through on the second attempt. The
 * completion gate did not exist at all — `describeTask` hands the record to the
 * model before it writes, which is advice, and advice is not a boundary.
 *
 *   The model proposes an answer. The runtime decides whether it may be sent.
 *
 * ## Why every candidate, and why fail closed
 *
 * A gate that stops checking after the first refusal is a gate with a second
 * door. So validation is a property of a *candidate*, not of a turn: candidate
 * two is checked exactly as hard as candidate one, and a repair that fixes the
 * attribution while adding a completion claim is caught by the completion rule
 * on the way out.
 *
 * And when the repairs run out, the last unsafe candidate is not sent. It is
 * replaced by a summary the runtime writes from its own record. Any other
 * ending makes `escaped = 0` a statement about how patient the model was.
 */

// ---------------------------------------------------------------------------
// What the task actually is
// ---------------------------------------------------------------------------

/**
 * Where the work stands, decided by the runtime.
 *
 * Distinct from `TaskStatus`, which is about the task's own lifecycle, and from
 * `AgentStopReason`, which is about the run. This is the answer to "may the
 * user be told this is done", and it is the only thing the completion gate
 * consults.
 *
 *   file exists     ≠ task complete
 *   exit code 0     ≠ task complete
 *   model says done ≠ task complete
 *   run ended       ≠ task complete
 */
export type TaskDisposition = "completed" | "partial" | "blocked" | "aborted" | "active";

/** Run endings that mean the turn stopped rather than finished. */
const UNFINISHED_RUN = new Set(["no_progress", "protocol_error", "max_steps", "max_model_calls", "max_tool_calls", "timeout", "aborted", "loop_detected", "denied", "error"]);

export function taskDisposition(task: TaskState | null, termination?: string): TaskDisposition {
  if (task === null) return "active";
  const verdict = assessCompletion(task);
  // Completion first and unconditionally. A run that hit its step budget after
  // the work was already verified is a run that ended untidily, not a task that
  // is unfinished.
  if (verdict.complete) return "completed";
  if (task.status === "blocked") return "blocked";
  if (termination === "blocked") return "blocked";
  if (termination !== undefined && UNFINISHED_RUN.has(termination)) return "aborted";
  if (verdict.partial) return "partial";
  return "active";
}

export function describeDisposition(disposition: TaskDisposition): string {
  switch (disposition) {
    case "completed":
      return "요구사항이 모두 확인되었습니다";
    case "partial":
      return "일부만 확인되었고 남은 것이 있습니다";
    case "blocked":
      return "바깥 원인으로 막혀 있습니다";
    case "aborted":
      return "이번 실행이 끝까지 가지 못하고 중단되었습니다";
    case "active":
      return "아직 확인된 것이 없습니다";
  }
}

// ---------------------------------------------------------------------------
// What a candidate may not say
// ---------------------------------------------------------------------------

export type ClaimViolationKind =
  | "UNSUPPORTED_COMPLETION"
  | "UNSUPPORTED_TEST_SUCCESS"
  | "UNVERIFIED_INVOCATION"
  | "UNSUPPORTED_SOURCE_ATTRIBUTION"
  | "UNSUPPORTED_BLOCKER"
  | "FALSE_ACTIVITY";

export interface ClaimViolation {
  kind: ClaimViolationKind;
  /** The sentence, so a repair can quote it rather than guess. */
  sentence: string;
  /** What the record says instead. */
  detail: string;
}

export interface ClaimValidationResult {
  valid: boolean;
  violations: ClaimViolation[];
}

// ---------------------------------------------------------------------------
// Reading the candidate
// ---------------------------------------------------------------------------

/** Splits on a sentence end followed by space. A bare dot is part of a name. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Words that assert the work stands finished.
 *
 * The second half of this list came from the first live sweep rather than from
 * imagination. `성공적으로 구현했습니다` and `요구사항을 모두 충족했습니다` are
 * both completion claims and neither contains 완료 — they went out against an
 * empty record because the gate did not recognise them as claims at all.
 *
 * This is a second line and is documented as one. The record is the first: a
 * claim is refused because nothing supports it, and widening this pattern only
 * widens what gets *asked* that question.
 */
const COMPLETION =
  /완료|완성|끝냈|끝났|마쳤|마무리했|다\s*했|구현했|충족했|반영했|적용했|처리했|해결했|done\b|complete[ds]?\b|finished\b|implemented\b|satisfied\b/i;

/**
 * A completion word that is being denied.
 *
 * The distinction the C4.7 evaluator got wrong once and had to be corrected
 * for: "작업을 완료하지 못했습니다" contains 완료 and says the opposite. What
 * matters is whether the negation attaches to the completion word, which in
 * Korean means it follows within a syllable or two — so this looks *there*
 * rather than anywhere in the sentence.
 *
 * That precision is also what catches the contradiction in §10:
 * "모두 완료했지만 네트워크 문제로 실행하지 못했습니다" has a negation, and it
 * is nowhere near 완료. The sentence is an affirmative completion claim with an
 * admission attached, and it is exactly the shape a report takes when it wants
 * to be read as success.
 */
const NEGATED_COMPLETION =
  /(?:완료|완성|끝|마무리)[가-힣]{0,4}\s*(?:않|못|안\s)|아직[^.!?\n]{0,12}(?:완료|완성|끝)|not\s+(?:complete|finished|done|fully)|un(?:able|finished)|isn't\s+(?:done|complete)|(?:완료|완성|끝|마무리)[가-힣]{0,2}(?:려면|려고|하기\s*위)|(?:to|before)\s+(?:complete|finish)/i;

/** Words that make a claim about the whole of the work rather than a piece. */
const TOTALITY = /모든|전체|전부|모두|일체|all\b|every\b|entire|fully|whole/i;

const TEST_CLAIM =
  /(?:테스트|test)[^.!?\n]{0,24}(?:통과|성공|passed|pass\b|green)|(?:모든|all)[^.!?\n]{0,12}(?:테스트|tests?)[^.!?\n]{0,12}(?:통과|passed)/i;

/**
 * A test claim that is being withheld rather than made.
 *
 * `테스트가 통과했다고 말할 수 없습니다` says the opposite of what `TEST_CLAIM`
 * matches, and refusing it taught the model to stop being careful — the one
 * sentence a model should be encouraged to write.
 */
const NEGATED_TEST =
  /(?:통과|성공|pass(?:ed)?)[^.!?\n]{0,14}(?:못했|않았|않습니다|없습니다|아닙니다|아직)|(?:통과|성공)했다고[^.!?\n]{0,12}없|(?:통과|성공)하지\s*(?:못|않)|(?:cannot|can't|couldn't|didn't)\s+(?:say|claim|confirm|verify)/i;

const TRAINING_CLAIM = /(?:학습|훈련|training)[^.!?\n]{0,16}(?:완료|끝|성공|completed|finished|succeeded)/i;

const INVOCATION_CLAIM =
  /(?:추론|호출|inference|invoke[d]?|invocation)[^.!?\n]{0,20}(?:성공|완료|했습니다|하였습니다|되었습니다|succeeded|successful|worked)/i;

/**
 * A claim that the agent's own work is running right now.
 *
 * False by construction in a final answer. Commands run inside the turn and the
 * turn is over when this text is sent, so "학습이 진행 중입니다" describes a
 * process that does not exist — the transcript this was written for repeated it
 * across four turns, with epochs and monitoring, and there had never been a
 * single `run_command`. The verbs are the agent's work verbs specifically:
 * "서버가 실행 중인지 확인하세요" talks about the user's world and must pass,
 * which is why the pattern demands work-verb + progressive rather than any
 * sentence containing 중.
 */
const ACTIVITY_CLAIM =
  /(?:학습|훈련|다운로드|설치|변환|생성|작업)[이을를은는]?\s*(?:이|가)?\s*(?:진행\s*중|진행되고\s*있|계속되고\s*있)|(?:학습|훈련|다운로드|설치)(?:하고|되고)\s*있(?:습니다|어요|음)|(?:모니터링|지켜보고)\s*(?:중입니다|하고\s*있)|(?:is|are)\s+(?:currently\s+)?(?:training|downloading|installing|running)\b|training\s+in\s+progress/i;

/**
 * A promise to keep watching after the answer — which nothing will do.
 *
 * "완료되면 보고하겠습니다" reads as a running job with a courier attached. The
 * turn ends with the sentence; no process, no watcher, no report. It is the
 * same false activity in the future tense.
 */
const MONITORING_PROMISE =
  /(?:완료되면|끝나면|학습이\s*끝나는\s*대로)[^.!?\n]{0,16}(?:보고|알려|공유)|(?:계속|이어서)\s*모니터링(?:하겠|할게|하며)|(?:i(?:'| wi)ll|will)\s+(?:keep\s+)?(?:monitor|watch|report\s+back)/i;

/** An external cause named as the reason something did not happen. */
const BLOCKER_CLAIM =
  /(?:네트워크|권한|인증|차단|방화벽|접근이\s*거부|network|permission|firewall|blocked)[^.!?\n]{0,30}(?:때문|문제로|로 인해|못했|실패|denied|refused)/i;

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface FinalClaimInput {
  task: TaskState | null;
  disposition: TaskDisposition;
  text: string;
  /** URLs the user named, for the source gate. */
  named?: readonly SourceRequirement[];
  facts?: readonly SourceFact[];
  /** How the run ended, so `no_progress` can be told from `finished`. */
  termination?: string;
}

/**
 * Every violation in one pass.
 *
 * Not the first one. A candidate that misattributes a source *and* claims the
 * work is finished gets both back at once, because handing them over one at a
 * time means the second survives the repair aimed at the first — which is how a
 * bounded repair budget turns into an escape hatch.
 */
export function validateFinalClaims(input: FinalClaimInput): ClaimValidationResult {
  const { task, disposition, text } = input;
  const violations: ClaimViolation[] = [];

  // No task record is the hardest case, not the easiest.
  //
  // This used to `return { valid: true }` here, on the reading that a gate with
  // nothing to check against should not object. That is exactly backwards, and
  // the first live sweep measured the cost: ten of seventeen escaped completion
  // claims came from turns that recorded no contract at all. The model said the
  // work was done, the runtime held no requirement, no evidence and no action —
  // and the gate waved it through *because* it knew nothing.
  //
  //     nothing recorded  ≠  nothing to object to
  //     nothing recorded  =  nothing that could support a claim
  //
  // So an absent record is now an empty one, and every rule below asks the same
  // question of it. A claim of completion against an empty record has no
  // passed requirement to be scoped to and no evidence to rest on, so it fails
  // the rules that were already written — no new rule was needed, only the
  // refusal to skip them.
  const evidence = task?.evidence ?? [];
  const sources = task?.sources ?? [];
  const facts = task?.facts ?? [];
  const requirements = task?.requirements ?? [];

  // Source attribution, from the gate C4.6.1 built. Folded in here rather than
  // called separately so there is one boundary and one budget.
  for (const claim of unsupportedClaims(evidence, text, input.named ?? sources, input.facts ?? facts)) {
    violations.push({
      kind: claim.kind === "invocation" ? "UNVERIFIED_INVOCATION" : "UNSUPPORTED_SOURCE_ATTRIBUTION",
      sentence: claim.sentence,
      detail:
        claim.subject === undefined
          ? `${claim.hostname}에 대해 확인된 것이 그 주장에 미치지 못합니다.`
          : `${claim.hostname}의 내용에서 ${claim.subject}을(를) 확인한 기록이 없습니다.`,
    });
  }

  const passed = requirements.filter((r) => r.status === "passed");
  const outstanding = task === null ? [] : assessCompletion(task).outstanding;

  for (const sentence of sentences(text)) {
    if (COMPLETION.test(sentence) && !NEGATED_COMPLETION.test(sentence)) {
      // Scope decides everything. "CNN 구현은 완료했습니다" is a claim about one
      // requirement and is true when that requirement passed; "전체를
      // 완료했습니다" is a claim about the task and needs the task to be done.
      const scoped = !TOTALITY.test(sentence) && namesRequirement(sentence, passed);
      if (!scoped && disposition !== "completed") {
        violations.push({
          kind: "UNSUPPORTED_COMPLETION",
          sentence,
          detail:
            `기록상 ${describeDisposition(disposition)}. ` +
            (outstanding.length === 0
              ? "완료를 뒷받침할 요구사항 기록이 없습니다."
              : `남은 것: ${outstanding.map((r) => r.description).join(", ")}.`) +
            (input.termination === "no_progress"
              ? " 이번 실행은 같은 시도가 반복되어 중단되었습니다 — 실행 종료는 작업 완료가 아닙니다."
              : ""),
        });
      }
    }

    if (TEST_CLAIM.test(sentence) && !NEGATED_TEST.test(sentence) && !hasEvidence(task, "test_result")) {
      // Two different problems and two different things to do about them. A
      // model told "you never ran the tests" runs them; one told "you ran them
      // and then changed the code" runs them *again*, which is the whole point.
      violations.push({
        kind: "UNSUPPORTED_TEST_SUCCESS",
        sentence,
        detail: hasStaleEvidence(task, "test_result")
          ? "테스트를 통과시킨 뒤에 파일을 다시 고쳤습니다. 그 실행 결과는 지금 코드에 대한 것이 아닙니다 — 다시 실행하십시오."
          : "통과한 테스트 실행 기록이 없습니다. 테스트를 돌린 적이 없으면 통과했다고 쓸 수 없습니다.",
      });
    }

    if (TRAINING_CLAIM.test(sentence) && !NEGATED_COMPLETION.test(sentence) && !hasAnyRun(task)) {
      violations.push({
        kind: "UNSUPPORTED_COMPLETION",
        sentence,
        detail: "학습을 실행한 기록이 없습니다. 코드를 작성한 것과 돌린 것은 다릅니다.",
      });
    }

    if (INVOCATION_CLAIM.test(sentence) && !hasAnyRun(task)) {
      violations.push({
        kind: "UNVERIFIED_INVOCATION",
        sentence,
        detail: "실제로 호출한 기록이 없습니다.",
      });
    }

    // No condition on the record, because no record could support it: the
    // answer is sent after the last tool returned, so nothing the runtime
    // started is running while the user reads this.
    if (ACTIVITY_CLAIM.test(sentence)) {
      violations.push({
        kind: "FALSE_ACTIVITY",
        sentence,
        detail:
          "이 답변이 전송되는 시점에 런타임이 실행 중인 프로세스는 없습니다. " +
          "실행 중이라고 쓰지 말고, 실제로 실행했으면 그 결과를, 하지 않았으면 하지 않았다고 적으십시오.",
      });
    }

    if (MONITORING_PROMISE.test(sentence)) {
      violations.push({
        kind: "FALSE_ACTIVITY",
        sentence,
        detail:
          "턴이 끝나면 아무것도 지켜보지 않습니다. 완료를 지켜보다 보고하겠다는 약속은 " +
          "지켜질 수 없으므로 쓰지 마십시오. 지금까지 확인된 것만 적으십시오.",
      });
    }

    if (BLOCKER_CLAIM.test(sentence) && !hasExternalBlocker(task)) {
      violations.push({
        kind: "UNSUPPORTED_BLOCKER",
        sentence,
        detail:
          "바깥 원인으로 막혔다는 근거가 기록에 없습니다. " +
          "명령을 잘못 만든 것은 환경 문제가 아닙니다.",
      });
    }
  }

  // Same sentence, same kind, once. A repeated finding reads as five problems
  // and is one.
  const seen = new Set<string>();
  const unique = violations.filter((v) => {
    const key = `${v.kind}|${v.sentence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { valid: unique.length === 0, violations: unique };
}

/** Whether a sentence is about one of these requirements in particular. */
function namesRequirement(sentence: string, passed: readonly RequirementState[]): boolean {
  const text = sentence.toLowerCase();
  return passed.some((requirement) =>
    tokens(requirement.description).some((token) => text.includes(token)),
  );
}

/**
 * The words of a requirement worth matching on.
 *
 * Two characters for CJK and three for ASCII, the same threshold the coverage
 * check uses: `추론` and `학습` are whole words, and a three-character floor
 * would make every Korean requirement unmatchable.
 */
function tokens(description: string): string[] {
  return description
    .toLowerCase()
    .split(/[\s,·/()]+/)
    .map((word) => word.replace(/[을를이가은는의에서]$/u, ""))
    .filter((word) => (/[가-힣]/.test(word) ? word.length >= 2 : word.length >= 3));
}

/**
 * A passing observation of this kind that still describes the current tree.
 *
 * Freshness, not just existence. A test run that exited 0 and was then followed
 * by a source edit is evidence about a tree that no longer exists, and it sits
 * in `evidence` looking exactly like evidence about this one.
 *
 *     exit 0  →  edit source  →  "tests pass" is a claim about the past
 *
 * The brief calls this out as its own invariant and it is the failure mode a
 * careful-looking agent produces most easily: fix, run, fix again, report the
 * first run's result. Ties count as fresh — an edit and a run recorded in the
 * same millisecond are not ordered by this clock, and refusing on a tie would
 * reject a legitimate run for the resolution of a timestamp.
 */
function hasEvidence(task: TaskState | null, kind: string): boolean {
  if (task === null) return false;
  // `?? 0` because a state reduced by older code has no clock, and reading
  // `undefined` as the change time would make every observation stale — the
  // safe-looking direction that silently refuses every legitimate claim.
  const changedAt = task.lastChangeAt ?? 0;
  return task.evidence.some((e) => e.kind === kind && e.status === "passed" && e.at >= changedAt);
}

/** Whether a passing observation of this kind exists but has been overtaken. */
function hasStaleEvidence(task: TaskState | null, kind: string): boolean {
  if (task === null) return false;
  const changedAt = task.lastChangeAt ?? 0;
  return task.evidence.some((e) => e.kind === kind && e.status === "passed" && e.at < changedAt);
}

function hasAnyRun(task: TaskState | null): boolean {
  return (task?.evidence ?? []).some(
    (e) => (e.kind === "command_result" || e.kind === "test_result" || e.kind === "build_result") && e.status === "passed",
  );
}

/** Whether anything the runtime saw actually came from outside the agent. */
function hasExternalBlocker(task: TaskState | null): boolean {
  return (task?.issues ?? []).some((issue) => issue.status === "open" && isExternalBlocker(classifyFailure(issue.detail)));
}

// ---------------------------------------------------------------------------
// What to say about it
// ---------------------------------------------------------------------------

/**
 * The opening line of a rejection, as a constant.
 *
 * Anything that needs to recognise an intervention — the evaluator counts them
 * — matches on this rather than on a copy of the prose. A metric that greps for
 * a sentence someone else owns reports zero the day the sentence is reworded,
 * and reads as "the gate never fired".
 */
export const CLAIM_REJECTED_MARKER = "런타임이 관측한 기록보다 강한 주장";

export function describeViolations(violations: readonly ClaimViolation[]): string {
  const lines = [
    `아래 문장은 ${CLAIM_REJECTED_MARKER}입니다. 기록에 맞게 고쳐서 다시 답하십시오. ` +
      "한 문장만 고치지 말고 나열된 것을 모두 반영하십시오.",
  ];
  for (const violation of violations) {
    lines.push(`- [${violation.kind}] "${violation.sentence}"\n  ${violation.detail}`);
  }
  lines.push(
    "완료하지 못한 것을 완료했다고 쓰지 말고, 무엇을 했고 무엇이 남았는지 그대로 적으십시오.",
  );
  return lines.join("\n");
}

/**
 * The answer the runtime sends when the model will not stop overclaiming.
 *
 * Built from the record and nothing else. It does not quote, paraphrase or
 * salvage the rejected candidate: the candidate is the thing that was wrong,
 * and copying any of it back is how the sentence gets out anyway.
 *
 * It is a worse answer than a good model's, and that is the trade. A user told
 * less than they hoped can ask again; a user told the work is done when it is
 * not has been given something they cannot act on and do not know to doubt.
 */
/**
 * The answer the runtime writes when the model's cannot be sent.
 *
 * Two kinds of sentence, kept apart by type rather than run together into one
 * string. `verdict` is the runtime speaking; `quoted` is requirement text and
 * issue detail repeated from the record. The second is arbitrary text written
 * by the user or the model, and a requirement legitimately called
 * "완료 여부 확인 및 보고" is a completion word inside data — not a claim, and
 * unfixable by choosing better words on this side, because these are not this
 * side's words.
 *
 *     "확인됨", not "완료"          fixed a label the runtime chose
 *     quoted requirement text        cannot be fixed that way at all
 */
export function safeFallback(
  task: TaskState | null,
  disposition: TaskDisposition,
  termination?: string,
): RuntimeSummary {
  const verdict = ["답변이 기록과 맞지 않아, 런타임이 확인한 사실만 정리해 드립니다."];
  const quoted: QuotedSection[] = [];

  if (task !== null) {
    const by = (status: string): string[] =>
      task.requirements.filter((r) => r.status === status).map((r) => r.description);
    quoted.push(
      { label: "확인됨", items: by("passed") },
      { label: "실패", items: by("failed") },
      { label: "막힘", items: by("blocked") },
      { label: "아직 실행 안 함", items: [...by("pending"), ...by("in_progress")] },
      {
        label: "미해결 오류",
        items: task.issues
          .filter((i) => i.status === "open")
          .map((i) => `${i.summary} — ${i.detail}${(i.count ?? 1) > 1 ? ` (×${i.count})` : ""}`),
      },
      { label: "변경한 파일", items: task.changedFiles },
    );
  }

  if (termination === "no_progress") {
    verdict.push("같은 시도가 반복되어 이번 실행은 중단했습니다.");
  }
  verdict.push(`${describeDisposition(disposition)}.`);
  if (disposition !== "completed") verdict.push("따라서 전체 작업은 아직 완료되지 않았습니다.");

  return composeRuntimeSummary({ verdict, quoted });
}

/**
 * The claim rules, applied to what the runtime actually asserted.
 *
 * Reads `verdict` and never `quoted`. That is the whole separation: the same
 * function that refuses a model's overclaim can be pointed at the runtime's own
 * words without the quoted requirement text being mistaken for them.
 *
 * Nothing calls this on the send path — a `RuntimeSummary` is trusted by
 * construction and is not re-validated. It exists so the invariant "the
 * runtime's own assertions pass the runtime's own gate" is a test that can be
 * written, which is how the two defects in this file were found.
 */
export function validateRuntimeSummary(
  summary: RuntimeSummary,
  input: Omit<FinalClaimInput, "text">,
): ClaimValidationResult {
  return validateFinalClaims({ ...input, text: summary.verdict.join("\n") });
}
