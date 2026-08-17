import type { GoldCase } from "./goldRequirements.ts";

/**
 * The answers, written from the Korean and not from the output.
 *
 * Forty-three cases, each one a sentence a person actually types at a coding
 * agent. What every case records is in `goldRequirements.ts`; what matters about
 * *this* file is the discipline: when the extractor disagrees with a case, the
 * case is the thing that is right until somebody argues otherwise in the
 * `KNOWN_MISSES` table, with a reason and a verdict.
 *
 * ## This is the development set, and it is frozen
 *
 * These 43 cases have been read by the implementation, so they can no longer
 * measure generalisation — every fix since they were written had them in view.
 * They stay as the regression set, and `holdoutCases.ts` is where an unseen
 * measurement now comes from. Its answers were written before any of the code
 * that reads them, and its hash is recorded so that fact stays checkable.
 *
 * ## Change history
 *
 * Every edit to an answer is listed here with why. An answer changed to match
 * the implementation is the one thing that would make this file worthless, so
 * "the implementation disagreed" is never a reason on its own.
 *
 *   1. `no-connective-as-target` — a requirement was **added**. The first draft
 *      recorded one `verify` for "버그를 재현해줘. 그리고 검증해줘." and the second
 *      clause is a second request with no named target. The extractor was right
 *      and the answer was incomplete.
 *   2. `particle-bound-noun` — the target was **corrected** from `있는 모델` to
 *      `모델`. `있는` is a verb ending, not part of the noun phrase; the original
 *      answer copied a fragment.
 *   3. All 43 cases — the `executable` axis was **added** (2026-08-18). It records
 *      whether the harness could run the plan, which `startable` never claimed;
 *      see the field's own note in `goldRequirements.ts`.
 *
 * No answer has been changed in the other direction — to agree with output that
 * disagreed with the Korean.
 *
 * ## How the targets were decided
 *
 * The target is the noun phrase the sentence binds to the verb, in the user's
 * words, with case particles removed — "로그인 오류를 수정해줘" targets `로그인
 * 오류`. Where the sentence binds nothing, the target is `null`, and that is an
 * answer: "테스트해줘" asks for a test run and names no target, so a plan that
 * invents one is wrong and a plan that asks which one is right.
 *
 * ## Where the categories come from
 *
 * Every category is a failure this repository has actually seen: a correction
 * filed as a refinement, an object reaching back across a clause boundary, a
 * past-tense failure report read as an instruction, a user asked to re-authorise
 * the request they had just made. The set is weighted towards those rather than
 * towards easy sentences, which is why the measured rates below are not 1.0 and
 * should not be reported as if they were.
 */

export const GOLD_CASES: readonly GoldCase[] = [
  // --- 명시적 요구 -----------------------------------------------------------
  {
    id: "fix-and-test",
    category: "explicit",
    why: "가장 흔한 요청. 두 개의 요구사항이고, 두 번째의 대상은 문장에 없다.",
    turns: [
      {
        text: "로그인 오류를 수정하고 테스트해줘.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "로그인 오류", quote: "로그인 오류를 수정하고" },
          { action: "verify", polarity: "required", target: null, quote: "테스트해줘" },
        ],
      },
    ],
    questions: { expected: ["TARGET_UNRESOLVED"], max: 2 },
    startable: false,
    executable: false,
  },
  {
    id: "run-named-file",
    category: "explicit",
    why: "파일명은 문장 경계가 아니다. main.py 가 둘로 쪼개지면 대상이 'py' 가 된다.",
    turns: [
      {
        text: "main.py를 실행해줘.",
        relation: "new_task",
        requirements: [
          { action: "execute", polarity: "required", target: "main.py", quote: "main.py를 실행해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 1 },
    startable: true,
    executable: true,
  },
  {
    id: "add-test-file",
    category: "explicit",
    why: "create 는 대상이 있어야 요구사항이 된다. 여기서는 있다.",
    turns: [
      {
        text: "로그인 테스트를 추가해줘.",
        relation: "new_task",
        requirements: [
          { action: "create", polarity: "required", target: "로그인 테스트", quote: "로그인 테스트를 추가해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 1 },
    startable: true,
    executable: true,
  },
  {
    id: "remove-dead-code",
    category: "explicit",
    why: "remove 도 마찬가지. 대상이 이름으로 주어졌다.",
    turns: [
      {
        text: "사용하지 않는 import를 제거해줘.",
        relation: "new_task",
        requirements: [
          { action: "remove", polarity: "required", target: "import", quote: "import를 제거해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 1 },
    startable: true,
    executable: true,
  },

  // --- 금지 -----------------------------------------------------------------
  {
    id: "no-execute-show-code",
    category: "prohibition",
    why: "금지 하나와 요구 하나. 금지된 동사의 긍정형이 만들어지면 사용자의 말과 정반대가 된다.",
    turns: [
      {
        text: "실행하지 말고 코드만 보여줘.",
        relation: "new_task",
        requirements: [
          { action: "forbid_execute", polarity: "forbidden", target: null, quote: "실행하지 말고" },
          { action: "inspect", polarity: "required", target: "코드", quote: "코드만 보여줘" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },
  {
    id: "no-modify-no-execute",
    category: "prohibition",
    why: "-거나 연쇄. 하나의 부정이 두 동사를 덮는다.",
    turns: [
      {
        text: "수정하거나 실행하지 말고 원인만 분석해줘.",
        relation: "new_task",
        requirements: [
          { action: "forbid_modify", polarity: "forbidden", target: null, quote: "수정하거나" },
          { action: "forbid_execute", polarity: "forbidden", target: null, quote: "실행하지 말고" },
          { action: "inspect", polarity: "required", target: "원인", quote: "원인만 분석해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 3 },
    startable: true,
    executable: true,
  },
  {
    id: "particle-between-stem-and-negation",
    category: "prohibition",
    why: "'실행은 하지 마' — 어간과 부정 사이에 조사가 들어간다. 이걸 놓치면 금지가 사라진다.",
    turns: [
      {
        text: "실행은 하지 마. 코드만 설명해줘.",
        relation: "new_task",
        requirements: [
          { action: "forbid_execute", polarity: "forbidden", target: null, quote: "실행은 하지 마" },
          { action: "inspect", polarity: "required", target: "코드", quote: "코드만 설명해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },
  {
    id: "negation-jin-form",
    category: "prohibition",
    why: "'수정하진 마' 는 '수정하지 마' 와 같은 금지다. 어느 쪽도 긍정 요구를 만들어서는 안 된다.",
    turns: [
      {
        text: "수정하진 마. 무엇이 문제인지만 알려줘.",
        relation: "new_task",
        requirements: [
          { action: "forbid_modify", polarity: "forbidden", target: null, quote: "수정하진 마" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },
  {
    id: "negation-myeon-an",
    category: "prohibition",
    why: "'실행하면 안 돼' 도 금지다. 부정이 어미 뒤에 붙는 다른 모양.",
    turns: [
      {
        text: "실행하면 안 돼. 코드만 보여줘.",
        relation: "new_task",
        requirements: [
          { action: "forbid_execute", polarity: "forbidden", target: null, quote: "실행하면 안 돼" },
          { action: "inspect", polarity: "required", target: "코드", quote: "코드만 보여줘" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },

  // --- 정정 · 보완 · 질문 · 계속 ---------------------------------------------
  {
    id: "correction",
    category: "correction",
    why: "정정을 refine 으로 읽으면 이전 요구사항이 그대로 남아 금지와 충돌한다. 실제로 여섯 번 중 한 번 그랬다.",
    turns: [
      {
        text: "main.py를 실행해줘.",
        relation: "new_task",
        requirements: [
          { action: "execute", polarity: "required", target: "main.py", quote: "main.py를 실행해줘" },
        ],
      },
      {
        text: "정정할게. 실행하지 말고 코드만 보여줘.",
        relation: "correct",
        requirements: [
          { action: "forbid_execute", polarity: "forbidden", target: null, quote: "실행하지 말고" },
          { action: "inspect", polarity: "required", target: "코드", quote: "코드만 보여줘" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },
  {
    id: "refinement",
    category: "refinement",
    why: "보완은 앞 요구사항을 지우지 않는다. '추가로' 가 그 신호다.",
    turns: [
      {
        text: "로그인 오류를 수정해줘.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "로그인 오류", quote: "로그인 오류를 수정해줘" },
        ],
      },
      {
        text: "추가로 회귀 테스트도 실행해줘.",
        relation: "refine",
        requirements: [
          { action: "execute", polarity: "required", target: "회귀 테스트", quote: "회귀 테스트도 실행해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },
  {
    id: "question-turn",
    category: "question",
    why: "질문은 새 작업이 아니다. 새 작업으로 읽으면 앞 요구사항이 사라진다.",
    turns: [
      {
        text: "auth.py를 수정해줘.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "auth.py", quote: "auth.py를 수정해줘" },
        ],
      },
      {
        text: "이 오류가 왜 나는지 알려줄래?",
        relation: "question",
        requirements: [],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },
  {
    id: "continuation",
    category: "continuation",
    why: "'계속해줘' 는 앞 작업을 이어가라는 뜻이고, 새 요구사항을 담고 있지 않다.",
    turns: [
      {
        text: "테스트를 실행해줘.",
        relation: "new_task",
        requirements: [
          { action: "execute", polarity: "required", target: "테스트", quote: "테스트를 실행해줘" },
        ],
      },
      { text: "아까 하던 작업 계속해줘.", relation: "continue", requirements: [] },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },

  // --- 복합 요청과 병렬 동사 -------------------------------------------------
  {
    id: "three-verbs-chained",
    category: "compound",
    why: "-고 로 이어진 세 요청. 하나로 읽으면 두 개가 사라진다.",
    turns: [
      {
        text: "테스트를 실행하고 결과를 확인하고 실패한 부분을 수정해줘.",
        relation: "new_task",
        requirements: [
          { action: "execute", polarity: "required", target: "테스트", quote: "테스트를 실행하고" },
          { action: "verify", polarity: "required", target: "결과", quote: "결과를 확인하고" },
          { action: "modify", polarity: "required", target: "실패한 부분", quote: "실패한 부분을 수정해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 3 },
    startable: true,
    executable: true,
  },
  {
    id: "two-inspects-one-sentence",
    category: "compound",
    why: "같은 동사, 다른 대상. 둘을 하나로 합치면 두 번째 요청이 없어진다.",
    turns: [
      {
        text: "main.py 코드도 보여주고 실제 실행 결과도 보여줘.",
        relation: "new_task",
        requirements: [
          { action: "inspect", polarity: "required", target: "main.py 코드", quote: "main.py 코드도 보여주고" },
          { action: "inspect", polarity: "required", target: "실행 결과", quote: "실제 실행 결과도 보여줘" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },
  {
    id: "after-then",
    category: "compound",
    why: "'-한 뒤' 도 절 경계다. 순서가 있는 두 요청.",
    turns: [
      {
        text: "의존성을 설치한 뒤 테스트를 실행해줘.",
        relation: "new_task",
        requirements: [
          { action: "execute", polarity: "required", target: "테스트", quote: "테스트를 실행해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },

  // --- 조사와 생략된 목적어 -------------------------------------------------
  {
    id: "omitted-object-verify",
    category: "omitted_object",
    why: "대상 없는 검증 요청. 대상을 만들어내면 안 되고, 물어야 한다.",
    turns: [
      {
        text: "테스트해줘.",
        relation: "new_task",
        requirements: [{ action: "verify", polarity: "required", target: null, quote: "테스트해줘" }],
      },
    ],
    questions: { expected: ["TARGET_UNRESOLVED"], max: 1 },
    startable: false,
    executable: false,
  },
  {
    id: "omitted-object-execute",
    category: "omitted_object",
    why: "'돌려줘' 도 실행 요청이다. 무엇을 돌릴지는 문장에 없다.",
    turns: [
      {
        text: "한번 돌려줘.",
        relation: "new_task",
        requirements: [{ action: "execute", polarity: "required", target: null, quote: "돌려줘" }],
      },
    ],
    questions: { expected: ["TARGET_UNRESOLVED"], max: 1 },
    startable: false,
    executable: false,
  },
  {
    id: "omitted-object-inspect",
    category: "omitted_object",
    why: "'보여줘' 만으로도 요청이다. 대상은 열린 채로 남아야 한다.",
    turns: [
      {
        text: "보여줘.",
        relation: "new_task",
        requirements: [{ action: "inspect", polarity: "required", target: null, quote: "보여줘" }],
      },
    ],
    questions: { expected: ["TARGET_UNRESOLVED"], max: 1 },
    startable: false,
    executable: false,
  },
  {
    id: "particle-eseoman",
    category: "particle",
    why: "'안에서만' 같은 위치 조사가 대상을 밀어내면 'src' 가 아니라 '폴더' 가 남는다.",
    turns: [
      {
        text: "src 폴더 안에서만 로그를 추가해줘.",
        relation: "new_task",
        requirements: [
          { action: "create", polarity: "required", target: "로그", quote: "로그를 추가해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },
  {
    id: "particle-bound-noun",
    category: "particle",
    why: "'사용할 수 있는 모델' — '수', '있는' 은 대상이 아니다. 조사를 아무 토큰에서 떼면 '있 모델' 이 된다.",
    turns: [
      {
        text: "사용할 수 있는 모델을 확인해줘.",
        relation: "new_task",
        requirements: [
          { action: "verify", polarity: "required", target: "모델", quote: "모델을 확인해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },
  {
    id: "particle-eun-neun",
    category: "particle",
    why: "'-은/는' 이 붙은 명사가 대상이고, 그 뒤의 부사가 대상이 되어서는 안 된다.",
    turns: [
      {
        text: "기존 API 호환성은 반드시 유지해줘.",
        relation: "new_task",
        requirements: [
          { action: "preserve", polarity: "required", target: "API 호환성", quote: "호환성은 반드시 유지해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },

  // --- 과거 실패 보고 -------------------------------------------------------
  {
    id: "past-failure-then-fix",
    category: "past_failure",
    why: "'실행했더니' 는 보고다. 요청으로 읽으면 사용자가 하지 않은 실행 요구가 생긴다.",
    turns: [
      {
        text: "어제 실행했더니 ModuleNotFoundError가 났어. 원인을 찾아줘.",
        relation: "new_task",
        requirements: [
          { action: "inspect", polarity: "required", target: "원인", quote: "원인을 찾아줘" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },
  {
    id: "past-failure-retry",
    category: "past_failure",
    why: "'실행했는데 실패했어' 는 보고, '다시 실행해줘' 는 요청. 둘을 섞으면 요구사항이 두 배가 된다.",
    turns: [
      {
        text: "테스트를 실행해줘.",
        relation: "new_task",
        requirements: [
          { action: "execute", polarity: "required", target: "테스트", quote: "테스트를 실행해줘" },
        ],
      },
      {
        text: "실행했는데 실패했어. 다시 실행해줘.",
        relation: "new_task",
        requirements: [{ action: "execute", polarity: "required", target: null, quote: "다시 실행해줘" }],
      },
    ],
    questions: { expected: ["TARGET_UNRESOLVED"], max: 2 },
    startable: false,
    executable: false,
  },
  {
    id: "past-failure-not-a-prohibition",
    category: "past_failure",
    why: "'실행하지 못했어' 는 금지가 아니라 실패 보고다. 금지로 읽으면 요청한 일을 거부한다.",
    turns: [
      {
        text: "어제는 실행하지 못했어. 오늘은 main.py를 실행해줘.",
        relation: "new_task",
        requirements: [
          { action: "execute", polarity: "required", target: "main.py", quote: "main.py를 실행해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },

  // --- 조건부 -------------------------------------------------------------
  {
    id: "conditional-prohibition",
    category: "conditional",
    why: "조건이 성립하는지 아무도 모른다. 요구는 분명하고 실행 가능성은 아니다.",
    turns: [
      {
        text: "기존 클라이언트가 사용 중이라면 API를 변경하지 마.",
        relation: "new_task",
        requirements: [
          {
            action: "forbid_modify",
            polarity: "forbidden",
            target: null,
            quote: "사용 중이라면 API를 변경하지 마",
          },
        ],
      },
    ],
    questions: { expected: ["UNRESOLVED_CONDITION"], max: 2 },
    startable: false,
    executable: false,
  },
  {
    id: "conditional-requirement",
    category: "conditional",
    why: "조건부 요구도 요구다. 조건을 무시하고 실행 가능으로 표시하면 사용자가 결정한 적 없는 일을 한다.",
    turns: [
      {
        text: "테스트가 실패하면 로그를 추가해줘.",
        relation: "new_task",
        requirements: [
          { action: "create", polarity: "required", target: "로그", quote: "로그를 추가해줘" },
        ],
      },
    ],
    questions: { expected: ["UNRESOLVED_CONDITION"], max: 2 },
    startable: false,
    executable: false,
  },
  {
    id: "while-modifying-not-conditional",
    category: "conditional",
    why: "'수정하면서' 는 조건이 아니라 동시성이다. 조건으로 읽으면 멀쩡한 요청이 막힌다.",
    turns: [
      {
        text: "auth.py를 수정하면서 테스트를 실행해줘.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "auth.py", quote: "auth.py를 수정하면서" },
          { action: "execute", polarity: "required", target: "테스트", quote: "테스트를 실행해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },

  // --- 기존 동작 유지 -------------------------------------------------------
  {
    id: "preserve-behaviour",
    category: "preserve",
    why: "유지는 수정의 반대다. functional 로 분류되면 설계가 정반대를 증명하는 시나리오를 붙인다.",
    turns: [
      {
        text: "기존 동작은 그대로 유지해줘.",
        relation: "new_task",
        requirements: [
          { action: "preserve", polarity: "required", target: "기존 동작", quote: "기존 동작은 그대로 유지해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },
  {
    id: "preserve-and-modify",
    category: "preserve",
    why: "같은 대상에 대한 수정과 유지. 둘 다 요구사항이고, 충돌은 사용자만 풀 수 있다.",
    turns: [
      {
        text: "함수 이름을 바꿔주고 기존 이름도 그대로 유지해줘.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "함수 이름", quote: "함수 이름을 바꿔주고" },
          { action: "preserve", polarity: "required", target: "기존 이름", quote: "기존 이름도 그대로 유지해줘" },
        ],
      },
    ],
    questions: { expected: ["REQUIREMENT_CONFLICT"], max: 2 },
    startable: false,
    executable: false,
  },

  // --- 코드 분석 · 설명 -----------------------------------------------------
  {
    id: "explain-function",
    category: "inspect",
    why: "설명 요청은 수정 요청이 아니다. 대상은 문장에 있다.",
    turns: [
      {
        text: "handleLogin 함수를 설명해줘.",
        relation: "new_task",
        requirements: [
          { action: "inspect", polarity: "required", target: "handleLogin 함수", quote: "handleLogin 함수를 설명해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 1 },
    startable: true,
    executable: true,
  },
  {
    id: "analyse-structure",
    category: "inspect",
    why: "분석도 inspect 다. 파일을 건드리지 않는 요구가 수정으로 분류되면 승인 흐름이 달라진다.",
    turns: [
      {
        text: "저장소 구조를 분석해줘.",
        relation: "new_task",
        requirements: [
          { action: "inspect", polarity: "required", target: "저장소 구조", quote: "저장소 구조를 분석해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 1 },
    startable: true,
    executable: true,
  },
  {
    id: "named-source",
    category: "inspect",
    why: "출처를 지목한 요청. 읽지 않고 그 출처로 보고하는 것을 막는 요구사항이 하나 더 생긴다.",
    turns: [
      {
        text: "https://nodejs.org/api/test.html 를 읽고 정리해줘.",
        relation: "new_task",
        requirements: [
          { action: "read_source", polarity: "required", target: "nodejs.org", quote: "nodejs.org" },
        ],
      },
    ],
    questions: { expected: [], max: 2 },
    startable: true,
    executable: true,
  },

  // --- 한국어 · 영어 혼합 ---------------------------------------------------
  {
    id: "mixed-path-and-identifier",
    category: "mixed_script",
    why: "경로와 식별자가 영어, 문장은 한국어. 토큰 창이 좁으면 대상이 '파일' 로 뭉개진다.",
    turns: [
      {
        text: "src/auth/login.ts 파일의 handleLogin 함수를 수정해줘.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "handleLogin 함수", quote: "handleLogin 함수를 수정해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 1 },
    startable: true,
    executable: true,
  },
  {
    id: "mixed-command-name",
    category: "mixed_script",
    why: "명령 이름이 영어일 때 조사 붙임이 달라진다. 'pytest를' 은 맞고 'pytest을' 은 틀리다.",
    turns: [
      {
        text: "CI에서 pytest를 실행해줘.",
        relation: "new_task",
        requirements: [
          { action: "execute", polarity: "required", target: "pytest", quote: "pytest를 실행해줘" },
        ],
      },
    ],
    questions: { expected: [], max: 1 },
    startable: true,
    executable: true,
  },
  {
    id: "mixed-english-error-name",
    category: "mixed_script",
    why: "영어 예외 이름이 대상이 되는 경우. 한글 조사가 붙어도 이름은 그대로 남아야 한다.",
    turns: [
      {
        text: "TypeError를 고쳐줘.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "TypeError", quote: "TypeError를 고쳐줘" },
        ],
      },
    ],
    questions: { expected: [], max: 1 },
    startable: true,
    executable: true,
  },

  // --- 잘못된 대상 결합 방지 -------------------------------------------------
  {
    id: "no-cross-clause-binding",
    category: "wrong_binding",
    why: "'auth.py를 수정하고 실행해줘' 의 실행 대상은 auth.py 가 아니다. 절을 넘어 명사를 끌어오면 사용자가 하지 않은 요구가 된다.",
    turns: [
      {
        text: "auth.py를 수정하고 실행해줘.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "auth.py", quote: "auth.py를 수정하고" },
          { action: "execute", polarity: "required", target: null, quote: "실행해줘" },
        ],
      },
    ],
    questions: { expected: ["TARGET_UNRESOLVED"], max: 2 },
    startable: false,
    executable: false,
  },
  {
    id: "no-connective-as-target",
    category: "wrong_binding",
    why:
      "'그리고' 는 대상이 아니다. 실제로 '그리고를 확인한다' 가 만들어진 적이 있다. " +
      "두 번째 절은 진짜 요청이고, 그 대상은 문장에 없다 — 이 케이스의 첫 판은 두 번째를 빠뜨렸고, " +
      "추출기가 옳고 정답이 틀렸다.",
    turns: [
      {
        text: "버그를 재현해줘. 그리고 검증해줘.",
        relation: "new_task",
        requirements: [
          { action: "verify", polarity: "required", target: "버그", quote: "버그를 재현해줘" },
          { action: "verify", polarity: "required", target: null, quote: "검증해줘" },
        ],
      },
    ],
    questions: { expected: ["TARGET_UNRESOLVED"], max: 2 },
    startable: false,
    executable: false,
  },

  // --- 과다 질문 방지 -------------------------------------------------------
  {
    id: "no-question-for-clear-request",
    category: "question_restraint",
    why: "대상과 행동이 모두 분명하면 물을 것이 없다. 사용자가 방금 한 말을 되묻는 것이 가장 흔한 과다 질문이었다.",
    turns: [
      {
        text: "README.md를 보여줘.",
        relation: "new_task",
        requirements: [
          { action: "inspect", polarity: "required", target: "README.md", quote: "README.md를 보여줘" },
        ],
      },
    ],
    questions: { expected: [], max: 0 },
    startable: true,
    executable: true,
  },
  {
    id: "one-question-per-requirement",
    category: "question_restraint",
    why: "요구사항 하나에 finding 이 여러 개 붙어도 질문은 하나다. 세 번 물으면 심문이 된다.",
    turns: [
      {
        text: "테스트해줘.",
        relation: "new_task",
        requirements: [{ action: "verify", polarity: "required", target: null, quote: "테스트해줘" }],
      },
    ],
    questions: { expected: ["TARGET_UNRESOLVED"], max: 1 },
    startable: false,
    executable: false,
  },

  // --- 요구사항 발명 방지 ---------------------------------------------------
  {
    id: "vague-no-requirement",
    category: "no_invention",
    why: "동사가 없으면 요구사항도 없다. '적당히 잘' 에서 무엇이든 만들어내는 것이 최악의 실패다.",
    turns: [{ text: "적당히 잘 좀 해줘.", relation: "new_task", requirements: [] }],
    questions: { expected: [], max: 1 },
    startable: false,
    executable: false,
  },
  {
    id: "thanks-no-requirement",
    category: "no_invention",
    why: "감사 인사는 요청이 아니다.",
    turns: [{ text: "고마워, 잘 됐어.", relation: "new_task", requirements: [] }],
    questions: { expected: [], max: 1 },
    startable: false,
    executable: false,
  },
  {
    id: "no-invented-deploy",
    category: "no_invention",
    why: "수정과 테스트만 요청했다. 배포·성능·삭제는 어디에도 없다.",
    turns: [
      {
        text: "결제 버그를 고치고 확인해줘.",
        relation: "new_task",
        requirements: [
          { action: "modify", polarity: "required", target: "결제 버그", quote: "결제 버그를 고치고" },
          { action: "verify", polarity: "required", target: null, quote: "확인해줘" },
        ],
      },
    ],
    questions: { expected: ["TARGET_UNRESOLVED"], max: 2 },
    startable: false,
    executable: false,
  },
];
