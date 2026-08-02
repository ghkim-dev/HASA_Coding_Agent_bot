import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseInline, parseMarkdown, toPlainText, type Block } from "./markdown.ts";

/**
 * The failure this answers: the panel printed `**연산 기록 저장 기능 추가**`
 * with the asterisks showing, so the user read the markup instead of the
 * sentence.
 *
 * The rule these tests hold to is that no word may be lost. Formatting this
 * parser does not understand must survive as the literal text the model wrote.
 */

function paragraphs(blocks: Block[]): string[] {
  return blocks.filter((b) => b.kind === "paragraph").map((b) => toPlainText([b]));
}

describe("blocks", () => {
  test("prose is one paragraph per blank-line group", () => {
    const blocks = parseMarkdown("First line\nstill first.\n\nSecond.");
    assert.equal(blocks.length, 2);
    assert.deepEqual(paragraphs(blocks), ["First line\nstill first.", "Second."]);
  });

  test("the outline the user complained about parses into its parts", () => {
    const blocks = parseMarkdown(`1. **연산 기록 저장 기능 추가**:
   - \`history\` 리스트를 사용해 모든 연산 기록을 저장합니다.
   - \`=\` 버튼을 누를 때마다 기록합니다.

2. **임시 버퍼(\`tmp\`) 관리**:
   - 현재 연산 중인 값을 임시로 저장합니다.`);

    // One ordered list of two items, each carrying its own bullets — not five
    // siblings renumbered 1..5, which is what flattening showed the user.
    assert.equal(blocks.length, 1);
    const list = blocks[0];
    assert.equal(list?.kind, "list");
    if (list?.kind !== "list") return;
    assert.equal(list.ordered, true);
    assert.equal(list.items.length, 2);

    const [first, second] = list.items;
    const sub = first?.children[0];
    assert.equal(sub?.kind, "list");
    assert.equal(sub?.kind === "list" ? sub.ordered : true, false, "sub-items are bullets");
    assert.equal(sub?.kind === "list" ? sub.items.length : 0, 2);
    assert.equal(second?.children.length, 1);

    const text = toPlainText(blocks);
    assert.match(text, /연산 기록 저장 기능 추가/);
    assert.match(text, /임시로 저장합니다/);
    assert.doesNotMatch(text, /\*\*/, "no asterisks survive as text");
    assert.doesNotMatch(text, /`/, "no backticks survive as text");
  });

  test("a sub-list nests rather than joining its parent", () => {
    const blocks = parseMarkdown("- outer\n  - inner\n- outer2");
    const list = blocks[0];
    assert.equal(list?.kind === "list" ? list.items.length : 0, 2, "two outer items");
    const inner = list?.kind === "list" ? list.items[0]?.children[0] : undefined;
    assert.equal(inner?.kind, "list");
  });

  test("prose indented under an item belongs to the item", () => {
    const blocks = parseMarkdown("1. step\n\n   detail line\n\n2. next");
    const list = blocks[0];
    assert.equal(list?.kind === "list" ? list.items.length : 0, 2);
    assert.match(toPlainText(blocks), /detail line/);
  });

  test("headings keep their level", () => {
    const blocks = parseMarkdown("### 변경 내용\n본문");
    assert.deepEqual(blocks[0], { kind: "heading", level: 3, inlines: [{ kind: "text", text: "변경 내용" }] });
  });

  test("a hash without a space is not a heading", () => {
    // `#include` and `#!/usr/bin/env` are text, not headings.
    assert.equal(parseMarkdown("#include <stdio.h>")[0]?.kind, "paragraph");
  });

  test("ordered and unordered lists are distinguished", () => {
    const ul = parseMarkdown("- a\n- b")[0];
    const ol = parseMarkdown("1. a\n2. b")[0];
    assert.equal(ul?.kind === "list" && ul.ordered, false);
    assert.equal(ol?.kind === "list" && ol.ordered, true);
    assert.equal(ol?.kind === "list" ? ol.items.length : 0, 2);
  });

  test("a list ends where the prose resumes", () => {
    const blocks = parseMarkdown("- a\n- b\n\n이제 계산기는 연속 연산을 지원합니다.");
    assert.equal(blocks.length, 2);
    assert.equal(blocks[1]?.kind, "paragraph");
  });
});

describe("code blocks", () => {
  test("a fence is taken whole, and its language is kept", () => {
    const block = parseMarkdown("```python\ndef f():\n    return 1\n```")[0];
    assert.deepEqual(block, { kind: "code", language: "python", text: "def f():\n    return 1" });
  });

  test("a bullet inside code is code, not a list item", () => {
    // The whole reason fences are consumed before anything else.
    const blocks = parseMarkdown("```\n- not a list\n# not a heading\n```");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.kind, "code");
    assert.match(toPlainText(blocks), /- not a list/);
  });

  test("an unterminated fence still shows the code written so far", () => {
    // This is what a half-streamed block looks like.
    const blocks = parseMarkdown("```js\nconst a = 1;");
    assert.equal(blocks[0]?.kind, "code");
    assert.equal(blocks[0]?.kind === "code" ? blocks[0].text : "", "const a = 1;");
  });

  test("an empty fenced block does not vanish", () => {
    assert.equal(parseMarkdown("```\n```")[0]?.kind, "code");
  });
});

describe("inline", () => {
  test("bold, italic and code become spans", () => {
    assert.deepEqual(parseInline("a **b** c"), [
      { kind: "text", text: "a " },
      { kind: "strong", children: [{ kind: "text", text: "b" }] },
      { kind: "text", text: " c" },
    ]);
    assert.deepEqual(parseInline("`x`"), [{ kind: "code", text: "x" }]);
  });

  test("code inside bold is code, not backticks", () => {
    // `**임시 버퍼(`tmp`) 관리**` showed the backticks raw when emphasis held a
    // flat string. Emphasis recurses now.
    assert.deepEqual(parseInline("**버퍼(`tmp`) 관리**"), [
      {
        kind: "strong",
        children: [
          { kind: "text", text: "버퍼(" },
          { kind: "code", text: "tmp" },
          { kind: "text", text: ") 관리" },
        ],
      },
    ]);
  });

  test("asterisks inside a code span stay literal", () => {
    // Markup inside code is content: the user may be looking at a glob.
    assert.deepEqual(parseInline("`**/*.ts`"), [{ kind: "code", text: "**/*.ts" }]);
  });

  test("an identifier with underscores is not italicised", () => {
    // `snake_case_name` is the most common thing in this text.
    assert.deepEqual(parseInline("call snake_case_name here"), [
      { kind: "text", text: "call snake_case_name here" },
    ]);
  });

  test("a lone asterisk is text, not the start of emphasis", () => {
    assert.equal(toPlainText(parseMarkdown("2 * 3 = 6")), "2 * 3 = 6");
  });

  test("multiplication in prose survives", () => {
    assert.equal(toPlainText(parseMarkdown("a * b * c")), "a * b * c");
  });

  test("unbalanced emphasis keeps the characters the model wrote", () => {
    // Losing the word would be worse than showing the asterisks.
    assert.equal(toPlainText(parseMarkdown("**unclosed bold")), "**unclosed bold");
  });

  test("a double backtick span can contain a backtick", () => {
    assert.deepEqual(parseInline("``a ` b``"), [{ kind: "code", text: "a ` b" }]);
  });

  test("empty backticks are not a code span", () => {
    assert.equal(toPlainText(parseMarkdown("``")), "``");
  });
});

describe("nothing is lost", () => {
  const samples = [
    "plain sentence",
    "**bold** and *italic* and `code`",
    "1. one\n2. two",
    "- a\n- b",
    "### heading\n\ntext",
    "```py\nx = 1\n```",
    "混合 텍스트 with **강조**",
    "*",
    "**",
    "`",
    "- ",
    "#",
    "",
    "a\n\n\n\nb",
    "___",
    "text with _under_ score",
  ];

  /**
   * The sample with its markup removed — what must still be readable after a
   * round trip. Line-level markers go first, while the newlines that anchor
   * them are still there; whitespace goes last.
   *
   * A fence's language is deliberately excluded: `py` in ```` ```py ```` is
   * metadata the renderer keeps as an attribute, not words the user wrote.
   */
  function withoutMarkup(sample: string): string {
    return sample
      .replace(/^\s{0,3}(?:```|~~~)\s*\S*$/gm, "")
      .replace(/^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/gm, "")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/[*_`]/g, "")
      .replace(/\s+/g, "");
  }

  for (const sample of samples) {
    test(`every word survives: ${JSON.stringify(sample).slice(0, 40)}`, () => {
      const words = toPlainText(parseMarkdown(sample)).replace(/\s+/g, "");
      for (const char of new Set(withoutMarkup(sample))) {
        assert.ok(words.includes(char), `lost ${JSON.stringify(char)} from ${JSON.stringify(sample)}`);
      }
    });
  }

  test("parsing never throws, whatever arrives", () => {
    const nasty = ["```".repeat(50), "*".repeat(200), "#".repeat(10) + " h", " ", "1.".repeat(100)];
    for (const input of nasty) assert.doesNotThrow(() => parseMarkdown(input));
  });
});
