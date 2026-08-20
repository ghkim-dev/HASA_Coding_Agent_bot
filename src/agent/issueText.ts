/**
 * Runtime failures, in the words of the person reading them.
 *
 * A `RuntimeIssue.detail` is whatever the tool or the gate returned, and some
 * of those are machine codes the runtime invented for itself:
 *
 *     TURN_CONTRACT_REQUIRED: 아직 이번 요청을 record_request로 정리하지 …
 *     ACTION_DENIED_BY_CONSTRAINT
 *     CONTROL_PLANE_CONTRACT_STATE_MISMATCH
 *
 * Those reached the panel verbatim, three times over, and a user watching their
 * request fail was shown the internal name of the check that failed it. The raw
 * text is still what the log and the transcript keep — a diagnosis needs the
 * exact string — but the panel gets a sentence.
 *
 * One function, because the alternative is what the panel, the timeline and the
 * runtime summary were already doing: three translations of one failure, worded
 * differently, in the same window.
 */

/** A machine code the runtime uses to classify its own refusals. */
const CODES: ReadonlyArray<{ code: string; text: string }> = [
  {
    code: "TURN_CONTRACT_REQUIRED",
    text: "요청 내용을 아직 정리하지 못해 작업을 시작하지 않았습니다.",
  },
  {
    code: "ACTION_DENIED_BY_CONSTRAINT",
    text: "사용자가 하지 말라고 하신 작업이라 실행하지 않았습니다.",
  },
  {
    code: "ACTION_REQUIRES_JUSTIFICATION",
    text: "이번 요청에 필요한 작업인지 분명하지 않아 실행하지 않았습니다.",
  },
  {
    code: "CONTROL_PLANE_CONTRACT_STATE_MISMATCH",
    text: "현재 요청과 기존 계약 상태가 일치하지 않아 안전하게 중단했습니다.",
  },
  {
    code: "NO_PROGRESS_DETECTED",
    text: "같은 시도가 반복되어 더 진행하지 않았습니다.",
  },
];

/**
 * The sentence for a failure, or the failure itself when it is already one.
 *
 * A detail that carries no code is left alone: a compiler error, a stack trace
 * and a refused path are all better in the tool's own words than in a
 * paraphrase, and rewriting them would lose the part the user acts on.
 */
export function describeIssueDetail(detail: string): string {
  const found = CODES.find((entry) => detail.includes(entry.code));
  if (found === undefined) return detail;

  // Some codes carry a human sentence after the colon that is already better
  // than the generic one. Prefer it — but strip *every* occurrence of *every*
  // code first. Slicing past the first one left a second copy in the tail, and
  // a detail that names two codes still put one of them on screen.
  let text = detail;
  for (const entry of CODES) {
    text = text.split(entry.code).join(" ");
  }
  text = text.replace(/^[:\s]+/, "").replace(/\s{2,}/g, " ").trim();
  return text.length > 0 ? text : found.text;
}

/** Whether this detail is one of the runtime's own codes rather than a tool's error. */
export function isRuntimeCode(detail: string): boolean {
  return CODES.some((entry) => detail.includes(entry.code));
}
