import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { stripToolMarkup } from "./hasaModel.ts";

/**
 * Markup the gateway left behind.
 *
 * On the native path the parser is supposed to lift `tool_calls` out and hand
 * back clean prose. This deployment leaves the opening token, so a finished
 * answer ends with a bare `<tool_call>` — which is exactly what a user reported
 * seeing in the panel, and which had been chased in the text protocol, where it
 * never was. Reproduced end to end against `qwen3-coder` on 2026-08-04:
 *
 *   "…정상적으로 작동하는 것으로 보입니다.\n<tool_call>"
 */
describe("stripping tool markup from an answer", () => {
  test("the trailing token that was actually observed", () => {
    assert.equal(
      stripToolMarkup("파일은 성공적으로 실행되었습니다.\n<tool_call>"),
      "파일은 성공적으로 실행되었습니다.",
    );
  });

  test("a closing token on its own", () => {
    assert.equal(stripToolMarkup("done\n</tool_call>"), "done");
  });

  test("a whole block the parser should have consumed", () => {
    assert.equal(
      stripToolMarkup('before<tool_call>{"name":"run_command"}</tool_call>after'),
      "beforeafter",
    );
  });

  test("the pipe-delimited spellings other builds emit", () => {
    assert.equal(stripToolMarkup("answer <|tool_calls|>"), "answer");
    assert.equal(stripToolMarkup("answer <function_call>"), "answer");
  });

  test("ordinary prose is untouched, including prose about tools", () => {
    // The removal is of markup, not of the subject. A model explaining tool
    // calling should keep its sentence.
    for (const text of [
      "이 함수는 tool_call 이라는 이름을 씁니다.",
      "The tool call protocol is described in the docs.",
      "Use <div> and </div> in the template.",
    ]) {
      assert.equal(stripToolMarkup(text), text, text);
    }
  });

  test("an answer that is only markup becomes empty, not whitespace", () => {
    // The loop treats an empty completion differently from a blank one, and a
    // reply consisting of a stray token has said nothing.
    assert.equal(stripToolMarkup("<tool_call>"), "");
    assert.equal(stripToolMarkup("  <tool_call>\n  "), "");
  });

  test("real content survives whatever surrounds it", () => {
    assert.equal(stripToolMarkup("<tool_call>\n실행했습니다.\n"), "실행했습니다.");
  });
});
