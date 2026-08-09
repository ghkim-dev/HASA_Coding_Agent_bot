import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { AgentSession } from "./session.ts";
import { allowingApprovalPort } from "./approval.ts";
import { nullLogger } from "../hasa-client/logger.ts";
import { createRepoFixture, type RepoFixture } from "../testing/repo-fixture.ts";
import { reduceTask, outstandingWork } from "./taskReducer.ts";
import {
  assessCompletion,
  describeTask,
  evidenceFrom,
  isSelfAuthoredOutput,
  verifierFor,
} from "./taskState.ts";
import type { SessionEvent } from "./sessionEvents.ts";
import type { AgentCompletion, AgentModel } from "./types.ts";
import type { NormalizedToolCall, ProviderMessage } from "../provider/types.ts";

/**
 * What was actually done, as opposed to what was said about it.
 *
 * Every case here is from one real transcript. Asked to build a dog/cat
 * classifier, the agent wrote the code, failed to load the model, ran
 * `python -c "print('모든 코드가 정상적으로 작동합니다')"`, and reported that
 * everything worked. The failure was available to the runtime as fact at every
 * step — a tool call that failed, a command whose only output was a sentence it
 * had written itself — and none of it was kept.
 *
 * The rule these all express:
 *
 *   The model proposes. The runtime records. A claim in text cannot change
 *   what the record says.
 */

const fixtures: RepoFixture[] = [];
after(async () => {
  for (const f of fixtures) await f.dispose().catch(() => {});
});

let seq = 0;
function ev(event: Partial<SessionEvent> & { type: SessionEvent["type"] }): SessionEvent {
  return { id: `e${seq++}`, turnId: "t1", at: seq, ...event } as SessionEvent;
}

const ask = (text: string): SessionEvent => ev({ type: "user_message", text });
const plan = (...steps: string[]): SessionEvent => ev({ type: "plan", steps, current: 1 });

function ranCommand(callId: string, command: string, ok: boolean, detail = ""): SessionEvent[] {
  return [
    ev({ type: "tool_started", callId, toolName: "run_command", risk: "execute", summary: command }),
    ev({
      type: "tool_completed",
      callId,
      toolName: "run_command",
      status: ok ? "success" : "failed",
      detail: detail || (ok ? "exit 0" : "exit 1"),
    }),
  ];
}

function wroteFile(callId: string, path: string): SessionEvent[] {
  return [
    ev({ type: "tool_started", callId, toolName: "create_file", risk: "write", summary: `${path} 작성` }),
    ev({ type: "tool_completed", callId, toolName: "create_file", status: "success", detail: "written" }),
    ev({ type: "file_changed", path, change: "created" }),
  ];
}

describe("9/13 — a command's own stdout is not verification", () => {
  test("a print-only one-liner supplies no verifier", () => {
    // The exact command from the transcript. Its exit status says the
    // interpreter ran; it says nothing about the sentence inside it.
    for (const command of [
      `python -c "print('모든 코드가 정상적으로 작동합니다')"`,
      `python3 -c 'print("all tests passed")'`,
      `node -e "console.log('build ok')"`,
      `echo "ALL TESTS PASSED"`,
    ]) {
      assert.equal(isSelfAuthoredOutput(command), true, command);
      assert.equal(verifierFor(command), null, command);
    }
  });

  test("a one-liner that actually does something is not dismissed", () => {
    // The rule is "only prints what it was told to print", not "is short".
    const real = `python -c "import torch; print(torch.rand(1))"`;
    assert.equal(isSelfAuthoredOutput(real), false);
  });

  test("a real test runner does supply one", () => {
    assert.equal(verifierFor("pytest -q")?.kind, "test_result");
    assert.equal(verifierFor("pnpm test")?.kind, "test_result");
    assert.equal(verifierFor("node --test src/")?.kind, "test_result");
    assert.equal(verifierFor("tsc --noEmit")?.kind, "build_result");
  });

  test("the evidence from a print-only command is not a test result", () => {
    const completed = ev({
      type: "tool_completed",
      callId: "c1",
      toolName: "run_command",
      status: "success",
      detail: "exit 0",
    }) as Extract<SessionEvent, { type: "tool_completed" }>;

    const asPrint = evidenceFrom(completed, `python -c "print('ALL TESTS PASSED')"`);
    assert.equal(asPrint?.kind, "command_result", "a command ran; that is all it says");
    assert.notEqual(asPrint?.kind, "test_result");

    const asTest = evidenceFrom(completed, "pytest -q");
    assert.equal(asTest?.kind, "test_result");
  });
});

describe("4/5/6 — a failure stays a failure until something shows otherwise", () => {
  const events = [
    ask("개와 고양이를 분류하는 모델을 만들어줘"),
    plan("CNN 구현", "CNN 실행", "Transformer 구현", "Transformer 실행"),
    ...wroteFile("c1", "cnn.py"),
    ...ranCommand("c2", "python cnn.py", true, "exit 0"),
    ...wroteFile("c3", "vit.py"),
    ...ranCommand("c4", "python vit.py", false, "size mismatch for classifier.weight"),
  ];

  test("implementation passing and execution failing are different requirements", () => {
    const task = reduceTask(events)!;
    const status = (id: string): string => task.requirements.find((r) => r.id === id)!.status;
    assert.equal(status("r1"), "passed", "CNN was written");
    assert.equal(status("r2"), "passed", "and it ran");
    assert.equal(status("r3"), "passed", "the Transformer was written");
    assert.equal(status("r4"), "failed", "and it did not run");
  });

  test("the failing call raises an issue that stays open", () => {
    const task = reduceTask(events)!;
    const open = task.issues.filter((i) => i.status === "open");
    assert.equal(open.length, 1);
    assert.match(open[0]!.detail, /size mismatch/, "the error as it arrived, not a paraphrase");
  });

  test("writing another file does not close it", () => {
    // The transcript's actual behaviour: the error scrolled past, more files
    // were written, and the final report did not mention it.
    const andMore = [...events, ...wroteFile("c5", "compare.py")];
    const task = reduceTask(andMore)!;
    assert.equal(task.issues.filter((i) => i.status === "open").length, 1);
  });

  test("the task is not complete while a requirement failed", () => {
    const verdict = assessCompletion(reduceTask(events)!);
    assert.equal(verdict.complete, false);
    assert.equal(verdict.partial, true);
    assert.deepEqual(verdict.failed.map((r) => r.id), ["r4"]);
  });

  test("nor while one was never run", () => {
    const notRun = [
      ask("만들어줘"),
      plan("구현", "실행"),
      ...wroteFile("c1", "a.py"),
    ];
    const verdict = assessCompletion(reduceTask(notRun)!);
    assert.equal(verdict.complete, false);
    assert.deepEqual(verdict.outstanding.map((r) => r.id), ["r2"]);
  });

  test("a task with no requirements is not complete either", () => {
    // Otherwise the whole mechanism is bypassed by never recording a plan.
    const bare = [ask("뭔가 해줘")];
    assert.equal(assessCompletion(reduceTask(bare)!).complete, false);
  });

  test("everything passing is complete", () => {
    const done = [
      ask("만들어줘"),
      plan("구현", "테스트"),
      ...wroteFile("c1", "a.py"),
      ...ranCommand("c2", "pytest -q", true),
    ];
    assert.equal(assessCompletion(reduceTask(done)!).complete, true);
  });
});

describe("12/39 — what the model is told before it answers", () => {
  test("the record names what failed and what was never run", () => {
    const events = [
      ask("만들어줘"),
      plan("CNN 구현", "CNN 실행", "Transformer 실행", "성능 비교"),
      ...wroteFile("c1", "cnn.py"),
      ...ranCommand("c2", "python cnn.py", true),
      ...ranCommand("c3", "python vit.py", false, "size mismatch for classifier.weight"),
    ];
    const record = describeTask(reduceTask(events)!);

    assert.match(record, /완료:/);
    assert.match(record, /실패:/);
    assert.match(record, /아직 실행 안 함:.*성능 비교/);
    assert.match(record, /미해결 오류:/);
    assert.match(record, /전체 완료라고 말하지 마십시오/);
  });

  test("and says so plainly when everything is confirmed", () => {
    const done = [ask("해줘"), plan("테스트"), ...ranCommand("c1", "pytest -q", true)];
    assert.match(describeTask(reduceTask(done)!), /요구사항이 모두 확인되었습니다/);
  });
});

describe("2/3/8 — a timeout ends a run, not the task", () => {
  const interrupted = [
    ask("개와 고양이 분류 프로젝트를 만들어줘"),
    plan("구조 만들기", "CNN 구현", "CNN 실행", "Transformer 실행", "데이터 학습"),
    ...wroteFile("c1", "structure.py"),
    ...wroteFile("c1b", "cnn.py"),
    ...ranCommand("c2", "python cnn.py", true),
    ...ranCommand("c3", "python vit.py", false, "size mismatch for classifier.weight"),
    ev({ type: "run_completed", reason: "timeout", summary: "" }),
  ];

  test("the task is still active after the run timed out", () => {
    const task = reduceTask(interrupted)!;
    assert.notEqual(task.status, "completed");
    assert.notEqual(task.status, "cancelled");
  });

  test("the goal survives", () => {
    assert.match(reduceTask(interrupted)!.goal, /개와 고양이/);
  });

  test("what was finished is not offered again", () => {
    // "이어서 해줘" must not start from the scaffold that already exists.
    const pending = outstandingWork(reduceTask(interrupted)!).map((r) => r.description);
    assert.ok(!pending.includes("구조 만들기"));
    assert.ok(!pending.includes("CNN 실행"));
  });

  test("and what failed is what it resumes from", () => {
    const pending = outstandingWork(reduceTask(interrupted)!).map((r) => r.description);
    assert.deepEqual(pending, ["Transformer 실행", "데이터 학습"]);
    assert.equal(reduceTask(interrupted)!.issues.filter((i) => i.status === "open").length, 1);
  });

  test("the record handed to the next turn carries the unresolved error", () => {
    const record = describeTask(reduceTask(interrupted)!);
    assert.match(record, /size mismatch/);
    assert.match(record, /Transformer 실행/);
  });
});

describe("57/58 — the record is a projection, so it replays", () => {
  test("reducing the same events twice gives the same state", () => {
    const events = [ask("해줘"), plan("구현", "실행"), ...wroteFile("c1", "a.py")];
    assert.deepEqual(reduceTask(events), reduceTask(events));
  });

  test("a branch's chain gives that branch's state", () => {
    // The events after a fork are not in the other branch's chain, so its task
    // state does not contain them. Nothing extra is needed for this to be true.
    const shared = [ask("해줘"), plan("구현", "실행"), ...wroteFile("c1", "a.py")];
    const mainLine = [...shared, ...ranCommand("c2", "python a.py", true)];
    const forked = [...shared, ...ranCommand("c3", "python a.py", false, "boom")];

    assert.equal(reduceTask(mainLine)!.requirements[1]!.status, "passed");
    assert.equal(reduceTask(forked)!.requirements[1]!.status, "failed");
    assert.equal(reduceTask(mainLine)!.issues.length, 0);
    assert.equal(reduceTask(forked)!.issues.length, 1);
  });

  test("a re-plan does not erase a status the record established", () => {
    // A model that revises its plan after a failure must not thereby lose the
    // failure — which is what the transcript did.
    const events = [
      ask("해줘"),
      plan("구현", "실행"),
      ...ranCommand("c1", "python a.py", false, "boom"),
      plan("구현", "실행", "다시 시도"),
    ];
    const task = reduceTask(events)!;
    assert.equal(task.requirements.find((r) => r.description === "실행")!.status, "failed");
    assert.equal(task.requirements.length, 3);
  });
});

describe("the model cannot write the record", () => {
  test("assistant text produces no evidence and settles nothing", () => {
    // The property everything above rests on. A turn whose only content is the
    // model saying it worked has an empty record.
    const claimed = [
      ask("해줘"),
      plan("구현", "테스트"),
      ev({ type: "assistant_text", text: "모든 코드가 정상적으로 작동합니다. 테스트를 통과했습니다." }),
      ev({ type: "run_completed", reason: "finished", summary: "모두 완료했습니다" }),
    ];
    const task = reduceTask(claimed)!;
    assert.deepEqual(task.evidence, []);
    assert.deepEqual(task.requirements.map((r) => r.status), ["pending", "pending"]);
    assert.equal(assessCompletion(task).complete, false);
    assert.match(describeTask(task), /전체 완료라고 말하지 마십시오/);
  });
});

describe("the loop hands the record over before the answer", () => {
  function completion(overrides: Partial<AgentCompletion> = {}): AgentCompletion {
    return { text: "", reasoning: "", toolCalls: [], inputTokens: 1, outputTokens: 1, ...overrides };
  }
  function call(name: string, id: string): NormalizedToolCall {
    return { id, name, arguments: {}, rawArguments: "{}", argumentsValid: true };
  }

  test("a turn that used a tool is shown what the runtime observed", async () => {
    const fixture = await createRepoFixture({ "a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);

    const seen: ProviderMessage[][] = [];
    let index = 0;
    const script = [
      completion({ toolCalls: [call("read_file", "c1")] }),
      completion({ text: "전부 정상 동작합니다." }),
      completion({ text: "코드를 읽었습니다. 실행은 하지 않았습니다." }),
    ];
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model: {
        modelId: "test",
        async complete(request) {
          seen.push(structuredClone([...request.messages]) as ProviderMessage[]);
          return script[index++] ?? completion({ text: "끝" });
        },
      },
      approvalPort: allowingApprovalPort,
      approvalMode: "auto",
      mode: "code",
      logger: nullLogger,
      taskRecord: () => "목표: 확인\n아직 실행 안 함: 실행\n확인되지 않은 요구사항이 남아 있습니다.",
    });

    await session.send("확인해줘", new AbortController().signal);

    // The model's first attempt to finish is answered with the record, and the
    // request after it contains what the runtime observed.
    const last = JSON.stringify(seen.at(-1));
    assert.match(last, /런타임이 관측한 기록/);
    assert.match(last, /아직 실행 안 함/);
    assert.equal(index, 3, "the model got a second chance to answer, once");
  });

  test("and only once, so a turn cannot be held open by it", async () => {
    const fixture = await createRepoFixture({ "a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);
    let calls = 0;
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model: {
        modelId: "test",
        async complete() {
          calls += 1;
          return calls === 1
            ? completion({ toolCalls: [call("read_file", "c1")] })
            : completion({ text: "다 됐습니다." });
        },
      },
      approvalPort: allowingApprovalPort,
      approvalMode: "auto",
      mode: "code",
      logger: nullLogger,
      taskRecord: () => "목표: 확인\n아직 실행 안 함: 실행",
    });

    const result = await session.send("확인해줘", new AbortController().signal);
    assert.equal(result.reason, "finished");
    assert.equal(calls, 3, "one tool call, one reconciliation, one answer");
  });

  test("a turn that touched nothing is not interrupted by it", async () => {
    // Answering a question without using a tool has no record to disagree with,
    // and an extra round trip there is cost with no benefit.
    const fixture = await createRepoFixture({ "a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);
    let calls = 0;
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model: {
        modelId: "test",
        async complete() {
          calls += 1;
          return completion({ text: "이 코드는 상수를 내보냅니다." });
        },
      },
      approvalPort: allowingApprovalPort,
      approvalMode: "auto",
      mode: "code",
      logger: nullLogger,
      taskRecord: () => "목표: 설명",
    });

    await session.send("이 코드 설명해줘", new AbortController().signal);
    assert.equal(calls, 1);
  });
});
