import type { CapabilityMatrix, CapabilityStatus } from "../protocol/capability.ts";

/**
 * Whether *this credential* may call a model — which the public catalogue does
 * not answer.
 *
 * The defect this replaces: `rankByRecall` took `provider.listModels()` and
 * passed `permitted: true` for every entry, with the comment "in the listing
 * means this credential may call it". HASA's `GET /v1/models` is a public
 * endpoint — it answers without a key at all, which the provider layer already
 * says in as many words (`hasaProvider.ts`, on `ProviderValidation`). So the
 * listing is what the gateway publishes, and permission is what this key may
 * reach; the design layer was reading the first as the second. A previous run
 * of that confusion put a burst of 403s through a provider's transaction log.
 *
 * ## Three states, and `unknown` is not a yes
 *
 *     permitted   the key made a chat call to it and got an answer
 *     denied      the gateway answered 403 for this key
 *     unknown     nobody has established either
 *
 * `unknown` stays out. That is the opposite of `poolEligibility`, where an
 * absent `permitted` falls through to eligible — a deliberate difference: that
 * function ranks models the router already reaches, and this one decides
 * whether to open a connection at all. Guessing wrong there costs a 403 against
 * a real credential, so absence of evidence is not treated as permission.
 *
 * Everything here is pure. No network, no key, no filesystem — a caller hands
 * in evidence someone else gathered, which is what makes it testable with no
 * credential at all.
 */

export type PermissionStanding = "permitted" | "denied" | "unknown";

export interface ModelPermission {
  modelId: string;
  standing: PermissionStanding;
  /** What established it, for a report that has to justify itself. */
  basis: string;
}

/**
 * Permission facts, scoped to the credential that produced them.
 *
 * The fingerprint is carried so a record gathered under one key can never be
 * read as permission under another. A key upgrade widens what is callable and a
 * key downgrade narrows it; either way the old file describes a different
 * credential, and the guard below refuses it rather than trusting it.
 */
export interface PermissionEvidence {
  /** sha256 prefix of the key these facts were measured under. */
  keyFingerprint: string;
  baseUrl: string;
  measuredAt: string;
  models: ReadonlyArray<{ modelId: string; chat: CapabilityStatus }>;
}

const BASIS: Readonly<Record<PermissionStanding, string>> = {
  permitted: "이 자격 증명으로 chat 호출이 성공한 기록이 있습니다",
  denied: "이 자격 증명에 대해 게이트웨이가 403 을 반환했습니다",
  unknown: "이 자격 증명으로 호출해 본 기록이 없습니다",
};

/** A single model's standing. Absent from the evidence is `unknown`. */
export function permissionFor(
  evidence: PermissionEvidence | null,
  modelId: string,
): ModelPermission {
  const found = evidence?.models.find((m) => m.modelId === modelId);
  const standing: PermissionStanding =
    found === undefined ? "unknown" : found.chat === "pass" ? "permitted" : found.chat === "denied" ? "denied" : "unknown";
  return { modelId, standing, basis: BASIS[standing] };
}

/**
 * The models a proposer may be built on.
 *
 * Takes the catalogue only to preserve its order; membership decides nothing.
 * A model in the catalogue with no permission record does not appear here, and
 * that is the whole point of the function.
 */
export function permittedModels(
  evidence: PermissionEvidence | null,
  catalogue: readonly string[],
): string[] {
  return catalogue.filter((id) => permissionFor(evidence, id).standing === "permitted");
}

/** Every model's standing, catalogue order, for a report that shows its work. */
export function permissionReport(
  evidence: PermissionEvidence | null,
  catalogue: readonly string[],
): ModelPermission[] {
  return catalogue.map((id) => permissionFor(evidence, id));
}

/**
 * Reads a probe's capability matrix as permission evidence, or refuses to.
 *
 * Refuses when the matrix belongs to a different credential or a different
 * gateway. A matrix that does not match is not weaker evidence — it is evidence
 * about someone else, and using it is how one user's permission surface becomes
 * another's.
 */
export function evidenceFromMatrix(input: {
  matrix: CapabilityMatrix | null;
  keyFingerprint: string;
  baseUrl: string;
}): PermissionEvidence | null {
  const { matrix } = input;
  if (matrix === null) return null;
  if (matrix.keyFingerprint !== input.keyFingerprint) return null;
  if (matrix.baseUrl !== input.baseUrl) return null;
  return {
    keyFingerprint: matrix.keyFingerprint,
    baseUrl: matrix.baseUrl,
    measuredAt: matrix.probedAt,
    models: matrix.models.map((m) => ({
      modelId: m.modelId,
      chat: m.capabilities["chat"]?.status ?? "unknown",
    })),
  };
}
