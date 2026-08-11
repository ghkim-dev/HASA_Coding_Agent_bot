import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createRepoFixture, type RepoFixture } from "../testing/repo-fixture.ts";
import { createFileTools } from "./tools/fileTools.ts";
import { createShellTools, interpreterEnv } from "./tools/shellTools.ts";
import { Sandbox } from "../core/sandbox.ts";
import { INVALID_COMMAND_USE_FILE_TOOL } from "./commandSpec.ts";
import { newProgressState, observeAction } from "./progress.ts";
import type { AgentTool, ToolContext } from "./types.ts";

/**
 * Making a directory without knowing which operating system this is.
 *
 * The dog/cat transcript failed three times before it ever got to running
 * anything: `mkdir -p …`, then `mkdir …` spawned as though it were a program,
 * then `cd …` the same way. a286d77 closed the `cd` half by making the working
 * directory a field. This closes the other half, and the answer turned out to
 * be that it was already closed in the right place and nobody had said so.
 *
 * `Sandbox.writeFile` calls `mkdir(dirname, { recursive: true })` before it
 * writes. So `create_file` with `a/b/c/main.py` creates `a/b/c`, through a
 * filesystem call, on every platform. There is no directory tool to add — there
 * is a behaviour to state, to test, and to point the model at when it reaches
 * for the shell instead.
 */

const fixtures: RepoFixture[] = [];
after(async () => {
  for (const f of fixtures) await f.dispose().catch(() => {});
});

function contextFor(root: string): ToolContext {
  return { signal: new AbortController().signal, workspaceRoot: root };
}

/** Both halves over one workspace, because the point is that they meet. */
async function workspace(): Promise<{ create: AgentTool; run: AgentTool; root: string }> {
  const fixture = await createRepoFixture({ "a.ts": "export const a = 1;\n" });
  fixtures.push(fixture);
  const sandbox = new Sandbox({ root: fixture.root });
  const create = createFileTools(sandbox).find((t) => t.name === "create_file");
  const run = createShellTools({
    workspaceRoot: fixture.root,
    allowlist: [],
    isGitRepo: true,
  }).find((t) => t.name === "run_command");
  assert.ok(create !== undefined && run !== undefined);
  return { create, run, root: fixture.root };
}

describe("2/3 — a nested path makes its own directories", () => {
  test("writing a/b/c/main.py creates a/b/c", async () => {
    const { create, root } = await workspace();
    const result = await create.execute(
      { path: "image_classification_project/src/models/main.py", contents: "print('학습 시작')\n" },
      contextFor(root),
    );

    assert.equal(result.ok, true, result.content);
    assert.equal(
      await readFile(join(root, "image_classification_project", "src", "models", "main.py"), "utf8"),
      "print('학습 시작')\n",
    );
  });

  test("D — a nested write does not quietly fail for want of a directory", async () => {
    // Stated as its own case because the alternative — a write that fails until
    // something else made the directory — is what sends a model to the shell.
    const { create, root } = await workspace();
    for (const path of ["one/main.py", "one/two/main.py", "one/two/three/four/main.py"]) {
      const result = await create.execute({ path, contents: "x\n" }, contextFor(root));
      assert.equal(result.ok, true, `${path}: ${result.content}`);
    }
  });

  test("5 — and the path is still checked, so no directory appears outside", async () => {
    // The sandbox throws rather than returning, and `AgentLoop.invoke` turns
    // that into a result the model can read — see `describeToolFailure`. What
    // matters here is the half that cannot be caught later: no directory is
    // created on the way to finding out the path was illegal.
    const { create, root } = await workspace();
    // A name unique to this run. The parent of a fixture is a shared temp
    // directory, so a fixed name can be satisfied by something another test —
    // or an earlier experiment — happened to leave there.
    const target = `escaped-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await assert.rejects(
      () => create.execute({ path: `../${target}/main.py`, contents: "x" }, contextFor(root)),
      /sandbox|traversal/i,
    );
    await assert.rejects(() => stat(join(root, "..", target)), "a directory was made outside the workspace");
  });

  test("nor for an absolute path", async () => {
    const { create, root } = await workspace();
    await assert.rejects(
      () => create.execute({ path: "/tmp/escaped/main.py", contents: "x" }, contextFor(root)),
      /sandbox|absolute/i,
    );
  });
});

describe("1/9 — reaching for mkdir is answered with the tool that already does it", () => {
  test("every spelling of it, on either platform", async () => {
    // On Windows `mkdir` is a `cmd` built-in and spawning it fails outright; on
    // Linux it is a real binary and would work. The same call has to mean the
    // same thing on both, and it already does somewhere better.
    const { run, root } = await workspace();
    for (const name of ["mkdir", "md", "New-Item", "MKDIR"]) {
      const result = await run.execute({ executable: name, args: "src/models" }, contextFor(root));
      assert.equal(result.ok, false, name);
      assert.match(result.content, new RegExp(INVALID_COMMAND_USE_FILE_TOOL), name);
      assert.match(result.content, /create_file/, name);
    }
  });

  test("`mkdir -p` is refused rather than parsed", async () => {
    // The exact first call from the transcript. It is not a POSIX flag to be
    // translated — it is a job with a tool.
    const { run, root } = await workspace();
    const result = await run.execute({ command: "mkdir -p a/b/c" }, contextFor(root));
    assert.equal(result.ok, false);
    assert.match(result.content, new RegExp(INVALID_COMMAND_USE_FILE_TOOL));
  });

  test("and the refusal says which tool, not merely no", async () => {
    // A refusal without an alternative is what produced three attempts.
    const { run, root } = await workspace();
    const result = await run.execute({ executable: "mkdir", args: "x" }, contextFor(root));
    assert.match(result.content, /상위 디렉터리|create_file/);
  });

  test("an explicit shell is still available for someone who means it", async () => {
    // `mode: "shell"` is the escape hatch. Refusing a job that has a tool is a
    // default, not a prohibition.
    const { run, root } = await workspace();
    const result = await run.execute({ command: "mkdir shelldir | echo x" }, contextFor(root));
    assert.ok(!result.content.includes(INVALID_COMMAND_USE_FILE_TOOL), "a pipeline is a shell command");
  });
});

describe("9 — the dog/cat scaffold, with no shell anywhere", () => {
  test("one create_file and one cwd replace mkdir -p, mkdir and cd", async () => {
    const { create, run, root } = await workspace();
    await create.execute(
      {
        path: "image_classification_project/src/main.js",
        contents: "console.log('개와 고양이 분류 시작');\n",
      },
      contextFor(root),
    );

    const result = await run.execute(
      { executable: "node", args: "main.js", cwd: "image_classification_project/src" },
      contextFor(root),
    );

    assert.equal(result.ok, true, result.content);
    assert.match(String(result.display), /개와 고양이 분류 시작/);

    const shown = String(result.display).toLowerCase();
    assert.ok(!shown.includes("mkdir"), "no mkdir");
    assert.ok(!shown.includes("powershell"), "no shell wrapper");
    assert.ok(!shown.includes("&&"), "no command chaining");
    assert.ok(!/\bcd\b/.test(shown), "no cd");
  });
});

describe("8 — an existing directory is not fresh progress", () => {
  test("the first write counts, the identical repeat does not", () => {
    // Creating the same scaffold again changes nothing about the workspace, and
    // a model doing it repeatedly must not accumulate progress for it.
    const state = newProgressState();
    const same = {
      toolName: "create_file",
      args: { path: "image_classification_project/src/main.py" },
      outcome: "executed" as const,
      detail: "wrote image_classification_project/src/main.py (1 lines)",
      changedFiles: ["image_classification_project/src/main.py"],
    };
    assert.equal(observeAction(state, same), "strong");
    assert.equal(observeAction(state, same), "none");
    assert.equal(observeAction(state, same), "none");
    assert.equal(state.streak, 2);
  });

  test("but a different file does count", () => {
    const state = newProgressState();
    const write = (path: string): "strong" | "weak" | "none" =>
      observeAction(state, {
        toolName: "create_file",
        args: { path },
        outcome: "executed",
        detail: `wrote ${path}`,
        changedFiles: [path],
      });
    assert.equal(write("a/main.py"), "strong");
    assert.equal(write("b/main.py"), "strong");
  });
});

describe("10 — the original failure was Python", () => {
  test("a structured Python call keeps argv, cwd and UTF-8", async () => {
    const { create, run, root } = await workspace();
    await create.execute(
      {
        path: "image_classification_project/src/main.py",
        contents: "import sys\nprint('개와 고양이 분류 🐶🐱')\nprint(sys.argv[1])\n",
      },
      contextFor(root),
    );

    const result = await run.execute(
      {
        executable: "python",
        args: "main.py\ninput file.txt",
        cwd: "image_classification_project/src",
      },
      contextFor(root),
    );

    // A machine without Python does not disprove the contract; what was sent is
    // what this test is about, and the shape assertions below still hold.
    if (!result.ok && /찾을 수 없습니다|not installed|ENOENT/.test(result.content)) {
      assert.match(String(result.display ?? result.content), /python/i);
      return;
    }

    assert.equal(result.ok, true, result.content);
    const shown = String(result.display);
    assert.match(shown, /개와 고양이 분류 🐶🐱/, "PYTHONUTF8 on the writing side, the decoder on the reading side");
    assert.match(shown, /input file\.txt/, "the space survived as one argument");
    assert.match(shown, /image_classification_project\/src/, "and it ran where it was told to");
    assert.ok(!shown.toLowerCase().includes("powershell"));
  });

  test("the interpreter env is set for Python and not for everything", () => {
    // These are ignored by other programs, but setting them everywhere would be
    // a claim about tools that never asked for it.
    assert.deepEqual(interpreterEnv("python"), { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" });
    assert.deepEqual(interpreterEnv("python3.11"), { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" });
    assert.deepEqual(interpreterEnv("C:\\Python311\\python.exe"), {
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    });
    assert.deepEqual(interpreterEnv("node"), {});
    assert.deepEqual(interpreterEnv("pytest"), {});
  });
});
