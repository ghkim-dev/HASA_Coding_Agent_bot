import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ConversationStore, LEGACY_SCOPE, type ConversationStorePort } from "./conversationStore.ts";
import { MAIN_BRANCH_ID, type ConversationTurn } from "./conversationGraph.ts";
import { workspaceIdentityOf } from "./workspaceIdentity.ts";
import type { ProviderMessage } from "../provider/types.ts";
import type { SessionEvent } from "./sessionEvents.ts";

/**
 * One project's conversations never appear under another's name.
 *
 * The thing that makes this urgent rather than tidy is what a conversation now
 * carries. Before the turn graph, mis-filing one showed the wrong transcript.
 * After it, opening one puts its whole chain into the model's context — so the
 * agent would answer about the wrong project, confidently, from a history the
 * user cannot place.
 *
 * Two defences, and both are tested here. The directory scopes by workspace, and
 * the file itself records which workspace it was had in, so a conversation that
 * arrives by another route — a backup, a copy between machines, a hand-moved
 * file — is refused rather than shown.
 */

const WS_A = "wsaaaaaaaaaaaaaaaa";
const WS_B = "wsbbbbbbbbbbbbbbbb";
/** Never a real key. The point is that no store can be given one. */
const FAKE_SECRET = "HASA_SECRET_MUST_NOT_APPEAR_123456";

function memory(): ConversationStorePort & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async listFiles(dir) {
      // Directory-like: one level below `dir`, de-duplicated, the way a real
      // `readdir` reports folders as well as files.
      const out = new Set<string>();
      for (const path of files.keys()) {
        if (!path.startsWith(`${dir}/`)) continue;
        out.add(path.slice(dir.length + 1).split("/")[0]!);
      }
      return [...out];
    },
    async readFile(path) {
      const found = files.get(path);
      if (found === undefined) throw new Error(`ENOENT ${path}`);
      return found;
    },
    async writeFile(path, contents) {
      files.set(path, contents);
    },
    async remove(path) {
      files.delete(path);
    },
  };
}

function store(port: ConversationStorePort, workspaceId: string): ConversationStore {
  return new ConversationStore({ port, home: "/home", workspaceId });
}

function exchange(n: string): ProviderMessage[] {
  return [
    { role: "user", content: `질문 ${n}` },
    { role: "assistant", content: `답 ${n}`, toolCalls: [] },
  ];
}

function turnAt(id: string, at: number, n = id): Omit<ConversationTurn, "parentTurnId"> {
  return {
    id,
    state: "completed",
    createdAt: at,
    completedAt: at + 10,
    events: [{ type: "assistant_text", id: `${id}-e`, turnId: id, at, text: `답 ${n}` } as SessionEvent],
    messageDelta: exchange(n),
    restorable: true,
  };
}

describe("8 — a conversation from one workspace is not adopted by another", () => {
  test("the same conversation id in two workspaces is two conversations", async () => {
    // Ids are minted per conversation and can collide across workspaces. The
    // scope is what keeps them apart; the id never was.
    const port = memory();
    await store(port, WS_A).appendTurn("c1", turnAt("t0", 100, "A"));
    await store(port, WS_B).appendTurn("c1", turnAt("t0", 200, "B"));

    const a = await store(port, WS_A).load("c1");
    const b = await store(port, WS_B).load("c1");
    assert.match(JSON.stringify(a?.messages), /답 A/);
    assert.match(JSON.stringify(b?.messages), /답 B/);
    assert.ok(!JSON.stringify(a?.messages).includes("답 B"));
  });

  test("a file that says it belongs elsewhere is refused, not shown", async () => {
    // Defence in depth. The directory already separates them; this catches a
    // file that arrived by another route — restored from a backup, copied
    // between machines, moved by hand.
    const port = memory();
    const a = store(port, WS_A);
    await a.appendTurn("c1", turnAt("t0", 100, "A"));

    const written = port.files.get(`${a.directory}/c1.json`)!;
    assert.match(written, new RegExp(WS_A), "the file records its workspace");

    // The same bytes, dropped into B's directory.
    port.files.set(`${store(port, WS_B).directory}/c1.json`, written);
    assert.equal(await store(port, WS_B).load("c1"), null);
    assert.deepEqual(await store(port, WS_B).list(), []);
  });

  test("the list of one workspace never contains another's", async () => {
    const port = memory();
    await store(port, WS_A).appendTurn("a1", turnAt("t0", 100));
    await store(port, WS_A).appendTurn("a2", turnAt("t0", 100));
    await store(port, WS_B).appendTurn("b1", turnAt("t0", 100));

    assert.deepEqual((await store(port, WS_A).list()).map((c) => c.id).sort(), ["a1", "a2"]);
    assert.deepEqual((await store(port, WS_B).list()).map((c) => c.id), ["b1"]);
  });
});

describe("Scenario C — the same key across two workspaces keeps them apart", () => {
  test("nothing about the credential enters the namespace", async () => {
    // The store has no parameter for a key at all, so "the same key" is not
    // expressible here — which is the strongest form of the guarantee. Both
    // workspaces are built the way production builds them and stay separate.
    const port = memory();
    await store(port, WS_A).appendTurn("c1", turnAt("t0", 100, "A"));
    await store(port, WS_B).appendTurn("c2", turnAt("t0", 100, "B"));

    for (const [path, contents] of port.files) {
      assert.ok(!path.includes(FAKE_SECRET));
      assert.ok(!contents.includes(FAKE_SECRET));
      assert.ok(!path.includes("sha256"), `a key-scoped directory was written: ${path}`);
    }
    assert.deepEqual((await store(port, WS_A).list()).map((c) => c.id), ["c1"]);
    assert.deepEqual((await store(port, WS_B).list()).map((c) => c.id), ["c2"]);
  });
});

describe("Scenario B — rotating a key keeps the workspace", () => {
  test("a conversation created before a rotation is there after it", async () => {
    // The failure this replaces: conversations were filed under
    // `fingerprint(apiKey)`, so changing a key emptied the history — every file
    // still on disk, under a directory nothing would look in again.
    const port = memory();
    await store(port, WS_A).appendTurn("c1", turnAt("t0", 100));
    await store(port, WS_A).addCheckpoint("c1", {
      checkpointId: "cp1",
      turnId: "t0",
      branchId: MAIN_BRANCH_ID,
      message: "여기까지",
      at: 200,
    });

    // A rotation changes nothing that this store can see, because the store
    // cannot see a key. Same workspace, same store, same conversation.
    const afterRotation = store(port, WS_A);
    const loaded = await afterRotation.load("c1");
    assert.ok(loaded !== null);
    assert.equal(loaded.checkpoints?.length, 1);
  });

  test("and the workspace identity itself does not move", async () => {
    const before = await workspaceIdentityOf(["/projects/foo"], { platform: "linux" });
    const after = await workspaceIdentityOf(["/projects/foo"], { platform: "linux" });
    assert.equal(before.id, after.id);
  });
});

describe("14 — conversations written before workspaces existed", () => {
  /** The old layout: filed under a key fingerprint, with no workspace recorded. */
  function seedLegacy(port: ConversationStorePort & { files: Map<string, string> }): string {
    const scope = "sha256c726373c13be";
    port.files.set(
      `/home/conversations/${scope}/old1.json`,
      JSON.stringify({
        id: "old1",
        title: "옛 대화",
        createdAt: 500,
        updatedAt: 600,
        messages: [
          { role: "user", content: "안녕" },
          { role: "assistant", content: "반가워요", toolCalls: [] },
        ],
      }),
    );
    return scope;
  }

  test("the legacy directory is recognisable on sight", () => {
    // Workspace ids start with `ws`; key fingerprints with `sha256`. A reader
    // can tell which era a directory is from without a manifest.
    assert.equal(LEGACY_SCOPE.test("sha256c726373c13be"), true);
    assert.equal(LEGACY_SCOPE.test(WS_A), false);
  });

  test("they are listed, so nothing is silently lost", async () => {
    const port = memory();
    const scope = seedLegacy(port);
    const legacy = await store(port, WS_A).listLegacy();
    assert.deepEqual(legacy.map((c) => [c.id, c.scope]), [["old1", scope]]);
  });

  test("but they are not in this workspace's list", async () => {
    // The guess this refuses: they record no workspace, so attaching them to
    // whichever folder happens to be open would be a fact invented from
    // nothing.
    const port = memory();
    seedLegacy(port);
    assert.deepEqual(await store(port, WS_A).list(), []);
    assert.equal(await store(port, WS_A).load("old1"), null);
  });

  test("opening one is the explicit act that binds it", async () => {
    const port = memory();
    const scope = seedLegacy(port);
    const s = store(port, WS_A);

    const adopted = await s.adoptLegacy(scope, "old1");
    assert.ok(adopted !== null);
    assert.equal(adopted.workspace?.id, WS_A);
    assert.equal(adopted.createdAt, 500, "adopting does not restart the clock");
    assert.deepEqual((await s.list()).map((c) => c.id), ["old1"]);
  });

  test("adopting leaves the original alone", async () => {
    // A move that cannot be undone is not one to make on the user's behalf, and
    // a second window may still be looking at the old copy.
    const port = memory();
    const scope = seedLegacy(port);
    await store(port, WS_A).adoptLegacy(scope, "old1");
    assert.ok(port.files.has(`/home/conversations/${scope}/old1.json`));
  });

  test("a second workspace can adopt it too, and gets its own copy", async () => {
    const port = memory();
    const scope = seedLegacy(port);
    await store(port, WS_A).adoptLegacy(scope, "old1");
    await store(port, WS_B).adoptLegacy(scope, "old1");

    assert.equal((await store(port, WS_A).load("old1"))?.workspace?.id, WS_A);
    assert.equal((await store(port, WS_B).load("old1"))?.workspace?.id, WS_B);
  });

  test("a scope that is not a legacy scope is refused", async () => {
    // The scope becomes a path segment. It is checked before it is trusted.
    const port = memory();
    seedLegacy(port);
    for (const bad of ["../escape", WS_B, "", "sha256"]) {
      assert.equal(await store(port, WS_A).adoptLegacy(bad, "old1"), null, JSON.stringify(bad));
    }
  });
});

describe("every write stamps the workspace", () => {
  test("a turn appended to a conversation records where it happened", async () => {
    const port = memory();
    const s = store(port, WS_A);
    await s.appendTurn("c1", turnAt("t0", 100), { boundRoot: "/projects/foo" });

    const loaded = await s.load("c1");
    assert.equal(loaded?.workspace?.id, WS_A);
    assert.equal(loaded?.workspace?.boundRoot, "/projects/foo");
  });

  test("a later turn does not lose the binding", async () => {
    // The folder a conversation resolves relative paths against is settled on
    // its first turn and kept, so `src/a.ts` means one file for its whole life.
    const port = memory();
    const s = store(port, WS_A);
    await s.appendTurn("c1", turnAt("t0", 100), { boundRoot: "/projects/foo" });
    await s.appendTurn("c1", turnAt("t1", 200));

    assert.equal((await s.load("c1"))?.workspace?.boundRoot, "/projects/foo");
  });
});
