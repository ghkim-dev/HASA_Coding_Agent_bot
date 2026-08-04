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

/**
 * A turn that promised work and did none.
 *
 * From a transcript: "이제 코드를 실행해보겠습니다." — and then nothing. The loop
 * treated the announcement as the answer and ended the turn, so the user asked
 * again, got the same sentence, and asked a third time. Nothing ever ran.
 */
describe("announcing work without doing it", () => {
  test("the turn continues instead of ending on a promise", async () => {
    const tool = fakeTool({ name: "run_command" });
    const h = harness({
      model: scripted([
        turn({ text: "이제 코드를 실행해보겠습니다." }),
        turn({ toolCalls: [{ id: "c1", name: "run_command", arguments: {}, rawArguments: "{}", argumentsValid: true }] }),
        turn({ text: "실행했고 통과했습니다." }),
      ]),
      tools: [tool],
    });

    const result = await h.loop.run(h.messages, never);
    assert.equal(result.reason, "finished");
    assert.equal(tool.executions, 1, "the promised work should actually happen");
    assert.match(result.summary, /통과/);
  });

  test("the model is told what went wrong, in a message it can act on", async () => {
    const h = harness({ model: scripted([turn({ text: "파일을 수정하겠습니다." }), turn({ text: "수정했습니다." })]) });
    await h.loop.run(h.messages, never);

    const nudge = h.messages.find((m) => m.role === "user" && String(m.content).includes("no tool was called"));
    assert.ok(nudge !== undefined, "the model should be told its announcement did nothing");
    assert.match(String(nudge.content), /If you were actually finished/i, "and allowed to say it was done");
  });

  test("asked once, never twice", async () => {
    // A model that keeps promising is not argued with. Two identical nudges
    // would be a loop the user watches without being able to stop.
    const model = scripted([turn({ text: "실행해보겠습니다." })]);
    const h = harness({ model });
    const result = await h.loop.run(h.messages, never);

    assert.equal(result.reason, "finished");
    assert.equal(model.calls, 2, "one nudge, then the turn ends whatever it says");
  });

  test("a turn that already did work is never nudged", async () => {
    // The structural half of the check. Promising more after doing something is
    // an ordinary turn in progress.
    const tool = fakeTool({ name: "read_file" });
    const model = scripted([
      turn({ toolCalls: [{ id: "c1", name: "read_file", arguments: {}, rawArguments: "{}", argumentsValid: true }] }),
      turn({ text: "이제 수정하겠습니다." }),
    ]);
    const h = harness({ model, tools: [tool] });
    await h.loop.run(h.messages, never);

    assert.equal(model.calls, 2, "no third call: the turn ended on its own terms");
  });

  test("an ordinary answer is not interrupted", async () => {
    const model = scripted([turn({ text: "이 파일은 사용자 인증을 담당합니다." })]);
    const h = harness({ model });
    const result = await h.loop.run(h.messages, never);

    assert.equal(model.calls, 1);
    assert.equal(result.summary, "이 파일은 사용자 인증을 담당합니다.");
  });
});

/**
 * A model call that does not come back.
 *
 * The deadline was checked at the top of each iteration and then not enforced
 * during the one thing that takes time, so a call that never returned outlived
 * the budget indefinitely — the loop was parked inside `await` with nothing left
 * to notice. Reported as a turn that sat on "생각하는 중 · 369초" with no way to
 * tell a slow model from a dead request.
 */
describe("a turn that outlives its budget", () => {
  test("a hung model call is cut off at the deadline, not waited on", async () => {
    let aborted = false;
    const hung: AgentModel = {
      modelId: "hung",
      complete(_req, signal) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        });
      },
    };

    let clock = 0;
    const h = harness({ model: hung, budget: { timeoutMs: 50 }, now: () => clock });
    // The clock only moves when asked, so the deadline is reached by the timer
    // rather than by the test racing it.
    const running = h.loop.run(h.messages, never);
    await new Promise((r) => setTimeout(r, 80));
    clock = 1_000;

    const result = await running;
    assert.equal(aborted, true, "the model call should have been aborted");
    assert.equal(result.reason, "timeout");
  });

  test("a call that finishes inside the deadline is untouched", async () => {
    const h = harness({ model: scripted([turn({ text: "빠르게 답했습니다." })]), budget: { timeoutMs: 60_000 } });
    const result = await h.loop.run(h.messages, never);
    assert.equal(result.reason, "finished");
    assert.equal(result.summary, "빠르게 답했습니다.");
  });
});

/**
 * Output the user can check.
 *
 * Reported from a screenshot: three ticks, a paragraph of the model's prose
 * about what the command printed, and no way to verify any of it. `tool_end`
 * carried 200 characters of status and the panel used none of them.
 *
 * The rule that produced that — a progress line per tool, not a transcript — is
 * still right for reading a file. It is wrong for a command, where the output
 * *is* the answer. So a tool opts in, and almost none do.
 */
describe("showing what a tool actually produced", () => {
  test("a tool that opts in has its output carried to the panel", async () => {
    const tool = fakeTool({ result: { ok: true, content: "model text", display: "hello\nworld" } });
    const h = harness({
      model: scripted([turn({ toolCalls: [call("do_thing", {})] }), turn({ text: "ok" })]),
      tools: [tool],
    });
    await h.loop.run(h.messages, never);

    const end = h.events.find((e) => e.type === "tool_end") as { output?: string };
    assert.equal(end.output, "hello\nworld");
  });

  test("a tool that does not opt in carries nothing, as before", async () => {
    // The considered decision this must not silently overturn: a whole file
    // under `read_file` is a payload nobody asked to render.
    const h = harness({
      model: scripted([turn({ toolCalls: [call("do_thing", {})] }), turn({ text: "ok" })]),
      tools: [fakeTool({ result: { ok: true, content: "x".repeat(10_000) } })],
    });
    await h.loop.run(h.messages, never);

    const end = h.events.find((e) => e.type === "tool_end") as { detail: string; output?: string };
    assert.equal(end.output, undefined);
    assert.ok(end.detail.length <= 200, "the status line is still a status line");
  });

  test("displayed output is capped, because a webview is not a file viewer", async () => {
    const tool = fakeTool({ result: { ok: true, content: "c", display: "y".repeat(50_000) } });
    const h = harness({
      model: scripted([turn({ toolCalls: [call("do_thing", {})] }), turn({ text: "ok" })]),
      tools: [tool],
    });
    await h.loop.run(h.messages, never);

    const end = h.events.find((e) => e.type === "tool_end") as { output?: string };
    const output = String(end.output);
    // The cut is stated, not silent. Output that stops without saying it was
    // cut reads as output that ended — which is the same mistake as showing no
    // output at all, in a smaller place.
    assert.match(output, /…\[\d+자 더 있습니다\]$/);
    assert.ok(output.replace(/\n…\[\d+자 더 있습니다\]$/, "").length === 8_000);
    assert.ok(output.length > 200, "and it is far more than the status line");
  });

  test("a failed call still carries its output, which is when it matters most", async () => {
    const tool = fakeTool({
      result: { ok: false, content: "failed", display: "Traceback…\nModuleNotFoundError: cowsay" },
    });
    const h = harness({
      model: scripted([turn({ toolCalls: [call("do_thing", {})] }), turn({ text: "ok" })]),
      tools: [tool],
    });
    await h.loop.run(h.messages, never);

    const end = h.events.find((e) => e.type === "tool_end") as { ok: boolean; output?: string };
    assert.equal(end.ok, false);
    assert.match(String(end.output), /ModuleNotFoundError/);
  });
});

/**
 * Failures the panel used to show nothing for.
 *
 * Both refusals returned before any event was emitted, so a model reaching for
 * a tool its mode does not have burned a round trip that left no trace: the
 * user saw a turn take longer and end. Found by auditing every emit against
 * every branch, not by reading the happy path.
 */
describe("refusals that happen before a tool runs", () => {
  test("an unknown tool produces a visible, failed step", async () => {
    const h = harness({
      model: scripted([turn({ toolCalls: [call("no_such_tool", {})] }), turn({ text: "ok" })]),
      tools: [fakeTool({ name: "do_thing" })],
    });
    await h.loop.run(h.messages, never);

    const start = h.events.find((e) => e.type === "tool_start") as { name: string; summary: string };
    const end = h.events.find((e) => e.type === "tool_end") as { ok: boolean; detail: string };
    assert.equal(start.name, "no_such_tool");
    assert.equal(end.ok, false);
    assert.match(end.detail, /there is no tool called/);
  });

  test("the refusal still names the tools that do exist", async () => {
    // The usual cause is a mode boundary, and the fix is for the model to pick
    // a tool it has — which it can only do if it is told what those are.
    const h = harness({
      model: scripted([turn({ toolCalls: [call("run_command", {})] }), turn({ text: "ok" })]),
      tools: [fakeTool({ name: "read_file" })],
    });
    await h.loop.run(h.messages, never);

    const tool = h.messages.find((m) => m.role === "tool");
    assert.match(String(tool?.content), /read_file/);
  });

  test("arguments that are not an object fail visibly too", async () => {
    const h = harness({
      model: scripted([
        turn({
          toolCalls: [
            { id: "c1", name: "do_thing", arguments: {}, rawArguments: "not json", argumentsValid: false },
          ],
        }),
        turn({ text: "ok" }),
      ]),
      tools: [fakeTool({ name: "do_thing" })],
    });
    await h.loop.run(h.messages, never);

    const end = h.events.find((e) => e.type === "tool_end") as { ok: boolean };
    assert.equal(end.ok, false);
  });

  test("every tool_start still has exactly one tool_end", async () => {
    // The invariant the new emits must not break: the panel keys its lines by
    // callId and would leave a spinner on a line that never resolved.
    const h = harness({
      model: scripted([turn({ toolCalls: [call("nope", {})] }), turn({ text: "ok" })]),
      tools: [fakeTool({ name: "do_thing" })],
    });
    await h.loop.run(h.messages, never);

    const starts = h.events.filter((e) => e.type === "tool_start");
    const ends = h.events.filter((e) => e.type === "tool_end");
    assert.equal(starts.length, ends.length);
    assert.equal(starts.length, 1);
  });
});
