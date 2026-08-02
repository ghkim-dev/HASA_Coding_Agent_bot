import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { discoverRunnableScripts } from "./discoverCommands.ts";
import { assertRunnable } from "../core/commands.ts";
import type { CommandSpec } from "../protocol/index.ts";
import { commandLabels, createShellTools } from "./tools/shellTools.ts";

/**
 * Running the file the user is looking at.
 *
 * The failure this answers: a folder holding one `calculator.py` declares no
 * scripts, so no command tool was registered and the agent replied that the
 * workspace contained nothing runnable. True of `package.json`, false of the
 * file on screen — and worst for the people who most needed it to work, since
 * "make a project first" is the part they wanted help with.
 */

function workspace(tree: Record<string, string[]>) {
  return {
    listFiles: async (dir: string) => tree[dir] ?? [],
    hasExecutable: async (name: string) => ["python", "node"].includes(name),
  };
}

describe("finding something to run", () => {
  test("a lone Python file becomes a run command", async () => {
    const { commands } = await discoverRunnableScripts(workspace({ "": ["calculator.py"] }));
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.cmd, "python");
    assert.deepEqual(commands[0]?.args, ["calculator.py"]);
    assert.equal(commands[0]?.gate, "run");
  });

  test("the entry point comes first", async () => {
    // The model picks from this list in order, so `main.py` should lead.
    const { commands } = await discoverRunnableScripts(
      workspace({ "": ["zebra.py", "main.py", "helpers.py"] }),
    );
    assert.deepEqual(commands.map((c) => c.args[0]), ["main.py", "helpers.py", "zebra.py"]);
  });

  test("src/ is searched as well as the root", async () => {
    const { commands } = await discoverRunnableScripts(
      workspace({ "": [], src: ["app.py"] }),
    );
    assert.deepEqual(commands.map((c) => c.args[0]), ["src/app.py"]);
  });

  test("nothing deeper is searched, so a virtualenv is not a program", async () => {
    // A recursive walk finds `venv/lib/python3/site-packages/.../setup.py`,
    // which is nobody's program.
    const tree = workspace({ "": ["notes.txt"], src: [], "venv/lib": ["setup.py"] });
    const { commands } = await discoverRunnableScripts(tree);
    assert.deepEqual(commands, []);
  });

  test("JavaScript works the same way", async () => {
    const { commands } = await discoverRunnableScripts(workspace({ "": ["index.js"] }));
    assert.equal(commands[0]?.cmd, "node");
  });

  test("a shell script is never offered", async () => {
    // `bash deploy.sh` is arbitrary shell with an extra step, and the allowlist
    // exists precisely so there is no arbitrary shell.
    const { commands } = await discoverRunnableScripts(
      workspace({ "": ["deploy.sh", "setup.bat", "run.ps1"] }),
    );
    assert.deepEqual(commands, []);
  });

  test("a TypeScript file is not offered either", async () => {
    // Whether `node file.ts` works depends on the Node version, and a command
    // that fails for an invisible reason is worse than one never offered.
    const { commands } = await discoverRunnableScripts(workspace({ "": ["main.ts"] }));
    assert.deepEqual(commands, []);
  });

  test("the list is capped so the model can read it", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `file${i}.py`);
    const { commands } = await discoverRunnableScripts(workspace({ "": many }));
    assert.ok(commands.length <= 6, `offered ${commands.length}`);
  });

  test("an empty workspace offers nothing rather than guessing", async () => {
    const { commands, gaps } = await discoverRunnableScripts(workspace({ "": [] }));
    assert.deepEqual(commands, []);
    assert.deepEqual(gaps, []);
  });

  test("a listing that throws is not fatal", async () => {
    const { commands } = await discoverRunnableScripts({
      listFiles: async () => {
        throw new Error("EACCES");
      },
      hasExecutable: async () => true,
    });
    assert.deepEqual(commands, []);
  });
});

describe("when the interpreter is missing", () => {
  const noPython = {
    listFiles: async (dir: string) => (dir === "" ? ["calculator.py"] : []),
    hasExecutable: async () => false,
  };

  test("the gap is reported rather than silently swallowed", async () => {
    // Silence is what produced "this workspace contains no runnable scripts",
    // which told a beginner their file was the problem.
    const { commands, gaps } = await discoverRunnableScripts(noPython);
    assert.deepEqual(commands, []);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]?.language, "Python");
    assert.deepEqual(gaps[0]?.files, ["calculator.py"]);
  });

  test("the gap says how to fix it, with a real address", async () => {
    const { gaps } = await discoverRunnableScripts(noPython);
    assert.match(gaps[0]?.install ?? "", /python\.org/);
  });

  test("every interpreter is tried before declaring it missing", async () => {
    const tried: string[] = [];
    await discoverRunnableScripts({
      listFiles: async (dir) => (dir === "" ? ["a.py"] : []),
      hasExecutable: async (name) => {
        tried.push(name);
        return false;
      },
    });
    assert.deepEqual(tried, ["python", "python3", "py"]);
  });

  test("the first interpreter that answers is used and the rest are not probed", async () => {
    const tried: string[] = [];
    const { commands } = await discoverRunnableScripts({
      listFiles: async (dir) => (dir === "" ? ["a.py"] : []),
      hasExecutable: async (name) => {
        tried.push(name);
        return name === "python";
      },
    });
    assert.deepEqual(tried, ["python"]);
    assert.equal(commands[0]?.cmd, "python");
  });

  test("a probe that throws counts as missing, not as present", async () => {
    const { commands, gaps } = await discoverRunnableScripts({
      listFiles: async (dir) => (dir === "" ? ["a.py"] : []),
      hasExecutable: async () => {
        throw new Error("spawn failed");
      },
    });
    assert.deepEqual(commands, []);
    assert.equal(gaps.length, 1);
  });

  test("one language missing does not hide another that works", async () => {
    const { commands, gaps } = await discoverRunnableScripts({
      listFiles: async (dir) => (dir === "" ? ["a.py", "b.js"] : []),
      hasExecutable: async (name) => name === "node",
    });
    assert.deepEqual(commands.map((c) => c.cmd), ["node"]);
    assert.deepEqual(gaps.map((g) => g.language), ["Python"]);
  });
});

describe("the command still goes through the same gate", () => {
  test("a discovered run command passes assertRunnable", async () => {
    const { commands } = await discoverRunnableScripts(workspace({ "": ["calculator.py"] }));
    assert.doesNotThrow(() => assertRunnable(commands[0]!, commands));
  });

  test("a neighbouring file cannot be run just because one was discovered", () => {
    // The allowlist is matched on cmd and args exactly, so discovering
    // `calculator.py` does not license `python secrets.py`.
    const allow = [{ gate: "run" as const, kind: "acceptance" as const, cmd: "python", args: ["calculator.py"], timeoutMs: 1000 }];
    assert.throws(
      () => assertRunnable({ ...allow[0]!, args: ["secrets.py"] }, allow),
      /not_allowlisted|was not declared/,
    );
  });

  test("the interpreter cannot be swapped for a shell", () => {
    const allow = [{ gate: "run" as const, kind: "acceptance" as const, cmd: "python", args: ["a.py"], timeoutMs: 1000 }];
    assert.throws(() => assertRunnable({ ...allow[0]!, cmd: "bash" }, allow));
  });

  test("the tool is risk-gated as execute, so approval still applies", async () => {
    const { commands } = await discoverRunnableScripts(workspace({ "": ["calculator.py"] }));
    const tools = createShellTools({ workspaceRoot: "/w", allowlist: commands, isGitRepo: false });
    const run = tools.find((t) => t.name === "execute_command");
    assert.equal(run?.risk, "execute");
  });
});

describe("naming the commands", () => {
  const spec = (gate: "run" | "test", args: string[]) =>
    ({ gate, kind: "acceptance" as const, cmd: "python", args, timeoutMs: 1000 });

  test("a single command of a gate keeps the plain gate name", () => {
    assert.deepEqual([...commandLabels([spec("test", ["-m", "pytest"])]).keys()], ["test"]);
  });

  test("several run commands are distinguished by file", () => {
    // Keying by gate alone kept only the last, so a workspace with two scripts
    // silently lost one.
    const all = [spec("run", ["main.py"]), spec("run", ["tool.py"])];
    assert.deepEqual([...commandLabels(all).keys()].sort(), ["run main.py", "run tool.py"]);
  });

  test("two runtimes running the same filename both survive", () => {
    // Found by probing. `python src/main.py` and `node src/main.py` shorten to
    // the same label, and the map keying on it dropped one — the identical bug
    // one level down from the gate collision this labelling was added to fix.
    const all = [
      { gate: "run" as const, kind: "acceptance" as const, cmd: "python", args: ["src/main.py"], timeoutMs: 1 },
      { gate: "run" as const, kind: "acceptance" as const, cmd: "node", args: ["src/main.py"], timeoutMs: 1 },
    ];
    const labels = commandLabels(all);
    assert.equal(labels.size, 2, "one command was swallowed");
    assert.deepEqual(new Set([...labels.values()].map((s) => s.cmd)), new Set(["python", "node"]));
  });

  test("even byte-identical commands do not collapse", () => {
    // A caller bug rather than something to expect, but losing one silently is
    // worse than showing two.
    const one = spec("run", ["main.py"]);
    assert.equal(commandLabels([one, { ...one }]).size, 2);
  });

  test("every label maps back to the command it names", () => {
    const all: CommandSpec[] = [spec("test", ["-m", "pytest"]), spec("run", ["a.py"]), spec("run", ["b.py"])];
    for (const [label, resolved] of commandLabels(all)) {
      assert.ok(all.includes(resolved), `${label} resolves to a command not in the list`);
    }
  });

  test("every discovered command is reachable by its own label", async () => {
    const { commands } = await discoverRunnableScripts(
      workspace({ "": ["main.py", "helper.py", "other.py"] }),
    );
    assert.equal(commandLabels(commands).size, commands.length, "labels collide");
  });

  test("the tool description names each command so the model can choose", async () => {
    const { commands } = await discoverRunnableScripts(workspace({ "": ["main.py", "helper.py"] }));
    const tools = createShellTools({ workspaceRoot: "/w", allowlist: commands, isGitRepo: false });
    const description = tools.find((t) => t.name === "execute_command")?.description ?? "";
    assert.match(description, /main\.py/);
    assert.match(description, /helper\.py/);
  });
});
