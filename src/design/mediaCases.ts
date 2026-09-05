import type { ActionKind } from "./functionalExtract.ts";

/**
 * Requests from a domain the extractor has never seen: generative media.
 *
 * The three project topics are the user's, given as a test of the designer:
 * turning an image into a video, turning an image plus a prompt into a video,
 * and turning a prompt alone into an image or a video. The sentences are what a
 * person asking for those projects types.
 *
 * ## What kind of set this is, stated plainly
 *
 * A **development set for a new domain**, not a holdout. `holdoutCases.ts` is a
 * holdout because its answers were written before the code that reads them and
 * its hash is pinned; these were written by the same pass that then fixed the
 * extractor, so they cannot measure generalisation and must not be described as
 * if they could.
 *
 * What they can do is the thing that matters here: the domain's vocabulary and
 * its sentence shapes were never in view while the extractor was built. It grew
 * around editing a repository, then around training a model. Nobody had ever
 * asked it to render, export, convert or save anything, and nobody had written
 * "…할 수 있게 해줘" at it — which turns out to be how a person states a feature
 * request in Korean, and which it read as nothing at all.
 *
 * ## How a target was decided
 *
 * The same rule the gold set settled on, applied here without exception:
 *
 *   · The target is the noun phrase the sentence binds to the verb.
 *   · A **relative clause** is not part of it. "사용할 수 있는 모델" targets
 *     `모델`; likewise "생성된 영상" targets `영상` and "이미지와 텍스트를 같이
 *     입력받는 API" targets `API`. This is the rule the gold set corrected itself
 *     to, and copying a fragment of the modifier was the mistake it corrected.
 *   · A **noun-noun compound or an adnominal modifier** is part of it: `생성
 *     속도`, `결과 영상`, `프레임 수와 해상도`.
 *   · An **instrumental phrase** (`-로`, `-으로`) is not the target. "영상을 mp4로
 *     내보내줘" targets `결과 영상`, not `mp4`; "결과를 미리보기로 보여줘" targets
 *     `결과`, not `결과 미리보기`.
 *   · `null` means the sentence names no target, which is an answer.
 *
 * ## Where the act was genuinely arguable
 *
 * Recorded rather than smoothed over, because a reader should be able to
 * disagree with a specific decision instead of with a vibe:
 *
 *   · `변환` and `바꾸다` (convert an image to a video) are `modify`. Nothing new
 *     is authored; an existing thing is turned into another form. The competing
 *     reading — that a new video is created — is defensible, and the deciding
 *     argument is that the sentence's object is the *source*, not the result.
 *   · `저장`, `내보내다` are `create`: a file that did not exist now does.
 *   · `렌더링` is `execute`. It names running a renderer, and the sentence's
 *     object is what the run produces rather than what it edits.
 *   · `지원하다` is `create`. "이미지 생성과 영상 생성을 모두 지원해줘" asks for
 *     both to be built.
 *   · `-ㄹ 수 있게 해줘` takes the act of its inner verb, not of `하다`.
 *     "설정할 수 있게 해줘" is a request to make configuration possible, and the
 *     act a runtime would have to perform is `modify`.
 */

/** One thing a careful reader finds in the sentence. */
export interface MediaRequirement {
  action: ActionKind;
  /** Exactly as the sentence names it, or null when it names none. */
  target: string | null;
}

export interface MediaCase {
  id: string;
  /** Which of the three project topics this belongs to. */
  topic: "image_to_video" | "image_prompt_to_video" | "prompt_to_media" | "operating";
  text: string;
  /** Why this sentence is in the set — the shape it tests, in its own terms. */
  why: string;
  requirements: readonly MediaRequirement[];
}

export const MEDIA_CASES: readonly MediaCase[] = [
  // --- 프로젝트 1: 이미지 → 동영상 -------------------------------------------
  {
    id: "m-project-image-to-video",
    topic: "image_to_video",
    text: "사용자가 올린 이미지를 동영상으로 만들어주는 프로젝트를 만들어줘.",
    why: "주제 문장 그대로. 관형절이 목적어를 감싸고, 그 안에 `으로` 가 들어 있다.",
    requirements: [{ action: "create", target: "프로젝트" }],
  },
  {
    id: "m-convert-to-clip",
    topic: "image_to_video",
    text: "이미지 한 장을 5초 영상으로 변환해줘.",
    why: "`변환` 은 이 도메인의 중심 동사인데 목록에 없었다.",
    requirements: [{ action: "modify", target: "이미지 한 장" }],
  },
  {
    id: "m-photo-to-animation",
    topic: "image_to_video",
    text: "업로드한 사진을 애니메이션으로 바꿔줘.",
    why: "자음으로 끝나는 명사 뒤의 `으로`. `애니메이션으` 가 남았다.",
    // `업로드한` stays. Not a special case for this corpus — it is the rule the
    // gold set already fixed and pinned: a contentful adnominal belongs to the
    // noun phrase ("실패한 부분", "낡은 설정"), and only a bound-verb chain does
    // not ("사용할 수 있는 모델" → 모델). Writing `사진` here would have made this
    // set quietly disagree with the corpus next to it.
    requirements: [{ action: "modify", target: "업로드한 사진" }],
  },
  {
    id: "m-render-video",
    topic: "image_to_video",
    text: "이미지를 받아서 동영상을 렌더링해줘.",
    why: "`렌더링` 이 없었다. 앞의 `받아서` 는 수단이지 별도 요청이 아니다.",
    requirements: [{ action: "execute", target: "동영상" }],
  },
  {
    id: "m-add-motion",
    topic: "image_to_video",
    text: "정지 이미지에 움직임을 넣어줘.",
    why: "`넣다` — 무언가를 더해 달라는 가장 평범한 말 중 하나.",
    requirements: [{ action: "create", target: "움직임" }],
  },
  {
    id: "m-export-mp4",
    topic: "image_to_video",
    text: "결과 영상을 mp4로 내보내줘.",
    why: "`내보내다`, 그리고 `mp4로` 는 도구이지 대상이 아니다.",
    requirements: [{ action: "create", target: "결과 영상" }],
  },
  {
    id: "m-save-output",
    topic: "image_to_video",
    text: "생성된 영상을 저장해줘.",
    why: "`저장` 이 없었다. `생성된` 은 관형절이므로 목적어에서 빠진다.",
    requirements: [{ action: "create", target: "영상" }],
  },
  {
    id: "m-configurable-params",
    topic: "image_to_video",
    text: "프레임 수와 해상도를 설정할 수 있게 해줘.",
    why: "`-ㄹ 수 있게 해줘`. 기능 요청을 한국어로 말하는 가장 흔한 형태이고, 아무것도 읽히지 않았다.",
    requirements: [{ action: "modify", target: "프레임 수와 해상도" }],
  },

  // --- 프로젝트 2: 이미지 + 프롬프트 → 동영상 --------------------------------
  {
    id: "m-image-and-prompt",
    topic: "image_prompt_to_video",
    text: "이미지와 프롬프트를 받아서 동영상을 생성해줘.",
    why: "이미 읽히던 형태. 이 집합이 회귀를 잡아내는지 확인하는 기준선.",
    requirements: [{ action: "create", target: "동영상" }],
  },
  {
    id: "m-photo-plus-sentence",
    topic: "image_prompt_to_video",
    text: "사진 한 장과 설명 문장으로 영상을 만들어줘.",
    why: "`-으로` 로 끝나는 도구 구가 목적어 앞에 온다. 목적어는 `영상` 뿐이다.",
    requirements: [{ action: "create", target: "영상" }],
  },
  {
    id: "m-animate-by-prompt",
    topic: "image_prompt_to_video",
    text: "프롬프트에 맞춰 이미지를 움직이게 해줘.",
    why: "`-게 해줘` 의 짧은 형태. `수 있게` 가 없어도 같은 구문이다.",
    requirements: [{ action: "modify", target: "이미지" }],
  },
  {
    id: "m-dual-input-api",
    topic: "image_prompt_to_video",
    text: "이미지와 텍스트를 같이 입력받는 API를 구현해줘.",
    why: "관형절이 목적어를 앞에서 길게 수식한다. 대상은 `API`.",
    requirements: [{ action: "create", target: "API" }],
  },
  {
    id: "m-conditional-comparison",
    topic: "image_prompt_to_video",
    text: "프롬프트를 바꾸면 결과가 어떻게 달라지는지 비교해줘.",
    why: "`-면` 은 조건이지 요청이 아니다. 요청은 비교 하나뿐이고, 조건절의 동사가 요구사항이 되면 사용자가 하지 않은 말을 하는 것이다.",
    requirements: [{ action: "inspect", target: "결과" }],
  },

  // --- 프로젝트 3: 프롬프트 → 이미지 또는 동영상 -----------------------------
  {
    id: "m-prompt-only-tool",
    topic: "prompt_to_media",
    text: "프롬프트만 가지고 이미지나 동영상을 생성하는 도구를 만들어줘.",
    why: "주제 문장 그대로. 목적어는 `도구` 이고 앞은 전부 관형절이다.",
    requirements: [{ action: "create", target: "도구" }],
  },
  {
    id: "m-text-to-image",
    topic: "prompt_to_media",
    text: "텍스트에서 이미지를 생성해줘.",
    why: "`-에서` 는 출처이지 대상이 아니다.",
    requirements: [{ action: "create", target: "이미지" }],
  },
  {
    id: "m-text-to-video",
    topic: "prompt_to_media",
    text: "텍스트에서 영상을 뽑아줘.",
    why: "`뽑다` — 생성을 말하는 구어체.",
    requirements: [{ action: "create", target: "영상" }],
  },
  {
    id: "m-support-both",
    topic: "prompt_to_media",
    text: "이미지 생성과 영상 생성을 모두 지원해줘.",
    why: "`지원하다`, 그리고 접속 조사로 이어진 목록이 통째로 대상이다.",
    requirements: [{ action: "create", target: "이미지 생성과 영상 생성" }],
  },
  {
    id: "m-user-chooses",
    topic: "prompt_to_media",
    text: "사용자가 이미지와 영상 중에 고를 수 있게 해줘.",
    why: "`-ㄹ 수 있게 해줘` 에 `중에` 가 끼어 있다. 대상은 고르는 것들이다.",
    requirements: [{ action: "create", target: "이미지와 영상" }],
  },

  // --- 프로젝트를 실제로 돌리는 데 필요한 것 ---------------------------------
  {
    id: "m-download-and-run",
    topic: "operating",
    text: "모델을 다운로드하고 GPU에서 돌려줘.",
    why: "이미 읽히던 형태. 두 번째 절은 대상을 말하지 않으므로 null 이 정답이다.",
    requirements: [
      { action: "execute", target: "모델" },
      { action: "execute", target: null },
    ],
  },
  {
    id: "m-measure-and-judge",
    topic: "operating",
    text: "생성 속도를 측정하고 품질을 평가해줘.",
    why:
      "이미 읽히던 형태. 한 문장 안의 두 요청이 둘 다 나오는지를 본다. " +
      "이 자리에 \"`속도` 의 `도` 를 조사로 잘못 떼지 않는지도 함께 본다\" 고 적혀 " +
      "있었는데, 사실이 아니었다 — 문장이 `속도를` 이라고 쓰므로 `-도` 절단 분기가 " +
      "애초에 발화하지 않는다. `MEASURE_NOUN` 에서 `속도` 를 지워도 저장소 전체가 " +
      "초록이었다. 그 항목을 실제로 재는 것은 `functionalExtract.test.ts` 의 " +
      "「`-도` 를 지우는 두 관문」 이다.",
    requirements: [
      { action: "verify", target: "생성 속도" },
      { action: "verify", target: "품질" },
    ],
  },
  {
    id: "m-compare-models",
    topic: "operating",
    text: "Stable Diffusion과 AnimateDiff를 비교해줘.",
    why: "라틴 문자 모델 이름이 접속 조사로 이어진다.",
    requirements: [{ action: "inspect", target: "Stable Diffusion과 AnimateDiff" }],
  },
  {
    id: "m-web-ui",
    topic: "operating",
    text: "웹 UI를 붙여서 브라우저에서 쓸 수 있게 해줘.",
    why: "`붙이다` + 목적을 나타내는 `-게`. 요청은 UI 를 붙이는 것 하나다.",
    requirements: [{ action: "create", target: "웹 UI" }],
  },
  {
    id: "m-preview-result",
    topic: "operating",
    text: "결과를 미리보기로 보여줘.",
    why: "`미리보기로` 는 방법이다. 목적어에 흡수되면 대상을 지어낸 것이 된다.",
    requirements: [{ action: "inspect", target: "결과" }],
  },
  {
    id: "m-retry-on-failure",
    topic: "operating",
    text: "실패하면 다시 시도하게 해줘.",
    why: "조건절 + `-게 해줘`. 대상은 문장에 없으므로 null 이다.",
    requirements: [{ action: "execute", target: null }],
  },

  // --- 두 번째 통과: 이 말뭉치가 담지 않았던 모양 -----------------------------
  //
  // 위 24문장에서 이 경로는 행위 25/26, 대상 25/26 이었다. 그 점수가 말한 것은
  // 말뭉치의 범위였고, 같은 세 주제를 사람이 실제로 쓸 문장 열 개로 다시 묻자
  // 넷이 없는 대상을 내놓았다. 아래 정답은 코드를 건드리기 전에 문장에서 썼다.
  {
    id: "m-bound-noun-with-particle",
    topic: "image_to_video",
    text: "이미지를 10장 뽑아서 그중 제일 나은 걸로 영상을 만들어줘.",
    why:
      "`걸로` 는 의존명사에 조사가 붙은 것이다. `걸` 은 이미 목록에 있었고 " +
      "통과한 것은 `로` 였다 — 대상이 `걸로 영상` 이 되었다.",
    requirements: [{ action: "create", target: "영상" }],
  },
  {
    id: "m-time-head-with-particle",
    topic: "operating",
    text: "생성 중에는 진행률을 보여줘.",
    why:
      "`중에는` 도 같은 모양이다. 시점명사는 부사와 달리 건너뛰어서는 안 된다 — " +
      "그 앞의 명사는 시점 구의 것이지 동사의 것이 아니다.",
    requirements: [{ action: "inspect", target: "진행률" }],
  },
  {
    id: "m-standalone-numeral",
    topic: "prompt_to_media",
    text: "결과물은 mp4랑 gif 둘 다 저장해줘.",
    why: "`둘` 은 목록을 세는 말이지 저장할 물건이 아니다.",
    requirements: [{ action: "create", target: "결과물은 mp4랑 gif" }],
  },
  {
    id: "m-prohibition-then-request",
    topic: "image_to_video",
    text: "워터마크는 넣지 말고 영상을 만들어줘.",
    why: "금지가 앞에 오고 요청이 뒤에 온다. 금지된 동사가 요구사항이 되어서는 안 된다.",
    requirements: [{ action: "create", target: "영상" }],
  },
  {
    id: "m-comitative-style",
    topic: "image_prompt_to_video",
    text: "이 이미지랑 비슷한 스타일로 만들어줘.",
    why: "`-랑 비슷한` 은 명사구 안에 있다. 구 전체가 만들 대상이다.",
    requirements: [{ action: "create", target: "이미지랑 비슷한 스타일" }],
  },
  {
    id: "m-add-audio",
    topic: "image_prompt_to_video",
    text: "음악도 같이 넣어줘.",
    why: "`도` 는 목적어에 남지 않고 `같이` 는 대상이 아니다.",
    requirements: [{ action: "create", target: "음악" }],
  },
  {
    id: "m-vary-prompts",
    topic: "prompt_to_media",
    text: "프롬프트를 바꿔가면서 여러 개 만들어줘.",
    why:
      "`-면서` 는 절 경계이고, 뒤 절이 만드는 것은 프롬프트가 아니라 여러 개다. " +
      "앞 절의 목적어가 넘어오면 지어낸 것이 된다.",
    requirements: [{ action: "create", target: "여러 개" }],
  },
];
