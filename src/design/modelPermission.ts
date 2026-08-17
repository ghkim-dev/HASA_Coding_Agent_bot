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
 * ## And a measurement is not permanent
 *
 * `measuredAt` was carried and never read, which made a record from any point in
 * the past as good as one from a minute ago. It is not: a key's model access
 * changes when the plan behind it changes, and a `permitted` from last month is
 * a guess wearing a measurement's clothes. So a record has a maximum age, a
 * timestamp that cannot be read is not a timestamp, and one stamped in the
 * future beyond ordinary clock skew is refused rather than treated as very
 * fresh — an expired record answers `unknown`, which is not a yes.
 *
 * The other half of the same problem is the live one: a real 403 arriving now
 * outranks any file, however fresh, and `denyObserved` is how the caller says
 * so. A record that keeps saying `permitted` after the gateway has refused is
 * the same defect as reading the catalogue, one layer down.
 *
 * Everything here is pure. No network, no key, no filesystem, and no clock —
 * `now` is a parameter for the same reason the evidence is: a caller hands in
 * what someone else established, which is what makes it testable with no
 * credential and no waiting.
 */

export type PermissionStanding = "permitted" | "denied" | "unknown";

/** Why a standing came out the way it did. Structural, so tests need no prose. */
export type PermissionReason =
  /** The key called it and got an answer. */
  | "chat_succeeded"
  /** The gateway answered 403 when the probe ran. */
  | "gateway_denied"
  /** The gateway answered 403 just now, superseding whatever the record said. */
  | "denied_live"
  /** Nothing has ever been established for this key and this model. */
  | "never_probed"
  /** There is a record and it is older than a record may be. */
  | "expired"
  /** The measurement time is not a time. */
  | "unreadable_time"
  /** The measurement time is ahead of now by more than clock skew explains. */
  | "future_dated";

export interface ModelPermission {
  modelId: string;
  standing: PermissionStanding;
  reason: PermissionReason;
  /** What established it, for a report that has to justify itself. */
  basis: string;
  /** How old the measurement is, or null when there is nothing to measure. */
  ageMs: number | null;
}

/**
 * How long a permission measurement stands before it has to be made again.
 *
 * A day. The number is a trade rather than a discovery: re-probing costs real
 * calls against the user's key, so a short window spends their quota to
 * re-establish something that rarely changes, and a long one lets a plan change
 * sit unnoticed as a `permitted` that produces 403s. A day bounds the stale
 * window to something a person would recognise as "today's measurement", and
 * `denyObserved` closes it immediately when the gateway actually refuses —
 * which is the case the age limit alone cannot catch.
 */
export const PERMISSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How far ahead of `now` a measurement may be stamped and still be believed.
 *
 * Five minutes, for the ordinary case: the matrix was written on a machine
 * whose clock is a little ahead of this one. Beyond that the record is not
 * describing the past, and a record that is not describing the past cannot be
 * evidence about it — treating a far-future stamp as "very fresh" is what would
 * let a wrong clock, or a written-by-hand file, keep an expired `permitted`
 * alive indefinitely.
 */
export const PERMISSION_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

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
  models: ReadonlyArray<PermissionFact>;
}

export interface PermissionFact {
  modelId: string;
  chat: CapabilityStatus;
  /**
   * When *this fact* was established, when that differs from the record.
   *
   * Set by `denyObserved`: a 403 observed a moment ago is newer than the file it
   * corrects, and dating it by the file's `measuredAt` would let a stale record
   * expire the fresh refusal inside it.
   */
  observedAt?: string;
  /** `live` for something this process saw happen. Default `probe`. */
  source?: "probe" | "live";
}

function hoursOf(ms: number): string {
  return `${Math.floor(ms / 3_600_000)}시간`;
}

/** How old a fact is, and whether that age is usable at all. */
function ageOf(stamp: string, now: number): { ageMs: number } | { problem: PermissionReason } {
  const at = Date.parse(stamp);
  if (!Number.isFinite(at)) return { problem: "unreadable_time" };
  const ageMs = now - at;
  if (ageMs < -PERMISSION_MAX_FUTURE_SKEW_MS) return { problem: "future_dated" };
  if (ageMs > PERMISSION_MAX_AGE_MS) return { problem: "expired" };
  // Inside the skew window a stamp slightly ahead of us is treated as now, so
  // an age never reads as negative to anything downstream.
  return { ageMs: Math.max(0, ageMs) };
}

function basisFor(reason: PermissionReason, ageMs: number | null): string {
  switch (reason) {
    case "chat_succeeded":
      return `이 자격 증명으로 chat 호출이 성공한 기록이 있습니다 (측정 후 ${hoursOf(ageMs ?? 0)} 경과)`;
    case "gateway_denied":
      return "이 자격 증명에 대해 게이트웨이가 403 을 반환했습니다";
    case "denied_live":
      return "이 자격 증명으로 방금 호출했을 때 게이트웨이가 403 을 반환했습니다";
    case "never_probed":
      return "이 자격 증명으로 호출해 본 기록이 없습니다";
    case "expired":
      return `권한 기록이 만료되었습니다 (측정 후 ${hoursOf(ageMs ?? 0)} 경과, 최대 ${hoursOf(PERMISSION_MAX_AGE_MS)})`;
    case "unreadable_time":
      return "권한 기록의 측정 시각을 읽을 수 없습니다";
    case "future_dated":
      return "권한 기록의 측정 시각이 현재보다 미래입니다";
  }
}

function decide(standing: PermissionStanding, reason: PermissionReason, modelId: string, ageMs: number | null): ModelPermission {
  return { modelId, standing, reason, basis: basisFor(reason, ageMs), ageMs };
}

/**
 * A single model's standing, as of `now`.
 *
 * Absent from the evidence is `unknown`, and so is present-but-stale: an
 * expired record is not weaker evidence, it is a fact about a credential
 * configuration that may no longer exist. Uniform across all three standings on
 * purpose — an expired `denied` becoming `unknown` costs nothing, because
 * `unknown` is not permission either.
 */
export function permissionFor(
  evidence: PermissionEvidence | null,
  modelId: string,
  now: number,
): ModelPermission {
  const found = evidence?.models.find((m) => m.modelId === modelId);
  if (evidence === null || found === undefined) return decide("unknown", "never_probed", modelId, null);

  const age = ageOf(found.observedAt ?? evidence.measuredAt, now);
  if ("problem" in age) return decide("unknown", age.problem, modelId, null);

  if (found.chat === "pass") return decide("permitted", "chat_succeeded", modelId, age.ageMs);
  if (found.chat === "denied") {
    return decide("denied", found.source === "live" ? "denied_live" : "gateway_denied", modelId, age.ageMs);
  }
  return decide("unknown", "never_probed", modelId, age.ageMs);
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
  now: number,
): string[] {
  return catalogue.filter((id) => permissionFor(evidence, id, now).standing === "permitted");
}

/** Every model's standing, catalogue order, for a report that shows its work. */
export function permissionReport(
  evidence: PermissionEvidence | null,
  catalogue: readonly string[],
  now: number,
): ModelPermission[] {
  return catalogue.map((id) => permissionFor(evidence, id, now));
}

/**
 * Writes a 403 that actually happened into the record.
 *
 * The gateway refusing a call now outranks a file that says it would not, so
 * this supersedes the fact rather than adding a second one: a caller that keeps
 * selecting a model because the record still says `permitted` is repeating the
 * mistake this module exists for, one layer down.
 *
 * Null evidence stays null. There is no record to correct, and inventing one
 * would mean inventing the credential and gateway it was measured under —
 * `unknown` already excludes the model from every selection.
 */
export function denyObserved(
  evidence: PermissionEvidence | null,
  modelId: string,
  at: number,
): PermissionEvidence | null {
  if (evidence === null) return null;
  const observed: PermissionFact = {
    modelId,
    chat: "denied",
    observedAt: new Date(at).toISOString(),
    source: "live",
  };
  const models = evidence.models.some((m) => m.modelId === modelId)
    ? evidence.models.map((m) => (m.modelId === modelId ? observed : m))
    : [...evidence.models, observed];
  return { ...evidence, models };
}

/**
 * Whether a thrown value is the gateway refusing this key for this model.
 *
 * Read structurally rather than with `instanceof`, so this module keeps its one
 * import and its purity: a `ProviderError` arrives as `code: "forbidden"`, and
 * anything else carrying HTTP 403 means the same thing to a caller deciding
 * whether to keep using a model.
 */
export function isForbiddenDenial(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const record = err as { code?: unknown; httpStatus?: unknown; status?: unknown };
  return record.code === "forbidden" || record.httpStatus === 403 || record.status === 403;
}

/**
 * Reads a probe's capability matrix as permission evidence, or refuses to.
 *
 * Refuses when the matrix belongs to a different credential or a different
 * gateway. A matrix that does not match is not weaker evidence — it is evidence
 * about someone else, and using it is how one user's permission surface becomes
 * another's.
 *
 * Refuses too when its timestamp is not a readable past time. That is a
 * different kind of wrong from age: a stale matrix is a real measurement that
 * has lapsed, and it is carried through so a report can say so; a matrix whose
 * `probedAt` cannot be parsed, or sits in the future, is not a measurement of
 * anything and there is nothing to carry.
 */
export function evidenceFromMatrix(input: {
  matrix: CapabilityMatrix | null;
  keyFingerprint: string;
  baseUrl: string;
  now: number;
}): PermissionEvidence | null {
  const { matrix } = input;
  if (matrix === null) return null;
  if (matrix.keyFingerprint !== input.keyFingerprint) return null;
  if (matrix.baseUrl !== input.baseUrl) return null;
  const probedAt = Date.parse(matrix.probedAt);
  if (!Number.isFinite(probedAt)) return null;
  if (probedAt - input.now > PERMISSION_MAX_FUTURE_SKEW_MS) return null;
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
