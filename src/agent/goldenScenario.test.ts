import { test, describe, before, after } from "node:test";
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

type Contract = ReturnType<typeof reduceContract>;

describe("M — the dog/cat transcript, five turns", () => {
  let s: Scenario;
  let afterOne: Contract;
  let planned: SessionEvent[];
  let afterReload: Contract;
  let afterTwo: Contract;
  let afterThree: Contract;
  let afterFour: Contract;
  let executedBefore: number;
  let finalContract: Contract;
  let finalAnswer: SessionEvent | undefined;
  let task: ReturnType<typeof reduceTask>;
  let afterFinalReload: Contract;

  /**
   * The five turns are driven once, here. Every test below reads what this
   * recorded; not one of them sends another turn.
   *
   * It does not throw, and that is deliberate. `node --test` treats a `before()`
   * that throws as a *cancellation* of every test underneath it: not one of the
   * cases below runs, each is reported `cancelled`, and the summary line still
   * prints `fail 0`. That zero is a lie — the scenario never built, nothing was
   * checked — and a green summary over an input that never loaded is the one
   * thing this harness must not hand back.
   *
   * So the failure is caught and kept, and the first test of this suite asserts
   * it away by name, carrying the build's own stack in its message. Every test
   * after it then reads an unbuilt scenario and fails under its own name, which
   * is what splitting these assertions case by case was for: a named failure per
   * case beats one silent cancellation of all of them.
   */
  let buildError: Error | null = null;
  before(async () => {
    try {
      s = await openScenario();

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

      afterOne = reduceContract(s.events);
      planned = s.events.filter((e) => e.type === "plan");

      // ── serialise / reload, between turn 1 and turn 2 ──────────────────────
      const reloaded = s.roundTrip();
      afterReload = reduceContract(reloaded);
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

      afterTwo = reduceContract(s.events);

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

      afterThree = reduceContract(s.events);

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
      afterFour = reduceContract(s.events);

      // ── TURN 5 — the correction ────────────────────────────────────────────
      executedBefore = s.executed.filter((name) => name === "run_command").length;
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

      finalContract = reduceContract(s.events);
      // The source really is in the answer.
      finalAnswer = s.events.filter((e) => e.type === "assistant_text").at(-1);
      task = reduceTask(s.events);
      // And the reload in the middle changed nothing about any of it.
      afterFinalReload = reduceContract(s.roundTrip());
    } catch (err) {
      buildError = err as Error;
    }
  });

  /**
   * The first test in this suite, and what makes catching the hook above safe:
   * a scenario that did not build fails here, by name, with the build's stack —
   * instead of vanishing into `cancelled` under a `fail 0` summary.
   */
  test("M · the five turns were driven", () => {
    assert.equal(buildError, null, `the five turns could not be driven: ${buildError?.stack}`);
    assert.equal(
      s.events.filter((e) => e.type === "user_message").length,
      5,
      "five turns were asked",
    );
  });

  /**
   * T1 — the whole request, the turn the real agent kept about half of.
   *
   * The plan named two of the eight. That is the bug this layer was built for.
   */
  describe("T1 — 개와 고양이를 분류하는 프로젝트", () => {
    test("T1 · requirement count", () => {
      assert.equal(activeRequirements(afterOne).length, 8, "requirement loss at turn 1");
    });

    test("T1 · a plan was recorded", () => {
      assert.ok(planned.length > 0);
    });

    test("T1 · the plan does not shrink the contract", () => {
      // The count is pinned by "T1 · requirement count" above. What is asserted
      // here is the gap that pin exists for: the plan named two steps against a
      // contract of eight, and the contract is not narrowed to the plan's two.
      const steps = planned.flatMap((e) => (e.type === "plan" ? e.steps : []));
      assert.deepEqual(steps, ["CNN 구현", "ViT 구현"], "the plan named two");
      assert.ok(
        steps.length < activeRequirements(afterOne).length,
        "the plan must not shrink the contract",
      );
    });
  });

  /** The serialise/reload the host does between turn 1 and turn 2. */
  describe("reload — between turn 1 and turn 2", () => {
    test("reload · the contract survives a serialise/reload", () => {
      // Say there is something to compare before comparing. Both sides are
      // `undefined` when the hook above caught a build failure, and
      // `deepEqual(undefined, undefined)` passes — a green tick over a scenario
      // that never ran is the same lie as `fail 0` over a cancelled suite.
      assert.ok(afterOne?.requirements.length, "no turn-1 contract was built to compare");
      assert.deepEqual(afterReload, afterOne, "contract loss across a reload");
    });
  });

  describe("T2 — 기존에 진행하던 것을 이어서", () => {
    test("T2 · requirement count", () => {
      assert.equal(activeRequirements(afterTwo).length, 8, "a continuation must not add or drop requirements");
    });

    test("T2 · goal", () => {
      assert.equal(afterTwo.goal, afterOne.goal, "nor rewrite the goal");
    });
  });

  describe("T3 — 오픈소스/HASA 모델도 사용해 결과 정리", () => {
    test("T3 · requirement count", () => {
      assert.equal(activeRequirements(afterThree).length, 10, "a refinement adds without losing");
    });

    test("T3 · turn 1's requirements (Hugging Face)", () => {
      assert.match(
        activeRequirements(afterThree).map((r) => r.description).join(" | "),
        /Hugging Face/,
        "the original requirements are still there three turns later",
      );
    });
  });

  describe("T4 — 너가 결과를 실행해서 보여줄 수 있어?", () => {
    test("T4 · intents include execute", () => {
      assert.ok(afterFour.intents.includes("execute"));
    });
  });

  /**
   * T5 — the correction: "코드 결과물을 직접 대화창에서 출력해서 보여달라는
   * 말이었음." The real agent kept executing.
   *
   * I — the regression this whole slice is named after.
   */
  describe("T5 — the correction", () => {
    test("T5 · intents", () => {
      assert.deepEqual(finalContract.intents, ["present"], "the correction must replace the misread intent");
    });

    test("T5 · relation", () => {
      assert.equal(finalContract.relation, "correct");
    });

    test("T5 · run_command count", () => {
      assert.equal(
        s.executed.filter((name) => name === "run_command").length,
        executedBefore,
        "turn 5 must run nothing",
      );
    });

    test("T5 · read_file", () => {
      assert.ok(s.executed.includes("read_file"), "it must read the file it was asked to show");
    });

    test("T5 · create_file", () => {
      assert.ok(
        !s.executed.slice(-4).includes("create_file"),
        "and write nothing",
      );
    });

    test("T5 · the answer carries the source", () => {
      assert.match(String(finalAnswer?.type === "assistant_text" ? finalAnswer.text : ""), /class CNN/);
    });
  });

  // ── across the whole scenario ──────────────────────────────────────────
  /**
   * 8 from turn 1, 2 added by turn 3, 1 by turn 4, 1 by turn 5. A correction
   * retires the *deliverable* it contradicts and adds what it asks for: the
   * user did not retract wanting results, they said how they wanted them.
   */
  describe("across the whole scenario", () => {
    test("scenario · requirement count", () => {
      assert.equal(activeRequirements(finalContract).length, 12, "requirement loss across five turns");
    });

    test("scenario · turn 1's requirements after the correction", () => {
      assert.ok(
        activeRequirements(finalContract).some((r) => r.description.includes("Hugging Face")),
        "turn 1's requirements are still standing after the correction",
      );
    });

    test("scenario · the contradicted deliverable is superseded", () => {
      const retired = finalContract.deliverables.find((d) => d.description === "실행 결과");
      assert.equal(retired?.lifecycle, "superseded", "the deliverable the correction contradicts");
    });

    test("scenario · active deliverables", () => {
      assert.deepEqual(
        finalContract.deliverables.filter((d) => d.lifecycle === "active").map((d) => d.description),
        ["실행 가능한 프로젝트", "비교 결과", "소스 코드"],
      );
    });

    test("scenario · a task was reduced", () => {
      assert.ok(task !== null, "five turns of events reduced to no task at all");
      assert.match(task.goal, /개와 고양이를 분류하는 모델/, "the task keeps turn 1's ask as its goal");
    });

    // false completion = 0. Eight of the eleven requirements never had a tool
    // succeed against them, so nothing may call this finished.
    //
    // 알려진 어긋남: nothing may call it finished, and nothing does — but not for
    // the reason the line above gives. `reduceTask` builds requirements from
    // `plan` events alone, so the task this reads holds the plan's two steps.
    // Neither eleven nor eight of anything is in it, and the twelve the contract
    // ends five turns with are somewhere `assessCompletion` never looks. Both
    // plan steps are still `pending` with no evidence, so `complete` is false —
    // false on the two the plan named, not on the eight it dropped. Pinned as it
    // stands, not fixed here.
    //
    // The null guard lives in this test rather than beside it: split into its
    // own case it stopped protecting the call below, which had to assert `task!`
    // by hand. Now a null task fails here, under this test's name.
    test("scenario · false completion", () => {
      assert.ok(task !== null, "no task was reduced, so completion cannot be assessed");
      assert.equal(assessCompletion(task).complete, false);
      assert.deepEqual(
        task.requirements.map((r) => `${r.description}:${r.status}`),
        ["CNN 구현:pending", "ViT 구현:pending"],
        "what the completion gate is actually judging",
      );
    });

    test("scenario · contract across a final reload", () => {
      // As in "reload · the contract survives a serialise/reload": two
      // undefineds compare equal, so the comparison has to be shown to have
      // sides before it is trusted.
      assert.ok(finalContract?.requirements.length, "no final contract was built to compare");
      assert.deepEqual(afterFinalReload, finalContract, "contract loss across the scenario");
    });
  });
});
