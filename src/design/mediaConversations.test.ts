import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { MEDIA_CONVERSATIONS, type MediaConversation } from "./mediaConversations.ts";
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
 *
 * ## 집계와 사례를 함께 둔다
 *
 * 축마다 집계 하나와 대화별 테스트가 나란히 선다. 집계는 말뭉치가 사례를 잃으면
 * 실패하라고 남아 있고, 대화별 테스트는 실패가 "배열이 다르다" 가 아니라
 * "이 대화의 이 축이 이렇게 틀렸다" 를 말하게 하려고 있다. 둘은 같은 미리 계산된
 * 결과를 읽으므로, 사례를 쪼갠 값은 대화 하나를 다시 돌리는 비용이 아니다.
 *
 * 그래서 집계가 지키는 것은 개수다. 사례별 테스트가 이미 문장 단위로 같은 주장을 하고
 * 있다면 집계는 그것을 한 번 더 하지 않고, 사례별 테스트가 스스로 할 수 없는 일 —
 * 사례나 필드가 통째로 사라져서 그것을 검사하던 테스트도 함께 사라지는 것 — 만 막는다.
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

/**
 * 말뭉치를 만들다 터진 것. 훅이 던지는 대신 여기 담아 두고, 첫 테스트가 이름을 붙여
 * 실패시킨다.
 *
 * `before()` 가 throw 하면 `node --test` 는 그 아래 테스트를 실행하지 않고
 * **cancelled** 로 처리하는데, 요약줄은 그것을 `fail 0` 으로 찍는다. 훅 하나가 터지면
 * 이 파일의 테스트가 통째로 실행되지 않는데도 요약은 초록으로 보인다는 뜻이고, 그때
 * 요약줄의 `fail 0` 은 거짓말이다. 위에서 사례별로 갈라 놓은 입도가 전부 이 훅 하나에
 * 매달려 있으므로, 훅은 던지지 않고 기록만 한다.
 *
 * 그 대가로 미리보기를 읽는 사례별 테스트들은 빈 맵을 읽고 `live()` 안에서 각자 자기
 * 대화 이름으로 실패한다. 취소되어 조용히 사라지는 것보다 이름을 가진 실패 N개가
 * 낫다 — 취소 0, 실패 N.
 */
let buildError: Error | null = null;

before(async () => {
  try {
    for (const conversation of ALL) {
      previews.set(conversation.id, await previewDesign({ turns: [...conversation.turns] }));
    }
  } catch (err) {
    buildError = err as Error;
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

/**
 * 정정으로 물러난 요구사항 — 목록에 남아 있고, 무엇이 물렸는지 표시가 붙은 것.
 *
 * `live` 의 여집합이 아니다. 요구사항이 마지막 턴에 서 있지 않은 이유는 둘이고,
 * 그 둘은 완전히 다른 일이다: 정정이 그것을 물렸거나, 애초에 읽히지 않았거나.
 * 정정 축이 `!held.includes(text)` 만 보던 동안 이 둘은 구별되지 않았고, 그래서
 * 런타임이 그 요구사항을 처음부터 만들지 않게 만들어도 스위트는 완전히 초록이었다
 * — 이 파일 머리가 말하는 실패 모드("a requirement quietly falls out between two
 * of them")가 바로 그것인데 정정 축이 그것을 볼 수 없었다.
 *
 * `supersededBy` 가 붙어 있다는 것은 설계가 "이것은 있었고, 이 턴이 물렸다" 고
 * 말한다는 뜻이다. 그 말이 없으면 물러난 것이 아니라 없었던 것이다.
 */
function retiredIn(id: string): string[] {
  const preview = previews.get(id);
  assert.ok(preview !== undefined, `${id}: no preview`);
  return preview.requirements
    .filter((spec) => spec.status !== "system_added" && spec.supersededBy !== undefined)
    .map((spec) => spec.text);
}

/** 정답에 있는데 마지막 턴에 남아 있지 않은 것. */
function missingIn(conversation: MediaConversation): string[] {
  const held = live(conversation.id);
  return conversation.standing.filter((text) => !held.includes(text));
}

/** 남아 있는데 정답에 없는 것. */
function extraIn(conversation: MediaConversation): string[] {
  const held = live(conversation.id);
  const allowed = new Set(conversation.standing);
  return held.filter((text) => !allowed.has(text));
}

/** 사용자가 쓴 문장에서 `statedProhibitions` 가 실제로 읽어낸 금지. */
function prohibitionsRead(conversation: MediaConversation): Set<string> {
  const seen = new Set<string>();
  for (const turn of conversation.turns) {
    for (const klass of prohibitionsIn(turn)) seen.add(`no_${klass}`);
  }
  return seen;
}

/**
 * 마지막 턴에 설계가 들고 있는 금지.
 *
 * 위엣것과 다른 질문이다. `prohibitionsRead` 는 턴을 하나씩 다시 읽으므로 순서도
 * 누적도 보지 않고, 설계가 그 금지를 잊어버려도 통과한다 — 실제로 확인했다:
 * 미리보기에서 금지 요구사항을 걸러내 설계가 금지를 완전히 잊게 만들어도 그 축은
 * 전부 초록이었다.
 *
 * 둘 다 필요하고 둘은 서로를 대신하지 못한다. 도구 게이트가 묻는 것은
 * `statedProhibitions` 이므로 그것이 읽지 못하는 금지는 일어나지 않을 거절이고,
 * 사람이 보는 것은 설계의 요구사항 목록이므로 거기서 빠진 금지는 보이지 않는
 * 약속이다.
 */
function prohibitionsHeld(id: string): Set<string> {
  const preview = previews.get(id);
  assert.ok(preview !== undefined, `${id}: no preview`);
  const seen = new Set<string>();
  for (const spec of preview.requirements) {
    if (spec.polarity !== "forbidden" || spec.derivedBy !== "runtime_prohibition") continue;
    if (spec.supersededBy !== undefined) continue;
    // `t1-forbid-execute` 처럼 턴 접두사 뒤에 부류가 붙는다. 그 부류가 금지의
    // 종류이고, 말뭉치는 `no_execute` 형태로 적는다.
    const klass = spec.id.split("-forbid-")[1];
    if (klass !== undefined) seen.add(`no_${klass}`);
  }
  return seen;
}

describe("여러 턴에 걸친 미디어 프로젝트 요청", () => {
  test("말뭉치가 만들어졌다", () => {
    assert.equal(buildError, null, `말뭉치를 만들지 못했습니다: ${buildError?.stack}`);
    assert.ok(ALL.length > 0, "대화가 하나도 없습니다");
    assert.equal(previews.size, ALL.length, `미리보기 ${previews.size}개 / 대화 ${ALL.length}개`);
  });

  describe("말뭉치의 형태", () => {
    /**
     * 개수만 못 박는다. 이 자리에 있던 루프 본문은 아래 `사례 형태` 테스트와 글자까지
     * 같았고, 같은 주장을 두 번 하는 대신 어느 대화인지 이름이 붙는 쪽에 맡긴다.
     * 여기 남은 것은 사례별 테스트가 스스로 할 수 없는 일 — 사례가 말뭉치에서 빠지면
     * 그 사례의 테스트도 같이 빠져서 아무도 실패하지 않는 것 — 을 막는 핀이다.
     */
    test("말뭉치의 사례 수와 이름", () => {
      assert.equal(ALL.length, 13);
      // 개수만 못 박으면 삭제는 잡히고 **치환**은 잡히지 않는다. 정교화 축을
      // 재는 사례 하나를 턴이 중복된 자리채움으로 통째로 바꿔치기해도 13은
      // 13이고 테스트 총수도 그대로라, 검사 하나가 소리 없이 사라진다.
      // 이름을 고정하면 그 자리가 비는 순간 이름으로 실패한다.
      assert.deepEqual(ALL.map((conversation) => conversation.id).sort(), [
        "emc-accumulate",
        "emc-correction",
        "emc-genuine-new-task",
        "emc-prohibition-midway",
        "emc-refine",
        "mc-accumulate",
        "mc-correction",
        "mc-correction-bare-ani",
        "mc-correction-not-that",
        "mc-genuine-new-task",
        "mc-preserve-while-adding",
        "mc-prohibition-midway",
        "mc-refine-target",
      ]);
    });

    /**
     * 필드가 사라지는 것을 잡는 핀.
     *
     * `superseded` 를 사례에서 통째로 지우면 그 사례의 `물러났어야 할 …` 테스트는
     * 아예 생성되지 않고, 집계 쪽 루프도 `?? []` 로 조용히 넘어간다. 검사만 사라지고
     * 스위트는 초록으로 남는다는 뜻이므로, 필드를 가진 사례 수와 문장 수를 함께
     * 고정한다 — 사례가 필드를 잃으면 앞엣것이, 여러 문장 중 하나만 빠지면 뒤엣것이
     * 실패한다.
     */
    test("정정을 가진 사례 수", () => {
      const ids = ALL.filter((conversation) => (conversation.superseded ?? []).length > 0).map(
        (conversation) => conversation.id,
      );
      assert.equal(ids.length, 4, `정정을 가진 사례: ${ids.join(", ")}`);
      assert.equal(ALL.flatMap((conversation) => conversation.superseded ?? []).length, 4);
    });

    /**
     * 같은 이유로 `prohibitions`. 집계 쪽은 비어 있으면 `continue` 로 넘어가므로,
     * 필드를 지운 사례는 금지 축에서 검사를 통째로 잃고도 초록으로 남는다.
     */
    test("금지를 가진 사례 수", () => {
      const ids = ALL.filter((conversation) => (conversation.prohibitions ?? []).length > 0).map(
        (conversation) => conversation.id,
      );
      assert.equal(ids.length, 3, `금지를 가진 사례: ${ids.join(", ")}`);
      assert.equal(ALL.flatMap((conversation) => conversation.prohibitions ?? []).length, 3);
    });

    for (const conversation of ALL) {
      test(`${conversation.id} · 사례 형태`, () => {
        assert.ok(conversation.turns.length >= 2, `${conversation.id}: 한 턴짜리입니다`);
        assert.ok(conversation.standing.length > 0, `${conversation.id}: 정답이 비어 있습니다`);
        assert.ok(conversation.why.length > 20, `${conversation.id}: 이유가 없습니다`);
      });
    }
  });

  describe("마지막 턴에 살아 있어야 할 것", () => {
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

    for (const conversation of ALL) {
      test(`${conversation.id} · 남아 있어야 할 것`, () => {
        const missing = missingIn(conversation);
        assert.ok(
          missing.length === 0,
          `${conversation.id}: "${missing.join('", "')}" 이(가) 빠졌습니다 (남은 것: ${live(conversation.id).join(" / ")})`,
        );
      });
    }
  });

  /**
   * The complete answer, checked from the other side. A conversation that
   * accumulates requirements correctly and also keeps one the user withdrew
   * has not understood the correction — it has understood the addition twice.
   *
   * 두 축으로 나뉜다. `남으면 안 되는 것` 은 정답 밖의 요구사항이 붙어 있는지를,
   * `물러났어야 할 것` 은 정정이 지목한 그 문장이 실제로 물러났는지를 본다.
   * 뒤엣것이 앞엣것의 부분집합이기는 하지만, 어느 쪽으로 틀렸는지를 이름이
   * 말해주지 않으면 정정 실패와 과잉 축적이 같은 실패로 보인다.
   */
  describe("살아 있으면 안 되는 것", () => {
    test("살아 있으면 안 되는 것은 남아 있지 않다", () => {
      const extra: string[] = [];
      for (const conversation of ALL) {
        const held = live(conversation.id);
        const allowed = new Set(conversation.standing);
        for (const text of held) {
          if (!allowed.has(text)) extra.push(`${conversation.id}: "${text}"`);
        }
        const retired = retiredIn(conversation.id);
        for (const text of conversation.superseded ?? []) {
          if (held.includes(text)) extra.push(`${conversation.id}: 정정됐어야 할 "${text}"`);
          // 그리고 물러난 자리에 실제로 있어야 한다. 이 줄이 없으면 런타임이
          // 그 요구사항을 아예 만들지 않아도 위의 검사가 무조건 참이 된다.
          if (!retired.includes(text)) {
            extra.push(`${conversation.id}: "${text}" 이(가) 물러난 것이 아니라 읽히지 않았습니다`);
          }
        }
      }
      assert.deepEqual(extra, []);
    });

    for (const conversation of ALL) {
      test(`${conversation.id} · 남으면 안 되는 것`, () => {
        const extra = extraIn(conversation);
        assert.ok(
          extra.length === 0,
          `${conversation.id}: 정답에 없는 "${extra.join('", "')}" 이(가) 남아 있습니다`,
        );
      });
    }

    for (const conversation of ALL) {
      for (const text of conversation.superseded ?? []) {
        test(`${conversation.id} · 물러났어야 할 "${text}"`, () => {
          const held = live(conversation.id);
          const retired = retiredIn(conversation.id);
          // 두 방향을 함께 본다 — 서 있으면 안 되고, 물러난 자리에는 있어야
          // 한다. 앞엣것만 보면 "정정이 물렸다" 와 "애초에 읽히지 않았다" 가
          // 같은 초록이 된다. 이 파일이 재려는 것은 앞쪽이다.
          assert.ok(
            !held.includes(text),
            `${conversation.id}: 정정됐어야 할 "${text}" 이(가) 아직 서 있습니다 (남은 것: ${held.join(" / ")})`,
          );
          assert.ok(
            retired.includes(text),
            `${conversation.id}: "${text}" 이(가) 물러난 목록에 없습니다 — 정정이 물린 것이 아니라 ` +
              `런타임이 그 요구사항을 만들지 않았습니다 (물러난 것: ${retired.join(" / ") || "없음"})`,
          );
        });
      }
    }
  });

  /**
   * Read from the user's own text rather than from the design, because that is
   * the module the tool gate asks. A prohibition the design records but
   * `statedProhibitions` cannot see is a refusal that will not happen.
   */
  describe("대화 도중에 나온 금지", () => {
    test("대화 도중에 나온 금지를 도구 게이트가 읽어낸다", () => {
      for (const conversation of ALL) {
        const wanted = conversation.prohibitions ?? [];
        if (wanted.length === 0) continue;
        const seen = prohibitionsRead(conversation);
        for (const kind of wanted) {
          assert.ok(seen.has(kind), `${conversation.id}: ${kind} 를 읽지 못했습니다 (${[...seen].join(",")})`);
        }
      }
    });

    for (const conversation of ALL) {
      for (const kind of conversation.prohibitions ?? []) {
        test(`${conversation.id} · 금지 ${kind} · 도구 게이트가 읽는다`, () => {
          const seen = prohibitionsRead(conversation);
          assert.ok(seen.has(kind), `${conversation.id}: ${kind} 를 읽지 못했습니다 (${[...seen].join(",")})`);
        });
      }
    }

    /**
     * 그리고 설계도 마지막 턴에 그것을 들고 있어야 한다.
     *
     * 위 축은 턴을 다시 읽으므로 설계가 금지를 잊어도 통과한다. 사람이 보는 것은
     * 설계의 요구사항 목록이고, 거기서 빠진 금지는 보이지 않는 약속이다 — 그래서
     * 같은 사례를 두 방향에서 묻는다.
     */
    test("대화 도중에 나온 금지를 설계가 마지막 턴까지 들고 있다", () => {
      const lost: string[] = [];
      for (const conversation of ALL) {
        const held = prohibitionsHeld(conversation.id);
        for (const kind of conversation.prohibitions ?? []) {
          if (!held.has(kind)) lost.push(`${conversation.id}: ${kind}`);
        }
      }
      assert.deepEqual(lost, []);
    });

    for (const conversation of ALL) {
      for (const kind of conversation.prohibitions ?? []) {
        test(`${conversation.id} · 금지 ${kind} · 설계가 들고 있다`, () => {
          const held = prohibitionsHeld(conversation.id);
          assert.ok(
            held.has(kind),
            `${conversation.id}: 설계가 ${kind} 를 들고 있지 않습니다 (${[...held].join(",") || "없음"})`,
          );
        });
      }
    }
  });
});
