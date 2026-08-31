/**
 * What the user's own words forbid, read without asking the model.
 *
 * The action gate is sound and has never once let through a call it was told to
 * block. Six repeated runs of the same fixture produced three forbidden
 * executions and the cause of every one was the same:
 *
 *     gate_allowed_despite_constraint   0
 *     constraint_never_recorded         2
 *     relation_misclassified            1
 *
 * `decideAction` reads `contract.constraints`, and a contract is the model's
 * transcription of what the user said. Twice the model filed the turn correctly
 * as a `correct` and still recorded no constraint at all; once it filed a
 * correction as a refinement. In all three the gate looked at an empty list and
 * had nothing to refuse.
 *
 *     the boundary was enforced correctly
 *     against facts the model was responsible for supplying
 *
 * A safety boundary whose inputs come from the thing it is guarding against is
 * not a boundary. This is the second opinion: the user's sentence, read by the
 * runtime, for the two classes that can change a machine.
 *
 * ## It may only ever deny
 *
 * Deliberately asymmetric. A miss leaves the existing behaviour exactly as it
 * was — the contract still governs — so the cost of an imperfect pattern is
 * bounded on one side. A false positive is the only way this can hurt, so the
 * patterns require the negation to attach to the verb rather than appear
 * anywhere in the sentence, the same discipline `NEGATED_COMPLETION` uses.
 *
 * ## What it deliberately does not match
 *
 * `못` is excluded. "실행하지 못했습니다" reports a failure to run; it does not
 * forbid running, and treating a user's account of what went wrong as an
 * instruction would refuse the work they are asking for. Likewise `않았` is a
 * past tense and only `않고` is the prohibitive connective.
 */

export type ProhibitedClass = "execute" | "modify" | "research";

/**
 * A negation that attaches to the verb it follows.
 *
 * `마` / `말` / `않고` only. See the note above on `못` and `않았`.
 */
const NEG = "(?:마|말|않고)";

/**
 * `하지`, its contraction `하진`, and the particle a speaker puts after either.
 *
 * "수정하진 마" is the same prohibition as "수정하지 마", and only the second one
 * was recognised. The asymmetry was measurable and one-sided: `functionalExtract`
 * already treats both forms as a negation, so the contracted sentence produced no
 * prohibition *and* no positive requirement — the runtime read "수정하진 마" as
 * having asked for nothing at all, and the action gate had nothing to refuse.
 *
 * `(?:[는도를은])?` closes the same asymmetry for a whole family that was still
 * open. Korean marks contrast and addition on the negated verb — 수정하지**는**
 * 마세요, 실행하지**도** 마, 수정하지**를** 마 — and every one of those was read
 * by `functionalExtract`'s `NEGATED`, which allows the particle, and by nothing
 * here, which did not. Sixteen forms across the two classes produced no
 * prohibition at all: the request was correctly suppressed and the ban was
 * invisible to the tool gate, so the model was free to do the thing the user had
 * just refused in the politest available way. Found by generating prohibitions
 * and asking whether the runtime read them back, which is what
 * `statedProhibitions.fuzz.test.ts` now does on every run.
 *
 * The particle cannot make this fire on a sentence that is not a prohibition:
 * whatever sits between `하지` and `마`/`말`/`않고`, the negation is still there.
 */
const STEM = "하[지진](?:[는도를은])?";

/**
 * "실행하면 안 돼" — the negation after the verb ending rather than after `하지`.
 *
 * The interrogative is excluded. "실행하면 안 돼?" is a user asking whether they
 * may run it, not forbidding it, and a false positive is the only way this module
 * can hurt — so the lookahead refuses the pattern when a question mark closes the
 * same clause.
 */
const MYEON_AN = "(?:면|서는)\\s*안\\s*(?:돼|되|된|됩)(?![^.!。\\n]*[?？])";

/**
 * "…하지 말아야 하나요?" — asking whether to forbid, rather than forbidding.
 *
 * Anchored to the negated verb, not to the clause. The first version rejected
 * the match whenever a `?` appeared anywhere before the next sentence end, and
 * Korean requests are routinely questions: "웹검색하지 말고 로컬 코드만 봐줄래?"
 * is a prohibition wearing a polite tail, and the `?` belongs to 봐줄래 rather
 * than to 하지 마. That guard silently disarmed the whole class for every
 * politely-phrased ban — while "실행하지 말고 … 줄래?", which carries no such
 * guard, still resolved. The asymmetry was the tell.
 *
 * So the `?` only suppresses when it closes *this* verb phrase: nothing but a
 * short interrogative tail may sit between the negation and the mark. A
 * connective (`고`, `며`) means another clause follows, and this one was an
 * instruction.
 */
const ASKING_WHETHER = "(?!\\s*(?:아야|아도|까)?\\s*(?:하나요|할까요|되나요|될까요|한가요|하죠|해요)?\\s*[?？])";

/**
 * Going out to the web, as the user names it.
 *
 * Qualified on purpose. A bare `검색` is what someone says about searching the
 * repository, and this class denies `web_search`/`web_fetch` — refusing those
 * because the user said "파일 검색하지 마" would be the false positive this
 * module is written to avoid. `웹` and `인터넷` are the qualifiers that make it
 * about leaving the machine.
 */
const WEB = "(?:웹\\s*검색|웹서치|웹\\s*서치|인터넷\\s*검색|인터넷\\s*조사|온라인\\s*검색|웹\\s*조사|웹|인터넷|온라인)";

const RESEARCH_DIRECT = new RegExp(
  [
    // "웹검색하지 마", "웹 검색하지 말아 주세요", "웹검색은 하지 말고".
    `${WEB}(?:도|은|는|을|를|만)?\\s*(?:${STEM}|사용${STEM}|검색${STEM}|조사${STEM})\\s*${NEG}${ASKING_WHETHER}`,
    // "웹에서 찾지 말아줘" — the verb carries the negation, the web is a place.
    `${WEB}에서\\s*[가-힣]{0,6}[지진]\\s*${NEG}${ASKING_WHETHER}`,
    // The bare noun forms, with no verb between the noun and the negation:
    // "웹검색 말고 저장소에서 찾아줘", "웹검색 대신 로컬 코드를 봐줘". `clausesOf`
    // already names `-말고` as how Korean joins "not X" to "do Y"; requiring a
    // verb stem here meant the runtime did not recognise the half it had named.
    // Missing these was not merely a missed refusal — the demand side then
    // matched the web noun *inside* the prohibition and read the ban as a
    // request for the thing it banned.
    `${WEB}(?:\\s*검색|\\s*조사)?(?:도|은|는|을|를|만)?\\s*(?:말고|말구|대신(?:에)?)`,
    // "웹검색하면 안 돼", "웹을 써서는 안 된다".
    `${WEB}[하해]?${MYEON_AN}`,
    `${WEB}(?:도|은|는|을|를|만)?\\s*(?:써|쓰|사용[하해])${MYEON_AN}`,
    // "웹 검색 없이 저장소 파일만" — the absence stated as the instruction.
    `${WEB}\\s*(?:검색|조사)?\\s*없이`,
    // "인터넷 검색은 빼줘".
    `${WEB}(?:\\s*검색|\\s*조사)?(?:도|은|는|을|를|만)?\\s*(?:빼|제외)${ASKING_WHETHER}`,
    // "웹검색하라는 게 아니라" — a correction, the shape that started all this.
    `${WEB}[가-힣]{0,4}하?(?:라는|란)\\s*(?:게|것이|말이|건)?\\s*아니`,
    "do\\s+not\\s+(?:use\\s+)?(?:web|internet|online|browse|search\\s+the\\s+web|research)",
    "don'?t\\s+(?:use\\s+)?(?:web|internet|online|browse|search\\s+the\\s+web|research)",
    "never\\s+(?:research|browse|search)\\b",
    "without\\s+(?:web|internet|online|browsing|searching\\s+the\\s+web)",
    "avoid\\s+web[_\\s]?(?:search|fetch)",
    "no\\s+web\\s+(?:search|access)",
  ].join("|"),
  "i",
);

const EXECUTE_DIRECT = new RegExp(
  [
    // A particle may sit between the stem and 하지: "실행도 하지 마",
    // "실행은 하지 말고". A missed prohibition is the dangerous direction —
    // this module exists because one was missed — and requiring the two to be
    // joined missed every sentence that puts a particle between them.
    `실행(?:도|은|는|을|를|만)?\\s*${STEM}\\s*${NEG}`,
    `돌리[지진]\\s*${NEG}`,
    `구동(?:도|은|는|을|를|만)?\\s*${STEM}\\s*${NEG}`,
    // Both endings, because the negation attaches after either: "실행하면 안 돼"
    // and "실행해서는 안 된다" are one prohibition in two conjugations.
    `실행[하해]${MYEON_AN}`,
    `돌[리려]${MYEON_AN}`,
    `구동[하해]${MYEON_AN}`,
    // "실행하라는 게 아니라" — a correction rather than a prohibition, and the
    // sentence that produced this whole investigation.
    "실행하(?:라는|란)\\s*(?:게|것이|말이|건)?\\s*아니",
    "don't\\s+(?:run|execute)",
    "do\\s+not\\s+(?:run|execute)",
    "without\\s+(?:running|executing)",
  ].join("|"),
  "i",
);

const MODIFY_DIRECT = new RegExp(
  [
    `수정(?:도|은|는|을|를|만)?\\s*${STEM}\\s*${NEG}`,
    `고치[지진]\\s*${NEG}`,
    `바꾸[지진]\\s*${NEG}`,
    `변경(?:도|은|는|을|를|만)?\\s*${STEM}\\s*${NEG}`,
    `건드리[지진]\\s*${NEG}`,
    `수정[하해]${MYEON_AN}`,
    `고[치쳐]${MYEON_AN}`,
    `바[꾸꿔]${MYEON_AN}`,
    `변경[하해]${MYEON_AN}`,
    `건드[리려]${MYEON_AN}`,
    "수정하(?:라는|란)\\s*(?:게|것이|말이|건)?\\s*아니",
    "don't\\s+(?:modify|edit|change)",
    "do\\s+not\\s+(?:modify|edit|change)",
    "without\\s+(?:modifying|editing|changing)",
  ].join("|"),
  "i",
);

/**
 * The `-거나` chain: "수정하거나 실행하지 말고".
 *
 * One negation covering two verbs. Read only on the left of the negated verb
 * and only within a clause, because "실행하거나" three sentences earlier is a
 * different thought.
 */
const CHAIN = new RegExp(`([가-힣\\s]{0,24})거나\\s*[가-힣]{0,6}하지\\s*${NEG}`, "g");

const CHAIN_VERB: ReadonlyArray<{ pattern: RegExp; klass: ProhibitedClass }> = [
  { pattern: /실행|돌리|구동/, klass: "execute" },
  { pattern: /수정|고치|바꾸|변경|건드리/, klass: "modify" },
  { pattern: /웹|인터넷|온라인|검색|조사/, klass: "research" },
];

/** Which verb the negation itself is attached to, in a chain. */
const CHAIN_TAIL = new RegExp(`거나\\s*([가-힣]{0,6})하지\\s*${NEG}`);

/**
 * The classes this text forbids.
 *
 * Empty when it forbids nothing, which is the overwhelmingly common case and
 * the one that must stay cheap and silent.
 */
export function prohibitionsIn(text: string): Set<ProhibitedClass> {
  const out = new Set<ProhibitedClass>();
  if (text.length === 0) return out;

  if (EXECUTE_DIRECT.test(text)) out.add("execute");
  if (MODIFY_DIRECT.test(text)) out.add("modify");
  if (RESEARCH_DIRECT.test(text)) out.add("research");

  // A chain adds the verbs on the left of the negation, and the negated verb
  // itself — "수정하거나 실행하지 말고" forbids both, and the direct patterns
  // above only caught the second.
  for (const match of text.matchAll(CHAIN)) {
    const before = match[1] ?? "";
    for (const { pattern, klass } of CHAIN_VERB) {
      if (pattern.test(before)) out.add(klass);
    }
    const tail = CHAIN_TAIL.exec(match[0])?.[1] ?? "";
    for (const { pattern, klass } of CHAIN_VERB) {
      if (pattern.test(tail)) out.add(klass);
    }
  }

  return out;
}

/** Tools each class covers. The same split the evaluator's fixtures use. */
const TOOLS: Readonly<Record<ProhibitedClass, readonly string[]>> = {
  execute: ["run_command"],
  modify: ["write_file", "create_file", "apply_patch", "delete_file"],
  // The web tools and nothing else. Searching the repository is not going out
  // to the internet, so `search_files` stays available to a user who said
  // "웹검색하지 말고 저장소 안에서 찾아줘" — which is the whole point of that
  // sentence.
  research: ["web_search", "web_fetch"],
};

/**
 * Whether the user's own words forbid this tool.
 *
 * The question the gate asks last, after the contract has had its say. Returns
 * the class that forbids it so a refusal can name which words it is honouring.
 */
export function classForbidding(
  prohibitions: ReadonlySet<ProhibitedClass>,
  toolName: string,
): ProhibitedClass | null {
  for (const klass of prohibitions) {
    if (TOOLS[klass].includes(toolName)) return klass;
  }
  return null;
}

export function describeProhibition(klass: ProhibitedClass, toolName: string): string {
  const what = klass === "execute" ? "실행" : klass === "modify" ? "파일 수정" : "웹 검색";
  return (
    `이번 차례에 ${what}을(를) 하지 말라고 하셨습니다. ${toolName} 은(는) 그 요청과 어긋납니다.\n` +
    "요청하신 범위 안에서 답하고, 그 이상이 필요하면 무엇이 왜 필요한지 먼저 말씀해 주십시오."
  );
}
