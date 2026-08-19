import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AgentTool } from "./types.ts";
import { parseToolCall, renderToolCall, renderToolInstructions } from "./textTools.ts";

/**
 * Tool calling for a gateway that will not allow it.
 *
 * The failure this exists for is real and measured: `qwen2.5-coder-32b` is the
 * best coding model on this key and its deployment rejects every `tool_choice`
 * because vLLM was started without `--tool-call-parser`.
 *
 * The cases that matter are all about *values*. A tool argument here is usually
 * source code, so the parser has to survive code containing angle brackets, the
 * parser's own tags, blank lines and leading indentation. Getting any of those
 * wrong produces a patch that applies and is wrong, which is worse than one
 * that fails.
 */

const tools: AgentTool[] = [
  {
    name: "read_file",
    risk: "read",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path." },
        startLine: { type: "number", description: "First line." },
      },
      required: ["path"],
    },
    summarize: () => "읽기",
    execute: async () => ({ ok: true, content: "" }),
  },
  {
    name: "apply_patch",
    risk: "write",
    description: "Replace a block of text.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path." },
        find: { type: "string", description: "Exact text." },
        replace: { type: "string", description: "Replacement." },
      },
      required: ["path", "find", "replace"],
    },
    summarize: () => "수정",
    execute: async () => ({ ok: true, content: "" }),
  },
  {
    name: "list_files",
    risk: "read",
    description: "List files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory." },
        recursive: { type: "boolean", description: "Descend." },
      },
      required: ["path"],
    },
    summarize: () => "목록",
    execute: async () => ({ ok: true, content: "" }),
  },
];

describe("the instructions", () => {
  test("name every tool and every parameter", () => {
    const text = renderToolInstructions(tools);
    for (const tool of tools) {
      assert.match(text, new RegExp(`## ${tool.name}\\b`), tool.name);
      for (const param of Object.keys((tool.parameters as { properties: object }).properties)) {
        assert.match(text, new RegExp(`- ${param}\\b`), `${tool.name}.${param}`);
      }
    }
  });

  test("only the example is tag-shaped, so the skeleton cannot be copied", () => {
    // This replaced an assertion that every parameter appeared as `<name>`. That
    // rendering made the reference section the nearest tag-shaped text in the
    // prompt, and a model copies the nearest pattern: `qwen3-coder` answered
    // with the empty skeleton — a perfectly formed call carrying nothing, which
    // parsed and then had to be refused.
    const text = renderToolInstructions(tools);
    const reference = text.slice(text.indexOf("# Tools"));
    assert.doesNotMatch(reference, /<[a-z_]+>/i, "the reference section must contain no tags to copy");
    assert.match(text, /<read_file>/, "the example still shows the shape");
  });

  test("the example carries real values, not an ellipsis", () => {
    // A model that copies the example copies whatever is inside the tags.
    const text = renderToolInstructions(tools);
    assert.doesNotMatch(text, /<path>…<\/path>/);
    assert.match(text, /<path>[^<…]+<\/path>/);
  });

  test("say that values are literal, because that is the whole reason for XML", () => {
    const text = renderToolInstructions(tools);
    assert.match(text, /no escaping|literally/i);
    assert.match(text, /one tool call per message/i);
  });

  test("the example uses a real tool rather than a placeholder", () => {
    const text = renderToolInstructions(tools);
    assert.match(text, /<read_file>\n<path>src\/main\.py<\/path>\n<\/read_file>/);
  });

  test("no tools means no instructions at all", () => {
    assert.equal(renderToolInstructions([]), "");
  });
});

describe("reading a call", () => {
  test("a plain call", () => {
    const { call, text } = parseToolCall("<read_file>\n<path>src/a.ts</path>\n</read_file>", tools);
    assert.equal(call?.name, "read_file");
    assert.deepEqual(call?.arguments, { path: "src/a.ts" });
    assert.equal(text, "", "the markup is not shown to the user");
  });

  test("prose around the call is kept and the markup is removed", () => {
    const { call, text } = parseToolCall(
      "먼저 파일을 읽겠습니다.\n\n<read_file>\n<path>src/a.ts</path>\n</read_file>\n\n확인 후 수정합니다.",
      tools,
    );
    assert.equal(call?.name, "read_file");
    assert.match(text, /먼저 파일을 읽겠습니다/);
    assert.match(text, /확인 후 수정합니다/);
    assert.doesNotMatch(text, /<read_file>/);
  });

  test("no call is an answer", () => {
    const { call, problem, text } = parseToolCall("The bug is in src/auth.ts, line 41.", tools);
    assert.equal(call, null);
    assert.equal(problem, null);
    assert.equal(text, "The bug is in src/auth.ts, line 41.");
  });

  test("the first call wins when a tool name also appears in prose", () => {
    const { call } = parseToolCall(
      "<read_file>\n<path>a.ts</path>\n</read_file>\nthen I will use apply_patch",
      tools,
    );
    assert.equal(call?.name, "read_file");
  });

  test("an id is always produced", () => {
    const a = parseToolCall("<read_file>\n<path>a</path>\n</read_file>", tools);
    const b = parseToolCall("<read_file>\n<path>b</path>\n</read_file>", tools);
    assert.ok((a.call?.id.length ?? 0) > 0);
    assert.notEqual(a.call?.id, b.call?.id, "two calls must not share an id");
  });
});

describe("values that are code", () => {
  test("indentation survives, because a patch that loses it does not compile", () => {
    const { call } = parseToolCall(
      "<apply_patch>\n<path>a.ts</path>\n<find>\n  const x = 1;\n</find>\n<replace>\n  const x = 2;\n</replace>\n</apply_patch>",
      tools,
    );
    assert.equal((call?.arguments as { find: string }).find, "  const x = 1;");
    assert.equal((call?.arguments as { replace: string }).replace, "  const x = 2;");
  });

  test("exactly one newline is trimmed at each end, not all whitespace", () => {
    const { call } = parseToolCall(
      "<apply_patch>\n<path>a</path>\n<find>\n\nleading blank line kept\n\n</find>\n<replace>\nx\n</replace>\n</apply_patch>",
      tools,
    );
    assert.equal((call?.arguments as { find: string }).find, "\nleading blank line kept\n");
  });

  test("code containing angle brackets is carried verbatim", () => {
    const code = "const a: Array<Map<string, number>> = [];\nif (a < b && c > d) return;";
    const { call } = parseToolCall(
      `<apply_patch>\n<path>a.ts</path>\n<find>\nold\n</find>\n<replace>\n${code}\n</replace>\n</apply_patch>`,
      tools,
    );
    assert.equal((call?.arguments as { replace: string }).replace, code);
  });

  test("code containing JSX survives", () => {
    const jsx = '<div className="x">\n  <Button onClick={() => go()} />\n</div>';
    const { call } = parseToolCall(
      `<apply_patch>\n<path>a.tsx</path>\n<find>\nold\n</find>\n<replace>\n${jsx}\n</replace>\n</apply_patch>`,
      tools,
    );
    assert.equal((call?.arguments as { replace: string }).replace, jsx);
  });

  test("a value containing the closing tag is still bracketed by the outermost pair", () => {
    // A patch that edits this parser would contain `</replace>` in its own text.
    const code = "const marker = '</replace>';";
    const { call } = parseToolCall(
      `<apply_patch>\n<path>a.ts</path>\n<find>\nold\n</find>\n<replace>\n${code}\n</replace>\n</apply_patch>`,
      tools,
    );
    assert.equal((call?.arguments as { replace: string }).replace, code);
  });

  test("quotes and backslashes need no escaping — the reason this is not JSON", () => {
    const code = 'const re = /\\d+/g;\nconst s = "he said \\"hi\\"";';
    const { call } = parseToolCall(
      `<apply_patch>\n<path>a.ts</path>\n<find>\nx\n</find>\n<replace>\n${code}\n</replace>\n</apply_patch>`,
      tools,
    );
    assert.equal((call?.arguments as { replace: string }).replace, code);
  });

  test("a single-line value on the same line as its tags works", () => {
    const { call } = parseToolCall("<read_file>\n<path>src/a.ts</path>\n</read_file>", tools);
    assert.equal((call?.arguments as { path: string }).path, "src/a.ts");
  });

  test("markdown fences around the call are ignored", () => {
    const { call } = parseToolCall(
      "```xml\n<read_file>\n<path>a.ts</path>\n</read_file>\n```",
      tools,
    );
    assert.equal(call?.name, "read_file");
  });
});

describe("types", () => {
  test("a number parameter arrives as a number", () => {
    const { call } = parseToolCall(
      "<read_file>\n<path>a.ts</path>\n<startLine>12</startLine>\n</read_file>",
      tools,
    );
    assert.equal((call?.arguments as { startLine: number }).startLine, 12);
  });

  test("an unparseable number is omitted so the tool's own default applies", () => {
    const { call } = parseToolCall(
      "<read_file>\n<path>a.ts</path>\n<startLine>somewhere</startLine>\n</read_file>",
      tools,
    );
    assert.ok(!("startLine" in (call?.arguments as object)));
  });

  test("booleans accept what models actually write", () => {
    for (const [written, expected] of [["true", true], ["yes", true], ["1", true], ["false", false], ["no", false]] as const) {
      const { call } = parseToolCall(
        `<list_files>\n<path>.</path>\n<recursive>${written}</recursive>\n</list_files>`,
        tools,
      );
      assert.equal((call?.arguments as { recursive: boolean }).recursive, expected, written);
    }
  });

  test("an optional parameter that is absent is simply absent", () => {
    const { call } = parseToolCall("<read_file>\n<path>a.ts</path>\n</read_file>", tools);
    assert.deepEqual(call?.arguments, { path: "a.ts" });
  });
});

describe("calls that cannot be used", () => {
  test("a missing required parameter is reported, not guessed at", () => {
    const { call, problem } = parseToolCall("<read_file>\n</read_file>", tools);
    assert.equal(call, null);
    assert.match(String(problem), /read_file needs <path>/);
  });

  test("several missing parameters are all named", () => {
    const { problem } = parseToolCall("<apply_patch>\n<path>a.ts</path>\n</apply_patch>", tools);
    assert.match(String(problem), /<find>/);
    assert.match(String(problem), /<replace>/);
  });

  test("an invented tool is corrected, with the real ones listed", () => {
    const { call, problem } = parseToolCall(
      "<delete_everything>\n<path>/</path>\n</delete_everything>",
      tools,
    );
    assert.equal(call, null);
    assert.match(String(problem), /"delete_everything" is not a tool/);
    assert.match(String(problem), /read_file/);
  });

  test("prose about HTML is not mistaken for a failed tool call", () => {
    // Otherwise every explanation of some markup puts a correction in front of
    // the model.
    for (const text of [
      "Wrap it in a <div>content</div> element.",
      "The type is <string> in that position.",
      "Use <b>bold</b> here.",
    ]) {
      const { call, problem } = parseToolCall(text, tools);
      assert.equal(call, null, text);
      assert.equal(problem, null, text);
    }
  });

  test("an unclosed call is not half-applied", () => {
    const { call } = parseToolCall("<read_file>\n<path>a.ts</path>", tools);
    assert.equal(call, null);
  });

  test("an unclosed call is reported rather than passed off as an answer", () => {
    // This replaced "an unfinished thought is not an error". It is one: a reply
    // cut off at the output limit leaves a call that never ran, and saying
    // nothing meant the model saw no result, concluded it was incapable, and
    // told the user so — for several turns — while the raw markup sat in the
    // transcript. Reported from a running session.
    const { call, text, problem } = parseToolCall("Reading it now.\n<read_file>\n<path>a.ts</path>", tools);
    assert.equal(call, null);
    assert.match(String(problem), /read_file was opened but never closed/);
    assert.match(String(problem), /output limit/);
    assert.equal(text, "Reading it now.", "the markup is not shown to the user");
  });

  test("an unclosed tag that is not a tool is named, not leaked", () => {
    // `<tool_call>` is the format the Qwen family was trained on. Truncated, it
    // matched nothing and was printed to the user verbatim — the reported bug.
    const { call, text, problem } = parseToolCall("\n<tool_call>", tools);
    assert.equal(call, null);
    assert.match(String(problem), /"tool_call" is not a tool/);
    assert.match(String(problem), /read_file/, "the real tools are listed so it can switch");
    assert.equal(text, "");
  });

  test("a tool named in prose is still just prose", () => {
    // The rule is "begins a line", because that is where the format puts a call.
    // Without it every sentence mentioning a tool draws a correction.
    for (const text of [
      "I will use the <read_file> tool next.",
      "Call <apply_patch> when you know the path.",
    ]) {
      const { call, problem } = parseToolCall(text, tools);
      assert.equal(call, null, text);
      assert.equal(problem, null, text);
    }
  });

  test("a complete call is unaffected by any of this", () => {
    const { call, problem } = parseToolCall("<read_file>\n<path>a.ts</path>\n</read_file>", tools);
    assert.equal(problem, null);
    assert.equal(call?.name, "read_file");
  });
});

describe("rendering a call back", () => {
  test("round-trips through the parser", () => {
    const original = parseToolCall(
      "<apply_patch>\n<path>a.ts</path>\n<find>\n  const x = 1;\n</find>\n<replace>\n  const x = 2;\n</replace>\n</apply_patch>",
      tools,
    );
    assert.ok(original.call !== null);

    const reparsed = parseToolCall(renderToolCall(original.call), tools);
    assert.equal(reparsed.call?.name, original.call.name);
    assert.deepEqual(reparsed.call?.arguments, original.call.arguments);
  });

  test("code with brackets round-trips", () => {
    const code = "if (a < b) return <T>x;";
    const first = parseToolCall(
      `<apply_patch>\n<path>a.ts</path>\n<find>\nx\n</find>\n<replace>\n${code}\n</replace>\n</apply_patch>`,
      tools,
    );
    const second = parseToolCall(renderToolCall(first.call!), tools);
    assert.equal((second.call?.arguments as { replace: string }).replace, code);
  });
});

describe("the <function=…> spelling", () => {
  // Llama-3-instruct and several fine-tunes write calls this way. The `=`
  // inside the tag made the whole convention invisible: no call, no problem, no
  // repair — and the raw markup fell through to the user as the answer. That is
  // the transcript C4.9 was written about.

  test("a known tool with parameters is a call", () => {
    const parsed = parseToolCall(
      "<function=read_file>\n<parameter=path>train.py</parameter>\n</function>",
      tools,
    );
    assert.equal(parsed.call?.name, "read_file");
    assert.deepEqual(parsed.call?.arguments, { path: "train.py" });
    assert.equal(parsed.problem, null);
    assert.equal(parsed.text, "");
  });

  test("prose around the call survives; the markup does not", () => {
    const parsed = parseToolCall(
      "먼저 파일을 확인하겠습니다.\n<function=read_file>\n<parameter=path>a.py</parameter>\n</function>",
      tools,
    );
    assert.equal(parsed.call?.name, "read_file");
    assert.equal(parsed.text, "먼저 파일을 확인하겠습니다.");
    assert.ok(!parsed.text.includes("<function"));
  });

  test("an unknown function name is a problem, and the markup is stripped", () => {
    const parsed = parseToolCall(
      "<function=install_package>\n<parameter=name>torch</parameter>\n</function>",
      tools,
    );
    assert.equal(parsed.call, null);
    assert.match(parsed.problem ?? "", /is not a tool/);
    assert.ok(!parsed.text.includes("<function"));
    assert.ok(!parsed.text.includes("<parameter"));
  });

  test("a call cut off before </function> is still read", () => {
    const parsed = parseToolCall(
      "<function=read_file>\n<parameter=path>a.py</parameter>",
      tools,
    );
    assert.equal(parsed.call?.name, "read_file");
    assert.deepEqual(parsed.call?.arguments, { path: "a.py" });
  });

  test("missing required parameters are named", () => {
    const parsed = parseToolCall("<function=read_file>\n</function>", tools);
    assert.equal(parsed.call, null);
    assert.match(parsed.problem ?? "", /<path>/);
  });

  test("numbers are coerced by the schema, like every other spelling", () => {
    const parsed = parseToolCall(
      "<function=read_file>\n<parameter=path>a.py</parameter>\n<parameter=startLine>10</parameter>\n</function>",
      tools,
    );
    assert.deepEqual(parsed.call?.arguments, { path: "a.py", startLine: 10 });
  });

  test("mid-sentence mention of the syntax is not a call", () => {
    const parsed = parseToolCall(
      "이 모델은 <function=read_file> 형식을 씁니다.",
      tools,
    );
    assert.equal(parsed.call, null);
    assert.equal(parsed.problem, null);
  });

  test("the native spelling still wins when both are present", () => {
    const parsed = parseToolCall(
      "<read_file>\n<path>a.py</path>\n</read_file>\n<function=list_files>\n<parameter=path>.</parameter>\n</function>",
      tools,
    );
    assert.equal(parsed.call?.name, "read_file");
  });
});

describe("prose survives around leftover markup", () => {
  test("a closed function block between the call and the conclusion is removed, and only it", () => {
    // The strip must take the block, not everything after it. An unclosed-tag
    // rule alone would eat the conclusion too, and the user would get silence
    // where the model wrote an explanation.
    const parsed = parseToolCall(
      "<read_file>\n<path>a.py</path>\n</read_file>\n<function=install_package>\n<parameter=name>torch</parameter>\n</function>\n이후 설명입니다.",
      tools,
    );
    assert.equal(parsed.call?.name, "read_file");
    assert.equal(parsed.text, "이후 설명입니다.");
  });
});
