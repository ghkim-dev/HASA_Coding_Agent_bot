import { prohibitionsIn, type ProhibitedClass } from "../agent/statedProhibitions.ts";
import { exactSourcesIn } from "../agent/sourceProvenance.ts";
import type { TurnRelation } from "../agent/turnContract.ts";
import { checkSpan, sentenceAround, type SourceSpan, type SpanProblem } from "./sourceSpan.ts";
import { checkAlignment, conditionIn, priorityFrom, scopeIn, type Alignment } from "./semanticAlignment.ts";
import { functionalCandidates, type ActionKind } from "./functionalExtract.ts";

/**
 * What the user asked for, in a form a verification plan can be built from.
 *
 * The existing `Requirement` in `turnContract.ts` is what the *model* recorded.
 * This is what the runtime is prepared to act on, and the difference is the
 * whole point: a plan built from the first inherits every omission the model
 * made, and this codebase has measured those — six runs of the correction
 * fixture, three with the turn filed correctly as `correct` and no constraint
 * recorded at all.
 *
 * ## Who may say a requirement is confirmed
 *
 * Not the model. `confirmed` is the flag that lets a plan act without asking,
 * and a model that can set it on its own proposals can promote its own
 * paraphrase to a fact. So the authority is fixed by *origin*, not by anything
 * in the message:
 *
 *     runtime_prohibition   confirmed — the runtime read it from the words
 *     runtime_source        confirmed — same
 *     model_proposal        ambiguous — always, whatever it sends
 *     carried               keeps what it already had
 *     system_baseline       confirmed, and never `explicit`
 *     user approval         confirmed — a later turn where the user said yes
 *
 * A model's `confidence` is advisory and recorded as such. It is the difference
 * between "the model thinks this is certain" and "this is certain", and those
 * were the same field once.
 */

export type RequirementKind =
  | "functional"
  | "safety"
  | "compatibility"
  | "quality"
  | "validation"
  | "ux"
  | "security"
  | "constraint";

export type RequirementPriority = "must" | "should" | "may";
export type RequirementPolarity = "required" | "forbidden";
export type RequirementStatus = "explicit" | "inherited" | "system_added";
export type RequirementConfidence = "confirmed" | "ambiguous";

/**
 * Four questions the single `confidence` was answering at once.
 *
 * Collapsing them cost the product its main claim. Every requirement read from
 * a verb phrase came out `ambiguous`, which raised `AMBIGUOUS_DECIDED`, which
 * became "…로 이해했습니다. 맞습니까?" — so "로그인 오류를 수정해줘" was answered
 * by asking the user whether they had meant to ask for a fix. They had. What
 * the runtime did not know was *which* login error, and that is a different
 * question with a different answer.
 *
 *     provenance   근거가 사용자의 말 안에 실제로 있는가
 *     intent       사용자가 그 행동을 요청했는가
 *     binding      그 행동의 대상이 무엇인지 정해졌는가
 *
 * Kept apart because they are established by different evidence and settled by
 * different means: provenance by a span check, intent by who originated the
 * requirement, binding by whether the sentence named a target.
 */
export type Provenance = "verified" | "invalid";
export type Intent = "confirmed" | "ambiguous";
export type Binding = "resolved" | "unresolved";
export type ExecutionReadiness = "ready" | "blocked";

export type DerivedBy =
  | "runtime_prohibition"
  | "runtime_source"
  | "model_proposal"
  | "system_baseline"
  /** A verb the user wrote, with the words in front of it. See `functionalExtract`. */
  | "runtime_action"
  | "carried";

export interface RequirementSpec {
  id: string;
  text: string;
  /** Cut by the runtime from the user's message. Never a model's string. */
  sourceText: string;
  /** The coordinates it was cut from. Absent only for `system_added`. */
  span?: SourceSpan;
  sourceTurnId: string;
  kind: RequirementKind;
  priority: RequirementPriority;
  polarity: RequirementPolarity;
  status: RequirementStatus;
  /** Whether the runtime can point at the words this came from. */
  provenance: Provenance;
  /** Whether the user asked for this act. Not whether the target is known. */
  intent: Intent;
  /**
   * The act the runtime read out of the verb, when a verb is where this came
   * from.
   *
   * Carried as a field because the designer has to branch on it and the
   * alternative is reading it back out of prose. It was already being recorded —
   * inside the id, as `t1-act-inspect-2` — which is the same fact kept somewhere
   * a rule cannot honestly use: an id is an identifier, and a design rule keyed
   * on a substring of one is keyed on a naming convention.
   *
   * Absent for prohibitions, sources, baselines and model proposals. A model
   * cannot set it: `acceptProposals` builds every field of an accepted spec
   * itself and never copies this one.
   */
  act?: ActionKind;
  /**
   * The words the sentence bound to that verb, when it bound any.
   *
   * The user's own noun phrase, particles removed — `로그인 오류`, not the
   * runtime's rendered sentence `로그인 오류를 수정한다`. Absent exactly when
   * `binding` is `unresolved`, and carried for the same reason as `act`: the
   * alternative is recovering it by unparsing `text`, which is prose surgery on a
   * string this layer wrote itself.
   */
  target?: string;
  /** Whether the act has a target. `unresolved` is open, never invented. */
  binding: Binding;
  /** What the model claimed, kept as information and never as authority. */
  modelClaimedConfidence?: RequirementConfidence;
  /** Set when the span scopes the requirement to a condition nobody settled. */
  condition?: string;
  /** Paths the requirement confines work to, when the user named any. */
  scope?: string[];
  /** What the alignment check made of it. `unknown` is a reason to stay ambiguous. */
  alignment?: Alignment;
  dependencies: string[];
  conflicts: string[];
  supersededBy?: string;
  derivedBy: DerivedBy;
}

// ---------------------------------------------------------------------------
// Confirmation authority
// ---------------------------------------------------------------------------

/**
 * The only place an `intent` is decided.
 *
 * Written as one function so there is one thing to point at, and so the
 * mutation that removes it removes a boundary rather than a habit.
 *
 * `runtime_action` is `confirmed` here, and that is the correction. The user
 * wrote the verb; the runtime is not guessing that they asked for it. What the
 * runtime *is* guessing at — which files, which error, how far — is `binding`,
 * and conflating the two produced a preview that asked permission to do what it
 * had just been told to do.
 *
 * A condition does not appear here either. "기존 클라이언트가 사용 중이라면
 * 변경하지 마" states its intent perfectly clearly; what is unsettled is whether
 * the condition holds, which blocks execution without muddying what was asked.
 */
export function intentFor(input: {
  derivedBy: DerivedBy;
  /** For `carried`: what it was before. */
  previous?: Intent;
  /** Whether the user approved it in a later turn, in their own words. */
  userApproved?: boolean;
}): Intent {
  if (input.userApproved === true) return "confirmed";
  switch (input.derivedBy) {
    case "runtime_prohibition":
    case "runtime_source":
    case "runtime_action":
    case "system_baseline":
      return "confirmed";
    case "carried":
      return input.previous ?? "ambiguous";
    case "model_proposal":
      // Always. A model cannot confirm its own reading of the user, and there
      // is no field it can send that changes this.
      return "ambiguous";
  }
}

/**
 * Whether a run could start on this requirement alone.
 *
 * Derived rather than stored, because three of its four inputs are settled
 * after the spec is built — `conflicts` is filled in by `markConflicts`, and a
 * stored copy would go stale exactly when it matters. Everything that blocks is
 * named, so a caller can say which one it was.
 */
export function executionReadiness(spec: RequirementSpec): ExecutionReadiness {
  if (spec.provenance === "invalid") return "blocked";
  if (spec.intent === "ambiguous") return "blocked";
  if (spec.binding === "unresolved") return "blocked";
  if (spec.condition !== undefined) return "blocked";
  if (spec.conflicts.length > 0) return "blocked";
  return "ready";
}

// ---------------------------------------------------------------------------
// What the runtime establishes on its own
// ---------------------------------------------------------------------------

const PROHIBITION_SENTENCE: Readonly<Record<ProhibitedClass, RegExp>> = {
  execute: /실행|돌리|구동|run|execute/i,
  modify: /수정|고치|바꾸|변경|건드리|손대|modify|edit|change/i,
};

const PROHIBITION_TEXT: Readonly<Record<ProhibitedClass, string>> = {
  execute: "이번 요청에서 명령을 실행하지 않는다",
  modify: "이번 요청에서 파일을 수정하지 않는다",
};

/** The span of the first sentence matching a pattern, as coordinates. */
function sentenceSpan(full: string, pattern: RegExp, turnId: string): SourceSpan | null {
  let offset = 0;
  for (const piece of full.split(/(?<=[.!?。])\s+|\n+/)) {
    const at = full.indexOf(piece, offset);
    if (at === -1) continue;
    if (piece.trim().length > 0 && pattern.test(piece)) {
      return { turnId, start: at, end: at + piece.length };
    }
    offset = at + piece.length;
  }
  return null;
}

/**
 * Requirements the runtime reads out of the user's own words.
 *
 * No model involved, so these cannot be omitted by one. They are the floor
 * under whatever a model proposes.
 */
export function runtimeRequirements(input: { turnId: string; text: string }): RequirementSpec[] {
  const out: RequirementSpec[] = [];

  for (const klass of prohibitionsIn(input.text)) {
    const span =
      sentenceSpan(input.text, PROHIBITION_SENTENCE[klass], input.turnId) ??
      ({ turnId: input.turnId, start: 0, end: input.text.length } as SourceSpan);
    const sourceText = input.text.slice(span.start, span.end).trim();
    const condition = conditionIn(sourceText);
    out.push({
      id: `${input.turnId}-forbid-${klass}`,
      text: PROHIBITION_TEXT[klass],
      sourceText,
      span,
      sourceTurnId: input.turnId,
      kind: "constraint",
      priority: "must",
      polarity: "forbidden",
      status: "explicit",
      provenance: "verified",
      intent: intentFor({ derivedBy: "runtime_prohibition" }),
      // A prohibition's target is the act class itself, which the runtime named.
      binding: "resolved",
      ...(condition === null ? {} : { condition }),
      dependencies: [],
      conflicts: [],
      derivedBy: "runtime_prohibition",
    });
  }

  // Plain functional requests, which have no prohibition and no URL to read.
  //
  // `ambiguous` rather than `confirmed`, and the distinction is the point. A
  // prohibition is something the runtime can be *right* about — the user wrote
  // "하지 마". What a verb phrase means for a codebase is a reading, and this
  // one is coarse: it belongs in the plan, visible, and needing the user or a
  // model to settle it before it decides anything.
  const claimed = new Set(out.map((spec) => spec.text));
  for (const candidate of functionalCandidates(input)) {
    if (claimed.has(candidate.text)) continue;
    const sourceText = input.text.slice(candidate.span.start, candidate.span.end).trim();
    const condition = conditionIn(sourceText);
    out.push({
      id: `${input.turnId}-act-${candidate.action}-${out.length + 1}`,
      text: candidate.text,
      sourceText,
      span: candidate.span,
      sourceTurnId: input.turnId,
      // `preserve` is not a functional change — it asks that one not happen.
      // Filing it as `functional` would let the designer attach a scenario that
      // proves the opposite of the requirement.
      kind:
        candidate.action === "verify"
          ? "validation"
          : candidate.action === "preserve"
            ? "compatibility"
            : "functional",
      priority: priorityFrom(sourceText, "must"),
      polarity: "required",
      status: "explicit",
      provenance: "verified",
      intent: intentFor({ derivedBy: "runtime_action" }),
      act: candidate.action,
      ...(candidate.object.length === 0 ? {} : { target: candidate.object }),
      // The one place the target can genuinely be open: Korean leaves the
      // object implicit, and the extractor reports that rather than filling it.
      binding: candidate.object.length > 0 ? "resolved" : "unresolved",
      ...(condition === null ? {} : { condition }),
      ...(scopeIn(sourceText).length === 0 ? {} : { scope: scopeIn(sourceText) }),
      dependencies: [],
      conflicts: [],
      derivedBy: "runtime_action",
    });
  }

  for (const source of exactSourcesIn(input.text)) {
    const span =
      sentenceSpan(input.text, new RegExp(escapeRegExp(source.hostname), "i"), input.turnId) ??
      ({ turnId: input.turnId, start: 0, end: input.text.length } as SourceSpan);
    out.push({
      id: `${input.turnId}-source-${source.hostname}`,
      text: `${source.hostname} 을(를) 실제로 읽고, 거기서 확인한 것만 그 출처로 보고한다`,
      sourceText: input.text.slice(span.start, span.end).trim(),
      span,
      sourceTurnId: input.turnId,
      kind: "validation",
      priority: "must",
      polarity: "required",
      status: "explicit",
      provenance: "verified",
      intent: intentFor({ derivedBy: "runtime_source" }),
      binding: "resolved",
      dependencies: [],
      conflicts: [],
      derivedBy: "runtime_source",
    });
  }

  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// What a model may propose
// ---------------------------------------------------------------------------

/**
 * A model's suggestion.
 *
 * No `derivedBy`, no `status`, no authority. `confidence` is here because a
 * model saying how sure it is remains useful information; it simply does not
 * decide anything.
 */
export interface RequirementProposal {
  text: string;
  span: SourceSpan;
  /** What the model believes it selected. Checked against the runtime's cut. */
  quote?: string;
  kind?: RequirementKind;
  priority?: RequirementPriority;
  polarity?: RequirementPolarity;
  confidence?: RequirementConfidence;
}

export type RejectionReason = SpanProblem | "forged_provenance" | "semantics_reversed";

export interface RejectedProposal {
  proposal: RequirementProposal;
  reasons: RejectionReason[];
}

/** Fields a proposal must not carry. Their presence is an attempt at authority. */
const FORGEABLE = ["derivedBy", "status", "sourceText", "id", "supersededBy"];

export function acceptProposals(input: {
  turnId: string;
  userText: string;
  proposals: readonly RequirementProposal[];
}): { accepted: RequirementSpec[]; rejected: RejectedProposal[] } {
  const accepted: RequirementSpec[] = [];
  const rejected: RejectedProposal[] = [];

  input.proposals.forEach((proposal, index) => {
    const reasons: RejectionReason[] = [];

    // A proposal claiming to be runtime-derived, or supplying its own
    // `sourceText`, is trying to be believed rather than checked.
    const carried = proposal as unknown as Record<string, unknown>;
    if (FORGEABLE.some((field) => carried[field] !== undefined)) {
      rejected.push({ proposal, reasons: ["forged_provenance"] });
      return;
    }

    const check = checkSpan({
      span: proposal.span,
      turnId: input.turnId,
      full: input.userText,
      ...(proposal.quote === undefined ? {} : { quote: proposal.quote }),
    });
    reasons.push(...check.problems);
    if (!check.ok) {
      rejected.push({ proposal, reasons });
      return;
    }

    const polarity = proposal.polarity ?? "required";
    const priority = priorityFrom(check.text, proposal.priority ?? "should");
    const alignment = checkAlignment({
      spanText: check.text,
      proposalText: proposal.text,
      polarity,
      priority,
    });
    if (alignment.verdict === "reversed") {
      rejected.push({ proposal, reasons: ["semantics_reversed"] });
      return;
    }

    const condition = conditionIn(check.text);
    const scope = scopeIn(check.text);

    accepted.push({
      id: `${input.turnId}-model-${index + 1}`,
      text: proposal.text,
      sourceText: check.text,
      span: proposal.span,
      sourceTurnId: input.turnId,
      kind: proposal.kind ?? "functional",
      priority,
      polarity,
      status: "explicit",
      // It survived the span and semantics checks, so the words are real.
      provenance: "verified",
      // Never `confirmed`, whatever the proposal said.
      intent: intentFor({ derivedBy: "model_proposal" }),
      binding: "resolved",
      ...(proposal.confidence === undefined ? {} : { modelClaimedConfidence: proposal.confidence }),
      ...(condition === null ? {} : { condition }),
      ...(scope.length === 0 ? {} : { scope }),
      alignment,
      dependencies: [],
      conflicts: [],
      derivedBy: "model_proposal",
    });
  });

  return { accepted, rejected };
}

// ---------------------------------------------------------------------------
// User approval
// ---------------------------------------------------------------------------

/** Words in a later turn that approve what was proposed. */
const APPROVAL = /승인|맞(?:아|습니다)|그렇게\s*(?:해|하자)|확인했|진행해|approved?\b|yes\b|correct\b/i;

/**
 * Confirms requirements the user themselves agreed to.
 *
 * The one route by which a `model_proposal` becomes `confirmed`, and it runs
 * through the user rather than around them. `approvedIds` is what the caller
 * showed them; the approval text is checked so a turn that says "아니" cannot
 * be counted as agreement.
 */
export function applyUserApproval(input: {
  specs: readonly RequirementSpec[];
  approvalText: string;
  approvedIds: readonly string[];
  turnId: string;
}): RequirementSpec[] {
  if (!APPROVAL.test(input.approvalText)) return [...input.specs];
  const approved = new Set(input.approvedIds);
  return input.specs.map((spec) =>
    approved.has(spec.id) && spec.condition === undefined
      ? {
          ...spec,
          intent: intentFor({ derivedBy: spec.derivedBy, userApproved: true }),
          // Approving the reading settles the target it named, and nothing else.
          binding: "resolved" as const,
          sourceTurnId: spec.sourceTurnId,
        }
      : spec,
  );
}

// ---------------------------------------------------------------------------
// Across turns
// ---------------------------------------------------------------------------

export function mergeRequirements(input: {
  standing: readonly RequirementSpec[];
  incoming: readonly RequirementSpec[];
  relation: TurnRelation;
  turnId: string;
}): RequirementSpec[] {
  const { standing, incoming, relation, turnId } = input;

  if (relation === "new_task") return [...incoming];
  if (relation === "question" || relation === "continue") return carry(standing);
  if (relation === "refine") return [...carry(standing), ...incoming];

  const superseded = standing.map((spec) => {
    const contradicted = incoming.some((next) => contradicts(spec, next) || sameSubject(spec, next));
    return contradicted ? { ...spec, supersededBy: turnId } : spec;
  });
  return [...carry(superseded), ...incoming];
}

/**
 * Everything that stood, marked inherited.
 *
 * A carried requirement keeps the confidence it earned. It was established
 * once; a later unrelated turn is not a reason to doubt it, and re-deriving it
 * as ambiguous would make every long conversation gradually uncertain.
 */
function carry(specs: readonly RequirementSpec[]): RequirementSpec[] {
  return specs.map((spec) =>
    spec.status === "explicit" && spec.derivedBy !== "carried"
      ? {
          ...spec,
          status: "inherited" as const,
          derivedBy: "carried" as const,
          intent: intentFor({ derivedBy: "carried", previous: spec.intent }),
        }
      : spec,
  );
}

function contradicts(a: RequirementSpec, b: RequirementSpec): boolean {
  return a.polarity !== b.polarity && subjectOf(a) === subjectOf(b);
}

function sameSubject(a: RequirementSpec, b: RequirementSpec): boolean {
  return subjectOf(a) !== null && subjectOf(a) === subjectOf(b);
}

function subjectOf(spec: RequirementSpec): string | null {
  if (/실행|돌리|구동|execute|\brun\b/i.test(spec.text)) return "execute";
  if (/수정|고치|바꾸|변경|손대|modify|edit/i.test(spec.text)) return "modify";
  return null;
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

/**
 * Requirements that cannot both be satisfied, marked on both sides.
 *
 * Detected, never resolved. "형식은 그대로 유지하면서 필드 이름을 전부 바꿔줘"
 * is a question for the user, and a planner that picks one has decided
 * something on their behalf and hidden that it did.
 */
export function markConflicts(specs: readonly RequirementSpec[]): RequirementSpec[] {
  const KEEP = /유지|보존|그대로|keep|preserve/;
  const CHANGE = /바꾸|변경|이름을|rename|change|replace/;
  const conflicts = new Map<string, string[]>();
  const add = (id: string, other: string): void => {
    conflicts.set(id, [...(conflicts.get(id) ?? []), other]);
  };

  for (const a of specs) {
    for (const b of specs) {
      if (a.id === b.id) continue;
      if (a.supersededBy !== undefined || b.supersededBy !== undefined) continue;
      const opposed =
        (KEEP.test(a.text) && CHANGE.test(b.text) && sharedSubject(a.text, b.text)) ||
        (a.polarity !== b.polarity && subjectOf(a) !== null && subjectOf(a) === subjectOf(b));
      if (opposed) add(a.id, b.id);
      // The acts and the thing they are about, rather than two texts sharing a
      // word. Marked on both sides, because both requirements are blocked until
      // the user says which one wins.
      if (actsCollide(a, b)) {
        add(a.id, b.id);
        add(b.id, a.id);
      }
    }
  }

  return specs.map((spec) =>
    conflicts.has(spec.id) ? { ...spec, conflicts: [...new Set(conflicts.get(spec.id))] } : spec,
  );
}

/** Acts that alter what is already there. `create` adds and contradicts nothing. */
const CHANGING_ACTS: ReadonlySet<string> = new Set(["modify", "remove"]);

/**
 * Whether one requirement asks to change the very thing another asks to keep.
 *
 * The text-based rule above could not see this. `sharedSubject` filters `이름` out
 * of its noun list — sensibly, since it is a common word — and `이름` is exactly
 * the noun that "함수 이름을 바꿔주고 기존 이름도 그대로 유지해줘" shares. Relaxing
 * that filter was the obvious fix and the wrong one: it makes any two sentences
 * mentioning a name look contradictory.
 *
 * So this reads the two things the runtime already recorded — the act, and the
 * noun phrase the act applies to — and asks whether they are opposed *about the
 * same subject*. A subject is the head noun plus its qualifier, and the qualifier
 * is what separates the pairs:
 *
 *     함수 이름  ↔  기존 이름     같은 대상 (기존 은 앞의 것을 가리킨다) → 충돌
 *     파일 이름  ↔  함수 이름     다른 대상                            → 충돌 아님
 *     함수 이름  ↔  API 동작      다른 것                              → 충돌 아님
 *     내부 이름  ↔  외부 호환성   다른 것                              → 충돌 아님
 *
 * Both requirements must come from the user's own words. A model's proposal is
 * `ambiguous` and already blocks execution on its own; letting one raise a
 * conflict would let a paraphrase invalidate something the user actually said.
 */
function actsCollide(a: RequirementSpec, b: RequirementSpec): boolean {
  if (a.derivedBy !== "runtime_action" || b.derivedBy !== "runtime_action") return false;
  if (a.act !== "preserve") return false;
  if (b.act === undefined || !CHANGING_ACTS.has(b.act)) return false;
  if (a.target === undefined || b.target === undefined) return false;
  return sameTargetPhrase(a.target, b.target);
}

/**
 * Qualifiers that point back at something already mentioned rather than naming a
 * different thing.
 *
 * "기존 이름" in a sentence that has just said "함수 이름" *is* that name. Treating
 * `기존` as a distinguishing modifier is what let the pair through: two different
 * qualifiers normally mean two different subjects, and this is the class where
 * they do not.
 */
const ANAPHORIC = /^(?:기존|현재|원래|본래|지금|이전|종전|그|해당|이|그대로)$/;

/** Whether two target phrases name the same thing. Head noun plus qualifier. */
function sameTargetPhrase(left: string, right: string): boolean {
  const parts = (phrase: string): { head: string; qualifier: string | null } => {
    const words = phrase.trim().split(/\s+/).filter((w) => w.length > 0);
    const head = words[words.length - 1] ?? "";
    return { head, qualifier: words.length > 1 ? (words[words.length - 2] ?? null) : null };
  };
  const a = parts(left);
  const b = parts(right);
  if (a.head.length === 0 || a.head !== b.head) return false;
  if (a.qualifier === null || b.qualifier === null) return true;
  if (a.qualifier === b.qualifier) return true;
  // One side points back at what the other named.
  return ANAPHORIC.test(a.qualifier) || ANAPHORIC.test(b.qualifier);
}

/** Whether two requirement texts talk about the same noun. Coarse on purpose. */
function sharedSubject(a: string, b: string): boolean {
  const nouns = (text: string): string[] =>
    (text.match(/[A-Za-z][\w.-]{2,}|[가-힣]{2,}/g) ?? []).filter(
      (w) => !/유지|보존|그대로|변경|바꾸|이름|전부|모두/.test(w),
    );
  const left = new Set(nouns(a));
  return nouns(b).some((word) => left.has(word));
}

// ---------------------------------------------------------------------------
// The harness's own conditions
// ---------------------------------------------------------------------------

export function systemBaseline(turnId: string): RequirementSpec[] {
  const base = {
    sourceText: "",
    sourceTurnId: turnId,
    status: "system_added" as const,
    provenance: "verified" as const,
    intent: intentFor({ derivedBy: "system_baseline" }),
    binding: "resolved" as const,
    dependencies: [],
    conflicts: [],
    derivedBy: "system_baseline" as const,
    priority: "must" as const,
  };
  return [
    {
      ...base,
      id: `${turnId}-system-completion`,
      text: "완료 주장은 기록된 요구사항과 증거가 뒷받침할 때만 사용자에게 전달된다",
      kind: "safety",
      polarity: "required",
    },
    {
      ...base,
      id: `${turnId}-system-forbidden-action`,
      text: "사용자가 금지한 동작은 계약 기록 여부와 무관하게 실행되지 않는다",
      kind: "security",
      polarity: "forbidden",
    },
  ];
}

export { sentenceAround };
export type { SourceSpan };
