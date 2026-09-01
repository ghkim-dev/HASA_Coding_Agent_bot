import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRepoFixture, type RepoFixture } from "../testing/repo-fixture.ts";
import { createShellTools } from "./tools/shellTools.ts";
import { CappedDecoder } from "../core/commands.ts";
import {
  COMMAND_CWD_NOT_FOUND,
  COMMAND_CWD_OUTSIDE_WORKSPACE,
  INVALID_COMMAND_SHELL_SYNTAX,
  INVALID_COMMAND_USE_CWD,
  isPrintOnlySpec,
  resolveCwd,
  specFromLine,
  specShape,
  validateSpec,
  type AgentCommandSpec,
} from "./commandSpec.ts";
import type { AgentTool, ToolContext } from "./types.ts";

/**
 * Running a program somewhere else, without writing shell.
 *
 * What actually happened, on Windows, three calls in a row: `mkdir -p …`
 * failed, then `mkdir …` spawned as though it were a program and failed, then
 * `cd image_classification_project/src` spawned as a standalone process and
 * failed. The rest of that session was spent working around the working
 * directory with `python -c "import sys; sys.path.append(...)"`.
 *
 * The model was not being careless. It had been asked to express "run this
 * program, over there" in a language with no way to say "over there" — a single
 * command line — so it reached for shell syntax, and shell syntax differs by
 * platform.
 *
 *   The working directory is not part of the command. It is a field.
 */

const fixtures: RepoFixture[] = [];
after(async () => {
  for (const f of fixtures) await f.dispose().catch(() => {});
});

/** Built per workspace, because `ToolContext` carries the root. */
function contextFor(root: string): ToolContext {
  return { signal: new AbortController().signal, workspaceRoot: root };
}

/** The shell tools over a real workspace, with `node` allowed. */
async function tools(files: Record<string, string> = {}): Promise<{
  run: AgentTool;
  root: string;
}> {
  const fixture = await createRepoFixture({ "a.ts": "export const a = 1;\n", ...files });
  fixtures.push(fixture);
  const all = createShellTools({
    workspaceRoot: fixture.root,
    allowlist: [],
    isGitRepo: true,
  });
  const run = all.find((t) => t.name === "run_command");
  assert.ok(run !== undefined);
  return { run, root: fixture.root };
}

const exec = (executable: string, args: string[] = [], cwd?: string): AgentCommandSpec => ({
  mode: "exec",
  executable,
  args,
  ...(cwd === undefined ? {} : { cwd }),
});

describe("A/8 — cd is not a program", () => {
  test("it is refused before anything is spawned, and named for what it is", () => {
    for (const name of ["cd", "chdir", "pushd", "popd", "CD", "cd.exe"]) {
      const problem = validateSpec(exec(name, ["src"]));
      assert.equal(problem?.code, INVALID_COMMAND_USE_CWD, name);
      assert.match(String(problem?.message), /cwd/);
    }
  });

  test("through the tool, nothing runs", async () => {
    const { run, root } = await tools();
    const result = await run.execute({ executable: "cd", args: "src" }, contextFor(root));
    assert.equal(result.ok, false);
    assert.match(result.content, new RegExp(INVALID_COMMAND_USE_CWD));
    // No `display`, because nothing was displayed — nothing ran.
    assert.equal(result.display, undefined);
  });

  test("env-setting built-ins are refused the same way", () => {
    assert.equal(validateSpec(exec("export", ["X=1"]))?.code, INVALID_COMMAND_USE_CWD);
    assert.match(String(validateSpec(exec("export", ["X=1"]))?.message), /env/);
  });
});

describe("I/13/14 — shell is asked for, never fallen into", () => {
  test("shell syntax in an exec payload is a validation error", () => {
    const problem = validateSpec(exec("python a.py | python b.py"));
    assert.equal(problem?.code, INVALID_COMMAND_SHELL_SYNTAX);
    assert.match(String(problem?.message), /mode/);
  });

  test("and the message says how to get a shell, since pipelines are real", () => {
    assert.match(String(validateSpec(exec("a && b"))?.message), /shell/);
  });

  test("an explicit shell spec is allowed", () => {
    assert.equal(validateSpec({ mode: "shell", command: "python a.py | python b.py" }), null);
  });

  test("an empty one is not", () => {
    assert.equal(validateSpec({ mode: "shell", command: "   " })?.code, INVALID_COMMAND_SHELL_SYNTAX);
  });

  test("H — through the tool, a pipeline runs as a shell command", async () => {
    const { run, root } = await tools();
    const result = await run.execute(
      { command: "node -e \"console.log('a')\" | node -e \"process.stdin.pipe(process.stdout)\"" },
      contextFor(root),
    );
    // What matters is that it was not refused as a bad executable: a legacy
    // line containing a pipe is read as the shell command it always was.
    assert.ok(!result.content.includes(INVALID_COMMAND_SHELL_SYNTAX));
  });
});

describe("B/C/D — the same call means the same thing everywhere", () => {
  test("the working directory is a field, not a prefix", async () => {
    const { run, root } = await tools();
    await mkdir(join(root, "image_classification_project", "src"), { recursive: true });
    await writeFile(join(root, "image_classification_project", "src", "main.py"), "x\n", "utf8");

    const result = await run.execute(
      {
        executable: "node",
        args: "-e\nconsole.log(process.cwd())",
        cwd: "image_classification_project/src",
      },
      contextFor(root),
    );
    assert.equal(result.ok, true, result.content);
    assert.match(String(result.display), /image_classification_project/);
    // No shell wrapper anywhere in what was run or shown.
    assert.ok(!String(result.display).includes("&&"));
    assert.ok(!String(result.display).toLowerCase().includes("powershell"));
  });

  test("D — a path with spaces is one argument, with no quoting", async () => {
    const { run, root } = await tools();
    await mkdir(join(root, "My Project"), { recursive: true });

    const result = await run.execute(
      {
        executable: "node",
        args: "-e\nconsole.log(process.argv[1])\ninput file.txt",
        cwd: "My Project",
      },
      contextFor(root),
    );
    assert.equal(result.ok, true, result.content);
    assert.match(String(result.display), /input file\.txt/, "the space survived as one argument");
  });

  test("the argument vector is never rebuilt into a string", () => {
    // The property the two tests above depend on: an arg list is carried, not
    // joined. Joining and re-splitting is where a space becomes two arguments.
    const spec = exec("node", ["-e", "console.log(1)", "my file.txt"]);
    assert.equal(spec.mode, "exec");
    if (spec.mode !== "exec") return;
    assert.deepEqual(spec.args, ["-e", "console.log(1)", "my file.txt"]);
    assert.equal(spec.args.length, 3);
  });
});

describe("E/F/G — the workspace boundary still holds", () => {
  const probe = {
    realpath: async (p: string) => p,
    isDirectory: async () => true,
  };

  // Built with `join` so the separators are the platform's, the way a real
  // workspace root arrives. Hard-coding POSIX paths made these pass on Linux
  // and compare `\work\project.ts` against `/work/project` on Windows.
  const ROOT = resolve(join("work", "project"));

  test("E — a relative path climbing out is refused", async () => {
    const result = await resolveCwd("../../outside", ROOT, probe);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.problem.code : "", COMMAND_CWD_OUTSIDE_WORKSPACE);
  });

  test("an absolute path outside is refused", async () => {
    const result = await resolveCwd(resolve(join("etc")), ROOT, probe);
    assert.equal(result.ok, false);
  });

  test("a sibling with a shared prefix is not inside", async () => {
    const result = await resolveCwd(`${ROOT}-other`, ROOT, probe);
    assert.equal(result.ok, false);
  });

  test("F — a symlink pointing out is followed and then refused", async () => {
    // The boundary is on the resolved real path, the same basis `Sandbox`
    // uses. A structured field must not become the way around a check a path
    // argument could not get around.
    const escaping = {
      realpath: async (p: string) => (p.includes("escape") ? resolve(join("elsewhere", "secrets")) : p),
      isDirectory: async () => true,
    };
    const result = await resolveCwd("escape", ROOT, escaping);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.problem.code : "", COMMAND_CWD_OUTSIDE_WORKSPACE);
  });

  test("G — a directory that is not there says so", async () => {
    const missing = {
      realpath: async (p: string) => {
        if (p.includes("gone")) throw new Error("ENOENT");
        return p;
      },
      isDirectory: async () => true,
    };
    const result = await resolveCwd("gone", ROOT, missing);
    assert.equal(result.ok === false ? result.problem.code : "", COMMAND_CWD_NOT_FOUND);
  });

  test("a file is not a directory", async () => {
    const asFile = { realpath: async (p: string) => p, isDirectory: async () => false };
    const result = await resolveCwd("a.ts", ROOT, asFile);
    assert.equal(result.ok === false ? result.problem.code : "", COMMAND_CWD_NOT_FOUND);
  });

  test("no cwd means the workspace root", async () => {
    for (const value of [undefined, "", "   "]) {
      const result = await resolveCwd(value, ROOT, probe);
      assert.equal(result.ok, true);
      assert.equal(result.ok === true ? result.path : "", ROOT);
    }
  });

  test("through the tool, a real symlink out of the workspace is refused", async () => {
    const { run, root } = await tools();
    const outside = join(root, "..", `outside-${Date.now()}`);
    await mkdir(outside, { recursive: true });
    try {
      await symlink(outside, join(root, "escape"), "dir");
    } catch {
      return; // A machine without symlink permission; the unit test above covers the rule.
    }
    const result = await run.execute(
      { executable: "node", args: "-e\nconsole.log(1)", cwd: "escape" },
      contextFor(root),
    );
    assert.equal(result.ok, false);
    assert.match(result.content, new RegExp(COMMAND_CWD_OUTSIDE_WORKSPACE));
  });
});

describe("15 — a legacy one-liner still works, and becomes a spec", () => {
  const parse = (line: string): { cmd: string; args: string[] } => {
    const parts = line.split(/\s+/);
    return { cmd: parts[0] ?? "", args: parts.slice(1) };
  };

  test("an ordinary line becomes an exec spec", () => {
    const spec = specFromLine("python main.py", parse);
    assert.equal(spec.mode, "exec");
    if (spec.mode !== "exec") return;
    assert.equal(spec.executable, "python");
    assert.deepEqual(spec.args, ["main.py"]);
  });

  test("a line with a pipe becomes a shell spec, because it always was one", () => {
    const spec = specFromLine("a | b", parse);
    assert.equal(spec.mode, "shell");
  });

  test("and the structured form has no such path", () => {
    // The reading above is of a legacy input that never had a mode to state.
    // An `exec` payload that says it is exec does not get silently promoted.
    assert.equal(validateSpec(exec("a | b"))?.code, INVALID_COMMAND_SHELL_SYNTAX);
  });

  test("through the tool, a legacy call still runs", async () => {
    const { run, root } = await tools();
    const result = await run.execute({ command: "node --version" }, contextFor(root));
    assert.equal(result.ok, true, result.content);
  });

  test("parentheses do not make a line into a shell command", async () => {
    // The bug the narrowing fixed. Treating every shell-ish character as
    // requiring a shell turned `node -e "console.log(1)"` — an ordinary call —
    // into a PowerShell invocation that failed.
    const spec = specFromLine('node -e "console.log(1)"', parse);
    assert.equal(spec.mode, "exec");

    const { run, root } = await tools();
    const result = await run.execute({ command: 'node -e "console.log(1)"' }, contextFor(root));
    assert.equal(result.ok, true, result.content);
    assert.ok(!String(result.display).toLowerCase().includes("powershell"));
  });

  test("a quoted pipe is not a pipeline", () => {
    assert.equal(specFromLine(`node -e "console.log('a|b')"`, parse).mode, "exec");
    assert.equal(specFromLine("node a.js | node b.js", parse).mode, "shell");
  });
});

describe("19/20 — the loop detector reads the structure now", () => {
  test("a print-only one-liner is recognised from its fields", () => {
    assert.equal(isPrintOnlySpec(exec("python", ["-c", "print('프로젝트 완료')"])), true);
    assert.equal(isPrintOnlySpec(exec("node", ["-e", "console.log('done')"])), true);
    assert.equal(isPrintOnlySpec(exec("echo", ["hello"])), true);
  });

  test("a one-liner that computes something is not", () => {
    assert.equal(isPrintOnlySpec(exec("python", ["-c", "import torch; print(torch.rand(1))"])), false);
  });

  test("every celebratory print is one shape", () => {
    const shapes = [
      exec("python", ["-c", "print('프로젝트 완료')"]),
      exec("python", ["-c", "print('프로젝트 최종 완료')"]),
      exec("python", ["-c", "print('모든 구성 요소 정상')"]),
    ].map(specShape);
    assert.equal(new Set(shapes).size, 1);
  });

  test("but two different test files are two shapes", () => {
    assert.notEqual(specShape(exec("pytest", ["test_a.py"])), specShape(exec("pytest", ["test_b.py"])));
  });
});

describe("J/K/22 — output survives being Korean", () => {
  test("Korean stdout comes back intact", async () => {
    const { run, root } = await tools();
    const result = await run.execute(
      { executable: "node", args: "-e\nconsole.log('개와 고양이 분류 완료 🐶🐱')" },
      contextFor(root),
    );
    assert.equal(result.ok, true, result.content);
    assert.match(String(result.display), /개와 고양이 분류 완료 🐶🐱/);
  });

  test("K — a character split across chunk boundaries survives", () => {
    // Split deliberately rather than hoped for. Through a real process the
    // boundary lands wherever the pipe flushes, and the capture cap meant the
    // interesting case happened after output stopped being kept — so per-chunk
    // decoding passed every end-to-end test.
    const text = "개와 고양이 분류 완료 🐶🐱";
    const bytes = Buffer.from(text, "utf8");

    for (let cut = 1; cut < bytes.length; cut += 1) {
      const decoder = new CappedDecoder(64 * 1024);
      decoder.write(bytes.subarray(0, cut));
      decoder.write(bytes.subarray(cut));
      assert.equal(decoder.text, text, `split at byte ${cut}`);
    }
  });

  test("and the cap stops accumulating without corrupting what was kept", () => {
    const decoder = new CappedDecoder(10);
    const bytes = Buffer.from("가나다라마바사아자차", "utf8");
    for (let i = 0; i < bytes.length; i += 1) decoder.write(bytes.subarray(i, i + 1));
    assert.ok(!decoder.text.includes("�"), "one byte at a time must still decode");
    assert.ok(decoder.text.length <= 20);
  });

  test("a long Korean run through a real process comes back whole", async () => {
    // Written in pieces with flushes between, so the multi-byte characters land
    // on different reads. `chunk.toString()` per chunk would produce replacement
    // characters here; a decoder held across them does not.
    const { run, root } = await tools();
    // Large enough that the pipe flushes many times, so a boundary lands
    // mid-character somewhere. At 5 KB it fits in one flush and proves nothing.
    const script =
      "const s='가나다라마바사아자차카타파하'.repeat(500);" +
      "for(let i=0;i<40;i+=1)process.stdout.write(s);";
    const result = await run.execute({ executable: "node", args: `-e\n${script}` }, contextFor(root));

    assert.equal(result.ok, true, result.content);
    const shown = String(result.display);
    assert.ok(!shown.includes("�"), "a replacement character means a split was mishandled");
    assert.match(shown, /가나다라마바사아자차카타파하/);
  });
});

describe("25 — the dog/cat failure, as it should go now", () => {
  test("running a script in a subdirectory takes one call and no shell", async () => {
    // The whole sequence that failed — mkdir -p, mkdir, cd — is replaced by a
    // field. Nothing here depends on the platform.
    const { run, root } = await tools();
    await mkdir(join(root, "image_classification_project", "src"), { recursive: true });
    await writeFile(
      join(root, "image_classification_project", "src", "main.js"),
      "console.log('학습 시작');\n",
      "utf8",
    );

    const result = await run.execute(
      { executable: "node", args: "main.js", cwd: "image_classification_project/src" },
      contextFor(root),
    );

    assert.equal(result.ok, true, result.content);
    assert.match(String(result.display), /학습 시작/);
    assert.match(String(result.display), /image_classification_project\/src/, "the user is told where it ran");
  });

  test("and reaching for cd instead is answered with the field to use", async () => {
    const { run, root } = await tools();
    const result = await run.execute(
      { executable: "cd", args: "image_classification_project/src" },
      contextFor(root),
    );
    assert.equal(result.ok, false);
    assert.match(result.content, /cwd/);
  });
});
