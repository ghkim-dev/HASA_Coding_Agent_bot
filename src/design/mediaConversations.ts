/**
 * The same three project topics, asked across several turns.
 *
 * `mediaCases.ts` is one sentence at a time, which is not how anybody uses this.
 * A person opens with a rough idea, adds a constraint, changes their mind, and
 * forbids something halfway through — and what the design must get right is not
 * any single turn but **what is still standing at the end of the conversation**.
 *
 * That is a different failure surface from extraction, and it is the one this
 * runtime was built around: a requirement dropped between turns is invisible,
 * because every turn on its own looks correctly read.
 *
 * ## What each case records
 *
 * `standing` is the complete answer — the requirement texts that must be live
 * after the last turn, and nothing else. `superseded` is what a correction must
 * have retired. Both are the *rendered* texts rather than acts and targets,
 * because inheritance is about which requirements survive, and identity here is
 * the sentence the panel shows.
 *
 * A pinned rendered text is coupled to how the extractor words things, and that
 * has moved twice already this pass. The rule for changing one is the rule the
 * holdout set uses: the answer changes only when the *reading* changed, never to
 * agree with output that disagreed with the Korean, and every edit says which.
 *
 * ## The baselines are excluded
 *
 * The runtime adds its own standing rules — that a completion claim needs
 * evidence, that a stated prohibition is honoured whatever the contract says.
 * They are not what the user asked for and they are the same in every case, so
 * the scorer drops `system_added` before comparing. Counting them would make
 * every case pass for a reason that has nothing to do with the conversation.
 */

export interface MediaConversation {
  id: string;
  topic: "image_to_video" | "image_prompt_to_video" | "prompt_to_media";
  /** Why this conversation is in the set — the shape it tests. */
  why: string;
  turns: readonly string[];
  /** Every requirement of the user's that must be live after the last turn. */
  standing: readonly string[];
  /** Requirements a later turn must have retired. Absent when none should be. */
  superseded?: readonly string[];
  /** Prohibition kinds the runtime must be holding at the end. */
  prohibitions?: readonly string[];
}

export const MEDIA_CONVERSATIONS: readonly MediaConversation[] = [
  {
    id: "mc-accumulate",
    topic: "image_to_video",
    why: "요구가 세 턴에 걸쳐 쌓인다. 마지막 턴에서 앞의 둘이 살아 있어야 한다.",
    turns: [
      "이미지를 동영상으로 만들어주는 프로젝트를 만들어줘.",
      "프레임 수와 해상도를 설정할 수 있게 해줘.",
      "결과 영상을 mp4로 내보내줘.",
    ],
    // The first is the phrase, not the bare head: with four tokens and a
    // relative clause it clears the bar the target/sentence split sets, so the
    // panel shows what the user described rather than only what it resolved to.
    standing: [
      "이미지를 동영상으로 만들어주는 프로젝트를 추가한다",
      "프레임 수와 해상도를 설정한다",
      "결과 영상을 mp4로 내보낸다",
    ],
  },
  {
    id: "mc-correction",
    topic: "image_prompt_to_video",
    why:
      "정정은 모순되는 것만 지운다. 생성 요청은 물러나고 비교 요청이 대신 서야 하며, " +
      "정정문 자체가 생성 요구사항을 다시 만들어서는 안 된다.",
    turns: [
      "이미지와 프롬프트로 동영상을 생성해줘.",
      "아니, 생성하라는 게 아니라 어떤 모델을 쓸지 먼저 비교해줘.",
    ],
    standing: ["모델을 비교한다"],
    superseded: ["동영상을 생성한다"],
  },
  {
    id: "mc-prohibition-midway",
    topic: "prompt_to_media",
    why:
      "대화 도중에 나온 금지가 앞 턴의 요구사항을 지우지는 않는다. 도구를 만드는 " +
      "요청은 그대로 서 있고, 이번 턴에서 실행만 막힌다.",
    turns: [
      "프롬프트로 이미지를 생성하는 도구를 만들어줘.",
      "일단 실행은 하지 말고 설계만 보여줘.",
    ],
    // The prohibition is one of the user's own requirements and is listed as
    // one — it is not a baseline the harness added, and leaving it out of the
    // answer would let a run that silently dropped it still pass.
    standing: ["도구를 추가한다", "이번 요청에서 명령을 실행하지 않는다", "설계를 살펴본다"],
    prohibitions: ["no_execute"],
  },
  {
    id: "mc-preserve-while-adding",
    topic: "image_to_video",
    why: "유지와 추가는 모순이 아니다. 둘 다 서 있어야 하고, 어느 쪽도 다른 쪽을 지우지 않는다.",
    turns: [
      "이미지를 영상으로 변환해줘.",
      "기존 업로드 기능은 그대로 유지하면서 변환 옵션을 추가해줘.",
    ],
    // `업로드 기능`, not `기존 업로드 기능`. The two-token window is the rule
    // the gold set pinned with "기존 API 호환성은 반드시 유지해줘" → `API 호환성`,
    // and this set does not get to contradict it.
    standing: [
      "이미지를 영상으로 변환한다",
      "업로드 기능을 그대로 유지한다",
      "변환 옵션을 추가한다",
    ],
  },
  {
    id: "mc-genuine-new-task",
    topic: "image_to_video",
    why:
      "주제를 바꾼다고 말하면 앞의 것은 남지 않는다. 이어붙이는 쪽이 기본이 된 뒤에도 " +
      "이 경우는 여전히 지워져야 하고, 그것을 가르는 것은 사용자가 한 말뿐이다.",
    turns: [
      "이미지를 영상으로 변환해줘.",
      "이제 완전히 다른 걸 하자. README를 한국어로 번역해줘.",
    ],
    standing: ["README를 한국어로 번역한다"],
  },
  {
    id: "mc-correction-bare-ani",
    topic: "image_to_video",
    why:
      "`아니,` 하나로 시작하는 정정. 한국어에서 가장 흔한 형태인데 정정으로 읽히지 " +
      "않아서, 물러났어야 할 요구사항이 새 요청 옆에 그대로 서 있었다.",
    turns: [
      "main.py를 실행해줘.",
      "아니, 실행은 하지 말고 코드만 보여줘.",
    ],
    standing: ["이번 요청에서 명령을 실행하지 않는다", "코드를 살펴본다"],
    superseded: ["main.py를 실행한다"],
    prohibitions: ["no_execute"],
  },
  {
    id: "mc-correction-not-that",
    topic: "image_prompt_to_video",
    why:
      "`아니,` 없이 `-라는 게 아니라` 만으로 정정하는 형태. 추출기는 이 문장에서 " +
      "생성 요구사항을 만들지 않지만, 앞 턴에 서 있던 것은 별개로 물러나야 한다.",
    turns: [
      "동영상을 생성해줘.",
      "생성하라는 게 아니라 먼저 비교해줘.",
    ],
    standing: ["요청한 내용을 살펴본다"],
    superseded: ["동영상을 생성한다"],
  },
  {
    id: "mc-refine-target",
    topic: "prompt_to_media",
    why:
      "두 번째 턴은 첫 턴을 더 좁힌다. 새 요구사항이 아니라 같은 일에 대한 추가 조건이므로 " +
      "둘 다 남는 것이 옳다.",
    turns: [
      "텍스트에서 이미지를 생성해줘.",
      "생성한 이미지를 저장해줘.",
    ],
    standing: ["이미지를 생성한다", "이미지를 저장한다"],
  },
];
