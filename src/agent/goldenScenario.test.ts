import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { AgentSession } from "./session.ts";
import { allowingApprovalPort } from "./approval.ts";
import { nullLogger } from "../hasa-client/logger.ts";
import { createRepoFixture, type RepoFixture } from "../testing/repo-fixture.ts";
import { TurnRecorder } from "./sessionRecorder.ts";
import { readSession, writeSession } from "./sessionLog.ts";
import { SESSION_SCHEMA_VERSION, type SessionEvent } from "./sessionEvents.ts";
import { activeRequirements, reduceContract } from "./turnContract.ts";
import { reduceTask } from "./taskReducer.ts";
import { assessCompletion } from "./taskState.ts";
import type { AgentCompletion, AgentEvent, AgentModel } from "./types.ts";
import type { NormalizedToolCall, ProviderMessage } from "../provider/types.ts";

/**
 * The transcript that started all of this, as a test.
 *
 * Five turns, from a real session. The agent was asked to build a dog/cat
 * classifier across CNN and Transformer models using Hugging Face and
 * open.hasa.re.kr; it lost most of the request, failed to load a model, ran a
 * command that printed a sentence it had written itself, reported that
 * everything worked, and — when the user finally said "코드 결과물을 직접
 * 대화창에서 출력해서 보여달라는 말이었음" — kept executing.
 *
 * What is asserted is not that the agent is clever. It is that the things it
 * lost are still there:
 *
 *     requirement loss   = 0
 *     contract loss      = 0   (across a serialise/reload)
 *     false completion   = 0
 *     turn 5 executions  = 0
 */

const fixtures: RepoFixture[] = [];
after(async () => {
  for (const f of fixtures) await f.dispose().catch(() => {});
});

function completion(overrides: Partial<AgentCompletion> = {}): AgentCompletion {
  return { text: "", reasoning: "", toolCalls: [], inputTokens: 1, outputTokens: 1, ...overrides };
}

function call(name: string, id: string, args: Record<string, unknown> = {}): NormalizedToolCall {
  return { id, name, arguments: args, rawArguments: JSON.stringify(args), argumentsValid: true };
}

const TURN_1_REQUIREMENTS = [
  "개와 고양이 분류",
  "CNN 계열 활용",
  "Transformer 계열 활용",
  "학습",
  "추론",
  "웹에서 필요한 내용 보충",
  "Hugging Face 활용",
  "open.hasa.re.kr 활용",
].join("\n");

/** Drives a session and keeps its events the way the host does. */
class Scenario {
  readonly events: SessionEvent[] = [];
  session: AgentSession;
  private ordinal = 0;
  private queue: AgentCompletion[] = [];
  readonly executed: string[] = [];
  readonly seen: ProviderMessage[][] = [];

  constructor(session: AgentSession) {
    this.session = session;
  }

  script(steps: AgentCompletion[]): void {
    this.queue = [...steps];
  }

  next(): AgentCompletion {
    return this.queue.shift() ?? completion({ text: "끝." });
  }

  async ask(prompt: string): Promise<void> {
    const recorder = new TurnRecorder({ turnId: `c-${this.ordinal++}` });
    this.events.push(...recorder.userMessage(prompt, []));
    this.session.setEventSink((event: AgentEvent) => {
      if (event.type === "tool_start") this.executed.push(event.name);
      this.events.push(...recorder.record(event));
    });
    await this.session.send(prompt, new AbortController().signal);
  }

  /** What the panel and the model would be rebuilt from after a restart. */
  roundTrip(): SessionEvent[] {
    const raw = writeSession({
      version: SESSION_SCHEMA_VERSION,
      id: "golden",
      title: "dog/cat",
      createdAt: 1,
      updatedAt: 2,
      events: this.events,
      messages: [...this.session.history()].filter((m) => m.role !== "system"),
    });
    return readSession(raw)!.session.events;
  }
}

async function openScenario(): Promise<Scenario> {
  const fixture = await createRepoFixture({
    "cnn_model.py": "import torch\n\nclass CNN(torch.nn.Module):\n    pass\n",
    "vit_model.py": "from transformers import ViTForImageClassification\n",
  });
  fixtures.push(fixture);

  let scenario: Scenario;
  const model: AgentModel = {
    modelId: "test",
    async complete(request) {
      scenario.seen.push(structuredClone([...request.messages]) as ProviderMessage[]);
      return scenario.next();
    },
  };
  const session = await AgentSession.open({
    workspaceRoot: fixture.root,
    model,
    approvalPort: allowingApprovalPort,
    approvalMode: "auto",
    mode: "code",
    logger: nullLogger,
  });
  scenario = new Scenario(session);
  return scenario;
}

describe("M — the dog/cat transcript, five turns", () => {
  test("nothing the user asked for is lost, and turn 5 runs nothing", async () => {
    const s = await openScenario();

    // ── TURN 1 ─────────────────────────────────────────────────────────────
    // The whole request. The real agent kept about half of it.
    s.script([
      completion({
        toolCalls: [
          call("record_request", "r1", {
            goal: "개/고양이 분류 프로젝트 구축",
            relation: "new_task",
            intents: "modify\nexecute\nresearch",
            requirements: TURN_1_REQUIREMENTS,
            deliverables: "실행 가능한 프로젝트\n비교 결과",
          }),
        ],
      }),
      completion({ toolCalls: [call("update_plan", "p1", { steps: "CNN 구현\nViT 구현", current: 1 })] }),
      completion({ toolCalls: [call("read_file", "f1", { path: "vit_model.py" })] }),
      completion({ text: "ViT 로드에서 막혔습니다." }),
      completion({ text: "ViT 로드에서 막혔습니다." }),
    ]);
    await s.ask(
      "개와 고양이를 분류하는 모델을 학습하고 추론하는 프로젝트를 진행하고 싶어. " +
        "CNN부터 Transformer 계열까지 활용하고, 웹에서 필요한 내용을 보충하고, " +
        "Hugging Face와 open.hasa.re.kr을 활용하고 싶다.",
    );

    const afterOne = reduceContract(s.events);
    assert.equal(activeRequirements(afterOne).length, 8, "requirement loss at turn 1");
    // The plan named two of the eight. That is the bug this layer was built for.
    const planned = s.events.filter((e) => e.type === "plan");
    assert.ok(planned.length > 0);
    assert.equal(activeRequirements(afterOne).length, 8, "the plan must not shrink the contract");

    // ── serialise / reload, between turn 1 and turn 2 ──────────────────────
    const reloaded = s.roundTrip();
    const afterReload = reduceContract(reloaded);
    assert.deepEqual(afterReload, afterOne, "contract loss across a reload");
    s.session.restoreContract(reloaded);

    // ── TURN 2 ─────────────────────────────────────────────────────────────
    s.script([
      completion({
        toolCalls: [call("record_request", "r2", { goal: "이어서", relation: "continue", intents: "continue" })],
      }),
      completion({ text: "ViT 문제부터 이어가겠습니다." }),
      completion({ text: "ViT 문제부터 이어가겠습니다." }),
    ]);
    await s.ask("기존에 진행하던 것을 이어서 해주세요.");

    const afterTwo = reduceContract(s.events);
    assert.equal(activeRequirements(afterTwo).length, 8, "a continuation must not add or drop requirements");
    assert.equal(afterTwo.goal, afterOne.goal, "nor rewrite the goal");

    // ── TURN 3 ─────────────────────────────────────────────────────────────
    s.script([
      completion({
        toolCalls: [
          call("record_request", "r3", {
            goal: "오픈소스/HASA 모델 추가",
            relation: "refine",
            intents: "research\nmodify",
            requirements: "오픈소스 모델 활용\nHASA 모델로 결과 정리",
          }),
        ],
      }),
      completion({ text: "추가하겠습니다." }),
      completion({ text: "추가하겠습니다." }),
    ]);
    await s.ask("좋은 오픈소스 모델이나 open.hasa.re.kr에서 활용할 수 있는 것도 사용해 결과 정리해줘.");

    const afterThree = reduceContract(s.events);
    assert.equal(activeRequirements(afterThree).length, 10, "a refinement adds without losing");
    assert.match(
      activeRequirements(afterThree).map((r) => r.description).join(" | "),
      /Hugging Face/,
      "the original requirements are still there three turns later",
    );

    // ── TURN 4 ─────────────────────────────────────────────────────────────
    s.script([
      completion({
        toolCalls: [
          call("record_request", "r4", {
            goal: "결과를 실행해서 보여주기",
            relation: "refine",
            intents: "execute\npresent",
            requirements: "실행 결과 제시",
            deliverables: "실행 결과",
          }),
        ],
      }),
      completion({ text: "실행해 보겠습니다." }),
      completion({ text: "실행해 보겠습니다." }),
    ]);
    await s.ask("너가 결과를 실행해서 보여줄 수 있어?");
    assert.ok(reduceContract(s.events).intents.includes("execute"));

    // ── TURN 5 — the correction ────────────────────────────────────────────
    const executedBefore = s.executed.filter((name) => name === "run_command").length;
    s.script([
      completion({
        toolCalls: [
          call("record_request", "r5", {
            goal: "소스 코드를 대화창에 그대로 출력",
            relation: "correct",
            intents: "present",
            requirements: "소스 코드를 대화창에 표시",
            deliverables: "소스 코드",
          }),
        ],
      }),
      completion({ toolCalls: [call("read_file", "f5", { path: "cnn_model.py" })] }),
      completion({ text: "cnn_model.py의 내용입니다:\n\n```python\nimport torch\n\nclass CNN(torch.nn.Module):\n    pass\n```" }),
      completion({ text: "cnn_model.py의 내용입니다." }),
    ]);
    await s.ask("코드 결과물을 직접 대화창에서 출력해서 보여달라는 말이었음.");

    const finalContract = reduceContract(s.events);

    // I — the regression this whole slice is named after.
    assert.deepEqual(finalContract.intents, ["present"], "the correction must replace the misread intent");
    assert.equal(finalContract.relation, "correct");
    assert.equal(
      s.executed.filter((name) => name === "run_command").length,
      executedBefore,
      "turn 5 must run nothing",
    );
    assert.ok(s.executed.includes("read_file"), "it must read the file it was asked to show");
    assert.ok(
      !s.executed.slice(-4).includes("create_file"),
      "and write nothing",
    );

    // The source really is in the answer.
    const answer = s.events.filter((e) => e.type === "assistant_text").at(-1);
    assert.match(String(answer?.type === "assistant_text" ? answer.text : ""), /class CNN/);

    // ── across the whole scenario ──────────────────────────────────────────
    // 8 from turn 1, 2 added by turn 3, 1 by turn 4, 1 by turn 5. A correction
    // retires the *deliverable* it contradicts and adds what it asks for: the
    // user did not retract wanting results, they said how they wanted them.
    assert.equal(activeRequirements(finalContract).length, 12, "requirement loss across five turns");
    assert.ok(
      activeRequirements(finalContract).some((r) => r.description.includes("Hugging Face")),
      "turn 1's requirements are still standing after the correction",
    );

    const retired = finalContract.deliverables.find((d) => d.description === "실행 결과");
    assert.equal(retired?.lifecycle, "superseded", "the deliverable the correction contradicts");
    assert.deepEqual(
      finalContract.deliverables.filter((d) => d.lifecycle === "active").map((d) => d.description),
      ["실행 가능한 프로젝트", "비교 결과", "소스 코드"],
    );

    // false completion = 0. Eight of the eleven requirements never had a tool
    // succeed against them, so nothing may call this finished.
    const task = reduceTask(s.events);
    assert.ok(task !== null);
    assert.equal(assessCompletion(task).complete, false);

    // And the reload in the middle changed nothing about any of it.
    assert.deepEqual(reduceContract(s.roundTrip()), finalContract, "contract loss across the scenario");
  });
});
