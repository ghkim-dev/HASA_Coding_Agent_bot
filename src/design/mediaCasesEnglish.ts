import type { MediaRequirement } from "./mediaCases.ts";

/**
 * The same three project topics, asked in English.
 *
 * The English pass exists — it was added when the holdout set turned up a
 * request it read as nothing — and it has never had a denominator. Six
 * hand-written cases, one holdout turn, and no measurement of what it does with
 * an ordinary request. Asking the three topics in English, before writing a
 * line of code, read nothing at all from half of them.
 *
 * Same discipline as `mediaCases.ts`: a development set for a path nobody had
 * scored, written from the sentence and not from the output, and honest about
 * being written by the same pass that then fixed the code.
 *
 * ## How a target was decided
 *
 * Deliberately parallel to the Korean rules, because the two passes should not
 * disagree about the same request in two languages:
 *
 *   · The **head noun phrase**, with its article dropped — "project", "login
 *     error", "result video". The Korean side strips the case particle for the
 *     same reason: the target is what a run gets bound to, and `the` is not part
 *     of what it names.
 *   · A **relative clause** is not part of it. "a project that turns an uploaded
 *     image into a video" targets `project`, exactly as "이미지를 동영상으로
 *     만들어주는 프로젝트" targets 프로젝트.
 *   · A **participle built on a verb this file knows** is not part of it either:
 *     "the generated video" targets `video`, as "생성된 영상" targets 영상.
 *     An ordinary adjective stays — "the broken pipeline" targets `broken
 *     pipeline`, as "낡은 설정" keeps 낡은.
 *   · A **prepositional adjunct** is not the target. "generate an image from
 *     text" targets `image`; "run it on the GPU" targets nothing, because `it`
 *     names nothing this can resolve.
 *   · `null` means the sentence names no target, which is an answer.
 *
 * ## Where the act was arguable
 *
 *   · `convert` and `transform` are `modify`, on the same argument the Korean
 *     `변환` settled: the object is the *source*, not the result.
 *   · `render` is `execute` — a machine does work and the sentence's object is
 *     what the run produces.
 *   · `export` and `save` are `create`: a file that did not exist now does.
 *   · `build` is the English `쓰다` — genuinely two verbs. "build a tool" makes
 *     something; "build the project" runs a compiler. The answers below use the
 *     article, which is what a reader uses.
 */

export interface EnglishMediaCase {
  id: string;
  topic: "image_to_video" | "image_prompt_to_video" | "prompt_to_media" | "operating";
  text: string;
  why: string;
  requirements: readonly MediaRequirement[];
}

export const ENGLISH_MEDIA_CASES: readonly EnglishMediaCase[] = [
  // --- Project 1: image → video ---------------------------------------------
  {
    id: "e-project-image-to-video",
    topic: "image_to_video",
    text: "Build a project that turns an uploaded image into a video.",
    why: "주제 문장. 관형절이 목적어를 길게 뒤에서 수식하고, `build` 는 두 가지 뜻을 가진다.",
    requirements: [{ action: "create", target: "project" }],
  },
  {
    id: "e-convert-to-clip",
    topic: "image_to_video",
    text: "Convert an image into a 5 second clip.",
    why: "`convert` 가 없었다. `into` 뒤는 결과이지 대상이 아니다.",
    requirements: [{ action: "modify", target: "image" }],
  },
  {
    id: "e-render-video",
    topic: "image_to_video",
    text: "Render a video from the image.",
    why: "`render` 가 없었다. `from` 뒤는 출처다.",
    requirements: [{ action: "execute", target: "video" }],
  },
  {
    id: "e-export-mp4",
    topic: "image_to_video",
    text: "Export the result video as mp4.",
    why: "`export` 가 없었고, `as` 뒤는 형식이지 대상이 아니다.",
    requirements: [{ action: "create", target: "result video" }],
  },
  {
    id: "e-save-output",
    topic: "image_to_video",
    text: "Save the generated video.",
    why: "`save` 가 없었다. `generated` 는 이 파일이 아는 동사의 분사이므로 대상에서 빠진다.",
    requirements: [{ action: "create", target: "video" }],
  },
  {
    id: "e-broken-pipeline",
    topic: "image_to_video",
    text: "Fix the broken pipeline.",
    why: "분사 규칙의 반대쪽. `broken` 은 동사 목록에 없으므로 대상에 남는다.",
    requirements: [{ action: "modify", target: "broken pipeline" }],
  },

  // --- Project 2: image + prompt → video -------------------------------------
  {
    id: "e-image-and-prompt",
    topic: "image_prompt_to_video",
    text: "Take an image and a prompt and generate a video.",
    why: "이미 읽히던 형태. 회귀를 잡는 기준선.",
    requirements: [{ action: "create", target: "video" }],
  },
  {
    id: "e-dual-input-api",
    topic: "image_prompt_to_video",
    text: "Implement an API that accepts both an image and text.",
    why: "관형절이 목적어 뒤에 붙는다. 대상은 API 이고, 절 중간에서 잘려서는 안 된다.",
    requirements: [{ action: "create", target: "API" }],
  },
  {
    id: "e-compare-models",
    topic: "image_prompt_to_video",
    text: "Compare the two models.",
    why: "`compare` 가 없었다.",
    requirements: [{ action: "inspect", target: "two models" }],
  },
  {
    id: "e-configurable-params",
    topic: "image_prompt_to_video",
    text: "Set the frame count and the resolution.",
    why: "`set` 이 없었고, 접속사로 이어진 목록이 통째로 대상이다.",
    requirements: [{ action: "modify", target: "frame count and the resolution" }],
  },

  // --- Project 3: prompt → image or video ------------------------------------
  {
    id: "e-prompt-only-tool",
    topic: "prompt_to_media",
    text: "Build a tool that generates an image or a video from a prompt alone.",
    why: "주제 문장. `build a` 는 만드는 것이다.",
    requirements: [{ action: "create", target: "tool" }],
  },
  {
    id: "e-text-to-image",
    topic: "prompt_to_media",
    text: "Generate an image from text.",
    why: "이미 읽히던 형태이지만 대상이 `image from text` 였다. `from` 뒤는 출처다.",
    requirements: [{ action: "create", target: "image" }],
  },
  {
    id: "e-support-both",
    topic: "prompt_to_media",
    text: "Support both image generation and video generation.",
    // The answer was `both image generation` and that was wrong: `both` is a
    // correlative marker, not part of the noun, and the target is the pair it
    // introduces. Corrected before the code was touched, not after.
    why: "`support` 가 없었다. `both` 는 상관 표지이고 대상은 등위된 쌍 전체다.",
    requirements: [{ action: "create", target: "image generation and video generation" }],
  },

  // --- Operating it ----------------------------------------------------------
  {
    id: "e-download-and-run",
    topic: "operating",
    text: "Download the model and run it on the GPU.",
    why:
      "`download` 가 없어서 첫 절이 통째로 사라졌고, 둘째 절의 대상은 `on the GPU` 라는 " +
      "장소가 되었다. `it` 은 이 파일이 풀 수 없는 대명사이므로 대상은 없는 것이 정답이다.",
    requirements: [
      { action: "execute", target: "model" },
      { action: "execute", target: null },
    ],
  },
  {
    id: "e-measure-and-judge",
    topic: "operating",
    text: "Measure the generation speed and evaluate the quality.",
    why: "`measure` 와 `evaluate` 가 둘 다 없었다.",
    requirements: [
      { action: "verify", target: "generation speed" },
      { action: "verify", target: "quality" },
    ],
  },
  {
    id: "e-preview-result",
    topic: "operating",
    text: "Show me the result as a preview.",
    why: "`me` 는 간접 목적어이고 `as a preview` 는 방법이다. 둘 다 대상이 아니다.",
    requirements: [{ action: "inspect", target: "result" }],
  },
  {
    id: "e-check-for-errors",
    topic: "operating",
    text: "Check for errors in the log.",
    why: "`for` 는 보어를 이끈다. `in the log` 는 장소다.",
    requirements: [{ action: "inspect", target: "errors" }],
  },
  {
    id: "e-fix-and-test",
    topic: "operating",
    text: "Fix the login error and test it.",
    why: "이미 읽히던 형태. `it` 은 여전히 풀 수 없다.",
    requirements: [
      { action: "modify", target: "login error" },
      { action: "verify", target: null },
    ],
  },
  {
    id: "e-no-run-just-show",
    topic: "operating",
    text: "Do not run anything, just show me the design.",
    why: "금지가 앞에 오고 요청이 뒤에 온다. 금지된 동사가 요구사항이 되어서는 안 된다.",
    requirements: [{ action: "inspect", target: "design" }],
  },
  {
    id: "e-train-the-model",
    topic: "operating",
    text: "Train the model on the dataset.",
    why: "`train` 은 이 도메인의 중심 동사인데 없었다. `on the dataset` 은 장소다.",
    requirements: [{ action: "execute", target: "model" }],
  },

  // --- 한국어 쪽에서 드러난 결함 부류를 영어에도 겨눈 것 ------------------------
  //
  // 위 20문장에서 이 경로는 행위 23/23, 대상 23/23 이었다. 그 점수가 말한 것은
  // "영어 경로가 옳다" 가 아니라 "이 말뭉치에 이런 모양이 없다" 였다. 아래는
  // 한국어에서 방금 고친 결함 부류를 그대로 영어로 물은 것이고, 정답은 코드를
  // 건드리기 전에 문장에서 썼다. 다섯 중 셋이 **없는 대상을 지어내고** 있었다.
  {
    id: "e-coordinated-verbs",
    topic: "operating",
    text: "Train and evaluate the model.",
    why:
      "접속사 하나만 남았을 때 그것이 목적어가 되어 **train and** 를 내놓았다. " +
      "앞 동사의 목적어는 뒤에서 생략된 것이고, 없는 것은 없는 것이다.",
    requirements: [
      { action: "execute", target: null },
      { action: "verify", target: "model" },
    ],
  },
  {
    id: "e-verb-then-question",
    topic: "operating",
    text: "Check the model list and tell me which ones are usable.",
    why:
      "`tell` 이 동사 목록에 없어 접속사에서 절이 갈리지 않았고, 목적어가 " +
      "`model list and tell me` 가 되었다. 뒤 절이 묻는 것은 사물이 아니다.",
    requirements: [
      { action: "inspect", target: "model list" },
      { action: "inspect", target: null },
    ],
  },
  {
    id: "e-question-only",
    topic: "operating",
    text: "Tell me whether the video is actually rendered.",
    why: "물음이 목적어 자리에 서 있다. 종속절을 대상으로 삼는 것은 지어내기다.",
    requirements: [{ action: "inspect", target: null }],
  },
  {
    id: "e-feature-frame",
    topic: "prompt_to_media",
    text: "Make it possible to set the frame rate and the resolution.",
    why: "한국어 `-ㄹ 수 있게 해줘` 의 영어 짝. 아무것도 읽지 못했다.",
    requirements: [{ action: "modify", target: "frame rate and the resolution" }],
  },
  {
    id: "e-verb-without-object",
    topic: "operating",
    text: "Compare it with the previous result.",
    why:
      "`it` 은 풀 수 없으므로 대상은 없다. 그런데 부류 문구가 `compare` 를 " +
      "`look at what was asked about` 으로 바꿔 불렀다 — 비교와 살펴봄은 다른 결과물이다.",
    requirements: [{ action: "inspect", target: null }],
  },
];
