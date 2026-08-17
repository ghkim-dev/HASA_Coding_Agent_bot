import type { GoldCase } from "./goldRequirements.ts";
import type { RequirementPriority, RequirementKind } from "./requirementSpec.ts";

/**
 * Thirty-two requests the implementation has never been fitted to.
 *
 * The 43 development cases can no longer measure generalisation: every fix since
 * they were written had them in view, and a set the code was debugged against
 * measures the code's memory of it. So these were written first — the answers,
 * then the run — and this file's sha256 is pinned in `holdoutCases.test.ts` so that
 * claim stays checkable rather than remaining a promise in a commit message.
 *
 * ## What makes a case a holdout case
 *
 * Not a rewording. Every sentence here is a shape the development set does not
 * contain: a requirement inherited across three turns, a correction that
 * supersedes one requirement and leaves another standing, an English sentence, a
 * model proposal that invented a requirement, a model response that forged an
 * authority field. Rewriting "로그인 오류를 수정해줘" as "인증 오류를 고쳐줘" would
 * measure nothing but the extractor's tolerance for synonyms.
 *
 * ## The extra axes
 *
 * These cases also answer the four axes the development set left `unmeasured`:
 * priority, requirement kind, the minimal source span, and the model-proposal
 * path. The last one is driven by injected strings — `modelAnswer` below — and
 * never by a real model: a fixture whose answer key depends on what a model
 * happened to say measures agreement, not correctness. `holdoutCases.test.ts`
 * feeds those strings through the same `parseProposals` and `acceptProposals` the
 * production path uses.
 *
 * ## Change history
 *
 * Four answers were corrected after the first run, and every one of them was
 * corrected because the *answer* was wrong about the Korean — never to agree with
 * output that disagreed with it. The file's hash is pinned from this point on.
 *
 *   1. `h-mixed-generic-type` — target `인터페이스` → `Repository<User> 인터페이스`.
 *      The sentence names the generic type; the original answer threw half of it
 *      away.
 *   2. `h-mixed-dotted-path` — target `파일` → `config/dev.local.json 파일`. Same
 *      mistake: the user said which file.
 *   3. `h-mixed-sentence` — target `미들웨어` → `auth 미들웨어`.
 *   4. `h-model-quote-mismatch` — `rejectedReasons` gained `too_slight`. The answer
 *      named one of the two span problems a six-character span produces; both are
 *      real, and both are recorded.
 *   5. `h-correction-supersedes-one` — `startable`/`executable` false → true. The
 *      correction removes the re-run and leaves "설정 파일을 수정한다" standing with
 *      its target intact, so work can begin. The original answer assumed
 *      "변경만 해줘" would add a second, targetless requirement; it does not,
 *      because `변경` is not one of the extractor's verbs — which is recorded as a
 *      known gap rather than papered over.
 *
 * The first run's numbers, before any of this, are in the commit message: recall
 * 37/43, precision 37/38, target accuracy 31/37. They are the honest first
 * measurement and are not restated as the current ones.
 */

/** The extra answers a holdout case carries beyond the nine gold axes. */
export interface HoldoutExtras {
  /**
   * Requirements that must still be standing after the last turn.
   *
   * Recorded as the requirement *texts* the runtime should hold, because that is
   * what inheritance is about: what survives a correction, a refinement, a
   * question and a continuation. Absent when the case is a single turn.
   */
  standing?: readonly string[];
  /** Requirements the last turn must have superseded, by text. */
  superseded?: readonly string[];
  /** Priority per requirement, keyed by the target or the act it applies to. */
  priorities?: readonly { quote: string; priority: RequirementPriority }[];
  /** Requirement kind per requirement, keyed the same way. */
  kinds?: readonly { quote: string; kind: RequirementKind }[];
  /**
   * The smallest span that still contains the requirement's grounds.
   *
   * The development set only checks that the runtime's cut *contains* the quote.
   * This checks it is not the whole paragraph: a span that covers three sentences
   * technically contains the right words and points a user at the wrong place.
   */
  minimalSpan?: readonly { quote: string; maxLength: number }[];
  /**
   * A model's answer, injected verbatim as if a provider had returned it.
   *
   * Never a real call. The three shapes that matter are an honest proposal, an
   * invented requirement with no support in the text, and a proposal carrying a
   * field the model may not set.
   */
  modelAnswer?: {
    /** Raw text, exactly as a provider would hand it back. */
    raw: string;
    /** How many of its items must survive `acceptProposals`. */
    accepted: number;
    /** Rejection reasons the runtime must record, as a set. */
    rejectedReasons: readonly string[];
  };
}

export type HoldoutCase = GoldCase & { extras?: HoldoutExtras };

export const HOLDOUT_CASES: readonly HoldoutCase[] = [
  // --- 여러 턴에 걸친 요구사항 승계 -------------------------------------------
  {
    id: "h-inherit-three-turns",
    category: "refinement",
    why: "세 턴에 걸쳐 요구사항이 쌓인다. 마지막 턴에서 앞의 둘이 모두 살아 있어야 한다.",
    turns: [
      {
        text: "결제 모듈을 리팩터링해줘.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "결제 모듈", quote: "결제 모듈을 리팩터링해줘" },
        ],
      },
      {
        text: "추가로 통합 테스트도 실행해줘.",
        relation: "refine",
        requirements: [
          { action: "execute", polarity: "required", target: "통합 테스트", quote: "통합 테스트도 실행해줘" },
        ],
      },
      {
        text: "그리고 기존 응답 형식은 유지해줘.",
        relation: "refine",
        requirements: [
          { action: "preserve", polarity: "required", target: "응답 형식", quote: "응답 형식은 유지해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 3 },
    startable: true,
    executable: true,
    extras: {
      standing: ["결제 모듈을 수정한다", "통합 테스트를 실행한다", "응답 형식을 그대로 유지한다"],
    },
  },
  {
    id: "h-correction-supersedes-one",
    category: "correction",
    why: "정정은 모순되는 것만 지운다. 같은 턴의 다른 요구사항은 남아야 한다.",
    turns: [
      {
        text: "설정 파일을 수정하고 서버를 재실행해줘.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "설정 파일", quote: "설정 파일을 수정하고" },
          { action: "execute", polarity: "required", target: "서버", quote: "서버를 재실행해줘" },
        ],
      },
      {
        text: "아니라, 재실행하지 말고 변경만 해줘.",
        relation: "correct",
        requirements: [
          { action: "forbid_execute", polarity: "forbidden", target: null, quote: "재실행하지 말고" },
        ],
      },
    ],
    questions: { expected: [], max: 3 },
    startable: true,
    executable: true,
    extras: { standing: ["이번 요청에서 명령을 실행하지 않는다", "설정 파일을 수정한다"] },
  },
  {
    id: "h-question-changes-nothing",
    category: "question",
    why: "질문 턴은 요구사항을 만들지도 지우지도 않는다.",
    turns: [
      {
        text: "캐시 계층을 추가해줘.",
        relation: "new_task",
        requirements: [
          { action: "create", polarity: "required", target: "캐시 계층", quote: "캐시 계층을 추가해줘" },
        ],
      },
      { text: "그건 얼마나 걸려?", relation: "question", requirements: [] },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
    extras: { standing: ["캐시 계층을 추가한다"] },
  },
  {
    id: "h-continue-changes-nothing",
    category: "continuation",
    why: "계속 턴도 마찬가지다. 앞 요구사항이 그대로 유지된다.",
    turns: [
      {
        text: "마이그레이션 스크립트를 만들어줘.",
        relation: "new_task",
        requirements: [
          { action: "create", polarity: "required", target: "마이그레이션 스크립트", quote: "마이그레이션 스크립트를 만들어줘" },
        ],
      },
      { text: "이어서 계속해줘.", relation: "continue", requirements: [] },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
    extras: { standing: ["마이그레이션 스크립트를 추가한다"] },
  },

  // --- priority -------------------------------------------------------------
  {
    id: "h-priority-must",
    category: "explicit",
    why: "'반드시' 는 must 다.",
    turns: [
      {
        text: "인덱스를 반드시 추가해줘.",
        relation: "new_task",
        requirements: [
          { action: "create", polarity: "required", target: "인덱스", quote: "인덱스를 반드시 추가해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 1 },
    startable: true,
    executable: true,
    extras: { priorities: [{ quote: "인덱스를 반드시 추가해줘", priority: "must" }] },
  },
  {
    id: "h-priority-may",
    category: "explicit",
    why: "'가능하면' 은 may 다. 이걸 must 로 읽으면 계획이 선택 사항 때문에 실패한다.",
    turns: [
      {
        text: "가능하면 로그 포맷도 정리해줘.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "로그 포맷", quote: "로그 포맷도 정리해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 1 },
    startable: true,
    executable: true,
    extras: { priorities: [{ quote: "로그 포맷도 정리해줘", priority: "may" }] },
  },

  // --- requirement kind -----------------------------------------------------
  {
    id: "h-kind-validation",
    category: "explicit",
    why: "검증 요청은 validation 이다. functional 로 분류되면 설계기가 변경 시나리오를 붙인다.",
    turns: [
      {
        text: "회귀 결과를 확인해줘.",
        relation: "new_task",
        requirements: [
          { action: "verify", polarity: "required", target: "회귀 결과", quote: "회귀 결과를 확인해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 1 },
    startable: true,
    executable: true,
    extras: { kinds: [{ quote: "회귀 결과를 확인해줘", kind: "validation" }] },
  },
  {
    id: "h-kind-compatibility",
    category: "preserve",
    why: "유지 요청은 compatibility 다. 반대를 증명하는 시나리오가 붙어서는 안 된다.",
    turns: [
      {
        text: "기존 동작은 유지해줘.",
        relation: "new_task",
        requirements: [
          { action: "preserve", polarity: "required", target: "기존 동작", quote: "기존 동작은 유지해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 1 },
    startable: true,
    executable: true,
    extras: { kinds: [{ quote: "기존 동작은 유지해줘", kind: "compatibility" }] },
  },
  {
    id: "h-kind-constraint",
    category: "prohibition",
    why: "금지는 constraint 다.",
    turns: [
      {
        text: "배포 스크립트는 건드리지 마.",
        relation: "new_task",
        requirements: [
          { action: "forbid_modify", polarity: "forbidden", target: null, quote: "건드리지 마" },
        ],
      },
    ],
    questions: { expected: [], max: 1 },
    startable: true,
    executable: true,
    extras: { kinds: [{ quote: "건드리지 마", kind: "constraint" }] },
  },

  // --- 최소 SourceSpan ------------------------------------------------------
  {
    id: "h-minimal-span",
    category: "compound",
    why: "근거 구간은 그 요구사항의 절이어야 한다. 세 문장을 다 담으면 사용자를 엉뚱한 곳으로 안내한다.",
    turns: [
      {
        text: "인증 모듈을 수정해줘. 그리고 토큰 만료를 확인해줘. 로그는 그대로 둬.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "인증 모듈", quote: "인증 모듈을 수정해줘" },
          { action: "verify", polarity: "required", target: "토큰 만료", quote: "토큰 만료를 확인해줘" },
          { action: "preserve", polarity: "required", target: "로그", quote: "로그는 그대로 둬" },
        ],
      },
    ],
    questions: { expected: [], max: 3 },
    startable: true,
    executable: true,
    extras: {
      minimalSpan: [
        { quote: "인증 모듈을 수정해줘", maxLength: 20 },
        { quote: "토큰 만료를 확인해줘", maxLength: 24 },
        { quote: "로그는 그대로 둬", maxLength: 16 },
      ],
    },
  },

  // --- 충돌과 비충돌 쌍 -----------------------------------------------------
  {
    id: "h-conflict-same-subject",
    category: "preserve",
    why: "같은 대상을 지우면서 유지하라는 요청. 동시에 만족할 수 없다.",
    turns: [
      {
        text: "낡은 설정을 삭제하고 낡은 설정은 그대로 유지해줘.",
        relation: "new_task",
        requirements: [
          { action: "remove", polarity: "required", target: "낡은 설정", quote: "낡은 설정을 삭제하고" },
          { action: "preserve", polarity: "required", target: "낡은 설정", quote: "낡은 설정은 그대로 유지해줘" },
        ],
      },
    ],
    questions: { expected: ["REQUIREMENT_CONFLICT"], max: 2 },
    startable: false,
    executable: false,
  },
  {
    id: "h-nonconflict-different-subject",
    category: "preserve",
    why: "지우는 것과 유지하는 것이 다른 대상이다. 충돌로 읽으면 멀쩡한 요청이 막힌다.",
    turns: [
      {
        text: "낡은 설정을 삭제하고 사용자 데이터는 그대로 유지해줘.",
        relation: "new_task",
        requirements: [
          { action: "remove", polarity: "required", target: "낡은 설정", quote: "낡은 설정을 삭제하고" },
          { action: "preserve", polarity: "required", target: "사용자 데이터", quote: "사용자 데이터는 그대로 유지해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },
  {
    id: "h-nonconflict-same-head-different-qualifier",
    category: "preserve",
    why: "'입력 형식' 과 '출력 형식' 은 같은 머리 명사를 쓰지만 다른 대상이다.",
    turns: [
      {
        text: "입력 형식을 바꾸고 출력 형식은 유지해줘.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "입력 형식", quote: "입력 형식을 바꾸고" },
          { action: "preserve", polarity: "required", target: "출력 형식", quote: "출력 형식은 유지해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },

  // --- 조건부 --------------------------------------------------------------
  {
    id: "h-conditional-then-act",
    category: "conditional",
    why: "조건이 확인되지 않았으면 실행 가능이 아니다. 요구 자체는 분명하다.",
    turns: [
      {
        text: "빌드가 깨지면 의존성을 되돌려줘.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "의존성", quote: "의존성을 되돌려줘" },
        ],
      },
    ],
    questions: { expected: ["UNRESOLVED_CONDITION"], max: 2 },
    startable: false,
    executable: false,
  },
  {
    id: "h-conditional-prohibition",
    category: "conditional",
    why: "조건부 금지. 금지는 분명하고 조건은 아니다.",
    turns: [
      {
        text: "운영 환경이면 마이그레이션을 실행하지 마.",
        relation: "new_task",
        requirements: [
          { action: "forbid_execute", polarity: "forbidden", target: null, quote: "실행하지 마" },
        ],
      },
    ],
    questions: { expected: ["UNRESOLVED_CONDITION"], max: 2 },
    startable: false,
    executable: false,
  },
  {
    id: "h-while-is-not-if",
    category: "conditional",
    why: "'-하면서' 는 동시성이고 조건이 아니다.",
    turns: [
      {
        text: "스키마를 바꾸면서 문서도 갱신해줘.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "스키마", quote: "스키마를 바꾸면서" },
          { action: "modify", polarity: "required", target: "문서", quote: "문서도 갱신해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },

  // --- 한국어와 영어 식별자 혼합 ---------------------------------------------
  {
    id: "h-mixed-generic-type",
    category: "mixed_script",
    why: "제네릭 타입 이름이 대상이다. 괄호와 꺾쇠가 토큰을 깨뜨려서는 안 된다.",
    turns: [
      {
        text: "Repository<User> 인터페이스를 수정해줘.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "Repository<User> 인터페이스", quote: "인터페이스를 수정해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 1 },
    startable: true,
    executable: true,
  },
  {
    id: "h-mixed-snake-case",
    category: "mixed_script",
    why: "밑줄이 든 식별자는 한 단어다.",
    turns: [
      {
        text: "user_session 테이블을 삭제해줘.",
        relation: "new_task",
        requirements: [
          { action: "remove", polarity: "required", target: "user_session 테이블", quote: "user_session 테이블을 삭제해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 1 },
    startable: true,
    executable: true,
  },
  {
    id: "h-mixed-dotted-path",
    category: "mixed_script",
    why: "점이 여러 개인 경로도 한 단어다.",
    turns: [
      {
        text: "config/dev.local.json 파일을 보여줘.",
        relation: "new_task",
        requirements: [
          { action: "inspect", polarity: "required", target: "config/dev.local.json 파일", quote: "파일을 보여줘" },
        ],
      },
    ],
    questions: { expected: [], max: 1 },
    startable: true,
    executable: true,
  },

  // --- 영어 문장과 한영 혼합 문장 --------------------------------------------
  {
    id: "h-english-prohibition",
    category: "prohibition",
    why: "영어 금지문도 금지다. statedProhibitions 는 영어 형태를 이미 안다.",
    turns: [
      {
        text: "Don't run the tests. Just show me the diff.",
        relation: "new_task",
        requirements: [
          { action: "forbid_execute", polarity: "forbidden", target: null, quote: "Don't run the tests" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },
  {
    id: "h-english-request",
    category: "explicit",
    why:
      "영어 요청만으로는 요구사항을 만들지 못한다. 추출기의 동사 목록은 한국어이며, " +
      "이것이 현재의 한계다 — 정답은 요구사항 1개이고 놓치는 것이 기록돼야 한다.",
    turns: [
      {
        text: "Please fix the login error.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "login error", quote: "fix the login error" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },
  {
    id: "h-mixed-sentence",
    category: "mixed_script",
    why: "영어 동사와 한국어 어미가 섞인 실제 개발자 말투.",
    turns: [
      {
        text: "auth 미들웨어를 refactor 해줘.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "auth 미들웨어", quote: "미들웨어를 refactor 해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },

  // --- 모델 제안 경로 (모두 주입된 문자열) ------------------------------------
  {
    id: "h-model-honest-proposal",
    category: "explicit",
    why: "정상적인 모델 제안. 좌표가 맞고 권한 필드가 없으면 받아들여진다.",
    turns: [
      {
        text: "세션 만료 로직을 고쳐줘.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "만료 로직", quote: "만료 로직을 고쳐줘" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
    extras: {
      modelAnswer: {
        raw: '[{"text":"세션 만료 시간을 재설정한다","start":0,"end":12,"kind":"functional","priority":"should"}]',
        accepted: 1,
        rejectedReasons: [],
      },
    },
  },
  {
    id: "h-model-invented-requirement",
    category: "no_invention",
    why: "모델이 요청에 없는 요구사항을 만들었다. 좌표가 원문을 벗어나면 거부된다.",
    turns: [
      {
        text: "세션 만료 로직을 고쳐줘.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "만료 로직", quote: "만료 로직을 고쳐줘" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
    extras: {
      modelAnswer: {
        raw: '[{"text":"프로덕션에 배포한다","start":400,"end":420}]',
        accepted: 0,
        rejectedReasons: ["out_of_range"],
      },
    },
  },
  {
    id: "h-model-forged-authority",
    category: "no_invention",
    why: "모델이 derivedBy 를 보내 확정된 척했다. 권한 위조는 좌표와 무관하게 거부된다.",
    turns: [
      {
        text: "세션 만료 로직을 고쳐줘.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "만료 로직", quote: "만료 로직을 고쳐줘" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
    extras: {
      modelAnswer: {
        raw: '[{"text":"세션 만료 시간을 재설정한다","start":0,"end":12,"derivedBy":"runtime_extraction","status":"confirmed"}]',
        accepted: 0,
        rejectedReasons: ["forged_provenance"],
      },
    },
  },
  {
    id: "h-model-quote-mismatch",
    category: "no_invention",
    why: "모델이 보낸 인용이 런타임의 절단과 다르다. 좌표는 원문 안이지만 근거가 아니다.",
    turns: [
      {
        text: "세션 만료 로직을 고쳐줘.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "만료 로직", quote: "만료 로직을 고쳐줘" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
    extras: {
      modelAnswer: {
        raw: '[{"text":"세션을 삭제한다","start":0,"end":6,"quote":"세션을 삭제"}]',
        accepted: 0,
        // Both, and the second was missing from the first draft of this answer:
        // six characters trip the mismatched-quote check *and* the one that says
        // a span that short cannot ground a requirement.
        rejectedReasons: ["quote_mismatch", "too_slight"],
      },
    },
  },

  // --- 과거 실패 보고 · 대상 생략 · 발명 방지 --------------------------------
  {
    id: "h-past-failure-report",
    category: "past_failure",
    why: "'안 됐어' 는 보고다. 요청은 그 다음 문장에 있다.",
    turns: [
      {
        text: "빌드가 안 됐어. 원인을 알려줘.",
        relation: "new_task",
        requirements: [
          { action: "inspect", polarity: "required", target: "원인", quote: "원인을 알려줘" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },
  {
    id: "h-omitted-target-execute",
    category: "omitted_object",
    why: "대상 없는 실행 요청. 물어야 하고, 지어내서는 안 된다.",
    turns: [
      {
        text: "다시 실행해줘.",
        relation: "new_task",
        requirements: [{ action: "execute", polarity: "required", target: null, quote: "다시 실행해줘" }],
      },
    ],
    questions: { expected: ["TARGET_UNRESOLVED"], max: 1 },
    startable: false,
    executable: false,
  },
  {
    id: "h-no-requirement-smalltalk",
    category: "no_invention",
    why: "요청이 아니다. 요구사항 0개이고 실행 가능도 아니다.",
    turns: [{ text: "수고했어, 오늘은 여기까지 하자.", relation: "new_task", requirements: [] }],
    questions: { expected: [], max: 1 },
    startable: false,
    executable: false,
  },
  {
    id: "h-no-requirement-vague-praise",
    category: "no_invention",
    why: "칭찬도 요청이 아니다.",
    turns: [{ text: "잘 하고 있네!", relation: "new_task", requirements: [] }],
    questions: { expected: [], max: 1 },
    startable: false,
    executable: false,
  },

  // --- 병렬 동사 · 조사 -----------------------------------------------------
  {
    id: "h-parallel-three-targets",
    category: "compound",
    why: "한 문장에 세 개의 서로 다른 대상. 하나로 합치면 둘이 사라진다.",
    turns: [
      {
        text: "라우터를 수정하고 미들웨어를 추가하고 낡은 핸들러를 삭제해줘.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "라우터", quote: "라우터를 수정하고" },
          { action: "create", polarity: "required", target: "미들웨어", quote: "미들웨어를 추가하고" },
          { action: "remove", polarity: "required", target: "낡은 핸들러", quote: "낡은 핸들러를 삭제해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 3 },
    startable: true,
    executable: true,
  },
  {
    id: "h-particle-eseo",
    category: "particle",
    why: "'-에서' 가 붙은 앞말은 대상이 아니라 장소다.",
    turns: [
      {
        text: "테스트 환경에서 마이그레이션을 실행해줘.",
        relation: "new_task",
        requirements: [
          { action: "execute", polarity: "required", target: "마이그레이션", quote: "마이그레이션을 실행해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 1 },
    startable: true,
    executable: true,
  },
  {
    id: "h-scope-limited",
    category: "particle",
    why: "범위를 지정한 요청. 범위는 scope 로 잡히고 대상은 따로 남는다.",
    turns: [
      {
        text: "src/api 폴더 안에서만 타입을 수정해줘.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "타입", quote: "타입을 수정해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },
];
