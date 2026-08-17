import type { SourceSpan } from "./sourceSpan.ts";

/**
 * The minimum structure of a plain functional request, read without a model.
 *
 * The gap this closes is the one that contradicts the whole goal. "로그인 오류를
 * 수정하고 테스트해줘" has no prohibition and no URL, so the deterministic path
 * produced nothing at all and the preview reported that it had understood
 * nothing. A design engine that only understands what a user forbids is not a
 * design engine.
 *
 * ## Widened, not loosened
 *
 * Every requirement here is a verb the user wrote plus the words in front of it.
 * Nothing is inferred from a verb alone, nothing is added because it "usually
 * goes with" something else, and a sentence with no recognised verb yields
 * nothing — which is still the right answer for "적당히 잘 좀 해줘".
 *
 *     수정해줘        → 무엇을 수정하는지가 없으면 만들지 않는다
 *     오류를 수정해줘  → 대상이 있으므로 요구사항이 된다
 *
 * ## Why these start ambiguous
 *
 * A prohibition and a named URL are things the runtime can be *right* about: the
 * user wrote "하지 마" and wrote the host. What a verb phrase means for a
 * codebase is a reading, and this one is coarse. So it is `ambiguous` — visible
 * in the plan, and needing either the user's confirmation or a model's
 * corroboration before it decides anything.
 */

export type ActionKind = "modify" | "verify" | "inspect" | "create" | "remove" | "execute";

export interface FunctionalCandidate {
  /** What was asked, in the user's own words plus the verb. */
  text: string;
  span: SourceSpan;
  action: ActionKind;
  /** The object, when the sentence named one. Empty is not emitted at all. */
  object: string;
}

/**
 * Verbs that describe work on a codebase, and what class each belongs to.
 *
 * Ordered longest-first within a class so `재실행` is not read as `실행`, and the
 * stem is matched with its ending so `수정하지` — a prohibition — never lands
 * here. Prohibitions are `statedProhibitions`'s job and this must not duplicate
 * or contradict it.
 */
const VERBS: ReadonlyArray<{ pattern: RegExp; action: ActionKind }> = [
  { pattern: /재실행(?:해|하|시켜)/, action: "execute" },
  { pattern: /실행(?:해|하[^지]|시켜)/, action: "execute" },
  { pattern: /돌려(?:줘|주세요|봐)/, action: "execute" },
  { pattern: /테스트(?:해|하[^지]|를 해|해줘|해 주)/, action: "verify" },
  { pattern: /검증(?:해|하[^지])/, action: "verify" },
  { pattern: /확인(?:해|하[^지])/, action: "verify" },
  { pattern: /재현(?:해|하[^지])/, action: "verify" },
  { pattern: /수정(?:해|하[^지])/, action: "modify" },
  { pattern: /고쳐(?:줘|주세요|서|야)/, action: "modify" },
  { pattern: /개선(?:해|하[^지])/, action: "modify" },
  { pattern: /리팩터(?:링해|링하)/, action: "modify" },
  { pattern: /바꿔(?:줘|주세요)/, action: "modify" },
  { pattern: /추가(?:해|하[^지])/, action: "create" },
  { pattern: /구현(?:해|하[^지])/, action: "create" },
  { pattern: /만들어(?:줘|주세요)/, action: "create" },
  { pattern: /삭제(?:해|하[^지])/, action: "remove" },
  { pattern: /제거(?:해|하[^지])/, action: "remove" },
  { pattern: /분석(?:해|하[^지])/, action: "inspect" },
  { pattern: /설명(?:해|하[^지])/, action: "inspect" },
  { pattern: /보여(?:줘|주세요)/, action: "inspect" },
  { pattern: /찾아(?:줘|주세요|봐)/, action: "inspect" },
];

/** How an act with no stated target is written down. The target stays open. */
const ACT_ONLY: Readonly<Record<ActionKind, string>> = {
  modify: "수정한다",
  verify: "테스트를 실행해 결과를 확인한다",
  inspect: "살펴본다",
  create: "추가한다",
  remove: "제거한다",
  execute: "요청한 명령을 실행한다",
};

const ACTION_TEXT: Readonly<Record<ActionKind, string>> = {
  modify: "수정한다",
  verify: "확인한다",
  inspect: "살펴본다",
  create: "추가한다",
  remove: "제거한다",
  execute: "실행한다",
};

/** Words that are grammar rather than a target. An object made of these is none. */
const NOT_AN_OBJECT =
  /^(?:그것|이것|저것|그거|이거|저거|그|이|저|좀|다|전부|모두|잘|적당히|알아서|한번|다시|또|이번|이번에는|안에서만|여기서|거기서)$/;

/**
 * Verbs whose act is the requirement even with no stated target.
 *
 * "테스트해줘" is a real request and Korean routinely leaves the object
 * implicit. Dropping it loses half of "고치고 테스트해줘". What is *not* done is
 * guessing the target — the requirement is recorded with the act named and the
 * target left open, which the plan then carries as unresolved.
 *
 * Deliberately not extended to `modify`, `create` or `remove`. "수정해줘" with
 * nothing to modify tells the runtime nothing it could verify, and inventing a
 * target is the failure this module is written against.
 */
const ACT_IS_ENOUGH: ReadonlySet<ActionKind> = new Set<ActionKind>(["verify", "execute"]);

/**
 * The object of a verb: the noun phrase immediately before it.
 *
 * Immediately, and in the same clause. Reaching further back finds a noun from
 * a different thought and attaches it to this verb, which is how "로그인 오류를
 * 수정하고 테스트해줘" would become "로그인 오류를 테스트한다" — a requirement the
 * user did not state.
 */
function objectBefore(clause: string, verbStart: number): string {
  const before = clause.slice(0, verbStart).trim();
  if (before.length === 0) return "";

  // Up to three tokens, so a modifier stays with its noun: "로그인 오류" rather
  // than "오류", "main.py 코드" rather than "py 코드만". One token loses the
  // half of the phrase that says *which* one.
  const marked = /((?:[^\s,]+\s+){0,2}[^\s,]+)\s*(?:을|를)\s*$/.exec(before);

  // Strip particles token by token *before* choosing, so a trailing
  // "안에서만" does not push "auth" out of the window and leave a bare "폴더".
  const strip = (token: string): string =>
    token
      .replace(/(?:안에서만|에서만|에서|안에|만)$/u, "")
      .replace(/[을를이가은는의로]$/u, "")
      .trim();

  const tokens = (marked?.[1] ?? before)
    .split(/\s+/)
    .map(strip)
    .filter((t) => t.length > 0 && !NOT_AN_OBJECT.test(t));

  const kept = tokens.slice(-2).join(" ");
  return kept.length < 2 ? "" : kept;
}

/**
 * `을` or `를`, by whether the last syllable ends in a consonant.
 *
 * A user-facing sentence, so "오류을(를)" is not good enough. Hangul syllables
 * are laid out so the final consonant falls out of the code point directly;
 * anything else — a latin identifier, a digit — takes `을`, which is what a
 * Korean reader writes after a consonant sound.
 */
function objectParticle(object: string): string {
  const last = object.codePointAt(object.length - 1) ?? 0;
  if (last >= 0xac00 && last <= 0xd7a3) {
    return (last - 0xac00) % 28 === 0 ? "를" : "을";
  }
  return "을";
}

/**
 * Functional candidates in one turn.
 *
 * Splits on clause boundaries first, because Korean chains verbs with `-고` and
 * a single sentence routinely holds two separate requests. "고치고 테스트해줘"
 * is two requirements and reading it as one loses the second.
 */
export function functionalCandidates(input: { turnId: string; text: string }): FunctionalCandidate[] {
  const out: FunctionalCandidate[] = [];
  const seen = new Set<string>();

  // Clause boundaries: sentence ends, and the connective that chains verbs.
  //
  // A sentence end is a full stop *followed by a break*. Splitting on a bare
  // period cut `main.py` in half and the object came out as "py 코드" — a
  // filename is not a sentence boundary.
  const boundaries = /(?<=[.!?。])(?=\s|$)|(?<=하고\s)|(?<=한\s*뒤\s)|(?<=한\s*다음\s)|(?<=,\s)/;
  let offset = 0;
  for (const clause of input.text.split(boundaries)) {
    const at = input.text.indexOf(clause, offset);
    if (at === -1) continue;
    offset = at + clause.length;
    if (clause.trim().length === 0) continue;

    for (const { pattern, action } of VERBS) {
      const match = pattern.exec(clause);
      if (match === null) continue;
      const object = objectBefore(clause, match.index);
      // No object and no act that stands alone: the user asked for something
      // this cannot name, and naming it anyway is inventing.
      if (object.length === 0 && !ACT_IS_ENOUGH.has(action)) continue;

      const text = object.length === 0 ? ACT_ONLY[action] : `${object}${objectParticle(object)} ${ACTION_TEXT[action]}`;
      if (seen.has(text)) continue;
      seen.add(text);

      out.push({
        text,
        action,
        object,
        span: { turnId: input.turnId, start: at, end: at + clause.replace(/\s+$/, "").length },
      });
      break; // One requirement per clause. Two verbs in one clause is one act.
    }
  }

  return out;
}
