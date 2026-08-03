import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const plainDirs: string[] = [];

after(async () => {
  for (const fixture of fixtures) await fixture.dispose();
  for (const dir of plainDirs) await rm(dir, { recursive: true, force: true });
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
    assert.ok(
      String(systems[0]?.content).startsWith(MODE_DEFINITIONS.code.systemPrompt),
      "the new mode's prompt leads; what follows is what this workspace cannot do",
    );
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

describe("what the workspace cannot do is said out loud", () => {
  test("a project with no declared scripts can still run things", async () => {
    // This asserted the opposite, and the opposite was the bug. A folder with no
    // package.json got no command tool at all, and the prompt told the model to
    // say it could not run anything — so asked to install a dependency and run
    // the file it had just written, it explained at length that it was unable
    // to. It was not unable; it had been disarmed and then told to apologise.
    //
    // What gates a command now is the approval prompt, which is what the README
    // has always documented: 명령 실행 — 확인.
    const fixture = await repo();
    const model = scripted([turn({ text: "ok" })]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      mode: "code",
      logger: nullLogger,
    });
    await session.send("실행해줘", never);

    const system = String(session.history().find((m) => m.role === "system")?.content);
    assert.doesNotMatch(system, /cannot run programs/i, "the prompt must not disclaim a tool that exists");
    const offered = (model.seen[0] as { tools?: Array<{ name: string }> }).tools ?? [];
    assert.ok(offered.some((t) => t.name === "run_command"), "run_command should be offered regardless");
  });

  test("a project with scripts is told about them, and still gets the same tool", async () => {
    const fixture = await repo();
    const model = scripted([turn({ text: "ok" })]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      mode: "code",
      commands: [{ gate: "test", kind: "acceptance", cmd: "pnpm", args: ["run", "test"], timeoutMs: 1000 }],
      logger: nullLogger,
    });
    await session.send("테스트 돌려줘", never);

    const system = String(session.history().find((m) => m.role === "system")?.content);
    assert.doesNotMatch(system, /cannot run programs/i);
    const offered = (model.seen[0] as { tools?: Array<{ name: string; description?: string }> }).tools ?? [];
    const run = offered.find((t) => t.name === "run_command");
    assert.ok(run !== undefined);
    // Declared scripts become a suggestion rather than a restriction: knowing
    // the project runs `pnpm run test` is useful, being unable to run anything
    // else is not.
    assert.match(String(run.description), /pnpm run test/);
  });

  test("ASK is still given nothing that runs", async () => {
    // The capability boundary is the mode, not the workspace. Loosening what
    // CODE may do must not loosen what ASK may do.
    const fixture = await repo();
    const model = scripted([turn({ text: "ok" })]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      mode: "ask",
      logger: nullLogger,
    });
    await session.send("이거 뭐야?", never);

    const offered = (model.seen[0] as { tools?: Array<{ name: string }> }).tools ?? [];
    assert.ok(!offered.some((t) => t.name === "run_command"));
  });

  test("a git repository is offered a diff tool and no warning about undo", async () => {
    const fixture = await repo();
    const model = scripted([turn({ text: "ok" })]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
    });
    await session.send("확인해줘", never);

    const offered = ((model.seen[0] as { tools?: Array<{ name: string }> }).tools ?? []).map((t) => t.name);
    assert.ok(offered.includes("get_git_diff"));
    assert.doesNotMatch(
      String(session.history().find((m) => m.role === "system")?.content),
      /not a git repository/i,
    );
  });

  test("a plain folder is offered no diff tool, and told undo is unavailable", async () => {
    // A tool that always fails is worse than an absent one: the model tries it,
    // reads the refusal, and tries again.
    const dir = await mkdtemp(join(tmpdir(), "hasa-plain-"));
    plainDirs.push(dir);
    const model = scripted([turn({ text: "ok" })]);
    const session = await AgentSession.open({
      workspaceRoot: dir,
      model,
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
    });
    await session.send("확인해줘", never);

    const offered = ((model.seen[0] as { tools?: Array<{ name: string }> }).tools ?? []).map((t) => t.name);
    assert.ok(!offered.includes("get_git_diff"), "it could only ever fail here");
    assert.match(
      String(session.history().find((m) => m.role === "system")?.content),
      /not a git repository/i,
    );
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

/**
 * Media generation, wired through a real session.
 *
 * The tools are tested alone and the session is tested alone; what is checked
 * here is the join. It is the one path where a mistake is invisible until a
 * user asks for a picture and nothing happens.
 */
describe("image and video generation in a session", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad]);
  const entry = (id: string, modality: "image" | "video") => ({
    id, modality, title: null, available: true, callable: true, videoSpec: null,
  }) as const;

  const media = (onPost?: () => void) => ({
    transport: {
      postJson: async () => {
        onPost?.();
        return { data: [{ b64_json: Buffer.from(PNG).toString("base64") }] };
      },
      getJson: async () => ({}),
      getBinary: async () => null,
    },
    imageModels: [entry("img-1", "image")],
    videoModels: [entry("vid-1", "video")],
    videoSpecFor: async () => null,
  });

  test("the tools reach the model when the gateway offers them", async () => {
    const fixture = await repo();
    const model = scripted([turn({ text: "done" })]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      media: media(),
      logger: nullLogger,
    });
    await session.send("hello");

    const offered = (model.seen[0] as { tools?: AgentTool[] }).tools ?? [];
    const names = offered.map((t) => t.name);
    assert.ok(names.includes("generate_image"), `tools were: ${names.join(", ")}`);
    assert.ok(names.includes("generate_video"));
  });

  test("no media options means no media tools at all", async () => {
    const fixture = await repo();
    const model = scripted([turn({ text: "done" })]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
    });
    await session.send("hello");

    const names = ((model.seen[0] as { tools?: AgentTool[] }).tools ?? []).map((t) => t.name);
    assert.ok(!names.some((n) => n.startsWith("generate_")), `tools were: ${names.join(", ")}`);
  });

  test("a read-only mode is never offered them", async () => {
    // ARCHITECT and ASK cannot change the workspace, and a generated file is a
    // change. The ceiling has to hold here, not only in the registry test.
    for (const mode of AGENT_MODES.filter((m) => !modeCanWrite(m))) {
      const fixture = await repo();
      const model = scripted([turn({ text: "done" })]);
      const session = await AgentSession.open({
        workspaceRoot: fixture.root,
        model,
        approvalPort: allowingApprovalPort,
        media: media(),
        mode,
        logger: nullLogger,
      });
      await session.send("hello");

      const names = ((model.seen[0] as { tools?: AgentTool[] }).tools ?? []).map((t) => t.name);
      assert.ok(!names.some((n) => n.startsWith("generate_")), `${mode} offered: ${names.join(", ")}`);
    }
  });

  test("generating writes into the workspace and can be undone", async () => {
    // The whole reason the result is a file: it is an ordinary change, so the
    // checkpoint that protects every other edit protects this one too.
    const fixture = await repo();
    const model = scripted([
      turn({ toolCalls: [call("generate_image", { prompt: "a red apple" })] }),
      turn({ text: "made it" }),
    ]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      media: media(),
      logger: nullLogger,
    });
    await session.send("draw an apple");

    const changed = await session.changedFiles();
    assert.ok(
      changed.some((f) => f.includes("assets/generated/a-red-apple.png")),
      `changed: ${changed.join(", ")}`,
    );

    assert.equal(await session.undo(), true);
    assert.deepEqual(await session.changedFiles(), []);
  });

  test("refusing the approval spends no GPU time", async () => {
    // The request must not be sent before the user has agreed to it — a refusal
    // after the fact would still have cost them the quota.
    let requests = 0;
    const fixture = await repo();
    const model = scripted([
      turn({ toolCalls: [call("generate_image", { prompt: "x" })] }),
      turn({ text: "stopped" }),
    ]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: denyingApprovalPort,
      media: media(() => {
        requests += 1;
      }),
      logger: nullLogger,
    });
    await session.send("draw something");
    assert.equal(requests, 0, "a denied tool still called the gateway");
  });

  test("the user is asked before a picture is generated", async () => {
    const recorder = recordingApprovalPort(() => true);
    const fixture = await repo();
    const model = scripted([
      turn({ toolCalls: [call("generate_image", { prompt: "a red apple" })] }),
      turn({ text: "done" }),
    ]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: recorder.port,
      media: media(),
      logger: nullLogger,
    });
    await session.send("draw an apple");

    assert.equal(recorder.requests.length, 1);
    // What they are shown must be a decision, not a JSON blob.
    assert.match(recorder.requests[0]!.summary, /이미지/);
  });
});

/**
 * Attachments and history, through a real session.
 *
 * The join is where these can fail invisibly: a file that reaches the panel but
 * not the model, or a conversation that restores a system prompt from whatever
 * mode it was saved in.
 */
describe("attachments in a session", () => {
  const lastMessage = (model: { seen: unknown[] }): { role: string; content: unknown } => {
    const request = model.seen.at(-1) as { messages: Array<{ role: string; content: unknown }> };
    return request.messages.at(-1)!;
  };

  test("an attached file reaches the model in the same message as the question", async () => {
    const fixture = await repo();
    const model = scripted([turn({ text: "읽었습니다" })]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
    });

    await session.send("이 파일 설명해줘", never, [
      { kind: "text", name: "notes.md", text: "SECRET_MARKER_TEXT" },
    ]);

    const message = lastMessage(model);
    assert.equal(message.role, "user");
    assert.match(String(message.content), /SECRET_MARKER_TEXT/);
    assert.match(String(message.content), /notes\.md/);
    // The question stays last, so it is the most recent thing the model read.
    const body = String(message.content);
    assert.ok(body.indexOf("SECRET_MARKER_TEXT") < body.indexOf("이 파일 설명해줘"));
  });

  test("an image is refused rather than dropped when the model cannot read one", async () => {
    const fixture = await repo();
    const model = scripted([turn({ text: "…" })]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      vision: false,
      logger: nullLogger,
    });

    await session.send("이거 뭐야", never, [
      { kind: "image", name: "shot.png", mediaType: "image/png", base64: "AAAA" },
    ]);

    const problem = session.takeAttachmentProblem();
    assert.ok(problem !== null, "the user was not told the image was not sent");
    assert.match(problem, /shot\.png/);
    assert.equal(typeof lastMessage(model).content, "string", "an image part was sent anyway");
  });

  test("an image reaches a model that was measured to read one", async () => {
    const fixture = await repo();
    const model = scripted([turn({ text: "…" })]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      vision: true,
      logger: nullLogger,
    });

    await session.send("이거 뭐야", never, [
      { kind: "image", name: "shot.png", mediaType: "image/png", base64: "AAAA" },
    ]);

    const parts = lastMessage(model).content as Array<{ type: string }>;
    assert.ok(Array.isArray(parts));
    assert.ok(parts.some((p) => p.type === "image"));
    assert.equal(session.takeAttachmentProblem(), null);
  });

  test("the problem is reported once, then it is stale", async () => {
    const fixture = await repo();
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model: scripted([turn({ text: "…" })]),
      approvalPort: allowingApprovalPort,
      vision: false,
      logger: nullLogger,
    });
    await session.send("q", never, [{ kind: "image", name: "a.png", mediaType: "image/png", base64: "AA" }]);
    assert.ok(session.takeAttachmentProblem() !== null);
    assert.equal(session.takeAttachmentProblem(), null);
  });

  test("a turn with no attachments sends the prompt unchanged", async () => {
    const fixture = await repo();
    const model = scripted([turn({ text: "…" })]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
    });
    await session.send("그냥 질문", never);
    assert.equal(lastMessage(model).content, "그냥 질문");
  });
});

describe("restoring a conversation", () => {
  test("the messages come back and the next turn continues them", async () => {
    const fixture = await repo();
    const model = scripted([turn({ text: "이어서" })]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
    });

    session.restore([
      { role: "user", content: "예전 질문" },
      { role: "assistant", content: "예전 답" },
    ]);
    await session.send("그 다음은?", never);

    const request = model.seen[0] as { messages: Array<{ role: string; content: unknown }> };
    const texts = request.messages.map((m) => String(m.content));
    assert.ok(texts.some((t) => t.includes("예전 질문")));
    assert.ok(texts.some((t) => t.includes("그 다음은?")));
  });

  test("a stored system prompt is not restored", async () => {
    // It is re-seeded from the current mode every turn. Restoring one would
    // put a prompt from a different mode back into this session.
    const fixture = await repo();
    const model = scripted([turn({ text: "…" })]);
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model,
      approvalPort: allowingApprovalPort,
      mode: "ask",
      logger: nullLogger,
    });

    session.restore([
      { role: "system", content: "STALE_PROMPT_FROM_ANOTHER_MODE" },
      { role: "user", content: "질문" },
    ]);
    await session.send("또 질문", never);

    const request = model.seen[0] as { messages: Array<{ role: string; content: unknown }> };
    const systems = request.messages.filter((m) => m.role === "system");
    assert.equal(systems.length, 1, "there should be exactly one system message");
    assert.ok(!String(systems[0]?.content).includes("STALE_PROMPT_FROM_ANOTHER_MODE"));
    assert.match(String(systems[0]?.content), /You answer questions about this repository/);
  });

  test("restoring replaces rather than appends", async () => {
    const fixture = await repo();
    const session = await AgentSession.open({
      workspaceRoot: fixture.root,
      model: scripted([turn({ text: "…" })]),
      approvalPort: allowingApprovalPort,
      logger: nullLogger,
    });
    session.restore([{ role: "user", content: "첫 번째" }]);
    session.restore([{ role: "user", content: "두 번째" }]);
    const history = session.history().map((m) => String(m.content));
    assert.deepEqual(history, ["두 번째"]);
  });
});
