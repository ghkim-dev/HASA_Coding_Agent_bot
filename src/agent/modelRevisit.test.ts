import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { modelNeedsRevisiting } from "./modelRevisit.ts";
import { modeCanWrite } from "./modes.ts";
import type { AgentMode } from "./types.ts";

/**
 * When a running session must go and choose its model again.
 *
 * The asymmetry is the whole of it, and getting it backwards costs nothing
 * visible: the session keeps running, the model answers, and the change the user
 * asked for is described rather than made. That is the failure `autoModel`
 * exists to prevent, and it is invisible from inside the conversation.
 *
 * Every mode pair is checked rather than the two that motivated the rule,
 * because the rule is about what a mode *can do* and there are four of them.
 */

const MODES: readonly AgentMode[] = ["code", "architect", "debug", "ask"];

const at = (input: {
  selected?: string | null;
  session?: string | null;
  from?: AgentMode | null;
  to: AgentMode;
}): boolean =>
  modelNeedsRevisiting({
    selectedModelId: input.selected ?? null,
    sessionChoice: input.session === undefined || input.session === null ? null : { modelId: input.session },
    modeAtSession: input.from ?? null,
    mode: input.to,
  });

describe("모델을 다시 고를 것인가", () => {
  test("세션이 없으면 언제나 고른다", () => {
    // Nothing to keep. Both halves are checked because either one being absent
    // means there is no session to speak of.
    assert.equal(at({ to: "code" }), true);
    assert.equal(at({ session: "m", to: "code" }), true, "a choice with no mode behind it");
    assert.equal(at({ from: "code", to: "code" }), true, "a mode with no choice behind it");
  });

  test("손으로 고른 모델은 다른 무엇보다 앞선다", () => {
    // If the user picked one and the session is not using it, it is the wrong
    // session whatever the modes are.
    assert.equal(at({ selected: "picked", session: "other", from: "code", to: "code" }), true);
    assert.equal(at({ selected: "picked", session: "picked", from: "code", to: "code" }), false);
    // Even with no session at all, the question is only whether it matches.
    assert.equal(at({ selected: "picked", to: "code" }), true);
  });

  test("모드가 그대로면 다시 고르지 않는다", () => {
    for (const mode of MODES) {
      assert.equal(at({ session: "m", from: mode, to: mode }), false, mode);
    }
  });

  test("쓰는 모드에서 읽는 모드로 가면 그대로 쓴다", () => {
    // A model chosen to write already satisfies a mode that only reads. Paying
    // for a new resolution here buys nothing.
    for (const from of MODES.filter((m) => modeCanWrite(m))) {
      for (const to of MODES.filter((m) => !modeCanWrite(m))) {
        assert.equal(at({ session: "m", from, to }), false, `${from} → ${to}`);
      }
    }
  });

  test("읽는 모드에서 쓰는 모드로 가면 다시 고른다", () => {
    // The direction that matters. A chat-only model accepts the request and
    // then describes the change instead of making it.
    for (const from of MODES.filter((m) => !modeCanWrite(m))) {
      for (const to of MODES.filter((m) => modeCanWrite(m))) {
        assert.equal(at({ session: "m", from, to }), true, `${from} → ${to}`);
      }
    }
  });

  test("같은 등급끼리 옮겨 다니면 그대로 쓴다", () => {
    // `code` → `debug` and `architect` → `ask`. The mode changed and what it may
    // do did not, so the model that was right is still right.
    for (const from of MODES) {
      for (const to of MODES) {
        if (from === to) continue;
        if (modeCanWrite(from) !== modeCanWrite(to)) continue;
        assert.equal(at({ session: "m", from, to }), false, `${from} → ${to}`);
      }
    }
  });

  test("네 모드가 두 등급으로 갈린다", () => {
    // The denominator of the two loops above. If every mode landed on the same
    // side, both would pass over an empty set and say nothing at all.
    const writes = MODES.filter((m) => modeCanWrite(m));
    const reads = MODES.filter((m) => !modeCanWrite(m));
    assert.ok(writes.length > 0 && reads.length > 0, `${writes.length} write, ${reads.length} read`);
  });
});
