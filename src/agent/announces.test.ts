import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { announcesAction } from "./loop.ts";

/**
 * Telling a promise from a report.
 *
 * From a real transcript. Asked to run the code it had written, the agent
 * answered "이제 코드를 실행해보겠습니다" and stopped; the loop read that as the
 * answer and ended the turn. The user asked again, got the same sentence, asked
 * again, got it a third time — a conversation in which nothing ever ran.
 *
 * This is a heuristic and is allowed to be, because of what it costs when it is
 * wrong: one more model call, whose prompt says "if you were actually finished,
 * say so and stop". It decides nothing irreversible. What it must not do is fire
 * on ordinary finished answers, which is most of what is checked here.
 */

describe("a reply that promises work it has not done", () => {
  test("the sentence that started this", () => {
    assert.equal(announcesAction("이제 코드를 실행해보겠습니다."), true);
  });

  test("the other spellings of the same promise", () => {
    for (const text of [
      "다시 실행해보겠습니다.",
      "필요한 패키지를 설치하겠습니다.",
      "파일을 수정하겠습니다.",
      "이번에는 코드를 조금 수정하고, 실행해보겠습니다.",
      "먼저 관련 파일을 확인해 볼게요.",
      "I'll run the script now.",
      "Let me check the file first.",
      "I'm going to install the dependency.",
    ]) {
      assert.equal(announcesAction(text), true, text);
    }
  });
});

describe("a reply that reports work it did", () => {
  test("plain past tense does not fire", () => {
    for (const text of [
      "파일을 수정했습니다. 테스트도 통과했습니다.",
      "패키지를 설치했고 스크립트가 정상 동작합니다.",
      "I ran the tests and they passed.",
      "Installed the package; the import works now.",
    ]) {
      assert.equal(announcesAction(text), false, text);
    }
  });

  test("a promise that follows evidence of work is a report", () => {
    // "I installed it and will now run it" is a turn in progress, not a stall —
    // and it is what a narrating model says between two tool calls.
    assert.equal(announcesAction("패키지를 설치했고, 이제 실행하겠습니다."), false);
    assert.equal(announcesAction("I installed it, and I'll run it next."), false);
  });

  test("an answer to a question is not a promise", () => {
    for (const text of [
      "이 파일은 사용자 인증을 담당합니다.",
      "원인은 캐시가 무효화되지 않은 것이었습니다.",
      "The function returns null when the list is empty.",
      "실행하면 됩니다.",
      "이 명령을 실행하시면 결과가 나옵니다.",
    ]) {
      assert.equal(announcesAction(text), false, text);
    }
  });

  test("only the tail is read, so a narrated turn that concludes is finished", () => {
    // A model that says what it is about to do, does it, and then concludes must
    // not be nudged on the strength of its own opening line.
    const narrated =
      "먼저 파일을 읽어보겠습니다.\n" +
      "읽어보니 import가 빠져 있었습니다.\n" +
      "수정했고 테스트를 실행했습니다. 모두 통과합니다.";
    assert.equal(announcesAction(narrated), false);
  });

  test("empty and whitespace are not promises", () => {
    for (const text of ["", "   ", "\n\n"]) assert.equal(announcesAction(text), false, JSON.stringify(text));
  });

  test("a refusal is not a promise", () => {
    // The turn the user should see rather than a nudge: it says what is wrong.
    assert.equal(announcesAction("python이 설치되어 있지 않아 실행할 수 없습니다."), false);
  });
});
