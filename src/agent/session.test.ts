import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { nullLogger } from "../hasa-client/logger.ts";
import type { NormalizedToolCall } from "../provider/types.ts";
import { createRepoFixture, type RepoFixture } from "../testing/repo-fixture.ts";
import { allowingApprovalPort, denyingApprovalPort, recordingApprovalPort } from "./approval.ts";
import { MODE_DEFINITIONS, modeCanWrite } from "./modes.ts";
import { AgentSession } from "./session.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { AGENT_MODES, atMost, type AgentCompletion, type AgentEvent, type AgentMode, type AgentModel, type AgentTool } from "./types.ts";

/**
 * A session end to end, over a real repository and a scripted model.
 *
 * This is where the pieces have to agree with each other: a mode decides which
 * tools exist, the policy decides which of them ask first, and the checkpoint
 * decides whether any of it can be undone. Each is tested alone elsewhere; what
 * is checked here is that together they do what the user was promised.
 */

const fixtures: RepoFixture[] = [];

after(async () => {
  for (const fixture of fixtures) await fixture.dispose();
});

async function repo(files: Record<string, string> = { "src/a.ts": "export const a = 1;\n" }): Promise<RepoFixture> {
  const fixture = await createRepoFixture(files);
  fixtures.push(fixture);
  return fixture;
}

function call(name: string, args: Record<string, unknown>): NormalizedToolCall {
  const raw = JSON.stringify(args);
  return { id: `c_${name}`, name, arguments: args, rawArguments: raw, argumentsValid: true };
}

function turn(overrides: Partial<AgentCompletion> = {}): AgentCompletion {
  return { text: "", reasoning: "", toolCalls: [], inputTokens: 1, outputTokens: 1, ...overrides };
}

function scripted(script: AgentCompletion[]): AgentModel & { seen: unknown[] } {
  const model = {
    modelId: "test-model",
    seen: [] as unknown[],
    calls: 0,
    async complete(request: unknown): Promise<AgentCompletion> {
      model.seen.push(request);
      const step = script[model.calls] ?? turn({ text: "done" });
      model.calls += 1;
      return step;
    },
  };
  return model;
}

const never = new AbortController().signal;

describe("modes decide which tools exist", () => {
  test("every mode has a definition, a Korean description and a ceiling", () => {
    for (const mode of AGENT_MODES) {
      const definition = MODE_DEFINITIONS[mode];
      assert.equal(definition.mode, mode);
      assert.ok(definition.label.length > 0);
      assert.match(definition.description, /[가-힣]/);
      assert.ok(definition.systemPrompt.length > 100);
    }
  });

  test("ARCHITECT and ASK are read-only by construction", () => {
    // Not "asked about writes" — there is no writing tool to be asked about.
    assert.equal(MODE_DEFINITIONS.architect.maxRisk, "read");
    assert.equal(MODE_DEFINITIONS.ask.maxRisk, "read");
    assert.equal(modeCanWrite("architect"), false);
    assert.equal(modeCanWrite("ask"), false);
  });

  test("CODE and DEBUG may change and run things", () => {
    assert.equal(MODE_DEFINITIONS.code.maxRisk, "execute");
    assert.equal(MODE_DEFINITIONS.debug.maxRisk, "execute");
  });

  test("no prompt promises success it has not checked", () => {
    for (const mode of AGENT_MODES) {
      assert.match(
        MODE_DEFINITIONS[mode].systemPrompt,
        /did not run it, say so|say that instead|say so instead|say that rather/,
        `${mode} does not tell the model to admit what it did not verify`,
      );
    }
  });

  test("a read-only mode is offered no tool that writes", async () => {
    const fixture = await repo();
    const model = scripted([turn({ text: "Here is the plan." })]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      mode: "architect",
      logger: nullLogger,
    });

    await session.send("How is auth structured?", never);
    const request = model.seen[0] as { tools?: Array<{ name: string }> };
    const offered = (request.tools ?? []).map((t) => t.name);

    assert.ok(offered.includes("read_file"), "it can still read");
    assert.ok(!offered.includes("create_file"), "and cannot write");
    assert.ok(!offered.includes("apply_patch"));
    assert.ok(!offered.includes("execute_command"));
  });

  test("CODE is offered the writing tools", async () => {
    const fixture = await repo();
    const model = scripted([turn({ text: "ok" })]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      mode: "code",
      logger: nullLogger,
    });

    await session.send("Fix the bug.", never);
    const request = model.seen[0] as { tools?: Array<{ name: string }> };
    const offered = (request.tools ?? []).map((t) => t.name);
    assert.ok(offered.includes("create_file"));
    assert.ok(offered.includes("apply_patch"));
  });

  test("switching mode takes effect on the next message, not the next session", async () => {
    const fixture = await repo();
    const model = scripted([turn({ text: "a" }), turn({ text: "b" })]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      mode: "ask",
      logger: nullLogger,
    });

    await session.send("What does this do?", never);
    session.setMode("code");
    await session.send("Now change it.", never);

    const second = model.seen[1] as { tools?: Array<{ name: string }> };
    assert.ok((second.tools ?? []).some((t) => t.name === "create_file"));
  });
});

describe("a turn that edits a file", () => {
  test("the change lands, is reported, and can be undone", async () => {
    const fixture = await repo({ "src/a.ts": "export const a = 1;\n" });
    const events: AgentEvent[] = [];
    const model = scripted([
      turn({ toolCalls: [call("apply_patch", { path: "src/a.ts", find: "a = 1", replace: "a = 2" })] }),
      turn({ text: "src/a.ts 의 상수를 2로 바꿨습니다." }),
    ]);

    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      mode: "code",
      logger: nullLogger,
      onEvent: (e) => events.push(e),
    });

    const result = await session.send("상수를 2로 바꿔줘", never);

    assert.equal(result.reason, "finished");
    assert.deepEqual(result.changedFiles, ["src/a.ts"]);
    assert.equal(await fixture.read("src/a.ts"), "export const a = 2;\n");
    assert.ok(result.summary.length > 0);

    assert.equal(await session.undo(), true);
    assert.equal(await fixture.read("src/a.ts"), "export const a = 1;\n", "undo restored the file");
  });

  test("the user is asked before the file changes, and told what will change", async () => {
    const fixture = await repo({ "src/a.ts": "old value\n" });
    const { port, requests } = recordingApprovalPort(() => true);
    const model = scripted([
      turn({ toolCalls: [call("create_file", { path: "src/a.ts", contents: "new value\n" })] }),
      turn({ text: "done" }),
    ]);

    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: port,
      mode: "code",
      approvalMode: "safe",
      logger: nullLogger,
    });
    await session.send("바꿔줘", never);

    assert.equal(requests.length, 1);
    assert.match(requests[0]?.summary ?? "", /src\/a\.ts/);
    assert.match(String(requests[0]?.preview), /- old value/);
    assert.match(String(requests[0]?.preview), /\+ new value/);
  });

  test("a refusal leaves the workspace exactly as it was", async () => {
    const fixture = await repo({ "src/a.ts": "untouched\n" });
    const model = scripted([
      turn({ toolCalls: [call("create_file", { path: "src/a.ts", contents: "changed\n" })] }),
    ]);

    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: denyingApprovalPort,
      mode: "code",
      approvalMode: "safe",
      logger: nullLogger,
    });
    const result = await session.send("바꿔줘", never);

    assert.equal(result.reason, "denied");
    assert.equal(await fixture.read("src/a.ts"), "untouched\n");
    assert.deepEqual(await fixture.status(), [], "not even a stash was left behind");
  });

  test("a read-only mode never asks and never writes", async () => {
    const fixture = await repo();
    const { port, requests } = recordingApprovalPort(() => true);
    const model = scripted([
      // The model reaches for a tool this mode does not have.
      turn({ toolCalls: [call("create_file", { path: "x.ts", contents: "x" })] }),
      turn({ text: "I cannot edit in this mode." }),
    ]);

    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: port,
      mode: "ask",
      logger: nullLogger,
    });
    const result = await session.send("고쳐줘", never);

    assert.equal(result.reason, "finished");
    assert.deepEqual(requests, [], "there was nothing to approve");
    assert.deepEqual(await fixture.status(), []);
  });
});

describe("history", () => {
  test("the conversation carries across turns", async () => {
    const fixture = await repo();
    const model = scripted([turn({ text: "first" }), turn({ text: "second" })]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
    });

    await session.send("one", never);
    await session.send("two", never);

    const roles = session.history().map((m) => m.role);
    assert.equal(roles.filter((r) => r === "user").length, 2);
    assert.equal(roles[0], "system", "the system prompt stays first");
    assert.equal(roles.filter((r) => r === "system").length, 1, "and is never duplicated");
  });

  test("switching mode replaces the system prompt rather than stacking one", async () => {
    const fixture = await repo();
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model: scripted([turn({ text: "a" }), turn({ text: "b" })]),
      approvalPort: allowingApprovalPort,
      mode: "ask",
      logger: nullLogger,
    });

    await session.send("one", never);
    session.setMode("code");
    await session.send("two", never);

    const systems = session.history().filter((m) => m.role === "system");
    assert.equal(systems.length, 1);
    assert.equal(systems[0]?.content, MODE_DEFINITIONS.code.systemPrompt);
  });

  test("clearHistory forgets the conversation and nothing else", async () => {
    const fixture = await repo();
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model: scripted([turn({ text: "a" })]),
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
    });
    await session.send("one", never);
    session.clearHistory();
    assert.deepEqual(session.history(), []);
  });
});

describe("the registry", () => {
  const tool = (name: string, risk: AgentTool["risk"]): AgentTool => ({
    name,
    risk,
    description: name,
    parameters: { type: "object", properties: {} },
    summarize: () => name,
    execute: async () => ({ ok: true, content: "" }),
  });

  test("a ceiling keeps everything at or below it", () => {
    const registry = new ToolRegistry([
      tool("r", "read"),
      tool("w", "write"),
      tool("x", "execute"),
      tool("d", "dangerous"),
    ]);
    assert.deepEqual(registry.withCeiling("read").list().map((t) => t.name), ["r"]);
    assert.deepEqual(registry.withCeiling("write").list().map((t) => t.name), ["r", "w"]);
    assert.deepEqual(registry.withCeiling("execute").list().map((t) => t.name), ["r", "w", "x"]);
  });

  test("a dangerous tool is never registered by any mode's ceiling", () => {
    const registry = new ToolRegistry([tool("d", "dangerous")]);
    for (const mode of AGENT_MODES) {
      const ceiling = MODE_DEFINITIONS[mode].maxRisk;
      assert.equal(atMost("dangerous", ceiling), false, mode);
      assert.equal(registry.withCeiling(ceiling).size, 0, mode);
    }
  });

  test("the provider form carries no risk level", () => {
    // A model told which of its tools are considered dangerous has been handed
    // a map of what to argue about.
    const registry = new ToolRegistry([tool("w", "write")]);
    const [provider] = registry.toProviderTools();
    assert.deepEqual(Object.keys(provider ?? {}).sort(), ["description", "name", "parameters"]);
  });

  test("a duplicate name is a programming error, not a silent overwrite", () => {
    assert.throws(() => new ToolRegistry([tool("a", "read"), tool("a", "write")]), /duplicate tool/);
  });
});
