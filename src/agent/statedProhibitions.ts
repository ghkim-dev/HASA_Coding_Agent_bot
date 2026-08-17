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

export type ProhibitedClass = "execute" | "modify";

/**
 * A negation that attaches to the verb it follows.
 *
 * `마` / `말` / `않고` only. See the note above on `못` and `않았`.
 */
const NEG = "(?:마|말|않고)";

/**
 * `하지` and its contraction `하진`.
 *
 * "수정하진 마" is the same prohibition as "수정하지 마", and only the second one
 * was recognised. The asymmetry was measurable and one-sided: `functionalExtract`
 * already treats both forms as a negation, so the contracted sentence produced no
 * prohibition *and* no positive requirement — the runtime read "수정하진 마" as
 * having asked for nothing at all, and the action gate had nothing to refuse.
 */
const STEM = "하[지진]";

/**
 * "실행하면 안 돼" — the negation after the verb ending rather than after `하지`.
 *
 * The interrogative is excluded. "실행하면 안 돼?" is a user asking whether they
 * may run it, not forbidding it, and a false positive is the only way this module
 * can hurt — so the lookahead refuses the pattern when a question mark closes the
 * same clause.
 */
const MYEON_AN = "(?:면|서는)\\s*안\\s*(?:돼|되|된|됩)(?![^.!。\\n]*[?？])";

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
  const what = klass === "execute" ? "실행" : "파일 수정";
  return (
    `이번 차례에 ${what}을(를) 하지 말라고 하셨습니다. ${toolName} 은(는) 그 요청과 어긋납니다.\n` +
    "요청하신 범위 안에서 답하고, 그 이상이 필요하면 무엇이 왜 필요한지 먼저 말씀해 주십시오."
  );
}
