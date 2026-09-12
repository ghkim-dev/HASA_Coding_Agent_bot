import { outputProhibitionsIn } from "../agent/outputProhibitions.ts";
import { prohibitionsIn } from "../agent/statedProhibitions.ts";
import { NEGATED } from "./functionalExtract.ts";

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
/**
 * 제안이 실행 행위를 말하는가.
 *
 * 배포·커밋·머지·푸시가 뒤늦게 붙었다. `statedProhibitions` 의 실행 부류에는
 * 넣어 두고 여기에는 넣지 않아서, "배포는 하지 마세요" 를 금지로 읽고도
 * "배포한다" 라는 제안이 그 금지에 **대한** 것인 줄 몰랐다 — 두 목록이 같은
 * 부류의 양쪽 끝인데 한쪽만 자랐던 것이다.
 */
const EXECUTE = /실행|돌리|구동|배포|커밋|머지|푸시|릴리[스즈]|롤아웃|run\b|execute|deploy|release|merge|commit|push/;

/**
 * Putting something into the answer — the act an output prohibition forbids.
 *
 * The mirror of `EXECUTE` and `REMOVE`, and needed for the same reason: the
 * reversal check has to ask whether the proposal is about the act the span
 * forbade, or it fires on any proposal that merely quotes a prohibition.
 */
const INCLUDE = /넣|포함|기재|언급|노출|삽입|담|적는|쓴다|include|mention|list|cite/;
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
  /**
   * The sentence the span sits in, when the caller has it.
   *
   * The prohibition check runs on this rather than on the span, and the reason
   * is that **the model chooses where the span ends.** Asking for a quote made
   * that easy to exploit: given "배포는 하지 마세요", a model that quotes
   * `배포는 하지` — the prohibition with its negation cut off — gets a span
   * that `prohibitionsIn` reads as forbidding nothing, and the proposal
   * "배포한다" was accepted on it. A requirement to do the thing the user had
   * just forbidden, grounded in the user's own words.
   *
   * Found by an outside review that listed truncated negation as a case to
   * check. It was reachable before quotes too — a model could have given the
   * coordinates — but coordinates are the thing models get wrong, so the hole
   * was hard to fall into by accident and easy to fall into on purpose.
   *
   * Optional because two callers pass a span with no document behind it. When
   * it is absent the check is what it was: the span, and nothing wider.
   */
  sentenceText?: string;
}): Alignment {
  const span = input.spanText;
  const text = input.proposalText;

  // The span forbids something and the proposal requires it, or the reverse.
  // Read on the sentence, so cutting the negation out of the quote does not
  // cut the prohibition out of the check.
  const forbidden = prohibitionsIn(input.sentenceText ?? span);
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

  // The same reversal, for the prohibition that names no tool.
  //
  // `prohibitionsIn` is empty for "특정 벤더의 제품명은 결론에 넣지 말아 주세요",
  // so the check above could not see it: a model was free to quote that
  // sentence and file "특정 벤더의 제품명을 결론에 넣는다" as a `required`
  // requirement, and this function answered `aligned`. The span was genuinely
  // the user's words, which is exactly the hole a span check leaves and this
  // function exists to close.
  //
  // Three conditions, all necessary. The subject has to appear — otherwise any
  // proposal built on a caveated sentence is suspect. The proposal has to be
  // about putting it in. And the proposal must not itself be negated, because
  // "제품명은 결론에 넣지 않는다" repeats both the subject and the verb and is
  // the correct reading rather than its reversal.
  //
  // The third condition asks about negation rather than about being an output
  // prohibition, and the difference is not cosmetic: `outputProhibitionsIn`
  // reads what a *user* writes (넣지 마), and a requirement is written in the
  // declarative (넣지 않는다), which that reader deliberately does not treat as
  // a ban. Asking the wrong question there marked the correct reading as its
  // own reversal. `NEGATED` is the extractor's own, shared rather than copied
  // so the two cannot drift.
  if (input.polarity === "required" && INCLUDE.test(text) && !NEGATED.test(text)) {
    // 여기도 문장으로 읽는다. "제품명은 결론에 넣지 마세요" 에서 `넣지` 까지만
    // 인용하면 같은 방식으로 금지가 사라진다.
    for (const banned of outputProhibitionsIn(input.sentenceText ?? span)) {
      if (!text.includes(banned.subject)) continue;
      return {
        verdict: "reversed",
        code: "polarity_reversed",
        detail: "인용한 구절은 그것을 결과물에 넣지 말라고 하는데 요구사항은 넣으라고 합니다.",
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
