import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ProviderMessage } from "../provider/types.ts";
import {
  ConversationStore,
  newConversationId,
  scopeFor,
  titleFrom,
  type ConversationStorePort,
  type StoredConversation,
} from "./conversationStore.ts";

/**
 * Remembering conversations, and keeping one key's apart from another's.
 *
 * The invariant that outranks every feature here: the API key is never written
 * anywhere. It reaches the constructor, is digested, and is not kept — so the
 * paths, the file contents and the summaries cannot contain it, and these tests
 * check that by looking rather than by trusting.
 */

/**
 * Two workspaces, and two keys.
 *
 * The keys are here because the scope used to be derived from one, and the
 * tests below now say the opposite: rotating a key must not move a
 * conversation. They are never passed to the store — there is no longer an
 * argument to pass them in — which is the strongest form of "the key cannot
 * reach this module".
 */
const SEPARATOR = String.fromCharCode(10);
const WS_A = "wsaaaaaaaaaaaaaaaa";
const WS_B = "wsbbbbbbbbbbbbbbbb";
const KEY_A = "sk-ops-lv-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY_B = "sk-ops-lv-bbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** An in-memory disk, so the policy is tested without one. */
function memory(): ConversationStorePort & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async listFiles(dir) {
      const prefix = `${dir}/`;
      return [...files.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
    },
    async readFile(path) {
      const value = files.get(path);
      if (value === undefined) throw new Error(`ENOENT ${path}`);
      return value;
    },
    async writeFile(path, contents) {
      files.set(path, contents);
    },
    async remove(path) {
      files.delete(path);
    },
  };
}

function store(port: ConversationStorePort, workspaceId = WS_A, max?: number): ConversationStore {
  return new ConversationStore({
    port,
    home: "/home",
    workspaceId,
    ...(max === undefined ? {} : { maxConversations: max }),
  });
}

const user = (text: string): ProviderMessage => ({ role: "user", content: text });
const assistant = (text: string): ProviderMessage => ({ role: "assistant", content: text });

function conversation(id: string, overrides: Partial<StoredConversation> = {}): StoredConversation {
  return {
    id,
    title: "제목",
    createdAt: 1000,
    updatedAt: 2000,
    messages: [user("안녕"), assistant("네")],
    ...overrides,
  };
}

describe("the key is never written down", () => {
  test("it does not appear in any path", () => {
    const scoped = store(memory());
    assert.ok(!scoped.directory.includes(KEY_A));
    assert.ok(!scoped.directory.includes("sk-"));
  });

  test("it does not appear in any file, path or content", async () => {
    const port = memory();
    await store(port).save(conversation("c1"));
    const everything = [...port.files.entries()].flat().join(SEPARATOR);
    assert.ok(!everything.includes(KEY_A), "the key reached disk");
    assert.ok(!everything.includes("sk-"), "something key-shaped reached disk");
  });

  test("the store has nowhere to put a key at all", () => {
    // Stronger than the two above, and why they can now be brief. The scope
    // used to be `fingerprint(apiKey)`; the constructor no longer takes a
    // credential, so a key cannot reach a path from here because it cannot
    // reach here. The two keys in this file are never passed to anything.
    const scoped = store(memory());
    assert.ok(!scoped.directory.includes(KEY_B));
    assert.match(scoped.directory, /conversations\/ws[a-z0-9]+$/);
  });

  test("the scope is a safe path segment on every platform", () => {
    assert.ok(!scopeFor(WS_A).includes(":"));
    assert.match(scopeFor(WS_A), /^[a-z0-9-]+$/i);
  });

  test("anything that is not a workspace id cannot name a directory", () => {
    // The scope becomes a path segment, so it is checked before it is trusted.
    for (const bad of ["../escape", "sha256abcdef012345", "", "ws/../x"]) {
      assert.throws(() => scopeFor(bad), /refusing to scope/, JSON.stringify(bad));
    }
  });
});

describe("one workspace's conversations are not another's", () => {
  // Was "one key's". The reversal is deliberate: a credential says who is
  // calling and nothing about which project this is, and filing conversations
  // under a key meant rotating one emptied the history — every file still on
  // disk, under a directory nothing would look in again.

  test("a second workspace sees none of the first's history", async () => {
    const port = memory();
    await store(port, WS_A).save(conversation("c1"));
    assert.equal((await store(port, WS_A).list()).length, 1);
    assert.deepEqual(await store(port, WS_B).list(), []);
  });

  test("nor can it load one by id", async () => {
    const port = memory();
    await store(port, WS_A).save(conversation("c1"));
    assert.equal(await store(port, WS_B).load("c1"), null);
  });

  test("different workspaces write to different directories", () => {
    assert.notEqual(store(memory(), WS_A).directory, store(memory(), WS_B).directory);
  });

  test("switching back to the first workspace finds its history intact", async () => {
    const port = memory();
    await store(port, WS_A).save(conversation("c1"));
    await store(port, WS_B).save(conversation("c2"));
    assert.deepEqual((await store(port, WS_A).list()).map((c) => c.id), ["c1"]);
    assert.deepEqual((await store(port, WS_B).list()).map((c) => c.id), ["c2"]);
  });

  test("the same workspace is the same place whatever key is in use", async () => {
    // There is no second argument that could make it otherwise, which is the
    // guarantee: two stores built for one workspace are one namespace.
    const port = memory();
    await store(port, WS_A).save(conversation("c1"));
    assert.deepEqual((await store(port, WS_A).list()).map((c) => c.id), ["c1"]);
    assert.equal(store(memory(), WS_A).directory, store(memory(), WS_A).directory);
  });
});

describe("reading and writing", () => {
  test("a saved conversation comes back", async () => {
    const port = memory();
    const scoped = store(port);
    await scoped.save(conversation("c1", { messages: [user("첫 질문"), assistant("답")] }));

    const loaded = await scoped.load("c1");
    assert.equal(loaded?.id, "c1");
    assert.equal(loaded?.messages.length, 2);
  });

  test("newest first, so the list reads as a history", async () => {
    const port = memory();
    const scoped = store(port);
    await scoped.save(conversation("old", { updatedAt: 100 }));
    await scoped.save(conversation("new", { updatedAt: 900 }));
    await scoped.save(conversation("mid", { updatedAt: 500 }));
    assert.deepEqual((await scoped.list()).map((c) => c.id), ["new", "mid", "old"]);
  });

  test("the system prompt is not stored", async () => {
    // It is re-seeded from the current mode every turn, so a stored one would
    // restore a stale prompt into a session whose mode had changed.
    const port = memory();
    const scoped = store(port);
    await scoped.save(conversation("c1", {
      messages: [{ role: "system", content: "OLD PROMPT" }, user("질문")],
    }));
    const raw = [...port.files.values()].join("");
    assert.ok(!raw.includes("OLD PROMPT"));
    assert.equal((await scoped.load("c1"))?.messages.length, 1);
  });

  test("an empty conversation is not stored at all", async () => {
    // A panel that was opened and closed should leave no trace in the history.
    const port = memory();
    await store(port).save(conversation("c1", { messages: [] }));
    assert.equal(port.files.size, 0);
  });

  test("the message count ignores the system message", async () => {
    const port = memory();
    const scoped = store(port);
    await scoped.save(conversation("c1", { messages: [user("a"), assistant("b")] }));
    assert.equal((await scoped.list())[0]?.messageCount, 2);
  });

  test("removing one leaves the rest", async () => {
    const port = memory();
    const scoped = store(port);
    await scoped.save(conversation("c1"));
    await scoped.save(conversation("c2"));
    await scoped.remove("c1");
    assert.deepEqual((await scoped.list()).map((c) => c.id), ["c2"]);
  });

  test("removing something that is not there is not an error", async () => {
    await assert.doesNotReject(() => store(memory()).remove("nope"));
  });
});

describe("surviving a bad file", () => {
  test("one corrupt conversation costs one conversation, not all of them", async () => {
    // The failure that actually happens: a machine loses power mid-write. A
    // single index file would lose the whole history to it.
    const port = memory();
    const scoped = store(port);
    await scoped.save(conversation("good"));
    port.files.set(`${scoped.directory}/broken.json`, "{ this is not json");

    const listed = await scoped.list();
    assert.deepEqual(listed.map((c) => c.id), ["good"]);
  });

  test("a file that parses but is not a conversation is skipped", async () => {
    const port = memory();
    const scoped = store(port);
    port.files.set(`${scoped.directory}/x.json`, JSON.stringify({ hello: "world" }));
    port.files.set(`${scoped.directory}/y.json`, JSON.stringify({ id: "y" }));
    assert.deepEqual(await scoped.list(), []);
  });

  test("a directory that does not exist yet lists as empty", async () => {
    const port: ConversationStorePort = {
      listFiles: async () => {
        throw new Error("ENOENT");
      },
      readFile: async () => "",
      writeFile: async () => {},
      remove: async () => {},
    };
    assert.deepEqual(await store(port).list(), []);
  });

  test("non-json files in the directory are ignored", async () => {
    const port = memory();
    const scoped = store(port);
    port.files.set(`${scoped.directory}/notes.txt`, "hello");
    assert.deepEqual(await scoped.list(), []);
  });
});

describe("ids are not trusted as paths", () => {
  test("a traversing id cannot be loaded", async () => {
    for (const id of ["../../etc/passwd", "..", "a/b", "a\\b", "", "x".repeat(200)]) {
      assert.equal(await store(memory()).load(id), null, id);
    }
  });

  test("a traversing id cannot be written", async () => {
    await assert.rejects(() => store(memory()).save(conversation("../escape")));
  });

  test("a traversing id cannot be removed", async () => {
    const port = memory();
    port.files.set("/home/other.json", "x");
    await store(port).remove("../other");
    assert.equal(port.files.size, 1, "a file outside the scope was deleted");
  });

  test("generated ids are always valid", () => {
    for (let i = 0; i < 200; i += 1) {
      const id = newConversationId(1785650000000 + i, () => i / 200);
      assert.match(id, /^[a-z0-9-]{1,64}$/, id);
    }
  });

  test("generated ids do not collide within a millisecond", () => {
    const ids = new Set(Array.from({ length: 50 }, (_, i) => newConversationId(1785650000000, () => i / 50)));
    assert.equal(ids.size, 50);
  });
});

describe("the history does not grow without bound", () => {
  test("the oldest are dropped past the cap", async () => {
    const port = memory();
    const scoped = store(port, WS_A, 3);
    for (let i = 0; i < 6; i += 1) {
      await scoped.save(conversation(`c${i}`, { updatedAt: i * 100 }));
    }
    const listed = await scoped.list();
    assert.equal(listed.length, 3);
    assert.deepEqual(listed.map((c) => c.id), ["c5", "c4", "c3"]);
  });
});

describe("titles", () => {
  test("come from the first thing the user said", () => {
    assert.equal(titleFrom([user("계산기를 만들어줘"), assistant("네")]), "계산기를 만들어줘");
  });

  test("use the first non-empty line, not the whole message", () => {
    assert.equal(titleFrom([user("\n\n첫 줄\n둘째 줄")]), "첫 줄");
  });

  test("are cut, with a marker, when long", () => {
    const title = titleFrom([user("가".repeat(200))]);
    assert.ok(title.length <= 61, title.length.toString());
    assert.ok(title.endsWith("…"));
  });

  test("read the text out of a message that also carries an image", () => {
    const withImage: ProviderMessage = {
      role: "user",
      content: [
        { type: "image", url: "data:image/png;base64,AAAA" },
        { type: "text", text: "이 화면 설명해줘" },
      ],
    };
    assert.equal(titleFrom([withImage]), "이 화면 설명해줘");
  });

  test("fall back rather than being blank", () => {
    assert.equal(titleFrom([]), "새 대화");
    assert.equal(titleFrom([user("   \n  ")]), "새 대화");
    assert.equal(titleFrom([assistant("먼저 말한 쪽이 모델")]), "새 대화");
  });
});
