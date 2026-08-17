import type { LlmProvider } from "../provider/types.ts";
import type { Proposer } from "./preview.ts";
import { parseProposals } from "./proposalParse.ts";
import {
  denyObserved,
  isForbiddenDenial,
  permittedModels,
  type PermissionEvidence,
} from "./modelPermission.ts";

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
  /**
   * An already-built provider. Not an api key.
   *
   * Assembly belongs at the composition root — `previewCli` — the way
   * `createAgentModel` and `createTextToolModel` already take one. This module
   * opened its own socket instead, and reimplemented the URL, the bearer header,
   * the timeout, the retry and the OpenAI response shape that the provider layer
   * owns, each one a second and weaker copy.
   */
  provider: LlmProvider;
  /**
   * What this credential is known to be able to call. `null` means nothing was
   * established, which selects nothing — see `modelPermission`.
   */
  permission: PermissionEvidence | null;
  /**
   * The clock, from the caller.
   *
   * Required rather than defaulted to `Date.now`, because permission evidence
   * expires and a layer that reads its own clock cannot be tested for what it
   * does at the boundary. The composition root passes `() => Date.now()`; a
   * test passes the moment it wants to be.
   */
  now: () => number;
  /**
   * Told when a model this record called `permitted` answered 403.
   *
   * The corrected record is handed over so whoever owns the file can write it
   * back or re-probe. Optional: the proposer stops using the model either way.
   */
  onDenied?: (denial: { modelId: string; permission: PermissionEvidence | null }) => void;
}

/**
 * Which model to ask.
 *
 * Permission first, and permission is not the catalogue. `listModels()` is
 * kept only for its order — every id it returns is checked against evidence
 * gathered under *this* credential, and one with no such evidence is not asked.
 *
 * ## Why recall no longer ranks these
 *
 * It used to sort by `requirementRecall` from the Coding Agent sweep, reading
 * the quarantined dataset alongside the production one. Two things were wrong
 * with that and only one was the quarantine. `requirementRecall` measures
 * whether a *whole agent loop* wrote the user's requirements into its contract
 * over a long task; a proposer emits a short JSON array with character offsets
 * in one call. Nothing establishes that the first predicts the second, so the
 * ranking was authority the number had not earned — and no argument about
 * quarantine could have fixed that, because the metric was the wrong metric
 * before the question of which file it came from arose.
 *
 * So: permitted models in catalogue order, and the selection says plainly that
 * it had no measured basis. A proposer-specific measurement is what would
 * change this; `proposerMetrics.ts` defines what it would have to contain.
 */
export async function chooseProposerModel(options: ProposerOptions): Promise<string | null> {
  const ranked = await rankByPermission(options);
  return ranked[0] ?? null;
}

/** Models this credential may call, catalogue order. Exported for its own test. */
export async function rankByPermission(options: ProposerOptions): Promise<string[]> {
  const listing = await options.provider.listModels();
  return permittedModels(options.permission, listing.models.map((m) => m.id), options.now());
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

  /**
   * Set when the gateway refuses this model, and never cleared.
   *
   * The record said `permitted` and the gateway says otherwise; the gateway is
   * the one holding the answer. Calling again on the strength of the file is
   * how the burst of 403s in a provider's transaction log happened, so the
   * proposer stops rather than retrying against a record that has been proven
   * wrong.
   */
  let revoked: string | null = null;
  let permission = options.permission;

  return async ({ turnId, text, signal }) => {
    if (revoked !== null) {
      throw new Error(`${revoked} 은(는) 403 을 받았습니다. 권한을 다시 측정할 때까지 호출하지 않습니다.`);
    }
    let calls = 0;
    let last = "";
    for (let attempt = 1; attempt <= MAX_CALLS; attempt += 1) {
      if (signal?.aborted === true) throw new Error("aborted");
      calls += 1;
      // Normalized in, normalized out. `response.text` is the provider's job;
      // reading `choices[0].message.content` here was a second, weaker
      // unwrapping of a wire format this layer must not know exists.
      let response;
      try {
        response = await options.provider.chat(
          {
            modelId,
            messages: [
              { role: "system", content: SYSTEM },
              { role: "user", content: attempt === 1 ? text : `${text}\n\n(JSON 배열만 출력하십시오.)` },
            ],
            temperature: 0,
            maxOutputTokens: 800,
          },
          { timeoutMs: TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
        );
      } catch (err) {
        if (!isForbiddenDenial(err)) throw err;
        revoked = modelId;
        permission = denyObserved(permission, modelId, options.now());
        options.onDenied?.({ modelId, permission });
        throw err;
      }
      last = response.text;
      const parse = parseProposals(last, turnId);
      if (parse.proposals.length > 0) return { proposals: parse.proposals, modelId, calls, parse };
      // An empty answer is a legitimate outcome — some turns state no new
      // requirement — so one retry and then stop rather than insisting.
    }
    const parse = parseProposals(last, turnId);
    return { proposals: parse.proposals, modelId, calls, parse };
  };
}
