import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { AgentSession } from "./session.ts";
import { allowingApprovalPort } from "./approval.ts";
import { nullLogger } from "../hasa-client/logger.ts";
import { createRepoFixture, type RepoFixture } from "../testing/repo-fixture.ts";
import { TurnRecorder } from "./sessionRecorder.ts";
import type { SessionEvent } from "./sessionEvents.ts";
import {
  ACTION_DENIED_BY_CONSTRAINT,
  ACTION_REQUIRES_JUSTIFICATION,
  TURN_CONTRACT_REQUIRED,
  decideAction,
} from "./actionPolicy.ts";
import { parseTurnContract, reduceContract } from "./turnContract.ts";
import type { AgentCompletion, AgentEvent, AgentModel } from "./types.ts";
import type { NormalizedToolCall } from "../provider/types.ts";

/**
 * A policy that only comments is not a policy.
 *
 * `requires_justification` used to let the call through and attach a note to
 * its result — so the command ran, the workspace changed, the tokens were
 * spent, and the objection arrived as a footnote. The failure it was written
 * for happened anyway.
 *
 * What every test here checks is the distinction that makes it real:
 *
 *     proposed   what the model asked to do
 *     deferred   what the runtime held back
 *     executed   what actually ran
 *
 * The interesting number is the third. A test that only checks the model chose
 * well is a test of the model; these check that choosing badly is survivable.
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

/** Counts what was asked for against what happened. */
class Counted {
  readonly events: SessionEvent[] = [];
  readonly proposed: string[] = [];
  /** Commands the shell actually launched. The number that matters. */
  readonly launched: string[] = [];
  session!: AgentSession;
  private ordinal = 0;
  private queue: AgentCompletion[] = [];

  script(steps: AgentCompletion[]): void {
    this.queue = [...steps];
  }
  next(): AgentCompletion {
    const step = this.queue.shift() ?? completion({ text: "끝." });
    for (const c of step.toolCalls) this.proposed.push(c.name);
    return step;
  }

  async ask(prompt: string): Promise<void> {
    const recorder = new TurnRecorder({ turnId: `c-${this.ordinal++}` });
    this.events.push(...recorder.userMessage(prompt, []));
    this.session.setEventSink((event: AgentEvent) => this.events.push(...recorder.record(event)));
    await this.session.send(prompt, new AbortController().signal);
  }

  /** Tool calls that reached execution, by name. */
  executed(name: string): number {
    return this.events.filter(
      (e) => e.type === "tool_completed" && e.toolName === name && !e.detail.includes("ACTION_") && !e.detail.includes("TURN_CONTRACT"),
    ).length;
  }

  /** Tool calls the runtime held back. */
  deferred(code: string): number {
    return this.events.filter((e) => e.type === "tool_completed" && e.detail.includes(code)).length;
  }
}

async function counted(): Promise<Counted> {
  const fixture = await createRepoFixture({
    "cnn_model.py": "import torch\n\nclass CNN(torch.nn.Module):\n    pass\n",
  });
  fixtures.push(fixture);
  const c = new Counted();
  const model: AgentModel = {
    modelId: "test",
    async complete() {
      return c.next();
    },
  };
  c.session = await AgentSession.open({
    workspaceRoot: fixture.root,
    model,
    approvalPort: allowingApprovalPort,
    approvalMode: "auto",
    mode: "code",
    logger: nullLogger,
    // A real allowlist, so a command that got through would really run.
    commands: [
      { kind: "acceptance", gate: "run", cmd: "node", args: ["-e", "console.log(1)"], timeoutMs: 5_000 },
    ],
  });
  return c;
}

function present(id: string, extra: Record<string, unknown> = {}): AgentCompletion {
  return completion({
    toolCalls: [
      call("record_request", id, {
        goal: "현재 작성된 코드를 보여주기",
        relation: "new_task",
        intents: "present",
        requirements: "작성된 소스 코드를 대화창에 표시",
        deliverables: "소스 코드",
        ...extra,
      }),
    ],
  });
}

describe("1/4/7 — a call that does not answer the request does not run", () => {
  test("adversarial: the model reaches for a command first, and nothing executes", async () => {
    // The test the previous slice was missing. It does not check that the model
    // chose well — it checks that choosing badly is survivable.
    const c = await counted();
    c.script([
      present("r1"),
      completion({ toolCalls: [call("run_command", "x1", { command: "python cnn_model.py" })] }),
      completion({ toolCalls: [call("run_command", "x2", { command: "python -c \"print('보여드립니다')\"" })] }),
      completion({ toolCalls: [call("read_file", "f1", { path: "cnn_model.py" })] }),
      completion({ text: "cnn_model.py 내용입니다:\n\n```python\nclass CNN\n```" }),
      completion({ text: "cnn_model.py 내용입니다." }),
    ]);
    await c.ask("현재 작성된 코드를 보여줘.");

    assert.equal(c.proposed.filter((n) => n === "run_command").length, 2, "the model proposed executing, twice");
    assert.equal(c.executed("run_command"), 0, "and nothing was executed");
    assert.equal(c.deferred(ACTION_REQUIRES_JUSTIFICATION), 2, "both were held back");
    assert.ok(c.executed("read_file") >= 1, "and it recovered by reading");

    const answer = c.events.filter((e) => e.type === "assistant_text").at(-1);
    assert.match(String(answer?.type === "assistant_text" ? answer.text : ""), /class CNN/);
  });

  test("the deferral says what to do instead, in machine-readable form", async () => {
    const c = await counted();
    c.script([
      present("r1"),
      completion({ toolCalls: [call("run_command", "x1", { command: "ls" })] }),
      completion({ text: "실행하지 않았습니다." }),
    ]);
    await c.ask("코드 보여줘.");

    const held = c.events.find(
      (e) => e.type === "tool_completed" && e.detail.includes(ACTION_REQUIRES_JUSTIFICATION),
    ) as Extract<SessionEvent, { type: "tool_completed" }> | undefined;
    assert.ok(held !== undefined);
    assert.match(held.detail, /^ACTION_REQUIRES_JUSTIFICATION/);
    assert.match(held.detail, /소스 코드/, "what the turn is supposed to deliver");
    assert.match(held.detail, /report_blocked/, "and the way out if it really cannot proceed");
  });

  test("3 — claiming necessity does not make it necessary", async () => {
    // A model that asserts the command is required gets the same answer. The
    // contract is what the user said; only a new contract changes it.
    const c = await counted();
    c.script([
      present("r1"),
      completion({
        text: "이 명령이 반드시 필요합니다.",
        toolCalls: [call("run_command", "x1", { command: "ls" })],
      }),
      completion({
        text: "정말로 필요합니다.",
        toolCalls: [call("run_command", "x2", { command: "ls -la" })],
      }),
      completion({ text: "실행하지 못했습니다." }),
    ]);
    await c.ask("코드 보여줘.");
    assert.equal(c.executed("run_command"), 0);
  });
});

describe("5 — a request that does ask for execution gets it", () => {
  test("present plus execute runs the command", async () => {
    // The check that this did not turn into a timid agent.
    const c = await counted();
    c.script([
      completion({
        toolCalls: [
          call("record_request", "r1", {
            goal: "코드와 실행 결과를 함께 보여주기",
            relation: "new_task",
            intents: "present\nexecute",
            requirements: "소스 코드 표시\n실행 결과 표시",
            deliverables: "소스 코드\n실행 결과",
          }),
        ],
      }),
      completion({ toolCalls: [call("run_command", "x1", { command: "node -e \"console.log(1)\"" })] }),
      completion({ text: "실행했습니다." }),
    ]);
    await c.ask("코드를 보여주고 실제 실행 결과도 보여줘.");

    assert.equal(c.deferred(ACTION_REQUIRES_JUSTIFICATION), 0, "nothing should have been held back");
    assert.equal(c.executed("run_command"), 1);
  });
});

describe("6 — an explicit prohibition cannot be justified past", () => {
  test("no_execute denies, and stays denied however often it is asked", async () => {
    const c = await counted();
    c.script([
      present("r1", { constraints: "no_execute: 실행하지 말고 코드만 보여줘" }),
      completion({ toolCalls: [call("run_command", "x1", { command: "ls" })] }),
      completion({
        text: "확인을 위해 꼭 필요합니다.",
        toolCalls: [call("run_command", "x2", { command: "pwd" })] ,
      }),
      completion({ text: "실행하지 않았습니다." }),
    ]);
    await c.ask("실행하지 말고 코드만 보여줘.");

    assert.equal(c.executed("run_command"), 0);
    assert.equal(c.deferred(ACTION_DENIED_BY_CONSTRAINT), 2);
    assert.equal(c.deferred(ACTION_REQUIRES_JUSTIFICATION), 0, "a constraint is a denial, not a deferral");
  });
});

describe("8 — the plan is task-affecting state and waits for the contract", () => {
  test("a plan proposed before the request has been read does not land", async () => {
    const c = await counted();
    c.script([
      completion({ toolCalls: [call("update_plan", "p1", { steps: "뭔가 한다", current: 1 })] }),
      present("r1"),
      completion({ toolCalls: [call("update_plan", "p2", { steps: "코드를 읽는다", current: 1 })] }),
      completion({ text: "끝." }),
    ]);
    await c.ask("코드 보여줘.");

    const plans = c.events.filter((e) => e.type === "plan");
    assert.equal(plans.length, 1, "only the plan made after the request was read");
    assert.equal(c.deferred(TURN_CONTRACT_REQUIRED), 1);
  });

  test("reading and searching are still open before it", async () => {
    // A model that cannot look at anything cannot work out what was asked for.
    const c = await counted();
    c.script([
      completion({ toolCalls: [call("read_file", "f1", { path: "cnn_model.py" })] }),
      present("r1"),
      completion({ text: "봤습니다." }),
    ]);
    await c.ask("코드 보여줘.");
    assert.equal(c.executed("read_file"), 1);
    assert.equal(c.deferred(TURN_CONTRACT_REQUIRED), 0);
  });
});

describe("2 — the decision itself", () => {
  function contractFor(args: Record<string, unknown>): ReturnType<typeof reduceContract> {
    const parsed = parseTurnContract({ goal: "g", relation: "new_task", ...args }, "t1");
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.problem.reason);
    if (!parsed.ok) throw new Error("unreachable");
    return reduceContract([
      { type: "turn_contract", id: "e1", turnId: "t1", at: 1, contract: parsed.contract } as SessionEvent,
    ]);
  }

  test("three outcomes, and only one of them runs anything", () => {
    const presentOnly = contractFor({ intents: "present", requirements: "x" });
    assert.equal(decideAction(presentOnly, "read_file", "t1").decision, "allow");
    assert.equal(decideAction(presentOnly, "run_command", "t1").decision, "requires_justification");

    const forbidden = contractFor({ intents: "present", requirements: "x", constraints: "no_execute: 실행 금지" });
    assert.equal(decideAction(forbidden, "run_command", "t1").decision, "deny");
  });

  test("a turn nobody has read denies substantive calls and allows reading", () => {
    const none = reduceContract([]);
    assert.equal(decideAction(none, "run_command", "t9").code, TURN_CONTRACT_REQUIRED);
    assert.equal(decideAction(none, "update_plan", "t9").code, TURN_CONTRACT_REQUIRED);
    assert.equal(decideAction(none, "read_file", "t9").decision, "allow");
    assert.equal(decideAction(none, "record_request", "t9").decision, "allow");
    assert.equal(decideAction(none, "report_blocked", "t9").decision, "allow");
  });

  test("a contract from an earlier turn does not cover this one", () => {
    const earlier = contractFor({ intents: "execute", requirements: "x" });
    assert.equal(decideAction(earlier, "run_command", "t1").decision, "allow");
    assert.equal(decideAction(earlier, "run_command", "t2").code, TURN_CONTRACT_REQUIRED);
  });
});
