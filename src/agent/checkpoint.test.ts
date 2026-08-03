import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "../hasa-client/logger.ts";
import { createRepoFixture, type RepoFixture } from "../testing/repo-fixture.ts";
import { CheckpointManager } from "./checkpoint.ts";

/**
 * Undo, against a real repository.
 *
 * A stub would happily "restore" nothing. This is the one part of the agent
 * that can destroy work the user did not ask it to touch, so the tests use real
 * git and check the tree afterwards rather than the calls made.
 */

const fixtures: RepoFixture[] = [];
const dirs: string[] = [];

after(async () => {
  for (const fixture of fixtures) await fixture.dispose();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function repo(files: Record<string, string> = { "src/a.ts": "export const a = 1;\n" }): Promise<RepoFixture> {
  const fixture = await createRepoFixture(files);
  fixtures.push(fixture);
  return fixture;
}

function manager(root: string): CheckpointManager {
  return new CheckpointManager({ repoRoot: root, logger: nullLogger });
}

describe("availability", () => {
  test("a git repository can be protected", async () => {
    const fixture = await repo();
    assert.equal(await manager(fixture.root).available(), true);
  });

  test("a plain directory cannot, and says so rather than pretending", async () => {
    // Not refused outright — a user may genuinely want the agent in a scratch
    // folder — but they have to be told undo will not exist.
    const dir = await mkdtemp(join(tmpdir(), "hasa-plain-"));
    dirs.push(dir);
    const cp = manager(dir);
    assert.equal(await cp.available(), false);
    assert.equal(await cp.ensure(), null);
  });
});

describe("taking a checkpoint", () => {
  test("a clean tree needs nothing stashed", async () => {
    const fixture = await repo();
    const cp = manager(fixture.root);
    const checkpoint = await cp.ensure();

    assert.ok(checkpoint !== null);
    assert.equal(checkpoint.ref, null, "there was nothing to put away");
    assert.equal(checkpoint.baseCommit, await fixture.headSha());
  });

  test("uncommitted work is put away, and the tree comes back clean", async () => {
    const fixture = await repo();
    await fixture.write("src/a.ts", "export const a = 999;\n");
    await fixture.write("src/untracked.ts", "// mine\n");

    const checkpoint = await manager(fixture.root).ensure();
    assert.ok(checkpoint?.ref !== null);
    assert.deepEqual(await fixture.status(), [], "the agent starts from a clean tree");
  });

  test("it happens once per turn, however many writes there are", async () => {
    // The second write of a turn must not stash away the first one's work.
    const fixture = await repo();
    await fixture.write("src/a.ts", "user's edit\n");
    const cp = manager(fixture.root);

    const first = await cp.ensure();
    await fixture.write("src/a.ts", "agent's edit\n");
    const second = await cp.ensure();

    assert.equal(second, first);
    assert.equal(await fixture.read("src/a.ts"), "agent's edit\n", "the agent's work survived");
  });

  test("the detail says something a person can read", async () => {
    const fixture = await repo();
    await fixture.write("src/a.ts", "dirty\n");
    const checkpoint = await manager(fixture.root).ensure();
    assert.match(checkpoint?.detail ?? "", /[가-힣]/);
  });
});

describe("reverting", () => {
  test("from a clean start, the agent's work is discarded", async () => {
    const fixture = await repo();
    const cp = manager(fixture.root);
    await cp.ensure();

    await fixture.write("src/a.ts", "the agent changed this\n");
    await fixture.write("src/new.ts", "the agent created this\n");

    assert.equal(await cp.revert(), true);
    assert.equal(await fixture.read("src/a.ts"), "export const a = 1;\n");
    assert.deepEqual(await fixture.status(), [], "nothing of the agent's is left");
  });

  test("from a dirty start, the user's work comes back", async () => {
    // The case that matters. The user had unsaved work, the agent ran, the user
    // pressed undo — and their work must be exactly where they left it.
    const fixture = await repo();
    await fixture.write("src/a.ts", "USER WAS HERE\n");
    await fixture.write("src/mine.ts", "user's untracked file\n");

    const cp = manager(fixture.root);
    await cp.ensure();
    await fixture.write("src/a.ts", "agent overwrote it\n");
    await fixture.write("src/agent.ts", "agent's file\n");

    assert.equal(await cp.revert(), true);
    assert.equal(await fixture.read("src/a.ts"), "USER WAS HERE\n");
    assert.equal(await fixture.read("src/mine.ts"), "user's untracked file\n");
    await assert.rejects(fixture.read("src/agent.ts"), "the agent's file is gone");
  });

  test("a stash the user made in between is not the one we restore", async () => {
    // The stash is a stack shared with the user. Popping the top would hand
    // them our undo and lose whatever they put away while the agent worked.
    const fixture = await repo();
    await fixture.write("src/a.ts", "USER WAS HERE\n");

    const cp = manager(fixture.root);
    await cp.ensure();

    // The user stashes something of their own, mid-turn.
    await fixture.write("src/side.ts", "user's other work\n");
    await fixture.git(["add", "-A"]);
    await fixture.git(["stash", "push", "-m", "the user's own stash"]);

    await fixture.write("src/a.ts", "agent's edit\n");
    assert.equal(await cp.revert(), true);

    assert.equal(await fixture.read("src/a.ts"), "USER WAS HERE\n", "our checkpoint came back");
    const stashes = await fixture.git(["stash", "list"]);
    assert.match(stashes, /the user's own stash/, "the user's stash must still be theirs");
  });

  test("reverting twice is not a second undo", async () => {
    const fixture = await repo();
    const cp = manager(fixture.root);
    await cp.ensure();
    await fixture.write("src/a.ts", "changed\n");

    assert.equal(await cp.revert(), true);
    assert.equal(await cp.revert(), false, "there is nothing left to revert to");
  });

  test("reverting without a checkpoint does nothing", async () => {
    const fixture = await repo();
    await fixture.write("src/a.ts", "user's work\n");

    assert.equal(await manager(fixture.root).revert(), false);
    assert.equal(await fixture.read("src/a.ts"), "user's work\n", "untouched");
  });

  test("a commit made since the checkpoint is never thrown away", async () => {
    // The guard that matters most. Someone committing mid-turn — in another
    // terminal, in the editor — has made a deliberate decision, and no undo is
    // worth discarding it silently.
    const fixture = await repo();
    const cp = manager(fixture.root);
    await cp.ensure();

    await fixture.write("src/a.ts", "committed by the user\n");
    const sha = await fixture.commit("the user's own commit");

    await assert.rejects(cp.revert(), /HEAD moved/);
    assert.equal(await fixture.headSha(), sha, "the commit is still there");
    assert.equal(await fixture.read("src/a.ts"), "committed by the user\n");
  });

  test("ignored files are left alone", async () => {
    // `clean -fd` without `-x`: node_modules and build output are not this
    // operation's business, and re-creating them costs minutes.
    const fixture = await repo({ "src/a.ts": "x\n", ".gitignore": "build/\n" });
    const cp = manager(fixture.root);
    await cp.ensure();

    await writeFile(join(fixture.root, "src/a.ts"), "agent edit\n", "utf8");
    await fixture.write("build/artifact.txt", "expensive\n");

    await cp.revert();
    assert.equal(await readFile(join(fixture.root, "build/artifact.txt"), "utf8"), "expensive\n");
  });
});

describe("release and changed files", () => {
  test("release forgets the checkpoint without touching the tree", async () => {
    const fixture = await repo();
    const cp = manager(fixture.root);
    await cp.ensure();
    await fixture.write("src/a.ts", "kept\n");

    cp.release();
    assert.equal(cp.current, null);
    assert.equal(await cp.revert(), false);
    assert.equal(await fixture.read("src/a.ts"), "kept\n");
  });

  test("changed files include new ones and do not stage anything", async () => {
    const fixture = await repo();
    const cp = manager(fixture.root);
    await cp.ensure();

    await fixture.write("src/a.ts", "edited\n");
    await fixture.write("src/brand-new.ts", "new\n");

    const changed = await cp.changedFiles();
    assert.deepEqual([...changed].sort(), ["src/a.ts", "src/brand-new.ts"]);

    // `git status` still reports them as untracked: listing must not stage.
    const status = await fixture.status();
    assert.ok(status.some((line) => line.startsWith("??")), "a new file was staged by merely listing it");
  });

  test("a path with a space survives the listing", async () => {
    const fixture = await repo();
    const cp = manager(fixture.root);
    await cp.ensure();
    await fixture.write("src/two words.ts", "x\n");

    assert.deepEqual(await cp.changedFiles(), ["src/two words.ts"]);
  });

  test("no checkpoint means no changed files rather than an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hasa-plain-"));
    dirs.push(dir);
    assert.deepEqual(await manager(dir).changedFiles(), []);
  });
});

/**
 * Handing the snapshot to a replacement.
 *
 * The extension rebuilds the session when the mode needs a different model, and
 * a new session builds a new manager. The stash is in git; the ref that finds it
 * again is only ever in memory. So without this the user's work survives in a
 * stash nothing can reach, and the button says there is nothing to undo — the
 * worst shape a bug in this file can take, because it is silent.
 */
describe("handing a checkpoint to a replacement manager", () => {
  async function dirtyRepoWithCheckpoint(): Promise<{
    root: string;
    taken: NonNullable<Awaited<ReturnType<CheckpointManager["ensure"]>>>;
  }> {
    const fixture = await repo({ "src/a.ts": "export const a = 1;\n" });
    const first = manager(fixture.root);
    await first.available();
    // Work the user had in progress before the agent touched anything.
    await writeFile(join(fixture.root, "src/a.ts"), "export const a = 2;\n");
    const taken = await first.ensure();
    assert.ok(taken !== null, "a dirty tree should produce a checkpoint");
    // And now the agent's own write, which is what undo has to remove.
    await writeFile(join(fixture.root, "src/a.ts"), "export const a = 999;\n");
    return { root: fixture.root, taken };
  }

  test("the replacement can revert what the original stashed", async () => {
    const { root, taken } = await dirtyRepoWithCheckpoint();

    const second = manager(root);
    await second.available();
    second.adopt(taken);

    assert.equal(await second.revert(), true);
    assert.equal(
      await readFile(join(root, "src/a.ts"), "utf8"),
      "export const a = 2;\n",
      "the user's in-progress work should be back, not the committed version",
    );
  });

  test("without adopting it, the replacement reports nothing to undo", async () => {
    // Written down because it is the bug, and because nothing about git makes
    // this recoverable on its own: the stash is still there and unreachable.
    const { root } = await dirtyRepoWithCheckpoint();

    const second = manager(root);
    await second.available();

    assert.equal(await second.revert(), false);
    assert.equal(
      await readFile(join(root, "src/a.ts"), "utf8"),
      "export const a = 999;\n",
      "the agent's write is still there, and the user has no way back",
    );
  });

  test("adopting nothing leaves a fresh manager fresh", async () => {
    // A session rebuilt before the agent wrote anything has no snapshot to pass,
    // and that must not be mistaken for one.
    const fixture = await repo();
    const cp = manager(fixture.root);
    await cp.available();
    cp.adopt(null);
    assert.equal(cp.current, null);
    assert.equal(await cp.revert(), false);
  });

  test("an adopted checkpoint is the one reported as current", async () => {
    const { root, taken } = await dirtyRepoWithCheckpoint();
    const second = manager(root);
    await second.available();
    second.adopt(taken);
    assert.deepEqual(second.current, taken);
  });
});
