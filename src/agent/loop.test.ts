import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SandboxViolation } from "../core/sandbox.ts";
import type { NormalizedToolCall, ProviderMessage } from "../provider/types.ts";
import { ApprovalManager, allowingApprovalPort, denyingApprovalPort, recordingApprovalPort } from "./approval.ts";
import { AgentLoop } from "./loop.ts";
import { ToolRegistry } from "./tools/registry.ts";
import type {
  AgentCompletion,
  AgentEvent,
  AgentModel,
  AgentTool,
  ApprovalPort,
  ToolResult,
  ToolRisk,
} from "./types.ts";

/**
 * The loop, driven by a scripted model.
 *
 * No HTTP and no provider: `AgentModel` knows one verb, which is exactly so a
 * test can hand the loop a list of turns and assert on what it did with them.
 */

function call(name: string, args: Record<string, unknown>, id = `call_${name}`): NormalizedToolCall {
  const raw = JSON.stringify(args);
  return { id, name, arguments: args, rawArguments: raw, argumentsValid: true };
}

function turn(overrides: Partial<AgentCompletion> = {}): AgentCompletion {
  return { text: "", reasoning: "", toolCalls: [], inputTokens: 3, outputTokens: 5, ...overrides };
}

/** A model that replays a script, then repeats its last turn forever. */
function scripted(script: AgentCompletion[]): AgentModel & { calls: number } {
  const model = {
    modelId: "test-model",
    calls: 0,
    async complete(): Promise<AgentCompletion> {
      const step = script[model.calls] ?? script.at(-1) ?? turn({ text: "done" });
      model.calls += 1;
      return step;
    },
  };
  return model;
}

interface FakeToolOptions {
  name?: string;
  risk?: ToolRisk;
  result?: ToolResult;
  throws?: unknown;
  preview?: string | null;
  onExecute?: () => void;
}

function fakeTool(opts: FakeToolOptions = {}): AgentTool & { executions: number } {
  const tool = {
    name: opts.name ?? "do_thing",
    risk: opts.risk ?? "read",
    description: "does a thing",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    executions: 0,
    summarize: () => "무언가를 합니다",
    ...(opts.preview === undefined
      ? {}
      : { preview: async (): Promise<string | null> => opts.preview ?? null }),
    async execute(): Promise<ToolResult> {
      tool.executions += 1;
      opts.onExecute?.();
      if (opts.throws !== undefined) throw opts.throws;
      return opts.result ?? { ok: true, content: "did the thing" };
    },
  };
  return tool as AgentTool & { executions: number };
}

interface Harness {
  loop: AgentLoop;
  events: AgentEvent[];
  messages: ProviderMessage[];
}

function harness(opts: {
  model: AgentModel;
  tools?: AgentTool[];
  port?: ApprovalPort;
  approvalMode?: "safe" | "balanced" | "auto";
  budget?: Partial<ConstructorParameters<typeof AgentLoop>[0]["budget"]>;
  now?: () => number;
  checkpoints?: ConstructorParameters<typeof AgentLoop>[0]["checkpoints"];
}): Harness {
  const events: AgentEvent[] = [];
  const messages: ProviderMessage[] = [{ role: "system", content: "be useful" }];
  const loop = new AgentLoop({
    model: opts.model,
    tools: new ToolRegistry(opts.tools ?? []),
    approvals: new ApprovalManager({
      mode: opts.approvalMode ?? "auto",
      port: opts.port ?? allowingApprovalPort,
    }),
    checkpoints: opts.checkpoints ?? null,
    workspaceRoot: "/workspace",
    systemPrompt: "be useful",
    ...(opts.budget ? { budget: opts.budget as never } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    onEvent: (e) => events.push(e),
  });
  return { loop, events, messages };
}

const never = new AbortController().signal;

describe("finishing", () => {
  test("prose with no tool calls is the answer", async () => {
    const h = harness({ model: scripted([turn({ text: "The bug is in src/auth.ts." })]) });
    const result = await h.loop.run(h.messages, never);

    assert.equal(result.reason, "finished");
    assert.equal(result.summary, "The bug is in src/auth.ts.");
    assert.equal(result.modelCalls, 1);
  });

  test("a tool round trip then an answer", async () => {
    const tool = fakeTool({ result: { ok: true, content: "file contents" } });
    const h = harness({
      model: scripted([turn({ toolCalls: [call("do_thing", {})] }), turn({ text: "Done." })]),
      tools: [tool],
    });
    const result = await h.loop.run(h.messages, never);

    assert.equal(result.reason, "finished");
    assert.equal(tool.executions, 1);
    assert.equal(result.toolCalls, 1);
    // The transcript has to carry the assistant turn and its tool result, or
    // the next turn re-asks for what it already knows.
    const roles = h.messages.map((m) => m.role);
    assert.deepEqual(roles, ["system", "user"].slice(0, 1).concat(["assistant", "tool"]));
  });

  test("token usage is accumulated across turns", async () => {
    const h = harness({
      model: scripted([turn({ toolCalls: [call("do_thing", {})] }), turn({ text: "ok" })]),
      tools: [fakeTool()],
    });
    const result = await h.loop.run(h.messages, never);
    assert.equal(result.inputTokens, 6);
    assert.equal(result.outputTokens, 10);
  });

  test("changed files are collected and reported once, sorted", async () => {
    const h = harness({
      model: scripted([
        turn({ toolCalls: [call("w", {}, "a"), call("w", { n: 2 }, "b")] }),
        turn({ text: "ok" }),
      ]),
      tools: [
        fakeTool({
          name: "w",
          risk: "write",
          result: { ok: true, content: "wrote", changedFiles: ["src/b.ts", "src/a.ts"] },
        }),
      ],
    });
    const result = await h.loop.run(h.messages, never);
    assert.deepEqual(result.changedFiles, ["src/a.ts", "src/b.ts"]);
    assert.equal(h.events.filter((e) => e.type === "changed").length, 1);
  });
});

describe("budgets", () => {
  test("maxSteps ends a model that never stops calling tools", async () => {
    const h = harness({
      model: scripted([turn({ toolCalls: [call("do_thing", { n: Math.random() })] })]),
      tools: [fakeTool()],
      budget: { maxSteps: 3, maxRepeatedCalls: 99 },
    });
    const result = await h.loop.run(h.messages, never);
    assert.equal(result.reason, "max_steps");
    assert.equal(result.steps, 3);
  });

  test("maxModelCalls is counted separately from steps", async () => {
    const h = harness({
      model: scripted([turn({ toolCalls: [call("do_thing", {})] })]),
      tools: [fakeTool()],
      budget: { maxModelCalls: 2, maxSteps: 99, maxRepeatedCalls: 99 },
    });
    const result = await h.loop.run(h.messages, never);
    assert.equal(result.reason, "max_model_calls");
    assert.equal(result.modelCalls, 2);
  });

  test("maxToolCalls bounds a turn that requests many at once", async () => {
    const many = Array.from({ length: 10 }, (_, i) => call("do_thing", { i }, `c${i}`));
    const h = harness({
      model: scripted([turn({ toolCalls: many })]),
      tools: [fakeTool()],
      budget: { maxToolCalls: 4, maxRepeatedCalls: 99 },
    });
    const result = await h.loop.run(h.messages, never);
    assert.equal(result.reason, "max_tool_calls");
    assert.equal(result.toolCalls, 4);
  });

  test("the deadline ends the turn without waiting for the model", async () => {
    let clock = 0;
    const h = harness({
      model: scripted([turn({ toolCalls: [call("do_thing", { n: 1 })] })]),
      tools: [fakeTool({ onExecute: () => { clock += 1_000; } })],
      budget: { timeoutMs: 2_500, maxRepeatedCalls: 99 },
      now: () => clock,
    });
    const result = await h.loop.run(h.messages, never);
    assert.equal(result.reason, "timeout");
  });

  test("every budget is reported in the result", async () => {
    const h = harness({
      model: scripted([turn({ toolCalls: [call("do_thing", {})] }), turn({ text: "ok" })]),
      tools: [fakeTool()],
    });
    const result = await h.loop.run(h.messages, never);
    assert.equal(result.steps, 2);
    assert.equal(result.modelCalls, 2);
    assert.equal(result.toolCalls, 1);
  });
});

describe("loop detection", () => {
  test("the same call with the same arguments ends the turn", async () => {
    // Not a budget: the model is not making progress, and another round would
    // produce the same answer it already has.
    const h = harness({
      model: scripted([turn({ toolCalls: [call("do_thing", { path: "a.ts" })] })]),
      tools: [fakeTool()],
      budget: { maxRepeatedCalls: 2, maxSteps: 50 },
    });
    const result = await h.loop.run(h.messages, never);
    assert.equal(result.reason, "loop_detected");
    assert.ok(result.steps < 50, "it must stop well before the step budget");
  });

  test("different arguments are not a loop", async () => {
    const script = Array.from({ length: 5 }, (_, i) => turn({ toolCalls: [call("do_thing", { i })] }));
    script.push(turn({ text: "ok" }));
    const h = harness({
      model: scripted(script),
      tools: [fakeTool()],
      budget: { maxRepeatedCalls: 2 },
    });
    const result = await h.loop.run(h.messages, never);
    assert.equal(result.reason, "finished");
  });

  test("a couple of repeats are ordinary work, not a loop", async () => {
    // Reading a file again after editing it repeats the request and not the
    // answer.
    const h = harness({
      model: scripted([
        turn({ toolCalls: [call("a", {})] }),
        turn({ toolCalls: [call("b", {})] }),
        turn({ toolCalls: [call("a", {})] }),
        turn({ text: "ok" }),
      ]),
      tools: [fakeTool({ name: "a" }), fakeTool({ name: "b" })],
      budget: { maxRepeatedCalls: 3 },
    });
    assert.equal((await h.loop.run(h.messages, never)).reason, "finished");
  });

  test("an A-B-A-B cycle is caught, though no call repeats consecutively", async () => {
    // The loop that actually happened. A model wrote a file, asked for a diff,
    // wrote the same file, asked again — each call different from the one
    // before it — until the step budget ran out. A consecutive counter resets
    // on every alternation and never fires.
    const h = harness({
      model: scripted([
        turn({ toolCalls: [call("write", {})] }),
        turn({ toolCalls: [call("diff", {})] }),
        turn({ toolCalls: [call("write", {})] }),
        turn({ toolCalls: [call("diff", {})] }),
        turn({ toolCalls: [call("write", {})] }),
        turn({ toolCalls: [call("diff", {})] }),
        turn({ toolCalls: [call("write", {})] }),
        turn({ toolCalls: [call("diff", {})] }),
      ]),
      tools: [fakeTool({ name: "write", risk: "write" }), fakeTool({ name: "diff", result: { ok: false, content: "not a repository" } })],
      budget: { maxRepeatedCalls: 2, maxSteps: 40 },
    });
    const result = await h.loop.run(h.messages, never);

    assert.equal(result.reason, "loop_detected");
    assert.ok(result.steps < 8, `stopped after ${result.steps} steps, not at the budget`);
  });

  test("the user is not asked to approve the same write over and over", async () => {
    // What the cycle looked like from the outside: the same approval modal,
    // again and again, for a file whose contents had not changed.
    const { port, requests } = recordingApprovalPort(() => true);
    const h = harness({
      model: scripted([
        turn({ toolCalls: [call("write", { path: "a.ts" })] }),
        turn({ toolCalls: [call("diff", {})] }),
        turn({ toolCalls: [call("write", { path: "a.ts" })] }),
        turn({ toolCalls: [call("diff", {})] }),
        turn({ toolCalls: [call("write", { path: "a.ts" })] }),
        turn({ toolCalls: [call("diff", {})] }),
        turn({ toolCalls: [call("write", { path: "a.ts" })] }),
      ]),
      tools: [fakeTool({ name: "write", risk: "write" }), fakeTool({ name: "diff" })],
      approvalMode: "safe",
      port,
      budget: { maxRepeatedCalls: 2, maxSteps: 40 },
    });
    await h.loop.run(h.messages, never);
    assert.ok(requests.length <= 3, `the user was asked ${requests.length} times`);
  });

  test("the model is told why it was stopped", async () => {
    const h = harness({
      model: scripted([turn({ toolCalls: [call("do_thing", {})] })]),
      tools: [fakeTool()],
      budget: { maxRepeatedCalls: 1 },
    });
    await h.loop.run(h.messages, never);
    const last = h.messages.at(-1);
    assert.equal(last?.role, "tool");
    assert.match(String(last?.content), /already made this exact request/);
  });
});

describe("approval", () => {
  test("a denied action ends the turn", async () => {
    const h = harness({
      model: scripted([turn({ toolCalls: [call("w", {})] })]),
      tools: [fakeTool({ name: "w", risk: "write" })],
      approvalMode: "safe",
      port: denyingApprovalPort,
    });
    const result = await h.loop.run(h.messages, never);

    assert.equal(result.reason, "denied");
    assert.match(result.summary, /중단/);
  });

  test("a denied action never runs", async () => {
    const tool = fakeTool({ name: "w", risk: "write" });
    const h = harness({
      model: scripted([turn({ toolCalls: [call("w", {})] })]),
      tools: [tool],
      approvalMode: "safe",
      port: denyingApprovalPort,
    });
    await h.loop.run(h.messages, never);
    assert.equal(tool.executions, 0);
  });

  test("the preview is built before the question and passed with it", async () => {
    const { port, requests } = recordingApprovalPort(() => true);
    const h = harness({
      model: scripted([turn({ toolCalls: [call("w", {})] }), turn({ text: "ok" })]),
      tools: [fakeTool({ name: "w", risk: "write", preview: "- old\n+ new" })],
      approvalMode: "safe",
      port,
    });
    await h.loop.run(h.messages, never);
    assert.equal(requests[0]?.preview, "- old\n+ new");
  });

  test("an auto-approved tool does not pay for a preview", async () => {
    // The preview exists to be shown. Building one nobody sees is work done for
    // nothing, and for a large file it is not free.
    let previews = 0;
    const tool = fakeTool({ name: "w", risk: "write" });
    const withPreview: AgentTool = {
      ...tool,
      preview: async () => {
        previews += 1;
        return "diff";
      },
    };
    const h = harness({
      model: scripted([turn({ toolCalls: [call("w", {})] }), turn({ text: "ok" })]),
      tools: [withPreview],
      approvalMode: "auto",
    });
    await h.loop.run(h.messages, never);
    assert.equal(previews, 0);
  });

  test("a preview that throws does not skip the question", async () => {
    const { port, requests } = recordingApprovalPort(() => true);
    const failing: AgentTool = {
      ...fakeTool({ name: "w", risk: "write" }),
      preview: async () => {
        throw new Error("could not read the file");
      },
    };
    const h = harness({
      model: scripted([turn({ toolCalls: [call("w", {})] }), turn({ text: "ok" })]),
      tools: [failing],
      approvalMode: "safe",
      port,
    });
    await h.loop.run(h.messages, never);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.preview, null);
  });

  test("the approval outcome is emitted for the transcript", async () => {
    const h = harness({
      model: scripted([turn({ toolCalls: [call("w", {})] }), turn({ text: "ok" })]),
      tools: [fakeTool({ name: "w", risk: "write" })],
      approvalMode: "safe",
      port: allowingApprovalPort,
    });
    await h.loop.run(h.messages, never);
    const approval = h.events.find((e) => e.type === "tool_approval");
    assert.deepEqual(approval, { type: "tool_approval", callId: "call_w", name: "w", outcome: "granted" });
  });
});

describe("refusals are results, not exceptions", () => {
  test("an unknown tool is answered, and the real ones are named", async () => {
    const h = harness({
      model: scripted([turn({ toolCalls: [call("write_everywhere", {})] }), turn({ text: "ok" })]),
      tools: [fakeTool({ name: "read_file" })],
    });
    const result = await h.loop.run(h.messages, never);

    assert.equal(result.reason, "finished");
    const answer = h.messages.find((m) => m.role === "tool");
    assert.match(String(answer?.content), /no tool called "write_everywhere"/);
    assert.match(String(answer?.content), /read_file/);
  });

  test("a sandbox violation is handed back so the model can try a legal path", async () => {
    const h = harness({
      model: scripted([
        turn({ toolCalls: [call("do_thing", {})] }),
        turn({ text: "I will stay inside the workspace." }),
      ]),
      tools: [fakeTool({ throws: new SandboxViolation("escape", "../../etc/passwd", "outside the workspace") })],
    });
    const result = await h.loop.run(h.messages, never);

    assert.equal(result.reason, "finished");
    assert.match(String(h.messages.find((m) => m.role === "tool")?.content), /refused: sandbox violation/);
  });

  test("malformed arguments are answered with the raw text", async () => {
    const broken: NormalizedToolCall = {
      id: "c1",
      name: "do_thing",
      arguments: {},
      rawArguments: '{"path": ',
      argumentsValid: false,
    };
    const tool = fakeTool();
    const h = harness({
      model: scripted([turn({ toolCalls: [broken] }), turn({ text: "ok" })]),
      tools: [tool],
    });
    await h.loop.run(h.messages, never);

    assert.equal(tool.executions, 0);
    assert.match(String(h.messages.find((m) => m.role === "tool")?.content), /not a JSON object/);
  });

  test("a tool that throws an ordinary error does not end the turn", async () => {
    const h = harness({
      model: scripted([turn({ toolCalls: [call("do_thing", {})] }), turn({ text: "recovered" })]),
      tools: [fakeTool({ throws: new Error("disk on fire") })],
    });
    const result = await h.loop.run(h.messages, never);
    assert.equal(result.reason, "finished");
    assert.equal(result.summary, "recovered");
  });

  test("a summariser that throws does not take the turn down", async () => {
    const hostile: AgentTool = {
      ...fakeTool({ name: "w", risk: "write" }),
      summarize: () => {
        throw new Error("bad summariser");
      },
    };
    const { port, requests } = recordingApprovalPort(() => true);
    const h = harness({
      model: scripted([turn({ toolCalls: [call("w", {})] }), turn({ text: "ok" })]),
      tools: [hostile],
      approvalMode: "safe",
      port,
    });
    const result = await h.loop.run(h.messages, never);
    assert.equal(result.reason, "finished");
    assert.ok((requests[0]?.summary.length ?? 0) > 0, "the user still gets something to read");
  });
});

describe("cancellation", () => {
  test("an already-aborted signal stops before the first model call", async () => {
    const model = scripted([turn({ text: "should not happen" })]);
    const controller = new AbortController();
    controller.abort();
    const h = harness({ model });

    const result = await h.loop.run(h.messages, controller.signal);
    assert.equal(result.reason, "aborted");
    assert.equal(model.calls, 0);
  });

  test("aborting mid-turn stops the loop", async () => {
    const controller = new AbortController();
    const h = harness({
      model: scripted([turn({ toolCalls: [call("do_thing", { n: 1 })] })]),
      tools: [fakeTool({ onExecute: () => controller.abort() })],
      budget: { maxRepeatedCalls: 99 },
    });
    const result = await h.loop.run(h.messages, controller.signal);
    assert.equal(result.reason, "aborted");
  });
});

describe("checkpoints", () => {
  function recordingCheckpoints(): {
    manager: ConstructorParameters<typeof AgentLoop>[0]["checkpoints"];
    ensures: number;
  } {
    const state = { ensures: 0 };
    const manager = {
      ensures: 0,
      current: null,
      async ensure() {
        state.ensures += 1;
        return { ref: "stash@{0}", baseCommit: "abc", takenAt: "now", detail: "보관했습니다" };
      },
    };
    return { manager: manager as never, get ensures() { return state.ensures; } };
  }

  test("a read-only turn takes no checkpoint", async () => {
    const cp = recordingCheckpoints();
    const h = harness({
      model: scripted([turn({ toolCalls: [call("r", {})] }), turn({ text: "ok" })]),
      tools: [fakeTool({ name: "r", risk: "read" })],
      checkpoints: cp.manager,
    });
    await h.loop.run(h.messages, never);
    assert.equal(cp.ensures, 0, "reading changes nothing, so there is nothing to protect");
  });

  test("the checkpoint is taken before the write, not after", async () => {
    let order: string[] = [];
    const manager = {
      current: null,
      async ensure() {
        order.push("checkpoint");
        return { ref: "stash@{0}", baseCommit: "abc", takenAt: "now", detail: "d" };
      },
    };
    const h = harness({
      model: scripted([turn({ toolCalls: [call("w", {})] }), turn({ text: "ok" })]),
      tools: [fakeTool({ name: "w", risk: "write", onExecute: () => order.push("write") })],
      checkpoints: manager as never,
    });
    await h.loop.run(h.messages, never);
    assert.deepEqual(order, ["checkpoint", "write"]);
  });

  test("a denied write takes no checkpoint", async () => {
    const cp = recordingCheckpoints();
    const h = harness({
      model: scripted([turn({ toolCalls: [call("w", {})] })]),
      tools: [fakeTool({ name: "w", risk: "write" })],
      approvalMode: "safe",
      port: denyingApprovalPort,
      checkpoints: cp.manager,
    });
    await h.loop.run(h.messages, never);
    assert.equal(cp.ensures, 0, "nothing was written, so nothing needed protecting");
  });
});

describe("events", () => {
  test("done is emitted exactly once, last", async () => {
    const h = harness({
      model: scripted([turn({ toolCalls: [call("do_thing", {})] }), turn({ text: "ok" })]),
      tools: [fakeTool()],
    });
    await h.loop.run(h.messages, never);

    assert.equal(h.events.filter((e) => e.type === "done").length, 1);
    assert.equal(h.events.at(-1)?.type, "done");
  });

  test("a tool_start is always followed by a tool_end for the same call", async () => {
    const h = harness({
      model: scripted([turn({ toolCalls: [call("do_thing", {})] }), turn({ text: "ok" })]),
      tools: [fakeTool({ throws: new Error("boom") })],
    });
    await h.loop.run(h.messages, never);

    const starts = h.events.filter((e) => e.type === "tool_start");
    const ends = h.events.filter((e) => e.type === "tool_end");
    assert.equal(starts.length, ends.length);
  });

  test("no event carries the whole tool output", async () => {
    // Events go to a webview. A 200-character detail is a status line; a whole
    // file is a payload nobody asked to render.
    const h = harness({
      model: scripted([turn({ toolCalls: [call("do_thing", {})] }), turn({ text: "ok" })]),
      tools: [fakeTool({ result: { ok: true, content: "x".repeat(10_000) } })],
    });
    await h.loop.run(h.messages, never);
    const end = h.events.find((e) => e.type === "tool_end") as { detail: string };
    assert.ok(end.detail.length <= 200);
  });
});
