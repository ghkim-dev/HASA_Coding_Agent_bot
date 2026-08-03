import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseCommandLine, UnparsableCommand } from "./commandLine.ts";

/**
 * Splitting a command line without a shell.
 *
 * The reason a free-form string is safe to accept here is that nothing
 * re-interprets it: the tokens go to `spawn` as an argv array with
 * `shell: false`, so a metacharacter that survives tokenisation arrives at the
 * program as a literal character rather than as syntax. These tests are that
 * claim, written down.
 */

function refusal(line: string): UnparsableCommand {
  try {
    parseCommandLine(line);
  } catch (err) {
    assert.ok(err instanceof UnparsableCommand, `expected a refusal, got ${String(err)}`);
    return err;
  }
  return assert.fail(`expected ${JSON.stringify(line)} to be refused`);
}

describe("ordinary commands", () => {
  test("the executable and its arguments come apart on whitespace", () => {
    assert.deepEqual(parseCommandLine("pip install transformers torch"), {
      cmd: "pip",
      args: ["install", "transformers", "torch"],
    });
  });

  test("runs of whitespace are one separator, not several empty arguments", () => {
    assert.deepEqual(parseCommandLine("  python   train.py  "), { cmd: "python", args: ["train.py"] });
  });

  test("a bare command has no arguments", () => {
    assert.deepEqual(parseCommandLine("pytest"), { cmd: "pytest", args: [] });
  });

  test("flags with values survive intact", () => {
    assert.deepEqual(parseCommandLine("python train.py --epochs 1 --lr 3e-4"), {
      cmd: "python",
      args: ["train.py", "--epochs", "1", "--lr", "3e-4"],
    });
  });
});

describe("quotes", () => {
  test("a quoted argument stays one argument", () => {
    assert.deepEqual(parseCommandLine('git commit -m "fix the parser"'), {
      cmd: "git",
      args: ["commit", "-m", "fix the parser"],
    });
  });

  test("single quotes work too, and do not process escapes", () => {
    assert.deepEqual(parseCommandLine("python 'C:\\Users\\IT\\a.py'"), {
      cmd: "python",
      args: ["C:\\Users\\IT\\a.py"],
    });
  });

  test("a backslash is a path separator, not an escape", () => {
    // Found by a test, on the platform this runs on. Treating `\` the way a
    // POSIX shell does turned "C:\Program Files\app\main.py" into
    // "C:Program Filesappmain.py" — quoted *and* unquoted.
    assert.deepEqual(parseCommandLine("python C:\\Users\\IT\\a.py"), {
      cmd: "python",
      args: ["C:\\Users\\IT\\a.py"],
    });
    assert.deepEqual(parseCommandLine('python "C:\\Users\\IT\\my file.py"'), {
      cmd: "python",
      args: ["C:\\Users\\IT\\my file.py"],
    });
  });

  test("an escaped quote inside double quotes is a quote", () => {
    assert.deepEqual(parseCommandLine('node -e "console.log(\\"hi\\")"'), {
      cmd: "node",
      args: ["-e", 'console.log("hi")'],
    });
  });

  test("an empty quoted argument is still an argument", () => {
    assert.deepEqual(parseCommandLine('grep "" file.txt'), { cmd: "grep", args: ["", "file.txt"] });
  });

  test("an unclosed quote is refused rather than guessed at", () => {
    assert.match(refusal('git commit -m "unfinished').guidance, /unclosed quote/i);
  });
});

describe("shell operators are refused, not silently mangled", () => {
  // Without a shell, `pip install x && python y.py` runs pip with the arguments
  // `&&`, `python` and `y.py`: no error, no install, and a model with no way to
  // tell why. A refusal turns that into one more tool call.
  test("&& and || and ; ask for separate calls", () => {
    for (const line of ["pip install x && python y.py", "a || b", "cd x; ls"]) {
      assert.match(refusal(line).guidance, /one at a time|separate calls/i, line);
    }
  });

  test("a pipe says a pipe is not available", () => {
    assert.match(refusal("cat a.txt | grep x").guidance, /pipe/i);
  });

  test("redirection points at the file tools instead", () => {
    for (const line of ["python a.py > out.txt", "python a.py >> out.txt", "python a.py < in.txt"]) {
      assert.match(refusal(line).guidance, /redirection/i, line);
    }
  });

  test("command substitution is refused in both spellings", () => {
    for (const line of ["echo $(whoami)", "echo `whoami`"]) {
      assert.match(refusal(line).guidance, /substitution/i, line);
    }
  });

  test("an operator inside quotes is data, and stays", () => {
    // The distinction that keeps the refusals from being wrong: this is one
    // command with an ampersand in a message, not a pipeline.
    assert.deepEqual(parseCommandLine('git commit -m "fix a && b"'), {
      cmd: "git",
      args: ["commit", "-m", "fix a && b"],
    });
    assert.deepEqual(parseCommandLine('python -c "print(1 > 0)"'), {
      cmd: "python",
      args: ["-c", "print(1 > 0)"],
    });
  });

  test("a newline is refused, because two lines are two commands", () => {
    assert.match(refusal("pip install x\npython y.py").guidance, /one command on one line/i);
  });
});

describe("nothing to run", () => {
  test("an empty line is refused", () => {
    for (const line of ["", "   ", "\t"]) assert.match(refusal(line).guidance, /No command was given/i);
  });
});

describe("what reaches spawn is literal", () => {
  test("a semicolon that survived quoting is one argument, not a separator", () => {
    // The property the whole design rests on. `shell: false` means this is a
    // string handed to the program, and no shell ever sees it.
    const { cmd, args } = parseCommandLine('python -c "import os; print(os.getcwd())"');
    assert.equal(cmd, "python");
    assert.deepEqual(args, ["-c", "import os; print(os.getcwd())"]);
  });

  test("a path with spaces stays one path", () => {
    const { args } = parseCommandLine('python "C:\\Program Files\\app\\main.py"');
    assert.deepEqual(args, ["C:\\Program Files\\app\\main.py"]);
  });
});
