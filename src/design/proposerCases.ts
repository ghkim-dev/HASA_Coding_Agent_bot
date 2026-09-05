import { buildProposerCase, type ProposerCase } from "./proposerMetrics.ts";

/**
 * Consulting requests a proposer is asked to find requirements in.
 *
 * ## Why these sentences and not the ones already in the repo
 *
 * `consultingCases` scores the *extractor*: one act, one target, read by rule
 * from a short sentence. A proposer is asked something else — read a paragraph
 * a client actually sent, and point at every passage that states a requirement.
 * So these are longer, they carry more than one requirement each, and several
 * contain a sentence that states none, because a proposer that returns one
 * candidate per sentence scores the same as a good one unless the corpus
 * contains sentences that must be left alone.
 *
 * ## What a `want` is
 *
 * The words a requirement is grounded in — not the requirement. Two proposers
 * naming the same requirement will write it differently and both be right; what
 * can be checked is whether the coordinates land on the passage that states it.
 * Each quote appears exactly once in its text, which `buildProposerCase`
 * enforces, so "did it point here" has one answer.
 *
 * ## What is deliberately not measured
 *
 * `kind`, `priority` and `polarity`. The instructions ask for them and the
 * runtime keeps them, but this corpus has no gold for them, and inventing one
 * would mean writing down my reading of "must vs should" as though a client's
 * phrasing settled it. A separate corpus with an argued rubric is what would
 * change that. Until then the honest report is that these fields are collected
 * and not scored — see the sweep's own output, which says so.
 *
 * The domain is IT and digital transformation throughout, because that is where
 * the sentences this harness has to survive come from: migration, governance,
 * cost, incident response, vendor lock-in.
 */

export interface ConsultingProposerCase {
  /** The phase of an engagement this request arrives in. */
  phase: "diagnose" | "roadmap" | "migrate" | "govern" | "operate";
  /** Why the case is in the corpus — what shape it puts in front of a model. */
  why: string;
  testCase: ProposerCase;
}

const c = (input: {
  id: string;
  phase: ConsultingProposerCase["phase"];
  why: string;
  text: string;
  quotes: readonly string[];
}): ConsultingProposerCase => ({
  phase: input.phase,
  why: input.why,
  testCase: buildProposerCase({
    turnId: input.id,
    text: input.text,
    wants: input.quotes.map((quote) => ({ quote })),
  }),
});

export const PROPOSER_CASES: readonly ConsultingProposerCase[] = [
  // --- 진단 -----------------------------------------------------------------
  c({
    id: "p-diagnose-legacy",
    phase: "diagnose",
    why: "요구사항 둘이 한 문단에. 앞 문장은 배경일 뿐 요구가 아니다.",
    text:
      "저희 그룹은 2011년에 도입한 ERP를 아직 쓰고 있습니다. " +
      "먼저 현재 아키텍처의 병목 지점을 분석해 주시고, " +
      "이관 대상 모듈의 우선순위를 정해 주세요.",
    quotes: ["현재 아키텍처의 병목 지점을 분석해", "이관 대상 모듈의 우선순위를 정해"],
  }),
  c({
    id: "p-diagnose-cost",
    phase: "diagnose",
    why: "숫자가 요구 안에 들어 있다. 범위를 잘라내면 요구가 달라진다.",
    text:
      "작년 클라우드 비용이 예산을 40% 초과했습니다. " +
      "초과분이 어느 워크로드에서 나왔는지 확인해 주세요. " +
      "참고로 계약은 내년 3월에 만료됩니다.",
    quotes: ["초과분이 어느 워크로드에서 나왔는지 확인해"],
  }),
  c({
    id: "p-diagnose-nothing",
    phase: "diagnose",
    why: "요구가 하나도 없는 문단. 후보를 만들어내면 지어낸 것이다.",
    text:
      "저희는 제조 계열사 일곱 곳을 두고 있고, 그중 셋은 아직 온프레미스입니다. " +
      "IT 인력은 본사에 스물두 명 있습니다.",
    quotes: [],
  }),

  // --- 로드맵 ---------------------------------------------------------------
  c({
    id: "p-roadmap-phased",
    phase: "roadmap",
    why: "요구 셋이 나열로 붙어 있다. 하나로 뭉뚱그리면 지목이 하나 빈다.",
    text:
      "3개년 디지털 전환 로드맵을 수립해 주시고, " +
      "단계별 투자 규모를 산정해 주시고, " +
      "경영진 보고용 요약본을 따로 작성해 주세요.",
    quotes: [
      "3개년 디지털 전환 로드맵을 수립해",
      "단계별 투자 규모를 산정해",
      "경영진 보고용 요약본을 따로 작성해",
    ],
  }),
  c({
    id: "p-roadmap-prohibition",
    phase: "roadmap",
    why: "금지가 요구다. 하라는 것만 찾는 제안자는 여기서 반을 놓친다.",
    text:
      "후보 솔루션을 비교해 주세요. " +
      "다만 특정 벤더의 제품명을 결론에 넣지는 말아 주세요.",
    quotes: ["후보 솔루션을 비교해", "특정 벤더의 제품명을 결론에 넣지는 말아"],
  }),

  // --- 이관 -----------------------------------------------------------------
  c({
    id: "p-migrate-order",
    phase: "migrate",
    why: "조건절이 앞에 붙어 있다. 조건을 요구로 세면 지어낸 것이 하나 는다.",
    text:
      "만약 downtime 이 4시간을 넘을 것 같으면, " +
      "회원 데이터를 먼저 신규 DB로 이관해 주세요.",
    quotes: ["회원 데이터를 먼저 신규 DB로 이관해"],
  }),
  c({
    id: "p-migrate-correction",
    phase: "migrate",
    why: "앞말을 뒤집는 문장. 취소된 요구를 후보로 내면 틀린 것이다.",
    text:
      "아까 말씀드린 일괄 전환은 취소하겠습니다. " +
      "대신 파일럿 대상 부서를 한 곳만 골라 주세요.",
    quotes: ["파일럿 대상 부서를 한 곳만 골라"],
  }),

  // --- 거버넌스 -------------------------------------------------------------
  c({
    id: "p-govern-policy",
    phase: "govern",
    why: "요구 둘 중 하나가 문서 산출물, 하나가 검증. 종류가 다르다.",
    text:
      "데이터 접근 권한 정책을 새로 설계해 주시고, " +
      "현행 계정이 그 정책을 지키고 있는지 검증해 주세요.",
    quotes: ["데이터 접근 권한 정책을 새로 설계해", "현행 계정이 그 정책을 지키고 있는지 검증해"],
  }),
  c({
    id: "p-govern-source",
    phase: "govern",
    why: "출처를 읽으라는 요구. 읽고 옮기는 것과 판단하는 것은 다른 요구다.",
    text:
      "금융위가 올해 낸 망분리 개선 가이드라인을 확인하고, " +
      "저희 상황에 해당되는 조항만 정리해 주세요. " +
      "해석은 붙이지 말고 원문 그대로 옮겨 주세요.",
    quotes: [
      "금융위가 올해 낸 망분리 개선 가이드라인을 확인하고",
      "저희 상황에 해당되는 조항만 정리해",
      "해석은 붙이지 말고 원문 그대로 옮겨",
    ],
  }),

  // --- 운영 -----------------------------------------------------------------
  c({
    id: "p-operate-incident",
    phase: "operate",
    why: "긴 배경 뒤에 요구 하나. 앞쪽 서술에 후보를 붙이기 쉬운 모양이다.",
    text:
      "지난주 화요일 새벽 2시에 결제 API 응답이 30초까지 늘어났고, " +
      "고객사 세 곳에서 항의가 들어왔으며, 원인은 아직 모릅니다. " +
      "재발 방지 대책을 수립해 주세요.",
    quotes: ["재발 방지 대책을 수립해"],
  }),
];

/** Every case's `ProposerCase`, in corpus order. */
export const PROPOSER_SWEEP: readonly ProposerCase[] = PROPOSER_CASES.map((k) => k.testCase);

/** How many requirements the corpus states in total — the recall denominator. */
export const PROPOSER_WANTS = PROPOSER_SWEEP.reduce((n, k) => n + k.wants.length, 0);
