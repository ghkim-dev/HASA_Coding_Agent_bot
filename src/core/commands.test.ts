import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandSpec } from "../protocol/index.ts";
import { CommandRejected, assertRunnable, candidateEnv, runCommand } from "./commands.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "arena-cmd-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
});

const NODE = process.execPath;

function spec(args: string[], gate: CommandSpec["gate"] = "test", timeoutMs = 20_000): CommandSpec {
  return { gate, kind: "regression", cmd: NODE, args, timeoutMs };
}

describe("assertRunnable", () => {
  const allowed = spec(["-e", "process.exit(0)"]);

  test("accepts an exact match from the task specification", () => {
    assert.doesNotThrow(() => assertRunnable(allowed, [allowed]));
  });

  test("rejects a command that was never declared", () => {
    assert.throws(
      () => assertRunnable(spec(["-e", "process.exit(1)"]), [allowed]),
      (e: unknown) => e instanceof CommandRejected && e.reason === "not_allowlisted",
    );
  });

  test("rejects a declared command with extra arguments appended", () => {
    // Prefix matching would be the obvious shortcut and the obvious hole.
    assert.throws(
      () => assertRunnable(spec(["-e", "process.exit(0)", "--extra"]), [allowed]),
      (e: unknown) => e instanceof CommandRejected && e.reason === "not_allowlisted",
    );
  });

  test("rejects an executable name that expects a shell", () => {
    for (const cmd of ["node && rm", "a|b", "a>out", "`id`", "cmd;other"]) {
      const s: CommandSpec = { gate: "build", kind: "regression", cmd, args: [], timeoutMs: 1000 };
      assert.throws(
        () => assertRunnable(s, [s]),
        (e: unknown) => e instanceof CommandRejected && e.reason === "metacharacter",
        `${cmd} should be rejected`,
      );
    }
  });

  test("allows metacharacters inside arguments — shell:false makes them literal", () => {
    // Screening args would reject `-e "process.exit(0)"` and every glob a test
    // runner takes, while buying nothing: the arg never reaches a shell.
    const s = spec(["-e", "process.exit(0)"]);
    assert.doesNotThrow(() => assertRunnable(s, [s]));
  });

  test("rejects control characters in arguments", () => {
    const s = spec(["line1\nline2"]);
    assert.throws(
      () => assertRunnable(s, [s]),
      (e: unknown) => e instanceof CommandRejected && e.reason === "metacharacter",
    );
  });

  test("rejects denylisted operations even if someone declared them", () => {
    for (const args of [["rm", "-rf", "/"], ["git", "push"], ["npm", "publish"], ["sudo", "reboot"]]) {
      const s: CommandSpec = {
        gate: "build",
        kind: "regression",
        cmd: args[0] ?? "",
        args: args.slice(1),
        timeoutMs: 1000,
      };
      assert.throws(
        () => assertRunnable(s, [s]),
        (e: unknown) => e instanceof CommandRejected && e.reason === "denylisted",
        `${args.join(" ")} should be denylisted`,
      );
    }
  });

  test("reading credentials is denylisted", () => {
    const s: CommandSpec = { gate: "test", kind: "regression", cmd: "cat", args: [".env"], timeoutMs: 1000 };
    assert.throws(() => assertRunnable(s, [s]), CommandRejected);
  });
});

describe("candidateEnv", () => {
  test("does not carry the HASA key into a candidate's commands", () => {
    const previous = process.env["HASA_API_KEY"];
    process.env["HASA_API_KEY"] = "sk-should-not-propagate-000000";
    try {
      const env = candidateEnv();
      assert.equal(env["HASA_API_KEY"], undefined);
      assert.ok(!JSON.stringify(env).includes("sk-should-not-propagate"));
    } finally {
      if (previous === undefined) delete process.env["HASA_API_KEY"];
      else process.env["HASA_API_KEY"] = previous;
    }
  });

  test("passes through only what a build actually needs", () => {
    const env = candidateEnv();
    assert.ok(env["PATH"] !== undefined);
    assert.equal(env["CI"], "1");
  });
});

describe("runCommand", () => {
  test("captures stdout and a zero exit code", async () => {
    const s = spec(["-e", "console.log('built ok')"], "build");
    const outcome = await runCommand(s, [s], { cwd });
    assert.equal(outcome.exitCode, 0);
    assert.match(outcome.stdout, /built ok/);
    assert.equal(outcome.timedOut, false);
  });

  test("reports a non-zero exit code without throwing", async () => {
    const s = spec(["-e", "console.error('boom'); process.exit(3)"], "test");
    const outcome = await runCommand(s, [s], { cwd });
    assert.equal(outcome.exitCode, 3);
    assert.match(outcome.stderr, /boom/);
  });

  test("kills a command that overruns its timeout", async () => {
    const s = spec(["-e", "setTimeout(() => {}, 60000)"], "test", 1_000);
    const outcome = await runCommand(s, [s], { cwd });
    assert.equal(outcome.timedOut, true);
    assert.notEqual(outcome.exitCode, 0);
    assert.ok(outcome.durationMs < 20_000, "must not wait for the full 60s");
  });

  test("runs in the given worktree, not the orchestrator's cwd", async () => {
    const s = spec(["-e", "console.log(process.cwd())"], "build");
    const outcome = await runCommand(s, [s], { cwd });
    assert.ok(outcome.stdout.trim().length > 0);
    assert.ok(!outcome.stdout.includes("HAFA_Extension"), "must not run in the orchestrator directory");
  });

  test("an unallowlisted command never reaches the process spawner", async () => {
    const allowed = spec(["-e", "process.exit(0)"]);
    await assert.rejects(runCommand(spec(["-e", "console.log(1)"]), [allowed], { cwd }), CommandRejected);
  });

  test("aborting terminates the child", async () => {
    const s = spec(["-e", "setTimeout(() => {}, 60000)"], "test", 60_000);
    const controller = new AbortController();
    const promise = runCommand(s, [s], { cwd, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const outcome = await promise;
    assert.notEqual(outcome.exitCode, 0);
    assert.ok(outcome.durationMs < 20_000);
  });
});
