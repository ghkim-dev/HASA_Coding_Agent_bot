import type { TurnIntent, TaskContract } from "../agent/turnContract.ts";
import { activeRequirements } from "../agent/turnContract.ts";

/**
 * What a task is *about*, and what a model is *for*.
 *
 * This exists because the semantic term of the ranking was measuring nothing.
 * The task's text was the user's own domain language — "실시간 회의록 시스템",
 * "React 상태 관리 버그" — and the model's text was its capability flags read
 * aloud: "코드 작성이 확인된 모델, 네이티브 도구 호출 지원, 컨텍스트 128000
 * 토큰". The cosine of those two asks how much a meeting-transcription system
 * resembles the phrase "supports tool calling", and the answer is noise.
 *
 * Worse than noise, actually. What little signal it carried was the capability
 * flags, and `capabilityScore` already scores those at 0.40 — so a semantic
 * term built that way spends 0.15 of the ranking double-counting evidence that
 * is already counted.
 *
 * So the axes here are deliberately narrow, and they are the ones the other
 * four scores do *not* use:
 *
 *     Semantic     which domain and task family is this about
 *     Capability   how able is the model at what this needs
 *     Evaluation   how did it actually do on this harness
 *     Eligibility  may it be used at all
 *     Efficiency   what does it cost
 *
 * Nothing that belongs to one of the other four may appear here. The validator
 * below enforces that rather than trusting a comment to be read.
 */

// ---------------------------------------------------------------------------
// The axes
// ---------------------------------------------------------------------------

/** What field of work. "software engineering", "document processing". */
export type Domain = string;
/** What kind of job. "debugging", "implementation", "summarization". */
export type TaskType = string;
/** A natural language, as a BCP-47-ish tag the renderer prints verbatim. */
export type Language = string;

/**
 * What a model is deployed to be.
 *
 * Separate from every capability number, and separate from semantic fit, because
 * it answers a different question: not "how well would this model do the work"
 * but "is doing this work what this model is for at all".
 *
 * The case that forced it: `granite-guardian-3.1-8b` passes the capability
 * probe for chat and would pass for patch work, because the probe measures
 * whether a model answers and calls tools. It is a safety classifier. Letting a
 * low similarity score push it down the ranking would be using semantic fit to
 * correct a candidate list that should never have contained it — and at 0.15 of
 * the score against 0.40 for capability, it would not reliably even do that.
 *
 * So this is a filter input, not a score input.
 */
export type ModelRole =
  /** Answers requests and does work across domains. */
  | "general_worker"
  /** A worker, specialised to code. */
  | "coding_worker"
  /** A worker, specialised to reading images and documents. */
  | "ocr_worker"
  /** A worker, specialised to vision-language work. */
  | "vision_worker"
  /** A worker across several modalities, without one specialism. */
  | "multimodal_worker"
  /** Classifies text for risk. Not an assistant. */
  | "safety_classifier"
  /** Produces vectors. */
  | "embedding"
  /** Orders candidates. */
  | "reranker"
  /** Nobody has said. Not a disqualification. */
  | "unknown";

/**
 * Roles that can drive an agent turn at all.
 *
 * Deliberately wider than "is a candidate for the coding pool". A
 * vision-language model *is* a worker — it answers, it uses tools, it does
 * work — and it is not a candidate for coding. Recording it as
 * `general_worker` and then excluding it from the only pool that exists would
 * make the role field a lie kept honest by a separate list; recording it as
 * not-a-worker would be wrong the day a vision pool exists.
 *
 * So the role says what kind of worker, and `ineligibleFor` says which pools.
 */
const WORKER_ROLES: ReadonlySet<ModelRole> = new Set([
  "general_worker",
  "coding_worker",
  "ocr_worker",
  "vision_worker",
  "multimodal_worker",
]);

export function roleIsWorker(role: ModelRole): boolean | "unknown" {
  if (role === "unknown") return "unknown";
  return WORKER_ROLES.has(role);
}

/**
 * What kind of thing the claim rests on.
 *
 * Separate from whether anyone has reviewed it, and the separation is the
 * point. "Nobody signed this off" was doing two jobs at once — it marked a
 * claim as provisional *and* it was the only thing standing between a
 * hand-written sentence and a model being removed from consideration. Those are
 * different concerns, and collapsing them meant an unreviewed guess and an
 * unreviewed measurement carried the same weight.
 */
export type EvidenceStatus =
  /** We called the endpoint and it answered — or refused. An observation. */
  | "invocation_verified"
  /** The provider's own documentation says what this is for. */
  | "provider_documented"
  /** Someone wrote it down. Includes anything inferred from a name. */
  | "manual_assertion"
  /** Nothing. */
  | "unknown";

/**
 * How much a claim is allowed to change routing.
 *
 * The rule the policy asks for: a measurement or a documented fact may remove a
 * model from a pool; an assertion may only advise. This is what stops
 * "unreviewed" from becoming a general licence to exclude — the question is not
 * whether someone checked the claim, it is what kind of claim it is.
 */
export type RoutingEffect =
  /** May remove the model from the pool. */
  | "hard_exclude"
  /** Surfaced in the reasons; never removes anything. */
  | "advisory"
  /** Recorded and observable; no effect on ranking at all. */
  | "shadow_only";

export function routingEffectFor(status: EvidenceStatus): RoutingEffect {
  if (status === "invocation_verified" || status === "provider_documented") return "hard_exclude";
  if (status === "manual_assertion") return "advisory";
  return "shadow_only";
}

/**
 * A pool a model may or may not belong in.
 *
 * Ineligibility is scoped rather than global. A vision-language model is not a
 * candidate for the coding worker pool and is an obvious candidate for a vision
 * one, and recording that as "unusable" would be a claim about the model rather
 * than about this pool — and would have to be unpicked the day the second pool
 * exists.
 */
export type WorkerPool = "coding" | "vision" | "safety";

export const DEFAULT_POOL: WorkerPool = "coding";

/** Why a model is not a candidate for one pool, and what backs that. */
export interface PoolExclusion {
  pool: WorkerPool;
  reason: string;
}

export interface ModelSemanticProfile {
  modelId: string;
  /**
   * What the model is deployed to be, and whether that is agent work.
   *
   * `workerEligible` is derived from `role` by `roleIsWorker` rather than
   * written separately — two fields that can disagree is a bug waiting for
   * someone to edit one of them.
   */
  role: ModelRole;
  domains: Domain[];
  taskTypes: TaskType[];
  languages: Language[];
  /** Prose about what it is for. Never about how good it is. */
  description: string;
  /**
   * Pools this model is not a candidate for.
   *
   * Scoped, never global. Absent or empty means no restriction is claimed.
   */
  ineligibleFor?: PoolExclusion[];
  provenance: {
    origin: "manual";
    /** What kind of claim this is. Decides how far it may reach. */
    evidenceStatus: EvidenceStatus;
    /**
     * Where the curator got it.
     *
     * Required, and required to be specific. "the model's published
     * documentation" is a source; the model's own name is not, and a profile
     * whose only basis is its id is the heuristic this whole design refuses.
     */
    source: string;
    /** When the evidence was taken or checked. */
    verifiedAt?: string;
    /**
     * Whether a person with authority over this project has signed it off.
     *
     * Now only about confidence in the write-up. It no longer decides what the
     * claim may do — `evidenceStatus` does — because "nobody reviewed this" was
     * being asked to mean both "treat as provisional" and "may not exclude
     * anything", and a measurement nobody reviewed is still a measurement.
     */
    reviewed: boolean;
    reviewedAt?: string;
  };
}

export interface TaskSemanticProfile {
  /**
   * Absent in this slice, and absent on purpose.
   *
   * Nothing available today can fill it honestly. The contract holds the
   * user's prose, and pulling domain tags out of Korean prose is the keyword
   * matching `turnContract.ts` refuses to do. The model could be asked for
   * them — it already interprets intents — but that is a contract change and
   * belongs to its own slice. Until then the domain signal rides in
   * `description`, which is the user's own wording and carries it already.
   */
  domains?: Domain[];
  /** Derived from the contract's intents by a fixed table. */
  taskTypes: TaskType[];
  /** Detected from the script the request is written in. A fact, not a reading. */
  languages: Language[];
  /** The user's own words: the goal and the requirements, in order. */
  description: string;
}

// ---------------------------------------------------------------------------
// What may not appear
// ---------------------------------------------------------------------------

/**
 * Words that assert quality rather than subject.
 *
 * A semantic profile is not a product page. "excellent at coding" and "does
 * coding" embed differently, and the first one makes every model that hired a
 * better copywriter rank higher — which is the failure mode this axis is most
 * exposed to, because unlike the other four scores nothing measures it.
 */
const QUALITY_WORDS: readonly string[] = [
  "excellent",
  "powerful",
  "best",
  "superior",
  "state-of-the-art",
  "state of the art",
  "high quality",
  "high-quality",
  "strongest",
  "leading",
  "cutting-edge",
  "world-class",
  "outstanding",
  "exceptional",
  "unmatched",
  "혁신적",
  "최고",
  "최강",
  "뛰어난",
  "탁월",
  "강력한",
];

/**
 * Terms that belong to eligibility or capability, not to subject matter.
 *
 * Context windows and tool protocols decide *whether a model may be used*, and
 * `filterEligible` reads them from structured fields. Restating them as prose
 * would put the same fact in two places and let a similarity score have an
 * opinion about a hard constraint.
 */
const METADATA_WORDS: readonly string[] = [
  "context window",
  "tool calling",
  "native tool",
  "max output",
  "token limit",
  "128k",
  "32k",
  "컨텍스트",
  "토큰",
  "도구 호출",
];

/** Anything that looks like a measurement. Evaluation owns those. */
const SCORE_PATTERN = /\b\d{1,3}\s?%|\b0\.\d+\b|\b\d\.\d{2}\b/;

export interface ProfileProblem {
  code: "QUALITY_CLAIM" | "EVALUATION_NUMBER" | "CAPABILITY_METADATA" | "EMPTY" | "NO_SOURCE";
  detail: string;
}

/**
 * Checks a curated profile before it can influence anything.
 *
 * Refusing is the point. A profile that slips a score or a superlative past
 * this becomes an embedding, and an embedding is not readable — nobody
 * reviewing a ranking later would be able to see where the extra weight came
 * from.
 */
export function validateModelSemanticProfile(profile: ModelSemanticProfile): ProfileProblem | null {
  const text = [profile.description, ...profile.domains, ...profile.taskTypes].join(" ").toLowerCase();

  if (profile.description.trim().length === 0 && profile.domains.length === 0) {
    return { code: "EMPTY", detail: "도메인도 설명도 없는 프로필은 아무것도 말하지 않습니다." };
  }
  if (profile.provenance.source.trim().length === 0) {
    return { code: "NO_SOURCE", detail: "이 내용을 어디서 가져왔는지 적어야 합니다." };
  }
  for (const word of QUALITY_WORDS) {
    if (text.includes(word.toLowerCase())) {
      return {
        code: "QUALITY_CLAIM",
        detail: `"${word}" 은(는) 품질 주장입니다. 무엇을 잘하는지가 아니라 무엇에 관한 모델인지 적으십시오.`,
      };
    }
  }
  if (SCORE_PATTERN.test(profile.description)) {
    return {
      code: "EVALUATION_NUMBER",
      detail: "평가 수치는 evaluationScore가 씁니다. 여기 넣으면 같은 증거를 두 번 셉니다.",
    };
  }
  for (const word of METADATA_WORDS) {
    if (text.includes(word.toLowerCase())) {
      return {
        code: "CAPABILITY_METADATA",
        detail: `"${word}" 은(는) eligibility/capability 메타데이터입니다. 도메인 설명과 섞지 마십시오.`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The task side
// ---------------------------------------------------------------------------

/**
 * What each intent is, said as a kind of job.
 *
 * A table, like every other mapping in this codebase, so a new intent is one
 * row and an unmapped one contributes nothing rather than inheriting a
 * neighbour's meaning.
 */
const INTENT_TASK_TYPE: Readonly<Record<TurnIntent, string>> = {
  discuss: "explanation",
  inspect: "code analysis",
  present: "presentation",
  modify: "implementation",
  execute: "execution",
  verify: "testing",
  research: "research",
  continue: "continuation",
};

/**
 * Which languages the request is written in.
 *
 * Detected from the characters, which is a fact about the bytes rather than a
 * reading of the meaning — the distinction this codebase draws everywhere else.
 * Hangul is present or it is not; nothing here decides what the sentence says.
 */
export function languagesIn(text: string): Language[] {
  const found: Language[] = [];
  if (/[가-힯ᄀ-ᇿ]/.test(text)) found.push("ko");
  if (/[A-Za-z]/.test(text)) found.push("en");
  if (/[぀-ゟ゠-ヿ]/.test(text)) found.push("ja");
  if (/[一-鿿]/.test(text) && !found.includes("ja")) found.push("zh");
  return found;
}

/** Projects the semantic half of a task, from the contract and nothing else. */
export function projectTaskSemanticProfile(contract: TaskContract): TaskSemanticProfile {
  const requirements = activeRequirements(contract);
  const description = [contract.goal, ...requirements.map((r) => r.description)]
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .join(". ");

  const taskTypes = [...new Set(contract.intents.map((i) => INTENT_TASK_TYPE[i]).filter((t) => t !== undefined))];

  return {
    taskTypes: taskTypes.sort(),
    languages: languagesIn(description),
    description,
  };
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

/**
 * One profile, as the text that gets embedded.
 *
 * Deterministic in every part: the sections are in a fixed order, the lists are
 * sorted, and nothing is generated. The alternative — asking a model to write a
 * description each time — would put another non-deterministic step in front of
 * the router, so the same task could rank differently on two identical turns
 * and nobody could say why.
 *
 * Both sides render through the same function so the two texts are comparable
 * by construction rather than by anyone remembering to keep them alike.
 */
export function renderSemanticText(profile: {
  domains?: readonly string[];
  taskTypes: readonly string[];
  languages: readonly string[];
  description: string;
}): string {
  const sections: string[] = [];
  const list = (values: readonly string[]): string => [...values].sort().join(", ");

  if (profile.domains !== undefined && profile.domains.length > 0) {
    sections.push(`Domains: ${list(profile.domains)}`);
  }
  if (profile.taskTypes.length > 0) sections.push(`Task types: ${list(profile.taskTypes)}`);
  if (profile.languages.length > 0) sections.push(`Languages: ${list(profile.languages)}`);
  if (profile.description.trim().length > 0) {
    sections.push(`Description: ${profile.description.trim()}`);
  }
  return sections.join("\n");
}

/** The section names, so a test can hold both sides to the same vocabulary. */
export const SEMANTIC_SECTIONS: readonly string[] = ["Domains", "Task types", "Languages", "Description"];

/**
 * A stable key for a semantic profile, for the embedding cache.
 *
 * Over the rendered text rather than the object, because the rendered text is
 * exactly what gets embedded: two profiles that render the same must not be
 * embedded twice, and one that renders differently must not reuse a vector.
 */
export function semanticFingerprint(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `sem-${h1.toString(36)}${h2.toString(36)}`;
}
