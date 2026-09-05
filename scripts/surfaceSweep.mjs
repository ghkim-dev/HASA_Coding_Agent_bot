/**
 * The models that are not chat models, measured on what each is actually for.
 *
 *     node --env-file-if-exists=.env scripts/surfaceSweep.mjs
 *     node --env-file-if-exists=.env scripts/surfaceSweep.mjs --surface rerank,pii
 *
 * `proposerSweep` scores the 18 chat models on the one task the designer uses a
 * model for. That leaves 17 models in the catalogue with nothing said about
 * them, and "we did not measure them" is a different sentence from "they do not
 * work" — so this asks each surface a question it can actually be wrong about.
 *
 * ## What is checked and what is not
 *
 * Where an answer has a right answer, it is checked: a reranker must put the
 * relevant document first, an embedder must place a paraphrase nearer than a
 * decoy, a PII detector must find the resident registration number and must not
 * flag the vendor's product name, a simulator must return the amplitudes the
 * circuit has. Those are pass/fail and they are reported as pass/fail.
 *
 * Image and video generation have no such answer here. Whether a diagram is a
 * good diagram is not something this script can decide, and a score invented for
 * it would be the most confident number in the report and the least earned. So
 * those surfaces get a contract check — something came back, it is the format it
 * claims to be, here is how long it took — and the report says that is all it is.
 *
 * ## Why the audio pair is one case and not two
 *
 * `melotts-ko` and `whisper-large-v3-turbo` are measured as a round trip:
 * synthesise a consulting sentence, transcribe it back, compare. Neither can be
 * checked alone without a recording nobody has, and the round trip is also the
 * shape a client actually asks for — record the workshop, get the minutes.
 * A failure does not say which of the two failed, and the report says so.
 */
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.HASA_BASE_URL ?? "https://open.hasa.re.kr/v1";
const KEY = process.env.HASA_API_KEY;
if (!KEY) {
  console.error("HASA_API_KEY 가 없습니다. .env 를 확인하십시오.");
  process.exit(2);
}
const JSON_HEADERS = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1];
};
const onlySurfaces = argOf("--surface")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;

/**
 * The gateway allows four calls at once and answers 429 past that.
 *
 * Recording a 429 as a failed case would report how busy the account was as
 * though it were a property of the model, so it waits and asks again.
 */
async function post(path, body, { raw = false } = {}) {
  const started = Date.now();
  const send = () =>
    fetch(`${BASE}${path}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });
  let r = await send();
  for (let attempt = 1; attempt <= 4 && r.status === 429; attempt += 1) {
    await r.text();
    await new Promise((res) => setTimeout(res, 3000 * attempt));
    r = await send();
  }
  const ms = Date.now() - started;
  if (!r.ok) return { ok: false, ms, why: `HTTP ${r.status} ${(await r.text()).replace(/\s+/g, " ").slice(0, 120)}` };
  if (raw) return { ok: true, ms, bytes: new Uint8Array(await r.arrayBuffer()) };
  return { ok: true, ms, json: await r.json() };
}

/** Bigram coverage, the same comparison `proposerMetrics` uses, for the same reason. */
function coverage(want, said) {
  const w = want.replace(/\s+/gu, "");
  const s = said.replace(/\s+/gu, "");
  if (w.length < 2) return s.includes(w) ? 1 : 0;
  let hit = 0;
  for (let i = 0; i + 2 <= w.length; i += 1) if (s.includes(w.slice(i, i + 2))) hit += 1;
  return hit / (w.length - 1);
}

// ---------------------------------------------------------------------------
// 임베딩 — 요구사항 검색. 같은 요구를 다르게 쓴 문장이, 다른 단계의 문장보다
// 가까워야 한다. 가깝다는 말에 절대 기준은 없으므로 비교로만 묻는다.
// ---------------------------------------------------------------------------
const EMBEDDING_CASES = [
  {
    id: "e-migration",
    anchor: "레거시 ERP를 클라우드로 단계적으로 이관한다",
    near: "온프레미스 전사자원관리 시스템을 클라우드로 순차 전환한다",
    far: "신규 채용자 온보딩 교육 과정을 개편한다",
  },
  {
    id: "e-cost",
    anchor: "워크로드별 클라우드 지출을 월 단위로 배분한다",
    near: "서비스마다 클라우드 비용이 얼마나 나가는지 매달 나눠 본다",
    far: "사옥 출입 통제 장비를 교체한다",
  },
  {
    id: "e-governance",
    anchor: "데이터 접근 권한을 직무 기준으로 다시 설계한다",
    near: "역할 기반 접근 제어 정책을 새로 수립한다",
    far: "고객 상담 콜센터의 응대 대본을 다듬는다",
  },
  {
    id: "e-incident",
    anchor: "결제 API 장애의 근본 원인을 규명한다",
    near: "결제 인터페이스에서 발생한 오류의 원인을 찾아낸다",
    far: "연말 정산 서류 제출 절차를 안내한다",
  },
  {
    id: "e-roadmap",
    anchor: "3개년 디지털 전환 로드맵의 단계별 투자 규모를 산정한다",
    near: "향후 3년 DX 추진 계획에 들어갈 연차별 예산을 계산한다",
    far: "구내 식당 위탁 업체 계약을 갱신한다",
  },
];

const dot = (a, b) => a.reduce((n, x, i) => n + x * (b[i] ?? 0), 0);
const norm = (a) => Math.sqrt(dot(a, a));
const cosine = (a, b) => dot(a, b) / (norm(a) * norm(b) || 1);

async function runEmbedding(modelId) {
  const rows = [];
  for (const k of EMBEDDING_CASES) {
    const r = await post("/embeddings", { model: modelId, input: [k.anchor, k.near, k.far] });
    if (!r.ok) {
      rows.push({ id: k.id, pass: false, why: r.why, ms: r.ms });
      continue;
    }
    const v = r.json.data.map((d) => d.embedding);
    if (v.length !== 3) {
      rows.push({ id: k.id, pass: false, why: `벡터 ${v.length}개`, ms: r.ms });
      continue;
    }
    const near = cosine(v[0], v[1]);
    const far = cosine(v[0], v[2]);
    rows.push({
      id: k.id,
      pass: near > far,
      why: `가까움 ${near.toFixed(3)} vs 먼것 ${far.toFixed(3)}`,
      ms: r.ms,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 재순위 — 컨설팅 산출물 더미에서 질의에 맞는 문서를 1위로 올리는가.
// 오답 후보는 '같은 낱말을 공유하되 답이 아닌 것'으로 골랐다. 관계없는 문장만
// 섞으면 아무 모델이나 통과하고, 그런 시험은 아무것도 가르지 못한다.
// ---------------------------------------------------------------------------
const RERANK_CASES = [
  {
    id: "r-priority",
    query: "이관 우선순위를 정하는 근거가 담긴 문서",
    docs: [
      "모듈별 상호 의존성과 장애 영향도를 비교해 이관 순서를 제시한 표",
      "이관 작업 당일의 담당자 연락망과 비상 연락 절차",
      "클라우드 이관 프로젝트 킥오프 회의록",
      "이관 완료 후 사용자 만족도 설문 결과",
    ],
    best: 0,
  },
  {
    id: "r-cost",
    query: "클라우드 비용이 예산을 넘긴 원인 분석",
    docs: [
      "월별 클라우드 청구서 원본 PDF 목록",
      "미사용 GPU 인스턴스가 상시 기동되어 초과분의 62%를 차지했다는 분석",
      "클라우드 도입 시 기대했던 절감 효과를 정리한 초기 제안서",
      "비용 승인 권한을 가진 부서장 명단",
    ],
    best: 1,
  },
  {
    id: "r-compliance",
    query: "망분리 규제가 우리 시스템에 적용되는지 판단한 자료",
    docs: [
      "금융위 망분리 개선 가이드라인 전문",
      "사내 네트워크 장비 구매 이력",
      "당사 업무망 구성이 가이드라인 제3조 예외 요건에 해당하는지 검토한 의견서",
      "망분리 관련 언론 보도 스크랩",
    ],
    best: 2,
  },
  {
    id: "r-incident",
    query: "결제 지연 장애의 재발 방지 대책",
    docs: [
      "장애 당시 결제 API 응답 시간 그래프",
      "고객사가 보낸 항의 메일 모음",
      "결제 담당 조직의 인력 현황",
      "커넥션 풀 상한 조정과 회로 차단기 도입을 담은 개선 계획",
    ],
    best: 3,
  },
  {
    id: "r-vendor",
    query: "특정 벤더에 묶이지 않게 하는 설계 방안",
    docs: [
      "표준 인터페이스 계층을 두어 벤더 교체 비용을 낮추는 아키텍처 제안",
      "현재 벤더와의 유지보수 계약서",
      "벤더 담당 영업 대표의 소개 자료",
      "벤더 제품의 기능 목록",
    ],
    best: 0,
  },
];

async function runRerank(modelId) {
  const rows = [];
  for (const k of RERANK_CASES) {
    const r = await post("/rerank", { model: modelId, query: k.query, documents: k.docs });
    if (!r.ok) {
      rows.push({ id: k.id, pass: false, why: r.why, ms: r.ms });
      continue;
    }
    const top = r.json.results?.[0]?.index;
    rows.push({
      id: k.id,
      pass: top === k.best,
      why: `1위 ${top} (정답 ${k.best})`,
      ms: r.ms,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// PII — 컨설팅 산출물을 고객사 밖으로 내보내기 전에 지워야 할 것.
// 찾아야 할 것과 '건드리면 안 되는 것'을 함께 묻는다. 다 지우는 검출기는
// 아무것도 못 지우는 검출기만큼 못 쓴다.
// ---------------------------------------------------------------------------
const PII_CASES = [
  {
    id: "i-interview",
    text: "인터뷰 대상: 재무팀 김민수 팀장 (010-2345-6789). 발언 요지는 ERP 결산 마감이 3일 지연된다는 것.",
    kinds: ["NAME", "PHONE"],
    keep: ["ERP"],
  },
  {
    id: "i-account",
    text: "정산 계좌는 국민은행 123456-78-901234 이며, 담당자 이메일은 pm.lee@example.co.kr 입니다.",
    kinds: ["ACCOUNT", "EMAIL"],
    keep: ["국민은행"],
  },
  {
    id: "i-rrn",
    text: "위탁 계약 첨부 서류에 박지훈(880303-1234567)의 주민등록번호가 그대로 남아 있습니다.",
    kinds: ["NAME", "RRN"],
    keep: ["위탁 계약"],
  },
  {
    id: "i-clean",
    text: "본 보고서는 Kubernetes 1.29 와 PostgreSQL 16 을 기준으로 작성되었으며 개인정보를 포함하지 않습니다.",
    kinds: [],
    keep: ["Kubernetes", "PostgreSQL"],
  },
  {
    // 처음 이 사례의 답을 PHONE 으로 적었고, 그쪽이 틀렸다. pii-ko 는 휴대폰을
    // PHONE, 유선을 TEL 로 나눠 답한다 — 02 번호를 못 찾은 것이 아니라 다른
    // 이름으로 찾은 것이었다. 그리고 그 구분은 옳다. 비식별 작업에서 개인의
    // 휴대폰과 회사 대표 회선은 지워야 할 이유가 다르다.
    id: "i-mixed",
    text: "장애 보고 회선: 02-1234-5678, 신고자 최유진 대리, 영향 시스템은 SAP S/4HANA 입니다.",
    kinds: ["NAME", "TEL"],
    keep: ["SAP"],
  },
];

async function runPii(modelId) {
  const rows = [];
  for (const k of PII_CASES) {
    const r = await post("/pii/detect", { model: modelId, text: k.text });
    if (!r.ok) {
      rows.push({ id: k.id, pass: false, why: r.why, ms: r.ms });
      continue;
    }
    const found = r.json.results ?? [];
    const kinds = new Set(found.map((f) => f.kind));
    const missing = k.kinds.filter((want) => !kinds.has(want));
    // 지우면 안 되는 것을 지웠는가. 겹치기만 해도 오검출로 센다.
    const wrongly = k.keep.filter((keep) => found.some((f) => String(f.text).includes(keep)));
    const extra = k.kinds.length === 0 ? found.length : 0;
    rows.push({
      id: k.id,
      pass: missing.length === 0 && wrongly.length === 0 && extra === 0,
      why:
        missing.length > 0
          ? `못 찾음 ${missing.join(",")}`
          : wrongly.length > 0
            ? `건드리면 안 될 것을 잡음 ${wrongly.join(",")}`
            : extra > 0
              ? `깨끗한 문장에서 ${extra}건 오검출`
              : `찾음 ${[...kinds].join(",") || "없음(정답)"}`,
      ms: r.ms,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 양자 — 최적화 PoC 타당성 확인. 정답이 해석적으로 정해지는 회로만 쓴다.
// "돌아갔다"가 아니라 "맞는 값을 냈다"를 물어야 시험이 된다.
// ---------------------------------------------------------------------------
const QUANTUM_CASES = [
  { id: "q-bell", qubits: 2, circuit: [{ op: "h", targets: [0] }, { op: "cx", targets: [1], controls: [0] }], probs: { "00": 0.5, "11": 0.5 }, observable: "ZI", expectation: 0 },
  { id: "q-super", qubits: 1, circuit: [{ op: "h", targets: [0] }], probs: { 0: 0.5, 1: 0.5 }, observable: "Z", expectation: 0 },
  { id: "q-flip", qubits: 1, circuit: [{ op: "x", targets: [0] }], probs: { 1: 1 }, observable: "Z", expectation: -1 },
  { id: "q-idle", qubits: 2, circuit: [], probs: { "00": 1 }, observable: "ZI", expectation: 1 },
  {
    id: "q-ghz",
    qubits: 3,
    circuit: [
      { op: "h", targets: [0] },
      { op: "cx", targets: [1], controls: [0] },
      { op: "cx", targets: [2], controls: [0] },
    ],
    probs: { "000": 0.5, "111": 0.5 },
    observable: "ZII",
    expectation: 0,
  },
];

const QUANTUM_ROUTES = {
  "cuquantum-statevector": { path: "/quantum/statevector", read: (j) => j.top_amplitudes },
  "cuquantum-tensornet": { path: "/quantum/tensornet", read: (j) => j.top_amplitudes },
  "cuquantum-densitymatrix": { path: "/quantum/densitymatrix", read: (j) => j.populations },
  "cuquantum-expectation": { path: "/quantum/expectation", read: null },
};

const CLOSE = 1e-6;

async function runQuantum(modelId) {
  const route = QUANTUM_ROUTES[modelId];
  const rows = [];
  for (const k of QUANTUM_CASES) {
    const body = { model: modelId, qubits: k.qubits, circuit: k.circuit };
    if (route.read === null) body.observable = k.observable;
    const r = await post(route.path, body);
    if (!r.ok) {
      rows.push({ id: k.id, pass: false, why: r.why, ms: r.ms });
      continue;
    }
    if (route.read === null) {
      const got = r.json.expectation;
      rows.push({
        id: k.id,
        pass: Math.abs(got - k.expectation) < CLOSE,
        why: `⟨${k.observable}⟩ ${got} (정답 ${k.expectation})`,
        ms: r.ms,
      });
      continue;
    }
    const amps = route.read(r.json) ?? [];
    const got = Object.fromEntries(amps.map((a) => [String(a.basis), a.prob]));
    const wrong = Object.entries(k.probs).filter(
      ([basis, p]) => Math.abs((got[basis] ?? 0) - p) > CLOSE,
    );
    // 정답에 없는 기저에 확률이 실렸는지도 본다. 맞는 것만 세면 절반만 보는 것이다.
    const leaked = Object.entries(got).filter(
      ([basis, p]) => k.probs[basis] === undefined && p > CLOSE,
    );
    rows.push({
      id: k.id,
      pass: wrong.length === 0 && leaked.length === 0,
      why:
        wrong.length > 0
          ? `틀림 ${wrong.map(([b, p]) => `${b}:${(got[b] ?? 0).toFixed(4)}≠${p}`).join(" ")}`
          : leaked.length > 0
            ? `없어야 할 기저에 확률 ${leaked.map(([b, p]) => `${b}:${p.toFixed(4)}`).join(" ")}`
            : `${Object.keys(k.probs).join("/")} 정확`,
      ms: r.ms,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 음성 왕복 — 워크숍을 녹음해서 회의록을 받는, 컨설팅이 실제로 시키는 모양.
// 실패해도 둘 중 누구 탓인지 이 시험은 말하지 못한다. 그래서 한 줄로 보고한다.
// ---------------------------------------------------------------------------
/**
 * Said, and what a correct transcript of it reads like.
 *
 * The two differ on purpose. A round trip legitimately normalises — "사십
 * 퍼센트" is spoken and comes back "40%", "에이피아이" comes back "API" — and
 * the first version of this table compared against the spoken form, so a
 * correct transcript scored 64% and was reported as a failure of whisper. The
 * expected form is what a person taking minutes would write.
 */
const SPEECH_CASES = [
  { say: "클라우드 이관 우선순위를 다음 주까지 정해 주세요.", expect: "클라우드 이관 우선순위를 다음 주까지 정해주세요." },
  { say: "작년 클라우드 비용이 예산을 사십 퍼센트 초과했습니다.", expect: "작년 클라우드 비용이 예산을 40% 초과했습니다." },
  { say: "데이터 접근 권한 정책을 새로 설계해 주세요.", expect: "데이터 접근 권한 정책을 새로 설계해 주세요." },
  { say: "결제 에이피아이 장애의 재발 방지 대책이 필요합니다.", expect: "결제 API 장애 재발 방지 대책이 필요합니다." },
  { say: "삼 개년 디지털 전환 로드맵을 수립해 주세요.", expect: "3개년 디지털 전환 로드맵을 수립해 주세요." },
];

/** How much of the spoken sentence has to survive the round trip to count. */
const ROUND_TRIP_COVERAGE = 0.7;

async function runSpeechRoundTrip() {
  const rows = [];
  for (const [i, k] of SPEECH_CASES.entries()) {
    const spoken = await post("/audio/speech", { model: "melotts-ko", input: k.say, voice: "KR" }, { raw: true });
    if (!spoken.ok) {
      rows.push({ id: `s-${i + 1}`, pass: false, why: `합성 실패 ${spoken.why}`, ms: spoken.ms });
      continue;
    }
    // 300KB 남짓한 업로드가 이따금 ECONNRESET 으로 끊긴다. 한 번은 다시 걸어
    // 본다 — 끊긴 연결을 모델의 실패로 적으면 없는 결함을 보고하게 된다.
    const started = Date.now();
    let r = null;
    let lastWhy = "";
    for (let attempt = 1; attempt <= 2 && r === null; attempt += 1) {
      const form = new FormData();
      form.append("model", "whisper-large-v3-turbo");
      form.append("language", "ko");
      form.append("file", new Blob([spoken.bytes], { type: "audio/wav" }), "utterance.wav");
      try {
        r = await fetch(`${BASE}/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${KEY}` },
          body: form,
          signal: AbortSignal.timeout(300_000),
        });
      } catch (err) {
        lastWhy = String(err.cause ?? err).replace(/\s+/g, " ").slice(0, 90);
      }
    }
    const ms = spoken.ms + (Date.now() - started);
    if (r === null) {
      rows.push({ id: `s-${i + 1}`, pass: false, why: `전사 연결 실패 ${lastWhy}`, ms });
      continue;
    }
    if (!r.ok) {
      rows.push({ id: `s-${i + 1}`, pass: false, why: `전사 실패 HTTP ${r.status}`, ms });
      continue;
    }
    const heard = String((await r.json()).text ?? "");
    const c = coverage(k.expect, heard);
    rows.push({
      id: `s-${i + 1}`,
      pass: c >= ROUND_TRIP_COVERAGE,
      why: `일치 ${Math.round(c * 100)}% «${heard.replace(/\s+/g, " ").slice(0, 40)}»`,
      ms,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 이미지·영상 — 계약만 본다. 좋은 그림인지는 이 스크립트가 판단할 수 없고,
// 판단한 척한 숫자는 보고서에서 가장 자신 있고 가장 근거 없는 줄이 된다.
// ---------------------------------------------------------------------------
const VISUAL_PROMPTS = [
  "a clean three-tier architecture diagram, boxes and arrows, white background, no text",
  "a flat isometric illustration of a data center migrating to cloud, muted corporate palette",
  "a simple bar chart shape showing five ascending bars, minimal, white background",
  "an abstract network topology graphic in navy and grey, suitable for a consulting deck cover",
  "a minimal timeline graphic with five milestone markers, horizontal, white background",
];

const PNG = [0x89, 0x50, 0x4e, 0x47];

async function runImage(modelId) {
  const rows = [];
  for (const [i, prompt] of VISUAL_PROMPTS.entries()) {
    const body = { model: modelId, prompt, size: "512x512" };
    const r = await post("/images/generations", body);
    if (!r.ok) {
      rows.push({ id: `v-${i + 1}`, pass: false, why: r.why, ms: r.ms });
      continue;
    }
    const b64 = r.json.data?.[0]?.b64_json;
    if (typeof b64 !== "string" || b64.length === 0) {
      rows.push({ id: `v-${i + 1}`, pass: false, why: "b64_json 이 없다", ms: r.ms });
      continue;
    }
    const head = [...Buffer.from(b64.slice(0, 12), "base64").subarray(0, 4)];
    rows.push({
      id: `v-${i + 1}`,
      pass: PNG.every((b, n) => head[n] === b),
      why: `${Math.round((b64.length * 3) / 4 / 1024)}KB · PNG 서명 ${PNG.every((b, n) => head[n] === b) ? "맞음" : "아님"}`,
      ms: r.ms,
    });
  }
  return rows;
}

/** Statuses that mean the job has stopped moving, whichever way it went. */
const TERMINAL = new Set(["COMPLETED", "SUCCEEDED", "SUCCESS", "DONE", "FAILED", "ERROR", "CANCELLED"]);

/**
 * Video generation is asynchronous — the POST returns a job, not a file.
 *
 * The first version of this read `data[0]` out of that response, found nothing,
 * and reported both video models as 0/2. They had not failed; the script had
 * mistaken a queue ticket for an asset. Reading the job through to a terminal
 * state is the contract, so that is what is checked.
 */
/**
 * A reference image, made here rather than committed.
 *
 * `Qwen-Image-Edit` and `wan2.2-i2v` both refuse to work without one, and an
 * earlier version of this sweep listed them as unreachable for that reason —
 * which was true of the sweep, not of the models. `Qwen-Image` produces one, so
 * the sweep makes its own. It must be a `data:` URL; raw base64 is refused.
 */
let referenceImage = null;
async function reference() {
  if (referenceImage !== null) return referenceImage;
  const r = await post("/images/generations", {
    model: "Qwen-Image",
    prompt: "a plain white rectangle on a light grey background, flat, no text",
    size: "512x512",
  });
  if (!r.ok) throw new Error(`기준 이미지를 만들지 못했다: ${r.why}`);
  referenceImage = `data:image/png;base64,${r.json.data[0].b64_json}`;
  return referenceImage;
}

async function runImageEdit(modelId) {
  const rows = [];
  const EDITS = [
    "recolour the rectangle to corporate navy",
    "add a thin border around the rectangle",
    "make the background white",
  ];
  const ref = await reference();
  for (const [i, prompt] of EDITS.entries()) {
    const r = await post("/images/generations", { model: modelId, prompt, reference: ref });
    if (!r.ok) {
      rows.push({ id: `x-${i + 1}`, pass: false, why: r.why, ms: r.ms });
      continue;
    }
    const b64 = r.json.data?.[0]?.b64_json;
    const head = typeof b64 === "string" ? [...Buffer.from(b64.slice(0, 12), "base64").subarray(0, 4)] : [];
    const ok = PNG.every((b, n) => head[n] === b);
    rows.push({
      id: `x-${i + 1}`,
      pass: ok,
      why: ok ? `${Math.round((b64.length * 3) / 4 / 1024)}KB · PNG` : "PNG 가 아니다",
      ms: r.ms,
    });
  }
  return rows;
}

async function runVideo(modelId) {
  const rows = [];
  // 한 편에 십수 초씩 걸린다. 다섯 편이면 남의 GPU 를 오래 잡는데, 계약만 보는
  // 시험에서 그럴 이유가 없다. 두 편으로 줄였고 줄였다는 사실을 여기 적는다.
  for (const [i, prompt] of VISUAL_PROMPTS.slice(0, 2).entries()) {
    const started = Date.now();
    try {
      rows.push(await oneVideo(modelId, prompt, i, started));
    } catch (err) {
      // 한 편이 끊겼다고 나머지를 안 재면, 재지 않은 것이 실패한 것처럼 보인다.
      rows.push({
        id: `w-${i + 1}`,
        pass: false,
        why: String(err.cause ?? err).replace(/\s+/g, " ").slice(0, 110),
        ms: Date.now() - started,
      });
    }
  }
  return rows;
}

async function oneVideo(modelId, prompt, i, started) {
  const id = `w-${i + 1}`;
  const body = { model: modelId, prompt };
  // i2v 는 기준 이미지가 있어야 한다. 없다고 '닿지 않는 모델' 로 적는 것은
  // 모델이 아니라 이 스크립트에 대한 보고다.
  if (modelId === "wan2.2-i2v") body.image = await reference();
  const r = await post("/videos/generations", body);
  if (!r.ok) return { id, pass: false, why: r.why, ms: r.ms };

  const jobId = r.json.job_id;
  if (typeof jobId !== "string") {
    return { id, pass: false, why: `job_id 가 없다: ${JSON.stringify(r.json).slice(0, 90)}`, ms: r.ms };
  }

  let job = r.json;
  for (let tick = 0; tick < 60 && !TERMINAL.has(String(job.status).toUpperCase()); tick += 1) {
    await new Promise((res) => setTimeout(res, 5000));
    const poll = await fetch(`${BASE}/jobs/${jobId}`, { headers: JSON_HEADERS });
    if (!poll.ok) break;
    job = await poll.json();
  }
  const ms = Date.now() - started;
  const url = job.artifact_url;
  if (String(job.status).toUpperCase() !== "COMPLETED" || typeof url !== "string") {
    return { id, pass: false, why: `${job.status} · 진행 ${job.progress ?? "?"}%`, ms };
  }

  // 링크가 났다고 파일이 있는 것은 아니다. 실제로 받아 보고 컨테이너를 본다.
  const file = await fetch(new URL(url, BASE).href, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!file.ok) return { id, pass: false, why: `자산 내려받기 HTTP ${file.status}`, ms };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const container = containerOf(bytes);
  return {
    id,
    pass: container !== null,
    why: `${Math.round(bytes.length / 1024)}KB · ${container ?? "알 수 없는 컨테이너"} · ${url}`,
    ms,
  };
}

/**
 * Which video container the bytes actually are.
 *
 * The first version accepted only MP4 and reported `Wan2.2-T2V` as 0/2. It was
 * producing WebM, which is a video — the check was wrong, not the model. But
 * the answer is not to stop looking: which container comes back is a fact a
 * consulting team needs before the clip goes in a deck, so it is reported
 * rather than normalised away.
 */
function containerOf(bytes) {
  if (String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp") return "MP4";
  const ebml = [0x1a, 0x45, 0xdf, 0xa3];
  if (ebml.every((b, i) => bytes[i] === b)) return "WebM/Matroska";
  return null;
}

// ---------------------------------------------------------------------------

const SURFACES = [
  { name: "embedding", label: "임베딩 (요구사항 검색)", models: ["bge-m3", "nemotron-embed-8b"], run: runEmbedding, cases: 5, judged: true },
  { name: "rerank", label: "재순위 (산출물 검색)", models: ["bge-reranker-v2-m3", "bge-reranker-v2-m3-ko"], run: runRerank, cases: 5, judged: true },
  { name: "pii", label: "PII (산출물 비식별)", models: ["pii-ko"], run: runPii, cases: 5, judged: true },
  { name: "quantum", label: "양자 (최적화 PoC 타당성)", models: Object.keys(QUANTUM_ROUTES), run: runQuantum, cases: 5, judged: true },
  { name: "speech", label: "음성 왕복 (워크숍 회의록)", models: ["melotts-ko + whisper-large-v3-turbo"], run: runSpeechRoundTrip, cases: 5, judged: true },
  { name: "image", label: "이미지 (제안서 시각자료)", models: ["Qwen-Image"], run: runImage, cases: 5, judged: false },
  { name: "imageedit", label: "이미지 편집 (기존 도식 수정)", models: ["Qwen-Image-Edit"], run: runImageEdit, cases: 3, judged: false },
  { name: "video", label: "영상 (제안서 시각자료)", models: ["LTX-2", "Wan2.2-T2V", "wan2.2-i2v"], run: runVideo, cases: 2, judged: false },
];

/**
 * Models the catalogue lists that this sweep does not reach, and why.
 *
 * One entry, and it is not about a missing input. `groot-n17-3b` is returned by
 * `GET /v1/models` and refused by every route the gateway has — chat,
 * embeddings, images, videos, speech, rerank, quantum, and the code-review
 * template, all 404. So the catalogue promises a model nothing serves.
 */
const UNREACHED = [
  ["groot-n17-3b", "GET /v1/models 에는 있으나 확인된 모든 경로가 404 다 — 카탈로그에만 있는 모델."],
];

const results = [];
for (const surface of SURFACES) {
  if (onlySurfaces !== null && !onlySurfaces.includes(surface.name)) continue;
  console.log(`\n=== ${surface.label}${surface.judged ? "" : " — 계약만 확인, 품질은 재지 않음"} ===`);
  for (const modelId of surface.models) {
    // 한 표면이 던진 예외가 스윕 전체를 끝내면, 그 뒤 표면들은 측정되지 않은
    // 채로 보고에서 사라진다. 없는 줄과 실패한 줄은 다르다.
    let rows;
    try {
      rows = await surface.run(modelId);
    } catch (err) {
      rows = [{ id: "(예외)", pass: false, why: String(err.cause ?? err).replace(/\s+/g, " ").slice(0, 120), ms: 0 }];
    }
    const pass = rows.filter((r) => r.pass).length;
    results.push({ surface: surface.name, modelId, pass, of: rows.length, rows });
    console.log(`  ${modelId.padEnd(34)} ${pass}/${rows.length}`);
    for (const row of rows) {
      console.log(`      ${row.pass ? "✔" : "✘"} ${row.id.padEnd(12)} ${String(row.ms).padStart(6)}ms  ${row.why}`);
    }
  }
}

const judged = results.filter((r) => SURFACES.find((s) => s.name === r.surface)?.judged === true);
const contractOnly = results.filter((r) => SURFACES.find((s) => s.name === r.surface)?.judged === false);
const sum = (rows) => rows.reduce((n, r) => n + r.pass, 0);
const den = (rows) => rows.reduce((n, r) => n + r.of, 0);

console.log(`\n=== 합계 ===`);
console.log(`  정답이 있는 표면: ${sum(judged)}/${den(judged)} 통과`);
console.log(`  계약만 본 표면  : ${sum(contractOnly)}/${den(contractOnly)} 응답 (품질 아님)`);
console.log(`\n=== 이번 스윕이 닿지 않은 모델 ===`);
for (const [id, why] of UNREACHED) console.log(`  ${id.padEnd(20)} ${why}`);

mkdirSync(".probe", { recursive: true });
writeFileSync(".probe/surfaceSweep.json", `${JSON.stringify({ results, unreached: UNREACHED }, null, 1)}\n`);
console.log(`\n.probe/surfaceSweep.json 에 기록했습니다.`);
