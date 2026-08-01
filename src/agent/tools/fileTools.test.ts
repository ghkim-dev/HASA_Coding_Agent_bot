import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Sandbox, SandboxViolation } from "../../core/sandbox.ts";
import type { AgentTool, ToolContext } from "../types.ts";
import { createFileTools } from "./fileTools.ts";

/**
 * The file tools.
 *
 * Containment itself is `core/sandbox.ts`, already tested against traversal,
 * absolute paths and symlink escape. What is checked here is the layer above:
 * that a refusal reaches the model as something it can act on, that an edit
 * that would silently do the wrong thing does not happen at all, and that what
 * the user is asked to approve is readable.
 */

const dirs: string[] = [];

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function workspace(files: Record<string, string>): Promise<{ root: string; tools: Map<string, AgentTool>; ctx: ToolContext }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hasa-tools-")));
  dirs.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents, "utf8");
  }
  const sandbox = new Sandbox({ root });
  const tools = new Map(createFileTools(sandbox).map((t) => [t.name, t]));
  return { root, tools, ctx: { workspaceRoot: root, signal: new AbortController().signal } };
}

describe("list_files", () => {
  test("lists a directory, marking directories with a slash", async () => {
    const w = await workspace({ "src/a.ts": "a", "src/b.ts": "b", "README.md": "r" });
    const result = await w.tools.get("list_files")!.execute({ path: "." }, w.ctx);

    assert.equal(result.ok, true);
    assert.match(result.content, /README\.md/);
    assert.match(result.content, /src\//);
  });

  test("skips the directories nobody wants listed", async () => {
    const w = await workspace({ "src/a.ts": "a", "node_modules/pkg/index.js": "x", ".git/config": "y" });
    const result = await w.tools.get("list_files")!.execute({ path: ".", recursive: true }, w.ctx);

    assert.doesNotMatch(result.content, /node_modules/);
    assert.doesNotMatch(result.content, /\.git/);
  });

  test("paths use forward slashes on every platform", async () => {
    const w = await workspace({ "src/deep/a.ts": "a" });
    const result = await w.tools.get("list_files")!.execute({ path: ".", recursive: true }, w.ctx);
    assert.match(result.content, /src\/deep/);
    assert.doesNotMatch(result.content, /src\\deep/);
  });

  test("an empty directory says so rather than returning nothing", async () => {
    const w = await workspace({ "src/a.ts": "a" });
    await mkdir(join(w.root, "empty"));
    const result = await w.tools.get("list_files")!.execute({ path: "empty" }, w.ctx);
    assert.match(result.content, /empty/);
  });

  test("escaping the workspace is refused", async () => {
    const w = await workspace({ "a.ts": "a" });
    await assert.rejects(
      w.tools.get("list_files")!.execute({ path: "../.." }, w.ctx),
      (e: unknown) => e instanceof SandboxViolation,
    );
  });
});

describe("read_file", () => {
  test("returns numbered lines, so an edit can be described by line", async () => {
    const w = await workspace({ "a.ts": "one\ntwo\nthree\n" });
    const result = await w.tools.get("read_file")!.execute({ path: "a.ts" }, w.ctx);
    assert.match(result.content, /1\tone/);
    assert.match(result.content, /3\tthree/);
  });

  test("a line range is honoured and reported", async () => {
    const w = await workspace({ "a.ts": "1\n2\n3\n4\n5\n" });
    const result = await w.tools.get("read_file")!.execute({ path: "a.ts", startLine: 2, endLine: 4 }, w.ctx);
    assert.match(result.content, /lines 2-4/);
    assert.doesNotMatch(result.content, /\n1\t1/);
  });

  test("a range beyond the file is clamped rather than failing", async () => {
    const w = await workspace({ "a.ts": "one\n" });
    const result = await w.tools.get("read_file")!.execute({ path: "a.ts", startLine: 1, endLine: 9999 }, w.ctx);
    assert.equal(result.ok, true);
  });

  test("a credential file is refused even though it is inside the workspace", async () => {
    const w = await workspace({ ".env": "HASA_API_KEY=secret\n" });
    await assert.rejects(
      w.tools.get("read_file")!.execute({ path: ".env" }, w.ctx),
      (e: unknown) => e instanceof SandboxViolation,
    );
  });
});

describe("search_files", () => {
  test("returns path, line number and the matching line", async () => {
    const w = await workspace({ "src/a.ts": "const x = 1;\nconst target = 2;\n" });
    const result = await w.tools.get("search_files")!.execute({ pattern: "target" }, w.ctx);
    assert.match(result.content, /src\/a\.ts:2: const target = 2;/);
  });

  test("no match is a result, not a failure", async () => {
    const w = await workspace({ "a.ts": "nothing here\n" });
    const result = await w.tools.get("search_files")!.execute({ pattern: "absent" }, w.ctx);
    assert.equal(result.ok, true);
    assert.match(result.content, /No match/);
  });

  test("an invalid pattern is handed back so the model can fix it", async () => {
    // Thrown, this would end the turn over a typo the model could correct.
    const w = await workspace({ "a.ts": "x" });
    const result = await w.tools.get("search_files")!.execute({ pattern: "([unclosed" }, w.ctx);
    assert.equal(result.ok, false);
    assert.match(result.content, /invalid regular expression/);
  });

  test("credential files are not searchable either", async () => {
    // Search would otherwise be a way around the read refusal: ask for a
    // pattern, get the matching line back.
    const w = await workspace({ ".env": "SECRET=hunter2\n", "a.ts": "x\n" });
    const result = await w.tools.get("search_files")!.execute({ pattern: "hunter2" }, w.ctx);

    assert.match(result.content, /No match/, "the search must come up empty");
    assert.doesNotMatch(result.content, /SECRET=/, "no line from .env may be echoed");
    assert.doesNotMatch(result.content, /\.env:/, "not even the fact that it matched");
  });

  test("a file the sandbox forbids is skipped rather than ending the search", async () => {
    const w = await workspace({ ".env": "TOKEN=abc\n", "src/a.ts": "findme\n" });
    const result = await w.tools.get("search_files")!.execute({ pattern: "findme|TOKEN" }, w.ctx);

    assert.equal(result.ok, true);
    assert.match(result.content, /src\/a\.ts:1: findme/, "the searchable files were still searched");
    assert.doesNotMatch(result.content, /TOKEN=abc/);
  });

  test("a glob narrows the search", async () => {
    const w = await workspace({ "src/a.ts": "needle\n", "docs/b.md": "needle\n" });
    const result = await w.tools.get("search_files")!.execute({ pattern: "needle", glob: "src/" }, w.ctx);
    assert.match(result.content, /src\/a\.ts/);
    assert.doesNotMatch(result.content, /docs\/b\.md/);
  });
});

describe("create_file", () => {
  test("writes a new file and reports it as changed", async () => {
    const w = await workspace({});
    const result = await w.tools.get("create_file")!.execute({ path: "src/new.ts", contents: "export const x = 1;\n" }, w.ctx);

    assert.equal(result.ok, true);
    assert.deepEqual(result.changedFiles, ["src/new.ts"]);
  });

  test("the summary is a sentence with a size, not a JSON blob", async () => {
    const w = await workspace({});
    const summary = w.tools.get("create_file")!.summarize({ path: "src/new.ts", contents: "a\nb\nc\n" });
    assert.match(summary, /src\/new\.ts/);
    assert.match(summary, /4줄/);
    assert.doesNotMatch(summary, /[{}]/);
  });

  test("the preview of a new file shows what will be in it", async () => {
    const w = await workspace({});
    const preview = await w.tools.get("create_file")!.preview!({ path: "n.ts", contents: "line one\n" }, w.ctx);
    assert.match(String(preview), /새 파일/);
    assert.match(String(preview), /line one/);
  });

  test("the preview of an overwrite shows the difference, not the whole file", async () => {
    const w = await workspace({ "a.ts": "keep\nchange me\nkeep\n" });
    const preview = await w.tools.get("create_file")!.preview!({ path: "a.ts", contents: "keep\nchanged\nkeep\n" }, w.ctx);

    assert.match(String(preview), /- change me/);
    assert.match(String(preview), /\+ changed/);
    assert.doesNotMatch(String(preview), /- keep/, "unchanged lines are not part of the decision");
  });

  test("writing outside the workspace is refused", async () => {
    const w = await workspace({});
    await assert.rejects(
      w.tools.get("create_file")!.execute({ path: "../escape.ts", contents: "x" }, w.ctx),
      (e: unknown) => e instanceof SandboxViolation,
    );
  });
});

describe("apply_patch", () => {
  test("replaces the block and reports the file as changed", async () => {
    const w = await workspace({ "a.ts": "before\nTARGET\nafter\n" });
    const result = await w.tools.get("apply_patch")!.execute({ path: "a.ts", find: "TARGET", replace: "REPLACED" }, w.ctx);

    assert.equal(result.ok, true);
    assert.deepEqual(result.changedFiles, ["a.ts"]);
  });

  test("text that is not there is reported, not guessed at", async () => {
    const w = await workspace({ "a.ts": "hello\n" });
    const result = await w.tools.get("apply_patch")!.execute({ path: "a.ts", find: "goodbye", replace: "x" }, w.ctx);

    assert.equal(result.ok, false);
    assert.match(result.content, /not found/);
    assert.match(result.content, /Read the file/);
  });

  test("an ambiguous match changes nothing at all", async () => {
    // Replacing the first of several is the kind of edit that looks like it
    // worked and quietly corrupts the file.
    const w = await workspace({ "a.ts": "x = 1;\nx = 1;\n" });
    const tool = w.tools.get("apply_patch")!;
    const result = await tool.execute({ path: "a.ts", find: "x = 1;", replace: "x = 2;" }, w.ctx);

    assert.equal(result.ok, false);
    assert.match(result.content, /occurs 2 times/);
    assert.match(result.content, /more surrounding lines/);

    const after = await w.tools.get("read_file")!.execute({ path: "a.ts" }, w.ctx);
    assert.doesNotMatch(after.content, /x = 2/, "the file must be untouched");
  });

  test("only the intended occurrence is replaced when the block is unique", async () => {
    const w = await workspace({ "a.ts": "a = 1;\nb = 1;\n" });
    await w.tools.get("apply_patch")!.execute({ path: "a.ts", find: "a = 1;", replace: "a = 2;" }, w.ctx);
    const after = await w.tools.get("read_file")!.execute({ path: "a.ts" }, w.ctx);

    assert.match(after.content, /a = 2;/);
    assert.match(after.content, /b = 1;/);
  });

  test("line numbers copied out of read_file are stripped back off", async () => {
    // Measured against the live gateway: the model reads a file, sees
    // "2<tab>  return x;", and puts that in `find`. The prefix is ours, added
    // by read_file, so removing it again is undoing our own doing.
    const w = await workspace({ "a.ts": "export function greet(name: string) {\n  return name;\n}\n" });
    const result = await w.tools.get("apply_patch")!.execute(
      { path: "a.ts", find: "2\t  return name;", replace: "  return name.trim();" },
      w.ctx,
    );

    assert.equal(result.ok, true);
    const after = await w.tools.get("read_file")!.execute({ path: "a.ts" }, w.ctx);
    assert.match(after.content, /return name\.trim\(\);/);
  });

  test("a genuine leading number is not mistaken for a line prefix", async () => {
    // Stripping one would corrupt an edit to a data file.
    const w = await workspace({ "data.tsv": "1\tapple\n2\tbanana\n" });
    const result = await w.tools.get("apply_patch")!.execute(
      { path: "data.tsv", find: "2\tbanana", replace: "2\tcherry" },
      w.ctx,
    );

    assert.equal(result.ok, true, "the text is present verbatim, so it is replaced verbatim");
    const after = await w.tools.get("read_file")!.execute({ path: "data.tsv" }, w.ctx);
    assert.match(after.content, /cherry/);
    assert.match(after.content, /1\tapple/, "the other row is untouched");
  });

  test("stripping is not attempted when only some lines carry a prefix", async () => {
    const w = await workspace({ "a.ts": "alpha\nbeta\n" });
    const result = await w.tools.get("apply_patch")!.execute(
      { path: "a.ts", find: "1\talpha\nbeta", replace: "x" },
      w.ctx,
    );
    assert.equal(result.ok, false, "half a prefix is not a prefix");
  });

  test("the failure tells the model what to do about it", async () => {
    const w = await workspace({ "a.ts": "hello\n" });
    const result = await w.tools.get("apply_patch")!.execute(
      { path: "a.ts", find: "goodbye", replace: "x" },
      w.ctx,
    );
    assert.match(result.content, /line numbers/);
    assert.match(result.content, /indentation/);
  });

  test("the preview shows the change before it happens", async () => {
    const w = await workspace({ "a.ts": "keep\nold\nkeep\n" });
    const preview = await w.tools.get("apply_patch")!.preview!({ path: "a.ts", find: "old", replace: "new" }, w.ctx);
    assert.match(String(preview), /- old/);
    assert.match(String(preview), /\+ new/);
  });

  test("a preview for a file that does not exist is absent, not an error", async () => {
    const w = await workspace({});
    assert.equal(await w.tools.get("apply_patch")!.preview!({ path: "missing.ts", find: "a", replace: "b" }, w.ctx), null);
  });
});

describe("risk levels", () => {
  test("reading is read, writing is write, and nothing here executes", async () => {
    const w = await workspace({});
    assert.equal(w.tools.get("list_files")?.risk, "read");
    assert.equal(w.tools.get("read_file")?.risk, "read");
    assert.equal(w.tools.get("search_files")?.risk, "read");
    assert.equal(w.tools.get("create_file")?.risk, "write");
    assert.equal(w.tools.get("apply_patch")?.risk, "write");
  });

  test("every tool can summarise itself in the user's language", async () => {
    const w = await workspace({});
    for (const tool of w.tools.values()) {
      const summary = tool.summarize({ path: "src/a.ts", contents: "x", pattern: "p", find: "f", replace: "r" });
      assert.ok(summary.length > 0, tool.name);
      assert.match(summary, /[가-힣]/, `${tool.name} does not speak to the user`);
    }
  });
});
