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
const GAP = "(?:(?:[은는만도을를]*|까지)\\s*)?";

interface VerbEntry {
  pattern: RegExp;
  action: ActionKind;
  /** How the requirement reads. Absent falls back to the class in `ACTION_TEXT`. */
  phrase?: string;
}

/**
 * A noun-verb, and the words it renders as.
 *
 * The phrase is the stem the user wrote rather than a representative of its
 * class, because the representative renames the act. `번역해줘` came back as
 * "수정한다"; `분석` and `비교` both as "살펴본다"; `학습` as "실행한다". A tool
 * whose entire job is to show a person what it understood cannot hand them back
 * a different verb from the one they typed — and the difference is not cosmetic:
 * "결과를 살펴본다" and "결과를 비교한다" are different deliverables.
 *
 * `render` overrides where the class phrase carries a word the stem does not.
 * `preserve` says "그대로 유지한다", and dropping 그대로 turns "leave it alone"
 * into "maintain it". The two English stems take their class phrase for the
 * obvious reason: "fix한다" is not Korean.
 *
 * Each call also records its stem in `STEMS`, which is what lets the noun-phrase
 * scan below tell a verb from a noun. Collected here rather than written out
 * beside it, because a verb added in one place and forgotten in the other
 * quietly becomes a target: `생성하는 도구를 만들어줘` targeted `생성하는 도구`,
 * with a verb sitting in the middle of the noun phrase.
 */
const STEMS: string[] = [];

/**
 * What each noun-verb stem means, for the light-verb reading below.
 *
 * `STEMS` alone says a word is a verb somewhere; this says which act it is
 * and how it reads. Filled by the same call, for the same reason `STEMS` is:
 * a stem added in one place and forgotten in another is the bug this file
 * keeps finding.
 */
const STEM_ENTRY = new Map<string, { action: ActionKind; phrase: string }>();

const verb = (stem: string, tail: string, action: ActionKind, render?: string): VerbEntry => {
  STEMS.push(stem);
  STEM_ENTRY.set(stem, { action, phrase: render ?? `${stem}한다` });
  return {
    pattern: new RegExp(`${stem}${GAP}${tail}`),
    action,
    phrase: render ?? `${stem}한다`,
  };
};

const VERBS: ReadonlyArray<VerbEntry> = [
  verb("재실행", "(?:하|해|시켜)", "execute"),
  verb("실행", "(?:하|해|시켜)", "execute"),
  // `되돌려` is not `돌려`: "의존성을 되돌려줘" is a revert, and this pattern was
  // matching the tail of it and producing "의존성 되를 실행한다" — a made-up target
  // for an act the user did not ask for.
  { pattern: /(?<!되)돌려(?:줘|주세요|주|봐)/, action: "execute" },
  // The plain stem with a connective, the same shape the `바꾸` entry covers.
  // "테스트를 돌리고 실패하면 고쳐줘" is an ordinary request and produced
  // nothing, because only `돌려-` was recognised.
  { pattern: /(?<!되)돌리(?:고|면|는|며|자|라|기)/, action: "execute" },
  // Work a project asks for that a codebase does not. These are absent from the
  // list above because it grew around editing a repository, and the designer
  // invites the other kind of request: "학습시켜줘", "설치해줘",
  // "다운로드해줘" are the verbs a model-selection request is made of, and each
  // produced no requirement at all.
  verb("설치", "(?:하|해)", "execute"),
  verb("학습", "(?:하|해|시켜)", "execute"),
  verb("훈련", "(?:하|해|시켜)", "execute"),
  verb("다운로드", "(?:하|해|받)", "execute"),
  verb("배포", "(?:하|해)", "execute"),
  verb("추론", "(?:하|해)", "execute"),
  // "CNN부터 Transformer까지 사용하고" names what the project is built out of, and
  // it read as nothing at all.
  //
  // `쓰다` is the other half of this and is deliberately absent: "보고서를 쓰고"
  // is writing, not using, and nothing here can tell the two apart from the
  // object alone. A missed request is a gap; a request turned into the wrong act
  // is an invention, and this file is written against the second one.
  verb("사용", "(?:하|해)", "execute"),
  // Generative media, which is the third kind of project this has been asked to
  // read and the first one where half the ordinary sentences produced nothing.
  // Running a renderer and trying something again are both `execute`; what they
  // have in common is that a machine does work and no file is authored by the
  // act itself.
  verb("렌더링", "(?:하|해)", "execute"),
  verb("시도", "(?:하|해)", "execute"),
  verb("테스트", "(?:하|해)", "verify"),
  verb("검증", "(?:하|해)", "verify"),
  verb("확인", "(?:하|해)", "verify"),
  verb("측정", "(?:하|해)", "verify"),
  verb("평가", "(?:하|해)", "verify"),
  verb("재현", "(?:하|해)", "verify"),
  verb("유지", "(?:하|해)", "preserve", "그대로 유지한다"),
  verb("보존", "(?:하|해)", "preserve", "그대로 유지한다"),
  { pattern: /그대로\s*(?:둬|두|유지)/, action: "preserve" },
  verb("수정", "(?:하|해)", "modify"),
  { pattern: /고(?:쳐|치)/, action: "modify" },
  verb("개선", "(?:하|해)", "modify"),
  verb("리팩터링", "(?:하|해)", "modify"),
  { pattern: /바꿔(?:줘|주세요|주(?![는던]))/, action: "modify" },
  // The plain stem, which only `바꿔주-` covered. "이름을 바꾸되", "이름을 바꾸고",
  // "이름을 바꾸면서" are ordinary requests and produced no requirement at all —
  // and every one of them is half of a rename-versus-keep pair, so the sentences
  // that most need a conflict check were the ones that reached it with nothing to
  // compare. Negation is still decided once, below, so "바꾸지 마" stays a
  // prohibition rather than becoming a request to change something.
  { pattern: /바꾸(?:되|고|면|니|는|어|었|자|라|시)/, action: "modify" },
  // Reverting is `modify` — something that exists changes — but it is not the
  // class phrase. "의존성을 되돌려줘" reported "의존성을 수정한다", which is a
  // different deliverable: one puts the dependency back where it was and the
  // other changes it to something new. The comment on `돌려` above already says
  // this verb is the one that gets confused; this is the other half of it.
  { pattern: /되돌[리려](?:줘|주세요|주|기|고|되)?/, action: "modify", phrase: "되돌린다" },
  verb("정리", "(?:하|해)", "modify"),
  verb("갱신", "(?:하|해)", "modify"),
  verb("번역", "(?:하|해)", "modify"),
  // `변환` is `modify` rather than `create` on the argument the sentence itself
  // makes: "이미지를 영상으로 변환해줘" marks the *source* as the object. What is
  // asked for is that this thing become another form, not that a second thing
  // appear beside it. `설정` is the same class for the same reason — it changes
  // how something already behaves.
  verb("변환", "(?:하|해)", "modify"),
  verb("설정", "(?:하|해)", "modify"),
  { pattern: /움직이(?:게|도록|는)/, action: "modify", phrase: "움직이게 한다" },
  // English stems, because Korean sentences use them with a Korean ending:
  // "refactor 해줘", "fix 해줘". The particle gap already allows the space.
  verb("refactor", "(?:하|해)", "modify", "수정한다"),
  verb("fix", "(?:하|해)", "modify", "수정한다"),
  verb("추가", "(?:하|해)", "create"),
  verb("구현", "(?:하|해)", "create"),
  // `만든다`, not the class phrase. The rule the noun-verbs above follow — the
  // requirement says the word the user said — was never applied to the entries
  // written as inflections, and `create` reads "추가한다": "이미지를 영상으로
  // 만들어줘" came back as **이미지를 영상으로 추가한다**, which is not Korean
  // and not the request. Making and adding are the same class and different
  // verbs, and the manner phrase is where that stops being a nicety.
  { pattern: /만들어(?:줘|주세요|주(?![는던]))/, action: "create", phrase: "만든다" },
  // The connective forms. "분류기를 만들고 학습해줘" is two acts, and only the
  // second was ever read.
  { pattern: /만들(?:고|면|자|라|어야|어서)/, action: "create", phrase: "만든다" },
  verb("생성", "(?:하|해)", "create"),
  // `create` because a file that did not exist now does, which is the same test
  // `추가` and `구현` pass. `지원` is here rather than under `modify` because
  // "이미지 생성과 영상 생성을 모두 지원해줘" asks for both to be built.
  verb("저장", "(?:하|해)", "create"),
  verb("지원", "(?:하|해)", "create"),
  { pattern: /내보내(?:줘|주세요|주(?![는던])|고|면|서|기)/, action: "create", phrase: "내보낸다" },
  { pattern: /뽑아(?:줘|주세요|주(?![는던])|봐)/, action: "create", phrase: "뽑아낸다" },
  { pattern: /넣어(?:줘|주세요|주(?![는던]))/, action: "create", phrase: "넣는다" },
  { pattern: /붙여(?:줘|주세요|주(?![는던])|서)/, action: "create", phrase: "붙인다" },
  verb("삭제", "(?:하|해)", "remove"),
  verb("제거", "(?:하|해)", "remove"),
  verb("분석", "(?:하|해)", "inspect"),
  verb("비교", "(?:하|해)", "inspect"),
  verb("조사", "(?:하|해)", "inspect"),
  // "웹과 Hugging Face 도 참고하고" — a request to go and read something, and one
  // of the most common things a design request says. It produced nothing.
  verb("참고", "(?:하|해)", "inspect"),
  verb("검토", "(?:하|해)", "inspect"),
  // `살펴보다` was the word this file *renders* for the whole inspect class and
  // not a word it could read: "결과와 로그를 살펴봐줘" produced nothing at all.
  { pattern: /살펴(?:봐|보)/, action: "inspect" },
  verb("설명", "(?:하|해)", "inspect"),
  { pattern: /보여(?:줘|주세요|주(?![는던])|달라|다오)/, action: "inspect" },
  { pattern: /찾아(?:줘|주세요|주(?![는던])|봐)/, action: "inspect" },
  // "원인을 알려줘" is a request to look and report, and one of the most common
  // shapes there is. It produced nothing at all.
  { pattern: /알려(?:줘|주세요|주(?![는던])|줄래|주라|다오)/, action: "inspect" },
];

/**
 * The forms that turn the verb just matched into its own refusal.
 *
 * Checked against the words *following* the stem, so one rule covers every verb
 * rather than each pattern carrying its own half-guard:
 *
 *     수정하지 마 / 수정하진 마 / 보여주지 마   → 지·진 + 마·말·않·못·안
 *     실행하면 안 돼 / 실행해서는 안 된다      → 면·서는 + 안
 *     실행하라는 게 아니라 보여달라는 말이야    → 라는 + 게/것이/건/말이 + 아니
 *
 * The third form is how a person corrects an agent that did the wrong thing, and
 * it was read as a request to do that thing again: "아니, 실행하라는 게 아니라
 * 코드를 보여달라는 말이야" produced "요청한 명령을 실행한다" — the correction
 * turned into the very act it was issued against.
 */
const NEGATED =
  /(?:지|진)(?:는|도|를|은)?\s*(?:마|말|않|못|안)|(?:면|서는)\s*안|(?:라|다|자|란)는?\s*(?:게|것이|건|말이)\s*아니/;

/** How an act with no stated target is written down. The target stays open. */
/**
 * The same list in English, for a request that was written in English.
 *
 * Without it an English sentence with no object came back as "테스트를 실행해
 * 결과를 확인한다" — the right reading, rendered in a language the person who
 * typed it may not read. The Korean side of this file renders Korean for the
 * same reason.
 */
const ACT_ONLY_EN: Readonly<Record<ActionKind, string>> = {
  modify: "make the change",
  verify: "run the tests and check the result",
  inspect: "look at what was asked about",
  create: "add it",
  remove: "remove it",
  execute: "run the requested command",
  preserve: "leave the existing behaviour as it is",
};

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
 *
 * `하나`/`둘`/`셋`/`넷` are the standalone number words, which count a list
 * rather than name a thing: "mp4랑 gif 둘 다 저장해줘" put the 둘 into the
 * target. Only the standalone forms — the adnominal `한`/`두`/`세`/`네` are in
 * `NUMERAL`, where they pair with the counter that follows them.
 */
const NOT_AN_OBJECT =
  /^(?:그것|이것|저것|그거|이거|저거|그|이|저|좀|다|전부|모두|잘|적당히|알아서|한번|다시|또|이번|이번에|이번에는|안에서만|여기서|거기서|말고|그리고|또한|하지만|그런데|및|등|수|있는|있을|없는|않는|않은|않을|되는|할|하는|해서|해|그대로|반드시|가능하면|절대|꼭|제대로|계속|미리|먼저|우선|전혀|아직|실제|실제로|맞춰|맞추어|따라|위해|통해|대해|같이|함께|오늘|어제|내일|왜|어떻게|무엇|뭐|뭔가|무언가|누군가|언젠가|어디|언제|누가|얼마나|어떤|어느|무슨|게|것|건|걸|거|바|줄|뿐|때문|따름|아니|아니라|것이|말이|하나|둘|셋|넷)$/;

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
 * Endings that close a clause, spelled out rather than by their last syllable.
 *
 * This was `/(?:면|고|서|며)$/` — a single syllable — and it dropped every noun
 * that happens to end in one of them. "문서를 갱신해줘" produced no requirement at
 * all, because `문서` ends in `서` and was read as a connective; so did `명세서`,
 * `순서`, `화면` and `측면`. The development set contained no such noun, which is
 * why a holdout set exists.
 *
 * These endings attach to verb stems, so the stem is part of the pattern. `-고`
 * and `-면서` are absent on purpose: the clause splitter already breaks on both,
 * so a token ending in them cannot sit in front of a verb in the same clause.
 */
const CLAUSE_ENDING = /(?:[하되지으우이라]면|[해어아여]서|[하되이]며|는지|은지|을지|인지)$/u;

/**
 * A verb wearing an adnominal ending, sitting inside a noun phrase.
 *
 * Korean builds relative clauses by putting the verb in front of the noun, and
 * the verb is not part of the noun phrase however adjacent it is:
 *
 *     생성하는 도구를 만들어줘        → 도구      (not `생성하는 도구`)
 *     만들어주는 프로젝트를 만들어줘   → 프로젝트  (not `만들어주는 프로젝트`)
 *     생성된 영상을 저장해줘          → 영상      (not `생성된 영상`)
 *
 * Two halves, because two different things give a verb away. The first is the
 * auxiliary: anything ending in `주는`, `하는`, `되는` is a verb form whatever
 * stem it is built on, and no Korean noun ends that way. The second needs the
 * lexicon — `-한`, `-된`, `-할` are also how adjectives and nouns end — so it
 * fires only on a stem this file already recognises as an act.
 *
 * That second restriction is what keeps `실패한 부분`, `낡은 설정` and
 * `업로드한 사진` intact: those modifiers carry content, the gold set pinned
 * them as part of the target, and none of their stems is one of these verbs.
 * The rule reaches exactly as far as the list of acts and no further.
 */
const VERB_FORM = /(?:(?:어|아|여)?주는|하는|되는|시키는|받는|(?:라|다|자|냐)는)$/u;
const VERB_ADNOMINAL = new RegExp(
  // `생성하는`, `생성되는`, `학습시키는` — the light verb is present and settles it.
  `^(?:${STEMS.join("|")})(?:(?:하|되|시키)[는던]` +
    // `생성된`, `생성한`, `사용할`, `삭제될` — the ending carries the verb itself.
    `|[한된할될])$`,
  "u",
);

/**
 * A verb wearing the conditional `-면`, which `CLAUSE_ENDING` cannot see.
 *
 * That list is spelled by syllable — `[하되지으우이라]면` — because it has to
 * leave `화면`, `측면`, `순서` and every other noun that happens to end that way
 * alone. `바꾸면` ends in 꾸, so it fell outside, and "프롬프트를 바꾸면 결과가
 * 어떻게 달라지는지 비교해줘" took its target from inside the condition.
 *
 * The lexicon settles what the syllable cannot: a token ending in 면 is a verb
 * when one of the acts above matches it. `화면` matches nothing here and stays a
 * noun; `바꾸면` matches the rename entry and stops the scan.
 */
function conditionalVerbToken(token: string): boolean {
  return token.endsWith("면") && VERBS.some((entry) => entry.pattern.test(token));
}

/**
 * The connectives that join the members of a noun list, as they attach to one.
 *
 * `및` and `그리고` are absent because they stand alone as tokens, and
 * `NOT_AN_OBJECT` already ends a run on them — "A 및 B를 수정해줘" targets `B`,
 * and this does not change that. Recorded rather than fixed: stepping *over* a
 * standalone connective is a different rule with a different failure mode.
 */
const COORDINATOR = /(?:[과와]|랑|이랑)$/u;

/**
 * Nouns that cannot stand alone, so nothing in front of them can be a target.
 *
 * `등` is deliberately absent. It means "and so on" and attaches *after* a real
 * noun — "파일 등을 만들어줘" is about the files — so treating it like the others
 * would delete the thing the sentence is about.
 */
const BOUND_NOUN = /^(?:것|걸|거|게|건|바|줄|뿐|때문|따름|수|데)$/u;

/**
 * An adverb standing between the modifier position and the object.
 *
 * `NOT_AN_OBJECT` already lists a dozen of these — 좀, 잘, 반드시, 먼저 — one at
 * a time, as each turned up in a wrong target. Asking the three project topics
 * again turned up six more in ten sentences, every one of them the same shape:
 *
 *     음악 없이 영상만 만들어줘      →  없이 영상을 만든다
 *     가급적 빠르게 영상을 만들어줘  →  빠르게 영상을 만든다
 *     일단 프로토타입을 만들어줘     →  일단 프로토타입을 만든다
 *     특히 화질을 확인해줘           →  특히 화질을 확인한다
 *     대충 결과만 보여줘             →  대충 결과를 살펴본다
 *
 * So the productive forms are read rather than listed. `-히` builds an adverb
 * from almost anything and builds no noun; the `-게` suffixes here are the ones
 * that attach to an adjective stem — 간단하게, 자연스럽게, 빠르게 — which is
 * what keeps `가게` and `무게` out of it. The monosyllabic adjectives have no
 * such marker and are listed, because 짧게 and 가게 have the same shape and only
 * the lexicon separates them.
 *
 * The bare adverbs stay a list for the same reason `NOT_AN_OBJECT` is one:
 * there is nothing in the shape of `일단` that says it is not a noun.
 */
const ADVERB =
  /^(?:없이|일단|대충|되도록|가급적|웬만하면|빨리|얼른|이미|방금|아까|이제|그냥|차라리|오히려|아무튼|어쨌든|따로|바로|직접)$|^[가-힣]+히$|(?:하게|롭게|럽게|르게|프게|쁘게|잖게|찮게)$|^(?:짧|크|작|쉽|길|좋|얇|넓|높|낮|많|적|늦)게$/u;

/**
 * A noun that says only *when*: `전처리 후`, `학습 중`, `생성 이후`.
 *
 * The clause splitter already takes "…한 뒤" and "…한 다음" out of the sentence;
 * these are the same words standing after a plain noun, which it cannot see.
 *
 * Only the words that head a time phrase and never modify a noun. `전`, `다음`
 * and `이전` were here and came out: they are just as often adnominal — "이전
 * 결과를 비교해줘", "다음 단계를 실행해줘" — and a head rule applied to those
 * deletes the modifier the user wrote. The ones left cannot stand in front of a
 * noun in that way.
 */
const TIME_HEAD = /^(?:후|뒤|중|이후|동안|사이)$/u;

/** A number word standing in front of its counter: `한 장`, `두 개`, `5초`. */
const NUMERAL = /^(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|몇|여러|\d+)$/u;

/**
 * Nouns whose last syllable is `도` and is not the additive particle.
 *
 * `-도` builds measure nouns from Sino-Korean roots, so this is a suffix rather
 * than a closed class, and every one of these is a word a project that measures
 * anything will write down. Listed because nothing in the shape of `해상도`
 * separates it from `결과도`, and the cost of getting it wrong is a target the
 * user does not recognise: `프레임 수와 해상`.
 */
const MEASURE_NOUN =
  /^(?:.*(?:속도|해상도|정확도|밀도|온도|각도|채도|명도|강도|빈도|정도|고도|위도|경도|진도|척도|난이도|만족도|신뢰도|충실도|완성도|기여도|중요도|우선도|유사도|선명도|투명도|가용도))$/u;

/**
 * The object of a verb: the noun phrase immediately before it.
 *
 * Immediately, and in the same clause. Reaching further back finds a noun from
 * a different thought and attaches it to this verb, which is how "로그인 오류를
 * 수정하고 테스트해줘" would become "로그인 오류를 테스트한다" — a requirement the
 * user did not state.
 */
function objectBefore(clause: string, verbStart: number): { target: string; shown: string } {
  const before = clause.slice(0, verbStart).trim();
  if (before.length === 0) return { target: "", shown: "" };

  // The marked phrase, as wide as the sentence wrote it.
  //
  // It used to stop at three tokens, which is one bound too many. The branch
  // below that runs when no `을`/`를` is present has never been capped at all,
  // and the run-of-nouns scan under this is what actually stops a phrase
  // reaching into the previous thought. So the cap applied only to the
  // sentences that marked their object *most* clearly — and it cut them:
  // "개와 고양이 분류 프로젝트를 만들어줘" never saw the word 개와 at all.
  // Where the object particle actually is, which is not always the end.
  //
  // The regex this replaces was anchored at `$`, so it only fired when `을`/`를`
  // closed the phrase immediately in front of the verb. Korean puts the
  // instrumental after the object all the time — "이미지 한 장을 5초 영상으로
  // 변환해줘" — and every one of those sentences fell through to the uncapped
  // branch and took its target from whatever happened to sit last, which was the
  // means rather than the thing.
  // The scan stops at a clause ending, so it cannot take its object from a
  // different thought. "프롬프트를 바꾸면 결과가 어떻게 달라지는지 비교해줘"
  // marks 프롬프트 inside the condition and marks nothing in the request, and
  // without this the comparison came out as being about the prompt.
  const beforeTokens = before.split(/\s+/);
  let markAt = -1;
  for (let i = beforeTokens.length - 1; i >= 0; i -= 1) {
    const token = beforeTokens[i] ?? "";
    if (CLAUSE_ENDING.test(token) || conditionalVerbToken(token)) break;
    if (/[을를]$/u.test(token)) {
      markAt = i;
      break;
    }
  }
  const marked = markAt === -1 ? null : beforeTokens.slice(Math.max(0, markAt - 6), markAt + 1);
  // Without the particle. It is grammar, the token scan takes it off anyway, and
  // leaving it on made the phrase stop ending with its own head noun — which is
  // the test the `shown` rule below uses to decide they are the same phrase.
  const phrase = marked === null ? before : marked.join(" ").replace(/[을를]$/u, "");

  /**
   * Whether this clause marks its object with `을`/`를` anywhere in front of
   * the verb — not only at the end, which is what `marked` above requires.
   *
   * It gates the instrumental rule below and nothing else. When the sentence
   * has said which noun is the object, a `-로` phrase is certainly not it; when
   * the sentence has marked nothing, the `-로` phrase may be the only noun
   * there is, and dropping it would leave the request with no target at all.
   */
  const marksItsObject = /[을를](?:\s|$)/u.test(before);

  const tokens = phrase.split(/\s+/).map((token) => {
    // Location particles can trail any token: a stray "안에서만" would
    // otherwise push "auth" out of the window and leave a bare "폴더".
    //
    // `까지` and `부터` used to be in this list and are not location. They mark
    // the two ends of a range, and both ends are the target: "CNN부터
    // Transformer까지 사용하고" had every one of its tokens marked as grammar and
    // came out with no object at all, so a request naming two architectures
    // named nothing. They come off with the other case particles instead, at the
    // end of the phrase only, which leaves "CNN부터 Transformer" — the range as
    // the user wrote it.
    //
    // The instrumental `-로`/`-으로` joins the locatives, because it names a
    // means and never the thing acted on. "결과를 미리보기로 보여줘" targets
    // 결과, not `결과 미리보기`; "사진을 애니메이션으로 바꿔줘" targets the photo,
    // not the animation it is turned into. Both came out with the method welded
    // onto the object, which reads as a target the user never named.
    //
    // Two guards, because `-로` cannot be told from a noun that ends in 로.
    // `고속도로` would become `고속도`, and unlike the other rules here that
    // error *drops* a real target rather than adding a false one. So it applies
    // only when the sentence has already said which noun is the object — if
    // `을`/`를` marks something else, this phrase is certainly not it — and only
    // when at least two Hangul syllables precede the particle, which spares
    // `경로`, `통로`, `진로`, `회로` and their kin. `고속도로 정보를 추가해줘`
    // still loses its 고속도로; that is the case left over, and it is recorded rather
    // than hidden.
    const located = !marksItsObject
      ? token.replace(/(?:안에서만|에서만|에서|안에|에만|[안밖위속앞뒤옆]의)$/u, "")
      : token
          // The bare dative-locative joins the list once the object is settled.
          // "정지 이미지에 움직임을 넣어줘" is about the motion; the image is
          // where it goes. Held back until then for the same reason as `-로`:
          // with nothing else marked, the `-에` phrase may be all there is.
          .replace(/(?:안에서만|에서만|에서|안에|에게|에만|[안밖위속앞뒤옆]의|에)$/u, "")
          .replace(/(?<=[가-힣]{2,})으로$/u, "")
          .replace(/(?:(?<=[가-힣]{2,})|(?<=[A-Za-z0-9]{2,}))로$/u, "");
    let out = located;

    // The additive `도`, but only when two syllables survive it. Stripping it
    // unconditionally turns "속도" into "속"; "결과도" and "코드도" are the
    // cases worth recovering and both leave a word behind.
    //
    // Length is not enough on its own, which "해상도" showed: it leaves "해상",
    // a perfectly plausible two-syllable word, so the guard passed and a request
    // to configure the resolution came out as `프레임 수와 해상`. `-도` is a live
    // suffix for measure nouns — degree, rate, accuracy — and the words it makes
    // are exactly the ones a project measuring anything will name. They are
    // listed rather than guessed at, because there is nothing in the shape of
    // `해상도` that distinguishes it from `결과도`.
    const dropped = out.replace(/도$/u, "");
    if (out.endsWith("도") && dropped.length >= 2 && !MEASURE_NOUN.test(out)) out = dropped;

    // `을`/`를` mark an object unambiguously, so they can go anywhere they
    // appear. The rest wait until the phrase is chosen — see below.
    const carriesObjectMark = /[을를]$/u.test(out);
    out = out.replace(/[을를]$/u, "").trim();

    // The same token with a case particle taken off, for the grammar tests only.
    //
    // `오늘은` is a time plus `은`, and `낡은` is an adjective whose ending happens
    // to be the same syllable. Testing the bare form separates them without a
    // rule about which syllable means what: `오늘` is in the list below and `낡`
    // is not. Breaking on a trailing `은`/`는` instead — which is what this
    // replaced — dropped every adnominal modifier, so "낡은 설정을 삭제하고" targeted
    // `설정` and "낡은 핸들러" targeted `핸들러`.
    //
    // `이`/`가`/`만` come off for the same reason: "무엇이 문제인지만 알려줘" named no
    // target, and reading `무엇이` as a noun made one up out of the question word.
    // A comma comes off first. It is punctuation, not part of the word, and it
    // only reaches this scan at all because a verbless piece is now folded into
    // the clause that follows it — which is how `먼저,` arrived here wearing one
    // and passed every test `먼저` fails.
    const bare = out.replace(/,$/u, "").replace(/[은는만이가]$/u, "");

    // The same token with *any* case particle taken off, for the two lexical
    // tests that ask what kind of noun this is.
    //
    // `bare` above takes off one particle from a closed set, which is right for
    // separating `오늘은` from `낡은`. It is not enough for a bound noun or a
    // time word, because those turn up wearing whatever particle the sentence
    // needed — and each one then walked into a target:
    //
    //     그중 제일 나은 걸로 영상을 만들어줘  →  걸로 영상을 만든다
    //     생성 중에는 진행률을 보여줘          →  중에는 진행률을 살펴본다
    //
    // `걸` and `중` are both already in the lists that would have stopped them;
    // what got past was the `로` and the `에는`. Kept apart from `bare` because
    // this strip is deliberately greedy and would cut real nouns short — `속도`
    // becomes `속` — which is harmless for asking "is this a bound noun" and
    // wrong for anything else.
    const head = out.replace(/(?:에는|에도|에서|에게|에|으로|로|만|도|은|는|이|가)+$/u, "");

    return {
      text: out,
      /** This token was marked as an object by the sentence itself. */
      carriesObjectMark,
      /**
       * The sentence made this its topic, with `은`/`는`.
       *
       * A topic is a full noun phrase and never a bare modifier, which is what
       * the rule below needs to know. "API Key는 SecretStorage에만 저장하고"
       * had its whole target thrown away as a modifier of `SecretStorage`,
       * because the rule fires whenever the run is not marked with `을`/`를` —
       * and this sentence marks its subject instead. Nothing came out at all,
       * for a requirement about where a secret may be stored.
       */
      carriesTopicMark: /[은는]$/u.test(token.replace(/,$/u, "")) && bare.length > 0,
      /**
       * Grammar, but with a noun still inside it — `영상으로`, `미리보기로`.
       *
       * Different from a bare particle word like `안에서만`, which leaves
       * nothing behind. A modifier standing in front of one of these belongs to
       * *it*, not to the verb: `5초짜리` describes the 영상, and reading it as
       * the thing being converted produced "5초짜리를 영상으로 변환한다".
       */
      carriesNoun: located !== token && located.length > 0,
      /**
       * Nothing to the left of this can be the target.
       *
       * Stronger than `grammar`, which is only skipped while the run has not
       * started — the scan below steps over an adverb to reach the noun behind
       * it, and that is right for an adverb. It is wrong for a time head: the
       * noun in front of 후/중/이후 belongs to the time phrase, so stepping over
       * it made "전처리 후 학습을 해줘" mean training the preprocessing.
       */
      closesPhrase: TIME_HEAD.test(head),
      // Not part of a noun phrase, whatever it is next to. Three kinds, and each
      // one was a wrong target in a real sentence: a locative that had its
      // particle taken off ("CI에서 pytest를" → "CI pytest"), a clause ending
      // ("실패하면 로그를" → "실패하면 로그"), and a grammar word.
      grammar:
        out.length === 0 ||
        NOT_AN_OBJECT.test(out) ||
        NOT_AN_OBJECT.test(bare) ||
        BOUND_NOUN.test(head) ||
        TIME_HEAD.test(head) ||
        ADVERB.test(out) ||
        ADVERB.test(bare) ||
        located !== token ||
        CLAUSE_ENDING.test(out) ||
        CLAUSE_ENDING.test(bare) ||
        questionEnding(out, carriesObjectMark) ||
        conditionalVerbToken(out) ||
        // A relative clause's verb, tested on `token` rather than `out`: the
        // `[은는만이가]` strip above would turn `생성하는` into `생성하` and
        // `만들어주는` into `만들어주`, hiding the very ending that identifies it.
        VERB_FORM.test(token) ||
        VERB_ADNOMINAL.test(token),
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
  const run: string[] = [];
  let runEndsAt = -1;
  let runMarked = false;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (token.closesPhrase) break;
    if (token.grammar) {
      if (run.length === 0) continue;
      break;
    }
    if (run.length === 0) runEndsAt = i;
    if (token.carriesObjectMark) runMarked = true;
    run.unshift(token.text);
  }

  // A bare modifier in front of a noun-plus-particle belongs to that noun.
  //
  // "이미지를 업로드하면 5초짜리 영상으로 변환해줘" marks its object inside the
  // condition, so the scan — which is not allowed to cross a clause boundary —
  // comes back with `5초짜리`, a size with nothing to size. It sits in front of
  // `영상으로`, which is grammar here but still has a noun inside it, and that
  // is what it describes.
  //
  // Only when the run carries no object mark of its own. "결과를 미리보기로
  // 보여줘" has exactly the same shape and `결과` is the object, which the
  // sentence said with `를`; and "auth 폴더 안에서만 수정해줘" is untouched
  // because `안에서만` is a bare particle with no noun in it.
  //
  // A topic is not a bare modifier either. The gate is "the clause marks its
  // object elsewhere", and `을`/`를` is not the only way a clause says which
  // noun it is about: "API Key는 SecretStorage에만 저장하고" marks its topic,
  // and the whole target was thrown away as a modifier of `SecretStorage` — a
  // requirement about where an API key may be stored came out as nothing at
  // all. `5초짜리` carries no such mark and is still dropped.
  const trailing = runEndsAt === -1 ? undefined : tokens[runEndsAt + 1];
  const runTopicMarked = run.length > 0 && tokens[runEndsAt]?.carriesTopicMark === true;
  if (!runMarked && !runTopicMarked && trailing?.grammar === true && trailing.carriesNoun) {
    run.length = 0;
  }

  // What modifies a bound noun belongs to it, not to the verb.
  //
  // "뭔가 좋은 걸 만들어줘" produced `좋은 걸을 추가한다` — a doubled particle on
  // a bound noun, describing nothing — and the design then reported itself ready
  // to run. `걸` is 것+을 and is grammar, which leaves `좋은` standing alone: an
  // adjective with the thing it described taken out from under it.
  //
  // Decided on the bound noun rather than on the shape of the modifier. The
  // morphology does not separate them: `좋은` ends in the adnominal `은`, and so
  // do `파일` and `설정` in their own way, while `빠른` hides its `ㄴ` inside
  // `른`. What is unambiguous is the head — a bound noun cannot stand alone and
  // cannot be a target, so nothing in front of it is one either.
  //
  // This module's header says "적당히 잘 좀 해줘" must yield nothing. "뭔가 좋은
  // 걸 만들어줘" is the same sentence with a verb it happens to know.
  if (trailing?.grammar === true && BOUND_NOUN.test(trailing.text)) run.length = 0;


  // Two of that run, unless the run is a list.
  //
  // A coordinated list is one noun phrase however many members it has, and
  // cutting it at two deletes the rest without a trace. "CNN과 ViT로 분류기를
  // 만들고" gave the target "ViT로 분류기": a request naming two architectures
  // came out naming one, and the member it dropped was the one the user put
  // first. Same for "개와 고양이 분류 프로젝트" and "CNN과 Transformer로 이미지
  // 분류기".
  //
  // `과`/`와` also end ordinary nouns — `결과`, `성과`, `효과` — so this widens
  // the phrase for some sentences that coordinate nothing. That error runs in
  // one direction only: the run is already bounded by the clause and by every
  // grammar token inside it, so a false positive shows more of the user's own
  // words and can never reach a word from another thought.
  //
  // The connective needs something after it to connect to, which is what stops
  // a phrase merely *ending* in 결과 from widening.
  const coordinated = run.some((token, i) => i < run.length - 1 && COORDINATOR.test(token));

  // A numeral and the counter it belongs to are one word, so the window counts
  // them as one.
  //
  // "이미지 한 장을 5초 영상으로 변환해줘" is about an image, and the last two
  // tokens of its phrase are `한 장` — a quantity with nothing to quantify.
  // Korean writes counters as separate words and there is no reading in which
  // `장` is the thing being converted.
  const units: string[] = [];
  for (let i = 0; i < run.length; i += 1) {
    const token = run[i] ?? "";
    const next = run[i + 1];
    if (NUMERAL.test(token) && next !== undefined) {
      units.push(`${token} ${next}`);
      i += 1;
      continue;
    }
    units.push(token);
  }
  const kept = coordinated ? run : units.slice(-2).join(" ").split(/\s+/);

  // Case particles come off last, and only from the token that ends the phrase.
  //
  // Stripping them from every token cut `있는` — a verb ending, not a particle —
  // down to `있`, and "사용할 수 있는 모델" came out as "있 모델". Waiting until
  // the grammar words are gone also means the particle is taken off the noun
  // that survived rather than off whichever adverb happened to be last:
  // "기존 API 호환성은 반드시" keeps `호환성`, not `반드시`.
  const lastAt = kept.length - 1;
  // `으로` before the bare `로`, or the vowel that carries it is left behind.
  //
  // Korean writes the instrumental as `-로` after a vowel and `-으로` after a
  // consonant, and taking off only the `로` produced `동영상으`, `기본값으`,
  // `JSON으`, `파이썬으`. Every one of those is a word that does not exist,
  // shown to the user as the thing their request is about — and none of the
  // checks caught it: the fragment is still a substring of what they typed, so
  // "never invent a target" held while the target was mangled.
  if (lastAt >= 0) {
    kept[lastAt] = (kept[lastAt] ?? "").replace(/(?:까지|부터|으로|만|[이가은는의로])$/u, "");
  }

  const joined = kept.filter((t) => t.length > 0).join(" ");
  const target = joined.length < 2 ? "" : joined;

  // What the sentence says about the target, as opposed to the target itself.
  //
  // These are two different jobs and merging them made both worse. The target is
  // what a run has to be bound to, so a relative clause inside it is a defect:
  // `개와 고양이 분류하는 프로젝트` is not a thing that can be resolved to
  // anything. But taking the clause out means the design stops showing words the
  // user typed, and "프로젝트를 추가한다" is a poor account of a request that
  // named two animals and a classifier.
  //
  // So the clause comes out of the target and stays in the sentence:
  //
  //     target 프로젝트
  //     shown  개와 고양이를 분류하는 프로젝트
  //
  // Four conditions, and each one is a case that came out worse without it.
  //
  //   · it holds a relative clause or a real list — the two ways a sentence says
  //     something about its target that the target itself cannot carry:
  //
  //         개와 고양이를 분류하는 프로젝트   the verb is not part of the noun
  //         CNN과 ViT로 분류기               a list of means, joined by 과
  //
  //     Not everything wider than the target: "src 폴더 안에서만 로그를 추가해줘"
  //     and "테스트가 실패하면 로그를 추가해줘" would otherwise be shown as flat
  //     statements that swallow a scope and a condition, and a requirement
  //     reading "테스트가 실패하면 로그를 추가한다" claims something the runtime
  //     has no way to honour.
  //   · the coordinator has something after it, the same guard the target window
  //     uses — `결과` ends in the syllable that joins a list, and "이전 실행
  //     결과" coordinates nothing.
  //   · it does not begin with a grammar word. "기준으로 사용할 수 있는 모델"
  //     starts mid-phrase and reads as a fragment.
  //   · five tokens at most. Past that it stops being a description of the
  //     target and becomes the sentence again, URL and all.
  const phraseTokens = phrase.split(/\s+/);
  const describes =
    phraseTokens.some((token, i) => VERB_FORM.test(token) || VERB_ADNOMINAL.test(token)) ||
    phraseTokens.some((token, i) => i < phraseTokens.length - 1 && COORDINATOR.test(token));
  const described =
    marked !== null &&
    target.length > 0 &&
    phrase.endsWith(target) &&
    phrase !== target &&
    phraseTokens.length <= 5 &&
    tokens[0]?.grammar === false &&
    describes
      ? phrase
      : target;

  return { target, shown: described };
}

/**
 * How an act with no target reads.
 *
 * The class phrase is the default and usually the better sentence: "테스트해줘"
 * with nothing to test means "테스트를 실행해 결과를 확인한다", which says more
 * than the verb alone did and says it in the user's word.
 *
 * It stops being the better sentence when the class phrase no longer contains
 * that word. "학습까지 해줘" is an `execute`, and `execute` reads "요청한 명령을
 * 실행한다" — a requirement that has quietly dropped the only thing the user
 * named. So the class phrase stands while it still says what they said, and the
 * stem takes over when it does not.
 */
function actOnlyText(action: ActionKind, stem: string): string {
  const wide = ACT_ONLY[action];
  if (stem === "" || wide.includes(stem)) return wide;
  return STEM_ENTRY.get(stem)?.phrase ?? wide;
}

/** One act, named by the word the user wrote for it. */
interface NamedAct {
  readonly stem: string;
  readonly action: ActionKind;
  readonly phrase: string;
}

/** A run of nouns conjoined in front of a verb, and which of them name acts. */
interface CoordinatedRun {
  /** Every conjoined word, in the order the sentence gave them. */
  readonly words: readonly string[];
  /** Those this file can name an act for, with the act. */
  readonly acts: readonly NamedAct[];
}

const NO_RUN: CoordinatedRun = { words: [], acts: [] };

/**
 * Nouns conjoined immediately in front of a verb.
 *
 * Korean says "학습과 추론을 하고" for "train and infer": two acts sharing one
 * 하다. The particle gap above is what lets `추론을 하고` be read as a verb at
 * all — and the moment it was, the object scan did what it always does and took
 * the word in front, producing **학습과를 추론한다**: a target nobody named,
 * bound to an act nobody asked for, out of a sentence that had said two
 * perfectly ordinary things.
 *
 * Two rules keep it from firing on ordinary sentences, and both are load-bearing:
 *
 *   · **Two syllables at least.** 와/과 is also the last syllable of ordinary
 *     nouns — 결과, 성과, 효과, 사과 — and "결과 확인을 해줘" would otherwise be
 *     read as `결`-conjoined-with-확인 and lose its target entirely. A Korean
 *     content noun of one syllable is rare enough, and the damage of splitting a
 *     two-syllable word is certain enough, that the trade is worth making in
 *     this direction. It also keeps "개와 고양이를" whole.
 *   · **The lexicon decides what is an act**, not the grammar. `words` is what
 *     the sentence conjoined; `acts` is the part this file can name. A conjoined
 *     word it cannot name is left unread — but it is still not the target, so
 *     the caller drops the object rather than rendering "전처리와를 학습한다".
 *     A missed request is a gap; a request bound to an invented target is worse.
 */
function coordinatedBefore(clause: string, verbStart: number): CoordinatedRun {
  const words: string[] = [];
  let head = clause.slice(0, verbStart);
  for (;;) {
    const match = /(?:^|[\s,(])([가-힣]{2,})\s*(?:와|과|및|,)\s*$/u.exec(head);
    if (match === null) break;
    words.unshift(match[1]);
    head = head.slice(0, match.index + match[0].indexOf(match[1]));
  }
  // The one place the lexicon is consulted for this run. The caller takes these
  // as given rather than looking each word up a second time — two guards for one
  // question is how a guard stops being load-bearing without anyone noticing.
  const acts: NamedAct[] = [];
  for (const word of words) {
    const entry = STEM_ENTRY.get(word);
    if (entry !== undefined) acts.push({ stem: word, ...entry });
  }
  return { words, acts };
}

/**
 * The instrumental phrase sitting between the object and its verb.
 *
 * Not part of the target — "README를 한국어로 번역해줘" is about the README, and
 * welding the language onto it produced the target `README 한국어`, a thing that
 * does not exist. But it is part of what the user asked for, and a design that
 * drops it says "README를 번역한다" to someone who specified a language.
 *
 * So it comes out of the target and goes back into the sentence:
 *
 *     README를 한국어로 번역한다
 *     업로드한 사진을 애니메이션으로 수정한다
 *     결과를 미리보기로 살펴본다
 *
 * Gated the same way the target rule is — only when the clause marks its object
 * elsewhere — and refused for the adverbs that merely end in 로. `그대로` is the
 * one that matters: without `NOT_AN_OBJECT` here, "기존 동작을 그대로 유지해줘"
 * renders 그대로 twice.
 */
function mannerBefore(clause: string, verbStart: number): string {
  const before = clause.slice(0, verbStart).trim();
  if (!/[을를](?:\s|$)/u.test(before)) return "";
  const last = before.split(/\s+/).at(-1) ?? "";
  if (NOT_AN_OBJECT.test(last)) return "";
  return /(?:(?<=[가-힣]{2,})으?로|(?<=[A-Za-z0-9]{2,})로)$/u.test(last) ? last : "";
}

/**
 * A verb or adjective wearing `-ㄴ지`, which is a question and never a noun.
 *
 * `CLAUSE_ENDING` spells out `는지`, `은지`, `을지` and `인지`, and Korean writes
 * the same ending inside the syllable when the stem ends in a vowel: 느린지,
 * 빠른지, 클지. Those fell through and became targets — "어디가 느린지 알려줘"
 * produced **느린지를 살펴본다**, a noun that does not exist wearing a particle
 * the user did not type.
 *
 * The syllable before `지` decides it: `-ㄴ지` and `-ㄹ지` are the endings, and a
 * Hangul syllable carries its final consonant in the code point. That does catch
 * ordinary nouns — 편지, 먼지, 반지 — so it applies only where the sentence did
 * *not* mark the token as its object. "편지를 보내줘" keeps its 편지; "편지 보내줘"
 * loses it, and that is a gap rather than an invention.
 */
function questionEnding(token: string, carriesObjectMark: boolean): boolean {
  if (carriesObjectMark || !token.endsWith("지")) return false;
  const previous = token.codePointAt(token.length - 2) ?? 0;
  if (previous < 0xac00 || previous > 0xd7a3) return false;
  const final = (previous - 0xac00) % 28;
  return final === 4 || final === 8;
}

/**
 * An embedded question standing where the object would be.
 *
 * "실제로 호출되는지도 알려줘" asks for one thing and the design said "요청한
 * 내용을 살펴본다" — every word the user chose gone, including the only one that
 * says what to look at. `-는지` is not a noun, so the object scan is right to
 * refuse it as a target; what was missing is that a clause can say what it is
 * about without naming a thing.
 *
 * It stays out of `target`: nothing here resolves to a file or a symbol, and the
 * binding is left unresolved exactly as it was. This decides only what the
 * requirement *reads* as, which is the part a person checks.
 *
 * A clause that marks an object of its own never reaches here — the caller asks
 * only when the object scan came back empty — so "프롬프트를 바꾸면 결과가
 * 어떻게 달라지는지 비교해줘" stays about 결과 without a rule here saying so. It
 * had one, and mutation testing showed that deleting it changed nothing.
 */
function embeddedQuestionBefore(clause: string, verbStart: number): string {
  const before = clause.slice(0, verbStart).trim();
  const last = before.split(/\s+/).at(-1) ?? "";
  const bare = last.replace(/[도만]$/u, "");
  if (!questionEnding(bare, false)) return "";
  return before.replace(/[도만]$/u, "");
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
export function objectParticle(object: string): string {
  // A phrase that already carries a case particle does not take a second one.
  //
  // "모델도 후보에 넣어줘" came out as **모델 후보에를 넣는다** — `후보에` kept
  // its 에 (the locative strip is held back until the sentence marks an object,
  // and this one marks its object with 도) and then the renderer added 를 on
  // top. Two particles in a row is not Korean, and the phrase underneath is not
  // a thing the sentence points at.
  //
  // Only the endings no Korean noun has. `로`, `도`, `과`, `와` and `만` are
  // excluded for the reason they are excluded everywhere else in this file:
  // 고속도로, 해상도, 결과, 성과 end that way and are single words, so a guard
  // written on them would silently drop the particle a real target needs. A
  // sweep over all four corpora — 187 rendered requirements — found exactly one
  // sentence with a doubled particle, and it is an `에`.
  // 한글 앞에서는 두 음절을 요구하고 라틴 문자·숫자 앞에서는 요구하지 않는다.
  // 두 음절 조건은 `결과`·`성과` 처럼 그 음절로 끝나는 낱말을 지키려는 것이고,
  // 라틴 낱말은 한글 음절 `에`로 끝날 수 없으므로 그런 충돌이 없다. 이 구멍으로
  // 보안 요구사항 하나가 새 나갔다 — "API Key는 SecretStorage에만 저장하고" 가
  // **Key는 SecretStorage에를 저장한다** 로 나왔다.
  if (/(?:(?<=[가-힣]{2,})|(?<=[A-Za-z0-9]))(?:에서|에게|으로|에)$/u.test(object)) return "";
  const last = object.codePointAt(object.length - 1) ?? 0;
  if (last >= 0xac00 && last <= 0xd7a3) {
    return (last - 0xac00) % 28 === 0 ? "를" : "을";
  }
  const letter = object.slice(-1).toLowerCase();
  if (/[a-z]/.test(letter)) return "lmn".includes(letter) ? "을" : "를";
  // Digits are read as their Korean names, so the same rule decides: 일, 삼, 육,
  // 칠, 팔 and 영 close their syllable; 이, 사, 오 and 구 do not. `mp4` was
  // coming out as `mp4을` because everything non-Latin fell to the default.
  if (/\d/.test(letter)) return "013678".includes(letter) ? "을" : "를";
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
 *
 * `-어서`/`-해서` is here under a condition, and the condition is the sentence
 * the unconditional version broke. "…를 확인해서 모델 목록을 알려줘" is two acts
 * and only the first was read; "최신 요약 모델을 웹에서 찾아서 정리해줘" is one,
 * because Korean elides the shared object in the second clause and a clause with
 * no object of its own is dropped outright — so splitting it turned one
 * requirement into none.
 *
 * The rule that separates them is the one the failure states: split only where
 * the second half **names its own target**. The lookahead asks for an object
 * mark after the connective and before the sentence ends, which "모델 목록을
 * 알려줘" has and "정리해줘" does not. `[해어아여]서` rather than a bare `서`, so
 * `문서`, `명세서`, `순서` and the locative `-에서` are untouched.
 *
 * `-되` is here for "이름을 바꾸되 기존 동작은 유지해줘" — "do X but Y", which is
 * two requests and was read as one. Since only the first matching verb in a clause
 * becomes a requirement and `유지` is tried before `바꾸`, the whole sentence came
 * out as a lone preserve and the rename it was contrasted with vanished. A space
 * after a Hangul syllable is required, so "안 되" and "적용되었다" are untouched.
 */
const BOUNDARIES =
  /(?<=[.!?。])(?=\s|$)|(?<=[가-힣]고\s)|(?<=[가-힣]되\s)|(?<=한\s*뒤\s)|(?<=한\s*다음\s)|(?<=면서\s)|(?<=,\s)|(?<=[해어아여]서\s)(?=[^.!?。]*[을를]\s)/;

/**
 * Functional candidates in one turn.
 *
 * Splits on clause boundaries first, because Korean chains verbs with `-고` and
 * a single sentence routinely holds two separate requests. "고치고 테스트해줘"
 * is two requirements and reading it as one loses the second.
 */

// ---------------------------------------------------------------------------
// The English pass
// ---------------------------------------------------------------------------

/**
 * The same acts, read out of English.
 *
 * A separate pass rather than more entries in `VERBS`, because the two
 * languages put the target on opposite sides of the verb. Korean is
 * verb-final — `objectBefore` reads leftwards from the verb and that is the
 * whole of how a target is found. English puts it after, so every Korean
 * mechanism here would take the wrong words, and the ones that did not would
 * take them from the previous sentence.
 *
 * Measured before this existed: 0 of 39 English requests produced a
 * requirement, and one of the two English cases in the corpora was the single
 * intent miss in 72. The runtime read English prohibitions — `do not modify`
 * has been in `statedProhibitions` from the start — and nothing else, so an
 * English request arrived as a design that had read nothing and said so with
 * the same confidence as a Korean one it had read completely.
 *
 * The discipline is the one the rest of this file follows: a miss is safe,
 * because the design reports what it read and `understood` says when that was
 * nothing. A false positive is not, so the verbs below are imperatives a
 * request actually uses, the object is bounded, and a negated verb is skipped
 * exactly as it is on the Korean side.
 */
const ENGLISH_VERBS: ReadonlyArray<{ pattern: RegExp; action: ActionKind }> = [
  // Order matters within an action the way it does above: the longer, more
  // specific form is tried first so `look into` is not read as `look`.
  { pattern: /\b(?:re-?implement|reimplement)\b/i, action: "create" },
  // `convert` and `transform` are `modify` on the argument the Korean `변환`
  // settled: the sentence's object is the source, not the result. `set` and
  // `configure` change how something already behaves.
  { pattern: /\b(?:refactor|rewrite|rename|fix|repair|correct|update|modify|edit|change|adjust|improve|clean\s+up|tidy|convert|transform|configure|translate|localis|localiz|set)\b/i, action: "modify" },
  // `export`, `save` and `store` are `create` because a file that did not exist
  // now does — the same test `add` and `implement` pass.
  { pattern: /\b(?:implement|create|add|write|generate|introduce|set\s+up|scaffold|export|save|store|support|attach|extract)\b/i, action: "create" },
  { pattern: /\b(?:remove|delete|drop|strip|get\s+rid\s+of)\b/i, action: "remove" },
  // `build a`/`build an` before the bare `build`, because English has the same
  // two verbs Korean has in `쓰다`: "build a tool" makes something and "build
  // the project" runs a compiler. The article is what a reader uses, and it is
  // the only thing in the sentence that separates them.
  { pattern: /\bbuild\s+(?=an?\b)/i, action: "create" },
  { pattern: /\b(?:run|execute|launch|start|install|build|compile|deploy|render|retry|train|fine-?tune|download|fetch|pull)\b/i, action: "execute" },
  { pattern: /\b(?:test|verify|validate|make\s+sure|measure|evaluate|benchmark|assess)\b/i, action: "verify" },
  // `search` and `check` are here rather than in a research act because this
  // list reads what the user asked the agent to *do*; where it looks is the
  // research decision's question, and `statedResearchDemand` answers it from
  // the same sentence.
  // `tell` is the commonest way an English request opens and it was absent, so
  // "check the model list and tell me which ones are usable" never split at the
  // conjunction — the second verb was not a verb this list knew, so the clause
  // stayed whole and its target came out as `model list and tell me`.
  { pattern: /\b(?:read|explain|describe|inspect|analy[sz]e|review|summari[sz]e|look\s+at|look\s+into|show|tell|list|find|locate|search|check|compare|contrast|preview)\b/i, action: "inspect" },
];

/**
 * A verb the sentence is telling us *not* to do.
 *
 * Read on the words before the verb rather than after it, which is where
 * English puts its negation. `without` is included and `never` is not a
 * prohibition of the following verb alone — "never mind, just read it" is not a
 * ban on reading — so only the forms that attach to the verb are here.
 */
const ENGLISH_NEGATED = /\b(?:do\s+not|don'?t|never|without|avoid|no\s+need\s+to|instead\s+of|rather\s+than)\s*$/i;

/**
 * The politeness and framing a request opens with, which is not its object.
 *
 * "Please fix the login error" has an object of "the login error", and reading
 * the whole tail including `please` would put the word into the requirement.
 */
const ENGLISH_LEAD = /^(?:please|kindly|could\s+you|can\s+you|would\s+you|i\s+want\s+you\s+to|i'?d\s+like\s+you\s+to|let'?s|let\s+me|we\s+should|you\s+should)\s+/i;

/**
 * A feature request, rewritten as the plain imperative it contains.
 *
 * The English half of what `plainImperative` does for `-ㄹ 수 있게 해줘`, and it
 * failed the same way: "Make it possible to set the frame rate and the
 * resolution" read as nothing at all, because the verb the request is about sits
 * too far into the sentence to be an imperative and the words in front of it are
 * not verbs this list knows.
 *
 * Only the frame comes off. Everything from the verb onwards — which is where an
 * English target comes from — is the sentence the user typed, so nothing here
 * can invent one.
 */
const ENGLISH_FEATURE_FRAME =
  /^(?:make\s+it\s+possible\s+to|make\s+it\s+so\s+(?:that\s+)?(?:i|we|you|users?)\s+can|add\s+(?:the\s+|an?\s+)?(?:ability|option)\s+to|allow\s+(?:the\s+)?(?:users?|me|us|people)\s+to|enable\s+(?:the\s+)?(?:users?|me|us|people)\s+to)\s+/i;

/**
 * Where an English object stops.
 *
 * A conjunction starts the next act, and punctuation closes the clause. The
 * object is capped as well: a runaway match would swallow a paragraph and put
 * it in a requirement, which is the shape of invention this file exists to
 * avoid.
 *
 * Two groups were missing, and both produced targets that are not things:
 *
 *   · **relative pronouns**. "a project that turns an uploaded image into a
 *     video" is about the project; without `that` the whole clause became the
 *     target, and "an API that accepts both an image and text" was cut at
 *     `and` into `API that accepts both an image`.
 *   · **adjunct prepositions**. "generate an image from text" is about the
 *     image, "run it on the GPU" is not about the GPU, and "export the result
 *     as mp4" is not about mp4.
 *
 * `for`, `of` and `about` stay out: those introduce the verb's complement
 * rather than an adjunct — "check for errors" is about the errors — and `for`
 * comes off as a leading particle instead.
 *
 * A later pass over the same three topics found six more, every one of them a
 * target the sentence does not contain:
 *
 *     show me the plan without editing anything  →  plan without editing anything
 *     run the tests unless they are slow         →  tests unless they are slow
 *     fix the bug except for the test file       →  bug except for the test file
 *     generate an image if the prompt is valid   →  image if the prompt is valid
 *     export the video only for the demo         →  video only for the demo
 *     add a button between the two panels        →  button between the two panels
 *
 * `without` in particular could not be reached from `with`, because the word
 * boundary that keeps `within` out keeps it out too. `only` is here as the word
 * that introduces the restriction; it needs the space in front of it, which is
 * what leaves "the only file" alone — the article comes off first, so `only`
 * then opens the remainder and matches nothing.
 */
const ENGLISH_OBJECT_END =
  /\s+(?:and|then|but|so|because|after|before|while|to|that|which|who|whose|on|in|at|into|onto|as|from|with|without|by|via|using|unless|except|if|whether|between|among|during|only|within|inside|outside|above|below|beneath|across|around|behind|beyond|near|until|since|throughout|towards?|against|upon)\b|[.,;:!?]/i;

const MAX_ENGLISH_OBJECT = 60;

/**
 * Adverbs and connectives an imperative may open with.
 *
 * Stripped before the position check below, so "just explain it" and "then run
 * the tests" are still read as the requests they are.
 */
const ENGLISH_OPENER = /^(?:just|also|now|first|next|then|and|so|please|again|finally)\s+/i;

/**
 * Whether the verb is where an English imperative puts it: at the front.
 *
 * The check that separates a request from a report. Without it, "Why did the
 * build fail?" produced a requirement to build and "The previous run did not
 * use web search" produced one to run — a question about a past failure and a
 * statement about what someone else did, both read as instructions. English
 * marks the imperative by position, and this is that mark.
 */
function isImperativePosition(body: string, at: number): boolean {
  let head = body.slice(0, at);
  for (;;) {
    const shorter = head.replace(ENGLISH_OPENER, "");
    if (shorter === head) break;
    head = shorter;
  }
  return head.trim().length === 0;
}

/** A question asks; it does not instruct. */
const ENGLISH_QUESTION = /\?\s*$/;

/** Words that are the verb's own particle rather than part of the target. */
/**
 * Words between the verb and its object that are not part of it.
 *
 * `me` and `us` are the indirect object — "show me the result" is about the
 * result, and without them the target was `me the result as a preview`. `for`
 * marks the complement of a search: "check for errors" is about the errors.
 */
/**
 * Whether a fragment opens with one of the acts above.
 *
 * What `and` joins, in English, is either two acts or two nouns, and the word
 * is the same either way — Korean has different connectives for the two and
 * this does not. What separates them is what follows: "fix the bug and test
 * it" continues with a verb, "set the frame count and the resolution" does
 * not.
 *
 * Anchored, so a verb later in the fragment does not count. `slice(0, 24)`
 * because only the opening matters and a long tail costs time for nothing.
 */
function opensWithEnglishVerb(fragment: string): boolean {
  const head = fragment.trim().slice(0, 24);
  return ENGLISH_VERBS.some(({ pattern }) => {
    const match = pattern.exec(head);
    return match !== null && match.index === 0;
  });
}

/**
 * The verb words themselves, pulled out of the table above.
 *
 * Collected from the patterns rather than written out beside them, for the
 * reason `STEMS` is on the Korean side: a verb added in one place and
 * forgotten in the other quietly becomes part of a target. Multi-word and
 * bracketed entries drop out — `clean up`, `analy[sz]e` — and none of them is
 * a participle base that matters.
 */
const ENGLISH_STEMS: ReadonlySet<string> = new Set(
  ENGLISH_VERBS.flatMap(({ pattern }) =>
    pattern.source
      .split("|")
      // The longest run of letters in the alternative.
      //
      // Trimming the ends does not work and looked like it did: the first word
      // of every group arrives as `\b(?:refactor`, and `\b` *contains a letter*,
      // so a leading `[^a-z]+` strips the backslash and stops. That left
      // `b(?:refactor`, which the filter then dropped — silently losing the
      // first verb of each group while the tests kept passing on the ones in the
      // middle.
      //
      // The longest run is right for every entry here and wrong for none:
      // `\b(?:refactor` → refactor, `scaffold)\b` → scaffold, `look\s+at` →
      // look. Multi-word and bracketed entries contribute their first word or a
      // fragment — `summari` out of `summari[sz]e` — and a fragment that is not
      // a word can never be the stem of a participle, so it costs nothing.
      .map((word) => (word.toLowerCase().match(/[a-z]+/g) ?? []).sort((a, b) => b.length - a.length)[0] ?? "")
      .filter((word) => word.length > 1),
  ),
);

/**
 * A participle built on one of those verbs, standing in front of its noun.
 *
 * The English half of the rule the Korean side calls `VERB_ADNOMINAL`: "the
 * generated video" is about the video, exactly as "생성된 영상" is about the
 * 영상. Restricted to verbs this file knows, which is what leaves "the broken
 * pipeline" and "the advanced settings" alone — `break` and `advance` are not
 * acts here, and their modifiers carry content.
 */
function isEnglishParticiple(word: string): boolean {
  const lower = word.toLowerCase();
  if (lower.endsWith("ed")) {
    // `fixed` → fix, `generated` → generate: the silent `e` may or may not be
    // part of the stem, so both readings are tried.
    if (ENGLISH_STEMS.has(lower.slice(0, -2)) || ENGLISH_STEMS.has(lower.slice(0, -1))) return true;
  }
  if (lower.endsWith("ing")) {
    const stem = lower.slice(0, -3);
    if (ENGLISH_STEMS.has(stem) || ENGLISH_STEMS.has(`${stem}e`)) return true;
  }
  return false;
}

/** A leftover that begins with an adjunct: `on the GPU`, `from text`, `as mp4`. */
const ENGLISH_ADJUNCT_HEAD = /^(?:on|in|at|into|onto|as|from|with|by|via|using)\b/i;

/** Nothing but a pronoun, with or without its full stop. */
const ENGLISH_PRONOUN_ONLY = /^(?:it|them|this|that|these|those|one)\b[.!?]?\s*$/i;
const ENGLISH_PARTICLE = /^(?:up|out|for|it|this|that|these|those|all|any|me|us|both)\s+/i;

/**
 * The article, which the target drops and the sentence keeps.
 *
 * The same split the Korean side makes between `object` and the words it
 * renders. A run is bound to `login error`; a person reads "fix the login
 * error". Dropping it from both gave "fix login error", which is a telegram.
 */
const ENGLISH_ARTICLE = /^(?:the|a|an)\s+/i;

/**
 * An English clause that is about a question rather than about a thing.
 *
 * The mirror of `embeddedQuestionBefore`, on the side of the verb where English
 * puts its object. "Tell me whether it is actually called" has no noun to point
 * at, and the object scan handed back `me whether it is actually called` — a
 * target made out of a subordinate clause, which is the shape of invention this
 * file exists to avoid. "Show me what changes if I change the prompt" did the
 * same thing at greater length.
 *
 * The question word is what marks it, and the requirement then reads as the
 * sentence did: the verb and the question, with the target left unnamed because
 * there is not one. Capped like the object is, so a long tail cannot ride in.
 */
function englishQuestionAfter(clause: string, after: number): string {
  const rest = clause.slice(after).trim();
  if (!/^(?:me\s+|us\s+)?(?:whether|if|which|what|how|why|when|where)\b/i.test(rest)) return "";
  // The clause split keeps the conjunction it broke on, exactly as the object
  // scan has to allow for.
  const asked = rest
    .replace(/[.!?]+\s*$/u, "")
    .replace(/(?:^|\s+)(?:and|then|but|or)\s*$/i, "")
    .trim();
  return asked.length > MAX_ENGLISH_OBJECT ? "" : asked;
}

function englishObject(clause: string, after: number): { target: string; shown: string } {
  let rest = clause.slice(after).trim();
  // Drop a leading particle, then a leading article — "clean up the imports"
  // has an object of "imports", not "up the imports".
  for (let i = 0; i < 2; i += 1) rest = rest.replace(ENGLISH_PARTICLE, "");
  // Held aside rather than dropped — see `ENGLISH_ARTICLE`.
  const article = ENGLISH_ARTICLE.exec(rest)?.[0] ?? "";
  rest = rest.slice(article.length);
  // Then the participle, which sits between the article and the noun.
  const lead = /^([A-Za-z]+)\s+(?=\S)/.exec(rest);
  if (lead !== null && isEnglishParticiple(lead[1] ?? "")) rest = rest.slice(lead[0].length);
  // The first stop that is really a stop.
  //
  // `and`, `then`, `but` and `or` end the object when the next act begins and
  // not otherwise: "support both image generation and video generation" is one
  // list, and cutting it at `and` reported half of what the user asked for.
  let stop: { index: number } | null = null;
  for (let from = 0; from < rest.length; ) {
    const found = ENGLISH_OBJECT_END.exec(rest.slice(from));
    if (found === null) break;
    const at = from + found.index;
    const tail = rest.slice(at + found[0].length);
    const joins = /^\s+(?:and|then|but|or)\b/i.test(found[0]);
    // A comma inside a list is not the end of the object either. Three things
    // have to hold, and each one is a sentence that goes wrong without it:
    //
    //   · the next member is an **article-led noun phrase** — "and make it
    //     blue" is not one, and reading it as one gave the target `button, and
    //     make it blue`;
    //   · that member carries **no copula or auxiliary** — "the tests are
    //     failing" is a clause wearing an article, and it became part of the
    //     bug being fixed;
    //   · a **coordinator is still ahead**, which is what a list has and a
    //     second thought does not.
    const member = /^\s*(?:and\s+|or\s+)?(?:the|a|an|its|their|our)\s+[^,.;:!?]*/i.exec(tail)?.[0] ?? "";
    const listComma =
      found[0] === "," &&
      member.trim().length > 0 &&
      !/\b(?:is|are|was|were|be|been|has|have|had|will|would|can|could|should|do|does|did)\b/i.test(member) &&
      /\b(?:and|or)\b/i.test(tail);
    if ((!joins && !listComma) || opensWithEnglishVerb(tail)) {
      stop = { index: at };
      break;
    }
    from = at + found[0].length;
  }
  // Nothing but an adjunct left, or nothing but a pronoun.
  //
  // "run it on the GPU" strips the `it` and leaves `on the GPU`, which the stop
  // list cannot catch because the preposition is now at the front with no space
  // in front of it. "test it" leaves a bare `it`, which names nothing this can
  // resolve — the honest answer is no target, the same one Korean gives for an
  // omitted object.
  if (ENGLISH_ADJUNCT_HEAD.test(rest) || ENGLISH_PRONOUN_ONLY.test(rest)) {
    return { target: "", shown: "" };
  }
  const object = (stop === null ? rest : rest.slice(0, stop.index))
    // The clause split keeps the conjunction it broke on, so a trailing `and`
    // rides along into the object: "fix the bug and" rather than "fix the bug".
    //
    // `(?:^|\s+)`, not `\s+`: when the verb has no object of its own the
    // conjunction is *all* that is left, and with nothing in front of it the
    // strip did not fire. "Train and evaluate the model" then reported a
    // requirement to train **and** — the word itself, offered as the thing to
    // train.
    .replace(/(?:^|\s+)(?:and|then|but|or)\s*$/i, "")
    .trim();
  if (object.length === 0 || object.length > MAX_ENGLISH_OBJECT) return { target: "", shown: "" };
  return { target: object, shown: `${article}${object}` };
}

/** Whether this text is worth running the English pass over at all. */
function looksEnglish(text: string): boolean {
  return /[A-Za-z]/.test(text) && !/[가-힣]/.test(text);
}

/**
 * English requests in one turn.
 *
 * Returns nothing for Korean, and nothing for a mixed sentence — a request
 * that switches language mid-clause is one this pass cannot bound an object
 * in, and guessing is worse than the honest empty answer the design already
 * knows how to report.
 */
function englishCandidates(input: { turnId: string; text: string }): FunctionalCandidate[] {
  if (!looksEnglish(input.text)) return [];

  const out: FunctionalCandidate[] = [];
  const seen = new Set<string>();
  let offset = 0;

  for (const clause of englishClauses(input.text)) {
    const at = input.text.indexOf(clause, offset);
    if (at === -1) continue;
    offset = at + clause.length;
    const body = clause.replace(ENGLISH_LEAD, "").replace(ENGLISH_FEATURE_FRAME, "");
    if (body.trim().length === 0) continue;
    if (ENGLISH_QUESTION.test(body)) continue;

    for (const { pattern, action } of ENGLISH_VERBS) {
      const match = pattern.exec(body);
      if (match === null) continue;
      // The sentence forbids this verb rather than asking for it. Emitting the
      // positive form would contradict `statedProhibitions`, which is reading
      // the very same words.
      if (ENGLISH_NEGATED.test(body.slice(0, match.index))) continue;
      // A verb in the middle of a sentence is doing some other job — a noun
      // ("the previous run"), a subordinate clause, a report about the past.
      if (!isImperativePosition(body, match.index)) continue;

      // A question standing where the object would be — see
      // `englishQuestionAfter`. Asked before the object scan, because that scan
      // is what turns the question into a target.
      const asked = englishQuestionAfter(body, match.index + match[0].length);
      const { target: object, shown } = asked === ""
        ? englishObject(body, match.index + match[0].length)
        : { target: "", shown: "" };
      if (object.length === 0 && asked === "" && !ACT_IS_ENOUGH.has(action)) continue;

      const verb = match[0].toLowerCase();
      // Collapsed, because `build\s+(?=an?\b)` matches its own trailing space
      // and the article strip takes the next one: "build  project".
      //
      // With no object the class phrase stands only while it still says the
      // word the user said — the same rule `actOnlyText` applies on the Korean
      // side, and for the same reason. "Compare it with the previous result"
      // was coming back as "look at what was asked about": comparing is not
      // looking, and the one verb the sentence chose was the word thrown away.
      const wide = ACT_ONLY_EN[action];
      const text =
        object.length > 0
          ? `${verb} ${shown}`.replace(/\s{2,}/g, " ")
          : asked !== ""
            ? `${verb} ${asked}`
            : wide.toLowerCase().includes(verb.trim())
              ? wide
              : verb.trim();
      // The question joins the key for the reason it does on the Korean side:
      // two questions in one turn are two asks, and their targets are equally
      // empty.
      const key = `${action}:${object.toLowerCase()}${asked === "" ? "" : `?${asked.toLowerCase()}`}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        text,
        action,
        object,
        span: { turnId: input.turnId, start: at, end: at + clause.replace(/\s+$/, "").length },
      });
      break; // One requirement per clause, as on the Korean side.
    }
  }
  return out;
}

/**
 * Where an English clause ends. Conjunctions and sentence punctuation.
 *
 * The dash and the semicolon are here for the shape Korean handles with `-말고`:
 * a prohibition and the request that replaces it, in one sentence. "do not
 * generate it yet — compare the models first" left the comparison unread,
 * because the negation suppressed the first verb and the second was then too
 * far into the sentence to be an imperative. Splitting there makes the request
 * a clause of its own, which is what it is.
 */
const ENGLISH_BOUNDARIES =
  /(?<=[.!?])(?=\s|$)|(?<=,\s)|\s*[—–;]\s*|\s+(?=and\s+then\s+)|(?<=\sand\s)|(?<=\sthen\s)/i;

/**
 * `-ㄹ 수 있게 해줘` and `-게 해줘`, rewritten as the plain imperative.
 *
 * This is how a person states a feature request in Korean — "프레임 수와
 * 해상도를 설정할 수 있게 해줘", "실패하면 다시 시도하게 해줘" — and the
 * extractor read none of it, because the verb it needs to see is buried under a
 * causative that ends in the bare `하다`. Adding `할` to every verb's endings
 * would have found it and broken more than it fixed: `사용할 수 있는 모델을
 * 확인해줘` would then match `사용할` first and report a request to use
 * something.
 *
 * So the construction is normalised instead of the verb table widened. The
 * rewrite only ever removes the causative tail, and the stem keeps its position,
 * so everything in front of the verb — which is where the target comes from — is
 * byte-identical to the sentence the user typed.
 *
 * `고를 수 있게 해줘` still reads as nothing: `고르다` is not one of the acts,
 * and inferring one from "let the user choose" would be the runtime deciding
 * what the feature is.
 */
function plainImperative(clause: string): string {
  return clause
    .replace(/([가-힣]{2,})할\s*수\s*있(?:게|도록)\s*(?:해|하)(?:줘|주세요|주라|주)?/gu, "$1해줘")
    .replace(/([가-힣]{2,})하(?:게|도록)\s*(?:해|하)(?:줘|주세요|주라|주)?/gu, "$1해줘");
}

/**
 * The acts this turn takes back.
 *
 * `functionalCandidates` already finds the verb and then refuses to make a
 * requirement out of it when `NEGATED` matches — which is right, and until now
 * that was the end of it. The information was thrown away, and a correction
 * could only retire a standing requirement through `statedProhibitions`, which
 * covers running and editing and nothing else. So "아니, 생성하라는 게 아니라
 * 먼저 비교해줘" added the comparison and left the generation standing beside
 * it: two requirements, one of which the user had just withdrawn, and no sign
 * in the panel that they disagreed.
 *
 * Reported rather than acted on here. What a withdrawal *does* is a question
 * about the conversation, and `mergeRequirements` is where the conversation
 * lives — this only says which acts the sentence pushed away.
 *
 * Only the negated ones. A turn that says "생성하지 말고 비교해줘" withdraws
 * generation; a turn that merely does not mention it withdraws nothing, which
 * is the difference between a correction and a change of subject.
 */
export function negatedActs(input: { turnId: string; text: string }): ActionKind[] {
  const out = new Set<ActionKind>();
  for (const source of input.text.split(BOUNDARIES)) {
    if (source.trim().length === 0) continue;
    const clause = plainImperative(source);
    for (const { pattern, action } of VERBS) {
      const match = pattern.exec(clause);
      if (match === null) continue;
      if (NEGATED.test(clause.slice(match.index, match.index + match[0].length + 8))) {
        out.add(action);
      }
      break; // The same one-verb-per-clause rule the reader uses.
    }
  }

  // The English side, and it is not an else-branch.
  //
  // `functionalCandidates` runs the English pass only when the Korean one found
  // nothing, because a sentence that produced Korean candidates is Korean. This
  // is the opposite situation: a withdrawal is a fact about the sentence, and a
  // request written in English inside a Korean conversation still withdraws what
  // it says it withdraws. Reading both costs nothing — a clause cannot carry a
  // negated verb in two languages at once.
  for (const clause of englishClauses(input.text)) {
    const body = clause.replace(ENGLISH_LEAD, "");
    if (body.trim().length === 0) continue;
    for (const { pattern, action } of ENGLISH_VERBS) {
      const match = pattern.exec(body);
      if (match === null) continue;
      if (ENGLISH_NEGATED.test(body.slice(0, match.index))) out.add(action);
      break;
    }
  }

  return [...out];
}

/**
 * English clauses, with a noun list left whole.
 *
 * `ENGLISH_BOUNDARIES` breaks on ` and `, which is right when it joins two
 * acts and wrong when it joins two nouns. Splitting first and re-joining is
 * how the distinction gets made, because a lookahead cannot ask whether what
 * follows is one of the verbs.
 */
function englishClauses(text: string): string[] {
  const out: string[] = [];
  for (const piece of text.split(ENGLISH_BOUNDARIES)) {
    const previous = out[out.length - 1];
    if (previous !== undefined && /\b(?:and|then|but|or)\s*$/i.test(previous) && !opensWithEnglishVerb(piece)) {
      out[out.length - 1] = previous + piece;
      continue;
    }
    // A list member the comma cut off from the verb it belongs to.
    //
    // "Download the dataset, the weights, and the config" is one act naming
    // three things, and the boundary left two of them in pieces with no verb —
    // so the requirement said `download the dataset` and the other two were
    // gone. This is the same fold `koreanClauses` does, in the direction English
    // needs it: Korean puts the verb after the list, English before it.
    //
    // A noun phrase, or the coordinator that introduces the last member — not
    // merely something with no verb in front. "add a button, and make it blue"
    // also splits into verbless pieces, and it folds back the same way; what
    // keeps it from becoming the target `button, and make it blue` is the
    // article test in `englishObject`, which `and make` fails and every list
    // member passes. `make` is not in the verb list and cannot be, since
    // "make a video" and "make it blue" are two different acts.
    if (
      previous !== undefined &&
      /,\s*$/u.test(previous) &&
      !opensWithEnglishVerb(piece) &&
      /^\s*(?:(?:and|or)\s*$|(?:and\s+|or\s+)?(?:the|a|an|its|their|our)\s+\S)/i.test(piece)
    ) {
      out[out.length - 1] = previous + piece;
      continue;
    }
    out.push(piece);
  }
  return out;
}

/**
 * The clauses of a Korean turn, with the pieces that cannot stand alone folded
 * into the clause they belong to.
 *
 * `BOUNDARIES` cuts on `, ` because a comma usually ends a clause. It does not
 * always: "웹과 Hugging Face, HASA도 참고하고" is one list and one verb, and the
 * cut left `웹과 Hugging Face` sitting in a piece with no verb in it. A piece
 * with no verb produces nothing, so 웹 and the service beside it were dropped
 * from a request that named them — not read wrongly, just gone.
 *
 * Such a piece belongs to the verb that follows it, because that is where
 * Korean puts the verb. Two conditions, and each one is a sentence that broke
 * without it:
 *
 *   · **Only a piece the comma cut.** A piece the `-고` boundary cut ends in a
 *     verb — "CNN과 Transformer를 쓰고" has one, and this file refuses to read
 *     `쓰다` on purpose. Folding that forward let the refusal be worked around
 *     from the outside: the sentence came out as "CNN과 Transformer를 학습한다",
 *     a target chosen by a rule that had no opinion about it. A piece with no
 *     verb and a piece with a verb nobody will read are not the same thing.
 *   · **Not across a sentence end.** What follows a full stop is a new thought.
 *
 * The pieces are concatenated back exactly as they were — every boundary here is
 * a lookaround and consumes nothing — so a span still points into the text the
 * user typed.
 */
function koreanClauses(text: string): string[] {
  const out: string[] = [];
  let pending = "";
  for (const piece of text.split(BOUNDARIES)) {
    const joined = pending + piece;
    const speaks = VERBS.some((entry) => entry.pattern.test(plainImperative(joined)));
    if (!speaks && /,\s*$/u.test(joined)) {
      pending = joined;
      continue;
    }
    out.push(joined);
    pending = "";
  }
  if (pending !== "") out.push(pending);
  return out;
}

export function functionalCandidates(input: { turnId: string; text: string }): FunctionalCandidate[] {
  const out: FunctionalCandidate[] = [];
  const seen = new Set<string>();

  let offset = 0;
  for (const source of koreanClauses(input.text)) {
    const at = input.text.indexOf(source, offset);
    if (at === -1) continue;
    offset = at + source.length;
    if (source.trim().length === 0) continue;

    // The causative rewritten away, for reading only. `source` is what the span
    // points at and what `input.text` still contains.
    const clause = plainImperative(source);

    // A conditional verb loses to any other verb in the same clause.
    //
    // "프롬프트를 바꾸면 결과가 어떻게 달라지는지 비교해줘" came out as
    // "프롬프트를 수정한다": `-면` marks a hypothesis, the table happens to try
    // `바꾸` before `비교`, and the first match wins the clause. So the design
    // recorded a change the user had not asked for and lost the comparison they
    // had. Two passes rather than a rule inside the loop, because the question
    // is not "is this verb conditional" but "is there anything else here".
    //
    // `-면서` is excluded: it means "while", not "if", and the clause splitter
    // already breaks on it. Requiring the syllable to end the match keeps
    // "유지하면서" out.
    const conditional = (match: RegExpExecArray): boolean => {
      const after = clause.slice(match.index + match[0].length);
      return /^면(?!서)/u.test(after) || (match[0].endsWith("면") && !after.startsWith("서"));
    };
    const ordered = [
      ...VERBS.map((entry) => ({ entry, match: entry.pattern.exec(clause) })).filter(
        (found): found is { entry: VerbEntry; match: RegExpExecArray } => found.match !== null,
      ),
    ];
    const preferred = ordered.filter((found) => !conditional(found.match));
    for (const { entry: { action, phrase }, match } of preferred.length > 0 ? preferred : ordered) {

      // The user forbade this verb rather than asking for it. Emitting the
      // positive form here would contradict `statedProhibitions`, which is
      // reading the very same words.
      //
      // What is dropped along with it, and is not represented anywhere:
      //
      //     워터마크는 넣지 말고 영상을 만들어줘  →  영상을 만든다
      //
      // The refusal is read correctly — no requirement to add a watermark is
      // produced — and then it is gone. `statedProhibitions` models three
      // classes, all of them tool gates (running, editing, going to the web),
      // and "do not add a watermark" is none of those: it is a constraint on
      // the deliverable. For the three generative-media topics this designer is
      // aimed at, that is the commonest constraint there is.
      //
      // Not fixed here, and the reason is the sentence above this one. A second
      // module emitting prohibitions would have to agree with the gate about
      // every sentence they both read, and the two disagreeing is the failure
      // `NEGATED` exists to prevent. The bound on the damage is that the
      // handoff carries the user's text verbatim, so the agent still reads the
      // words — what is lost is the panel's account of what it understood.
      // `functionalExtract.test.ts` has the case under its own name.
      if (NEGATED.test(clause.slice(match.index, match.index + match[0].length + 8))) continue;

      // Which noun-verb this was, when it was one. `phrase` says how the act
      // reads; this says which word of the user's it was built from, and both
      // the light-verb branch and the act-only rendering below need the word.
      const own = STEMS.find((stem) => match[0].startsWith(stem)) ?? "";

      // "학습과 추론을 하고" — see `coordinatedBefore`. What is conjoined in
      // front of a noun-verb is not its target: this clause spent its noun
      // phrase on the verbs. The words it could name become acts of their own,
      // the words it could not are left unread, and either way the object scan
      // below never sees them.
      const run = own === "" ? NO_RUN : coordinatedBefore(clause, match.index);
      if (run.words.length > 0) {
        // `own` came out of `STEMS`, so the map has it. The target of each act
        // is the noun the user wrote for it, which is what a light verb makes
        // of a noun-verb — and it is also what keeps two conjoined acts from
        // collapsing into one entry in `seen`.
        const ownAct = STEM_ENTRY.get(own);
        for (const act of ownAct === undefined ? run.acts : [...run.acts, { stem: own, ...ownAct }]) {
          const key = `${act.action}:${act.stem}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            text: act.phrase,
            action: act.action,
            object: act.stem,
            span: { turnId: input.turnId, start: at, end: at + source.replace(/\s+$/, "").length },
          });
        }
        break;
      }

      const { target: object, shown } = objectBefore(clause, match.index);
      // No object and no act that stands alone: the user asked for something
      // this cannot name, and naming it anyway is inventing.
      if (object.length === 0 && !ACT_IS_ENOUGH.has(action)) continue;

      // Kept out of the target and put back into the sentence — see
      // `mannerBefore`. Only where there is a target to keep it out of.
      const manner = object.length === 0 ? "" : mannerBefore(clause, match.index);
      // What the clause is about when it is about a question rather than a
      // thing — see `embeddedQuestionBefore`. It changes what the requirement
      // reads as and nothing else; the target stays unnamed, because it is.
      const asked = object.length === 0 ? embeddedQuestionBefore(clause, match.index) : "";
      const text =
        object.length > 0
          ? `${shown}${objectParticle(shown)} ${manner === "" ? "" : `${manner} `}${phrase ?? ACTION_TEXT[action]}`
          : asked !== ""
            ? `${asked} ${phrase ?? ACTION_TEXT[action]}`
            : actOnlyText(action, own);
      // Keyed on the act and its target, not the rendered sentence, so a
      // rewording never silently merges two different asks. An embedded
      // question has no target, so it joins the key — two of them in one turn
      // are two different asks and the empty target would have merged them.
      const key = `${action}:${object}${asked === "" ? "" : `?${asked}`}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        text,
        action,
        object,
        // `source`, not `clause`: the span points into the text the user typed,
        // and the causative rewrite above exists only for reading.
        span: { turnId: input.turnId, start: at, end: at + source.replace(/\s+$/, "").length },
      });
      break; // One requirement per clause. Two verbs in one clause is one act.
    }
  }

  // The English pass runs when the Korean one found nothing. Not in parallel:
  // a sentence that produced Korean candidates is Korean, and running both
  // would let an English word inside a Korean request add a second reading of
  // the same clause.
  if (out.length === 0) return englishCandidates(input);
  return out;
}
