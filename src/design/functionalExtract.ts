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
 * ## Negation is decided once, after the verb
 *
 * The previous version wrote the refusal into each pattern as `하[^지]`, which
 * blocks the literal `하지` and nothing else. So `수정하진 마` and `실행하면 안
 * 돼` both matched, and the runtime produced a requirement to do the thing the
 * user had just forbidden — the precise failure this module's own header says it
 * must not commit. The check now runs once, on the words following the verb,
 * where every form of the negation actually lives.
 *
 * ## What it reports, and what it refuses to guess
 *
 * A candidate carries its `object` — the noun phrase the sentence bound to the
 * verb — or an empty one. Empty is not a defect and not a reason to drop the
 * request: Korean routinely leaves the object implicit, and "테스트해줘" is a
 * real ask. It is a reason to record the target as *not settled*, which is what
 * the caller turns into an unresolved binding. Inventing a target instead is the
 * failure this module is written against.
 */

export type ActionKind =
  | "modify"
  | "verify"
  | "inspect"
  | "create"
  | "remove"
  | "execute"
  /** Keep something exactly as it is. Not a `modify` — it asks for the opposite. */
  | "preserve";

export interface FunctionalCandidate {
  /** What was asked, in the user's own words plus the verb. */
  text: string;
  span: SourceSpan;
  action: ActionKind;
  /** The noun phrase bound to the verb, or empty when the sentence named none. */
  object: string;
}

/**
 * Verbs that describe work on a codebase, and what class each belongs to.
 *
 * Ordered longest-first within a class so `재실행` is not read as `실행`. The
 * particle gap `(?:[은는만도]*\s*)?` is what lets `설명만 해줘` match: a Korean
 * speaker routinely puts a particle and a space between a noun stem and its
 * light verb, and requiring adjacency lost every such request silently.
 *
 * Prohibitions are `statedProhibitions`'s job. This must not duplicate or
 * contradict it, which is what `NEGATED` below enforces.
 */
const GAP = "(?:[은는만도]*\\s*)?";
const verb = (stem: string, tail: string): RegExp => new RegExp(`${stem}${GAP}${tail}`);

const VERBS: ReadonlyArray<{ pattern: RegExp; action: ActionKind }> = [
  { pattern: verb("재실행", "(?:하|해|시켜)"), action: "execute" },
  { pattern: verb("실행", "(?:하|해|시켜)"), action: "execute" },
  { pattern: /돌려(?:줘|주세요|주|봐)/, action: "execute" },
  { pattern: verb("테스트", "(?:하|해)"), action: "verify" },
  { pattern: verb("검증", "(?:하|해)"), action: "verify" },
  { pattern: verb("확인", "(?:하|해)"), action: "verify" },
  { pattern: verb("재현", "(?:하|해)"), action: "verify" },
  { pattern: verb("유지", "(?:하|해)"), action: "preserve" },
  { pattern: verb("보존", "(?:하|해)"), action: "preserve" },
  { pattern: /그대로\s*(?:둬|두|유지)/, action: "preserve" },
  { pattern: verb("수정", "(?:하|해)"), action: "modify" },
  { pattern: /고(?:쳐|치)/, action: "modify" },
  { pattern: verb("개선", "(?:하|해)"), action: "modify" },
  { pattern: verb("리팩터링", "(?:하|해)"), action: "modify" },
  { pattern: /바꿔(?:줘|주세요|주)/, action: "modify" },
  { pattern: verb("추가", "(?:하|해)"), action: "create" },
  { pattern: verb("구현", "(?:하|해)"), action: "create" },
  { pattern: /만들어(?:줘|주세요|주)/, action: "create" },
  { pattern: verb("삭제", "(?:하|해)"), action: "remove" },
  { pattern: verb("제거", "(?:하|해)"), action: "remove" },
  { pattern: verb("분석", "(?:하|해)"), action: "inspect" },
  { pattern: verb("설명", "(?:하|해)"), action: "inspect" },
  { pattern: /보여(?:줘|주세요|주)/, action: "inspect" },
  { pattern: /찾아(?:줘|주세요|주|봐)/, action: "inspect" },
];

/**
 * The forms that turn the verb just matched into its own refusal.
 *
 * Checked against the words *following* the stem, so one rule covers every verb
 * rather than each pattern carrying its own half-guard:
 *
 *     수정하지 마 / 수정하진 마 / 보여주지 마   → 지·진 + 마·말·않·못·안
 *     실행하면 안 돼 / 실행해서는 안 된다      → 면·서는 + 안
 */
const NEGATED = /(?:지|진)(?:는|도|를|은)?\s*(?:마|말|않|못|안)|(?:면|서는)\s*안/;

/** How an act with no stated target is written down. The target stays open. */
const ACT_ONLY: Readonly<Record<ActionKind, string>> = {
  modify: "수정한다",
  verify: "테스트를 실행해 결과를 확인한다",
  inspect: "요청한 내용을 살펴본다",
  create: "추가한다",
  remove: "제거한다",
  execute: "요청한 명령을 실행한다",
  preserve: "기존 동작을 그대로 유지한다",
};

const ACTION_TEXT: Readonly<Record<ActionKind, string>> = {
  modify: "수정한다",
  verify: "확인한다",
  inspect: "살펴본다",
  create: "추가한다",
  remove: "제거한다",
  execute: "실행한다",
  preserve: "그대로 유지한다",
};

/**
 * Words that are grammar rather than a target. An object made of these is none.
 *
 * The connectives are here because of a real misreading: with no entry for
 * `그리고`, "재현해줘. 그리고 검증해줘." produced the requirement "그리고를
 * 확인한다". The bound-noun fragments (`수`, `있는`, `할`) are here because
 * "사용할 수 있는 모델을 확인해줘" came out as "있 모델을 확인한다".
 */
const NOT_AN_OBJECT =
  /^(?:그것|이것|저것|그거|이거|저거|그|이|저|좀|다|전부|모두|잘|적당히|알아서|한번|다시|또|이번|이번에|이번에는|안에서만|여기서|거기서|말고|그리고|또한|하지만|그런데|및|등|수|있는|있을|없는|않는|않은|않을|되는|할|하는|해서|해|그대로|반드시|가능하면|절대|꼭|제대로|계속|미리|먼저|우선|전혀|아직|오늘|어제|내일)$/;

/**
 * Verbs whose act is the requirement even with no stated target.
 *
 * Korean routinely leaves the object implicit, and dropping those loses half of
 * "고치고 테스트해줘" and all of "수정하지 말고 설명만 해줘". What is *not* done
 * is guessing the target — the act is named and the target left open, which the
 * caller carries as an unresolved binding.
 *
 * Deliberately not extended to `modify`, `create` or `remove`. "수정해줘" with
 * nothing to modify tells the runtime nothing it could verify.
 */
const ACT_IS_ENOUGH: ReadonlySet<ActionKind> = new Set<ActionKind>(["verify", "execute", "inspect"]);

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
  // than "오류", "main.py 코드" rather than "py 코드만".
  const marked = /((?:[^\s,]+\s+){0,2}[^\s,]+)\s*(?:을|를)\s*$/.exec(before);
  const phrase = marked?.[1] ?? before;

  const tokens = phrase.split(/\s+/).map((token) => {
    // Location particles can trail any token: a stray "안에서만" would
    // otherwise push "auth" out of the window and leave a bare "폴더".
    const located = token.replace(/(?:안에서만|에서만|에서|안에|까지|부터)$/u, "");
    let out = located;

    // The additive `도`, but only when two syllables survive it. Stripping it
    // unconditionally turns "속도" into "속"; "결과도" and "코드도" are the
    // cases worth recovering and both leave a word behind.
    const dropped = out.replace(/도$/u, "");
    if (out.endsWith("도") && dropped.length >= 2) out = dropped;

    // `을`/`를` mark an object unambiguously, so they can go anywhere they
    // appear. The rest wait until the phrase is chosen — see below.
    out = out.replace(/[을를]$/u, "").trim();

    return {
      text: out,
      // Not part of a noun phrase, whatever it is next to. Three kinds, and each
      // one was a wrong target in a real sentence: a locative that had its
      // particle taken off ("CI에서 pytest를" → "CI pytest"), a clause ending
      // ("실패하면 로그를" → "실패하면 로그"), and a grammar word.
      grammar:
        out.length === 0 ||
        NOT_AN_OBJECT.test(out) ||
        located !== token ||
        /(?:면|고|서|며)$/u.test(out),
    };
  });

  // The last unbroken run of noun tokens, and no further.
  //
  // Taking the last two *surviving* tokens reached across whatever sat between
  // them, so an adverbial phrase before the object became part of it —
  // "src 폴더 안에서만 로그를 추가해줘" gave the target "폴더 로그". Reading from
  // the right and stopping at the first non-noun keeps the phrase the sentence
  // actually built. Before the head is found the same tokens are *skipped*
  // rather than final, because Korean puts trailing adverbs between the object
  // and its verb: "auth 폴더 안에서만 수정하고" still targets "auth 폴더".
  const kept: string[] = [];
  for (let i = tokens.length - 1; i >= 0 && kept.length < 2; i -= 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (token.grammar) {
      if (kept.length === 0) continue;
      break;
    }
    // A topic-marked modifier belongs to a different phrase: "오늘은 main.py를"
    // is a time and a file, not a two-word target. The head may carry the
    // particle — it comes off below — so this applies to modifiers only.
    if (kept.length > 0 && /[은는]$/u.test(token.text)) break;
    kept.unshift(token.text);
  }

  // Case particles come off last, and only from the token that ends the phrase.
  //
  // Stripping them from every token cut `있는` — a verb ending, not a particle —
  // down to `있`, and "사용할 수 있는 모델" came out as "있 모델". Waiting until
  // the grammar words are gone also means the particle is taken off the noun
  // that survived rather than off whichever adverb happened to be last:
  // "기존 API 호환성은 반드시" keeps `호환성`, not `반드시`.
  const lastAt = kept.length - 1;
  if (lastAt >= 0) kept[lastAt] = (kept[lastAt] ?? "").replace(/(?:만|[이가은는의로])$/u, "");

  const joined = kept.filter((t) => t.length > 0).join(" ");
  return joined.length < 2 ? "" : joined;
}

/**
 * `을` or `를`, by whether the last syllable ends in a consonant.
 *
 * A user-facing sentence, so "오류을(를)" is not good enough. Hangul syllables
 * are laid out so the final consonant falls out of the code point directly. A
 * latin ending is read as its Korean transliteration: `l`, `m` and `n` close a
 * syllable (`Agent` → 에이전트 does not, `email` → 이메일 does), and every other
 * letter transliterates to a vowel-final syllable.
 */
function objectParticle(object: string): string {
  const last = object.codePointAt(object.length - 1) ?? 0;
  if (last >= 0xac00 && last <= 0xd7a3) {
    return (last - 0xac00) % 28 === 0 ? "를" : "을";
  }
  const letter = object.slice(-1).toLowerCase();
  if (/[a-z]/.test(letter)) return "lmn".includes(letter) ? "을" : "를";
  return "을";
}

/**
 * Clause boundaries.
 *
 * A sentence end is a full stop *followed by a break*. Splitting on a bare
 * period cut `main.py` in half and the object came out as "py 코드" — a filename
 * is not a sentence boundary.
 *
 * The connective `-고` is matched generally rather than as the literal `하고`.
 * With only `하고`, "main.py 코드도 보여주고 실제 실행 결과도 보여줘" stayed one
 * clause, the single-candidate rule dropped the first request, and the object of
 * the second reached back across both.
 *
 * `말고` needs no alternative of its own: `말` is Hangul and `고` follows it, so
 * the general rule already ends the prohibition there and everything after it is
 * the positive request the user actually made. It had a dedicated branch until
 * mutation testing showed that deleting it changed no behaviour at all.
 */
const BOUNDARIES =
  /(?<=[.!?。])(?=\s|$)|(?<=[가-힣]고\s)|(?<=한\s*뒤\s)|(?<=한\s*다음\s)|(?<=면서\s)|(?<=,\s)/;

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

  let offset = 0;
  for (const clause of input.text.split(BOUNDARIES)) {
    const at = input.text.indexOf(clause, offset);
    if (at === -1) continue;
    offset = at + clause.length;
    if (clause.trim().length === 0) continue;

    for (const { pattern, action } of VERBS) {
      const match = pattern.exec(clause);
      if (match === null) continue;

      // The user forbade this verb rather than asking for it. Emitting the
      // positive form here would contradict `statedProhibitions`, which is
      // reading the very same words.
      if (NEGATED.test(clause.slice(match.index, match.index + match[0].length + 8))) continue;

      const object = objectBefore(clause, match.index);
      // No object and no act that stands alone: the user asked for something
      // this cannot name, and naming it anyway is inventing.
      if (object.length === 0 && !ACT_IS_ENOUGH.has(action)) continue;

      const text = object.length === 0 ? ACT_ONLY[action] : `${object}${objectParticle(object)} ${ACTION_TEXT[action]}`;
      // Keyed on the act and its target, not the rendered sentence, so a
      // rewording never silently merges two different asks.
      const key = `${action}:${object}`;
      if (seen.has(key)) continue;
      seen.add(key);

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
