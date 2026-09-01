import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { MEDIA_CONVERSATIONS } from "./mediaConversations.ts";
import { ENGLISH_MEDIA_CONVERSATIONS } from "./mediaConversationsEnglish.ts";
import { previewDesign, type PreviewResult } from "./preview.ts";
import { prohibitionsIn } from "../agent/statedProhibitions.ts";

/**
 * What is still standing when the conversation stops.
 *
 * The single-sentence corpus next door measures reading. This measures holding,
 * which is a different thing and fails differently: every turn can be read
 * perfectly while a requirement quietly falls out between two of them, and
 * nothing in the panel says so — the turn that dropped it looks fine, and the
 * requirement is simply not there any more.
 *
 * Scored per conversation rather than per turn, because that is the claim: after
 * the last thing the user said, this is what the runtime believes it owes them.
 */

/**
 * Both languages, scored by the same rules.
 *
 * Kept in one list rather than two suites because the claim is about the
 * runtime and not about Korean: a conversation that holds together in one
 * language and falls apart in the other is a defect, and separating them is
 * how that stops being visible.
 */
const ALL = [...MEDIA_CONVERSATIONS, ...ENGLISH_MEDIA_CONVERSATIONS];

const previews = new Map<string, PreviewResult>();

before(async () => {
  for (const conversation of ALL) {
    previews.set(conversation.id, await previewDesign({ turns: [...conversation.turns] }));
  }
});

/** The user's own requirements that survived, in the words the panel shows. */
function live(id: string): string[] {
  const preview = previews.get(id);
  assert.ok(preview !== undefined, `${id}: no preview`);
  return preview.requirements
    .filter((spec) => spec.status !== "system_added" && spec.supersededBy === undefined)
    .map((spec) => spec.text);
}

describe("여러 턴에 걸친 미디어 프로젝트 요청", () => {
  test("말뭉치 자체", () => {
    assert.equal(ALL.length, 13);
    for (const conversation of ALL) {
      assert.ok(conversation.turns.length >= 2, `${conversation.id}: 한 턴짜리입니다`);
      assert.ok(conversation.standing.length > 0, `${conversation.id}: 정답이 비어 있습니다`);
      assert.ok(conversation.why.length > 20, `${conversation.id}: 이유가 없습니다`);
    }
  });

  test("마지막 턴에 살아 있어야 할 것이 모두 살아 있다", () => {
    const missing: string[] = [];
    for (const conversation of ALL) {
      const held = live(conversation.id);
      for (const text of conversation.standing) {
        if (!held.includes(text)) missing.push(`${conversation.id}: "${text}" (남은 것: ${held.join(" / ")})`);
      }
    }
    assert.deepEqual(missing, []);
  });

  test("살아 있으면 안 되는 것은 남아 있지 않다", () => {
    // The complete answer, checked from the other side. A conversation that
    // accumulates requirements correctly and also keeps one the user withdrew
    // has not understood the correction — it has understood the addition twice.
    const extra: string[] = [];
    for (const conversation of ALL) {
      const held = live(conversation.id);
      const allowed = new Set(conversation.standing);
      for (const text of held) {
        if (!allowed.has(text)) extra.push(`${conversation.id}: "${text}"`);
      }
      for (const text of conversation.superseded ?? []) {
        if (held.includes(text)) extra.push(`${conversation.id}: 정정됐어야 할 "${text}"`);
      }
    }
    assert.deepEqual(extra, []);
  });

  test("대화 도중에 나온 금지를 런타임이 들고 있다", () => {
    // Read from the user's own text rather than from the design, because that is
    // the module the tool gate asks. A prohibition the design records but
    // `statedProhibitions` cannot see is a refusal that will not happen.
    for (const conversation of ALL) {
      const wanted = conversation.prohibitions ?? [];
      if (wanted.length === 0) continue;
      const seen = new Set<string>();
      for (const turn of conversation.turns) {
        for (const klass of prohibitionsIn(turn)) seen.add(`no_${klass}`);
      }
      for (const kind of wanted) {
        assert.ok(seen.has(kind), `${conversation.id}: ${kind} 를 읽지 못했습니다 (${[...seen].join(",")})`);
      }
    }
  });
});
