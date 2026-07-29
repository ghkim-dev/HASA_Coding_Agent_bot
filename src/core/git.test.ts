import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRepoFixture, type RepoFixture } from "../testing/repo-fixture.ts";
import { GitError, GitRepo, isInside, worktreePathFor } from "./git.ts";

let fixture: RepoFixture;

beforeEach(async () => {
  fixture = await createRepoFixture({ "src/app.ts": "export const answer = 41;\n", "README.md": "# fixture\n" });
});

afterEach(async () => {
  await fixture.dispose();
});

describe("GitRepo.open", () => {
  test("opens a repository root", async () => {
    const repo = await GitRepo.open(fixture.root);
    assert.equal(repo.root, fixture.root);
  });

  test("refuses a subdirectory — worktrees need the root", async () => {
    // This is the exact shape of the problem found in the target environment:
    // a project folder nested inside a repository rooted somewhere else.
    await assert.rejects(GitRepo.open(join(fixture.root, "src")), GitError);
  });

  test("refuses a directory that is not a repository", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const plain = await mkdtemp(join(tmpdir(), "arena-plain-"));
    await assert.rejects(GitRepo.open(plain));
  });

  test("refuses a relative path", async () => {
    await assert.rejects(GitRepo.open("./somewhere"), GitError);
  });
});

describe("worktrees", () => {
  test("each candidate gets an independent checkout of the same base commit", async () => {
    const repo = await GitRepo.open(fixture.root);
    const base = await repo.headSha();

    const a = await repo.addWorktree(worktreePathFor(repo.root, "run1234", "cand-a"), base, "cand-a");
    const b = await repo.addWorktree(worktreePathFor(repo.root, "run1234", "cand-b"), base, "cand-b");

    assert.notEqual(a.path, b.path);
    assert.equal(await readFile(join(a.path, "src/app.ts"), "utf8"), "export const answer = 41;\n");
    assert.equal(await readFile(join(b.path, "src/app.ts"), "utf8"), "export const answer = 41;\n");

    await repo.removeWorktree(a.path);
    await repo.removeWorktree(b.path);
  });

  test("a write in one worktree is invisible to the other and to the main tree", async () => {
    const repo = await GitRepo.open(fixture.root);
    const base = await repo.headSha();
    const a = await repo.addWorktree(worktreePathFor(repo.root, "run1234", "cand-a"), base, "cand-a");
    const b = await repo.addWorktree(worktreePathFor(repo.root, "run1234", "cand-b"), base, "cand-b");

    await writeFile(join(a.path, "src/app.ts"), "export const answer = 42;\n", "utf8");

    assert.equal(await readFile(join(b.path, "src/app.ts"), "utf8"), "export const answer = 41;\n");
    assert.equal(await fixture.read("src/app.ts"), "export const answer = 41;\n");

    await repo.removeWorktree(a.path);
    await repo.removeWorktree(b.path);
  });

  test("a worktree starts from the run's base commit, not from later history", async () => {
    const repo = await GitRepo.open(fixture.root);
    const base = await repo.headSha();
    await fixture.write("src/app.ts", "export const answer = 99;\n");
    await fixture.commit("move on");

    const wt = await repo.addWorktree(worktreePathFor(repo.root, "run5678", "cand-a"), base, "cand-a");
    assert.equal(await readFile(join(wt.path, "src/app.ts"), "utf8"), "export const answer = 41;\n");
    await repo.removeWorktree(wt.path);
  });
});

describe("diff capture", () => {
  test("captures a modification against the base commit", async () => {
    const repo = await GitRepo.open(fixture.root);
    const base = await repo.headSha();
    const wt = await repo.addWorktree(worktreePathFor(repo.root, "run1", "cand-a"), base, "cand-a");

    await writeFile(join(wt.path, "src/app.ts"), "export const answer = 42;\n", "utf8");
    const diff = await repo.diffWorktree(wt.path, base);

    assert.match(diff, /-export const answer = 41;/);
    assert.match(diff, /\+export const answer = 42;/);
    assert.deepEqual(await repo.changedFiles(wt.path, base), ["src/app.ts"]);
    await repo.removeWorktree(wt.path);
  });

  test("a newly created file appears in the diff", async () => {
    // Without `add -N` an untracked file is silently absent, which would make a
    // candidate that wrote a new module look like it did nothing.
    const repo = await GitRepo.open(fixture.root);
    const base = await repo.headSha();
    const wt = await repo.addWorktree(worktreePathFor(repo.root, "run2", "cand-a"), base, "cand-a");

    await mkdir(join(wt.path, "src/lib"), { recursive: true });
    await writeFile(join(wt.path, "src/lib/new.ts"), "export const added = true;\n", "utf8");

    assert.deepEqual(await repo.changedFiles(wt.path, base), ["src/lib/new.ts"]);
    assert.match(await repo.diffWorktree(wt.path, base), /\+export const added = true;/);
    await repo.removeWorktree(wt.path);
  });

  test("an untouched worktree produces an empty diff", async () => {
    const repo = await GitRepo.open(fixture.root);
    const base = await repo.headSha();
    const wt = await repo.addWorktree(worktreePathFor(repo.root, "run3", "cand-a"), base, "cand-a");
    assert.equal((await repo.diffWorktree(wt.path, base)).trim(), "");
    await repo.removeWorktree(wt.path);
  });
});

describe("patch application", () => {
  test("canApply reports without modifying anything", async () => {
    const repo = await GitRepo.open(fixture.root);
    const base = await repo.headSha();
    const wt = await repo.addWorktree(worktreePathFor(repo.root, "run4", "cand-a"), base, "cand-a");
    await writeFile(join(wt.path, "src/app.ts"), "export const answer = 42;\n", "utf8");
    const diff = await repo.diffWorktree(wt.path, base);

    assert.equal(await repo.canApply(diff), true);
    assert.deepEqual(await fixture.status(), [], "a dry run must not touch the tree");
    await repo.removeWorktree(wt.path);
  });

  test("an empty or malformed patch is refused", async () => {
    const repo = await GitRepo.open(fixture.root);
    assert.equal(await repo.canApply(""), false);
    assert.equal(await repo.canApply("this is not a diff"), false);
  });

  test("applying a worktree diff reproduces the candidate's change exactly", async () => {
    const repo = await GitRepo.open(fixture.root);
    const base = await repo.headSha();
    const wt = await repo.addWorktree(worktreePathFor(repo.root, "run5", "cand-a"), base, "cand-a");
    await writeFile(join(wt.path, "src/app.ts"), "export const answer = 42;\n", "utf8");
    const diff = await repo.diffWorktree(wt.path, base);

    await repo.applyPatch(diff);
    assert.equal(await fixture.read("src/app.ts"), "export const answer = 42;\n");
    await repo.removeWorktree(wt.path);
  });
});

describe("isInside", () => {
  test("accepts the directory itself and its descendants", () => {
    assert.equal(isInside("/a/b", "/a/b"), true);
    assert.equal(isInside("/a/b", "/a/b/c/d"), true);
  });

  test("rejects siblings sharing a prefix", () => {
    assert.equal(isInside("/a/b", "/a/bc"), false);
    assert.equal(isInside("/a/b", "/a"), false);
  });
});
