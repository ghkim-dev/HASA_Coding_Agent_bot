import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { AgentSession } from "./session.ts";
import { allowingApprovalPort } from "./approval.ts";
import { nullLogger } from "../hasa-client/logger.ts";
import { createRepoFixture, type RepoFixture } from "../testing/repo-fixture.ts";
import {
  NO_PROGRESS_DETECTED,
  STALL_WARNING_AT,
  commandShape,
  cyclePeriod,
  newProgressState,
  observationKey,
  observeAction,
  stallVerdict,
  structuralKey,
  type ActionObservation,
} from "./progress.ts";
import { ACTION_REQUIRES_JUSTIFICATION } from "./actionPolicy.ts";
import type { AgentCompletion, AgentModel } from "./types.ts";
import type { NormalizedToolCall } from "../provider/types.ts";

/**
 * Being busy is not the same as getting anywhere.
 *
 * From the transcript that started this:
 *
 *     python -c "print('프로젝트 완료')"
 *     python -c "print('프로젝트 최종 완료')"
 *     python -c "print('모든 구성 요소 정상')"
 *
 * Three different strings, so the exact-repetition detector saw three unrelated
 * calls. Three tool results, so anything counting events saw progress. Nothing
 * verified, nothing changed, nothing learned.
 *
 * The hard half of this is not catching that. It is catching it without
 * stopping an agent that is reading its way through a problem, or retrying a
 * test it has just fixed — so half the tests below exist to prove the detector
 * stays quiet when it should.
 */

const fixtures: RepoFixture[] = [];
after(async () => {
  for (const f of fixtures) await f.dispose().catch(() => {});
});

function ran(command: string, ok = true, detail = ""): ActionObservation {
  return {
    toolName: "run_command",
    args: { command },
    outcome: ok ? "executed" : "failed",
    detail: detail || (ok ? "exit 0" : "exit 1"),
    changedFiles: [],
  };
}

function read(path: string, detail = "contents"): ActionObservation {
  return { toolName: "read_file", args: { path }, outcome: "executed", detail, changedFiles: [] };
}

function wrote(path: string, detail: string): ActionObservation {
  return {
    toolName: "create_file",
    args: { path },
    outcome: "executed",
    detail,
    changedFiles: [path],
  };
}

/** Folds a sequence and returns what each action was worth. */
function sequence(observations: ActionObservation[]): { classes: string[]; state: ReturnType<typeof newProgressState> } {
  const state = newProgressState();
  return { classes: observations.map((o) => observeAction(state, o)), state };
}

describe("9/11/27 — the print loop, without exact string equality", () => {
  test("every celebratory one-liner is the same shape", () => {
    const keys = [
      `python -c "print('프로젝트 완료')"`,
      `python -c "print('프로젝트 최종 완료')"`,
      `python -c "print('모든 구성 요소 정상')"`,
      `node -e "console.log('done')"`,
    ].map((command) => structuralKey(ran(command)));

    assert.equal(new Set(keys).size, 1, "different text, one operation");
    assert.equal(keys[0], "run_command:print_only");
  });

  test("and none of them counts as progress, however new the sentence", () => {
    const { classes } = sequence([
      ran(`python -c "print('프로젝트 완료')"`),
      ran(`python -c "print('프로젝트 최종 완료')"`),
      ran(`python -c "print('모든 구성 요소 정상')"`),
      ran(`python -c "print('최종 확인')"`),
    ]);
    assert.deepEqual(classes, ["none", "none", "none", "none"]);
  });

  test("35 — a growing pile of evidence events does not fake it", () => {
    // Every one of these produces a tool result. A detector counting events
    // would see four increments and call it work.
    const { state } = sequence([
      ran(`echo "step 1 complete"`),
      ran(`echo "step 2 complete"`),
      ran(`echo "step 3 complete"`),
      ran(`echo "all complete"`),
    ]);
    assert.equal(state.meaningful, 0);
    assert.equal(state.streak, 4);
    assert.equal(stallVerdict(state), "warn");
  });

  test("a command that computes something is not a print-only one", () => {
    // The rule is "only prints what it was told to print", not "is short".
    assert.equal(commandShape(`python -c "print('done')"`), "print_only");
    assert.equal(commandShape(`python -c "import torch; print(torch.rand(1))"`), "other");
    assert.equal(commandShape("pytest -q"), "verifier");
  });
});

describe("29/32 — legitimate work is not a loop", () => {
  test("30 — reading three files nobody has read is investigation", () => {
    const { classes, state } = sequence([read("a.ts"), read("b.ts"), read("c.ts")]);
    assert.deepEqual(classes, ["weak", "weak", "weak"]);
    assert.equal(stallVerdict(state), "ok");
  });

  test("31 — reading the same file again is not", () => {
    const { classes } = sequence([read("a.ts"), read("a.ts"), read("a.ts")]);
    assert.deepEqual(classes, ["weak", "none", "none"]);
  });

  test("29 — a test that fails, gets patched, then passes is normal", () => {
    // The most important false positive to avoid. Running the same test twice
    // is exactly what fixing something looks like.
    const { classes, state } = sequence([
      ran("pytest -q", false, "1 failed: test_login"),
      wrote("login.py", "fixed"),
      ran("pytest -q", true, "1 passed"),
    ]);
    assert.deepEqual(classes, ["weak", "strong", "strong"]);
    assert.equal(stallVerdict(state), "ok");
  });

  test("15 — the same failure again, with nothing changed in between, is not", () => {
    const { classes, state } = sequence([
      ran("pytest -q", false, "1 failed: test_login"),
      ran("pytest -q", false, "1 failed: test_login"),
      ran("pytest -q", false, "1 failed: test_login"),
    ]);
    assert.deepEqual(classes, ["weak", "none", "none"]);
    assert.equal(state.streak, 2);
  });

  test("32 — a different failure is a discovery", () => {
    const { classes } = sequence([
      ran("pytest -q", false, "1 failed: test_login"),
      ran("pytest -q", false, "1 failed: test_logout"),
    ]);
    assert.deepEqual(classes, ["weak", "weak"]);
  });

  test("the same failure with different line numbers is the same failure", () => {
    // Timings and offsets vary between runs; the problem does not.
    const { classes } = sequence([
      ran("pytest", false, "AssertionError at line 42, took 1.2s"),
      ran("pytest", false, "AssertionError at line 42, took 1.9s"),
    ]);
    assert.deepEqual(classes, ["weak", "none"]);
  });

  test("14 — the same test file run twice for different files is not a loop", () => {
    // Structural shape alone would call these a repetition. The target is what
    // makes them different, and it is in the key.
    assert.notEqual(structuralKey(ran("pytest test_a.py")), structuralKey(ran("pytest test_b.py")));
  });
});

describe("7 — writing files", () => {
  test("a real change is strong progress", () => {
    const { classes } = sequence([wrote("a.ts", "version one"), wrote("b.ts", "version two")]);
    assert.deepEqual(classes, ["strong", "strong"]);
  });

  test("writing the same content again is not", () => {
    const { classes } = sequence([wrote("a.ts", "same"), wrote("a.ts", "same"), wrote("a.ts", "same")]);
    assert.deepEqual(classes, ["strong", "none", "none"]);
  });
});

describe("34 — rewriting the plan is not progress", () => {
  test("plan churn moves nothing", () => {
    const plan = (steps: string): ActionObservation => ({
      toolName: "update_plan",
      args: { steps },
      outcome: "executed",
      detail: "plan shown",
      changedFiles: [],
    });
    const { classes, state } = sequence([plan("A"), plan("B"), plan("C")]);
    assert.deepEqual(classes, ["none", "none", "none"]);
    assert.equal(stallVerdict(state), "warn");
  });
});

describe("16/33 — a call that never ran moved nothing", () => {
  test("a deferred action is not progress", () => {
    const deferred = (command: string): ActionObservation => ({
      toolName: "run_command",
      args: { command },
      outcome: "deferred",
      detail: `${ACTION_REQUIRES_JUSTIFICATION}: 실행하지 않았습니다.`,
      changedFiles: [],
    });
    const { classes, state } = sequence([deferred("ls"), deferred("pwd"), deferred("cat a")]);
    assert.deepEqual(classes, ["none", "none", "none"]);
    assert.equal(stallVerdict(state), "warn");
  });
});

describe("17 — cycles", () => {
  test("a repeated pair is found", () => {
    assert.equal(cyclePeriod(["A", "B", "A", "B"]), 2);
    assert.equal(cyclePeriod(["A", "A"]), 1);
    assert.equal(cyclePeriod(["A", "B", "C", "A", "B", "C"]), 3);
  });

  test("and an ordinary sequence is not", () => {
    assert.equal(cyclePeriod(["A", "B", "C", "D"]), null);
  });
});

describe("5/6 — what makes two observations the same", () => {
  test("the subject and the outcome, not the raw text", () => {
    assert.equal(
      observationKey(ran("pytest", false, "FAILED test_x — took 3s")),
      observationKey(ran("pytest", false, "FAILED test_x — took 9s")),
    );
  });

  test("a pass and a fail of the same thing are different observations", () => {
    assert.notEqual(observationKey(ran("pytest", true)), observationKey(ran("pytest", false)));
  });
});

describe("19/20/23 — the challenge, then the ending", () => {
  test("a warning comes first, and only once", () => {
    const state = newProgressState();
    for (let i = 0; i < STALL_WARNING_AT; i += 1) observeAction(state, ran(`echo ${i}`));
    assert.equal(stallVerdict(state), "warn");

    state.challenged = true;
    assert.equal(stallVerdict(state), "ok", "the same streak does not warn twice");
  });

  test("22 — real work resets it", () => {
    const state = newProgressState();
    for (let i = 0; i < STALL_WARNING_AT; i += 1) observeAction(state, ran(`echo ${i}`));
    state.challenged = true;
    observeAction(state, wrote("a.ts", "something real"));
    assert.equal(state.streak, 0);
    assert.equal(state.challenged, false, "a fresh stall gets a fresh warning");
  });

  test("23 — more of the same after the challenge stops the run", () => {
    const state = newProgressState();
    for (let i = 0; i < STALL_WARNING_AT; i += 1) observeAction(state, ran(`echo ${i}`));
    state.challenged = true;
    observeAction(state, ran("echo a"));
    observeAction(state, ran("echo b"));
    assert.equal(stallVerdict(state), "stop");
  });
});

describe("11/27 — the print loop, in the real loop", () => {
  function completion(overrides: Partial<AgentCompletion> = {}): AgentCompletion {
    return { text: "", reasoning: "", toolCalls: [], inputTokens: 1, outputTokens: 1, ...overrides };
  }
  function call(name: string, id: string, args: Record<string, unknown> = {}): NormalizedToolCall {
    return { id, name, arguments: args, rawArguments: JSON.stringify(args), argumentsValid: true };
  }

  test("a model that keeps printing is stopped, well before maxSteps", async () => {
    const fixture = await createRepoFixture({ "a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);

    const sentences = [
      "프로젝트 완료",
      "프로젝트 최종 완료",
      "모든 구성 요소 정상",
      "최종 확인",
      "다시 확인",
      "정상 동작",
      "완료되었습니다",
      "확인 완료",
    ];
    let index = 0;
    let modelCalls = 0;
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model: {
        modelId: "test",
        async complete() {
          modelCalls += 1;
          if (modelCalls === 1) {
            return completion({
              toolCalls: [
                call("record_request", "r1", {
                  goal: "프로젝트 검증",
                  relation: "new_task",
                  intents: "verify execute",
                  requirements: "테스트 통과 확인",
                }),
              ],
            });
          }
          const sentence = sentences[index++ % sentences.length];
          return completion({
            toolCalls: [call("run_command", `x${index}`, { command: `python -c "print('${sentence}')"` })],
          });
        },
      } as AgentModel,
      approvalPort: allowingApprovalPort,
      approvalMode: "auto",
      mode: "code",
      logger: nullLogger,
      commands: [
        { kind: "acceptance", gate: "run", cmd: "node", args: ["-e", "console.log(1)"], timeoutMs: 5_000 },
      ],
      // Deliberately generous. The point is that the run stops long before it.
      budget: { maxSteps: 60, maxToolCalls: 60, maxModelCalls: 60, maxRepeatedCalls: 99 },
    });

    const result = await session.send("전부 잘 되는지 확인해줘", new AbortController().signal);

    assert.equal(result.reason, "no_progress", "the run must say why it stopped");
    assert.ok(modelCalls < 20, `stopped after ${modelCalls} model calls, far short of the budget`);

    // The model was told once before it was stopped.
    const history = JSON.stringify(session.history());
    assert.match(history, new RegExp(NO_PROGRESS_DETECTED));
    assert.match(history, /report_blocked/, "and told the way out");
  });

  test("24 — no_progress is a run ending, not a finished task", async () => {
    // The task keeps its requirements, so the next turn can continue.
    const fixture = await createRepoFixture({ "a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);
    let calls = 0;
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model: {
        modelId: "test",
        async complete() {
          calls += 1;
          if (calls === 1) {
            return completion({
              toolCalls: [
                call("record_request", "r1", {
                  goal: "확인",
                  relation: "new_task",
                  intents: "verify",
                  requirements: "테스트 통과 확인\n성능 측정",
                }),
              ],
            });
          }
          return completion({ toolCalls: [call("run_command", `x${calls}`, { command: `echo ${calls}` })] });
        },
      } as AgentModel,
      approvalPort: allowingApprovalPort,
      approvalMode: "auto",
      mode: "code",
      logger: nullLogger,
      commands: [
        { kind: "acceptance", gate: "run", cmd: "node", args: ["-e", "console.log(1)"], timeoutMs: 5_000 },
      ],
      budget: { maxSteps: 60, maxToolCalls: 60, maxModelCalls: 60, maxRepeatedCalls: 99 },
    });

    const result = await session.send("확인해줘", new AbortController().signal);
    assert.equal(result.reason, "no_progress");

    // The contract is untouched: both requirements are still standing.
    assert.deepEqual(
      session.taskContract.requirements.filter((r) => r.lifecycle === "active").map((r) => r.description),
      ["테스트 통과 확인", "성능 측정"],
    );
  });

  /**
   * A tool that throws, rather than one that returns a failure.
   *
   * The two are the same thing to a user and were not the same thing to the
   * stall detector: `invoke`'s catch handed the message to the model and
   * recorded nothing, so the streak stayed at zero and the run went to
   * `maxSteps` — forty actions later, under a message about the request being
   * too large. The environments where every call throws (a spawn refused by
   * policy, a locked directory, an interpreter that dies on start) are exactly
   * the ones where the detector was needed and absent.
   *
   * Deterministic on purpose: the runner is injected and throws, so this
   * reproduces on a machine where `python` works and on one where it does not.
   */
  test("a tool that throws every time is a stall, not a step budget", async () => {
    const fixture = await createRepoFixture({ "a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);

    let modelCalls = 0;
    let spawns = 0;
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model: {
        modelId: "test",
        async complete() {
          modelCalls += 1;
          if (modelCalls === 1) {
            return completion({
              toolCalls: [
                call("record_request", "r1", {
                  goal: "학습 실행",
                  relation: "new_task",
                  intents: "execute",
                  requirements: "학습 스크립트 실행",
                }),
              ],
            });
          }
          return completion({
            toolCalls: [call("run_command", `x${modelCalls}`, { executable: "python", args: "train.py" })],
          });
        },
      } as AgentModel,
      approvalPort: allowingApprovalPort,
      approvalMode: "auto",
      mode: "code",
      logger: nullLogger,
      // Not CommandRejected and not ENOENT, so `shellTools` rethrows it and the
      // loop's catch is the path under test.
      runCommand: async () => {
        spawns += 1;
        throw new Error("EPERM: operation not permitted");
      },
      budget: { maxSteps: 60, maxToolCalls: 60, maxModelCalls: 60, maxRepeatedCalls: 99 },
    });

    const result = await session.send("학습 돌려줘", new AbortController().signal);

    assert.equal(result.reason, "no_progress", `stopped for ${result.reason} after ${spawns} throwing calls`);
    assert.ok(modelCalls < 20, `stopped after ${modelCalls} model calls, far short of the budget`);
    assert.match(JSON.stringify(session.history()), new RegExp(NO_PROGRESS_DETECTED));
  });

  /**
   * The other direction, which is the one that costs a working agent.
   *
   * Three throws that say three different things are three findings — a missing
   * package, then another, then a syntax error — and an agent working through
   * them is doing the job. Counting a thrown error as no progress must not make
   * investigation look like a loop.
   */
  test("throws that say different things are investigation, not a stall", async () => {
    const fixture = await createRepoFixture({ "a.ts": "export const a = 1;\n" });
    fixtures.push(fixture);

    const errors = [
      "ModuleNotFoundError: No module named 'torch'",
      "ModuleNotFoundError: No module named 'numpy'",
      "SyntaxError: invalid syntax in train.py",
    ];
    let modelCalls = 0;
    let attempt = 0;
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model: {
        modelId: "test",
        async complete() {
          modelCalls += 1;
          if (modelCalls === 1) {
            return completion({
              toolCalls: [
                call("record_request", "r1", {
                  goal: "학습 실행",
                  relation: "new_task",
                  intents: "execute",
                  requirements: "학습 스크립트 실행",
                }),
              ],
            });
          }
          if (attempt < errors.length) {
            return completion({
              toolCalls: [call("run_command", `x${modelCalls}`, { executable: "python", args: "train.py" })],
            });
          }
          return completion({
            text:
              "train.py 를 세 번 실행했고 세 번 다 다른 이유로 멈췄습니다: torch 없음, numpy 없음, " +
              "그리고 문법 오류. 환경이 준비되지 않아 더 진행하지 못했습니다.",
          });
        },
      } as AgentModel,
      approvalPort: allowingApprovalPort,
      approvalMode: "auto",
      mode: "code",
      logger: nullLogger,
      runCommand: async () => {
        const message = errors[attempt] ?? "unreachable";
        attempt += 1;
        throw new Error(message);
      },
      budget: { maxSteps: 60, maxToolCalls: 60, maxModelCalls: 60, maxRepeatedCalls: 99 },
    });

    const result = await session.send("학습 돌려줘", new AbortController().signal);

    assert.notEqual(result.reason, "no_progress", "three different findings are not a stall");
    assert.equal(attempt, errors.length, "every attempt was allowed to run");
    assert.doesNotMatch(
      JSON.stringify(session.history()),
      new RegExp(NO_PROGRESS_DETECTED),
      "and the model was never told it was going in circles",
    );
  });
});

describe("a thrown failure is classified like a returned one", () => {
  /** What `invoke`'s catch now records: an outcome of `failed` and the message. */
  function threw(command: string, message: string): ActionObservation {
    return {
      toolName: "run_command",
      args: { command },
      outcome: "failed",
      detail: `error: ${message}`,
      changedFiles: [],
    };
  }

  test("the first throw is a finding", () => {
    const { classes, state } = sequence([threw("python train.py", "EPERM: operation not permitted")]);
    assert.deepEqual(classes, ["weak"]);
    assert.equal(stallVerdict(state), "ok");
  });

  test("the same throw over and over is a stall", () => {
    const { classes, state } = sequence([
      threw("python train.py", "EPERM: operation not permitted"),
      threw("python train.py", "EPERM: operation not permitted"),
      threw("python train.py", "EPERM: operation not permitted"),
      threw("python train.py", "EPERM: operation not permitted"),
    ]);
    assert.deepEqual(classes, ["weak", "none", "none", "none"]);
    assert.equal(stallVerdict(state), "warn");
  });

  test("different throws are not", () => {
    const { classes, state } = sequence([
      threw("python train.py", "No module named 'torch'"),
      threw("python train.py", "No module named 'numpy'"),
      threw("python train.py", "SyntaxError: invalid syntax"),
      threw("python train.py", "CUDA out of memory"),
    ]);
    assert.deepEqual(classes, ["weak", "weak", "weak", "weak"]);
    assert.equal(stallVerdict(state), "ok");
  });

  test("a throw, a fix, then the same call again is an ordinary retry", () => {
    const { classes, state } = sequence([
      threw("python train.py", "No module named 'torch'"),
      wrote("requirements.txt", "torch"),
      threw("python train.py", "No module named 'torch'"),
    ]);
    // The third is a repeat of the first and worth nothing on its own — but the
    // fix in between reset the streak, so nothing is stopped.
    assert.deepEqual(classes, ["weak", "strong", "none"]);
    assert.equal(state.streak, 1);
    assert.equal(stallVerdict(state), "ok");
  });
});

describe("refusals that never ran are counted too", () => {
  test("a tool that does not exist, asked for repeatedly, is a stall", () => {
    // `get_git_diff` outside a repository, `edit_file` in ask mode: the model
    // reaches for a tool its mode does not have and reads the same refusal.
    const missing = (name: string): ActionObservation => ({
      toolName: name,
      args: {},
      outcome: "failed",
      detail: `refused: there is no tool called "${name}". Available tools: read_file, run_command`,
      changedFiles: [],
    });
    const { classes, state } = sequence([
      missing("get_git_diff"),
      missing("get_git_diff"),
      missing("get_git_diff"),
      missing("get_git_diff"),
    ]);
    assert.deepEqual(classes, ["weak", "none", "none", "none"]);
    assert.equal(stallVerdict(state), "warn");
  });

  test("but reaching for two different absent tools is still learning", () => {
    const missing = (name: string): ActionObservation => ({
      toolName: name,
      args: {},
      outcome: "failed",
      detail: `refused: there is no tool called "${name}". Available tools: read_file`,
      changedFiles: [],
    });
    const { classes, state } = sequence([missing("get_git_diff"), missing("apply_patch")]);
    assert.deepEqual(classes, ["weak", "weak"]);
    assert.equal(stallVerdict(state), "ok");
  });
});
