/**
 * Whether a model will hold a conversation, and how confident that answer is.
 *
 * The defect this replaces was a two-value answer to a five-value question.
 * `protocolFor` said `text` for anything unmeasured, so a live candidate list
 * contained four quantum simulators, a text-to-speech model and a speech
 * recogniser — every one of which answers 404 on `/v1/chat/completions`.
 *
 *     conversability unknown  ≠  conversational
 *
 * The other half matters just as much and is easier to get wrong in the
 * opposite direction. A 403 is a permission fact, a 429 is a busy gateway and a
 * timeout is a slow one; none of them says the model cannot converse, and
 * recording any of them as `NON_CONVERSATIONAL_VERIFIED` would take a working
 * model off the list permanently on the strength of one bad minute.
 *
 * So an inconclusive answer stays inconclusive. It does not become a worker
 * either — a model nobody has confirmed can talk is not something to hand a
 * user's turn to — but it stays in the registry, and the reason it is not
 * eligible is a state anyone can read rather than a silent absence.
 */

export type ConversabilityState =
  /** Called it, it answered like a chat model. */
  | "CONVERSATIONAL_VERIFIED"
  /** Called it, and it said it is not a chat endpoint. */
  | "NON_CONVERSATIONAL_VERIFIED"
  /** Called it and learned nothing about the model: auth, rate, timeout, 5xx. */
  | "INCONCLUSIVE"
  /** Never asked. */
  | "UNKNOWN"
  /** Asked, but the answer is older than the evidence is good for. */
  | "STALE";

/** Where an answer came from. Ordered strongest first — see `preferEvidence`. */
export type ConversabilityEvidence =
  | "invocation"
  | "catalog_modality"
  | "capability_probe"
  | "provider_documentation"
  | "none";

const EVIDENCE_RANK: Readonly<Record<ConversabilityEvidence, number>> = {
  invocation: 4,
  catalog_modality: 3,
  capability_probe: 2,
  provider_documentation: 1,
  none: 0,
};

/**
 * What one attempt established.
 *
 * `credentialFingerprint` and `baseUrlFingerprint` are here because the answer
 * is only about the credential and the endpoint that produced it. A key that
 * gains access to a model, or a base URL that moves to another deployment,
 * invalidates the record — and without these the record would silently outlive
 * the thing it described. Neither is the value itself.
 */
export interface ConversabilityRecord {
  modelId: string;
  state: ConversabilityState;
  evidence: ConversabilityEvidence;
  /** The HTTP status, when there was one. For diagnosis, not for logic. */
  status?: number;
  /** One line, already safe to print. Never a response body. */
  detail: string;
  measuredAt: string;
  expiresAt?: string;
  probeVersion: string;
  providerId: string;
  baseUrlFingerprint: string;
  credentialFingerprint: string;
}

export const PROBE_VERSION = "conversability-v1";

/** Evidence is good for a day. Model access changed in under two weeks once. */
export const CONVERSABILITY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * What an HTTP status says about the *model*.
 *
 * The distinction the classification turns on is whose fact it is. A 404 from
 * the model's own endpoint is about the model. A 403 is about the credential, a
 * 429 about the moment, a 500 about the gateway — and reading any of those as
 * "this model cannot converse" would remove a working model on evidence that
 * has nothing to do with it.
 *
 * A 400 is deliberately inconclusive rather than negative: it usually means the
 * payload was wrong, and a payload this code sent is not the model's fault.
 * That is exactly how the output-ceiling bug presented.
 */
export function classifyStatus(status: number): {
  state: ConversabilityState;
  detail: string;
} {
  if (status >= 200 && status < 300) {
    return { state: "CONVERSATIONAL_VERIFIED", detail: "chat 요청에 정상 응답했습니다." };
  }
  if (status === 404 || status === 405) {
    return {
      state: "NON_CONVERSATIONAL_VERIFIED",
      detail: "이 모델에는 chat 엔드포인트가 없습니다.",
    };
  }
  if (status === 401 || status === 403) {
    return {
      state: "INCONCLUSIVE",
      detail: "이 키에 권한이 없습니다. 모델이 대화를 못 한다는 뜻은 아닙니다.",
    };
  }
  if (status === 400 || status === 422) {
    return {
      state: "INCONCLUSIVE",
      detail: "요청 본문이 거부됐습니다. 보낸 쪽의 문제일 수 있습니다.",
    };
  }
  if (status === 408 || status === 429 || status >= 500) {
    return {
      state: "INCONCLUSIVE",
      detail: "게이트웨이가 일시적으로 응답하지 못했습니다.",
    };
  }
  return { state: "INCONCLUSIVE", detail: `분류되지 않은 상태 코드 ${status}.` };
}

/**
 * Whether a 404 is about the model or about the URL.
 *
 * A doubled `/v1` produced `/v1/v1/embeddings` and a 404 whose body read
 * `Not Found` — indistinguishable, without checking, from a model that has no
 * such endpoint. So a 404 only counts as evidence about the model when some
 * other model answered on the same path in the same run.
 */
export function fourOhFourIsAboutTheModel(anotherModelAnsweredHere: boolean): boolean {
  return anotherModelAnsweredHere;
}

/** Whether a record still describes the world it was taken in. */
export function stateOf(
  record: ConversabilityRecord,
  now: number,
  context: { baseUrlFingerprint: string; credentialFingerprint: string },
): ConversabilityState {
  if (
    record.baseUrlFingerprint !== context.baseUrlFingerprint ||
    record.credentialFingerprint !== context.credentialFingerprint
  ) {
    // The answer was about a different endpoint or a different key. It is not
    // wrong; it is about something else.
    return "STALE";
  }
  if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now) return "STALE";
  return record.state;
}

/** The stronger of two answers about the same model. */
export function preferEvidence(
  a: ConversabilityRecord | undefined,
  b: ConversabilityRecord | undefined,
): ConversabilityRecord | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const rankA = EVIDENCE_RANK[a.evidence];
  const rankB = EVIDENCE_RANK[b.evidence];
  if (rankA !== rankB) return rankA > rankB ? a : b;
  return Date.parse(a.measuredAt) >= Date.parse(b.measuredAt) ? a : b;
}

/**
 * Whether this model may be handed a user's turn.
 *
 * One state says yes. `UNKNOWN`, `STALE` and `INCONCLUSIVE` all say not yet,
 * and they say it for different reasons that a caller can act on differently —
 * an unknown model wants a probe, a stale one wants a re-probe, an inconclusive
 * one may want a different credential.
 */
export function mayBeWorker(state: ConversabilityState): boolean {
  return state === "CONVERSATIONAL_VERIFIED";
}

/** Whether the filter should say `CANNOT_CONVERSE` rather than `VALIDATION_REQUIRED`. */
export function isVerifiedNonConversational(state: ConversabilityState): boolean {
  return state === "NON_CONVERSATIONAL_VERIFIED";
}

/**
 * What has actually been asked, and what came back.
 *
 * Written from a probe run rather than from anyone's reading of the names. The
 * `cuquantum-*` entries are the clearest case for why the names are not the
 * evidence: four of them, one `groot-n17-3b` and one `pii-ko`, all of which the
 * portal catalogue declines to classify and all of which the gateway answers
 * 404 for on `/v1/chat/completions`. The same run called `exaone-4.0-32b` on the
 * same path and got a 200, so the 404s are about the models rather than about
 * the URL — which is the check that stops a doubled `/v1` from being recorded
 * as six models that cannot talk.
 *
 * Fingerprints, not values: a record is about the endpoint and the credential
 * that produced it, and `stateOf` returns `STALE` when either has moved.
 */
const PROBED: readonly ConversabilityRecord[] = (
  [
    ["cuquantum-densitymatrix", 404],
    ["cuquantum-expectation", 404],
    ["cuquantum-statevector", 404],
    ["cuquantum-tensornet", 404],
    ["groot-n17-3b", 404],
    ["pii-ko", 404],
  ] as const
).map(([modelId, status]) => ({
  modelId,
  state: "NON_CONVERSATIONAL_VERIFIED" as const,
  evidence: "invocation" as const,
  status,
  detail: "POST /v1/chat/completions → 404, in a run where another model answered 200.",
  measuredAt: "2026-08-16T00:00:00.000Z",
  probeVersion: PROBE_VERSION,
  providerId: "hasa",
  baseUrlFingerprint: "fp-13m45m71wq56bd",
  credentialFingerprint: "fp-hlsenstbj6to",
}));

/** Every recorded probe. Read by the registry; never inferred from an id. */
export function probedConversability(): readonly ConversabilityRecord[] {
  return PROBED;
}

/**
 * The conversability map a registry build wants, for the endpoint in use.
 *
 * Records taken against a different endpoint or credential are dropped rather
 * than applied — they are about a different world, and applying them would
 * exclude models the current key may well be able to reach.
 */
export function conversabilityFor(context: {
  baseUrlFingerprint: string;
  credentialFingerprint: string;
  now?: number;
}): Map<string, boolean> {
  const now = context.now ?? Date.now();
  const out = new Map<string, boolean>();
  for (const record of PROBED) {
    const state = stateOf(record, now, context);
    if (isVerifiedNonConversational(state)) out.set(record.modelId, false);
    else if (state === "CONVERSATIONAL_VERIFIED") out.set(record.modelId, true);
  }
  return out;
}

/** A fingerprint that identifies a value without carrying it. */
export function fingerprint(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `fp-${h1.toString(36)}${h2.toString(36)}`;
}
