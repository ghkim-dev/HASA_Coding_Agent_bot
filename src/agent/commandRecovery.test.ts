import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createRepoFixture, type RepoFixture } from "../testing/repo-fixture.ts";
import { createShellTools } from "./tools/shellTools.ts";
import { createBlockedTool } from "./tools/blockedTool.ts";
import { parseToolCall } from "./textTools.ts";
import { specFromLine } from "./commandSpec.ts";
import { parseCommandLine } from "./commandLine.ts";
import {
  INTERACTIVE_COMMAND_REQUIRES_PTY,
  INVALID_COMMAND_ARGUMENTS,
  classifyFailure,
  isExternalBlocker,
  validateSemantics,
} from "./commandSemantics.ts";
import {
  describeStall,
  newProgressState,
  observeAction,
  stallReason,
  type ActionObservation,
} from "./progress.ts";
import type { AgentTool, ToolContext } from "./types.ts";

/**
 * A command the agent got wrong is not a machine that cannot do it.
 *
 * The session this comes from, in order:
 *
 *     pip matplotlib   → unknown command "matplotlib"
 *     pip install      → you must give at least one requirement
 *     pip install      → the same
 *     python -m        → argument expected for the -m option
 *     python -m        → the same
 *     python -c        → argument expected for the -c option
 *     python           → REPL banner, exit 0
 *
 * and then: "패키지 설치가 불가능한 환경입니다."
 *
 * Every one of those spawned successfully. `pip` was found, it ran, and it
 * complained about its arguments — which is evidence that the environment
 * works. The agent read it as evidence that the environment does not, and
 * handed the user a blocker that was really its own typing.
 *
 * The audit question came first and its answer shapes everything here: the
 * arguments were **not** lost in the pipeline. Fed
 * `pip install torch torchvision matplotlib einops`, every path — legacy line,
 * text protocol, structured — preserves all five. The model wrote these
 * commands. So the fix is not in the parser.
 */

const fixtures: RepoFixture[] = [];
after(async () => {
  for (const f of fixtures) await f.dispose().catch(() => {});
});

function contextFor(root: string): ToolContext {
  return { signal: new AbortController().signal, workspaceRoot: root };
}

/** The command tool over a real workspace, and a record of what it spawned. */
async function shell(): Promise<{ run: AgentTool; root: string }> {
  const fixture = await createRepoFixture({ "a.ts": "export const a = 1;\n" });
  fixtures.push(fixture);
  const run = createShellTools({
    workspaceRoot: fixture.root,
    allowlist: [],
    isGitRepo: true,
  }).find((t) => t.name === "run_command");
  assert.ok(run !== undefined);
  return { run, root: fixture.root };
}

/** Whether a result is a pre-spawn refusal rather than a program's exit. */
function refusedBeforeSpawn(content: string): boolean {
  return /INVALID_COMMAND_|INTERACTIVE_COMMAND_|COMMAND_CWD_/.test(content);
}

describe("24 — the arguments were never the problem", () => {
  const parse = (line: string): { cmd: string; args: string[] } => {
    const parsed = parseCommandLine(line);
    return { cmd: parsed.cmd, args: parsed.args };
  };

  const WANTED = ["-m", "pip", "install", "torch", "torchvision", "matplotlib", "einops"];

  test("A — a legacy one-liner keeps every one", () => {
    const spec = specFromLine("python -m pip install torch torchvision matplotlib einops", parse);
    assert.equal(spec.mode, "exec");
    if (spec.mode !== "exec") return;
    assert.equal(spec.executable, "python");
    assert.deepEqual(spec.args, WANTED);
  });

  test("B — the text protocol keeps every one", () => {
    // Parameters arrive as tag bodies there, which is the path most likely to
    // lose something. It does not.
    const tool = {
      name: "run_command",
      risk: "execute",
      description: "run",
      parameters: {
        type: "object",
        properties: {
          executable: { type: "string" },
          args: { type: "string" },
          cwd: { type: "string" },
          command: { type: "string" },
        },
        required: [],
        additionalProperties: false,
      },
      summarize: () => "x",
      async execute() {
        return { ok: true, content: "" };
      },
    } as unknown as AgentTool;

    const { call } = parseToolCall(
      `<run_command>\n<executable>python</executable>\n<args>${WANTED.join("\n")}</args>\n<cwd>8_09</cwd>\n</run_command>`,
      [tool],
    );
    assert.ok(call !== null);
    const sent = call.arguments as Record<string, unknown>;
    assert.equal(sent["executable"], "python");
    assert.deepEqual(String(sent["args"]).split("\n"), WANTED);
    assert.equal(sent["cwd"], "8_09");
  });

  test("C — and so does the tool, all the way to what it reports running", async () => {
    // `node --version --help` is harmless and takes both arguments, so what is
    // shown is what was sent.
    const { run, root } = await shell();
    const result = await run.execute(
      { executable: "node", args: "-e\nconsole.log(process.argv.slice(1).join('|'))\nalpha\nbeta gamma\ndelta" },
      contextFor(root),
    );
    assert.equal(result.ok, true, result.content);
    assert.match(String(result.display), /alpha\|beta gamma\|delta/, "three arguments, one with a space");
  });
});

describe("4/21/22 — an incomplete invocation is caught before it runs", () => {
  test("python -m with no module", () => {
    const problem = validateSemantics({ mode: "exec", executable: "python", args: ["-m"] });
    assert.equal(problem?.code, INVALID_COMMAND_ARGUMENTS);
    assert.match(String(problem?.reason), /모듈/);
    assert.match(String(problem?.expected), /python -m pip/);
  });

  test("python -c with no code", () => {
    const problem = validateSemantics({ mode: "exec", executable: "python", args: ["-c"] });
    assert.equal(problem?.code, INVALID_COMMAND_ARGUMENTS);
    assert.match(String(problem?.reason), /코드/);
  });

  test("and the complete forms are fine", () => {
    assert.equal(validateSemantics({ mode: "exec", executable: "python", args: ["-m", "pip", "--version"] }), null);
    assert.equal(
      validateSemantics({ mode: "exec", executable: "python", args: ["-c", "import torch; print(1)"] }),
      null,
    );
    assert.equal(validateSemantics({ mode: "exec", executable: "node", args: ["-e", "console.log(1)"] }), null);
  });

  test("pip install with nothing to install", () => {
    for (const spec of [
      { mode: "exec" as const, executable: "pip", args: ["install"] },
      { mode: "exec" as const, executable: "python", args: ["-m", "pip", "install"] },
    ]) {
      const problem = validateSemantics(spec);
      assert.equal(problem?.code, INVALID_COMMAND_ARGUMENTS, JSON.stringify(spec.args));
      assert.match(String(problem?.expected), /torch/);
    }
  });

  test("`pip matplotlib` is missing its subcommand, and is told which", () => {
    const problem = validateSemantics({ mode: "exec", executable: "pip", args: ["matplotlib"] });
    assert.equal(problem?.code, INVALID_COMMAND_ARGUMENTS);
    assert.match(String(problem?.reason), /install/);
    assert.match(String(problem?.expected), /pip install matplotlib/);
  });

  test("6 — a requirements file counts as something to install", () => {
    assert.equal(
      validateSemantics({ mode: "exec", executable: "pip", args: ["install", "-r", "requirements.txt"] }),
      null,
    );
  });

  test("6 — and the validator keeps its hands off what it does not know", () => {
    // `npm install` with no package is perfectly meaningful. A validator that
    // guessed would start refusing correct work.
    for (const spec of [
      { mode: "exec" as const, executable: "npm", args: ["install"] },
      { mode: "exec" as const, executable: "pnpm", args: ["install"] },
      { mode: "exec" as const, executable: "pip", args: ["list"] },
      { mode: "exec" as const, executable: "make", args: [] },
      { mode: "exec" as const, executable: "somethingnew", args: ["-m"] },
    ]) {
      assert.equal(validateSemantics(spec), null, `${spec.executable} ${spec.args.join(" ")}`);
    }
  });

  test("a shell command is the shell's business", () => {
    assert.equal(validateSemantics({ mode: "shell", command: "python -m" }), null);
  });
});

describe("15/23 — a bare interpreter opens a session nobody can talk to", () => {
  test("it is refused rather than counted as a success", () => {
    for (const name of ["python", "python3", "node"]) {
      const problem = validateSemantics({ mode: "exec", executable: name, args: [] });
      assert.equal(problem?.code, INTERACTIVE_COMMAND_REQUIRES_PTY, name);
    }
  });

  test("through the tool, nothing spawns", async () => {
    // The transcript's last step: exit 0 and a banner, read as a working
    // Python and therefore as evidence about the environment.
    const { run, root } = await shell();
    const result = await run.execute({ executable: "python", args: "" }, contextFor(root));
    assert.equal(result.ok, false);
    assert.match(result.content, new RegExp(INTERACTIVE_COMMAND_REQUIRES_PTY));
    assert.equal(result.display, undefined, "nothing ran, so there is nothing to show");
  });

  test("with a script it is an ordinary call", () => {
    assert.equal(validateSemantics({ mode: "exec", executable: "python", args: ["main.py"] }), null);
  });
});

describe("9/10 — what a failure is evidence of", () => {
  test("an interpreter complaining about its own arguments is not the environment", () => {
    for (const detail of [
      "You must give at least one requirement to install",
      "Argument expected for the -m option",
      'ERROR: unknown command "matplotlib"',
      `${INVALID_COMMAND_ARGUMENTS}: 실행하지 않았습니다`,
    ]) {
      assert.equal(classifyFailure(detail), "invalid_invocation", detail);
      assert.equal(isExternalBlocker(classifyFailure(detail)), false, detail);
    }
  });

  test("but a missing binary, a refused permission and a dead network are", () => {
    assert.equal(classifyFailure("spawn python ENOENT"), "executable_not_found");
    assert.equal(classifyFailure("EACCES: permission denied"), "permission_denied");
    assert.equal(classifyFailure("getaddrinfo ENOTFOUND pypi.org"), "network_failure");
    for (const detail of ["spawn python ENOENT", "EACCES: permission denied", "getaddrinfo ENOTFOUND pypi.org"]) {
      assert.equal(isExternalBlocker(classifyFailure(detail)), true, detail);
    }
  });

  test("a plain non-zero exit says nothing on its own", () => {
    // Stretching a guess into a category would put confident wrong labels on
    // the evidence a blocker claim rests on.
    assert.equal(classifyFailure("exit 1"), "process_failed");
    assert.equal(isExternalBlocker("process_failed"), false);
  });
});

describe("11/19 — a blocked report needs something outside the model", () => {
  const args = {
    goal: "패키지 설치",
    obstacle: "설치가 되지 않습니다",
    tried: "pip install",
  };

  test("mistyped commands do not support one", async () => {
    // The claim from the transcript, refused. `pip` ran; that is evidence the
    // environment works.
    const tool = createBlockedTool({
      onBlocked: () => assert.fail("a blocked report was accepted on invalid-invocation evidence"),
      observedFailures: () => [
        "You must give at least one requirement to install",
        "Argument expected for the -m option",
      ],
    });
    const result = await tool.execute(args, undefined as never);
    assert.equal(result.ok, false);
    assert.notEqual(result.blocked, true, "the turn must not end here");
    assert.match(result.content, /명령 구성이 잘못된/);
  });

  test("a refused permission does", async () => {
    let reported = false;
    const tool = createBlockedTool({
      onBlocked: () => {
        reported = true;
      },
      observedFailures: () => ["EACCES: permission denied, mkdir '/usr/lib/python3'"],
    });
    const result = await tool.execute(args, undefined as never);
    assert.equal(result.blocked, true);
    assert.equal(reported, true);
  });

  test("so does a dead network", async () => {
    const tool = createBlockedTool({
      onBlocked: () => {},
      observedFailures: () => ["getaddrinfo ENOTFOUND pypi.org"],
    });
    assert.equal((await tool.execute(args, undefined as never)).blocked, true);
  });

  test("a turn that observed no failures at all is not second-guessed", async () => {
    // A blocker can be something no command could show — a missing credential,
    // a decision only the user can make.
    const tool = createBlockedTool({ onBlocked: () => {}, observedFailures: () => [] });
    assert.equal((await tool.execute(args, undefined as never)).blocked, true);
  });
});

describe("17/18 — the run says what actually went wrong", () => {
  function invalid(command: string): ActionObservation {
    return {
      toolName: "run_command",
      args: { command },
      outcome: "failed",
      detail: `${INVALID_COMMAND_ARGUMENTS}: \`${command}\` 은(는) 실행하지 않았습니다.`,
      changedFiles: [],
    };
  }

  test("repeated malformed commands are named as that", () => {
    const state = newProgressState();
    observeAction(state, invalid("pip install"));
    observeAction(state, invalid("python -m"));
    observeAction(state, invalid("python -c"));
    assert.equal(stallReason(state), "repeated_invalid_invocation");
  });

  test("and the user is not told their request was vague", () => {
    // The line the panel used to show. The request named CNN, Transformer,
    // dataset, training, evaluation and comparison; what repeated was the
    // agent's typing.
    const state = newProgressState();
    for (const c of ["pip install", "python -m", "python -c"]) observeAction(state, invalid(c));
    const message = describeStall(state, ["CNN 구현", "Transformer 구현"]);

    assert.match(message, /명령을 반복해서 잘못 구성/);
    // It says the request was *not* the problem, rather than merely avoiding
    // the word — the user is owed the correction, not silence about it.
    assert.match(message, /요청이 모호해서가 아니라/);
    assert.ok(!/구체적으로 알려|더 구체적으로/.test(message), "asking for more detail is the wrong instruction");
    assert.match(message, /CNN 구현/, "what is still outstanding");
  });

  test("a different repetition gets a different reason", () => {
    const state = newProgressState();
    for (const steps of ["A", "B", "C"]) {
      observeAction(state, {
        toolName: "update_plan",
        args: { steps },
        outcome: "executed",
        detail: "plan shown",
        changedFiles: [],
      });
    }
    assert.equal(stallReason(state), "plan_churn");
    assert.match(describeStall(state, []), /계획만 고쳐/);
  });
});

describe("20/25/26 — the whole sequence, and getting out of it", () => {
  test("every malformed attempt is refused, and the corrected one runs", async () => {
    const { run, root } = await shell();

    // What the model actually sent, in order.
    const attempts = [
      { executable: "pip", args: "matplotlib" },
      { executable: "pip", args: "install" },
      { executable: "pip", args: "install" },
      { executable: "python", args: "-m" },
      { executable: "python", args: "-c" },
      { executable: "python", args: "" },
    ];

    for (const attempt of attempts) {
      const result = await run.execute(attempt, contextFor(root));
      assert.equal(result.ok, false, JSON.stringify(attempt));
      assert.ok(refusedBeforeSpawn(result.content), `${JSON.stringify(attempt)} reached a spawn`);
      assert.equal(result.display, undefined, "nothing ran, so nothing is shown as having run");
    }

    // And the corrected form is not blocked by any of that.
    const corrected = await run.execute(
      { executable: "node", args: "-e\nconsole.log('installed')" },
      contextFor(root),
    );
    assert.equal(corrected.ok, true, corrected.content);
    assert.match(String(corrected.display), /installed/);
  });

  test("each refusal says what was missing and what to send", async () => {
    // A refusal without a fix is what produced the same mistake four times.
    const { run, root } = await shell();
    const result = await run.execute({ executable: "pip", args: "install" }, contextFor(root));
    assert.match(result.content, /대상이 하나 이상 필요/);
    assert.match(result.content, /python -m pip install torch/);
    assert.match(result.content, /환경 문제가 아니라/);
  });

  test("26 — none of it makes the task externally blocked", async () => {
    // "안된 부분들에 대해서 너가 직접 해결해줘" must not replay a blocker that
    // was never real.
    const failures = [
      'ERROR: unknown command "matplotlib"',
      "You must give at least one requirement to install",
      "Argument expected for the -m option",
    ];
    assert.ok(!failures.map(classifyFailure).some(isExternalBlocker));

    const tool = createBlockedTool({
      onBlocked: () => assert.fail("the task was reported blocked on the agent's own typing"),
      observedFailures: () => failures,
    });
    const result = await tool.execute(
      { goal: "패키지 설치", obstacle: "이 환경에서는 설치할 수 없습니다", tried: "pip install" },
      undefined as never,
    );
    assert.equal(result.ok, false);
    assert.match(result.content, /먼저 명령을 고쳐서 다시 시도/);
  });
});
