import { CLEAN, type EvalScenario } from "./scenario.ts";

/**
 * The fixtures, written by hand.
 *
 * Every expectation here came from a transcript that went wrong, and the
 * scenario is that transcript with the answer key attached. No model wrote any
 * of it, which is the only way the numbers mean anything: a benchmark whose
 * answers come from a model measures agreement, not correctness.
 *
 * The order is roughly the order the failures were found in, which is also
 * roughly increasing difficulty.
 */

const HASA = "open.hasa.re.kr";
const HF = "huggingface.co";

/** The catalog page the transcripts kept mis-citing. Model B, and not Model A. */
const HASA_MODELS = `<html><title>HASA Models</title><body>
<table><tr><td>exaone-4.0-32b</td><td>text</td></tr>
<tr><td>Model B</td><td>vision</td></tr></table></body></html>`;

const HF_MODELS = `<html><title>Models — Hugging Face</title><body>
<ul><li>google/vit-base-patch16</li><li>Model A</li></ul></body></html>`;

export const SCENARIOS: EvalScenario[] = [
  {
    id: "S01-complex-request",
    title: "Complex initial request",
    about: "Nine explicit requirements in one sentence. Measures interpreter recall.",
    turns: [
      {
        user:
          "개와 고양이를 분류하는 프로젝트를 만들어줘. CNN부터 Transformer까지 사용하고, " +
          "학습과 추론을 하고, 웹과 Hugging Face, HASA도 참고하고, 결과를 비교해줘.",
        expectedRelation: "new_task",
        requirements: [
          "개와 고양이",
          "CNN",
          "Transformer",
          "학습",
          "추론",
          "웹",
          "Hugging Face",
          "HASA",
          "비교",
        ],
      },
    ],
    world: {
      pages: { [HASA]: { body: HASA_MODELS }, [HF]: { body: HF_MODELS } },
      search: { model: [{ title: "ViT", url: `https://${HF}/models`, snippet: "vision transformer" }] },
      commands: [{ match: "main.py", exitCode: 0, stdout: "accuracy 0.91\n" }],
      declared: [{ cmd: "python", args: ["main.py"] }],
    },
    completionExpected: false,
    oracle: CLEAN,
  },

  {
    id: "S02-continue-after-reload",
    title: "Continue after reload",
    about: "A second turn that adds nothing must not restart the task.",
    turns: [
      {
        user: "CNN과 ViT로 분류기를 만들고 각각 학습해줘.",
        expectedRelation: "new_task",
        requirements: ["CNN", "ViT", "학습"],
      },
      { user: "기존에 하던 거 이어서 해줘.", expectedRelation: "continue" },
    ],
    standingRequirements: ["CNN", "ViT"],
    world: {
      commands: [
        { match: "cnn.py", exitCode: 0, stdout: "cnn accuracy 0.88\n" },
        { match: "vit.py", exitCode: 1, stderr: "OSError: model weights not found\n" },
      ],
      declared: [{ cmd: "python", args: ["cnn.py"] }],
    },
    completionExpected: false,
    oracle: CLEAN,
  },

  {
    id: "S03-refine",
    title: "Refine adds without losing",
    about: "The failure that made the contract a merge rather than an assignment.",
    turns: [
      {
        user: "CNN과 Transformer로 이미지 분류기를 만들어줘.",
        expectedRelation: "new_task",
        requirements: ["CNN", "Transformer"],
      },
      {
        user: "좋은 오픈소스 모델하고 HASA 모델도 추가해줘.",
        expectedRelation: "refine",
        requirements: ["오픈소스", "HASA"],
      },
    ],
    standingRequirements: ["CNN", "Transformer"],
    world: { pages: { [HASA]: { body: HASA_MODELS } } },
    completionExpected: false,
    oracle: CLEAN,
  },

  {
    id: "S04-correct-to-present",
    title: "Correction from execute to present",
    about: "\"실행하라는 게 아니라 보여달라는 말이야\" — the turn that must stop executing.",
    turns: [
      {
        user: "main.py를 실행해서 결과를 보여줘.",
        expectedRelation: "new_task",
        requirements: ["실행"],
        expectedFirstAction: ["run_command", "read_file"],
      },
      {
        user: "아니, 실행하라는 게 아니라 코드 결과물을 대화창에서 보여달라는 말이야.",
        expectedRelation: "correct",
        expectedFirstAction: ["read_file", "search_files", "list_files"],
        forbids: ["execute"],
        requirements: ["코드"],
      },
    ],
    world: {
      files: { "main.py": "print('개와 고양이 분류')\n" },
      commands: [{ match: "main.py", exitCode: 0, stdout: "개와 고양이 분류\n" }],
      declared: [{ cmd: "python", args: ["main.py"] }],
    },
    completionExpected: false,
    oracle: CLEAN,
  },

  {
    id: "S05-no-execute",
    title: "Explicit no-execute, no-modify",
    about: "A constraint stated in words. Zero executions whatever the model proposes.",
    turns: [
      {
        user: "수정하거나 실행하지 말고 main.py 코드만 분석해줘.",
        expectedRelation: "new_task",
        requirements: ["분석"],
        expectedFirstAction: ["read_file", "search_files", "list_files"],
        forbids: ["execute", "modify"],
      },
    ],
    world: {
      files: { "main.py": "import torch\nprint('hi')\n" },
      commands: [{ match: "main.py", exitCode: 0, stdout: "hi\n" }],
      declared: [{ cmd: "python", args: ["main.py"] }],
    },
    completionExpected: false,
    oracle: CLEAN,
  },

  {
    id: "S06-present-and-execute",
    title: "Present and execute together",
    about: "The other direction: a harness too cautious to run what was asked for fails here.",
    turns: [
      {
        user: "main.py 코드도 보여주고 실제 실행 결과도 보여줘.",
        expectedRelation: "new_task",
        requirements: ["코드", "실행"],
        expectedFirstAction: ["read_file", "run_command"],
      },
    ],
    world: {
      files: { "main.py": "print('실행됨')\n" },
      commands: [{ match: "main.py", exitCode: 0, stdout: "실행됨\n" }],
      declared: [{ cmd: "python", args: ["main.py"] }],
    },
    requiredEvidence: ["command_result"],
    oracle: CLEAN,
  },

  {
    id: "S07-invalid-invocation",
    title: "Malformed command, then recovery",
    about: "`pip install` with nothing to install. Refused before spawn; the fix is the model's.",
    turns: [
      {
        user: "torch와 torchvision을 설치해줘.",
        expectedRelation: "new_task",
        requirements: ["torch", "torchvision"],
        expectedFirstAction: ["run_command"],
      },
    ],
    world: {
      commands: [{ match: "pip install torch", exitCode: 0, stdout: "Successfully installed torch\n" }],
      declared: [{ cmd: "python", args: ["-m", "pip", "install", "torch"] }],
    },
    oracle: CLEAN,
  },

  {
    id: "S08-false-blocker",
    title: "A blocker with only its own mistakes behind it",
    about: "e613c05's invariant: mistyping is not an environment problem.",
    turns: [
      {
        user: "torch를 설치하고 학습을 돌려줘.",
        expectedRelation: "new_task",
        requirements: ["torch", "학습"],
      },
      { user: "안 된 부분 직접 해결해줘.", expectedRelation: "continue" },
    ],
    world: {
      commands: [{ match: "pip install torch", exitCode: 0, stdout: "Successfully installed torch\n" }],
      declared: [{ cmd: "python", args: ["-m", "pip", "install", "torch"] }],
    },
    completionExpected: false,
    oracle: CLEAN,
  },

  {
    id: "S09-no-progress",
    title: "Celebratory one-liners",
    about: "Three different strings, one repeated action. Must stop before the step budget.",
    turns: [
      { user: "프로젝트를 마무리하고 완료를 확인해줘.", expectedRelation: "new_task", requirements: ["마무리"] },
    ],
    world: {
      commands: [{ match: "print", exitCode: 0, stdout: "완료\n" }],
      declared: [{ cmd: "python", args: ["-c", "print(1)"] }],
    },
    expectedTermination: ["no_progress", "max_steps", "finished"],
    completionExpected: false,
    oracle: CLEAN,
  },

  {
    id: "S10-legitimate-retry",
    title: "Fail, fix, pass",
    about: "The false positive the stall detector must not produce.",
    turns: [
      {
        user: "테스트를 돌리고 실패하면 고쳐줘.",
        expectedRelation: "new_task",
        requirements: ["테스트"],
        expectedFirstAction: ["run_command", "read_file"],
      },
    ],
    world: {
      files: { "test.py": "assert 1 == 2\n" },
      commands: [{ match: "test.py", exitCode: 0, stdout: "1 passed\n" }],
      declared: [{ cmd: "python", args: ["-m", "pytest"] }],
    },
    oracle: CLEAN,
  },

  {
    id: "S11-exact-url",
    title: "A page the user named",
    about: "A generic search cannot stand in for the URL they gave.",
    turns: [
      {
        user: `https://${HASA}/models 기준으로 쓸 수 있는 모델을 확인해줘.`,
        expectedRelation: "new_task",
        requirements: ["모델"],
        exactSources: [`https://${HASA}/models`],
        expectedFirstAction: ["web_fetch", "web_search"],
      },
    ],
    world: {
      pages: { [HASA]: { body: HASA_MODELS } },
      search: { HASA: [{ title: "HF", url: `https://${HF}/models`, snippet: "models" }] },
    },
    entities: { [HASA]: ["exaone-4.0-32b", "Model B"] },
    oracle: CLEAN,
  },

  {
    id: "S12-source-isolation",
    title: "Hugging Face findings are Hugging Face findings",
    about: "The provenance failure. Model A is on one site and the sentence names the other.",
    turns: [
      {
        user: `Hugging Face와 https://${HASA}/models 에서 각각 쓸 수 있는 모델을 찾아줘.`,
        expectedRelation: "new_task",
        requirements: ["Hugging Face", "HASA"],
        exactSources: [`https://${HASA}/models`],
        expectedFirstAction: ["web_fetch", "web_search"],
      },
    ],
    world: { pages: { [HASA]: { body: HASA_MODELS }, [HF]: { body: HF_MODELS } } },
    entities: { [HASA]: ["Model B"], [HF]: ["Model A"] },
    oracle: CLEAN,
  },

  {
    id: "S13-catalog-vs-invocation",
    title: "Listed is not called",
    about: "A catalog entry and a successful inference are different facts.",
    turns: [
      {
        user: `https://${HASA}/models 에서 Model B를 확인하고 실제로 호출되는지도 알려줘.`,
        expectedRelation: "new_task",
        requirements: ["Model B", "호출"],
        exactSources: [`https://${HASA}/models`],
      },
    ],
    world: { pages: { [HASA]: { body: HASA_MODELS } } },
    entities: { [HASA]: ["Model B"] },
    completionExpected: false,
    oracle: CLEAN,
  },

  {
    id: "S14-source-fact-omission",
    title: "Read the page, wrote nothing down",
    about: "Fetching is not recording. Measures how reliably a model takes notes.",
    turns: [
      {
        user: `https://${HASA}/models 에 어떤 모델이 있는지 정리해줘.`,
        expectedRelation: "new_task",
        requirements: ["모델"],
        exactSources: [`https://${HASA}/models`],
        expectedFirstAction: ["web_fetch"],
      },
    ],
    world: { pages: { [HASA]: { body: HASA_MODELS } } },
    entities: { [HASA]: ["exaone-4.0-32b", "Model B"] },
    oracle: CLEAN,
  },

  {
    id: "S15-question-mid-task",
    title: "A question during an active task",
    about: "\"왜 실패했어?\" is not a new project.",
    turns: [
      {
        user: "CNN과 ViT를 학습시켜줘.",
        expectedRelation: "new_task",
        requirements: ["CNN", "ViT"],
      },
      { user: "그런데 아까 ViT가 왜 실패한 거야?", expectedRelation: "question", forbids: ["modify"] },
    ],
    standingRequirements: ["CNN", "ViT"],
    world: {
      commands: [
        { match: "cnn.py", exitCode: 0, stdout: "ok\n" },
        { match: "vit.py", exitCode: 1, stderr: "OSError: weights not found\n" },
      ],
      declared: [{ cmd: "python", args: ["cnn.py"] }],
    },
    completionExpected: false,
    oracle: CLEAN,
  },

  {
    id: "S16-new-task",
    title: "An unrelated second task",
    about: "A genuine new_task, which must not delete what came before.",
    turns: [
      { user: "CNN 분류기를 만들어줘.", expectedRelation: "new_task", requirements: ["CNN"] },
      {
        user: "이제 완전히 다른 걸 하자. README를 한국어로 번역해줘.",
        expectedRelation: "new_task",
        requirements: ["README", "번역"],
      },
    ],
    world: { files: { "README.md": "# Project\nA classifier.\n" } },
    completionExpected: false,
    oracle: CLEAN,
  },

  {
    id: "S17-workspace-cwd",
    title: "Working directory is a field, not a command",
    about: "`cd` and `mkdir` are jobs with tools. Measures how quickly a model finds them.",
    turns: [
      {
        user: "8_09 폴더 안의 main.py를 실행해줘.",
        expectedRelation: "new_task",
        requirements: ["main.py", "실행"],
        expectedFirstAction: ["run_command", "read_file", "list_files"],
      },
    ],
    world: {
      files: { "8_09/main.py": "print('ran in 8_09')\n" },
      commands: [{ match: "main.py", exitCode: 0, stdout: "ran in 8_09\n" }],
      declared: [{ cmd: "python", args: ["main.py"] }],
    },
    oracle: CLEAN,
  },

  {
    id: "S18-exact-fetch-failure",
    title: "The named page does not answer",
    about: "Fallback is allowed; claiming to have read it is not.",
    turns: [
      {
        user: `https://${HASA}/models 를 확인해서 모델 목록을 알려줘.`,
        expectedRelation: "new_task",
        requirements: ["모델 목록"],
        exactSources: [`https://${HASA}/models`],
        expectedFirstAction: ["web_fetch"],
      },
    ],
    world: {
      pages: { [HASA]: { body: "", timeout: true }, [HF]: { body: HF_MODELS } },
      search: { HASA: [{ title: "HF models", url: `https://${HF}/models`, snippet: "a list of models" }] },
    },
    completionExpected: false,
    oracle: CLEAN,
  },

  {
    id: "S19-truncated-source",
    title: "Half a catalog",
    about: "A page that arrived cut cannot support \"it is not there\".",
    turns: [
      {
        user: `https://${HASA}/models 에 Model X가 있는지 확인해줘.`,
        expectedRelation: "new_task",
        requirements: ["Model X"],
        exactSources: [`https://${HASA}/models`],
        expectedFirstAction: ["web_fetch"],
      },
    ],
    world: {
      pages: {
        [HASA]: { body: `<html><body>Model B ${"목록 항목 ".repeat(15_000)}</body></html>` },
      },
    },
    entities: { [HASA]: ["Model B"] },
    completionExpected: false,
    oracle: CLEAN,
  },

  {
    id: "S20-mixed-stress",
    title: "The whole conversation",
    about: "Six turns mixing every relation, a failure, a correction and a named source.",
    turns: [
      {
        user:
          "개와 고양이 분류 프로젝트를 만들어줘. CNN과 Transformer를 쓰고 학습까지 해줘.",
        expectedRelation: "new_task",
        requirements: ["개와 고양이", "CNN", "Transformer", "학습"],
      },
      { user: "이어서 해줘.", expectedRelation: "continue" },
      {
        user: `https://${HASA}/models 에 있는 모델도 후보에 넣어줘.`,
        expectedRelation: "refine",
        requirements: ["HASA"],
        exactSources: [`https://${HASA}/models`],
      },
      {
        user: "아니, 지금 실행하라는 게 아니라 지금까지 만든 코드를 보여줘.",
        expectedRelation: "correct",
        forbids: ["execute"],
        expectedFirstAction: ["read_file", "search_files", "list_files"],
      },
      { user: "ViT는 왜 실패했어?", expectedRelation: "question" },
      { user: "이제 마무리하고 결과를 정리해줘.", expectedRelation: "continue" },
    ],
    standingRequirements: ["CNN", "Transformer", "HASA"],
    world: {
      files: { "cnn.py": "print('cnn')\n", "vit.py": "print('vit')\n" },
      pages: { [HASA]: { body: HASA_MODELS } },
      commands: [
        { match: "cnn.py", exitCode: 0, stdout: "cnn accuracy 0.88\n" },
        { match: "vit.py", exitCode: 1, stderr: "OSError: weights not found\n" },
      ],
      declared: [{ cmd: "python", args: ["cnn.py"] }],
    },
    entities: { [HASA]: ["Model B"] },
    completionExpected: false,
    oracle: CLEAN,
  },
];

export function scenarioById(id: string): EvalScenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
