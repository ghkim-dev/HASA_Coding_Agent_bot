import type { ModelProfile } from "./modelProfile.ts";
import type { TaskProfile } from "./taskProfile.ts";
import type { ModelRecommendation } from "./recommend.ts";
import { embeddingRefusedBy, EmbeddingError } from "./hasaEmbedding.ts";
import { renderSemanticText, type TaskSemanticProfile } from "./semanticProfile.ts";
import { semanticProfileFor } from "./modelSemanticCatalog.ts";
import type { EmbeddingCache, SemanticScore } from "./embedding.ts";

/**
 * Measuring the semantic term without letting it decide anything.
 *
 * The alternative that was rejected: set `semantic` to a weight of 0 in the
 * router policy and let the term run through the normal path. That would have
 * changed what `requirement-router-v1` means — a stored decision naming that
 * policy would no longer describe the weights that produced it — and it would
 * leave the semantic score one edit away from mattering, with nothing
 * structural in the way.
 *
 * So the shadow runs *beside* the recommendation instead of inside it. The
 * production ranking is computed exactly as before, from the same policy, and
 * this observes the same candidates separately. There is no code path by which
 * a number produced here reaches a score, and that is a property of the shapes
 * rather than of a weight that happens to be zero.
 *
 * ## Fail-open, and loudly
 *
 * Every failure — a deadline, a 500, a vector of the wrong length, a
 * constraint that forbids the call — produces an observation that says what
 * went wrong and changes nothing else. A shadow measurement that could break a
 * turn would be worse than no measurement: it would add a failure mode to the
 * product in exchange for a number nobody is acting on yet.
 */

export type ShadowStatus =
  | "measured"
  /** The task forbids calling an external service. Nothing was sent. */
  | "refused_by_constraint"
  /** Nothing to compare: no curated profile for any candidate. */
  | "no_profiles"
  /** The provider failed. The reason is recorded. */
  | "provider_failed"
  /** No provider is configured. */
  | "unavailable";

export interface ShadowCandidate {
  modelId: string;
  /** As the metric produced it. Null when no comparison happened. */
  rawCosine: number | null;
  normalized: number;
  /** `curated` | `unreviewed` | `cold_start`. */
  profileStatus: string;
  /** Position under the shadow score alone. 1 is best. */
  shadowRank: number;
  /** Position under the production ranking, for comparison. */
  productionRank: number;
}

export interface SemanticShadowEvaluation {
  status: ShadowStatus;
  /** Which vector space, without the vectors. */
  embeddingSpace: {
    provider: string;
    modelId: string;
    dimension: number | null;
  } | null;
  candidates: ShadowCandidate[];
  /** The model the shadow would have picked. Never acted on. */
  shadowSelectedModelId: string | null;
  /** Whether the mapping from raw to normalized has been fitted. */
  calibrated: boolean;
  /** Which mapping was used. */
  method: string | null;
  /** Machine-readable, set whenever `status` is not `measured`. */
  failure?: string;
  detail?: string;
  /** Embedding calls this observation spent. */
  embeddingCalls: number;
}

export interface ShadowInput {
  task: TaskProfile;
  taskSemantic: TaskSemanticProfile;
  /** The candidates the production ranking actually considered. */
  recommendation: ModelRecommendation;
  profiles: readonly ModelProfile[];
  matcher: {
    explain(task: TaskProfile, model: ModelProfile): Promise<SemanticScore>;
    readonly cache: EmbeddingCache;
  } | null;
  signal?: AbortSignal;
}

function unavailable(status: ShadowStatus, failure: string, detail: string): SemanticShadowEvaluation {
  return {
    status,
    embeddingSpace: null,
    candidates: [],
    shadowSelectedModelId: null,
    calibrated: false,
    method: null,
    failure,
    detail,
    embeddingCalls: 0,
  };
}

/**
 * Runs the shadow measurement over the candidates production already ranked.
 *
 * Takes the recommendation rather than recomputing one: the point is to observe
 * *these* candidates, in the order production put them, so the two rankings can
 * be compared. Recomputing would risk observing a different candidate set than
 * the one that ran.
 */
export async function evaluateShadow(input: ShadowInput): Promise<SemanticShadowEvaluation> {
  if (input.matcher === null) {
    return unavailable("unavailable", "NO_PROVIDER", "임베딩 제공자가 설정되지 않았습니다.");
  }

  // Before anything is sent. A user who said the work stays local has said
  // something about their data, and an observability call is not an exception.
  const refusal = embeddingRefusedBy(input.task);
  if (refusal !== null) {
    return unavailable(
      "refused_by_constraint",
      refusal,
      "이 요청의 제약 때문에 외부 임베딩을 호출하지 않았습니다.",
    );
  }

  const ranked = [
    ...(input.recommendation.selected === null ? [] : [input.recommendation.selected]),
    ...input.recommendation.alternatives,
  ];
  if (ranked.length === 0) {
    return unavailable("no_profiles", "NO_CANDIDATES", "순위에 오른 후보가 없습니다.");
  }

  const byId = new Map(input.profiles.map((p) => [p.modelId, p]));
  const before = input.matcher.cache.calls;
  const measured: Array<{ modelId: string; score: SemanticScore; productionRank: number; status: string }> = [];

  for (const [index, candidate] of ranked.entries()) {
    const profile = byId.get(candidate.modelId);
    if (profile === undefined) continue;
    try {
      const score = await input.matcher.explain(input.task, profile);
      measured.push({
        modelId: candidate.modelId,
        score,
        productionRank: index + 1,
        status: semanticProfileFor(candidate.modelId).status,
      });
    } catch (err) {
      // One candidate failing does not end the observation, but a provider
      // that is down will fail every one — reported once, with its reason.
      const failure = err instanceof EmbeddingError ? err.failure : "NETWORK_ERROR";
      return {
        ...unavailable("provider_failed", failure, (err as Error).message.slice(0, 200)),
        embeddingCalls: input.matcher.cache.calls - before,
        embeddingSpace: spaceOf(input.matcher.cache),
      };
    }
  }

  if (measured.length === 0) {
    return unavailable("no_profiles", "NO_PROFILES", "후보 중 프로필이 있는 모델이 없습니다.");
  }

  const byShadow = [...measured].sort(
    (a, b) => b.score.normalized - a.score.normalized || a.modelId.localeCompare(b.modelId),
  );
  const shadowRankOf = new Map(byShadow.map((m, i) => [m.modelId, i + 1]));

  return {
    status: "measured",
    embeddingSpace: spaceOf(input.matcher.cache),
    candidates: measured.map((m) => ({
      modelId: m.modelId,
      rawCosine: m.score.raw,
      normalized: m.score.normalized,
      profileStatus: m.status,
      shadowRank: shadowRankOf.get(m.modelId) ?? 0,
      productionRank: m.productionRank,
    })),
    shadowSelectedModelId: byShadow[0]?.modelId ?? null,
    calibrated: measured.every((m) => m.score.calibrated),
    method: measured[0]?.score.method ?? null,
    embeddingCalls: input.matcher.cache.calls - before,
  };
}

/** The space, without the vectors. §"vector 전체를 저장하지 않는다". */
function spaceOf(cache: EmbeddingCache): SemanticShadowEvaluation["embeddingSpace"] {
  const space = cache.space;
  return { provider: space.provider, modelId: space.modelId, dimension: space.dimension };
}

/**
 * Whether a shadow observation agreed with production.
 *
 * Reported, never acted on. The value of the shadow is precisely that it can
 * disagree and nothing happens — a disagreement is the signal that calibration
 * is worth doing, and a shadow that always agreed would be telling us nothing.
 */
export function shadowAgrees(evaluation: SemanticShadowEvaluation): boolean | null {
  if (evaluation.status !== "measured" || evaluation.shadowSelectedModelId === null) return null;
  const productionFirst = evaluation.candidates.find((c) => c.productionRank === 1);
  return productionFirst?.modelId === evaluation.shadowSelectedModelId;
}
