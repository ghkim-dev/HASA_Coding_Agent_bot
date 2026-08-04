import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox } from "../core/sandbox.ts";
import { candidateEnv, runApprovedCommand } from "../core/commands.ts";
import { createFileTools } from "./tools/fileTools.ts";
import { createShellTools } from "./tools/shellTools.ts";
import { reduceSession } from "./sessionView.ts";
import { TurnRecorder } from "./sessionRecorder.ts";
import type { AgentEvent, ToolResult } from "./types.ts";

/**
 * The reported failures, against a real filesystem.
 *
 * Everything here was found by using the product rather than by reading it, and
 * each one is asserted the way it was observed: a plain directory with no git in
 * it, a file larger than the read limit, a process printing Korean. Mocks would
 * pass on every one of these.
 */

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  // Deliberately not a repository. That is the case that was broken.
  const dir = await mkdtemp(join(tmpdir(), "hasa-runtime-"));
  dirs.push(dir);
  return dir;
}

const ctx = { workspaceRoot: "/w", signal: new AbortController().signal };

describe("file changes are tracked without git", () => {
  test("a write reports what it did and whether the file was new", async () => {
    const root = await workspace();
    const tools = createFileTools(new Sandbox({ root }));
    const create = tools.find((t) => t.name === "create_file");
    assert.ok(create !== undefined);

    const first = (await create.execute({ path: "a.ts", contents: "1" }, ctx)) as ToolResult;
    const second = (await create.execute({ path: "a.ts", contents: "2" }, ctx)) as ToolResult;

    assert.deepEqual(first.changes, [{ path: "a.ts", change: "created" }]);
    assert.deepEqual(second.changes, [{ path: "a.ts", change: "modified" }]);
  });

  test("a patch reports a modification", async () => {
    const root = await workspace();
    await writeFile(join(root, "b.ts"), "const a = 1;\n");
    const tools = createFileTools(new Sandbox({ root }));
    const patch = tools.find((t) => t.name === "apply_patch");
    const result = (await patch!.execute(
      { path: "b.ts", find: "const a = 1;", replace: "const a = 2;" },
      ctx,
    )) as ToolResult;
    assert.deepEqual(result.changes, [{ path: "b.ts", change: "modified" }]);
  });

  test("the changed-file list survives to the view, in a plain folder", async () => {
    // The reported symptom: an agent writes four files in a directory that is
    // not a repository, and the review card is empty because the only thing
    // asked was `git status`.
    const recorder = new TurnRecorder({ turnId: "t1", now: () => 0 });
    const events: AgentEvent[] = [
      {
        type: "tool_end",
        callId: "c1",
        name: "create_file",
        ok: true,
        detail: "wrote",
        changedFiles: [
          { path: "src/a.ts", change: "created" },
          { path: "README.md", change: "modified" },
        ],
      },
    ];
    for (const event of events) recorder.record(event);

    const view = reduceSession(recorder.drain());
    assert.deepEqual(
      view.changedFiles.map((f) => f.path).sort(),
      ["README.md", "src/a.ts"],
    );
  });

  test("a file created then edited still reads as created", async () => {
    const recorder = new TurnRecorder({ turnId: "t1", now: () => 0 });
    for (const change of ["created", "modified"] as const) {
      recorder.record({
        type: "tool_end",
        callId: `c-${change}`,
        name: "create_file",
        ok: true,
        detail: "wrote",
        changedFiles: [{ path: "new.ts", change }],
      });
    }
    assert.deepEqual(reduceSession(recorder.drain()).changedFiles, [{ path: "new.ts", change: "created" }]);
  });
});

describe("a file too large to read whole", () => {
  test("comes back as a first chunk with the call that gets the rest", async () => {
    // It used to be a flat refusal, and a model that cannot read the file it was
    // told to change has nowhere to go but round in circles.
    const root = await workspace();
    const line = `${"x".repeat(120)}\n`;
    await writeFile(join(root, "big.ts"), line.repeat(4_000)); // ~480 KB

    const read = createFileTools(new Sandbox({ root })).find((t) => t.name === "read_file");
    const result = (await read!.execute({ path: "big.ts" }, ctx)) as ToolResult;

    assert.equal(result.ok, true, "a large file is readable, not refused");
    assert.equal(result.meta?.reason, "file_too_large");
    assert.equal(result.meta?.truncated, true);
    assert.match(result.content, /startLine:/, "the way to continue is in the text the model reads");
    assert.match(result.content, /Do not repeat this call unchanged/);
  });

  test("and the continuation actually works", async () => {
    const root = await workspace();
    const lines = Array.from({ length: 5_000 }, (_, i) => `line ${i + 1} ${"y".repeat(100)}`);
    await writeFile(join(root, "big.ts"), lines.join("\n"));

    const read = createFileTools(new Sandbox({ root })).find((t) => t.name === "read_file");
    const first = (await read!.execute({ path: "big.ts" }, ctx)) as ToolResult;
    const next = Number(/startLine: (\d+)/.exec(first.content)?.[1]);
    assert.ok(Number.isFinite(next) && next > 1);

    // The range read is the same tool, so a model that follows the instruction
    // gets a real answer rather than the same refusal.
    const second = (await read!.execute({ path: "big.ts", startLine: next, endLine: next + 5 }, ctx)) as ToolResult;
    assert.equal(second.ok, true);
  });

  test("a small file is unaffected", async () => {
    const root = await workspace();
    await writeFile(join(root, "small.ts"), "const a = 1;\n");
    const read = createFileTools(new Sandbox({ root })).find((t) => t.name === "read_file");
    const result = (await read!.execute({ path: "small.ts" }, ctx)) as ToolResult;
    assert.equal(result.meta, undefined);
    assert.match(result.content, /const a = 1;/);
  });
});

describe("search results say when they were shortened", () => {
  test("a long matching line ends with a marker and is counted", async () => {
    const root = await workspace();
    await writeFile(join(root, "long.ts"), `const x = "${"z".repeat(600)}"; // needle\n`);
    const search = createFileTools(new Sandbox({ root })).find((t) => t.name === "search_files");
    const result = (await search!.execute({ pattern: "needle" }, { ...ctx, signal: ctx.signal })) as ToolResult;

    assert.match(result.content, /…/, "the cut is visible in the snippet");
    assert.equal(result.meta?.truncated, true);
    assert.match(String(result.meta?.hint), /read the file at the line number/i);
  });

  test("a short match is returned whole, with no truncation claimed", async () => {
    const root = await workspace();
    await writeFile(join(root, "short.ts"), "const needle = 1;\n");
    const search = createFileTools(new Sandbox({ root })).find((t) => t.name === "search_files");
    const result = (await search!.execute({ pattern: "needle" }, ctx)) as ToolResult;
    assert.equal(result.meta, undefined);
    assert.match(result.content, /short\.ts:1:/, "path and line, so the model can go and read it");
  });
});

describe("command output a Korean user can read", () => {
  const python = process.platform === "win32" ? "python" : "python3";

  test("Korean stdout survives, and so does an emoji", async (t) => {
    const root = await workspace();
    await writeFile(
      join(root, "ko.py"),
      'print("한글 출력 테스트: 정상입니다")\nprint("emoji: \\U0001F600")\n',
      "utf8",
    );
    let outcome;
    try {
      outcome = await runApprovedCommand(
        { gate: "run", kind: "regression", cmd: python, args: ["ko.py"], timeoutMs: 30_000 },
        { cwd: root, env: candidateEnv() },
      );
    } catch {
      return t.skip("python is not installed here");
    }
    if (outcome.exitCode !== 0) return t.skip("python could not run the fixture");

    assert.ok(!outcome.stdout.includes("\uFFFD"), "no replacement characters");
    assert.match(outcome.stdout, /한글 출력 테스트: 정상입니다/);
    assert.match(outcome.stdout, /\u{1F600}/u, "a four-byte character crossed the chunk boundary intact");
  });

  test("Korean stderr survives too", async (t) => {
    const root = await workspace();
    await writeFile(join(root, "err.py"), 'import sys\nsys.stderr.write("오류: 실패했습니다\\n")\n', "utf8");
    let outcome;
    try {
      outcome = await runApprovedCommand(
        { gate: "run", kind: "regression", cmd: python, args: ["err.py"], timeoutMs: 30_000 },
        { cwd: root, env: candidateEnv() },
      );
    } catch {
      return t.skip("python is not installed here");
    }
    assert.ok(!outcome.stderr.includes("\uFFFD"));
    assert.match(outcome.stderr, /오류: 실패했습니다/);
  });

  test("the environment asks for UTF-8 rather than the console codepage", () => {
    // The Windows half of the fault: a child writing to a pipe defaults to CP949
    // on a Korean install, and this side decodes UTF-8.
    const env = candidateEnv();
    assert.equal(env["PYTHONUTF8"], "1");
    assert.equal(env["PYTHONIOENCODING"], "utf-8");
  });

  test("output keeps its beginning as well as its end", async (t) => {
    // A compiler puts the error at the top and progress underneath. Keeping only
    // the tail kept the progress.
    const root = await workspace();
    await writeFile(
      join(root, "noisy.py"),
      'print("ERROR: first line matters")\nfor i in range(300): print(f"noise {i}")\nprint("SUMMARY: done")\n',
      "utf8",
    );
    const run = createShellTools({ workspaceRoot: root, allowlist: [], isGitRepo: false }).find(
      (t2) => t2.name === "run_command",
    );
    const result = (await run!.execute({ command: `${python} noisy.py` }, {
      workspaceRoot: root,
      signal: new AbortController().signal,
    })) as ToolResult;
    if (!/ERROR|noise/.test(result.content)) return t.skip("python is not installed here");

    assert.match(result.content, /ERROR: first line matters/);
    assert.match(result.content, /SUMMARY: done/);
    assert.match(result.content, /more lines/);
  });
});
