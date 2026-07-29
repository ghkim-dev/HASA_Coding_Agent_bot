import {
  CAPABILITY_MATRIX_SCHEMA_VERSION,
  CapabilityMatrixSchema,
  PROBE_VERSION,
  type CapabilityMatrix,
  type CapabilityName,
  type CapabilityResult,
  type Eligibility,
  type ModelLimits,
  type ModelReport,
} from "../protocol/index.ts";

export type CapabilityMap = Partial<Record<CapabilityName, CapabilityResult>>;

function passed(caps: CapabilityMap, name: CapabilityName): boolean {
  return caps[name]?.status === "pass";
}

function anyDenied(caps: CapabilityMap): boolean {
  return Object.values(caps).some((r) => r?.status === "denied");
}

/** Minimum output budget below which a model cannot do useful code work. */
export const MIN_OUTPUT_TOKENS_FOR_CODE = 4096;

/**
 * Eligibility is computed, never authored.
 *
 * The rules mirror docs/compatibility-matrix.md §5 exactly. Keeping them in one
 * pure function is what makes "a model was excluded, why?" answerable months
 * later from a stored matrix alone.
 */
export function computeEligibility(caps: CapabilityMap, limits: ModelLimits): Eligibility {
  const reasons: string[] = [];
  const outputTokens = limits.observedMaxOutputTokens ?? 0;
  const enoughOutput = outputTokens >= MIN_OUTPUT_TOKENS_FOR_CODE;

  const responseCompare = passed(caps, "chat") && !anyDenied(caps);
  if (!passed(caps, "chat")) reasons.push("chat!=pass → 모든 모드 제외");
  else if (anyDenied(caps)) reasons.push("403 denied 존재 → responseCompare 제외");

  const codingAgent =
    passed(caps, "chat") &&
    passed(caps, "stream") &&
    passed(caps, "tools") &&
    passed(caps, "tools_roundtrip") &&
    enoughOutput;

  if (!codingAgent && passed(caps, "chat")) {
    if (!passed(caps, "stream")) reasons.push("stream!=pass → codingAgent 제외");
    if (!passed(caps, "tools")) reasons.push("tools!=pass → codingAgent 제외");
    if (passed(caps, "tools") && !passed(caps, "tools_roundtrip")) {
      reasons.push("tools_roundtrip!=pass → codingAgent 제외");
    }
    if (!enoughOutput) {
      reasons.push(`observedMaxOutputTokens=${outputTokens} < ${MIN_OUTPUT_TOKENS_FOR_CODE} → codingAgent 제외`);
    }
  }

  // patch-mode is the fallback league for models that cannot call tools; a
  // model good enough for the agent loop never competes there.
  const patchMode = passed(caps, "chat") && enoughOutput && !codingAgent;
  if (patchMode) reasons.push("tool calling 불가 → patchMode 후보로 분류");

  const judge = passed(caps, "chat") && (passed(caps, "json_object") || passed(caps, "json_schema"));
  if (!judge && passed(caps, "chat")) {
    reasons.push("structured output 미지원 → judge 제외 (파싱 재시도 정책으로도 위험)");
  }

  return { responseCompare, codingAgent, patchMode, judge, reasons };
}

export function emptyLimits(): ModelLimits {
  return { observedContextWindow: null, observedMaxOutputTokens: null, latencyMs: null };
}

export function buildModelReport(
  modelId: string,
  caps: CapabilityMap,
  limits: ModelLimits,
): ModelReport {
  return {
    modelId,
    capabilities: caps as ModelReport["capabilities"],
    limits,
    eligibility: computeEligibility(caps, limits),
  };
}

export function buildMatrix(input: {
  baseUrl: string;
  keyFingerprint: string;
  probedAt: string;
  models: ModelReport[];
}): CapabilityMatrix {
  const matrix: CapabilityMatrix = {
    schemaVersion: CAPABILITY_MATRIX_SCHEMA_VERSION,
    probeVersion: PROBE_VERSION,
    probedAt: input.probedAt,
    baseUrl: input.baseUrl,
    keyFingerprint: input.keyFingerprint,
    models: input.models,
  };
  // Parse our own output: if the writer and the reader ever disagree, the probe
  // should fail loudly rather than emit a matrix the orchestrator will reject.
  return CapabilityMatrixSchema.parse(matrix);
}

export interface MatrixStaleness {
  stale: boolean;
  reasons: string[];
}

export const MATRIX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function checkStaleness(
  matrix: CapabilityMatrix,
  opts: { now: number; keyFingerprint?: string; baseUrl?: string },
): MatrixStaleness {
  const reasons: string[] = [];
  if (matrix.probeVersion !== PROBE_VERSION) {
    reasons.push(`probeVersion ${matrix.probeVersion} != ${PROBE_VERSION} (전체 재프로빙 필요)`);
  }
  const age = opts.now - Date.parse(matrix.probedAt);
  if (Number.isFinite(age) && age > MATRIX_MAX_AGE_MS) {
    reasons.push(`probedAt이 ${Math.floor(age / 86_400_000)}일 경과`);
  }
  if (opts.keyFingerprint && matrix.keyFingerprint !== opts.keyFingerprint) {
    reasons.push("keyFingerprint 불일치 (권한이 달라졌을 수 있음)");
  }
  if (opts.baseUrl && matrix.baseUrl !== opts.baseUrl) {
    reasons.push(`baseUrl 불일치: ${matrix.baseUrl}`);
  }
  return { stale: reasons.length > 0, reasons };
}
