import type { Modality } from "../provider/hasa/hasaCatalog.ts";
import { poolEffectFor } from "./modelSemanticCatalog.ts";
import { DEFAULT_POOL, type WorkerPool } from "./semanticProfile.ts";

/**
 * Whether a model belongs in a worker pool, decided the same way for every
 * model.
 *
 * The defect this replaces: pool membership was decided *only* by the curated
 * catalogue. A model nobody had written up was not excluded, because there was
 * no profile to exclude it — so curation was not describing eligibility, it was
 * granting it by omission.
 *
 *     paddleocr-vl        vision   curated ocr_worker      excluded
 *     qwen2.5-vl-72b      vision   curated vision_worker   excluded
 *     nemotron-omni-30b   vision   no profile              admitted
 *
 * Three models, one modality, opposite outcomes, and the thing that differed
 * was how much someone had written down. The same rule now runs first, from
 * what was *measured* — the catalogue's modality, the gateway's answer — and
 * curation refines it afterwards.
 *
 * `nemotron-safety-4b` failed the same way from the other side: it *is*
 * curated, as a `safety_classifier`, and the exclusion did not apply because
 * the evidence behind the profile was not strong enough to reach
 * `hard_exclude`. Evidence strength is the right control for a *claim about a
 * model*; it is the wrong control for "this endpoint is a classifier", which
 * the catalogue states outright.
 *
 * ## Three answers, not two
 *
 * `unknown` is a real answer and is kept separate from `excluded`. They differ
 * in what to do next — an unknown model wants measuring, an excluded one does
 * not — and collapsing them is what let an unmeasured model read as permitted.
 *
 *     eligible    measured, and the measurement says yes
 *     excluded    measured, and the measurement says no
 *     unknown     nobody has established either
 *
 * Only `eligible` enters a pool. `unknown` stays out without any claim being
 * made about it.
 *
 * ## Curation may narrow, never widen
 *
 * A curated profile can move `unknown` or `eligible` to `excluded`. It cannot
 * move anything to `eligible`, because that is the direction the defect ran in.
 * What promotes is measurement.
 */

export type PoolStanding = "eligible" | "excluded" | "unknown";

/** What settled the question. Recorded so a standing can be argued with. */
export type StandingBasis =
  /** The gateway was called and answered. Outranks everything else. */
  | "invocation"
  /** The catalogue publishes a modality with its own endpoint semantics. */
  | "modality"
  /** A curated profile narrowed a standing the rules above allowed. */
  | "curation"
  /** Nothing has been established. */
  | "absent";

export interface PoolEligibility {
  standing: PoolStanding;
  basis: StandingBasis;
  /** One line, safe to print, naming what decided it. */
  reason: string;
}

/**
 * Modalities served by an endpoint that is not chat.
 *
 * A model here is not a bad assistant; it is not an assistant. Scoring it on
 * requirement recall measures the harness asking the wrong question — which is
 * what a sweep did to four image and video models before this existed.
 */
const DEDICATED: ReadonlySet<Modality> = new Set<Modality>([
  "image",
  "video",
  "audio",
  "embeddings",
  "rerank",
  "safety",
]);

/**
 * Why `vision` is unknown rather than excluded.
 *
 * The catalogue's `vision` covers two different things: a model that reads
 * images and does nothing else, and a conversational model that also reads
 * images and can perfectly well write code. Excluding on the modality alone
 * would throw away the second kind, and admitting on it would re-admit the
 * first. So the modality settles nothing here and something else has to.
 */
const NEEDS_MORE: ReadonlySet<Modality> = new Set<Modality>(["vision", "unknown"]);

export interface EligibilityInput {
  /** Used only as a lookup key for curation. Never parsed for meaning. */
  modelId: string;
  /** What the catalogue publishes. Null when the model is not listed. */
  modality: Modality | null;
  /**
   * What an invocation established, when one has been made.
   *
   * `false` means the endpoint answered that it does not serve chat. It
   * outranks the catalogue: the catalogue is a description and this is the
   * thing itself.
   */
  converses?: boolean | null;
  /**
   * Whether this credential may call it at all.
   *
   * A separate question from whether the model converses, and the T1 probe
   * found twelve models where the answer differs: the gateway returns 403, so
   * nothing is known about the model and everything is known about our access
   * to it. Both keep it out of a pool and they are not the same fact — one is
   * about the model, the other about the key, and only the second changes when
   * somebody is granted more.
   */
  permitted?: boolean | null;
  pool?: WorkerPool;
}

export function poolEligibility(input: EligibilityInput): PoolEligibility {
  const pool = input.pool ?? DEFAULT_POOL;

  // Measurement first, in both directions.
  if (input.converses === false) {
    return {
      standing: "excluded",
      basis: "invocation",
      reason: "이 모델은 chat 엔드포인트에 응답하지 않는 것으로 확인됐습니다.",
    };
  }
  if (input.permitted === false) {
    return {
      standing: "excluded",
      basis: "invocation",
      reason:
        "이 자격 증명으로는 호출할 수 없습니다. 모델에 대한 판단이 아니라 접근 권한에 대한 사실입니다.",
    };
  }

  const modality = input.modality;
  let standing: PoolStanding;
  let basis: StandingBasis;
  let reason: string;

  if (modality === null) {
    standing = "unknown";
    basis = "absent";
    reason = "카탈로그에 없는 모델입니다. 확인된 것이 없습니다.";
  } else if (DEDICATED.has(modality)) {
    standing = "excluded";
    basis = "modality";
    reason = `카탈로그가 ${modality} 전용 엔드포인트로 표시합니다. 대화형 워커가 아닙니다.`;
  } else if (NEEDS_MORE.has(modality)) {
    standing = "unknown";
    basis = "modality";
    reason =
      modality === "vision"
        ? "vision 은 이미지 전용과 대화형 멀티모달을 모두 포함합니다. 모달리티만으로는 결정되지 않습니다."
        : "카탈로그가 모달리티를 밝히지 않았습니다.";
  } else {
    standing = "eligible";
    basis = "modality";
    reason = "카탈로그가 chat 엔드포인트로 표시합니다.";
  }

  // Curation refines, in one direction only. A curated profile that says this
  // is an OCR model, a classifier or a vector producer is a reason to keep it
  // out; no profile is ever a reason to let something in, which is the shape
  // the defect had.
  const curated = poolEffectFor(input.modelId, pool);
  if (curated.reason !== null && standing !== "excluded") {
    return { standing: "excluded", basis: "curation", reason: curated.reason };
  }

  return { standing, basis, reason };
}

/** The one standing that enters a pool. Everything else stays out. */
export function inPool(input: EligibilityInput): boolean {
  return poolEligibility(input).standing === "eligible";
}
