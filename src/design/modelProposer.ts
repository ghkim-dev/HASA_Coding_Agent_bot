import { createHasaProvider } from "../provider/hasa/createProvider.ts";
import { HasaCatalog, type Modality } from "../provider/hasa/hasaCatalog.ts";
import { createMediaTransport } from "../provider/hasa/hasaMediaTransport.ts";
import { conversabilityFor, fingerprint } from "../router/conversability.ts";
import { poolEligibility } from "../router/poolEligibility.ts";
import type { RequirementProposal } from "./requirementSpec.ts";
import type { Proposer } from "./preview.ts";

/**
 * Asks a real model for requirement candidates, and lets it decide nothing.
 *
 * What comes back is coordinates and adjectives. `sourceText` is cut by the
 * runtime, `confidence` is fixed by origin, `derivedBy` and `status` and the id
 * are not the model's to send — and a response carrying any of them is refused
 * as forged rather than quietly cleaned, because a model that sends them is
 * telling us what it thinks it is allowed to do.
 *
 * ## What it may not do
 *
 * No tools, no streaming, no file access, no commands. One model, at most two
 * calls per request, a timeout and an `AbortSignal`. The model list is fetched
 * rather than written down, and only a model this credential may call *and*
 * that answers chat is eligible — asking one that is not is how a burst of 403s
 * ended up in a provider's transaction log.
 */

/** Two: one attempt, one retry for a malformed answer. Never more. */
export const MAX_CALLS = 2;
const TIMEOUT_MS = 30_000;

const SYSTEM = [
  "당신은 사용자의 요청에서 요구사항 후보를 찾아내는 보조자입니다.",
  "요청 원문에서 근거가 되는 구간의 위치만 지목하고, 그 구간의 글자를 옮겨 적지 마십시오.",
  "",
  "JSON 배열 하나만 출력하십시오. 다른 문장은 쓰지 마십시오.",
  "각 항목은 다음 필드만 가질 수 있습니다.",
  '  text      요구사항을 한 문장으로',
  '  start     요청 원문에서 근거 구간의 시작 위치 (0부터)',
  '  end       근거 구간의 끝 위치 (끝 글자 다음)',
  '  kind      functional | safety | compatibility | quality | validation | ux | security | constraint',
  '  priority  must | should | may',
  '  polarity  required | forbidden',
  "",
  "확정 여부, 출처 종류, 식별자, 실행 가능 여부는 판단하지 마십시오.",
  "근거를 찾을 수 없으면 빈 배열을 출력하십시오.",
].join("\n");

export interface ProposerOptions {
  apiKey: string;
  baseUrl: string;
  /** Overridden by tests. Production reads the gateway. */
  chat?: (input: { modelId: string; system: string; user: string; signal?: AbortSignal }) => Promise<string>;
}

/** Which model to ask, decided from the gateway rather than from a constant. */
export async function chooseProposerModel(options: ProposerOptions): Promise<string | null> {
  const provider = createHasaProvider({
    apiKey: options.apiKey,
    ...(options.baseUrl.length === 0 ? {} : { baseUrl: options.baseUrl }),
  });
  const listing = await provider.listModels();

  const modality = new Map<string, Modality>();
  try {
    const catalog = new HasaCatalog(
      createMediaTransport({ origin: options.baseUrl.replace(/\/v1\/?$/, ""), apiKey: options.apiKey }),
    );
    for (const entry of await catalog.all()) modality.set(entry.id, entry.modality);
  } catch {
    // Unknown modality is unknown, which `poolEligibility` treats as not
    // eligible rather than as permission.
  }
  const probed = conversabilityFor({
    baseUrlFingerprint: fingerprint(options.baseUrl),
    credentialFingerprint: fingerprint(options.apiKey),
  });

  for (const model of listing.models) {
    const standing = poolEligibility({
      modelId: model.id,
      modality: modality.get(model.id) ?? null,
      ...(probed.has(model.id) ? { converses: probed.get(model.id)! } : {}),
      // In the listing means this credential may call it; that is what the
      // listing is. Anything outside it is never asked.
      permitted: true,
    });
    if (standing.standing === "eligible") return model.id;
  }
  return null;
}

/**
 * Reads a model's answer into proposals, refusing what it may not decide.
 *
 * Exported for its own tests: malformed, empty and over-reaching answers are
 * the cases that matter and none of them needs a gateway to produce.
 */
export function readProposals(
  raw: string,
  turnId: string,
): { proposals: RequirementProposal[]; forged: number } {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end <= start) return { proposals: [], forged: 0 };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { proposals: [], forged: 0 };
  }
  if (!Array.isArray(parsed)) return { proposals: [], forged: 0 };

  const proposals: RequirementProposal[] = [];
  let forged = 0;

  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;

    // Fields the model may not send. Passed through so `acceptProposals`
    // records `forged_provenance` rather than being handed a cleaned object —
    // a refusal nobody sees is a boundary nobody can check.
    const overreach = ["confirmed", "confidence", "derivedBy", "status", "sourceText", "id", "executable"];
    const reaching = overreach.filter((f) => row[f] !== undefined);
    if (reaching.length > 0) forged += 1;

    if (typeof row["text"] !== "string") continue;
    if (typeof row["start"] !== "number" || typeof row["end"] !== "number") continue;

    proposals.push({
      text: row["text"],
      span: { turnId, start: row["start"], end: row["end"] },
      ...(typeof row["kind"] === "string" ? { kind: row["kind"] as never } : {}),
      ...(typeof row["priority"] === "string" ? { priority: row["priority"] as never } : {}),
      ...(typeof row["polarity"] === "string" ? { polarity: row["polarity"] as never } : {}),
      // Deliberately forwarded when present, so the refusal is visible.
      ...(reaching.length > 0 ? ({ derivedBy: "model_proposal" } as never) : {}),
    });
  }

  return { proposals, forged };
}

/** The default transport: one chat completion, no tools, no streaming. */
async function askGateway(input: {
  modelId: string;
  system: string;
  user: string;
  apiKey: string;
  baseUrl: string;
  signal?: AbortSignal;
}): Promise<string> {
  const base = input.baseUrl.replace(/\/+$/, "");
  const url = base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal =
    input.signal === undefined ? timeout : AbortSignal.any([timeout, input.signal]);

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${input.apiKey}` },
    body: JSON.stringify({
      model: input.modelId,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
      max_tokens: 800,
      temperature: 0,
    }),
    signal,
  });
  if (!response.ok) throw new Error(`gateway ${response.status}`);
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content ?? "";
}

/**
 * A proposer bound to one model.
 *
 * Chosen once and reused, so a multi-turn preview does not re-list the
 * catalogue per turn and does not drift between models mid-conversation.
 */
export async function createModelProposer(options: ProposerOptions): Promise<Proposer> {
  const modelId = await chooseProposerModel(options);
  if (modelId === null) {
    throw new Error("이 자격 증명으로 호출할 수 있는 대화형 모델이 없습니다.");
  }

  const chat =
    options.chat ??
    ((input) =>
      askGateway({
        ...input,
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
      }));

  return async ({ turnId, text, signal }) => {
    let calls = 0;
    let last = "";
    for (let attempt = 1; attempt <= MAX_CALLS; attempt += 1) {
      if (signal?.aborted === true) throw new Error("aborted");
      calls += 1;
      last = await chat({
        modelId,
        system: SYSTEM,
        user: attempt === 1 ? text : `${text}\n\n(JSON 배열만 출력하십시오.)`,
        ...(signal === undefined ? {} : { signal }),
      });
      const { proposals } = readProposals(last, turnId);
      if (proposals.length > 0) return { proposals, modelId, calls };
      // An empty answer is a legitimate outcome — some turns state no new
      // requirement — so one retry and then stop rather than insisting.
    }
    return { proposals: readProposals(last, turnId).proposals, modelId, calls };
  };
}
