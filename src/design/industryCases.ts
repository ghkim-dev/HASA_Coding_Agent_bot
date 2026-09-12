import type { ActionKind } from "./functionalExtract.ts";

/**
 * 산업군별 고객이 실제로 쓰는 요구사항, 그리고 그 답.
 *
 * 기존 말뭉치는 개발자가 코딩 에이전트에 치는 문장(Gold·Holdout), 생성형 미디어,
 * 그리고 IT·DX 컨설팅 셋이었다. 이 제품이 팔릴 자리는 그보다 넓고, 넓어지는 쪽이
 * 문장의 모양을 바꾼다:
 *
 *   - 규제 산업의 요청에는 **범위가 붙은 금지**가 거의 항상 따라온다.
 *     "운영 DB는 건드리지 마", "환자 식별정보는 보고서에 넣지 마".
 *   - 도메인 명사가 길고 합성적이다. "MES와 ERP 사이 재고 수량",
 *     "발전 설비 예측 정비 모델".
 *   - 같은 동사가 산업마다 다른 것을 뜻한다. 금융의 "심사"와 의료의 "판독"은
 *     둘 다 `inspect` 지만, 그 판단이 옳은지는 두 문장 다 있어야 알 수 있다.
 *
 * ## 정답은 문장에서 쓴다
 *
 * 다른 말뭉치와 같은 규율이다. 추출기가 무엇을 내놓는지 보고 답을 맞추면 이
 * 파일은 구현의 자기 일관성만 재게 된다. 어긋나는 자리는 `INDUSTRY_GAPS` 에
 * 이유와 판정을 달아 남긴다.
 *
 * ## 이 말뭉치가 재는 것
 *
 * 요구사항을 읽는 비율만이 아니라 **하네스가 그 요청에 맞게 설계되는지**다.
 * 같은 문장이 능력 수요(coding·toolUse·webResearch…)를 만들고, 그 수요가 모델
 * 추천을 만들고, 금지가 검증 오라클을 만든다. 산업군마다 그 셋이 달라야 하고,
 * 다르지 않다면 설계가 요청을 읽지 않은 것이다.
 */

export type Sector =
  | "manufacturing"
  | "finance"
  | "healthcare"
  | "retail"
  | "logistics"
  | "public"
  | "education"
  | "energy"
  | "telecom"
  | "insurance"
  | "construction"
  | "media";

export interface IndustryRequirement {
  action: ActionKind;
  /** 문장이 그 동사에 묶은 명사구. 묶지 않았으면 null. */
  target: string | null;
}

export interface IndustryCase {
  id: string;
  sector: Sector;
  /** 고객이 그대로 칠 법한 한 문장. */
  text: string;
  /** 이 사례가 이 말뭉치에 있는 이유. 한 문장. */
  why: string;
  /** 문장이 요청하는 것들. 순서는 문장 순서. */
  requirements: readonly IndustryRequirement[];
  /**
   * 문장이 금지하는 도구 부류. 없으면 빈 배열.
   *
   * `output` 은 도구를 막지 않는 금지 — 결과물에 무엇을 넣지 말라는 것 — 이고,
   * 규제 산업 요청이 가장 자주 달고 오는 형태다.
   */
  forbids: readonly ("execute" | "modify" | "research" | "output")[];
}

export const INDUSTRY_CASES: readonly IndustryCase[] = [
  // --- 제조 -----------------------------------------------------------------
  {
    id: "mfg-anomaly-pipeline",
    sector: "manufacturing",
    text: "생산라인 설비 센서 데이터를 수집해서 이상 징후를 탐지하는 파이프라인을 만들어줘.",
    why: "만들어 달라는 요청. 목적어가 여섯 어절짜리 도메인 합성 명사구다.",
    requirements: [{ action: "create", target: "이상 징후를 탐지하는 파이프라인" }],
    forbids: [],
  },
  {
    id: "mfg-stock-mismatch",
    sector: "manufacturing",
    text: "MES와 ERP 사이 재고 수량이 어긋나는 원인을 찾아줘. 운영 DB는 건드리지 마.",
    why: "원인 분석 + 범위가 붙은 수정 금지. 규제·운영 환경 요청의 기본형이다.",
    // 답을 **넓혔다**(2026-09-07). 처음에는 `재고 수량이 어긋나는 원인` 이라고
    // 적었는데, "MES와 ERP 사이" 는 `어긋나는` 을 꾸미는 부사어이므로 관형절
    // 안이고 따라서 목적어구 안이다. KLUE-DP 에서 관형절 안의 부사어가 목적어구에
    // 드는 비율을 재면서 같은 구조를 확인했다. 출력이 그렇게 말해서가 아니라
    // 문장이 그렇기 때문에 고친다 — 순서가 반대였다면 이 줄은 없어야 한다.
    requirements: [{ action: "inspect", target: "MES와 ERP 사이 재고 수량이 어긋나는 원인" }],
    forbids: ["modify"],
  },

  // --- 금융 -----------------------------------------------------------------
  {
    id: "fin-credit-rule-change",
    sector: "finance",
    text: "여신 심사 규정이 바뀌어서 심사 로직을 수정하고 회귀 테스트를 돌려줘.",
    why: "수정 + 실행 두 요청. 앞 절은 이유이지 요청이 아니다.",
    requirements: [
      { action: "modify", target: "심사 로직" },
      { action: "execute", target: "회귀 테스트" },
    ],
    forbids: [],
  },
  {
    id: "fin-fraud-rules-no-names",
    sector: "finance",
    text: "이상거래 탐지 룰을 정리해 주세요. 다만 고객 실명은 결과물에 넣지 말아 주세요.",
    why: "결과물에 대한 금지. 도구를 막지 않으므로 도구 관문은 이것을 읽을 수 없다.",
    requirements: [{ action: "inspect", target: "이상거래 탐지 룰" }],
    forbids: ["output"],
  },

  // --- 의료 -----------------------------------------------------------------
  {
    id: "hc-emr-slow-query",
    sector: "healthcare",
    text: "EMR 연동 모듈에서 환자 조회가 느린 원인을 분석해줘.",
    why: "성능 원인 분석. 영문 약어가 문장 경계로 잘리면 대상이 무너진다.",
    requirements: [{ action: "inspect", target: "환자 조회가 느린 원인" }],
    forbids: [],
  },
  {
    id: "hc-export-no-phi",
    sector: "healthcare",
    text: "임상 데이터 반출 절차를 문서로 정리해줘. 환자 식별정보는 보고서에 넣지 마.",
    why: "결과물 금지에 장소가 붙은 형태. 금지되는 것과 놓이면 안 되는 곳이 둘 다 문장에 있다.",
    requirements: [{ action: "inspect", target: "임상 데이터 반출 절차" }],
    forbids: ["output"],
  },

  // --- 유통 -----------------------------------------------------------------
  {
    id: "rtl-order-inventory-drift",
    sector: "retail",
    text: "주문과 재고 상태가 어긋나는 케이스를 재현하고 고쳐줘.",
    why: "재현 + 수정. 재현은 실행이고 수정은 파일 변경이라 관문이 둘 다 열려야 한다.",
    requirements: [
      { action: "verify", target: "주문과 재고 상태가 어긋나는 케이스" },
      { action: "modify", target: null },
    ],
    forbids: [],
  },
  {
    id: "rtl-store-sales-compare",
    sector: "retail",
    text: "매장별 매출을 비교하고 상위 원인을 정리해줘.",
    why: "비교 + 정리. 둘 다 읽고 답하는 일이며 파일을 바꾸지 않는다.",
    requirements: [
      { action: "inspect", target: "매장별 매출" },
      { action: "inspect", target: "상위 원인" },
    ],
    forbids: [],
  },

  // --- 물류 -----------------------------------------------------------------
  {
    id: "log-route-optimise",
    sector: "logistics",
    text: "배송 경로 최적화 로직을 수정하고 실행 시간을 측정해줘.",
    why: "수정 + 측정. 측정은 실행 증거를 요구한다.",
    requirements: [
      { action: "modify", target: "배송 경로 최적화 로직" },
      { action: "verify", target: "실행 시간" },
    ],
    forbids: [],
  },
  {
    id: "log-warehouse-no-web",
    sector: "logistics",
    text: "창고 입출고 로그를 분석해서 병목 구간을 찾아줘. 웹 검색은 하지 말고 저장소 데이터만 봐줘.",
    why: "웹 금지. 사내 데이터만 보라는 요청은 이 산업에서 기본값에 가깝다.",
    requirements: [
      { action: "inspect", target: "창고 입출고 로그" },
      { action: "inspect", target: "병목 구간" },
      { action: "inspect", target: "저장소 데이터" },
    ],
    forbids: ["research"],
  },

  // --- 공공 -----------------------------------------------------------------
  {
    id: "pub-access-model-no-deploy",
    sector: "public",
    text: "행정 정보 시스템의 접근 권한 모델을 설계해줘. 실제로 배포하지는 말고 계획만 보여줘.",
    why: "배포 금지. 기업·공공 요청에서 가장 흔한 금지이고, 오래 읽히지 않았다.",
    requirements: [
      { action: "create", target: "행정 정보 시스템의 접근 권한 모델" },
      { action: "inspect", target: "계획" },
    ],
    forbids: ["execute"],
  },
  {
    id: "pub-pii-masking",
    sector: "public",
    text: "개인정보가 포함된 필드를 찾아서 마스킹 규칙을 만들어줘.",
    why: "찾기 + 만들기. 앞 절이 뒤 절의 입력이지만 요청은 둘이다.",
    requirements: [
      { action: "inspect", target: "개인정보가 포함된 필드" },
      { action: "create", target: "마스킹 규칙" },
    ],
    forbids: [],
  },

  // --- 교육 -----------------------------------------------------------------
  {
    id: "edu-progress-recommender",
    sector: "education",
    text: "학습 진도 데이터를 기반으로 추천 알고리즘을 만들어줘.",
    why: "만들기 하나. `-를 기반으로` 가 목적어를 앞으로 당기지 않는지 본다.",
    requirements: [{ action: "create", target: "추천 알고리즘" }],
    forbids: [],
  },
  {
    id: "edu-exam-integrity",
    sector: "education",
    text: "온라인 시험 부정행위 탐지 기준을 정리하고 검증해줘.",
    why: "정리 + 검증. 두 번째 요청은 목적어를 문장에 두지 않는다.",
    requirements: [
      { action: "inspect", target: "온라인 시험 부정행위 탐지 기준" },
      { action: "verify", target: null },
    ],
    forbids: [],
  },

  // --- 에너지 ---------------------------------------------------------------
  {
    id: "eng-predictive-maintenance",
    sector: "energy",
    text: "발전 설비 예측 정비 모델을 학습시키고 정확도를 평가해줘.",
    why: "학습 + 평가. 학습은 명령 실행이고, 평가는 그 결과를 읽는 일이다.",
    requirements: [
      { action: "execute", target: "발전 설비 예측 정비 모델" },
      { action: "verify", target: "정확도" },
    ],
    forbids: [],
  },
  {
    id: "eng-demand-api-load",
    sector: "energy",
    text: "전력 수요 예측 API를 구현하고 부하 테스트를 실행해줘.",
    why: "구현 + 실행. 영문 약어가 목적어 끝에 붙는다.",
    requirements: [
      { action: "create", target: "전력 수요 예측 API" },
      { action: "execute", target: "부하 테스트" },
    ],
    forbids: [],
  },

  // --- 통신 -----------------------------------------------------------------
  {
    id: "tel-outage-root-cause",
    sector: "telecom",
    text: "네트워크 장애 로그에서 근본 원인을 찾아줘.",
    why: "원인 하나. `-에서` 가 장소이지 목적어가 아니다.",
    requirements: [{ action: "inspect", target: "근본 원인" }],
    forbids: [],
  },
  {
    id: "tel-batch-no-prod-change",
    sector: "telecom",
    text: "요금제 변경 배치 작업을 수정해줘. 운영 데이터는 바꾸지 마.",
    why: "같은 턴에 수정 요청과 수정 금지가 같이 온다. 범위가 다르므로 충돌이 아니다.",
    requirements: [{ action: "modify", target: "요금제 변경 배치 작업" }],
    forbids: ["modify"],
  },

  // --- 보험 -----------------------------------------------------------------
  {
    id: "ins-claim-auto-review",
    sector: "insurance",
    text: "보험금 청구 자동 심사 규칙을 설계해줘.",
    why: "설계 하나. `설계` 가 `create` 로 읽히는지 본다.",
    requirements: [{ action: "create", target: "보험금 청구 자동 심사 규칙" }],
    forbids: [],
  },
  {
    id: "ins-loss-ratio-verify",
    sector: "insurance",
    text: "손해율 산정 로직을 검증하고 결과를 보고해줘.",
    why: "검증 + 보고. 보고는 읽은 것을 사람에게 돌려주는 일이라 `inspect` 다.",
    requirements: [
      { action: "verify", target: "손해율 산정 로직" },
      { action: "inspect", target: "결과" },
    ],
    forbids: [],
  },

  // --- 건설 -----------------------------------------------------------------
  {
    id: "con-offline-sync-bug",
    sector: "construction",
    text: "현장 안전 점검 체크리스트 앱의 오프라인 동기화 오류를 고쳐줘.",
    why: "수정 하나. 관형절이 길게 붙은 목적어다.",
    requirements: [{ action: "modify", target: "오프라인 동기화 오류" }],
    forbids: [],
  },
  {
    id: "con-schedule-variance",
    sector: "construction",
    text: "공정 일정과 실제 진척을 비교해서 지연 구간을 정리해줘.",
    why: "비교 + 정리. 병렬 명사구가 하나의 목적어로 묶여야 한다.",
    requirements: [
      { action: "inspect", target: "공정 일정과 실제 진척" },
      { action: "inspect", target: "지연 구간" },
    ],
    forbids: [],
  },

  // --- 미디어 ---------------------------------------------------------------
  {
    id: "med-subtitle-no-watermark",
    sector: "media",
    text: "영상 자동 자막 생성 파이프라인을 만들어줘. 워터마크는 넣지 말고.",
    why: "결과물 금지가 뒤 절에 짧게 붙는 형태. 문장이 거기서 끝난다.",
    requirements: [{ action: "create", target: "영상 자동 자막 생성 파이프라인" }],
    forbids: ["output"],
  },
  {
    id: "med-recommender-compare",
    sector: "media",
    text: "콘텐츠 추천 모델을 두 개 비교하고 품질을 평가해줘.",
    why: "비교 + 평가. 수량 구가 목적어 뒤에 온다.",
    requirements: [
      { action: "inspect", target: "콘텐츠 추천 모델" },
      { action: "verify", target: "품질" },
    ],
    forbids: [],
  },
];

export interface IndustryGap {
  caseId: string;
  axis: "requirement" | "target" | "forbids";
  /** 결정이면 `by_design`, 버그면 `defect`. 두 번째만 할 일이다. */
  verdict: "defect" | "by_design";
  reason: string;
}

/**
 * 정답과 런타임이 아직 어긋나는 자리.
 *
 * 지우지 않고 적는다. 테스트가 이 표를 **정확히** 남은 어긋남의 집합으로
 * 주장하므로, 하나를 고치면 여기서 한 줄을 지워야 하고 새로 생기면 빌드가
 * 깨진다. 이런 표가 없는 정답 파일은 정답과 같아질 때까지 고쳐진 파일이다.
 */
/**
 * 목적어 창이 두 어절이라 잘리는 사례.
 *
 * 이 말뭉치가 찾아낸 것 중 가장 큰 것이고, 새 결함이 아니라 **크기가 새로 밝혀진**
 * 결함이다. `consultingCases` 는 이것을 세 자리에서 알고 있었고 잘린 값을 못 박아
 * 두었다. 산업군 요청에서는 세 자리가 아니라 **38개 대상 중 24개**다 — 규제 산업의
 * 도메인 명사가 길고 합성적이기 때문이다("행정 정보 시스템의 접근 권한 모델",
 * "이상 징후를 탐지하는 파이프라인", "창고 입출고 로그").
 *
 * 넓히면 되는 문제가 아니라는 것도 쟀다. 창을 4어절로 넓히면 이 말뭉치의 대상은
 * 14→21 로 오르지만 기존 말뭉치에서 약 14건을 잃는다 — 부사(`반드시`)와
 * 지시어(`기존`)를 목적어로 끌어오기 때문이다. 6어절까지 넓혀도 산업 쪽은 24에서
 * 멈추고 잃는 쪽은 그대로다. 순손실이라 넓히지 않았다.
 *
 * 고치려면 명사구가 **어디서 시작하는지**를 알아야 하고, 그것은 창 폭을 바꾸는
 * 일이 아니다. `defect` 로 적어 두는 이유다 — 결정이 아니라 아직 못 한 일이다.
 */
const WINDOW_TRUNCATED = [
  "mfg-anomaly-pipeline",
  "hc-emr-slow-query",
  "log-route-optimise",
  "log-warehouse-no-web",
  "pub-access-model-no-deploy",
  "pub-pii-masking",
  "eng-demand-api-load",
  "tel-batch-no-prod-change",
  "ins-claim-auto-review",
  "ins-loss-ratio-verify",
  "con-offline-sync-bug",
  "con-schedule-variance",
  "med-subtitle-no-watermark",
  "med-recommender-compare",
  "rtl-order-inventory-drift",
  "fin-fraud-rules-no-names",
  "hc-export-no-phi",
  "edu-exam-integrity",
  "rtl-store-sales-compare",
  "eng-predictive-maintenance",
] as const;

export const INDUSTRY_GAPS: readonly IndustryGap[] = [
  ...WINDOW_TRUNCATED.map(
    (caseId): IndustryGap => ({
      caseId,
      axis: "target",
      verdict: "defect",
      reason: "목적어 창이 두 어절이라 도메인 합성 명사구의 앞머리가 잘린다. 위 주석에 측정과 함께 있다.",
    }),
  ),
  {
    caseId: "fin-fraud-rules-no-names",
    axis: "requirement",
    verdict: "defect",
    reason:
      "`정리하다` 를 무조건 `modify` 로 읽는다. 기술 부채를 정리하는 것은 고치는 일이 맞지만 " +
      "탐지 룰을 정리해 보고서로 내는 것은 읽고 답하는 일이다. 문장이 가르는 것을 동사가 " +
      "혼자 정하고 있고, 그래서 이 요청은 파일을 바꾸는 하네스를 받는다.",
  },
  {
    caseId: "rtl-store-sales-compare",
    axis: "requirement",
    verdict: "defect",
    reason: "위와 같다 — `상위 원인을 정리해줘` 가 `modify` 로 읽힌다.",
  },
  {
    caseId: "edu-exam-integrity",
    axis: "requirement",
    verdict: "defect",
    reason: "위와 같다 — `탐지 기준을 정리하고` 가 `modify` 로 읽힌다.",
  },
  {
    caseId: "con-schedule-variance",
    axis: "requirement",
    verdict: "defect",
    reason: "위와 같다 — `지연 구간을 정리해줘` 가 `modify` 로 읽힌다.",
  },
  {
    caseId: "rtl-order-inventory-drift",
    axis: "requirement",
    verdict: "defect",
    reason:
      "`재현하고 고쳐줘` 의 두 번째 절이 사라진다. 목적어가 없는 요청은 요구사항이 아니라 " +
      "질문거리라는 것이 이 저장소의 판단인데, gold `no-connective-as-target` 은 같은 모양을 " +
      "요구사항으로 답해 두었다. 두 답이 서로 다르므로 하나는 틀렸다.",
  },
];
