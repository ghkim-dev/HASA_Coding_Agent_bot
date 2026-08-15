import { NEUTRAL, type SemanticScore } from "./embedding.ts";

/**
 * Turning raw similarities into a score that means something.
 *
 * The provisional mapping in `embedding.ts` is `(cos + 1) / 2`, which is
 * monotone, bounded, and arbitrary. It carries an assumption that measurement
 * shows to be false for the model this project would actually use: asked for
 * vectors for "한국어 문서 요약" and "python debugging" — two texts with nothing
 * in common — `bge-m3` returned a cosine of **0.41**. Under the provisional
 * mapping that is a semantic score of 0.70, well above the 0.5 that is supposed
 * to mean "no reason to prefer this".
 *
 * Dense embedding models have a high similarity floor. There is no universal
 * scale on which 0.72 is a good match and 0.20 is a bad one — the numbers only
 * mean something relative to other pairs from the same model. So a calibration
 * has to be *measured*, from pairs whose answer is known, and this file is the
 * shape of that measurement rather than the measurement itself.
 *
 * Nothing here runs in the router yet. It exists so that fitting a mapping is a
 * matter of supplying pairs, not of rewriting the scoring path.
 */

/**
 * One pair whose answer is known by construction.
 *
 * `related` is the claim being calibrated against — that this task and this
 * model are, or are not, about the same kind of work. It comes from whoever
 * built the set, and is the only labelled thing in the router.
 */
export interface CalibrationPair {
  taskText: string;
  modelText: string;
  related: boolean;
  /** Why this pair is labelled as it is, so the set can be argued with. */
  note?: string;
}

export interface CalibrationSample extends CalibrationPair {
  /** The raw cosine measured for this pair. */
  raw: number;
}

export interface Calibration {
  /** Named so a stored score can say which mapping produced it. */
  method: string;
  /** Mean raw similarity of pairs labelled unrelated. Maps to `NEUTRAL`. */
  floor: number;
  /** Mean raw similarity of pairs labelled related. Maps to 1. */
  ceiling: number;
  samples: { related: number; unrelated: number };
}

/**
 * Fits the two anchors from measured pairs.
 *
 * Deliberately the simplest thing that could work: the unrelated mean becomes
 * the neutral point and the related mean becomes the top. No distribution is
 * assumed, nothing is regressed, and the result is reported with its sample
 * counts so a fit from four pairs is visibly not a fit from four hundred.
 *
 * Returns null rather than a shape when either side is empty. A calibration
 * with no negative examples has no floor to place, and inventing one would put
 * the same confident-looking number back that this file exists to remove.
 */
export function fitCalibration(samples: readonly CalibrationSample[]): Calibration | null {
  const related = samples.filter((s) => s.related).map((s) => s.raw);
  const unrelated = samples.filter((s) => !s.related).map((s) => s.raw);
  if (related.length === 0 || unrelated.length === 0) return null;

  const mean = (values: readonly number[]): number =>
    values.reduce((total, v) => total + v, 0) / values.length;

  const floor = mean(unrelated);
  const ceiling = mean(related);
  // A set where the unrelated pairs score at least as high as the related ones
  // has not measured a usable separation, and a mapping fitted to it would
  // invert or divide by nothing.
  if (ceiling <= floor) return null;

  return {
    method: `measured-v1(n=${samples.length})`,
    floor,
    ceiling,
    samples: { related: related.length, unrelated: unrelated.length },
  };
}

/**
 * Applies a fitted calibration.
 *
 * A pair at the measured floor scores `NEUTRAL` — no reason to prefer it — and
 * one at the measured ceiling scores 1. Below the floor is clamped rather than
 * allowed to go negative, for the same reason the provisional mapping is
 * bounded: one term that can subtract outweighs three that only add.
 */
export function applyCalibration(raw: number | null, calibration: Calibration): SemanticScore {
  if (raw === null) {
    return { raw: null, normalized: NEUTRAL, method: "no-comparison", calibrated: false };
  }
  const span = calibration.ceiling - calibration.floor;
  const above = (raw - calibration.floor) / span;
  return {
    raw,
    normalized: Math.max(0, Math.min(1, NEUTRAL + above * (1 - NEUTRAL))),
    method: calibration.method,
    calibrated: true,
  };
}
