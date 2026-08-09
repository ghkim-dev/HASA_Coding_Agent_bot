import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_WORKSPACE_ID,
  canonicalizeRoot,
  canonicalizeSync,
  identityOf,
  isValidWorkspaceId,
  workspaceIdentityOf,
  type WorkspaceRoot,
} from "./workspaceIdentity.ts";
import { describeAmbiguity, resolveWorkspaceContext, rootContaining } from "./workspaceContext.ts";

/**
 * Which workspace this is, and which folder to work in.
 *
 * Two claims, and the second is not the first. A window can be one workspace
 * and still have several folders; the workspace is what conversations are filed
 * under, and the folder is where the next `read_file` looks. Conflating them is
 * how a two-folder window ends up with the agent reading one project and the
 * history of another.
 *
 * The rule underneath all of it:
 *
 *   The same workspace is reliably the same workspace, and two different
 *   workspaces are never the same one.
 */

/** A root as the resolver takes them, with canonicalization already applied. */
function root(path: string, platform: NodeJS.Platform = "linux"): WorkspaceRoot {
  return { path, canonical: canonicalizeSync(path, platform) };
}

const POSIX: NodeJS.Platform = "linux";

describe("1 — a single root has a stable identity", () => {
  test("the same folder is the same workspace, every time", () => {
    const a = identityOf([root("/projects/foo")]);
    const b = identityOf([root("/projects/foo")]);
    assert.equal(a.id, b.id);
    assert.match(a.id, /^ws[0-9a-f]{16}$/);
  });

  test("an empty window is a workspace of its own, not an error", () => {
    // A window with no folder open is a real state and callers have to handle
    // it. Throwing here would push that handling into every call site.
    assert.equal(identityOf([]).id, EMPTY_WORKSPACE_ID);
    assert.deepEqual(identityOf([]).roots, []);
  });
});

describe("2/3 — spellings of the same path are the same workspace", () => {
  test("a trailing separator does not make a new workspace", () => {
    assert.equal(canonicalizeSync("/projects/foo/", POSIX), canonicalizeSync("/projects/foo", POSIX));
    assert.equal(identityOf([root("/projects/foo/")]).id, identityOf([root("/projects/foo")]).id);
  });

  test("a bare root keeps its separator, because there it means something", () => {
    assert.equal(canonicalizeSync("/", POSIX), "/");
    assert.equal(canonicalizeSync("C:\\", "win32"), "c:\\");
  });

  test("relative segments collapse", () => {
    assert.equal(canonicalizeSync("/projects/bar/../foo", POSIX), "/projects/foo");
    assert.equal(canonicalizeSync("/projects/./foo", POSIX), "/projects/foo");
  });

  test("Windows folds case and normalises separators", () => {
    const a = canonicalizeSync("C:\\Work\\Foo", "win32");
    const b = canonicalizeSync("c:/work/foo", "win32");
    assert.equal(a, b);
    assert.equal(identityOf([root("C:\\Work\\Foo", "win32")]).id, identityOf([root("c:/work/foo", "win32")]).id);
  });

  test("Linux does not fold case, because there it is a different folder", () => {
    // Folding everywhere would merge two directories that genuinely differ.
    assert.notEqual(canonicalizeSync("/projects/Foo", POSIX), canonicalizeSync("/projects/foo", POSIX));
  });

  test("a symlink resolves to what it points at", async () => {
    const links: Record<string, string> = { "/link/foo": "/real/foo" };
    const fake = async (p: string): Promise<string> => links[p] ?? p;
    const viaLink = await canonicalizeRoot("/link/foo", { realpath: fake, platform: POSIX });
    const direct = await canonicalizeRoot("/real/foo", { realpath: fake, platform: POSIX });
    assert.equal(viaLink.canonical, direct.canonical);
    assert.equal(viaLink.path, "/link/foo", "what the editor said is kept, for showing to a person");
  });

  test("a root that cannot be resolved still gets an identity", async () => {
    // A deleted folder, an unmounted drive. Refusing would mean the user cannot
    // open the conversation that describes what was on it.
    const failing = async (): Promise<string> => {
      throw new Error("ENOENT");
    };
    const resolved = await canonicalizeRoot("/gone/foo", { realpath: failing, platform: POSIX });
    assert.equal(resolved.canonical, "/gone/foo");
  });
});

describe("4/5/6 — multi-root identity", () => {
  test("two folders are one workspace", () => {
    const id = identityOf([root("/projects/a"), root("/projects/b")]).id;
    assert.match(id, /^ws[0-9a-f]{16}$/);
  });

  test("reordering the folders does not change the workspace", () => {
    // Dragging one above another in the sidebar is a change of view, not of
    // project. A history that vanished when they did it would be a bug they
    // could not distinguish from data loss.
    const ab = identityOf([root("/projects/a"), root("/projects/b")]);
    const ba = identityOf([root("/projects/b"), root("/projects/a")]);
    assert.equal(ab.id, ba.id);
    assert.deepEqual(ab.roots.map((r) => r.canonical), ba.roots.map((r) => r.canonical));
  });

  test("the same folder added twice is one folder", () => {
    assert.equal(identityOf([root("/projects/a"), root("/projects/a")]).id, identityOf([root("/projects/a")]).id);
  });

  test("different folders are different workspaces", () => {
    assert.notEqual(identityOf([root("/projects/foo")]).id, identityOf([root("/projects/bar")]).id);
  });

  test("adding a folder makes a different workspace", () => {
    // Stated because it is a real consequence rather than an oversight: a
    // two-folder window is not the one-folder window plus something.
    assert.notEqual(identityOf([root("/a")]).id, identityOf([root("/a"), root("/b")]).id);
  });

  test("two root sets cannot collide by concatenation", () => {
    // `/a/b` + `/c` must not digest the same material as `/a` + `/b/c`.
    assert.notEqual(identityOf([root("/a/b"), root("/c")]).id, identityOf([root("/a"), root("/b/c")]).id);
  });

  test("the .code-workspace file is recorded but is not the identity", () => {
    // Two users open the same file from different checkouts; the folders are
    // where the work is. Moving the file must not change which workspace this
    // is for a reason the user did not act on.
    const withFile = identityOf([root("/projects/a")], "/somewhere/my.code-workspace");
    const without = identityOf([root("/projects/a")]);
    assert.equal(withFile.id, without.id);
    assert.equal(withFile.configPath, "/somewhere/my.code-workspace");
  });
});

describe("7 — the identity is the roots, and only the roots", () => {
  /**
   * Pinned values.
   *
   * Reproducibility alone does not say what went into the digest: mixing a
   * constant — a credential, a build id, a machine name — keeps every
   * before/after comparison equal while quietly making the identity depend on
   * something it must not. Only a value computed elsewhere catches that, so
   * here it is written down.
   *
   * These are not arbitrary. Changing one means every stored conversation is
   * now filed under a name nothing will look for again, so updating them is a
   * migration and should feel like one.
   */
  const GOLDEN: ReadonlyArray<[string, WorkspaceRoot[]]> = [
    ["ws0879ff19d931eaf1", [root("/projects/foo")]],
    ["wsd029a08e4843d74d", [root("/projects/a"), root("/projects/b")]],
    ["ws4194635deebd1d86", [root("C:\\Work\\Foo", "win32")]],
  ];

  test("a known set of roots produces a known id", () => {
    for (const [expected, roots] of GOLDEN) {
      assert.equal(identityOf(roots).id, expected, roots.map((r) => r.canonical).join(" + "));
    }
  });

  test("nothing but the roots is in it", () => {
    // The reversal this phase is for. Conversations were filed under
    // `fingerprint(apiKey)`, so rotating a key emptied the history — and any
    // return of that, in any form, changes these digests.
    const before = await0(identityOf([root("/projects/foo")]));
    assert.equal(before.id, GOLDEN[0]![0]);
    assert.deepEqual(Object.keys(before).sort(), ["id", "roots"]);
  });

  test("the same roots give the same id every time", async () => {
    const a = await workspaceIdentityOf(["/projects/foo"], { platform: POSIX });
    const b = await workspaceIdentityOf(["/projects/foo"], { platform: POSIX });
    assert.equal(a.id, b.id);
  });

  test("no credential-shaped text can appear in an id", () => {
    const id = identityOf([root("/projects/sk-ops-lv-secret")]).id;
    assert.ok(!id.includes("sk-"));
    assert.match(id, /^ws[0-9a-f]{16}$/);
  });
});

/** Identity is synchronous; this only keeps the test above reading in order. */
function await0<T>(value: T): T {
  return value;
}

describe("ids are safe as directory names", () => {
  test("what the identity produces is accepted", () => {
    assert.equal(isValidWorkspaceId(identityOf([root("/a")]).id), true);
    assert.equal(isValidWorkspaceId(EMPTY_WORKSPACE_ID), true);
  });

  test("anything else is not", () => {
    for (const bad of ["", "../escape", "sha256abcdef012345", "ws/../x", "WS-UPPER!", "a".repeat(80)]) {
      assert.equal(isValidWorkspaceId(bad), false, JSON.stringify(bad));
    }
  });
});

describe("9/10 — which folder to work in", () => {
  const A = root("/projects/a");
  const B = root("/projects/b");

  test("one folder needs no deciding", () => {
    const context = resolveWorkspaceContext({ folders: [A], platform: POSIX });
    assert.equal(context.activeRoot?.canonical, A.canonical);
    assert.equal(context.reason, "only-root");
    assert.equal(context.ambiguous, false);
  });

  test("the folder holding the open file wins in a multi-root window", () => {
    const context = resolveWorkspaceContext({
      folders: [A, B],
      activeFile: "/projects/b/src/main.ts",
      platform: POSIX,
    });
    assert.equal(context.activeRoot?.canonical, B.canonical);
    assert.equal(context.reason, "active-editor");
  });

  test("several folders and nothing to choose between them is ambiguous, not the first one", () => {
    // The whole point. `workspaceFolders[0]` answered this wrongly and
    // silently, and every file read and command run landed on one side of a
    // coin toss the user never saw.
    const context = resolveWorkspaceContext({ folders: [A, B], platform: POSIX });
    assert.equal(context.activeRoot, null);
    assert.equal(context.ambiguous, true);
    assert.match(String(describeAmbiguity(context)), /여러 개/);
  });

  test("no folder at all is a different problem, and says so", () => {
    const context = resolveWorkspaceContext({ folders: [], platform: POSIX });
    assert.equal(context.ambiguous, false, "there is nothing to be ambiguous between");
    assert.match(String(describeAmbiguity(context)), /폴더를 연/);
  });

  test("a conversation already working somewhere stays there", () => {
    // Beats the active editor deliberately: otherwise the same relative path
    // would mean different files within one conversation, depending on what the
    // user had clicked on.
    const context = resolveWorkspaceContext({
      folders: [A, B],
      boundRoot: "/projects/a",
      activeFile: "/projects/b/src/main.ts",
      platform: POSIX,
    });
    assert.equal(context.activeRoot?.canonical, A.canonical);
    assert.equal(context.reason, "bound");
  });

  test("an explicit choice beats the open file", () => {
    const context = resolveWorkspaceContext({
      folders: [A, B],
      chosenRoot: "/projects/a",
      activeFile: "/projects/b/src/main.ts",
      platform: POSIX,
    });
    assert.equal(context.activeRoot?.canonical, A.canonical);
    assert.equal(context.reason, "chosen");
  });

  test("a binding to a folder that is gone does not pin the session there", () => {
    // The folder was removed from the window. Falling through is right; holding
    // a root that no longer exists is not.
    const context = resolveWorkspaceContext({
      folders: [B],
      boundRoot: "/projects/a",
      activeFile: "/projects/b/src/main.ts",
      platform: POSIX,
    });
    assert.equal(context.activeRoot?.canonical, B.canonical);
    assert.equal(context.reason, "active-editor");
  });

  test("the identity does not depend on which folder was chosen", () => {
    const one = resolveWorkspaceContext({ folders: [A, B], boundRoot: "/projects/a", platform: POSIX });
    const other = resolveWorkspaceContext({ folders: [A, B], boundRoot: "/projects/b", platform: POSIX });
    assert.equal(one.identity.id, other.identity.id);
  });
});

describe("11 — nesting", () => {
  test("a file goes to the innermost root that contains it", () => {
    const outer = root("/project");
    const inner = root("/project/packages/foo");
    const found = rootContaining([outer, inner], "/project/packages/foo/src/a.ts", POSIX);
    assert.equal(found?.canonical, inner.canonical);
  });

  test("a sibling with a shared prefix is not a container", () => {
    // `/project/foobar` is not inside `/project/foo`.
    const found = rootContaining([root("/project/foo")], "/project/foobar/a.ts", POSIX);
    assert.equal(found, null);
  });

  test("the root itself counts as inside itself", () => {
    assert.equal(rootContaining([root("/project")], "/project", POSIX)?.canonical, "/project");
  });

  test("a file outside every root belongs to none", () => {
    assert.equal(rootContaining([root("/project")], "/elsewhere/a.ts", POSIX), null);
  });

  test("Windows containment folds case", () => {
    const found = rootContaining([root("C:\\Work\\Foo", "win32")], "c:/work/foo/src/a.ts", "win32");
    assert.ok(found !== null);
  });
});

describe("12 — git is not the workspace", () => {
  test("identity comes from the folders, whatever is or is not a repository", () => {
    // A workspace need not be a repository, and one that is may contain
    // several. `/project` with a repo at `/project/packages/foo` is one
    // workspace, not two — and the identity says so without asking git.
    const plain = identityOf([root("/project")]);
    const same = identityOf([root("/project")]);
    assert.equal(plain.id, same.id);

    // The nested repository is a different path and therefore a different
    // workspace only if the user actually opens it as one.
    assert.notEqual(plain.id, identityOf([root("/project/packages/foo")]).id);
  });
});
