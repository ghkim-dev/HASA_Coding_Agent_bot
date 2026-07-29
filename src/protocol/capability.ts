import { z } from "zod";

/**
 * Capability probe vocabulary.
 *
 * Every entry here maps to exactly one real HTTP request (or a small bounded
 * sequence of them) against the HASA API. Nothing in this file is derived from
 * documentation — a capability is only ever `pass` because a live request
 * proved it.
 */
export const CAPABILITY_NAMES = [
  "chat",
  "stream",
  "tools",
  "tools_multi",
  "tools_roundtrip",
  "tools_stream",
  "json_object",
  "json_schema",
  "reasoning_content",
  "vision",
  "seed",
  "long_context",
  "max_output",
  "latency",
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

/**
 * `denied` is deliberately distinct from `fail`: a 403 tells us the key lacks
 * permission, which says nothing about whether the model has the capability.
 * Collapsing the two would permanently mislabel models after a key upgrade.
 */
export const CapabilityStatusSchema = z.enum([
  "pass",
  "fail",
  "denied",
  "unknown",
  "skipped",
]);
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

export const CapabilityResultSchema = z.object({
  status: CapabilityStatusSchema,
  /** Short, redacted justification. Never a full prompt or response body. */
  evidence: z.string().max(300).optional(),
  httpStatus: z.number().int().optional(),
  errorCode: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type CapabilityResult = z.infer<typeof CapabilityResultSchema>;

export const ModelLimitsSchema = z.object({
  observedContextWindow: z.number().int().positive().nullable(),
  observedMaxOutputTokens: z.number().int().positive().nullable(),
  latencyMs: z
    .object({ p50: z.number().nonnegative(), p95: z.number().nonnegative() })
    .nullable(),
});
export type ModelLimits = z.infer<typeof ModelLimitsSchema>;

/**
 * Derived, never hand-edited. See docs/compatibility-matrix.md §5.
 */
export const EligibilitySchema = z.object({
  responseCompare: z.boolean(),
  codingAgent: z.boolean(),
  patchMode: z.boolean(),
  judge: z.boolean(),
  reasons: z.array(z.string()),
});
export type Eligibility = z.infer<typeof EligibilitySchema>;

export const ModelReportSchema = z.object({
  modelId: z.string().min(1),
  capabilities: z.record(z.enum(CAPABILITY_NAMES), CapabilityResultSchema),
  limits: ModelLimitsSchema,
  eligibility: EligibilitySchema,
});
export type ModelReport = z.infer<typeof ModelReportSchema>;

export const CAPABILITY_MATRIX_SCHEMA_VERSION = 1;

/**
 * Bumped whenever probe logic changes in a way that invalidates stored results.
 * A run refuses to start against a matrix produced by an older probe.
 */
export const PROBE_VERSION = "probe-v1";

export const CapabilityMatrixSchema = z.object({
  schemaVersion: z.literal(CAPABILITY_MATRIX_SCHEMA_VERSION),
  probeVersion: z.string(),
  probedAt: z.string(),
  baseUrl: z.string(),
  /** sha256 prefix of the API key — identifies which key produced these
   *  permissions without storing the key itself. */
  keyFingerprint: z.string(),
  models: z.array(ModelReportSchema),
});
export type CapabilityMatrix = z.infer<typeof CapabilityMatrixSchema>;

/** Shape of `GET /v1/models` (OpenAI-compatible). */
export const ModelsResponseSchema = z.object({
  object: z.string().optional(),
  data: z.array(
    z.object({
      id: z.string().min(1),
      object: z.string().optional(),
      owned_by: z.string().optional(),
      created: z.number().optional(),
    }),
  ),
});
export type ModelsResponse = z.infer<typeof ModelsResponseSchema>;
