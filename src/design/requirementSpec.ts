import { prohibitionsIn, type ProhibitedClass } from "../agent/statedProhibitions.ts";
import { exactSourcesIn } from "../agent/sourceProvenance.ts";
import type { TurnRelation } from "../agent/turnContract.ts";

/**
 * What the user asked for, in a form a verification plan can be built from.
 *
 * The existing `Requirement` in `turnContract.ts` is what the *model* recorded.
 * This is what the runtime is prepared to act on, and the difference is the
 * whole point: a plan built from the first inherits every omission the model
 * made, and this codebase has measured those. In one six-run fixture the model
 * filed the turn correctly as a correction and recorded no constraint at all,
 * three times.
 *
 *     model records it   → a proposal
 *     runtime finds it   → a fact
 *     runtime checks it  → a proposal that may be kept
 *
 * ## Provenance is not decoration
 *
 * `sourceText` must appear in what the user actually wrote. A model that
 * paraphrases a requirement into existence produces a plan that verifies
 * something nobody asked for, and the only defence that survives contact with a
 * confident model is checking the words against the transcript.
 *
 * ## Three origins, kept apart
 *
 * `explicit` is the user's. `inherited` came from an earlier turn and still
 * stands. `system_added` is this harness insisting on something — a safety
 * baseline — and it is separated because a report that presents it as the
 * user's request is lying about who wants it.
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

export interface RequirementSpec {
  id: string;
  /** The requirement, as the plan will refer to it. */
  text: string;
  /**
   * The user's own words that support it.
   *
   * Empty only for `system_added`, which by definition has no user text behind
   * it. For everything else this is verified against the transcript.
   */
  sourceText: string;
  sourceTurnId: string;
  kind: RequirementKind;
  priority: RequirementPriority;
  polarity: RequirementPolarity;
  status: RequirementStatus;
  confidence: RequirementConfidence;
  dependencies: string[];
  conflicts: string[];
  /** Set when a later turn replaced it. The original is never deleted. */
  supersededBy?: string;
  /** How it got here, for the audit trail. */
  derivedBy: "runtime_prohibition" | "runtime_source" | "model_proposal" | "system_baseline" | "carried";
}

// ---------------------------------------------------------------------------
// What the runtime can establish on its own
// ---------------------------------------------------------------------------

/** Whitespace-insensitive containment. Users and models space things differently. */
function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The sentence a match sits in.
 *
 * `sourceText` has to be quotable back to the user, and a class name is not
 * quotable. The sentence is the smallest unit that still reads as something
 * they wrote.
 */
export function sentenceContaining(text: string, pattern: RegExp): string | null {
  for (const sentence of text.split(/(?<=[.!?。])\s+|\n+/)) {
    const trimmed = sentence.trim();
    if (trimmed.length > 0 && pattern.test(trimmed)) return trimmed;
  }
  return null;
}

const PROHIBITION_SENTENCE: Readonly<Record<ProhibitedClass, RegExp>> = {
  execute: /실행|돌리|구동|run|execute/i,
  modify: /수정|고치|바꾸|변경|건드리|손대|modify|edit|change/i,
};

const PROHIBITION_TEXT: Readonly<Record<ProhibitedClass, string>> = {
  execute: "이번 요청에서 명령을 실행하지 않는다",
  modify: "이번 요청에서 파일을 수정하지 않는다",
};

/**
 * Requirements the runtime reads out of the user's own words.
 *
 * No model involved, so these cannot be omitted by one. They are the floor
 * under whatever a model proposes, and they are the reason a plan for
 * "실행하지 말고" contains a no-execute check even when the model forgot.
 */
export function runtimeRequirements(input: {
  turnId: string;
  text: string;
}): RequirementSpec[] {
  const out: RequirementSpec[] = [];

  for (const klass of prohibitionsIn(input.text)) {
    const sentence = sentenceContaining(input.text, PROHIBITION_SENTENCE[klass]) ?? input.text.trim();
    out.push({
      id: `${input.turnId}-forbid-${klass}`,
      text: PROHIBITION_TEXT[klass],
      sourceText: sentence,
      sourceTurnId: input.turnId,
      kind: "constraint",
      priority: "must",
      polarity: "forbidden",
      status: "explicit",
      confidence: "confirmed",
      dependencies: [],
      conflicts: [],
      derivedBy: "runtime_prohibition",
    });
  }

  for (const source of exactSourcesIn(input.text)) {
    const sentence =
      sentenceContaining(input.text, new RegExp(escapeRegExp(source.hostname), "i")) ??
      input.text.trim();
    out.push({
      id: `${input.turnId}-source-${source.hostname}`,
      text: `${source.hostname} 을(를) 실제로 읽고, 거기서 확인한 것만 그 출처로 보고한다`,
      sourceText: sentence,
      sourceTurnId: input.turnId,
      kind: "validation",
      priority: "must",
      polarity: "required",
      status: "explicit",
      confidence: "confirmed",
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
// What a model may propose, and what happens to it
// ---------------------------------------------------------------------------

/** A model's suggestion. Nothing here is trusted until it is checked. */
export interface RequirementProposal {
  text: string;
  sourceText: string;
  kind?: RequirementKind;
  priority?: RequirementPriority;
  polarity?: RequirementPolarity;
  confidence?: RequirementConfidence;
}

export interface RejectedProposal {
  proposal: RequirementProposal;
  reason: "not_in_source" | "empty_source";
}

/**
 * Accepts what the transcript supports and refuses the rest.
 *
 * The one rule: `sourceText` must be in the user's message, verbatim modulo
 * whitespace. A model that summarises "실행하지 말고 보여줘" as "사용자는 안전을
 *원한다" has invented a requirement, and a plan built on it verifies something
 * nobody asked for while the real request goes unchecked.
 *
 * An accepted proposal keeps whatever confidence it claimed. `ambiguous` stays
 * `ambiguous`: a plan that resolves an ambiguity by guessing has decided
 * something on the user's behalf and hidden that it did.
 */
export function acceptProposals(input: {
  turnId: string;
  userText: string;
  proposals: readonly RequirementProposal[];
}): { accepted: RequirementSpec[]; rejected: RejectedProposal[] } {
  const haystack = normalise(input.userText);
  const accepted: RequirementSpec[] = [];
  const rejected: RejectedProposal[] = [];

  input.proposals.forEach((proposal, index) => {
    const needle = normalise(proposal.sourceText);
    if (needle.length === 0) {
      rejected.push({ proposal, reason: "empty_source" });
      return;
    }
    if (!haystack.includes(needle)) {
      rejected.push({ proposal, reason: "not_in_source" });
      return;
    }
    accepted.push({
      id: `${input.turnId}-model-${index + 1}`,
      text: proposal.text,
      sourceText: proposal.sourceText.trim(),
      sourceTurnId: input.turnId,
      kind: proposal.kind ?? "functional",
      priority: proposal.priority ?? "should",
      polarity: proposal.polarity ?? "required",
      status: "explicit",
      confidence: proposal.confidence ?? "ambiguous",
      dependencies: [],
      conflicts: [],
      derivedBy: "model_proposal",
    });
  });

  return { accepted, rejected };
}

// ---------------------------------------------------------------------------
// Across turns
// ---------------------------------------------------------------------------

/**
 * What a turn's relation does to what already stood.
 *
 * The same algebra `mergeContract` uses, applied to specs. Stated here rather
 * than inferred because the failure it prevents is specific: a correction that
 * *deletes* the thing it corrects leaves a plan that no longer knows the user
 * changed their mind, and "실행하지 말고" following "실행해줘" is the case that
 * matters most.
 *
 *     new_task   the standing list is replaced
 *     refine     kept, and added to
 *     correct    kept and marked superseded; the new one stands
 *     continue   kept; nothing new is invented
 *     question   kept; nothing new is invented
 */
export function mergeRequirements(input: {
  standing: readonly RequirementSpec[];
  incoming: readonly RequirementSpec[];
  relation: TurnRelation;
  turnId: string;
}): RequirementSpec[] {
  const { standing, incoming, relation, turnId } = input;

  if (relation === "new_task") return [...incoming];

  if (relation === "question" || relation === "continue") {
    // Nothing new. A question is not a request, and a continuation restates
    // nothing — inventing a requirement here is how a plan grows work the user
    // never asked for.
    return carry(standing);
  }

  if (relation === "refine") return [...carry(standing), ...incoming];

  // correct. Anything the incoming set contradicts is superseded, not removed.
  const superseded = standing.map((spec) => {
    const contradicted = incoming.some(
      (next) => contradicts(spec, next) || sameSubject(spec, next),
    );
    return contradicted ? { ...spec, supersededBy: turnId } : spec;
  });
  return [...carry(superseded), ...incoming];
}

/** Everything that stood, marked as inherited rather than restated as new. */
function carry(specs: readonly RequirementSpec[]): RequirementSpec[] {
  return specs.map((spec) =>
    spec.status === "explicit" && spec.derivedBy !== "carried"
      ? { ...spec, status: "inherited" as const, derivedBy: "carried" as const }
      : spec,
  );
}

/** Opposite polarity about the same thing. */
function contradicts(a: RequirementSpec, b: RequirementSpec): boolean {
  return a.polarity !== b.polarity && subjectOf(a) === subjectOf(b);
}

function sameSubject(a: RequirementSpec, b: RequirementSpec): boolean {
  return subjectOf(a) !== null && subjectOf(a) === subjectOf(b);
}

/**
 * What a requirement is about, coarsely.
 *
 * Only enough to tell "run it" from "do not run it". Deliberately not a
 * semantic model: a wrong guess here supersedes something it should not, so it
 * answers `null` unless the subject is one it can name from the derivation
 * rather than from prose.
 */
function subjectOf(spec: RequirementSpec): string | null {
  // Every origin, not only the runtime-derived ones. The first version gated
  // this on `derivedBy` and so excluded `model_proposal` — which is exactly
  // where the user's original request lives. "main.py 를 실행한다" followed by
  // "실행하지 말고" then superseded nothing, which is the one case a correction
  // exists for.
  if (/실행|돌리|구동|execute|\brun\b/i.test(spec.text)) return "execute";
  if (/수정|고치|바꾸|변경|손대|modify|edit/i.test(spec.text)) return "modify";
  return null;
}

// ---------------------------------------------------------------------------
// The harness's own conditions
// ---------------------------------------------------------------------------

/**
 * What this harness requires whatever the user said.
 *
 * Marked `system_added` and never `explicit`. A report that presents these as
 * the user's request is claiming they asked for something they did not, and the
 * separation is what lets a reader see which half of a plan is theirs.
 */
export function systemBaseline(turnId: string): RequirementSpec[] {
  return [
    {
      id: `${turnId}-system-completion`,
      text: "완료 주장은 기록된 요구사항과 증거가 뒷받침할 때만 사용자에게 전달된다",
      sourceText: "",
      sourceTurnId: turnId,
      kind: "safety",
      priority: "must",
      polarity: "required",
      status: "system_added",
      confidence: "confirmed",
      dependencies: [],
      conflicts: [],
      derivedBy: "system_baseline",
    },
    {
      id: `${turnId}-system-forbidden-action`,
      text: "사용자가 금지한 동작은 계약 기록 여부와 무관하게 실행되지 않는다",
      sourceText: "",
      sourceTurnId: turnId,
      kind: "security",
      priority: "must",
      polarity: "forbidden",
      status: "system_added",
      confidence: "confirmed",
      dependencies: [],
      conflicts: [],
      derivedBy: "system_baseline",
    },
  ];
}
