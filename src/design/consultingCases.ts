import type { MediaRequirement } from "./mediaCases.ts";

/**
 * IT·디지털 전환 컨설팅에서 실제로 오는 요청들.
 *
 * 이 저장소의 말뭉치는 둘 중 하나였다. `goldCases` 와 `holdoutCases` 는 저장소를
 * 고치는 짧은 심부름이고, `mediaCases` 는 생성형 미디어 프로젝트다. 컨설팅 요청은
 * 세 번째 모양이고, 앞의 둘과 다른 곳에서 깨진다:
 *
 *   · 명사가 길고 한자어와 영문 약어가 섞인다 — `레거시 시스템`, `기술 부채`,
 *     `TCO`, `SLA`. 조사를 떼는 규칙이 라틴 문자와 만나는 자리다.
 *   · 산출물이 문서다. `로드맵`, `아키텍처 설계서`, `타당성 검토서` 를 만드는
 *     것은 `create` 이지만, 그 안에서 요구되는 일은 `inspect` 이거나 `verify` 다.
 *   · 금지가 결과물이 아니라 **범위**에 붙는다 — "운영 DB 는 건드리지 말고".
 *   · 조건이 사업 조건이다 — "트래픽이 두 배가 되면".
 *
 * ## 정답을 쓴 규칙
 *
 * `mediaCases.ts` 가 적어 둔 것과 같다. 여기 다시 적는 것은 이 말뭉치가 만나는
 * 모양이 달라서, 같은 규칙이 어디에 적용되는지가 다르기 때문이다.
 *
 *   · **머리 명사구**를 대상으로 쓰고, 그 앞의 관형절은 빼낸다. "레거시 ERP를
 *     클라우드로 이전하는 로드맵을 만들어줘" 의 대상은 `로드맵` 이다 — 관형절은
 *     로드맵이 무엇에 대한 것인지 말할 뿐, 만들 물건은 로드맵이다.
 *   · **도구격 `-로`/`-으로` 는 대상이 아니다.** "온프레미스에서 클라우드로
 *     옮겨줘" 가 옮기는 것은 클라우드가 아니다.
 *   · **나열은 하나의 명사구다.** "보안과 성능을" 은 둘 다 대상이다.
 *   · `null` 은 문장이 대상을 말하지 않았다는 답이고, 그것도 답이다.
 *
 * ## 행위를 어떻게 골랐는가
 *
 *   · `분석`·`검토`·`진단`·`비교`는 `inspect` 다. 무엇을 바꾸지 않는다.
 *   · `측정`·`검증`·`확인`은 `verify` 다. 증거가 나와야 끝난다.
 *   · `정리`·`이관`·`전환`·`통합`은 `modify` 다 — 있던 것이 달라진다. 특히
 *     `이관`/`전환`은 `mediaCases` 의 `변환`과 같은 논거로 `modify` 다: 문장이
 *     대상으로 삼는 것은 **옮겨지는 쪽**이지 도착지가 아니다.
 *   · `수립`·`작성`·`설계`는 `create` 다. 없던 문서가 생긴다.
 *   · `실행`·`배포`·`구축`은 `execute` 다.
 */

export interface ConsultingCase {
  id: string;
  /** 컨설팅 과업의 종류. 어느 단계에서 오는 요청인지. */
  phase: "diagnose" | "roadmap" | "migrate" | "govern" | "operate";
  text: string;
  /** 이 문장이 말뭉치에 있는 이유 — 어떤 모양을 재는가. */
  why: string;
  requirements: readonly MediaRequirement[];
}

export const CONSULTING_CASES: readonly ConsultingCase[] = [
  // --- 진단 -----------------------------------------------------------------
  {
    id: "c-diagnose-architecture",
    phase: "diagnose",
    text: "현재 시스템 아키텍처를 분석해줘.",
    why: "가장 단순한 형태. 두 어절 명사구가 통째로 대상이어야 한다.",
    requirements: [{ action: "inspect", target: "시스템 아키텍처" }],
  },
  {
    id: "c-diagnose-and-find",
    phase: "diagnose",
    text: "로그를 분석하고 병목 구간을 찾아줘.",
    why: "`-고` 로 이어진 두 요청. 둘 다 나와야 하고, 앞 절의 대상이 뒤 절로 넘어가면 안 된다.",
    requirements: [
      { action: "inspect", target: "로그" },
      { action: "inspect", target: "병목 구간" },
    ],
  },
  {
    id: "c-diagnose-tech-debt",
    phase: "diagnose",
    text: "레거시 시스템의 기술 부채를 정리해줘.",
    why: "관형격 `-의` 가 앞에 붙은 명사구. 머리는 `기술 부채` 이고 `정리` 는 있던 것을 바꾸는 일이다.",
    requirements: [{ action: "modify", target: "기술 부채" }],
  },
  {
    id: "c-diagnose-tco",
    phase: "diagnose",
    text: "TCO를 산정하고 ROI를 비교해줘.",
    why:
      "영문 약어가 조사를 달고 두 번 나온다. 라틴 문자 뒤의 조사 처리와, 약어가 " +
      "대상으로 온전히 남는지를 본다. " +
      "정답이 처음에는 한 줄이었다. 그때 `산정` 이 어휘에 없어서 `비교` 만 " +
      "나왔고, 나는 그 사실을 정답에 적었다 — 코드가 지금 하는 일을 정답으로 쓴 " +
      "것이고, 그것은 정답이 아니라 관찰이다. 문장은 두 가지를 요청한다. " +
      "어휘에 `산정` 이 들어가자 두 번째 줄이 나왔고, 정답은 처음부터 두 줄이었어야 했다.",
    requirements: [
      { action: "inspect", target: "TCO" },
      { action: "inspect", target: "ROI" },
    ],
  },
  {
    id: "c-diagnose-question",
    phase: "diagnose",
    text: "온프레미스와 클라우드 중 어느 쪽이 유리한지 알려줘.",
    why:
      "`-ㄴ지` 로 물은 것은 사물이 아니다. 대상은 없고, 요구사항은 무엇에 대한 " +
      "물음인지를 말해야 한다.",
    requirements: [{ action: "inspect", target: null }],
  },

  // --- 로드맵·설계 ------------------------------------------------------------
  {
    id: "c-roadmap-create",
    phase: "roadmap",
    text: "레거시 ERP를 클라우드로 이전하는 로드맵을 만들어줘.",
    why:
      "관형절이 앞에 통째로 붙은 문장. 만들 물건은 로드맵이고, 관형절은 그 로드맵이 " +
      "무엇에 대한 것인지 말할 뿐이다.",
    requirements: [{ action: "create", target: "로드맵" }],
  },
  {
    id: "c-roadmap-range",
    phase: "roadmap",
    text: "PoC부터 전사 확산까지 단계를 설계해줘.",
    why:
      "범위 조사 `부터`·`까지`. 위치가 아니라 대상의 일부이고, 두 끝이 다 남아야 한다. " +
      "정답을 처음에 `단계` 라고 좁게 썼는데, 이 파일 머리와 `mediaCases` 가 적어 둔 " +
      "규칙은 범위를 대상의 일부로 본다 — \"CNN부터 Transformer까지 사용해줘\" 의 대상이 " +
      "`CNN부터 Transformer` 인 것과 같다. 규칙대로면 네 어절 전체가 대상이다.",
    requirements: [{ action: "create", target: "PoC부터 전사 확산까지 단계" }],
  },
  {
    id: "c-roadmap-priority",
    phase: "roadmap",
    text: "보안과 성능을 기준으로 우선순위를 정해줘.",
    why:
      "나열이 도구격 `-로` 안에 들어 있다. 정할 것은 우선순위이고, 기준은 대상이 " +
      "아니다. `정하다` 는 어휘에 없으므로 지금은 아무것도 나오지 않는다.",
    requirements: [{ action: "create", target: "우선순위" }],
  },
  {
    id: "c-roadmap-feature",
    phase: "roadmap",
    text: "단계별 예산과 일정을 조정할 수 있게 해줘.",
    why:
      "`-ㄹ 수 있게 해줘` 는 기능 요청이고, 안쪽 동사의 행위를 가진다. 대상을 처음에 " +
      "`예산과 일정` 이라고 썼는데, 규칙은 관형 수식어를 명사구에 남긴다 — `낡은 설정을 " +
      "삭제해줘` 의 대상이 `낡은 설정` 인 것과 같다. `단계별` 도 그런 수식어다.",
    requirements: [{ action: "modify", target: "단계별 예산과 일정" }],
  },
  {
    id: "c-roadmap-source",
    phase: "roadmap",
    text: "NIST 가이드라인을 참고해서 보안 요건을 정리해줘.",
    why:
      "`-어서` 로 이어진 두 절이고, 뒤 절이 제 대상을 부른다. 그래서 절 경계가 " +
      "되어야 하고 두 요청이 다 나와야 한다.",
    requirements: [
      { action: "inspect", target: "NIST 가이드라인" },
      { action: "modify", target: "보안 요건" },
    ],
  },

  // --- 이관 -----------------------------------------------------------------
  {
    id: "c-migrate-instrumental",
    phase: "migrate",
    text: "온프레미스 서버를 클라우드로 이전해줘.",
    why:
      "도구격이 도착지다. 옮겨지는 것은 서버이고 클라우드가 아니다. `mediaCases` 의 " +
      "`변환`과 같은 논거로 `modify` 다.",
    requirements: [{ action: "modify", target: "온프레미스 서버" }],
  },
  {
    id: "c-migrate-prohibition",
    phase: "migrate",
    text: "운영 DB는 건드리지 말고 스테이징만 이전해줘.",
    why:
      "금지가 앞에 오고 요청이 뒤에 온다. 금지된 동사가 요구사항이 되어서는 안 되고, " +
      "뒤 절은 나와야 한다.",
    requirements: [{ action: "modify", target: "스테이징" }],
  },
  {
    id: "c-migrate-condition",
    phase: "migrate",
    text: "트래픽이 두 배가 되면 오토스케일링을 적용해줘.",
    why:
      "조건절의 명사가 대상이 되어서는 안 된다. `적용` 은 어휘에 없으므로 지금은 " +
      "아무것도 나오지 않는 것이 답이고, 나온다면 조건절에서 대상을 가져온 것이다.",
    requirements: [{ action: "modify", target: "오토스케일링" }],
  },
  {
    id: "c-migrate-scope",
    phase: "migrate",
    text: "결제 모듈 안의 외부 연동만 정리해줘.",
    why: "처소 명사 `안의` 는 대상이 아니다. 정리할 것은 외부 연동이다.",
    requirements: [{ action: "modify", target: "외부 연동" }],
  },
  {
    id: "c-migrate-two-acts",
    phase: "migrate",
    text: "데이터를 이관하고 정합성을 검증해줘.",
    why: "이관과 검증은 다른 행위다. 하나로 합쳐지면 증거가 필요한 쪽이 사라진다.",
    requirements: [
      { action: "modify", target: "데이터" },
      { action: "verify", target: "정합성" },
    ],
  },

  // --- 거버넌스 ---------------------------------------------------------------
  {
    id: "c-govern-policy",
    phase: "govern",
    text: "데이터 거버넌스 정책을 수립해줘.",
    why: "세 어절 명사구. 마지막 두 어절만 남으면 `거버넌스 정책` 이 되어 무엇의 정책인지 사라진다.",
    requirements: [{ action: "create", target: "거버넌스 정책" }],
  },
  {
    id: "c-govern-no-execute",
    phase: "govern",
    text: "실제로 배포하지 말고 계획만 보여줘.",
    why:
      "실행 금지가 명시된 요청. 도구 관문이 읽어야 하는 금지이고, 뒤 절의 요청은 " +
      "살아야 한다.",
    requirements: [{ action: "inspect", target: "계획" }],
  },
  {
    id: "c-govern-preserve",
    phase: "govern",
    text: "기존 인증 방식은 그대로 두고 권한 모델만 바꿔줘.",
    why:
      "유지와 변경이 한 문장에 있다. 둘이 충돌하는 것이 아니라 각각 다른 것에 " +
      "걸리므로, 둘 다 나와야 한다.",
    requirements: [
      { action: "preserve", target: "인증 방식" },
      { action: "modify", target: "권한 모델" },
    ],
  },
  {
    id: "c-govern-pii",
    phase: "govern",
    text: "개인정보가 포함된 필드를 찾아서 마스킹 규칙을 만들어줘.",
    why:
      "`-어서` 로 이어지고 뒤 절이 제 대상을 부른다. 두 절이 갈려야 한다. 앞 절의 대상을 " +
      "처음에 `필드` 라고 썼는데, 규칙은 **이 파일이 아는 동사의** 분사만 명사구에서 " +
      "빼낸다 — `생성된 영상` 은 `영상` 이지만 `포함` 은 어휘에 없으므로 `포함된` 은 " +
      "평범한 수식어로 남는다.",
    requirements: [
      { action: "inspect", target: "포함된 필드" },
      { action: "create", target: "마스킹 규칙" },
    ],
  },
  {
    id: "c-govern-adverb",
    phase: "govern",
    text: "가급적 빠르게 감사 로그를 남기게 해줘.",
    why: "부사 둘이 목적어 앞에 선다. 부사가 대상에 용접되면 없는 물건이 된다.",
    requirements: [{ action: "create", target: "감사 로그" }],
  },

  // --- 운영 -----------------------------------------------------------------
  {
    id: "c-operate-sla",
    phase: "operate",
    text: "SLA 준수율을 측정해줘.",
    why: "라틴 약어가 한글 명사와 붙어 한 명사구를 이룬다.",
    requirements: [{ action: "verify", target: "SLA 준수율" }],
  },
  {
    id: "c-operate-measure-and-report",
    phase: "operate",
    text: "장애 복구 시간을 측정하고 결과를 보고해줘.",
    why: "측정과 보고는 다른 행위다. `보고` 는 어휘에 없으므로 뒤 절이 어떻게 되는지가 관전 포인트다.",
    requirements: [
      { action: "verify", target: "장애 복구 시간" },
      { action: "inspect", target: "결과" },
    ],
  },
  {
    id: "c-operate-cost",
    phase: "operate",
    text: "클라우드 비용을 절감할 수 있는 방안을 정리해줘.",
    why:
      "`-ㄹ 수 있는` 은 관형절이고 기능 요청이 아니다. 정리할 것은 방안이며, " +
      "`절감` 이 요구사항이 되면 문장에 없는 일을 지어낸 것이다.",
    requirements: [{ action: "modify", target: "방안" }],
  },
  {
    id: "c-operate-runbook",
    phase: "operate",
    text: "장애 대응 런북을 작성하고 훈련을 실행해줘.",
    why: "문서 작성(create)과 실행(execute)이 한 문장에 있다.",
    requirements: [
      { action: "create", target: "대응 런북" },
      { action: "execute", target: "훈련" },
    ],
  },
  {
    id: "c-operate-vendor",
    phase: "operate",
    text: "벤더 세 곳의 제안서를 비교해줘.",
    why:
      "수량 표현이 명사구 안에 있다. 대상을 처음에 `제안서` 라고 좁게 썼는데, 규칙은 " +
      "수식어를 남기므로 `벤더 세 곳의 제안서` 전체가 대상이다. 지금은 앞머리 `벤더` 가 " +
      "잘리고 수량 구만 남는다.",
    requirements: [{ action: "inspect", target: "벤더 세 곳의 제안서" }],
  },
];
