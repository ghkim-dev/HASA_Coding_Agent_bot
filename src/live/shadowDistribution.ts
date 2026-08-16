import { createHasaProvider } from "../provider/hasa/createProvider.ts";
import { HasaCatalog, canConverse } from "../provider/hasa/hasaCatalog.ts";
import { createMediaTransport } from "../provider/hasa/hasaMediaTransport.ts";
import { conversabilityFor, fingerprint } from "../router/conversability.ts";
import { buildRegistry } from "../router/modelRegistry.ts";
import { loadEvidence } from "../router/evaluationStore.ts";
import { projectTaskProfile } from "../router/taskProfile.ts";
import { projectTaskSemanticProfile } from "../router/semanticProfile.ts";
import { recommendModel } from "../router/recommend.ts";
import { evaluateShadow } from "../router/shadow.ts";
import { embeddingMatcher } from "../router/embedding.ts";
import { createHasaEmbeddingProvider } from "../router/hasaEmbedding.ts";
import { emptyContract, type TaskContract } from "../agent/turnContract.ts";
import type { TurnIntent } from "../agent/turnContract.ts";

/**
 * What the semantic term would actually do, measured rather than assumed.
 *
 * The matcher has been wired in shadow for a slice now, and shadow was the
 * right place to put it: it observes the decision production already made and
 * cannot change it. What shadow has not answered is the question that decides
 * whether it should ever be promoted —
 *
 *     does this score separate the candidates at all?
 *
 * A term that returns nearly the same number for every model is not a weak
 * signal, it is no signal, and giving it weight would move the ranking by
 * whatever rounding noise sits on top of a flat distribution. So this asks a
 * spread of task profiles and reports the shape of what comes back: how far
 * apart the best and worst candidates are, how the shadow's order compares to
 * production's, and how much of the field is scored by a real curated profile
 * rather than by the cold-start constant.
 *
 *   node --env-file-if-exists=.env src/live/shadowDistribution.ts
 *
 * Costs one embedding call per distinct text, cached across tasks. No turn is
 * run, no workspace is touched and no model is asked to generate anything.
 */

interface Probe {
  id: string;
  goal: string;
  requirements: string[];
  intents: TurnIntent[];
  note: string;
}

/**
 * Tasks chosen to differ along the axes the semantic profile encodes — domain,
 * task type and language — because a distribution measured on near-identical
 * requests would be flat for reasons that have nothing to do with the matcher.
 */
const PROBES: Probe[] = [
  {
    id: "P1-korean-refactor",
    goal: "레거시 결제 모듈을 리팩터링한다",
    requirements: ["중복된 할인 계산 로직을 하나로 합친다", "기존 테스트가 모두 통과해야 한다"],
    intents: ["modify"],
    note: "coding · refactor · ko",
  },
  {
    id: "P2-english-debug",
    goal: "Find why the nightly ETL job drops rows",
    requirements: ["Reproduce the row loss", "Identify the failing stage"],
    intents: ["inspect", "verify"],
    note: "data · debugging · en",
  },
  {
    id: "P3-korean-analysis",
    goal: "이 저장소의 인증 흐름을 분석해서 설명한다",
    requirements: ["토큰 검증 경로를 정리한다"],
    intents: ["inspect", "present"],
    note: "security · analysis · ko",
  },
  {
    id: "P4-sql-migration",
    goal: "Migrate the reporting schema from MySQL to Postgres",
    requirements: ["Translate the stored procedures", "Keep column semantics identical", "Write a rollback"],
    intents: ["modify", "execute"],
    note: "database · migration · en",
  },
  {
    id: "P5-frontend",
    goal: "React 대시보드의 렌더링 성능을 개선한다",
    requirements: ["불필요한 리렌더를 제거한다", "번들 크기를 줄인다"],
    intents: ["modify", "verify"],
    note: "frontend · performance · ko",
  },
  {
    id: "P6-research",
    goal: "Compare three approaches to streaming ASR and recommend one",
    requirements: ["Summarise the latency trade-offs"],
    intents: ["research", "present"],
    note: "ml · research · en",
  },
  {
    id: "P7-devops",
    goal: "CI 파이프라인의 플레이키 테스트를 잡는다",
    requirements: ["재현 가능한 실패 조건을 찾는다", "격리해서 재실행한다"],
    intents: ["inspect", "execute", "verify"],
    note: "devops · flaky-tests · ko",
  },
  {
    id: "P8-docs",
    goal: "Write API reference documentation for the router package",
    requirements: ["Cover every exported function"],
    intents: ["present"],
    note: "docs · writing · en",
  },
];

function contractFor(probe: Probe): TaskContract {
  return {
    ...emptyContract(),
    goal: probe.goal,
    intents: probe.intents,
    requirements: probe.requirements.map((description, i) => ({
      id: `r${i + 1}`,
      description,
      required: true,
      provenance: { kind: "user" as const, turnId: "t1" },
      lifecycle: "active" as const,
    })) as unknown as TaskContract["requirements"],
    lastTurnId: "t1",
  };
}

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const section = (t: string): void => void out(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

function quantiles(values: number[]): { min: number; p50: number; max: number; spread: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const min = sorted[0] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  return { min, p50: at(0.5), max, spread: max - min };
}

/** Spearman's rho between two rankings of the same items. */
function spearman(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 2) return Number.NaN;
  const meanA = a.reduce((t, v) => t + v, 0) / n;
  const meanB = b.reduce((t, v) => t + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    const x = (a[i] ?? 0) - meanA;
    const y = (b[i] ?? 0) - meanB;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da === 0 || db === 0 ? Number.NaN : num / Math.sqrt(da * db);
}

const fmt = (v: number): string => (Number.isNaN(v) ? "  n/a" : v.toFixed(3).padStart(6));

// ---------------------------------------------------------------------------

const apiKey = process.env["HASA_API_KEY"] ?? "";
const baseUrl = process.env["HASA_BASE_URL"] ?? "";
if (apiKey.trim().length === 0) {
  out("HASA_API_KEY is not set. NOT RUN — no credential, and no distribution to report.");
  process.exit(2);
}

const provider = createHasaProvider({ apiKey, ...(baseUrl.length === 0 ? {} : { baseUrl }) });
const listing = await provider.listModels();

const catalog = new HasaCatalog(
  createMediaTransport({ origin: baseUrl.replace(/\/v1\/?$/, ""), apiKey }),
);
const converses = new Map<string, boolean>();
for (const entry of await catalog.all()) {
  if (!canConverse(entry.modality) || entry.callable === false) converses.set(entry.id, false);
}
for (const [id, value] of conversabilityFor({
  baseUrlFingerprint: fingerprint(baseUrl),
  credentialFingerprint: fingerprint(apiKey),
})) {
  converses.set(id, value);
}

const evidence = await loadEvidence({ baseUrl, now: Date.now() });
const registry = buildRegistry(listing.models, evidence.summaries, { converses });

out(`models     : ${registry.length}`);
out(`evidence   : ${evidence.unusable ?? `${evidence.summaries.length} model summaries applied`}`);
out(`probes     : ${PROBES.length}`);

// The matcher embeds the task through this closure rather than through the
// `task` argument, so it has to read the probe under test. A closure over a
// fixed probe made all eight rows identical — the same task text scored against
// the same model texts eight times — which looked like a flat distribution and
// was a flat input.
let current: Probe = PROBES[0]!;
const matcher = embeddingMatcher({
  provider: createHasaEmbeddingProvider({ apiKey, baseUrl }),
  taskSemantic: () => projectTaskSemanticProfile(contractFor(current)),
});

section("PER-PROBE DISTRIBUTION");
out("probe                 cand   raw min    p50    max spread   norm sp   rho  top1");

const allSpreads: number[] = [];
/** Spread among candidates that actually have a profile, which is the real question. */
const profiledSpreads: number[] = [];
const allRaw: number[] = [];
let scoredPerProbe = 0;
let candidatesPerProbe = 0;
const rhos: number[] = [];
let topOneAgreements = 0;
let measuredProbes = 0;
const statusMix: Record<string, number> = {};

for (const probe of PROBES) {
  current = probe;
  const contract = contractFor(probe);
  const task = projectTaskProfile(contract);
  const semantic = projectTaskSemanticProfile(contract);

  // Production first, exactly as the product runs it, with the neutral matcher.
  const production = await recommendModel(task, registry);

  const shadow = await evaluateShadow({
    task,
    taskSemantic: semantic,
    recommendation: production,
    profiles: registry,
    matcher: {
      explain: (t, m) => matcher.explain(t, m),
      cache: matcher.cache,
    },
  });

  if (shadow.status !== "measured" || shadow.candidates.length === 0) {
    out(`${probe.id.padEnd(21)} ${String(shadow.candidates.length).padStart(4)}   ${shadow.status} ${shadow.failure ?? ""}`);
    continue;
  }
  measuredProbes += 1;

  const raws = shadow.candidates.map((c) => c.rawCosine).filter((v): v is number => v !== null);
  const norms = shadow.candidates.map((c) => c.normalized);
  const q = quantiles(raws);
  const nq = quantiles(norms);
  allSpreads.push(q.spread);
  allRaw.push(...raws);

  const profiledRaws = shadow.candidates
    .filter((c) => c.profileStatus !== "cold_start" && c.rawCosine !== null)
    .map((c) => c.rawCosine!);
  if (profiledRaws.length >= 2) profiledSpreads.push(quantiles(profiledRaws).spread);
  scoredPerProbe = Math.max(scoredPerProbe, raws.length);
  candidatesPerProbe = Math.max(candidatesPerProbe, shadow.candidates.length);

  const rho = spearman(
    shadow.candidates.map((c) => c.shadowRank),
    shadow.candidates.map((c) => c.productionRank),
  );
  if (!Number.isNaN(rho)) rhos.push(rho);

  const agreed = shadow.shadowSelectedModelId === production.selected?.modelId;
  if (agreed) topOneAgreements += 1;

  for (const c of shadow.candidates) {
    statusMix[c.profileStatus] = (statusMix[c.profileStatus] ?? 0) + 1;
  }

  out(
    `${probe.id.padEnd(21)} ${String(shadow.candidates.length).padStart(4)}  ` +
      `${fmt(q.min)} ${fmt(q.p50)} ${fmt(q.max)} ${fmt(q.spread)}  ${fmt(nq.spread)} ${fmt(rho)}  ${agreed ? "same" : "DIFF"}`,
  );
}

section("ACROSS PROBES");
if (measuredProbes === 0) {
  out("Nothing was measured. No distribution to report.");
} else {
  const overall = quantiles(allRaw);
  const spreadQ = quantiles(allSpreads);
  const profiledQ = quantiles(profiledSpreads);
  const totalSlots = Object.values(statusMix).reduce((t, v) => t + v, 0);
  const coldSlots = statusMix["cold_start"] ?? 0;
  const coldShare = totalSlots === 0 ? 1 : coldSlots / totalSlots;

  out(`raw cosine overall     : min ${fmt(overall.min)}  p50 ${fmt(overall.p50)}  max ${fmt(overall.max)}`);
  out(`within-probe spread    : min ${fmt(spreadQ.min)}  p50 ${fmt(spreadQ.p50)}  max ${fmt(spreadQ.max)}`);
  out(`  ...profiled only     : min ${fmt(profiledQ.min)}  p50 ${fmt(profiledQ.p50)}  max ${fmt(profiledQ.max)}`);
  out(`shadow↔production rho  : per-probe mean ${fmt(rhos.reduce((t, v) => t + v, 0) / Math.max(1, rhos.length))}`);
  out(`top-1 agreement        : ${topOneAgreements}/${measuredProbes}`);
  out(`profile status mix     : ${Object.entries(statusMix).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  out(`cold-start share       : ${(coldShare * 100).toFixed(0)}% of candidate slots`);
  // The number the spread is actually computed over. A cold-start candidate has
  // no text to embed, so it has no cosine at all — it takes the constant and
  // sits outside every quantile above.
  out(`candidates with a cosine: ${scoredPerProbe} of ${candidatesPerProbe} per probe`);
  out(`embedding calls        : ${matcher.cache.calls}`);

  section("READING");
  // The order of these checks matters. A wide overall spread is not evidence
  // the term works if most of the field is scored by a constant: the gap is
  // then between "has a profile" and "does not", which is a fact about
  // curation coverage and not about semantic fit.
  if (coldShare >= 0.5) {
    out(`${(coldShare * 100).toFixed(0)}% of candidates carry no semantic profile and are scored by the`);
    out("cold-start constant. Whatever spread appears above is mostly the gap");
    out("between profiled and unprofiled models — a coverage measurement wearing");
    out("a similarity measurement's clothes.");
    out("VERDICT: keep in shadow. The blocker is curation, not the matcher.");
  } else if (profiledQ.p50 < 0.02) {
    out("Among candidates that do have a profile, the term does not separate them.");
    out("A spread this small is noise, and weighting it would move the ranking by");
    out("rounding error.");
    out("VERDICT: keep in shadow.");
  } else if (profiledQ.p50 < 0.08) {
    out("The term separates profiled candidates weakly. It carries some");
    out("information, not enough to outrank a measured capability score.");
    out("VERDICT: keep in shadow.");
  } else {
    out("The term separates profiled candidates. Whether that separation is");
    out("*correct* is a different question and needs labelled outcomes, not a");
    out("distribution.");
    out("VERDICT: candidate for a weighted trial, not for promotion.");
  }
}

section("INVARIANT");
// The claim the whole shadow design rests on, checked rather than asserted.
let changed = 0;
for (const probe of PROBES) {
  const task = projectTaskProfile(contractFor(probe));
  const a = await recommendModel(task, registry);
  const b = await recommendModel(task, registry);
  if (a.selected?.modelId !== b.selected?.modelId) changed += 1;
}
out(`production ranking is unaffected by the observation : ${changed === 0 ? "held" : `FAILED (${changed})`}`);
process.exit(changed === 0 ? 0 : 1);
