import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHasaProvider } from "../provider/hasa/createProvider.ts";
import { HasaCatalog, type Modality } from "../provider/hasa/hasaCatalog.ts";
import { createMediaTransport } from "../provider/hasa/hasaMediaTransport.ts";
import {
  CONVERSABILITY_TTL_MS,
  PROBE_VERSION,
  classifyStatus,
  fingerprint,
  type ConversabilityState,
} from "../router/conversability.ts";
import { poolEligibility } from "../router/poolEligibility.ts";
import { semanticProfileFor } from "../router/modelSemanticCatalog.ts";
import { DEFAULT_POOL } from "../router/semanticProfile.ts";

/**
 * Asks every model in the catalogue whether it serves chat, once.
 *
 * T1 of the model-verification plan. The catalogue *describes* what each model
 * is; this is the thing itself answering, and the two have disagreed before —
 * six models the catalogue declined to classify all answered 404, and a filter
 * reading an absent field called every model `text` for as long as it existed.
 *
 *   node --env-file-if-exists=.env src/live/conversabilityProbe.ts [--force]
 *
 * ## What it does not do
 *
 * No streaming, no tool-calling, no capability sweep. Those are eleven requests
 * per model and belong to whatever needs them, on the models that survive this.
 * One call each, `max_tokens: 1`.
 *
 * A model that answers 404 here is **not** a model that scored zero. It is a
 * model asked the wrong question, and it is recorded as a non-chat role rather
 * than as a bad assistant — the distinction a sweep got wrong once by scoring
 * four image models across twenty coding scenarios.
 *
 * ## What is written down
 *
 * Model id, HTTP status, the classified state, the catalogue's modality, and
 * fingerprints of the endpoint and credential. Never the key, never a header,
 * never a response body. A body can carry an echo of the request and there is
 * no reason for one to reach a file that gets committed or pasted.
 *
 * ## Resume
 *
 * Every model is written the moment it answers, so an interrupted run resumes
 * where it stopped and does not re-ask anything already settled. `--force`
 * re-asks everything.
 */

const STORE = ".arena/t1-conversability.json";

/** A pause between calls. Enough that a refusal streak is not a strike. */
const GAP_MS = 250;

/** Consecutive rate-limit answers before stopping rather than pressing on. */
const RATE_LIMIT_PATIENCE = 3;

export type ChatSupport =
  /** Answered a chat request. */
  | "chat_supported"
  /** Answered that it has no chat endpoint. This is a role, not a failure. */
  | "chat_unsupported"
  /** The credential may not call it. Says nothing about the model. */
  | "not_permitted"
  /** The request was rejected. Says something about the caller. */
  | "request_rejected"
  /** No answer arrived. */
  | "timeout"
  | "network_failure"
  /** The gateway was busy or broken. */
  | "gateway_unavailable"
  /** In the catalogue and never asked. */
  | "not_probed";

export interface ProbeRecord {
  modelId: string;
  /** Whether the portal catalogue lists it, and as what. */
  inCatalogue: boolean;
  modality: Modality | null;
  callable: boolean | null;
  /** Whether the gateway's own model list offers it. */
  inGatewayListing: boolean;
  support: ChatSupport;
  state: ConversabilityState;
  /** The HTTP status, when there was one. Diagnosis only. */
  status: number | null;
  /** One line, already safe to print. Never a response body. */
  detail: string;
  latencyMs: number | null;
  measuredAt: string;
  probeVersion: string;
  baseUrlFingerprint: string;
  credentialFingerprint: string;
}

export interface ProbeFile {
  format: "t1-conversability-v1";
  baseUrlFingerprint: string;
  credentialFingerprint: string;
  /** Whether a model known to answer did answer. Without it, 404 means nothing. */
  controlAnswered: boolean;
  records: ProbeRecord[];
}

/**
 * What a status means for *chat support*, which is not the same question as
 * conversability state.
 *
 * `classifyStatus` answers "what does this say about the model". This answers
 * "what do we do with it", and the two differ where a 403 is concerned: the
 * state is `INCONCLUSIVE` and the disposition is `not_permitted`, which is a
 * fact about the credential worth reporting separately from a fact about the
 * model.
 */
function supportFor(status: number): ChatSupport {
  if (status >= 200 && status < 300) return "chat_supported";
  if (status === 404 || status === 405) return "chat_unsupported";
  if (status === 401 || status === 403) return "not_permitted";
  if (status === 400 || status === 422) return "request_rejected";
  if (status === 408 || status === 429 || status >= 500) return "gateway_unavailable";
  return "gateway_unavailable";
}

async function load(path: string): Promise<ProbeFile | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ProbeFile;
  } catch {
    return null;
  }
}

async function save(path: string, file: ProbeFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const apiKey = process.env["HASA_API_KEY"] ?? "";
const baseUrl = (process.env["HASA_BASE_URL"] ?? "").replace(/\/+$/, "");
const force = process.argv.includes("--force");

if (apiKey.trim().length === 0) {
  out("HASA_API_KEY is not set. T1 NOT RUN — no credential, and no probe to report.");
  process.exit(2);
}

const context = {
  baseUrlFingerprint: fingerprint(baseUrl),
  credentialFingerprint: fingerprint(apiKey),
};
out(`endpoint   : ${context.baseUrlFingerprint}`);
out(`credential : ${context.credentialFingerprint}`);

// --- who there is to ask ----------------------------------------------------

const provider = createHasaProvider({ apiKey, ...(baseUrl.length === 0 ? {} : { baseUrl }) });
const listing = await provider.listModels();
const listed = new Set(listing.models.map((m) => m.id));

const catalog = new HasaCatalog(
  createMediaTransport({ origin: baseUrl.replace(/\/v1\/?$/, ""), apiKey }),
);
const entries = new Map<string, { modality: Modality; callable: boolean | null }>();
try {
  for (const entry of await catalog.all()) {
    entries.set(entry.id, { modality: entry.modality, callable: entry.callable ?? null });
  }
} catch (err) {
  out(`catalogue unavailable: ${(err as Error).message}`);
}

const ids = [...new Set([...listed, ...entries.keys()])].sort();
out(`catalogue  : ${entries.size} entries`);
out(`gateway    : ${listed.size} models`);
out(`to ask     : ${ids.length}`);

// --- resume -----------------------------------------------------------------

const previous = force ? null : await load(STORE);
const settled = new Map<string, ProbeRecord>();
if (
  previous !== null &&
  previous.baseUrlFingerprint === context.baseUrlFingerprint &&
  previous.credentialFingerprint === context.credentialFingerprint
) {
  const now = Date.now();
  for (const record of previous.records) {
    const age = now - Date.parse(record.measuredAt);
    // Only a settled answer is reused. An inconclusive one is exactly what a
    // re-run is for, and a stale one is not an answer about today.
    const settledState =
      record.state === "CONVERSATIONAL_VERIFIED" || record.state === "NON_CONVERSATIONAL_VERIFIED";
    if (settledState && age < CONVERSABILITY_TTL_MS) settled.set(record.modelId, record);
  }
  out(`resumed    : ${settled.size} already settled, ${ids.length - settled.size} to ask`);
} else if (previous !== null) {
  out("resumed    : none — the stored probe was taken against a different endpoint or key");
}

// --- ask --------------------------------------------------------------------

const url = baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
const records: ProbeRecord[] = [];
let controlAnswered = [...settled.values()].some((r) => r.support === "chat_supported");
let rateLimited = 0;
let stopped = false;

const file = (): ProbeFile => ({
  format: "t1-conversability-v1",
  ...context,
  controlAnswered,
  records: [...records].sort((a, b) => a.modelId.localeCompare(b.modelId)),
});

out("");
out(`${"model".padEnd(26)} ${"modality".padEnd(11)} ${"status".padEnd(7)} ${"support".padEnd(18)} latency`);

for (const id of ids) {
  const entry = entries.get(id) ?? null;
  const base = {
    modelId: id,
    inCatalogue: entry !== null,
    modality: entry?.modality ?? null,
    callable: entry?.callable ?? null,
    inGatewayListing: listed.has(id),
    measuredAt: new Date().toISOString(),
    probeVersion: PROBE_VERSION,
    ...context,
  };

  const already = settled.get(id);
  if (already !== undefined) {
    records.push({ ...already, ...base, measuredAt: already.measuredAt });
    out(
      `${id.padEnd(26)} ${String(base.modality ?? "-").padEnd(11)} ${String(already.status ?? "-").padEnd(7)} ${already.support.padEnd(18)} (cached)`,
    );
    continue;
  }

  if (stopped) {
    records.push({ ...base, support: "not_probed", state: "UNKNOWN", status: null, detail: "이 실행에서는 묻지 않았습니다.", latencyMs: null });
    continue;
  }

  const started = Date.now();
  let status: number | null = null;
  let support: ChatSupport;
  let state: ConversabilityState;
  let detail: string;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: id, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(30_000),
    });
    status = response.status;
    // Read and discard. Nothing from the body is kept: it can echo the request
    // and there is no reason for it to reach a file.
    await response.text();
    ({ state, detail } = classifyStatus(status));
    support = supportFor(status);
    if (support === "chat_supported") controlAnswered = true;
    if (status === 429) {
      rateLimited += 1;
      if (rateLimited >= RATE_LIMIT_PATIENCE) {
        stopped = true;
        out(`\nstopping: ${RATE_LIMIT_PATIENCE} consecutive rate limits. Re-run to resume.`);
      }
    } else {
      rateLimited = 0;
    }
  } catch (err) {
    const name = (err as Error).name;
    support = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_failure";
    state = "INCONCLUSIVE";
    detail = `요청이 끝나지 않았습니다: ${name}`;
  }

  const latencyMs = Date.now() - started;
  records.push({ ...base, support, state, status, detail, latencyMs });
  out(
    `${id.padEnd(26)} ${String(base.modality ?? "-").padEnd(11)} ${String(status ?? "-").padEnd(7)} ${support.padEnd(18)} ${latencyMs}ms`,
  );

  // Written every time, so an interruption costs one model rather than a run.
  await save(STORE, file());
  await new Promise((resolve) => setTimeout(resolve, GAP_MS));
}

await save(STORE, file());

// --- report -----------------------------------------------------------------

out("");
if (!controlAnswered) {
  out("NO MODEL ANSWERED. Every 404 above is about the path, not about the models.");
  out("Nothing here should be read as evidence. Check the base URL and re-run.");
  process.exit(1);
}

const by = (support: ChatSupport): ProbeRecord[] => records.filter((r) => r.support === support);
const codingPool = records.filter(
  (r) =>
    poolEligibility({
      modelId: r.modelId,
      modality: r.modality,
      converses: r.support === "chat_supported" ? true : r.support === "chat_unsupported" ? false : undefined,
      permitted: r.support === "not_permitted" ? false : undefined,
      pool: DEFAULT_POOL,
    }).standing === "eligible",
);

const section = (title: string, rows: readonly ProbeRecord[]): void => {
  out(`\n${title} (${rows.length})`);
  for (const r of rows) {
    const role = semanticProfileFor(r.modelId).profile?.role ?? "-";
    out(`  ${r.modelId.padEnd(26)} ${String(r.modality ?? "-").padEnd(11)} ${role}`);
  }
};

out("── T1 SUMMARY ─────────────────────────────────────────────");
out(`asked                : ${records.filter((r) => r.support !== "not_probed").length} / ${ids.length}`);
out(`control answered     : ${controlAnswered}`);
section("chat supported", by("chat_supported"));
section("chat unsupported (a role, not a score)", by("chat_unsupported"));
section("not permitted by this credential", by("not_permitted"));
section("request rejected", by("request_rejected"));
section("timeout", by("timeout"));
section("network failure", by("network_failure"));
section("gateway unavailable", by("gateway_unavailable"));
section("not probed in this run", by("not_probed"));

out(`\ncoding pool eligible : ${codingPool.length}`);
for (const r of codingPool) out(`  ${r.modelId}`);
out(`\nwritten to ${STORE}`);
