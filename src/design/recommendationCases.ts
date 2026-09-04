import { measure, type ModelProfile } from "../router/modelProfile.ts";
import type { ExclusionCode } from "../router/eligibility.ts";

/**
 * What a good recommendation looks like, written down.
 *
 * The router has ranked models since it was built and nothing has ever said
 * whether it ranks them *well*. Changing a weight, adding a term, or fixing a
 * demand could not be called an improvement or a regression, because there was
 * no denominator — the audit's words, and it was right.
 *
 * ## Why the expectations are relative, not absolute
 *
 * "This request should get qwen2.5-coder-32b" is not a claim anyone here can
 * defend: it depends on a gateway's catalogue, on evaluations that may not
 * exist, and on the day. So every case below fixes the *candidates* instead —
 * synthetic profiles whose strengths are stated — and asserts which of them
 * should win and on which capability. That is falsifiable without pretending to
 * know a truth about the world:
 *
 *     a request whose top demand is webResearch
 *     against a model with webResearch 0.9 and one with 0.1
 *     must not pick the second
 *
 * If it does, something is wrong with the router, the profile, or the demand
 * projection, and the case says which capability to look at first.
 *
 * ## What a case may not assume
 *
 * The expected capability is checked against the profile the designer actually
 * derives, not against the one the case author imagined — see the test, which
 * refuses a case whose `becauseCapability` the request does not demand. An
 * expectation nobody can trace to a demand is a preference, and a preference
 * dressed as a measurement is what this file exists to avoid.
 */

/** A capability the router might decide on. Narrow on purpose. */
export type Capability =
  | "coding"
  | "debugging"
  | "reasoning"
  | "codeReview"
  | "architecture"
  | "toolUse"
  | "commandExecution"
  | "webResearch"
  | "sourceGrounding"
  | "instructionFollowing"
  | "recovery"
  | "multiTurnContinuity";

export interface CandidateSpec {
  id: string;
  /** Capabilities this harness measured itself. Absent means unknown, not zero. */
  strong?: Partial<Record<Capability, number>>;
  /**
   * Capabilities the provider claims but nobody here measured.
   *
   * The distinction the router splits into two terms: `capabilityScore` reads
   * every capability whatever its origin, and `evaluationScore` reads only what
   * this harness measured. A corpus whose candidates are all measured cannot
   * tell the two apart — removing either term leaves the other carrying the
   * identical signal, which is how three mutations of the ranker passed this
   * file untouched.
   */
  declared?: Partial<Record<Capability, number>>;
  contextWindow?: number;
  available?: boolean;
  /** Null when the model cannot drive the loop at all — an embedding endpoint. */
  protocol?: "native" | "text" | null;
  /** Zero means nobody has evaluated it. */
  samples?: number;
}

export interface RecommendationCase {
  id: string;
  /** The request, in the user's own words. */
  request: string;
  /** Why this expectation is defensible rather than a preference. */
  why: string;
  candidates: CandidateSpec[];
  /** The candidate that should win, or null when none should be eligible. */
  expectWinner: string | null;
  /**
   * The capability the choice should turn on.
   *
   * Checked against the demand the designer derives for `request`, so a case
   * cannot assert a basis the request does not have.
   */
  becauseCapability?: Capability;
  /** Candidates that must be excluded before scoring, and under which code. */
  expectExcluded?: Array<{ id: string; code: ExclusionCode }>;
}

/** Builds a profile from a candidate spec. Unstated capabilities stay unknown. */
export function profileOf(spec: CandidateSpec): ModelProfile {
  const capabilities: ModelProfile["capabilities"] = {};
  const samples = spec.samples ?? 20;
  for (const [key, value] of Object.entries(spec.declared ?? {})) {
    // A declaration carries no sample count, because nobody ran anything.
    capabilities[key as Capability] = measure(value, "declared", 0);
  }
  for (const [key, value] of Object.entries(spec.strong ?? {})) {
    capabilities[key as Capability] = measure(value, "harness_eval", samples);
  }
  return {
    modelId: spec.id,
    availability: {
      available: spec.available ?? true,
      protocol: spec.protocol === undefined ? "native" : spec.protocol,
      contextWindow: spec.contextWindow ?? 128_000,
      maxOutputTokens: 8_000,
      supportsNativeTools: spec.protocol !== null,
    },
    capabilities,
    efficiency: {},
    semanticDescription: spec.id,
    evidence: { evalSampleCount: samples },
  };
}

/**
 * A pair of candidates that differ on one capability and agree on the rest.
 *
 * The shape most cases use, because it isolates what the assertion is about: if
 * the only difference between two models is `webResearch`, a webResearch-heavy
 * request choosing the weaker one cannot be explained by anything else.
 */
function pair(
  capability: Capability,
  strongId: string,
  weakId: string,
  baseline: Partial<Record<Capability, number>> = {},
): CandidateSpec[] {
  return [
    { id: strongId, strong: { ...baseline, [capability]: 0.9 } },
    { id: weakId, strong: { ...baseline, [capability]: 0.1 } },
  ];
}

/** Capabilities every candidate in a pair shares, so only the axis differs. */
const EVEN: Partial<Record<Capability, number>> = {
  reasoning: 0.5,
  instructionFollowing: 0.5,
  toolUse: 0.5,
};

export const RECOMMENDATION_CASES: readonly RecommendationCase[] = [
  {
    id: "coding-work-prefers-coding",
    request: "로그인 오류를 수정하고 테스트해줘.",
    why: "고치고 검증하는 요청의 최상위 수요는 coding 이다. 두 후보가 coding 에서만 다르면 선택은 그 축에서 갈려야 한다.",
    candidates: pair("coding", "coder", "not-a-coder", EVEN),
    expectWinner: "coder",
    becauseCapability: "coding",
  },
  {
    id: "debugging-work-prefers-debugging",
    request: "로그인 오류를 수정하고 테스트해줘.",
    why: "같은 요청이 debugging 도 0.8 로 요구한다. coding 을 동일하게 두면 debugging 이 결정해야 한다.",
    candidates: pair("debugging", "debugger", "not-a-debugger", { ...EVEN, coding: 0.7 }),
    expectWinner: "debugger",
    becauseCapability: "debugging",
  },
  {
    id: "web-request-prefers-web",
    request: "최신 요약 모델을 웹에서 찾아서 정리해줘.",
    why: "밖에 나가서 확인하라는 요청이다. webResearch 가 최상위 수요이고, 코드를 잘 쓰는 것은 이 요청을 만족시키지 못한다.",
    candidates: pair("webResearch", "researcher", "homebody", EVEN),
    expectWinner: "researcher",
    becauseCapability: "webResearch",
  },
  {
    id: "web-request-prefers-source-grounding",
    request: "최신 요약 모델을 웹에서 찾아서 정리해줘.",
    why: "읽은 것을 출처와 함께 말하는 능력도 같은 요청이 0.9 로 요구한다. 웹 접근만으로는 부족하다.",
    candidates: pair("sourceGrounding", "cites-sources", "makes-it-up", { ...EVEN, webResearch: 0.7 }),
    expectWinner: "cites-sources",
    becauseCapability: "sourceGrounding",
  },
  {
    id: "analysis-prefers-reasoning",
    request: "이 저장소 구조를 분석하고 개선 방향을 알려줘.",
    why: "무엇을 고칠지 정하는 요청이다. 수요는 reasoning 과 codeReview 이고 명령 실행은 요구되지 않는다.",
    candidates: pair("reasoning", "thinker", "doer", EVEN),
    expectWinner: "thinker",
    becauseCapability: "reasoning",
  },
  {
    id: "command-work-prefers-execution",
    request: "빌드를 실행해줘.",
    why: "실행 요청의 최상위 수요는 commandExecution 이다.",
    candidates: pair("commandExecution", "runner", "talker", EVEN),
    expectWinner: "runner",
    becauseCapability: "commandExecution",
  },
  {
    id: "install-and-train-prefers-execution",
    request: "torch를 설치하고 학습을 돌려줘.",
    why: "설치와 학습은 둘 다 명령을 돌리는 일이고, 수요도 commandExecution 이 최상위로 나온다.",
    candidates: pair("commandExecution", "runner", "talker", EVEN),
    expectWinner: "runner",
    becauseCapability: "commandExecution",
  },
  {
    id: "prohibition-prefers-instruction-following",
    request: "코드를 실행하지 말고 읽기만 해줘.",
    why: "사용자가 금지한 요청에서 가장 중요한 것은 그 지시를 지키는 능력이다. 수요도 instructionFollowing 이 0.9 로 최상위다.",
    candidates: pair("instructionFollowing", "obedient", "wilful", EVEN),
    expectWinner: "obedient",
    becauseCapability: "instructionFollowing",
  },

  // --- what must be excluded before anything is scored ----------------------
  {
    id: "unavailable-is-excluded",
    request: "로그인 오류를 수정하고 테스트해줘.",
    why: "게이트웨이가 못 쓴다고 한 모델은 아무리 좋아도 후보가 아니다. 점수로 이길 수 있으면 안 된다.",
    candidates: [
      { id: "great-but-down", strong: { coding: 0.99, ...EVEN }, available: false },
      { id: "ordinary", strong: { coding: 0.5, ...EVEN } },
    ],
    expectWinner: "ordinary",
    expectExcluded: [{ id: "great-but-down", code: "MODEL_UNAVAILABLE" }],
  },
  {
    id: "no-protocol-is-excluded",
    request: "빌드를 실행해줘.",
    why: "도구를 부를 수 없는 엔드포인트는 실행 요청을 맡을 수 없다. 능력치와 무관하다.",
    candidates: [
      { id: "embedding-endpoint", strong: { commandExecution: 0.99, ...EVEN }, protocol: null },
      { id: "ordinary", strong: { commandExecution: 0.5, ...EVEN } },
    ],
    expectWinner: "ordinary",
    expectExcluded: [{ id: "embedding-endpoint", code: "CANNOT_CONVERSE" }],
  },
  {
    id: "nothing-eligible-is-an-answer",
    request: "빌드를 실행해줘.",
    why: "후보가 전부 걸러지면 '적당한 모델이 없다' 가 답이고, 걸러진 이유가 함께 있어야 한다. 억지로 하나를 고르면 안 된다.",
    candidates: [
      { id: "down-a", strong: { commandExecution: 0.9 }, available: false },
      { id: "down-b", strong: { commandExecution: 0.8 }, available: false },
    ],
    expectWinner: null,
    expectExcluded: [
      { id: "down-a", code: "MODEL_UNAVAILABLE" },
      { id: "down-b", code: "MODEL_UNAVAILABLE" },
    ],
  },

  // --- evidence, and the absence of it --------------------------------------
  {
    id: "declared-strength-decides-when-evaluation-cannot",
    request: "로그인 오류를 수정하고 테스트해줘.",
    why:
      "한쪽은 공급자가 coding 0.95 라고 선언했을 뿐 측정된 적이 없고, 다른 쪽은 0.6 으로 측정됐다. " +
      "측정 항은 선언을 읽지 않으므로 그 항만으로는 측정된 쪽이 근소하게 앞선다. " +
      "능력 항이 선언까지 읽어 그 차이를 뒤집는지가 이 사례의 질문이다 — 선언도 증거이며, " +
      "얼마나 약한 증거인지는 confidence 가 따로 말한다.",
    candidates: [
      { id: "b-declared-strong", declared: { coding: 0.95 }, strong: { ...EVEN } },
      { id: "a-measured-middling", strong: { coding: 0.6, ...EVEN } },
    ],
    expectWinner: "b-declared-strong",
    becauseCapability: "coding",
  },
  {
    id: "measured-beats-declared-at-the-same-value",
    request: "로그인 오류를 수정하고 테스트해줘.",
    why:
      "같은 값을 주장해도 측정된 것과 선언된 것은 같은 근거가 아니다. 능력 항은 둘을 같게 보므로, " +
      "이 사례를 가르는 것은 측정 항뿐이다.",
    candidates: [
      { id: "b-measured", strong: { coding: 0.8, ...EVEN } },
      { id: "a-declared", declared: { coding: 0.8 }, strong: { ...EVEN } },
    ],
    expectWinner: "b-measured",
    becauseCapability: "coding",
  },
  {
    id: "measured-beats-unmeasured",
    request: "로그인 오류를 수정하고 테스트해줘.",
    why: "같은 값을 주장해도, 이 하네스에서 20회 측정된 것과 한 번도 측정되지 않은 것은 같은 근거가 아니다.",
    candidates: [
      { id: "measured", strong: { coding: 0.8, ...EVEN }, samples: 20 },
      { id: "never-measured", samples: 0 },
    ],
    expectWinner: "measured",
    becauseCapability: "coding",
  },

  // --- the three project topics, which this file had never been asked ------
  //
  // Fourteen cases and six requests, every one of them a short coding chore —
  // the corpus the extractor started from, and the same blind spot. The
  // designer is now asked generative-media requests all the way through and the
  // router had never been scored on one, so "14/14" said as much about the
  // requests as about the ranker.
  //
  // Written the same way as everything above: the candidates are synthetic and
  // the expectation is which axis decides, never which real model wins.
  {
    id: "media-build-prefers-coding",
    request: "업로드한 사진을 5초짜리 영상으로 만들어줘.",
    why:
      "프로젝트1의 문장 그대로다. 영상을 만들어달라는 것은 그 일을 하는 코드를 " +
      "만들어달라는 것이고, 최상위 수요는 coding 으로 나온다.",
    candidates: pair("coding", "coder", "not-a-coder", EVEN),
    expectWinner: "coder",
    becauseCapability: "coding",
  },
  {
    id: "media-feature-prefers-instruction-following",
    request: "프레임 수와 해상도를 설정할 수 있게 해줘.",
    why:
      "사용자가 무엇을 조절할 수 있어야 하는지 두 가지를 명시했다. 둘 중 하나만 " +
      "만드는 것은 요청을 지키지 않은 것이므로 instructionFollowing 이 걸린다.",
    candidates: pair("instructionFollowing", "obedient", "wilful", { ...EVEN, coding: 0.7 }),
    expectWinner: "obedient",
    becauseCapability: "instructionFollowing",
  },
  {
    id: "media-quality-check-prefers-debugging",
    request: "렌더링 속도를 측정하고 결과를 비교해줘.",
    why:
      "재고 비교하라는 요청이다. 무엇이 느린지 알아내는 일이므로 debugging 이 " +
      "최상위 수요이고, 코드를 잘 쓰는 것으로는 대신할 수 없다.",
    candidates: pair("debugging", "debugger", "not-a-debugger", EVEN),
    expectWinner: "debugger",
    becauseCapability: "debugging",
  },
  {
    id: "media-model-hunt-prefers-source-grounding",
    request: "Hugging Face에서 쓸 만한 영상 생성 모델을 찾아줘.",
    why:
      "사용자가 어디를 볼지 이미 말했다. 밖에 나가는 능력만으로는 부족하고, 읽은 " +
      "것을 그 출처와 함께 말하는 능력이 같은 값으로 요구된다.",
    candidates: pair("sourceGrounding", "cites-sources", "makes-it-up", { ...EVEN, webResearch: 0.7 }),
    expectWinner: "cites-sources",
    becauseCapability: "sourceGrounding",
  },
  {
    id: "media-render-prefers-execution",
    request: "생성한 영상을 mp4로 저장하고 품질을 확인해줘.",
    why: "저장하고 확인하는 일은 무언가를 돌려야 끝난다. commandExecution 이 요구된다.",
    candidates: pair("commandExecution", "runner", "talker", { ...EVEN, coding: 0.7, debugging: 0.7 }),
    expectWinner: "runner",
    becauseCapability: "commandExecution",
  },
  {
    id: "continue-prefers-continuity",
    request: "이어서 해줘.",
    why:
      "여러 턴에 걸친 작업을 이어가는 것이 이 요청의 전부다. multiTurnContinuity 는 " +
      "수요 표에 있으면서 한 번도 결정 축이 된 적이 없었다.",
    candidates: pair("multiTurnContinuity", "remembers", "forgets", EVEN),
    expectWinner: "remembers",
    becauseCapability: "multiTurnContinuity",
  },
];
