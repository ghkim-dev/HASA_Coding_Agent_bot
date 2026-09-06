import type { LlmProvider } from "../provider/types.ts";
import type { Proposer } from "./preview.ts";
import { parseProposals } from "./proposalParse.ts";
import { evidenceFromMemory } from "./memoryEvidence.ts";
import type { Neighbour } from "./requirementMemory.ts";
import {
  denyObserved,
  isForbiddenDenial,
  permissionReport,
  permittedModels,
  type ModelPermission,
  type PermissionEvidence,
  type PermissionEvidenceStore,
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

/**
 * The output budget every proposer call runs under.
 *
 * Exported because it is not an implementation detail: `proposerEvidence`
 * established that a model's score and its budget are one fact — six of the
 * eighteen chat models on this gateway return an empty string at this number
 * and answer well above it — so anything recording what a model did has to
 * record the budget it did it under. A caller that had to guess 800 would
 * write down a fact it did not know.
 */
export const MAX_OUTPUT_TOKENS = 800;
const TIMEOUT_MS = 30_000;

/**
 * The instructions the proposer actually ships with.
 *
 * Exported so `proposerMetrics` can measure this string rather than a copy of
 * it. A sweep that pasted the prompt into its own script would keep reporting
 * numbers about a prompt that had since changed here, and nothing would say so.
 */
export const SYSTEM = [
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
   * Where to write down a refusal so the next process does not repeat it.
   *
   * Optional in the type and load-bearing in practice. Without it a 403 is
   * remembered only inside this proposer instance: the run stops calling the
   * model, the process exits, and the next one reads a record that still says
   * `permitted` and calls it again. That is a burst of 403s spread across
   * restarts, which is indistinguishable from probing a permission boundary.
   *
   * The design layer never learns where the store keeps anything — see
   * `PermissionEvidenceStore`.
   */
  store?: PermissionEvidenceStore;
  /** Told about the refusal too, for a report that wants to mention it. */
  onDenied?: (denial: { modelId: string; permission: PermissionEvidence | null }) => void;
  /**
   * What the memory saw happen to requests like this one.
   *
   * Supplied by the composition root, which embeds the request and reads the
   * store — this layer opens neither a socket nor a file. Omitted means the
   * memory was not consulted, and the order is then exactly what permission and
   * the catalogue produced.
   */
  remembered?: readonly Neighbour[];
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
 * So the base order is permitted models in catalogue order, which has no
 * measured basis and never claimed one.
 *
 * ## What now moves it
 *
 * `remembered` — what happened to requests like this one. It is the first
 * evidence this function has ever had that is about the job it is choosing for:
 * a proposer misreading a request, seen in real use rather than measured
 * against a corpus. It reorders and never excludes, and with no neighbours the
 * order is unchanged, so the honest description of an unused memory is still
 * "catalogue order with no measured basis".
 *
 * `proposerMetrics.ts` remains the corpus-side answer to the same question, and
 * the two are deliberately not merged: one is what a sweep measured on a day,
 * the other is what users lived with.
 */
export async function chooseProposerModel(options: ProposerOptions): Promise<string | null> {
  const ranked = await rankByPermission(options);
  return demoteRemembered(ranked, options.remembered ?? [], options.now())[0] ?? null;
}

/**
 * Moves models the memory has watched fail on requests like this one to the back.
 *
 * This is the evidence the module has said it did not have since it stopped
 * ranking by `requirementRecall`. It is the right evidence for *this* choice and
 * for no other: what the memory records is a proposer misreading a request —
 * the user corrected the requirement, or the runtime refused its coordinates —
 * which is precisely the job being chosen for here.
 *
 * ## Why it does not go into the router's ranking instead
 *
 * That was tried first and it was wrong. The router ranks models to *do the
 * work*, and for "로그인 오류를 고쳐줘" it asks for coding, tool use and
 * recovery — `sourceGrounding` is demanded at zero. Folding the memory in there
 * either did nothing or, worse, would have claimed that a model which misreads
 * a request is also worse at writing code. Nothing establishes that, and
 * asserting it is the laundering of one signal into many that
 * `memoryEvidence` refuses on its own doorstep.
 *
 * ## It reorders; it never excludes
 *
 * A model the memory dislikes is still permitted, and permission is not this
 * function's to revoke — `permittedModels` decided that, from evidence about
 * what the gateway allows. A handful of corrected requirements is a reason to
 * prefer someone else, not a reason to declare a model unusable. When the
 * memory has no opinion the order is exactly what it was.
 */
export function demoteRemembered(
  ranked: readonly string[],
  neighbours: readonly Neighbour[],
  now: number,
): string[] {
  if (neighbours.length === 0) return [...ranked];
  const worst = new Map<string, number>();
  for (const e of evidenceFromMemory({ neighbours, now })) {
    const seen = e.capabilities.sourceGrounding;
    if (seen === undefined) continue;
    const standing = worst.get(e.modelId);
    // The worst verdict any budget produced. Ranking a model on its best day
    // and then calling it on its worst is how a pick becomes a promise nobody
    // made — the same reason `proposerEvidence` carries a budget floor.
    if (standing === undefined || seen.value < standing) worst.set(e.modelId, seen.value);
  }
  if (worst.size === 0) return [...ranked];

  // A stable sort over the original order, so models the memory says nothing
  // about keep their catalogue positions relative to each other. Only what the
  // memory actually watched moves.
  return [...ranked]
    .map((modelId, index) => ({ modelId, index, score: worst.get(modelId) }))
    .sort((a, b) => {
      if (a.score === undefined && b.score === undefined) return a.index - b.index;
      if (a.score === undefined) return -1;
      if (b.score === undefined) return 1;
      return b.score - a.score || a.index - b.index;
    })
    .map((r) => r.modelId);
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
/**
 * Why nothing was eligible, in words the person can act on.
 *
 * The old message said "no model this credential can call" and stopped there.
 * That sentence is true of two different situations and only one of them is a
 * problem with the key:
 *
 *   - nothing has ever been measured for this key, so nothing is *known* to be
 *     callable — the fix is to run the probe, and the message now says so;
 *   - measurements exist and the gateway refused every model — the key really
 *     cannot reach them, and probing again will not change that.
 *
 * Running the product as a user is what surfaced this. A valid key, a gateway
 * answering 35 models, and a design that reported no callable model — because
 * the capability matrix on disk was three weeks old and belonged to a different
 * key. The runtime knew that (`never_probed`) and told nobody.
 */
function whyNoModel(permissions: readonly ModelPermission[]): string {
  const forbidden = permissions.filter((p) => p.standing === "server_forbidden");
  const unmeasured = permissions.filter(
    (p) => p.reason === "never_probed" || p.reason === "expired",
  );

  if (permissions.length === 0) {
    return "게이트웨이가 모델 목록을 주지 않았습니다. 네트워크와 HASA_BASE_URL 을 확인하십시오.";
  }
  if (unmeasured.length === permissions.length) {
    return (
      `이 자격 증명으로 무엇을 부를 수 있는지 아직 재지 않았습니다 ` +
      `(모델 ${permissions.length}개 전부 미측정). \`pnpm probe\` 를 먼저 돌리십시오 — ` +
      `능력 측정은 키마다 따로 쌓이므로, 키를 바꿨다면 예전 측정은 쓰이지 않습니다.`
    );
  }
  if (unmeasured.length === 0) {
    return (
      `게이트웨이가 이 자격 증명으로는 모델 ${forbidden.length}개를 전부 거부했습니다. ` +
      `다시 재도 거부는 바뀌지 않습니다 — 키의 권한을 확인하십시오.`
    );
  }
  // 거부와 미측정이 섞인 경우. 미측정이 남아 있으면 재는 것이 여전히 할 일이고,
  // 여기서 "다시 재도 소용없다"고 말하면 고칠 수 있는 사람을 돌려보내게 된다.
  return (
    `부를 수 있다고 확인된 대화형 모델이 없습니다 — ` +
    `거부 ${forbidden.length}개, 아직 재지 않음 ${unmeasured.length}개. ` +
    `\`pnpm probe\` 로 나머지를 재 보십시오. 거부된 ${forbidden.length}개는 다시 재도 바뀌지 않습니다.`
  );
}

export async function createModelProposer(options: ProposerOptions): Promise<Proposer> {
  const modelId = await chooseProposerModel(options);
  if (modelId === null) {
    const listing = await options.provider.listModels();
    throw new Error(
      whyNoModel(permissionReport(options.permission, listing.models.map((m) => m.id), options.now())),
    );
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
            maxOutputTokens: MAX_OUTPUT_TOKENS,
          },
          { timeoutMs: TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
        );
      } catch (err) {
        if (!isForbiddenDenial(err)) throw err;
        // Stop here. Not "try the next permitted model" — a 403 on one model is
        // not evidence about another, and walking the list to find one that
        // answers is precisely the probing this must never do. One refusal, one
        // stop, one record.
        revoked = modelId;
        const at = options.now();
        permission = denyObserved(permission, modelId, at);
        if (options.store !== undefined && permission !== null) {
          // Awaited before the error is re-thrown, so the record is on disk by the
          // time the caller sees the failure. A refusal remembered only in memory
          // is forgotten by the next process, which then makes the same call.
          //
          // A failing store must not replace the 403 with a filesystem error: the
          // caller needs to see why their request stopped.
          await options.store
            .recordForbidden({
              keyFingerprint: permission.keyFingerprint,
              baseUrl: permission.baseUrl,
              modelId,
              at,
            })
            .catch(() => undefined);
        }
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
