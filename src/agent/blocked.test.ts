import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { AgentSession } from "./session.ts";
import { allowingApprovalPort } from "./approval.ts";
import { nullLogger } from "../hasa-client/logger.ts";
import { createRepoFixture, type RepoFixture } from "../testing/repo-fixture.ts";
import { createBlockedTool, describeBlocked } from "./tools/blockedTool.ts";
import { terminationView } from "./sessionView.ts";
import { turnStateFor } from "./conversationGraph.ts";
import { MODE_DEFINITIONS } from "./modes.ts";
import type { AgentCompletion, AgentEvent, AgentModel } from "./types.ts";
import type { NormalizedToolCall } from "../provider/types.ts";

/**
 * Being unable to do something is an outcome the agent can express.
 *
 * It could not, and the consequence was reported by a user. Asked to download a
 * real dataset and evaluate a classifier on it, the agent hit a load error,
 * substituted twenty synthetic samples without saying so, reported "Accuracy:
 * 0.8000" from a head the load report had already said was randomly
 * reinitialised, and finished with "실제 데이터셋을 다운받아 테스트하는 방식으로
 * 진행했습니다" in the same message that admitted it had not.
 *
 * A prompt alone cannot fix that. Every turn ended `finished`, which the panel
 * draws the same way whether the work happened or not, so "I am blocked" and "it
 * worked" were the same shape on screen. What is tested here is the ending that
 * was missing: it exists, it stops the turn, and it does not read as success.
 */

const fixtures: RepoFixture[] = [];
after(async () => {
  for (const f of fixtures) await f.dispose().catch(() => {});
});

function completion(overrides: Partial<AgentCompletion> = {}): AgentCompletion {
  return { text: "", reasoning: "", toolCalls: [], inputTokens: 1, outputTokens: 1, ...overrides };
}

function call(name: string, id: string, args: Record<string, unknown>): NormalizedToolCall {
  return { id, name, arguments: args, rawArguments: JSON.stringify(args), argumentsValid: true };
}

const BLOCKED_ARGS = {
  goal: "실제 CIFAR-10 데이터셋을 내려받아 평가",
  obstacle: "load_dataset('cifar10') raised: Couldn't find a dataset script at /cifar10/cifar10.py",
  tried: "datasets.load_dataset('cifar10')\nhuggingface_hub.snapshot_download('cifar10')",
  needed: "HF_TOKEN, 또는 데이터셋을 직접 내려받아 ./data 에 두기",
};

async function sessionWith(script: AgentCompletion[]): Promise<{
  session: AgentSession;
  events: AgentEvent[];
}> {
  const fixture = await createRepoFixture({ "a.ts": "export const a = 1;\n" });
  fixtures.push(fixture);
  let index = 0;
  const model: AgentModel = {
    modelId: "test",
    async complete() {
      return script[index++] ?? completion({ text: "기본" });
    },
  };
  const events: AgentEvent[] = [];
  const session = await AgentSession.open({
    workspaceRoot: fixture.root,
    model,
    approvalPort: allowingApprovalPort,
    approvalMode: "auto",
    mode: "code",
    logger: nullLogger,
    onEvent: (event) => events.push(event),
  });
  return { session, events };
}

const never = new AbortController().signal;

describe("the turn can end by saying it could not be done", () => {
  test("reporting blocked stops the turn", async () => {
    // The model would keep going — the script has three more completions after
    // the report, and none of them must be reached.
    const { session } = await sessionWith([
      completion({ toolCalls: [call("report_blocked", "b1", BLOCKED_ARGS)] }),
      completion({ text: "그럼 샘플 데이터로 대신 해보겠습니다." }),
      completion({ text: "Accuracy: 0.8000" }),
    ]);

    const result = await session.send("실제 데이터셋 받아서 평가해줘", never);
    assert.equal(result.reason, "blocked");

    // The system message is excluded, and not incidentally: the prompt quotes
    // "Accuracy: 0.8000" as the example of what not to do, so a search over the
    // whole history matches the rule instead of a violation of it.
    const conversation = JSON.stringify([...session.history()].filter((m) => m.role !== "system"));
    assert.ok(!conversation.includes("0.8000"), "the turn continued past the report");
    assert.ok(!conversation.includes("샘플 데이터로 대신"), "the turn went on to substitute");
  });

  test("and does not read as success", async () => {
    // The whole point. A blocked turn that renders like a finished one is the
    // situation this replaces.
    const view = terminationView("blocked");
    assert.equal(view.tone, "warning");
    assert.notEqual(view.tone, "ok");
    assert.notEqual(terminationView("finished").label, view.label);
  });

  test("and is not recorded as a completed turn", () => {
    assert.equal(turnStateFor("blocked"), "aborted");
    assert.notEqual(turnStateFor("blocked"), "completed");
  });

  test("the report reaches the session, with the error in it", async () => {
    const { session } = await sessionWith([
      completion({ toolCalls: [call("report_blocked", "b1", BLOCKED_ARGS)] }),
    ]);
    await session.send("실제 데이터셋 받아서 평가해줘", never);

    const report = session.takeBlockedReport();
    assert.ok(report !== null);
    assert.equal(report.goal, BLOCKED_ARGS.goal);
    assert.match(report.obstacle, /Couldn't find a dataset script/, "the actual error, not a paraphrase");
    assert.match(report.tried, /snapshot_download/);
    assert.equal(report.needed, BLOCKED_ARGS.needed);

    // Taken once. A stale report attributed to a later turn would be a claim
    // about work that turn did not do.
    assert.equal(session.takeBlockedReport(), null);
  });

  test("the user is shown the obstacle, not just that there was one", async () => {
    const { session, events } = await sessionWith([
      completion({ toolCalls: [call("report_blocked", "b1", BLOCKED_ARGS)] }),
    ]);
    await session.send("해줘", never);

    const end = events.find((e) => e.type === "tool_end" && e.name === "report_blocked");
    assert.ok(end !== undefined && end.type === "tool_end");
    assert.match(String(end.output), /Couldn't find a dataset script/);
    assert.match(String(end.output), /시도한 것/);
  });
});

describe("the report has to carry specifics", () => {
  const tool = createBlockedTool({ onBlocked: () => {} });

  test("an empty obstacle is refused", async () => {
    const result = await tool.execute({ goal: "평가", obstacle: "  ", tried: "" }, undefined as never);
    assert.equal(result.ok, false);
    assert.notEqual(result.blocked, true, "a refused report must not end the turn");
  });

  test("an empty goal is refused", async () => {
    const result = await tool.execute({ goal: "", obstacle: "네트워크 오류", tried: "" }, undefined as never);
    assert.equal(result.ok, false);
  });

  test("a complete report ends the turn", async () => {
    const result = await tool.execute(BLOCKED_ARGS, undefined as never);
    assert.equal(result.ok, true);
    assert.equal(result.blocked, true);
  });

  test("what the user reads names the goal, the error and what was tried", () => {
    const text = describeBlocked({
      goal: "실제 데이터셋 평가",
      obstacle: "404 Not Found",
      tried: "load_dataset\nsnapshot_download",
      needed: "HF_TOKEN",
    });
    assert.match(text, /실제 데이터셋 평가/);
    assert.match(text, /404 Not Found/);
    assert.match(text, /snapshot_download/);
    assert.match(text, /HF_TOKEN/);
  });
});

describe("every mode can say it is blocked", () => {
  test("including the read-only ones", async () => {
    // ARCHITECT asked to plan against a file that is not there is blocked in
    // exactly the same way, and the alternative is a plan for a file it imagined.
    for (const mode of ["code", "architect", "debug", "ask"] as const) {
      const fixture = await createRepoFixture({ "a.ts": "export const a = 1;\n" });
      fixtures.push(fixture);
      const model: AgentModel = {
        modelId: "test",
        async complete() {
          return completion({ toolCalls: [call("report_blocked", "b1", BLOCKED_ARGS)] });
        },
      };
      const session = await AgentSession.open({
        workspaceRoot: fixture.root,
        model,
        approvalPort: allowingApprovalPort,
        approvalMode: "auto",
        mode,
        logger: nullLogger,
      });
      const result = await session.send("해줘", never);
      assert.equal(result.reason, "blocked", `${mode} cannot report being blocked`);
    }
  });
});

describe("the prompt names the failure it is preventing", () => {
  test("substitution is forbidden in every mode", () => {
    // The structural half is above; this is the half that tells the model the
    // ending exists. Asserted because a prompt edit that drops it would leave
    // the tool present and unused.
    for (const [mode, definition] of Object.entries(MODE_DEFINITIONS)) {
      assert.match(definition.systemPrompt, /report_blocked/, `${mode} does not mention the tool`);
      assert.match(
        definition.systemPrompt,
        /Do what was asked, or say you could not/,
        `${mode} does not state the rule`,
      );
    }
  });
});
