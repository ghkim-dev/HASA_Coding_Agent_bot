import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ConversationStore, type ConversationStorePort } from "./conversationStore.ts";
import { reduceSession } from "./sessionView.ts";

/**
 * Reading your own history is a local operation.
 *
 * This is here because it stopped being one. `AgentHost.openConversation` built
 * a model session before it would show a stored conversation — which validates
 * the key and fetches the model list — so when the gateway went down the history
 * list still showed every conversation and clicking one said "대화를 열지
 * 못했습니다." Nothing about reading a file needs a model.
 *
 * What is fixed in the host is the ordering. What is fixed here is the claim
 * underneath it: everything needed to draw a past conversation comes off the
 * disk, and the path from bytes to blocks touches no network.
 */

/** A v1 file, the generation actually sitting in users' storage today. */
const V1 = JSON.stringify({
  id: "c1",
  title: "vision_language.py를 실행해줘.",
  createdAt: 1_785_807_887_160,
  updatedAt: 1_785_807_899_000,
  messages: [
    { role: "user", content: "vision_language.py를 실행해줘." },
    {
      role: "assistant",
      content: "먼저 파일이 있는지 확인하겠습니다.",
      toolCalls: [
        { id: "call-1", name: "list_files", arguments: { path: "." }, rawArguments: "{}", argumentsValid: true },
      ],
    },
    { role: "tool", toolCallId: "call-1", content: "assets/\nvision_language.py" },
    {
      role: "assistant",
      content: "실행하겠습니다.",
      toolCalls: [
        { id: "call-2", name: "run_command", arguments: {}, rawArguments: "{}", argumentsValid: true },
      ],
    },
    { role: "tool", toolCallId: "call-2", content: "정확도 0.94" },
    { role: "assistant", content: "정확도 0.94로 실행됐습니다.", toolCalls: [] },
  ],
});

/**
 * A filesystem and nothing else.
 *
 * The point of the test is what is absent: no provider, no model, no network,
 * no session. If drawing a stored conversation ever needs one of those again,
 * there is nowhere here to get it.
 */
function diskOnly(files: Record<string, string>): ConversationStorePort {
  return {
    async listFiles(dir) {
      return Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1));
    },
    async readFile(path) {
      const found = files[path];
      if (found === undefined) throw new Error(`ENOENT ${path}`);
      return found;
    },
    async writeFile() {
      throw new Error("reading a conversation must not write");
    },
    async remove() {
      throw new Error("reading a conversation must not delete");
    },
  };
}

function storeWith(raw: string): ConversationStore {
  const store = new ConversationStore({ port: diskOnly({}), home: "/home", apiKey: "k" });
  return new ConversationStore({
    port: diskOnly({ [`${store.directory}/c1.json`]: raw }),
    home: "/home",
    apiKey: "k",
  });
}

describe("a stored conversation is readable with nothing but the disk", () => {
  test("the list does not need a gateway", async () => {
    const summaries = await storeWith(V1).list();
    assert.deepEqual(
      summaries.map((s) => ({ id: s.id, title: s.title, messageCount: s.messageCount })),
      [{ id: "c1", title: "vision_language.py를 실행해줘.", messageCount: 6 }],
    );
  });

  test("and neither does opening one", async () => {
    const loaded = await storeWith(V1).load("c1");
    assert.ok(loaded !== null, "the file is right there");
    assert.equal(loaded.messages.length, 6);
    assert.equal(loaded.createdAt, 1_785_807_887_160);
  });

  test("the transcript it draws is the whole conversation, not just the prose", async () => {
    // The v1 projection this replaced skipped `role: "tool"` messages and never
    // read `toolCalls`, so a reopened conversation showed questions and answers
    // with the work between them missing.
    const loaded = await storeWith(V1).load("c1");
    const view = reduceSession(loaded?.events ?? []);

    const text = JSON.stringify(view.turns);
    assert.match(text, /vision_language\.py를 실행해줘/, "the question");
    assert.match(text, /정확도 0\.94로 실행됐습니다/, "the answer");
    assert.match(text, /list_files/, "the first tool");
    assert.match(text, /run_command/, "the second tool");

    // Both exchanges, each split into what the user said and what the agent did.
    assert.ok(view.turns.length >= 2);
    assert.ok(view.turns.some((t) => t.role === "user"));
    assert.ok(view.turns.some((t) => t.role === "agent"));
  });

  test("the model half is available at the same moment, from the same load", async () => {
    // The host defers putting these into a session until one exists, but it
    // must have them in hand when the conversation opens — otherwise the two
    // halves come from different reads and can disagree.
    const loaded = await storeWith(V1).load("c1");
    assert.ok(loaded !== null);
    assert.equal(loaded.messages.filter((m) => m.role === "user").length, 1);
    assert.equal(loaded.messages.filter((m) => m.role === "tool").length, 2);
    assert.deepEqual(loaded.messages, JSON.parse(V1).messages);
  });

  test("a corrupt file costs one conversation, not the list", async () => {
    const store = new ConversationStore({ port: diskOnly({}), home: "/home", apiKey: "k" });
    const withBadFile = new ConversationStore({
      port: diskOnly({
        [`${store.directory}/c1.json`]: V1,
        [`${store.directory}/broken.json`]: "{ this is not json",
      }),
      home: "/home",
      apiKey: "k",
    });
    const summaries = await withBadFile.list();
    assert.deepEqual(summaries.map((s) => s.id), ["c1"]);
  });
});
