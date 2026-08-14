import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sep } from "node:path";
import { parseCommandLine, UnparsableCommand } from "./commandLine.ts";
import {
  COMMAND_CWD_NOT_FOUND,
  COMMAND_CWD_OUTSIDE_WORKSPACE,
  INVALID_COMMAND_SHELL_SYNTAX,
  INVALID_COMMAND_USE_CWD,
  INVALID_COMMAND_USE_FILE_TOOL,
  displayCwd,
  isPrintOnlySpec,
  resolveCwd,
  specFromLine,
  specShape,
  validateSpec,
  type AgentCommandSpec,
} from "./commandSpec.ts";
import {
  INTERACTIVE_COMMAND_REQUIRES_PTY,
  INVALID_COMMAND_ARGUMENTS,
  bareName,
  classifyFailure,
  isExternalBlocker,
  validateSemantics,
} from "./commandSemantics.ts";
import { commandShape, structuralKey } from "./progress.ts";

/**
 * The other migration: a command line became a structured spec.
 *
 * Everything a model ever sent — a legacy one-liner, the text tool protocol's
 * tag body, a structured `exec` payload — now arrives at one `AgentCommandSpec`
 * and one spawn. A migration like that has exactly two ways to go wrong, and
 * both were seen in the field before it existed:
 *
 *   1. **Arguments disappear.** `pip install torch torchvision matplotlib` has
 *      to still be four tokens on the other side. The session that motivated
 *      this ran `pip install` with nothing after it, five times, and concluded
 *      the environment was broken.
 *   2. **A working call stops working.** Reading `(` as shell syntax turned
 *      `node -e "console.log(1)"` into a PowerShell invocation that failed.
 *
 * So the corpus below is swept for token preservation first and behaviour
 * second, and every expectation that could be written twice is computed once.
 */

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

interface Case {
  line: string;
  /** How the line must be read. */
  mode: "exec" | "shell";
  /** `validateSpec`'s verdict, by code. */
  spec?: string;
  /** `validateSemantics`'s verdict, by code. */
  semantics?: string;
  printOnly?: boolean;
}

const CASES: readonly Case[] = [
  // The transcript that produced all of this, line by line.
  { line: "pip matplotlib", mode: "exec", semantics: INVALID_COMMAND_ARGUMENTS },
  { line: "pip install", mode: "exec", semantics: INVALID_COMMAND_ARGUMENTS },
  { line: "pip uninstall", mode: "exec", semantics: INVALID_COMMAND_ARGUMENTS },
  { line: "pip download", mode: "exec", semantics: INVALID_COMMAND_ARGUMENTS },
  { line: "pip3 install", mode: "exec", semantics: INVALID_COMMAND_ARGUMENTS },
  { line: "python -m", mode: "exec", semantics: INVALID_COMMAND_ARGUMENTS },
  { line: "python -c", mode: "exec", semantics: INVALID_COMMAND_ARGUMENTS },
  { line: "python", mode: "exec", semantics: INTERACTIVE_COMMAND_REQUIRES_PTY },
  { line: "python3", mode: "exec", semantics: INTERACTIVE_COMMAND_REQUIRES_PTY },
  { line: "node", mode: "exec", semantics: INTERACTIVE_COMMAND_REQUIRES_PTY },
  { line: "irb", mode: "exec", semantics: INTERACTIVE_COMMAND_REQUIRES_PTY },
  { line: "ruby", mode: "exec", semantics: INTERACTIVE_COMMAND_REQUIRES_PTY },
  { line: "php", mode: "exec", semantics: INTERACTIVE_COMMAND_REQUIRES_PTY },
  { line: "node -e", mode: "exec", semantics: INVALID_COMMAND_ARGUMENTS },
  { line: "node --eval", mode: "exec", semantics: INVALID_COMMAND_ARGUMENTS },
  { line: "python -m pip install", mode: "exec", semantics: INVALID_COMMAND_ARGUMENTS },

  // The same commands, said properly. These must run.
  { line: "pip install torch torchvision matplotlib einops", mode: "exec" },
  { line: "python -m pip install torch torchvision matplotlib einops", mode: "exec" },
  { line: "pip install -r requirements.txt", mode: "exec" },
  { line: "pip list", mode: "exec" },
  { line: "pip freeze", mode: "exec" },
  { line: "pip show numpy", mode: "exec" },
  { line: "pip check", mode: "exec" },
  { line: "python -m pytest -q", mode: "exec" },
  { line: "python train.py --epochs 10", mode: "exec" },
  { line: "python3 -m venv .venv", mode: "exec" },
  { line: "npm install", mode: "exec" },
  { line: "npm install --save-dev typescript", mode: "exec" },
  { line: "npm run build", mode: "exec" },
  { line: "pnpm test", mode: "exec" },
  { line: "pnpm install", mode: "exec" },
  { line: "pytest -q", mode: "exec" },
  { line: "pytest tests/test_model.py::test_forward -q", mode: "exec" },
  { line: "cargo test --all", mode: "exec" },
  { line: "go test ./...", mode: "exec" },
  { line: "tsc --noEmit", mode: "exec" },
  { line: "git status --porcelain", mode: "exec" },
  { line: "git log --oneline -10", mode: "exec" },
  { line: "ls -la", mode: "exec" },

  // The regression: parentheses and braces are not shell syntax.
  { line: 'node -e "console.log(1)"', mode: "exec", printOnly: true },
  { line: 'node --eval "console.log(process.version)"', mode: "exec", printOnly: true },
  { line: 'python -c "print(1)"', mode: "exec", printOnly: true },
  { line: 'python -c "print(\'모든 코드가 정상적으로 작동합니다\')"', mode: "exec", printOnly: true },
  { line: 'python -c "import torch; print(torch.__version__)"', mode: "exec" },
  { line: 'node -e "require(\'fs\').writeFileSync(\'a\',\'b\')"', mode: "exec" },
  { line: 'python -c "{1:2}"', mode: "exec" },
  { line: "jq '.data[]' out.json", mode: "exec" },

  // Quoting: an operator inside quotes is data.
  { line: 'git commit -m "fix > bug"', mode: "exec" },
  { line: 'git commit -m "a | b"', mode: "exec" },
  { line: 'git commit -m "x && y"', mode: "exec" },
  { line: 'git commit -m "semi; colon"', mode: "exec" },
  { line: "git commit -m 'single | quoted'", mode: "exec" },
  { line: 'grep -r "TODO" src', mode: "exec" },
  { line: 'echo "hello world"', mode: "exec", printOnly: true },

  // Paths with spaces stay one argument.
  { line: 'python "C:\\Program Files\\app\\main.py"', mode: "exec" },
  { line: 'node "my dir/index.js"', mode: "exec" },
  { line: 'cat "a file with spaces.txt"', mode: "exec" },

  // Genuinely needs a shell.
  { line: "python a.py | python b.py", mode: "shell" },
  { line: "cat a.txt | head -5", mode: "shell" },
  { line: "pytest -q > out.txt", mode: "shell" },
  { line: "pytest -q >> out.txt", mode: "shell" },
  { line: "python main.py < input.txt", mode: "shell" },
  { line: "npm run build && npm test", mode: "shell" },
  { line: "cd src; python main.py", mode: "shell" },
  { line: "ls | wc -l", mode: "shell" },
  { line: "echo hi > a.txt", mode: "shell", printOnly: true },

  // The working directory, said in the only vocabulary a line has.
  { line: "cd src", mode: "exec", spec: INVALID_COMMAND_USE_CWD },
  { line: "cd image_classification_project/src", mode: "exec", spec: INVALID_COMMAND_USE_CWD },
  { line: "chdir build", mode: "exec", spec: INVALID_COMMAND_USE_CWD },
  { line: "pushd src", mode: "exec", spec: INVALID_COMMAND_USE_CWD },
  { line: "popd", mode: "exec", spec: INVALID_COMMAND_USE_CWD },
  { line: "export PATH=/x", mode: "exec", spec: INVALID_COMMAND_USE_CWD },
  { line: "set FOO=bar", mode: "exec", spec: INVALID_COMMAND_USE_CWD },
  { line: "source .venv/bin/activate", mode: "exec", spec: INVALID_COMMAND_USE_CWD },

  // The half of the failure one step earlier.
  { line: "mkdir -p a/b/c", mode: "exec", spec: INVALID_COMMAND_USE_FILE_TOOL },
  { line: "mkdir src", mode: "exec", spec: INVALID_COMMAND_USE_FILE_TOOL },
  { line: "md src", mode: "exec", spec: INVALID_COMMAND_USE_FILE_TOOL },
  { line: "New-Item -ItemType Directory src", mode: "exec", spec: INVALID_COMMAND_USE_FILE_TOOL },
  { line: "rmdir build", mode: "exec", spec: INVALID_COMMAND_USE_FILE_TOOL },
  { line: "mkdir.exe src", mode: "exec", spec: INVALID_COMMAND_USE_FILE_TOOL },
  { line: "CD src", mode: "exec", spec: INVALID_COMMAND_USE_CWD },
  { line: "MKDIR src", mode: "exec", spec: INVALID_COMMAND_USE_FILE_TOOL },

  // Only prints what it was told to print.
  { line: "echo hello", mode: "exec", printOnly: true },
  { line: 'echo "ALL TESTS PASSED"', mode: "exec", printOnly: true },
  { line: 'python -c "print(\'프로젝트 완료\')"', mode: "exec", printOnly: true },
  { line: 'python -c "print(\'프로젝트 최종 완료\')"', mode: "exec", printOnly: true },
  { line: 'python -c "print(\'모든 구성 요소 정상\')"', mode: "exec", printOnly: true },
];

const parse = (line: string): { cmd: string; args: string[] } => parseCommandLine(line);

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

describe("migration · one line in, one spec out", () => {
  for (const testCase of CASES) {
    const label = JSON.stringify(testCase.line);

    test(`${label} — is read as ${testCase.mode}`, () => {
      assert.equal(specFromLine(testCase.line, parse).mode, testCase.mode);
    });

    test(`${label} — reading it twice reads the same thing`, () => {
      assert.deepEqual(specFromLine(testCase.line, parse), specFromLine(testCase.line, parse));
    });

    test(`${label} — surrounding whitespace changes nothing`, () => {
      assert.deepEqual(
        specFromLine(`  ${testCase.line}  `, parse),
        specFromLine(testCase.line, parse),
      );
    });

    test(`${label} — validateSpec says ${testCase.spec ?? "nothing"}`, () => {
      const problem = validateSpec(specFromLine(testCase.line, parse));
      assert.equal(problem?.code ?? undefined, testCase.spec);
    });

    test(`${label} — validateSemantics says ${testCase.semantics ?? "nothing"}`, () => {
      const problem = validateSemantics(specFromLine(testCase.line, parse));
      assert.equal(problem?.code ?? undefined, testCase.semantics);
    });

    test(`${label} — print-only is ${testCase.printOnly === true}`, () => {
      assert.equal(isPrintOnlySpec(specFromLine(testCase.line, parse)), testCase.printOnly === true);
    });

    test(`${label} — has a stable shape`, () => {
      const shape = specShape(specFromLine(testCase.line, parse));
      assert.equal(typeof shape, "string");
      assert.ok(shape.length > 0);
      assert.equal(shape, specShape(specFromLine(testCase.line, parse)));
    });

    test(`${label} — a refusal names the field or tool to use instead`, () => {
      const problem = validateSpec(specFromLine(testCase.line, parse));
      if (problem === null) return;
      if (problem.code === INVALID_COMMAND_USE_CWD) {
        assert.match(problem.message, /cwd|env|shell/);
      } else if (problem.code === INVALID_COMMAND_USE_FILE_TOOL) {
        assert.match(problem.message, /create_file|사용자에게/);
      }
      assert.ok(problem.message.length > 0);
    });

    if (testCase.mode === "exec") {
      test(`${label} — every token survives into the argument vector`, () => {
        const spec = specFromLine(testCase.line, parse);
        assert.equal(spec.mode, "exec");
        if (spec.mode !== "exec") return;
        const direct = parseCommandLine(testCase.line);
        assert.equal(spec.executable, direct.cmd);
        assert.deepEqual(spec.args, direct.args);
      });

      test(`${label} — nothing is silently dropped`, () => {
        const spec = specFromLine(testCase.line, parse);
        if (spec.mode !== "exec") return;
        // Every whitespace-separated run of the original still appears in the
        // executable or the arguments. Quotes are removed from both sides: they
        // are the notation that says where an argument ends, and the whole
        // point of the vector is that they are gone by the time it exists.
        const unquote = (s: string): string => s.replace(/["']/g, "");
        const joined = unquote([spec.executable, ...spec.args].join(" "));
        for (const token of unquote(testCase.line).split(/\s+/).filter((t) => t.length > 0)) {
          assert.ok(
            joined.includes(token),
            `token ${JSON.stringify(token)} vanished from ${JSON.stringify(joined)}`,
          );
        }
      });

      test(`${label} — the executable is one token, never a command line`, () => {
        const spec = specFromLine(testCase.line, parse);
        if (spec.mode !== "exec") return;
        assert.ok(!/\s/.test(spec.executable), "an executable with a space in it is a command line");
      });

      test(`${label} — a structured caller sending the same fields gets the same verdicts`, () => {
        const fromLine = specFromLine(testCase.line, parse);
        if (fromLine.mode !== "exec") return;
        const structured: AgentCommandSpec = {
          mode: "exec",
          executable: fromLine.executable,
          args: [...fromLine.args],
        };
        assert.deepEqual(validateSpec(structured), validateSpec(fromLine));
        assert.deepEqual(validateSemantics(structured), validateSemantics(fromLine));
        assert.equal(isPrintOnlySpec(structured), isPrintOnlySpec(fromLine));
        assert.equal(specShape(structured), specShape(fromLine));
      });
    }

    if (testCase.mode === "shell") {
      test(`${label} — the line reaches the shell whole`, () => {
        const spec = specFromLine(testCase.line, parse);
        assert.equal(spec.mode, "shell");
        if (spec.mode !== "shell") return;
        assert.equal(spec.command, testCase.line.trim());
      });

      test(`${label} — an exec payload is never quietly turned into one`, () => {
        // The same text offered as a structured exec is refused, not run.
        const problem = validateSpec({ mode: "exec", executable: testCase.line, args: [] });
        assert.notEqual(problem, null);
      });
    }

    test(`${label} — a cwd rides along without changing how the line is read`, () => {
      const bare = specFromLine(testCase.line, parse);
      const withCwd = specFromLine(testCase.line, parse, "sub/dir");
      assert.equal(withCwd.mode, bare.mode);
      assert.equal(withCwd.cwd, "sub/dir");
      assert.equal(bare.cwd, undefined);
      assert.deepEqual({ ...withCwd, cwd: undefined }, { ...bare, cwd: undefined });
    });
  }
});

// ---------------------------------------------------------------------------
// The three celebratory one-liners are one shape
// ---------------------------------------------------------------------------

describe("migration · a different sentence is not a different operation", () => {
  const CELEBRATIONS = [
    'python -c "print(\'프로젝트 완료\')"',
    'python -c "print(\'프로젝트 최종 완료\')"',
    'python -c "print(\'모든 구성 요소 정상\')"',
    'python -c "print(\'all tests passed\')"',
    'python -c "print(1)"',
  ];

  for (const [i, a] of CELEBRATIONS.entries()) {
    for (const b of CELEBRATIONS.slice(i + 1)) {
      test(`${JSON.stringify(a)} and ${JSON.stringify(b)} are one shape`, () => {
        assert.equal(
          specShape(specFromLine(a, parse)),
          specShape(specFromLine(b, parse)),
          "three different strings that verify nothing must not look like three steps",
        );
      });
    }
  }

  test("two real test runs are the same kind of operation", () => {
    assert.equal(commandShape("pytest test_a.py"), commandShape("pytest test_b.py"));
    assert.equal(commandShape("pytest test_a.py"), "verifier");
  });

  test("but they are told apart by their target, so running both is not a loop", () => {
    // Finer than the doc's illustration, and deliberately on the safe side:
    // two different test files never trip LEVEL 2 at all.
    assert.notEqual(
      specShape(specFromLine("pytest test_a.py", parse)),
      specShape(specFromLine("pytest test_b.py", parse)),
    );
  });

  test("celebrations collapse to one key while real commands do not", () => {
    const key = (command: string): string =>
      structuralKey({ toolName: "run_command", args: { command }, outcome: "executed", detail: "", changedFiles: [] });
    assert.equal(key("python -c \"print('완료')\""), key("python -c \"print('최종 완료')\""));
    assert.equal(key("python -c \"print('완료')\""), "run_command:print_only");
    assert.notEqual(key("pytest test_a.py"), key("pytest test_b.py"));
  });

  test("a print-only call and a real one are different shapes", () => {
    assert.notEqual(
      specShape(specFromLine('python -c "print(1)"', parse)),
      specShape(specFromLine("pytest -q", parse)),
    );
  });

  test("importing something is not printing something", () => {
    assert.equal(isPrintOnlySpec(specFromLine('python -c "import torch; print(torch.__version__)"', parse)), false);
  });
});

// ---------------------------------------------------------------------------
// bareName, across the spellings a program arrives in
// ---------------------------------------------------------------------------

describe("migration · a program is the same program however it is spelled", () => {
  const SPELLINGS: ReadonlyArray<readonly [string, string]> = [
    ["python", "python"],
    ["Python", "python"],
    ["PYTHON", "python"],
    ["python.exe", "python"],
    ["python.EXE", "python"],
    ["/usr/bin/python", "python"],
    ["/usr/local/bin/python3", "python3"],
    ["node", "node"],
    ["node.exe", "node"],
    ["npm.cmd", "npm"],
    ["yarn.bat", "yarn"],
    ["pip3", "pip3"],
    ["", ""],
  ];

  for (const [spelling, expected] of SPELLINGS) {
    test(`${JSON.stringify(spelling)} is ${JSON.stringify(expected)}`, () => {
      assert.equal(bareName(spelling), expected);
    });
  }

  for (const spelled of ["python", "python.exe", "PYTHON", "Python.EXE"]) {
    test(`bare ${spelled} is still a REPL nobody can talk to`, () => {
      assert.equal(
        validateSemantics({ mode: "exec", executable: spelled, args: [] })?.code,
        INTERACTIVE_COMMAND_REQUIRES_PTY,
      );
    });

    test(`${spelled} with a script is left alone`, () => {
      assert.equal(validateSemantics({ mode: "exec", executable: spelled, args: ["main.py"] }), null);
    });
  }
});

// ---------------------------------------------------------------------------
// What is deliberately not judged
// ---------------------------------------------------------------------------

describe("migration · an unrecognised command is allowed to run", () => {
  const UNKNOWN = [
    "npm install",
    "yarn",
    "make",
    "cmake --build .",
    "docker build .",
    "terraform plan",
    "kubectl get pods",
    "some-tool-nobody-has-heard-of --flag",
    "cargo",
    "go",
  ];

  for (const line of UNKNOWN) {
    test(`${JSON.stringify(line)} passes semantics unjudged`, () => {
      assert.equal(validateSemantics(specFromLine(line, parse)), null);
    });
  }

  test("a shell command's syntax is the shell's business", () => {
    assert.equal(validateSemantics({ mode: "shell", command: "python -m" }), null);
    assert.equal(validateSemantics({ mode: "shell", command: "pip install" }), null);
  });

  test("an empty shell command is still refused", () => {
    assert.equal(validateSpec({ mode: "shell", command: "   " })?.code, INVALID_COMMAND_SHELL_SYNTAX);
  });

  test("an empty executable is refused", () => {
    assert.equal(validateSpec({ mode: "exec", executable: "  ", args: [] })?.code, INVALID_COMMAND_SHELL_SYNTAX);
  });
});

// ---------------------------------------------------------------------------
// The line the old parser refused
// ---------------------------------------------------------------------------

describe("migration · parseCommandLine still refuses what it cannot honour", () => {
  const REFUSED = [
    "a && b",
    "a || b",
    "a | b",
    "a ; b",
    "a > b",
    "a >> b",
    "a < b",
    "a $(b)",
    "a `b`",
  ];

  for (const line of REFUSED) {
    test(`${JSON.stringify(line)} is unparsable as a single program`, () => {
      assert.throws(() => parseCommandLine(line), UnparsableCommand);
    });

    test(`${JSON.stringify(line)} never becomes an exec spec that would spawn nonsense`, () => {
      // Two layers, and they draw the line in different places. `needsShell` is
      // narrow — only `|`, `>`, `<`, `;`, `&&` outside quotes — so `$(…)` and a
      // backtick fall through to the parser, which refuses them by throwing.
      // Either answer is safe; what must never happen is an exec spec whose
      // executable is a whole command line, which is the ENOENT naming a
      // program nobody meant to run.
      let spec: AgentCommandSpec | null = null;
      try {
        spec = specFromLine(line, parse);
      } catch (err) {
        assert.ok(err instanceof UnparsableCommand, "refusals are UnparsableCommand, which the tool catches");
        assert.ok((err as UnparsableCommand).guidance.length > 0, "and they say what to do instead");
        return;
      }
      if (spec.mode === "exec") {
        assert.ok(!/\s/.test(spec.executable));
        assert.equal(validateSpec(spec), null);
      } else {
        assert.equal(spec.command, line);
      }
    });
  }

  const KEPT = [
    'git commit -m "fix > bug"',
    "git commit -m 'a | b'",
    'echo "a && b"',
    'python -c "print(1 > 0)"',
  ];

  for (const line of KEPT) {
    test(`${JSON.stringify(line)} is one command with punctuation in it`, () => {
      assert.doesNotThrow(() => parseCommandLine(line));
      assert.equal(specFromLine(line, parse).mode, "exec");
    });
  }
});

// ---------------------------------------------------------------------------
// Where it runs
// ---------------------------------------------------------------------------

describe("migration · the working directory is a field, and it is bounded", () => {
  // `resolveCwd` joins with the platform's own separator, so the fake
  // filesystem answers in the platform's own spelling too. A probe that only
  // understood `/` would pass on Linux and fail on the machine the original
  // transcript came from, which is the wrong way round for this file.
  const ROOT = sep === "\\" ? "C:\\ws" : "/ws";
  const norm = (p: string): string => p.split(/[\\/]/).join("/").replace(/\/$/, "");
  const ROOT_N = norm(ROOT);
  /** What is actually on this fake disk. Anything else is ENOENT. */
  const EXISTS = new Set([ROOT_N, `${ROOT_N}/src`, `${ROOT_N}/a`, `${ROOT_N}/a/b`, `${ROOT_N}/a/b/c`, `${ROOT_N}/a.txt`]);
  const OUTSIDE = norm(sep === "\\" ? "C:\\elsewhere" : "/elsewhere");
  const probe = {
    realpath: async (p: string): Promise<string> => {
      const n = norm(p);
      if (n === `${ROOT_N}/link-out`) return OUTSIDE;
      if (EXISTS.has(n)) return p.replace(/[\\/]$/, "");
      throw new Error("ENOENT");
    },
    isDirectory: async (p: string): Promise<boolean> => !p.endsWith(".txt"),
  };

  const CWDS: ReadonlyArray<{ name: string; asked: string | undefined; ok: boolean; code?: string }> = [
    { name: "absent", asked: undefined, ok: true },
    { name: "empty", asked: "", ok: true },
    { name: "whitespace", asked: "   ", ok: true },
    { name: "relative", asked: "src", ok: true },
    { name: "nested relative", asked: "a/b/c", ok: true },
    { name: "absolute inside", asked: `${ROOT}${sep}src`, ok: true },
    { name: "the root itself", asked: ROOT, ok: true },
    { name: "missing", asked: "nope", ok: false, code: COMMAND_CWD_NOT_FOUND },
    { name: "a file, not a directory", asked: "a.txt", ok: false, code: COMMAND_CWD_NOT_FOUND },
    { name: "absolute outside", asked: sep === "\\" ? "C:\\etc" : "/etc", ok: false, code: COMMAND_CWD_NOT_FOUND },
  ];

  for (const c of CWDS) {
    test(`cwd ${c.name} — ${c.ok ? "resolves" : `is refused with ${c.code}`}`, async () => {
      const result = await resolveCwd(c.asked, ROOT, probe);
      assert.equal(result.ok, c.ok, JSON.stringify(result));
      if (!result.ok) assert.equal(result.problem.code, c.code);
    });

    test(`cwd ${c.name} — never resolves outside the workspace`, async () => {
      const result = await resolveCwd(c.asked, ROOT, probe);
      if (result.ok) assert.ok(norm(result.path) === ROOT_N || norm(result.path).startsWith(`${ROOT_N}/`));
    });
  }

  test("a symlink pointing out of the workspace is caught, not followed", async () => {
    const result = await resolveCwd("link-out", ROOT, probe);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.problem.code, COMMAND_CWD_OUTSIDE_WORKSPACE);
  });

  test("displayCwd shows the root as a dot", () => {
    assert.equal(displayCwd(ROOT, ROOT), ".");
  });
});

// ---------------------------------------------------------------------------
// A mistyped command is not a broken machine
// ---------------------------------------------------------------------------

describe("migration · what kind of failure this was", () => {
  const FAILURES: ReadonlyArray<{ detail: string; kind: string }> = [
    // The agent's own typing.
    { detail: "INVALID_COMMAND_ARGUMENTS: `pip install` 은(는) 실행하지 않았습니다.", kind: "invalid_invocation" },
    { detail: "INTERACTIVE_COMMAND_REQUIRES_PTY", kind: "invalid_invocation" },
    { detail: "INVALID_COMMAND_USE_CWD", kind: "invalid_invocation" },
    { detail: "INVALID_COMMAND_USE_FILE_TOOL", kind: "invalid_invocation" },
    { detail: "ERROR: You must give at least one requirement to install", kind: "invalid_invocation" },
    { detail: "Argument expected for the -m option", kind: "invalid_invocation" },
    { detail: "Argument expected for the -c option", kind: "invalid_invocation" },
    { detail: 'ERROR: unknown command "matplotlib"', kind: "invalid_invocation" },
    { detail: "error: no such option: --nope", kind: "invalid_invocation" },
    { detail: "argument --x: expected one argument", kind: "invalid_invocation" },

    // The machine.
    { detail: "spawn python ENOENT", kind: "executable_not_found" },
    { detail: "'pytest' is not recognized as an internal or external command", kind: "executable_not_found" },
    { detail: "bash: cargo: command not found", kind: "executable_not_found" },
    { detail: "torch is not installed", kind: "executable_not_found" },
    { detail: "EACCES: permission denied, open '/etc/shadow'", kind: "permission_denied" },
    { detail: "EPERM: operation not permitted", kind: "permission_denied" },
    { detail: "Access is denied.", kind: "permission_denied" },
    { detail: "getaddrinfo ENOTFOUND pypi.org", kind: "network_failure" },
    { detail: "connect ECONNREFUSED 127.0.0.1:8080", kind: "network_failure" },
    { detail: "connect ETIMEDOUT", kind: "network_failure" },
    { detail: "Temporary failure in name resolution", kind: "network_failure" },
    { detail: "network is unreachable", kind: "network_failure" },
    { detail: "proxy authentication required", kind: "network_failure" },
    { detail: "sandbox violation: write outside workspace", kind: "sandbox_denied" },
    { detail: "COMMAND_CWD_OUTSIDE_WORKSPACE", kind: "sandbox_denied" },
    { detail: "The user declined this action", kind: "approval_denied" },
    { detail: "사용자가 승인하지 않았습니다", kind: "approval_denied" },
    { detail: "the command timed out after 60s", kind: "timeout" },
    { detail: "시간 제한을 넘었습니다", kind: "timeout" },

    // Ran, and said nothing about why.
    { detail: "exit 1", kind: "process_failed" },
    { detail: "exit 2: 3 tests failed", kind: "process_failed" },
    { detail: "", kind: "unknown_failure" },
    { detail: "something happened", kind: "unknown_failure" },
    { detail: "exit 0", kind: "unknown_failure" },
  ];

  for (const failure of FAILURES) {
    test(`${JSON.stringify(failure.detail.slice(0, 46))} is ${failure.kind}`, () => {
      assert.equal(classifyFailure(failure.detail), failure.kind);
    });

    test(`${JSON.stringify(failure.detail.slice(0, 46))} ${
      failure.kind === "invalid_invocation" ? "cannot" : "may or may not"
    } support a blocker claim`, () => {
      const external = isExternalBlocker(classifyFailure(failure.detail));
      if (failure.kind === "invalid_invocation") {
        assert.equal(external, false, "a mistyped command is not evidence about the environment");
      }
      if (failure.kind === "process_failed") {
        assert.equal(external, false, "a non-zero exit is usually a fact about the code");
      }
    });
  }

  test("every failure the transcript produced is the agent's own, so none of them is a blocker", () => {
    const transcript = [
      'ERROR: unknown command "matplotlib"',
      "ERROR: You must give at least one requirement to install",
      "Argument expected for the -m option",
      "Argument expected for the -c option",
    ];
    for (const detail of transcript) {
      assert.equal(classifyFailure(detail), "invalid_invocation");
      assert.equal(isExternalBlocker(classifyFailure(detail)), false);
    }
  });
});
