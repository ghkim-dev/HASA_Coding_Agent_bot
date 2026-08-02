import type { ModelCapabilities, ProviderModel } from "../types.ts";

/**
 * Measuring the models a key can actually reach.
 *
 * The capability probe is lazy on purpose: firing an inference request at every
 * catalogue entry when a panel opens is nineteen requests against shared GPUs
 * to populate a dropdown. But lazy with no way to ask means a picker that says
 * "확인되지 않음" beside every model forever, which reads as *you do not have
 * permission* when it means *nobody has looked yet*. That is the worse failure:
 * a user with full access being told, in effect, that they have none.
 *
 * So measurement is explicit, and it is narrow. A 403 already told us which
 * models this key may call — `allowed_models` in the body — so there is no
 * reason to spend a request discovering that the other thirteen are refused.
 */

export interface VerifyProgress {
  modelId: string;
  done: number;
  total: number;
}

export interface VerifiedModel {
  modelId: string;
  capabilities: ModelCapabilities;
  /** False when the measurement itself could not be taken. */
  measured: boolean;
}

export interface VerifyResult {
  models: VerifiedModel[];
  /** Catalogue entries deliberately not measured, and why. */
  skipped: number;
}

export interface VerifyModelsOptions {
  models: readonly ProviderModel[];
  /**
   * What the gateway said this key may call, when it has said so. Null means
   * unknown, and then the whole catalogue is a candidate.
   */
  allowedModels?: readonly string[] | null;
  measure: (modelId: string) => Promise<ModelCapabilities>;
  onProgress?: (progress: VerifyProgress) => void;
  signal?: AbortSignal;
  /** Upper bound, for a key whose allow-list is long or unknown. */
  max?: number;
}

const DEFAULT_MAX = 12;

/**
 * Decides what is worth measuring.
 *
 * The allow-list wins when there is one: everything outside it answers 403, and
 * a 403 says nothing about a model's capabilities, so the request buys nothing.
 */
export function candidatesFor(
  models: readonly ProviderModel[],
  allowedModels: readonly string[] | null | undefined,
  max = DEFAULT_MAX,
): ProviderModel[] {
  const allowed = allowedModels ?? null;
  const eligible =
    allowed === null || allowed.length === 0
      ? [...models]
      : models.filter((model) => allowed.includes(model.id));
  return eligible.slice(0, max);
}

/**
 * Measures each candidate, one at a time.
 *
 * Sequential rather than parallel: these share GPU backends, and the recorded
 * probe saw 503s at a concurrency of three. A picker that fills in over a few
 * seconds is better than one that fills in faster and half-empty.
 */
export async function verifyModels(opts: VerifyModelsOptions): Promise<VerifyResult> {
  const candidates = candidatesFor(opts.models, opts.allowedModels, opts.max);
  const results: VerifiedModel[] = [];

  for (const [index, model] of candidates.entries()) {
    if (opts.signal?.aborted === true) break;
    opts.onProgress?.({ modelId: model.id, done: index, total: candidates.length });
    try {
      results.push({ modelId: model.id, capabilities: await opts.measure(model.id), measured: true });
    } catch {
      // A model that could not be measured is not a model that failed. Recording
      // the attempt as a measurement would turn an outage into a permanent
      // verdict, which is the mistake the tristate exists to prevent.
      results.push({ modelId: model.id, capabilities: model.capabilities, measured: false });
    }
  }

  opts.onProgress?.({ modelId: "", done: results.length, total: candidates.length });
  return { models: results, skipped: opts.models.length - candidates.length };
}

/** One sentence for the user, in their language. */
export function describeVerification(result: VerifyResult): string {
  const measured = result.models.filter((m) => m.measured);
  const usable = measured.filter((m) => m.capabilities.chat === true);
  const coding = measured.filter((m) => m.capabilities.coding === true);
  const viaText = measured.filter(
    (m) => m.capabilities.chat === true && m.capabilities.toolCalling === false,
  );

  if (measured.length === 0) return "모델을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.";

  const parts = [`${usable.length}개 모델을 사용할 수 있습니다.`];
  if (coding.length > 0) parts.push(`그중 ${coding.length}개는 코드를 직접 수정할 수 있습니다.`);
  if (viaText.length > 0) {
    parts.push(`${viaText.length}개는 서버 설정상 도구 호출이 막혀 있어 호환 방식으로 동작합니다.`);
  }
  if (result.skipped > 0) parts.push(`권한이 없는 ${result.skipped}개는 확인하지 않았습니다.`);
  return parts.join(" ");
}
