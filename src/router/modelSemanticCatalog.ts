import {
  DEFAULT_POOL,
  roleIsWorker,
  routingEffectFor,
  renderSemanticText,
  semanticFingerprint,
  validateModelSemanticProfile,
  type EvidenceStatus,
  type ModelSemanticProfile,
  type RoutingEffect,
  type WorkerPool,
} from "./semanticProfile.ts";

/**
 * What each model is for, and what kind of claim that is.
 *
 * ## Why this file has to exist
 *
 * `/v1/models` returns an id and an owner. `/api/catalog` adds a modality and
 * availability. Neither says what a model is *for*, and the two obvious
 * substitutes are both wrong.
 *
 * A **name** is not evidence, and it fails in both directions. `qwen2.5-coder`
 * had "coder" in its id and its deployment had tool calling switched off;
 * `granite-guardian` sounds like it could be anything and is a safety
 * classifier. The **capability probe** is not evidence for this either — it
 * measures whether a model answers and calls tools, which is capability, and is
 * scored elsewhere.
 *
 * ## Evidence decides reach, not review
 *
 * Every entry says what kind of claim it is, and that is what governs how far
 * it can go:
 *
 *     invocation_verified   we called it and it answered, or refused   → may exclude
 *     provider_documented   the provider's docs say what it is for     → may exclude
 *     manual_assertion      someone wrote it down; includes a guess    → advisory only
 *     unknown               nothing                                    → cold start
 *
 * The distinction matters because `reviewed: false` was previously doing two
 * jobs — marking a write-up as provisional *and* deciding whether a model could
 * be removed from consideration. An unreviewed measurement and an unreviewed
 * guess are not the same thing, and only one of them should be able to take a
 * model off the list.
 *
 * ## Exclusion is scoped to a pool
 *
 * A vision-language model is not a candidate for coding work and is an obvious
 * candidate for vision work. Recording it as "unusable" would be a claim about
 * the model rather than about this pool, and would have to be unpicked the day
 * a second pool exists. So exclusions name the pool they apply to.
 *
 * ## Coverage is against the live catalogue, not against this file
 *
 * This has already been wrong once: the curation was written against a probe
 * record that was two weeks old, and by the time anyone looked the key's access
 * had gone from four models to thirty-four and one curated model had been
 * withdrawn entirely. `statusFor` compares against ids passed in by the caller,
 * so a stale entry is reported as `obsolete` rather than counted as coverage.
 */

/** Evidence taken on this date, by calling the gateway. */
const PROBED_AT = "2026-08-15";

const CURATED: readonly ModelSemanticProfile[] = [
  // -------------------------------------------------------------------------
  // Measured. These answered one endpoint and refused the other.
  // -------------------------------------------------------------------------
  {
    modelId: "bge-m3",
    role: "embedding",
    domains: ["text representation"],
    taskTypes: ["embedding"],
    languages: ["ko", "en"],
    description:
      "Serves the embeddings endpoint and returns dense vectors. It does not serve the chat " +
      "endpoint.",
    provenance: {
      origin: "manual",
      evidenceStatus: "invocation_verified",
      source:
        "Called directly on 2026-08-15: POST /v1/embeddings returned 200 with 1024-dimension " +
        "vectors and honoured a two-item batch; POST /v1/chat/completions returned 404.",
      verifiedAt: PROBED_AT,
      reviewed: false,
    },
  },
  {
    modelId: "nemotron-embed-8b",
    role: "embedding",
    domains: ["text representation"],
    taskTypes: ["embedding"],
    languages: ["en"],
    description:
      "Serves the embeddings endpoint. It does not serve the chat endpoint.",
    provenance: {
      origin: "manual",
      evidenceStatus: "invocation_verified",
      source:
        "Called directly on 2026-08-15: POST /v1/embeddings returned 200; " +
        "POST /v1/chat/completions returned 404.",
      verifiedAt: PROBED_AT,
      reviewed: false,
    },
  },

  // -------------------------------------------------------------------------
  // Documented. These answer chat, so no probe can tell them from a worker.
  // -------------------------------------------------------------------------
  {
    modelId: "granite-guardian-3.1-8b",
    role: "safety_classifier",
    domains: ["content safety", "risk detection"],
    taskTypes: ["classification", "content review"],
    languages: ["en"],
    description:
      "Guardrail model from IBM's Granite family, documented for detecting risk in prompts and " +
      "responses — harm, bias, jailbreak attempts and groundedness. A classifier for reviewing " +
      "text rather than an assistant for producing work.",
    ineligibleFor: [
      { pool: "coding", reason: "Documented as a guardrail classifier, not an assistant." },
    ],
    provenance: {
      origin: "manual",
      evidenceStatus: "provider_documented",
      source:
        "Granite Guardian published model documentation (IBM). Recorded because the model answers " +
        "the chat endpoint — verified 2026-08-15 — so no invocation probe can distinguish it from " +
        "a general worker. This is the case the role field exists for.",
      verifiedAt: PROBED_AT,
      reviewed: false,
    },
  },
  {
    modelId: "paddleocr-vl",
    role: "ocr_worker",
    domains: ["optical character recognition", "document understanding"],
    taskTypes: ["text extraction", "document analysis"],
    languages: ["ko", "en", "zh"],
    description:
      "OCR and document-parsing model from the PaddleOCR project, documented for extracting text " +
      "and structure from images of documents.",
    ineligibleFor: [
      {
        pool: "coding",
        reason:
          "Specialised for reading documents rather than writing or changing code. Not a claim " +
          "that it is unusable — a document or vision pool is where it belongs.",
      },
    ],
    provenance: {
      origin: "manual",
      evidenceStatus: "provider_documented",
      source:
        "PaddleOCR published project documentation. It answers the chat endpoint (verified " +
        "2026-08-15), so the exclusion is scoped to the coding pool rather than global.",
      verifiedAt: PROBED_AT,
      reviewed: false,
    },
  },
  {
    modelId: "qwen2.5-vl-72b",
    role: "vision_worker",
    domains: ["vision-language understanding", "document understanding"],
    taskTypes: ["image analysis", "text extraction", "explanation"],
    languages: ["en", "zh"],
    description:
      "Vision-language model from the Qwen family, documented for understanding images, documents " +
      "and video alongside text.",
    ineligibleFor: [
      {
        pool: "coding",
        reason:
          "Specialised for vision-language work rather than code. Expected to be eligible for a " +
          "vision pool when one exists.",
      },
    ],
    provenance: {
      origin: "manual",
      evidenceStatus: "provider_documented",
      source:
        "Qwen2.5-VL published model documentation (Alibaba). It answers the chat endpoint " +
        "(verified 2026-08-15); the exclusion is scoped to the coding pool.",
      verifiedAt: PROBED_AT,
      reviewed: false,
    },
  },

  // -------------------------------------------------------------------------
  // Documented general workers.
  // -------------------------------------------------------------------------
  {
    modelId: "exaone-4.0-32b",
    role: "general_worker",
    domains: ["general knowledge", "software engineering", "Korean language tasks"],
    taskTypes: ["explanation", "implementation", "reasoning", "translation"],
    languages: ["ko", "en"],
    description:
      "Bilingual Korean and English assistant model from LG AI Research, documented as a " +
      "general-purpose model with a reasoning mode.",
    provenance: {
      origin: "manual",
      evidenceStatus: "provider_documented",
      source:
        "EXAONE 4.0 published model documentation (LG AI Research). Answers the chat endpoint, " +
        "verified 2026-08-15.",
      verifiedAt: PROBED_AT,
      reviewed: false,
    },
  },
  {
    modelId: "gpt-oss-20b",
    role: "general_worker",
    domains: ["general knowledge", "software engineering", "agentic workflows"],
    taskTypes: ["explanation", "implementation", "reasoning", "code analysis"],
    languages: ["en"],
    description:
      "Open-weight general assistant model from OpenAI, documented for reasoning and agentic " +
      "tool-using workflows. Primary documented language is English.",
    provenance: {
      origin: "manual",
      evidenceStatus: "provider_documented",
      source: "gpt-oss published model card (OpenAI). Answers the chat endpoint, verified 2026-08-15.",
      verifiedAt: PROBED_AT,
      reviewed: false,
    },
  },

  // -------------------------------------------------------------------------
  // Asserted, not documented. Advisory only — these do not exclude anything.
  // -------------------------------------------------------------------------
  {
    modelId: "nemotron-safety-4b",
    role: "safety_classifier",
    domains: ["content safety"],
    taskTypes: ["classification"],
    languages: ["en"],
    description:
      "Believed to be a safety classifier in NVIDIA's Nemotron family. The basis is the family " +
      "and the name rather than documentation that was checked, so this is an assertion.",
    ineligibleFor: [
      { pool: "coding", reason: "Believed to be a classifier rather than an assistant." },
    ],
    provenance: {
      origin: "manual",
      evidenceStatus: "manual_assertion",
      source:
        "Asserted from the model family and id, not from documentation that was read. Deliberately " +
        "not `provider_documented`: an assertion may advise and may not exclude, so this model " +
        "stays a candidate until someone checks it. Answers the chat endpoint, verified 2026-08-15.",
      verifiedAt: PROBED_AT,
      reviewed: false,
    },
  },
];

/**
 * Profiles for models the gateway no longer offers.
 *
 * Kept, not deleted. A past `worker_selected` event names a model and a profile
 * fingerprint, and deleting the profile would leave that record unreadable —
 * "why was this chosen" would have no answer for exactly the decisions that are
 * furthest in the past and hardest to reconstruct. The router never sees these:
 * `semanticProfileFor` does not look here, so an obsolete model cannot come
 * back as a live candidate.
 *
 * `qwen2.5-coder-32b` is the first. It was a curated coding worker on
 * 2026-08-01 and had been withdrawn from the catalogue by 2026-08-15.
 */
const OBSOLETE: readonly ModelSemanticProfile[] = [
  {
    modelId: "qwen2.5-coder-32b",
    role: "coding_worker",
    domains: ["software engineering"],
    taskTypes: ["implementation", "code analysis", "debugging", "code review"],
    languages: ["en", "zh"],
    description:
      "Code-specialised model from the Qwen family, documented for code generation, code " +
      "reasoning and code repair across programming languages.",
    provenance: {
      origin: "manual",
      evidenceStatus: "provider_documented",
      source:
        "Qwen2.5-Coder published model documentation (Alibaba). Withdrawn from the gateway " +
        "catalogue between 2026-08-01 and 2026-08-15; kept so decisions recorded while it was " +
        "available can still be explained.",
      verifiedAt: "2026-08-01",
      reviewed: false,
    },
  },
];

const OBSOLETE_BY_ID = new Map(OBSOLETE.map((p) => [p.modelId, p]));

/**
 * A fingerprint over what a profile *says*, for linking a stored decision back.
 *
 * Over the rendered text rather than the object: two profiles that render the
 * same describe the same thing, and a decision recorded against one can be read
 * against the other. Deliberately excludes provenance — a profile whose source
 * note was reworded is still the same claim.
 */
export function profileFingerprint(profile: ModelSemanticProfile): string {
  return semanticFingerprint(`${profile.role}\n${renderSemanticText(profile)}`);
}

/**
 * The profile a past decision was made against, live or withdrawn.
 *
 * The only reader that looks at `OBSOLETE`. A caller explaining history passes
 * the fingerprint the decision recorded; a mismatch means the profile has
 * changed since, and saying so is better than presenting today's description as
 * the reason for yesterday's choice.
 */
export function historicalProfileFor(
  modelId: string,
  fingerprint?: string,
): { profile: ModelSemanticProfile; obsolete: boolean; fingerprintMatches: boolean | null } | null {
  const live = BY_ID.get(modelId);
  const gone = OBSOLETE_BY_ID.get(modelId);
  const profile = live ?? gone;
  if (profile === undefined) return null;
  return {
    profile,
    obsolete: live === undefined,
    fingerprintMatches: fingerprint === undefined ? null : profileFingerprint(profile) === fingerprint,
  };
}

/** How a model stands relative to the live catalogue. */
export type SemanticProfileStatus =
  /** Curated and signed off. */
  | "reviewed"
  /** Curated, not signed off. */
  | "unreviewed"
  /** Live, and nobody has written it up. */
  | "cold_start"
  /** Curated, and no longer offered by the gateway. */
  | "obsolete";

export interface SemanticLookup {
  status: Exclude<SemanticProfileStatus, "obsolete">;
  profile: ModelSemanticProfile | null;
}

const BY_ID = new Map(CURATED.map((p) => [p.modelId, p]));

/**
 * The semantic profile for a model, or an honest absence.
 *
 * Nothing is invented for an unknown id — no domains read off it, no defaults
 * borrowed from a similar-sounding model. It stays a candidate, as an
 * unevaluated model does.
 */
export function semanticProfileFor(modelId: string): SemanticLookup {
  const profile = BY_ID.get(modelId);
  if (profile === undefined) return { status: "cold_start", profile: null };
  return { status: profile.provenance.reviewed ? "reviewed" : "unreviewed", profile };
}

/** Every curated entry, for validation and for reporting coverage. */
export function curatedProfiles(): readonly ModelSemanticProfile[] {
  return CURATED;
}

/**
 * What a profile is allowed to do to routing, for a given pool.
 *
 * Three answers rather than a boolean, and the middle one is the reason this
 * function exists: an assertion is recorded, is visible in the reasons, and
 * removes nothing.
 */
export function poolEffectFor(
  modelId: string,
  pool: WorkerPool = DEFAULT_POOL,
): { effect: RoutingEffect; excluded: boolean; reason: string | null; evidence: EvidenceStatus } {
  const profile = BY_ID.get(modelId);
  if (profile === undefined) {
    return { effect: "shadow_only", excluded: false, reason: null, evidence: "unknown" };
  }

  const evidence = profile.provenance.evidenceStatus;
  const effect = routingEffectFor(evidence);

  // Two ways to be out of a pool: the role is not a worker at all, or the
  // profile names this pool explicitly. Both need evidence strong enough to
  // exclude; otherwise the claim is recorded and the model stays.
  const scoped = profile.ineligibleFor?.find((e) => e.pool === pool) ?? null;
  const notAWorker = roleIsWorker(profile.role) === false;
  const claim = scoped?.reason ?? (notAWorker ? `Role is ${profile.role}, which is not a worker.` : null);
  if (claim === null) return { effect, excluded: false, reason: null, evidence };

  return { effect, excluded: effect === "hard_exclude", reason: claim, evidence };
}

/**
 * Coverage against the models the gateway is offering *now*.
 *
 * Takes the live ids rather than reading a file, because the file has been the
 * problem: a coverage claim computed from a stale snapshot reported complete
 * coverage of a catalogue that had changed underneath it.
 */
export function coverageOf(
  liveModelIds: readonly string[],
  pool: WorkerPool = DEFAULT_POOL,
): CoverageTable {
  const reviewed: string[] = [];
  const unreviewed: string[] = [];
  const coldStart: string[] = [];
  const ineligible: string[] = [];

  for (const id of liveModelIds) {
    if (poolEffectFor(id, pool).excluded) {
      ineligible.push(id);
      continue;
    }
    const found = BY_ID.get(id);
    if (found === undefined) coldStart.push(id);
    else if (found.provenance.reviewed) reviewed.push(id);
    else unreviewed.push(id);
  }

  const live = new Set(liveModelIds);
  const obsolete = [...BY_ID.keys()].filter((id) => !live.has(id));
  return {
    total: liveModelIds.length,
    reviewed,
    unreviewed,
    coldStart,
    ineligible,
    obsolete,
    complete: coldStart.length === 0,
  };
}

/** One coverage claim, with the population it was computed over. */
export interface CoverageTable {
  /** The denominator. A coverage figure without one says nothing. */
  total: number;
  reviewed: string[];
  unreviewed: string[];
  coldStart: string[];
  /** Excluded from *this* pool, so not part of what needs curating for it. */
  ineligible: string[];
  /** Curated but no longer offered. Never counted as coverage. */
  obsolete: string[];
  complete: boolean;
}

/**
 * Which population a coverage figure is about.
 *
 * Four denominators rather than one, because mixing them produces a number that
 * cannot be acted on. An embedding endpoint is not missing from the coding
 * pool's curation — it is not in that population at all, and counting it as an
 * uncurated candidate would report work that does not exist while hiding work
 * that does.
 */
export interface CoverageReport {
  /** Everything the gateway lists. */
  liveCatalog: CoverageTable;
  /** Of those, the ones that answer the chat endpoint. */
  chatCapable: CoverageTable;
  /** Of those, the ones eligible for the coding pool. */
  codingPool: CoverageTable;
  /** Models that serve the embeddings endpoint. A separate population. */
  embedding: CoverageTable;
}

export interface CatalogPopulations {
  liveCatalog: readonly string[];
  chatCapable: readonly string[];
  embedding: readonly string[];
}

/**
 * Coverage against each population separately.
 *
 * The populations are supplied rather than derived, because deciding which
 * models answer chat is an observation the caller makes against the gateway and
 * this module has no way to check.
 */
export function coverageReport(populations: CatalogPopulations): CoverageReport {
  const codingCandidates = populations.chatCapable.filter(
    (id) => !poolEffectFor(id, "coding").excluded,
  );
  return {
    liveCatalog: coverageOf(populations.liveCatalog, "coding"),
    chatCapable: coverageOf(populations.chatCapable, "coding"),
    codingPool: coverageOf(codingCandidates, "coding"),
    embedding: coverageOf(populations.embedding, "coding"),
  };
}

/** Runs the validator over the whole table. Used by a test, not on import. */
export function validateProfiles(): Array<{ modelId: string; problem: string }> {
  const problems: Array<{ modelId: string; problem: string }> = [];
  for (const profile of CURATED) {
    const problem = validateModelSemanticProfile(profile);
    if (problem !== null) {
      problems.push({ modelId: profile.modelId, problem: `${problem.code}: ${problem.detail}` });
    }
  }
  return problems;
}
