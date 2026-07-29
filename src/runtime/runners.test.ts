import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CodeTaskSpecSchema, type CandidateSpec, type CommandSpec } from "../protocol/index.ts";
import { HasaClient } from "../hasa-client/client.ts";
import { nullLogger } from "../hasa-client/logger.ts";
import { clearSecrets } from "../hasa-client/redact.ts";
import { GitRepo, worktreePathFor } from "../core/git.ts";
import { Sandbox } from "../core/sandbox.ts";
import { candidateEnv, runCommand, type CommandOutcome } from "../core/commands.ts";
import { startMockHasa, type MockHasaServer } from "../testing/mock-hasa.ts";
import { createRepoFixture, type RepoFixture } from "../testing/repo-fixture.ts";
import { ToolCallingRunner } from "./agentRunner.ts";
import { PatchGenerationRunner, extractPatch } from "./patchRunner.ts";
import type { RunnerInput } from "./types.ts";

const NODE = process.execPath;

const PATCH = [
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1 +1 @@",
  "-export const answer = 41;",
  "+export const answer = 42;",
  "",
].join("\n");

let mock: MockHasaServer;
let fixture: RepoFixture;
let repo: GitRepo;
let worktree: string;

before(async () => {
  mock = await startMockHasa({
    models: [
      {
        id: "agent/good",
        tools: "native",
        agentScript: [
          { name: "list_files", args: { path: "src" } },
          { name: "read_file", args: { path: "src/app.ts" } },
          { name: "write_file", args: { path: "src/app.ts", contents: "export const answer = 42;\n" } },
          { name: "finish", args: { summary: "changed the answer to 42" } },
        ],
      },
      {
        id: "agent/escaper",
        tools: "native",
        agentScript: [
          { name: "read_file", args: { path: "../outside-secret.txt" } },
          { name: "read_file", args: { path: ".env" } },
          { name: "write_file", args: { path: "src/app.ts", contents: "export const answer = 42;\n" } },
          { name: "finish", args: { summary: "done after being refused twice" } },
        ],
      },
      {
        id: "agent/runner",
        tools: "native",
        agentScript: [
          { name: "run_command", args: { gate: "build" } },
          { name: "run_command", args: { gate: "deploy" } },
          { name: "finish", args: { summary: "ran what I was allowed to" } },
        ],
      },
      { id: "patch/good", tools: "none", patchReply: PATCH },
      { id: "patch/fenced", tools: "none", patchReply: "```diff\n" + PATCH + "```" },
      { id: "patch/prose", tools: "none", patchReply: "I would change line 1 to 42." },
    ],
  });
});

after(async () => {
  await mock.close();
  clearSecrets();
});

beforeEach(async () => {
  fixture = await createRepoFixture({ "src/app.ts": "export const answer = 41;\n" });
  await fixture.write(".env", "HASA_API_KEY=leak-me\n");
  await fixture.commit("add env");
  repo = await GitRepo.open(fixture.root);
  const base = await repo.headSha();
  const handle = await repo.addWorktree(worktreePathFor(repo.root, "runtest1", "cand-a"), base, "cand-a");
  worktree = handle.path;
});

afterEach(async () => {
  await repo.removeWorktree(worktree).catch(() => {});
  await fixture.dispose();
});

function client(): HasaClient {
  return new HasaClient({
    apiKey: mock.apiKey,
    baseUrl: mock.url,
    logger: nullLogger,
    maxRetries: 0,
    sleep: async () => {},
  });
}

function spec(modelId: string): CandidateSpec {
  return {
    candidateId: "c1",
    label: "cand-a",
    modelId,
    systemPromptVersion: "coding-agent-v1",
    temperature: 0.2,
    topP: 1,
    maxOutputTokens: 2048,
    runtimeAdapter: "response",
  };
}

function makeInput(
  modelId: string,
  overrides: { acceptanceCommands?: CommandSpec[]; contextFiles?: string[] } = {},
): { input: RunnerInput; commands: CommandOutcome[] } {
  const taskSpec = CodeTaskSpecSchema.parse({
    prompt: "Change the answer to 42.",
    acceptanceCommands: overrides.acceptanceCommands ?? [],
    contextFiles: overrides.contextFiles ?? [],
  });
  const commands: CommandOutcome[] = [];
  const input: RunnerInput = {
    spec: spec(modelId),
    taskSpec,
    sandbox: new Sandbox({ root: worktree }),
    client: client(),
    log: nullLogger,
    signal: new AbortController().signal,
    onEvent: () => {},
    dispatch: (_model, fn) => fn(),
    runCommand: async (command) => {
      const outcome = await runCommand(command, taskSpec.acceptanceCommands, {
        cwd: worktree,
        env: candidateEnv(),
      });
      commands.push(outcome);
      return outcome;
    },
    applyPatch: (patch: string) => repo.applyPatch(patch, worktree),
  };
  return { input, commands };
}

describe("ToolCallingRunner", () => {
  test("reads, writes and finishes inside its own worktree", async () => {
    const { input } = makeInput("agent/good");
    const result = await new ToolCallingRunner().run(input);

    assert.equal(result.summary, "changed the answer to 42");
    assert.equal(result.toolCalls, 4);
    assert.equal(await readFile(join(worktree, "src/app.ts"), "utf8"), "export const answer = 42;\n");
    // The main workspace is a different tree entirely.
    assert.equal(await fixture.read("src/app.ts"), "export const answer = 41;\n");
  });

  test("a refused tool call is fed back to the model instead of killing the run", async () => {
    // The model tries to escape the worktree, then to read .env, and only then
    // does something legal. It must still be able to finish.
    const { input } = makeInput("agent/escaper");
    const result = await new ToolCallingRunner().run(input);

    assert.equal(result.summary, "done after being refused twice");
    assert.equal(await readFile(join(worktree, "src/app.ts"), "utf8"), "export const answer = 42;\n");
  });

  test("only declared commands are offered and undeclared ones are refused", async () => {
    const build: CommandSpec = {
      gate: "build",
      kind: "regression",
      cmd: NODE,
      args: ["-e", "console.log('built')"],
      timeoutMs: 20_000,
    };
    const { input, commands } = makeInput("agent/runner", { acceptanceCommands: [build] });
    const result = await new ToolCallingRunner().run(input);

    assert.equal(commands.length, 1, "the undeclared 'deploy' gate must never execute");
    assert.equal(commands[0]?.gate, "build");
    assert.match(result.summary, /allowed/);
  });

  test("the tool budget bounds the loop", async () => {
    const { input } = makeInput("agent/good");
    input.taskSpec.maxToolCalls = 2;
    const result = await new ToolCallingRunner().run(input);
    assert.ok(result.toolCalls <= 2);
  });
});

describe("extractPatch", () => {
  test("accepts a bare diff", () => {
    assert.match(extractPatch(PATCH), /^--- a\/src\/app\.ts/);
  });

  test("unwraps a fenced diff", () => {
    assert.match(extractPatch("```diff\n" + PATCH + "```"), /^--- a\/src\/app\.ts/);
  });

  test("strips leading prose before the first diff marker", () => {
    assert.match(extractPatch("Here you go:\n\n" + PATCH), /^--- a\/src\/app\.ts/);
  });

  test("returns the text unchanged when there is no diff to find", () => {
    assert.equal(extractPatch("no diff here").trim(), "no diff here");
  });
});

describe("PatchGenerationRunner", () => {
  test("applies a generated patch to the worktree", async () => {
    const { input } = makeInput("patch/good", { contextFiles: ["src/app.ts"] });
    const result = await new PatchGenerationRunner().run(input);

    assert.match(result.summary, /applied/);
    assert.equal(await readFile(join(worktree, "src/app.ts"), "utf8"), "export const answer = 42;\n");
    assert.equal(result.toolCalls, 0, "patch mode never calls tools");
  });

  test("unwraps a fenced patch rather than failing on formatting", async () => {
    const { input } = makeInput("patch/fenced", { contextFiles: ["src/app.ts"] });
    const result = await new PatchGenerationRunner().run(input);
    assert.match(result.summary, /applied/);
  });

  test("gives up cleanly when the model never produces an applicable patch", async () => {
    const { input } = makeInput("patch/prose", { contextFiles: ["src/app.ts"] });
    const result = await new PatchGenerationRunner().run(input);

    assert.match(result.summary, /no applicable patch/);
    // Nothing half-applied: the worktree is exactly as it started.
    assert.equal(await readFile(join(worktree, "src/app.ts"), "utf8"), "export const answer = 41;\n");
  });

  test("a forbidden context file is skipped rather than leaked into the prompt", async () => {
    const { input } = makeInput("patch/good", { contextFiles: [".env", "src/app.ts"] });
    await new PatchGenerationRunner().run(input);
    assert.ok(!JSON.stringify(mock.stats.lastRequestBody).includes("leak-me"));
  });
});
