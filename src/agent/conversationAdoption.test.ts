import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { adoptConversation } from "./conversationAdoption.ts";
import type { StoredConversation } from "./conversationStore.ts";
import type { SessionEvent } from "./sessionEvents.ts";
import type { ProviderMessage } from "../provider/types.ts";

/**
 * Moving the session onto a stored conversation, checked.
 *
 * The host that does this imports `vscode` and cannot be loaded by the test
 * runner, so this arithmetic lived there unmeasured — and `scripts/mutate.mjs`
 * said so in a comment, which is the honest thing to do and not the same as
 * covering it. Lifting it into `conversationAdoption.ts` is what makes these
 * assertions possible; the host now assigns what this returns.
 */

const event = (turnId: string, id: string): SessionEvent => ({
  type: "user_message",
  id,
  turnId,
  at: 1,
  text: "안녕",
});

const message = (text: string): ProviderMessage => ({ role: "user", content: text });

const stored = (over: Partial<StoredConversation> = {}): StoredConversation => ({
  id: "conv-1",
  title: "t",
  createdAt: 1,
  updatedAt: 2,
  messages: [message("첫 요청")],
  events: [event("t1", "e1")],
  ...over,
});

describe("대화 채택", () => {
  test("모든 필드가 같은 대화에서 나온다", () => {
    const adopted = adoptConversation(
      stored({
        id: "conv-7",
        messages: [message("a"), message("b")],
        events: [event("t1", "e1"), event("t1", "e2"), event("t2", "e3")],
        turns: [
          { id: "t1" } as never,
          { id: "t2" } as never,
          { id: "t3" } as never,
        ],
        workspace: { id: "w1", boundRoot: "/home/project" },
      }),
    );
    assert.deepEqual(adopted, {
      conversationId: "conv-7",
      recorded: [event("t1", "e1"), event("t1", "e2"), event("t2", "e3")],
      pendingRestore: [message("a"), message("b")],
      pendingEvents: [],
      pendingDelta: [],
      turnOrdinal: 3,
      boundRoot: "/home/project",
    });
  });

  test("이전 대화의 미전송분은 넘어오지 않는다", () => {
    // Nothing in the input can put anything in these, which is the point: the
    // fields hold what the current turn produced and has not persisted, and
    // carrying them across files one conversation's work under another's.
    const adopted = adoptConversation(stored());
    assert.deepEqual(adopted.pendingEvents, []);
    assert.deepEqual(adopted.pendingDelta, []);
  });

  test("다음 턴 id 는 이벤트가 아니라 턴에서 센다", () => {
    // A turn can end with no events — a refusal, an interrupted run — so
    // counting distinct event turnIds hands the next turn an id already taken.
    const adopted = adoptConversation(
      stored({
        events: [event("t1", "e1")],
        turns: [{ id: "t1" } as never, { id: "t2" } as never],
      }),
    );
    assert.equal(adopted.turnOrdinal, 2);
  });

  test("턴 그래프가 없는 예전 대화는 이벤트에서 센다", () => {
    // v2 and earlier. The event chain is all there is.
    const adopted = adoptConversation(
      stored({ events: [event("t1", "e1"), event("t1", "e2"), event("t2", "e3")], turns: undefined }),
    );
    assert.equal(adopted.turnOrdinal, 2);
  });

  test("다음 턴 id 는 이미 쓰인 턴 수보다 작을 수 없다", () => {
    // The property the two counts exist to satisfy. Stated on its own because
    // either branch could be changed to a number that happens to pass the two
    // cases above while still colliding with a turn that already exists.
    for (const turns of [undefined, [], [{ id: "t1" } as never]]) {
      const adopted = adoptConversation(
        stored({ events: [event("t1", "e1"), event("t2", "e2")], turns }),
      );
      const used = new Set(["t1", "t2"]).size;
      assert.ok(
        adopted.turnOrdinal >= used,
        `turns=${JSON.stringify(turns)} 에서 ${adopted.turnOrdinal} < ${used}`,
      );
    }
  });

  test("저장된 배열을 그대로 넘겨주지 않는다", () => {
    // The store hands back an object it may still be holding. A caller that
    // appends to what it was given would be editing the saved conversation.
    const source = stored();
    const adopted = adoptConversation(source);
    adopted.recorded.push(event("t9", "e9"));
    adopted.pendingRestore.push(message("추가"));
    assert.equal(source.events?.length, 1);
    assert.equal(source.messages.length, 1);
  });

  test("작업 폴더는 대화에서 오고, 없으면 null 이다", () => {
    assert.equal(adoptConversation(stored()).boundRoot, null);
    assert.equal(
      adoptConversation(stored({ workspace: { id: "w1" } })).boundRoot,
      null,
      "workspace 는 있지만 boundRoot 가 없는 경우",
    );
    assert.equal(
      adoptConversation(stored({ workspace: { id: "w1", boundRoot: "/a" } })).boundRoot,
      "/a",
    );
  });

  test("이벤트가 없는 대화도 채택된다", () => {
    // A conversation saved before its first turn produced anything. It used to
    // be reachable only through `?? []`, and a missing chain is not an error.
    const adopted = adoptConversation(stored({ events: undefined, turns: undefined }));
    assert.deepEqual(adopted.recorded, []);
    assert.equal(adopted.turnOrdinal, 0);
  });
});
