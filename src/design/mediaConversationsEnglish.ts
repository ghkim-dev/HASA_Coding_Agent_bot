import type { MediaConversation } from "./mediaConversations.ts";

/**
 * The same five conversation shapes, in English.
 *
 * `mediaConversations.ts` found the largest defect of the Korean pass — a
 * follow-up sentence with no connective discarding everything said before it —
 * and the English path had never been asked the question at all. It turned out
 * to have four of its own, three of which were invisible from any single turn.
 *
 * The shapes are deliberately the same as the Korean set. Two languages
 * disagreeing about the same conversation is a defect on its own, and lining
 * the corpora up is what makes that checkable.
 *
 * ## A note on the language of what is shown
 *
 * The prohibition requirement reads "이번 요청에서 명령을 실행하지 않는다" even
 * here, and that is on purpose rather than an oversight. The user's own
 * requirements are rendered in the language they wrote — "show the design", not
 * a translation of it — because that list is what they said. The prohibition
 * and the baselines are the *runtime* stating its own rules, and the panel that
 * shows them is Korean throughout. Localising those means localising the panel,
 * which is a different piece of work; mixing is the honest interim state and is
 * pinned here so it stays a decision.
 */
export const ENGLISH_MEDIA_CONVERSATIONS: readonly MediaConversation[] = [
  {
    id: "emc-accumulate",
    topic: "image_to_video",
    why: "세 턴에 걸쳐 쌓인다. 영어에서도 표지 없는 후속 턴이 앞의 것을 버리면 안 된다.",
    turns: [
      "Build a project that turns an image into a video.",
      "Let me set the frame count and the resolution.",
      "Export the result video as mp4.",
    ],
    standing: ["build a project", "set the frame count and the resolution", "export the result video"],
  },
  {
    id: "emc-correction",
    topic: "image_prompt_to_video",
    why:
      "`No,` 로 여는 정정. 한국어의 `아니,` 와 같은 자리인데 영어에는 없었고, " +
      "철회된 행위도 물러나지 않았다.",
    turns: [
      "Generate a video from the image and the prompt.",
      "No, do not generate it yet — compare the models first.",
    ],
    standing: ["compare the models first"],
    superseded: ["generate a video"],
  },
  {
    id: "emc-prohibition-midway",
    topic: "prompt_to_media",
    why:
      "대화 도중의 금지. 앞 턴의 요청은 남고 이번 턴에서 실행만 막힌다. " +
      "`show` 가 들어 있어서 이 턴 전체가 질문으로 분류되던 것도 여기서 잡힌다.",
    turns: [
      "Build a tool that generates images from a prompt.",
      "Do not run anything for now, just show me the design.",
    ],
    standing: ["build a tool", "이번 요청에서 명령을 실행하지 않는다", "show the design"],
    prohibitions: ["no_execute"],
  },
  {
    id: "emc-genuine-new-task",
    topic: "image_to_video",
    why: "주제를 바꾼다고 말하면 앞의 것은 남지 않는다. 영어 표지가 없어서 이어붙고 있었다.",
    turns: [
      "Convert the image into a video.",
      "Now let's do something completely different. Translate the README into Korean.",
    ],
    standing: ["translate the README"],
  },
  {
    id: "emc-refine",
    topic: "prompt_to_media",
    why: "두 번째 턴이 첫 턴을 좁힌다. 둘 다 남아야 한다.",
    turns: ["Generate an image from text.", "Save the generated image."],
    standing: ["generate an image", "save the image"],
  },
];
