import { prohibitionsIn } from "../agent/statedProhibitions.ts";

/**
 * Whether a proposed requirement says what its span says.
 *
 * A span check establishes that the words are the user's. It does not
 * establish that the requirement built on them means the same thing, and the
 * two failures that motivated this are both of that shape:
 *
 *     span: "실행하지 말고"           proposal: 실행이 필수다
 *     span: "기존 API ... 유지하면서"  proposal: 기존 API를 제거한다
 *
 * Both quote correctly and assert the reverse.
 *
 * ## Deliberately not a meaning model
 *
 * Only reversals the runtime can decide are decided. Everything else comes back
 * `unknown`, and `unknown` becomes `ambiguous` rather than `confirmed` — the
 * direction that costs a re-read instead of a wrong plan. A checker that
 * guessed at the rest would be the model's paraphrase again, one layer down.
 */

export type AlignmentVerdict = "aligned" | "reversed" | "widened" | "unknown";

export interface Alignment {
  verdict: AlignmentVerdict;
  /** Which check fired, for the audit trail. Empty when nothing did. */
  code:
    | "polarity_reversed"
    | "keep_vs_remove"
    | "execute_vs_analyse"
    | "past_failure_as_prohibition"
    | "conditional_made_absolute"
    | "priority_promoted"
    | "scope_widened"
    | "target_substituted"
    | "none";
  detail: string;
}

const KEEP = /유지|보존|그대로|keep|preserve|retain/;
const REMOVE = /제거|삭제|없애|바꾸|변경|rename|remove|delete|replace/;
const EXECUTE = /실행|돌리|구동|run\b|execute/;
const ANALYSE_ONLY = /분석만|설명만|보여주기만|읽기만|analy[sz]e only|only explain/;
const PAST_FAILURE = /못했|실패했|안\s*됐|failed|couldn't/;
/**
 * A condition the sentence puts on the work, spelled by ending rather than by
 * the syllable `면`.
 *
 * Four wrong answers shaped this pattern, and three of them were false positives.
 *
 * `하면서` is "while doing", not "if" — see the note in `sourceSpan.ts`. Excluded
 * by requiring whitespace or punctuation after the ending, which is where a
 * conditional clause actually stops.
 *
 * `하면 안 돼` is how Korean forbids something. "실행하면 안 돼" states a
 * prohibition with nothing unsettled in it, and read as a condition it produced
 * "이 조건을 어떻게 확인해야 할지 정해지지 않았습니다" about a sentence with no
 * condition — blocking a prohibition the runtime had understood perfectly. The
 * lookahead stays narrow: "실패하면 안전하게 롤백해줘" is still a condition, because
 * `안전` is not the negation.
 *
 * `가능하면` is a *priority*, not a condition. "가능하면 로그 포맷도 정리해줘" is an
 * optional request, which `priorityFrom` below already reads as `may` from the
 * very same word; counting it twice asked the user to settle a condition they had
 * not set.
 *
 * And the false negative: `깨지면` and `없으면` are ordinary conditions that
 * neither `하면` nor `이면` ever matched, so "빌드가 깨지면 의존성을 되돌려줘" was
 * planned as unconditional work. The stems are enumerated rather than reduced to a
 * bare `면`, which would match `화면` and `측면`.
 */
const CONDITION =
  /(?<!가능)(?:[하되지으우이라]면|경우|한해|일\s*때)(?=[\s,.)\]]|$)(?!\s*안\s*(?:돼|되|된|됩))|if\b|when\b|unless\b/;
const SOFT = /가능하면|가급적|되도록|원하면|if possible|preferably|nice to have/;
const HARD = /반드시|꼭|필수|무조건|must\b|required/;
const WHOLE = /전체|모든|전부|모두|저장소\s*전체|all files|entire|whole repo/;
const PATH_LIKE = /[\w.-]+\/[\w.-]+|[\w-]+\s*(?:폴더|디렉터리|디렉토리|folder|directory)|\b[\w-]+\.(?:ts|js|py|md|json)\b/;

const aligned: Alignment = { verdict: "aligned", code: "none", detail: "" };

/**
 * Compares a proposal against the words it was built from.
 *
 * `spanText` is what the runtime cut, never what the model typed.
 */
export function checkAlignment(input: {
  spanText: string;
  proposalText: string;
  polarity: "required" | "forbidden";
  priority: "must" | "should" | "may";
}): Alignment {
  const span = input.spanText;
  const text = input.proposalText;

  // The span forbids something and the proposal requires it, or the reverse.
  const forbidden = prohibitionsIn(span);
  if (forbidden.size > 0 && input.polarity === "required") {
    const about =
      (forbidden.has("execute") && EXECUTE.test(text)) ||
      (forbidden.has("modify") && REMOVE.test(text));
    if (about) {
      return {
        verdict: "reversed",
        code: "polarity_reversed",
        detail: "인용한 구절은 그 동작을 금지하는데 요구사항은 그것을 요구합니다.",
      };
    }
  }

  if (KEEP.test(span) && REMOVE.test(text) && !KEEP.test(text)) {
    return {
      verdict: "reversed",
      code: "keep_vs_remove",
      detail: "인용한 구절은 유지를 말하는데 요구사항은 제거·변경을 말합니다.",
    };
  }

  if (ANALYSE_ONLY.test(span) && EXECUTE.test(text) && input.polarity === "required") {
    return {
      verdict: "reversed",
      code: "execute_vs_analyse",
      detail: "인용한 구절은 분석만을 요청하는데 요구사항은 실행을 요구합니다.",
    };
  }

  // "아까는 실행하지 못했어" is a report. Reading it as a prohibition refuses
  // the fix the user is asking for in the next clause.
  if (PAST_FAILURE.test(span) && input.polarity === "forbidden") {
    return {
      verdict: "reversed",
      code: "past_failure_as_prohibition",
      detail: "인용한 구절은 과거 실패 보고입니다. 금지로 읽으면 요청한 수정을 거부하게 됩니다.",
    };
  }

  if (CONDITION.test(span) && input.priority === "must" && !CONDITION.test(text)) {
    return {
      verdict: "widened",
      code: "conditional_made_absolute",
      detail: "조건이 붙은 요구를 조건 없는 must 로 확정했습니다.",
    };
  }

  if (SOFT.test(span) && !HARD.test(span) && input.priority === "must") {
    return {
      verdict: "widened",
      code: "priority_promoted",
      detail: "인용한 구절은 선택적 표현인데 must 로 올렸습니다.",
    };
  }

  if (PATH_LIKE.test(span) && WHOLE.test(text) && !WHOLE.test(span)) {
    return {
      verdict: "widened",
      code: "scope_widened",
      detail: "인용한 구절은 특정 경로를 말하는데 요구사항은 전체 범위를 말합니다.",
    };
  }

  // A named target in the span that the proposal replaces with another.
  const named: string[] = span.match(/[\w][\w.-]{3,}/g) ?? [];
  const claimed: string[] = text.match(/[\w][\w.-]{3,}/g) ?? [];
  if (named.length > 0 && claimed.length > 0) {
    const overlap = claimed.some((c) => named.includes(c));
    if (!overlap) {
      return {
        verdict: "unknown",
        code: "target_substituted",
        detail: "인용한 구절이 지목한 대상이 요구사항에 나타나지 않습니다.",
      };
    }
  }

  return aligned;
}

/**
 * What a span says about how firmly it was asked for.
 *
 * Read from the user's own words rather than taken from the model, because
 * priority is exactly the field a model has an incentive to raise: everything
 * becomes `must` and a plan can then fail entirely on something the user said
 * "가능하면" about.
 */
export function priorityFrom(spanText: string, fallback: "must" | "should" | "may"): "must" | "should" | "may" {
  if (SOFT.test(spanText) && !HARD.test(spanText)) return "may";
  if (HARD.test(spanText)) return "must";
  return fallback;
}

/** Whether the span scopes its requirement to a condition that has not been settled. */
export function conditionIn(spanText: string): string | null {
  return CONDITION.test(spanText) ? spanText.trim() : null;
}

/** Paths a span confines the work to, when it names any. */
export function scopeIn(spanText: string): string[] {
  const folders = spanText.match(/([\w-]+)\s*(?:폴더|디렉터리|디렉토리|folder|directory)/g) ?? [];
  const paths = spanText.match(/[\w.-]+\/[\w.-]+/g) ?? [];
  const named = folders.map((f) => f.replace(/\s*(?:폴더|디렉터리|디렉토리|folder|directory)/, "").trim());
  return [...new Set([...named, ...paths])];
}
