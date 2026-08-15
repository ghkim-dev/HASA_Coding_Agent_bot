import { renderSemanticText, semanticFingerprint, type ModelSemanticProfile, type TaskSemanticProfile } from "./semanticProfile.ts";
import type { ModelProfile } from "./modelProfile.ts";
import type { TaskProfile } from "./taskProfile.ts";
import type { SemanticMatcher } from "./recommend.ts";
import { semanticProfileFor } from "./modelSemanticCatalog.ts";

/**
 * Turning two descriptions into one number.
 *
 * ## No vector database
 *
 * The gateway offers four models this key can converse with. Even at thirty,
 * one turn costs one task embedding and thirty cosine products over vectors
 * that are already in memory — microseconds. An index exists to avoid scanning
 * everything, and here scanning everything is the cheap part. Adding FAISS or
 * Chroma would add a dependency, a process and a persistence story to save an
 * amount of work that does not exist.
 *
 * What does need care is not the search, it is the *calls*: a model embedding
 * recomputed every turn is a network round trip per model per message, which
 * is the real cost and the reason `EmbeddingCache` exists.
 *
 * ## One number among four
 *
 * Nothing here decides anything. `recommendModel` weighs this against
 * capability, evaluation and efficiency, and the filter has already removed
 * whatever could not be used at all. A model that describes itself perfectly
 * and cannot do the work still loses — that is checked in the ranking tests,
 * and it is the invariant this file is most able to break.
 */

/**
 * Which vector space a cached vector belongs to.
 *
 * A model id alone is not the space. The same `bge-m3` served by a different
 * backend, at a different revision, or with a different pooling configuration
 * produces vectors that are not comparable with the old ones — and mixing two
 * spaces in one cosine gives a number that looks fine and means nothing.
 *
 * `dimension` is the cheap half of that check and is observed rather than
 * declared: the first response says how long its vectors are, and a change is
 * unambiguous evidence the space moved. `configFingerprint` is for whatever
 * else a provider can report about itself.
 */
export interface EmbeddingSpaceIdentity {
  provider: string;
  modelId: string;
  /** Observed from the first response. Null until something has been embedded. */
  dimension: number | null;
  configFingerprint?: string;
}

export function spaceKey(identity: EmbeddingSpaceIdentity): string {
  return [
    identity.provider,
    identity.modelId,
    identity.dimension ?? "d?",
    identity.configFingerprint ?? "",
  ].join("|");
}

/** Replaceable: a fake in tests, the gateway's embedding endpoint in production. */
export interface EmbeddingProvider {
  /** A stable identifier for the model producing vectors. Part of cache keys. */
  readonly embeddingModelId: string;
  /** Who serves it. Two backends for one model id are two spaces. */
  readonly providerId?: string;
  /** Anything else that changes the space — revision, pooling, normalisation. */
  readonly configFingerprint?: string;
  /** One vector per input, in the same order. */
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
}

/**
 * Cosine similarity, as the metric produces it.
 *
 * Returns null when there is nothing to compare — an empty or mismatched pair —
 * rather than a number, because "no comparison was possible" and "the
 * comparison came out in the middle" are different facts and a single float
 * cannot carry both.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return null;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * What a similarity was, and what it was turned into.
 *
 * Two numbers because they are two claims, and only one of them is measured.
 * `raw` is what the metric said. `normalized` is what goes into the weighted
 * sum, and it is **provisional**: the mapping below is a monotone transform
 * chosen so a similarity cannot subtract from a score whose other three terms
 * only add, and it is not a calibration.
 *
 * That distinction is not theoretical. Asked for vectors for "한국어 문서 요약"
 * and "python debugging" — two texts with nothing in common — `bge-m3` returned
 * a cosine of **0.41**, not 0. Dense embedding models have a high similarity
 * floor, so the intuition that orthogonal means unrelated and 0.5 means neutral
 * is simply false for this metric. A `normalized` value only means something
 * relative to other pairs from the same model, and `calibrated: false` says so
 * until a measured positive/negative set exists — see `calibration.ts`.
 */
export interface SemanticScore {
  /** As the metric produced it. Null when no comparison was possible. */
  raw: number | null;
  /** Fed to the ranking. Provisional while `calibrated` is false. */
  normalized: number;
  /** How `raw` became `normalized`, so a calibration can replace it by name. */
  method: string;
  /** False until the mapping has been fitted to measured pairs. */
  calibrated: boolean;
}

/** The neutral every term uses for "nothing is known". */
export const NEUTRAL = 0.5;

/**
 * The provisional mapping.
 *
 * Monotone and bounded, which is all it claims to be. Named so that a
 * calibrated replacement is a different `method` string in the record rather
 * than a silent change of meaning in the same field.
 */
export const PROVISIONAL_METHOD = "affine-uncalibrated-v1";

export function normalizeSimilarity(raw: number | null): SemanticScore {
  if (raw === null) {
    return { raw: null, normalized: NEUTRAL, method: "no-comparison", calibrated: false };
  }
  return {
    raw,
    normalized: Math.max(0, Math.min(1, (raw + 1) / 2)),
    method: PROVISIONAL_METHOD,
    calibrated: false,
  };
}

/**
 * Vectors already computed, keyed by what was embedded.
 *
 * Keyed by the fingerprint of the *rendered text* and the embedding model, not
 * by the model id. Two things follow that are both wanted: a profile that was
 * edited gets a new key and cannot reuse a stale vector, and changing the
 * embedding model invalidates everything at once rather than mixing vectors
 * from two spaces in one comparison.
 */
export class EmbeddingCache {
  private readonly vectors = new Map<string, number[]>();
  private embedCalls = 0;
  /**
   * Observed on the first response, then held to.
   *
   * A later response of a different length means the space changed underneath
   * us — a redeployed backend, a config change — and the cache is dropped
   * rather than allowed to serve vectors from the old space alongside the new.
   */
  private dimension: number | null = null;
  // Written out rather than a parameter property: this project strips types
  // rather than compiling them, so a constructor that declares a field is
  // syntax there is nothing left of once the types are gone.
  private readonly provider: EmbeddingProvider;

  constructor(provider: EmbeddingProvider) {
    this.provider = provider;
  }

  /** How many texts have actually been sent. For cost tests and reporting. */
  get calls(): number {
    return this.embedCalls;
  }

  /** The space these vectors live in, as far as it is known so far. */
  get space(): EmbeddingSpaceIdentity {
    return {
      provider: this.provider.providerId ?? "default",
      modelId: this.provider.embeddingModelId,
      dimension: this.dimension,
      ...(this.provider.configFingerprint === undefined
        ? {}
        : { configFingerprint: this.provider.configFingerprint }),
    };
  }

  private keyFor(text: string): string {
    return `${spaceKey(this.space)}:${semanticFingerprint(text)}`;
  }

  /**
   * Embeds what is missing and returns everything, in order.
   *
   * Batched: the misses go out in one call rather than one call each, which for
   * a first turn against four models is one request instead of four.
   */
  async embedAll(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const missing: string[] = [];
    for (const text of texts) {
      const key = this.keyFor(text);
      if (!this.vectors.has(key) && !missing.includes(text)) missing.push(text);
    }
    if (missing.length > 0) {
      const fresh = await this.provider.embed(missing, signal);
      this.embedCalls += missing.length;

      const observed = fresh.find((v) => v.length > 0)?.length ?? null;
      if (observed !== null && this.dimension !== null && observed !== this.dimension) {
        // Correctness here is the *key*, not this line: the dimension is part
        // of `spaceKey`, so vectors from the old space can no longer be looked
        // up once it changes. Dropping them reclaims the memory they would
        // otherwise hold for the life of the process. Said plainly because a
        // mutation test found this line to be unreachable as a safety measure
        // — two mechanisms were covering for each other and neither was
        // visible on its own.
        this.vectors.clear();
      }
      if (observed !== null) this.dimension = observed;

      for (const [i, text] of missing.entries()) {
        const vector = fresh[i];
        if (vector !== undefined) this.vectors.set(this.keyFor(text), vector);
      }
    }
    return texts.map((text) => this.vectors.get(this.keyFor(text)) ?? []);
  }

  /** Drops everything. For a test, or for a curation change at runtime. */
  clear(): void {
    this.vectors.clear();
  }
}

// ---------------------------------------------------------------------------
// The matcher
// ---------------------------------------------------------------------------

export interface EmbeddingMatcherOptions {
  provider: EmbeddingProvider;
  cache?: EmbeddingCache;
  /** Supplies the curated profile for a model. Injected so tests can vary it. */
  lookup?: (modelId: string) => ModelSemanticProfile | null;
  /** Renders the task's semantic half. Injected for the same reason. */
  taskSemantic: (task: TaskProfile) => TaskSemanticProfile;
}

/** Neutral, and the same neutral the other terms use for "nothing is known". */
export const COLD_START_SCORE = NEUTRAL;

/**
 * A `SemanticMatcher` backed by real embeddings.
 *
 * The cold-start branch is the important one. A model nobody has curated
 * returns the neutral score without an embedding call — it is not scored badly
 * for the absence, and no vector is spent finding that out. That keeps partial
 * curation from quietly ranking uncurated models last, which is the bias the
 * curation slice was meant to avoid rather than introduce.
 */
export function embeddingMatcher(options: EmbeddingMatcherOptions): SemanticMatcher & {
  readonly cache: EmbeddingCache;
  explain(task: TaskProfile, model: ModelProfile): Promise<SemanticScore>;
} {
  const cache = options.cache ?? new EmbeddingCache(options.provider);
  const lookup = options.lookup ?? ((id: string) => semanticProfileFor(id).profile);

  const explain = async (task: TaskProfile, model: ModelProfile): Promise<SemanticScore> => {
    const semantic = lookup(model.modelId);
    if (semantic === null) {
      return { raw: null, normalized: COLD_START_SCORE, method: "cold-start", calibrated: false };
    }

    const taskText = renderSemanticText(options.taskSemantic(task));
    const modelText = renderSemanticText(semantic);
    if (taskText.trim().length === 0 || modelText.trim().length === 0) {
      return { raw: null, normalized: COLD_START_SCORE, method: "no-text", calibrated: false };
    }

    const [taskVector, modelVector] = await cache.embedAll([taskText, modelText]);
    const score = normalizeSimilarity(cosineSimilarity(taskVector ?? [], modelVector ?? []));
    // An unreviewed profile is used — it beats no profile — but it does not get
    // to be silent about it. The method carries the fact, so a recorded score
    // says which of the two it was rather than looking the same either way.
    return semantic.provenance.reviewed
      ? score
      : { ...score, method: `${score.method}+unreviewed-profile` };
  };

  return {
    cache,
    explain,
    async score(task: TaskProfile, model: ModelProfile): Promise<number> {
      return (await explain(task, model)).normalized;
    },
  };
}
