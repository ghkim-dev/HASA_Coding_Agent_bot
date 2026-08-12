import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseToolCall, type ToolDescriptor } from "./textTools.ts";
import { argText } from "./argValues.ts";
import { parseTurnContract } from "./turnContract.ts";
import { parsePlan } from "./tools/planTool.ts";

/**
 * The turn that could not start.
 *
 * From use, and the whole of it fits in four lines:
 *
 *     user:  개와 고양이를 분류하는 모델을 학습하고 …
 *     model: <tool_call>{"name": "record_request", "arguments": {…}}</tool_call>
 *     agent: ["tool_call" is not a tool. Available tools: …]
 *
 * The model did everything right. Correct tool, arguments matching the schema,
 * valid JSON. The runtime threw it away because the envelope was not the
 * spelling the prompt asked for — and `record_request` is the first call of
 * every turn, so nothing after it ran: no contract, therefore
 * `TURN_CONTRACT_REQUIRED` on every substantive action for the rest of the
 * turn. The entire control plane sat behind a call it had refused.
 *
 * Two bugs, and either one alone is enough to lose the turn:
 *
 *   1. `<tool_call>{…}</tool_call>` was read as an invented tool.
 *   2. `"requirements": ["a", "b"]` — a real array — became an empty string,
 *      so even a parsed call would have failed validation for having no
 *      requirements.
 *
 * They are tested together because that is how they were met.
 */

const TOOLS: ToolDescriptor[] = [
  {
    name: "record_request",
    description: "what the user asked for",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string" },
        relation: { type: "string" },
        intents: { type: "string" },
        requirements: { type: "string" },
        constraints: { type: "string" },
      },
      required: ["goal", "relation", "intents"],
    },
  },
  {
    name: "read_file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "update_plan",
    parameters: {
      type: "object",
      properties: { steps: { type: "string" }, current: { type: "number" } },
      required: ["steps", "current"],
    },
  },
];

/** The exact reply from the transcript. */
const REPORTED = `개와 고양이를 분류하는 모델을 학습하고 추론한 성능을 비교해줘.
<tool_call>{"name": "record_request", "arguments": {"goal": "개와 고양이를 분류하는 다양한 모델(CNN부터 Transformer까지)을 학습하고 성능을 비교", "relation": "new_task", "intents": ["modify", "execute", "present"], "requirements": ["다양한 모델(CNN, Transformer 등) 학습", "성능 비교", "결과 제시"]}}</tool_call>`;

describe("the reported failure, end to end", () => {
  test("the call is read", () => {
    const parsed = parseToolCall(REPORTED, TOOLS);

    assert.equal(parsed.problem, null, parsed.problem ?? "");
    assert.equal(parsed.call?.name, "record_request");
    assert.equal(
      (parsed.call?.arguments as Record<string, unknown>)["goal"],
      "개와 고양이를 분류하는 다양한 모델(CNN부터 Transformer까지)을 학습하고 성능을 비교",
    );
  });

  test("and the contract it carries is accepted", () => {
    // The second half. The arguments arrive as arrays, which is what a JSON
    // envelope naturally produces, and the contract used to be refused for
    // having no requirements.
    const parsed = parseToolCall(REPORTED, TOOLS);
    assert.ok(parsed.call !== null);
    const contract = parseTurnContract(parsed.call.arguments as Record<string, unknown>, "t0");

    assert.equal(contract.ok, true, contract.ok ? "" : contract.problem.reason);
    assert.ok(contract.ok);
    assert.equal(contract.contract.relation, "new_task");
    assert.deepEqual(contract.contract.requirements.map((r) => r.description), [
      "다양한 모델(CNN, Transformer 등) 학습",
      "성능 비교",
      "결과 제시",
    ]);
    assert.deepEqual(contract.contract.intents.sort(), ["execute", "modify", "present"]);
  });

  test("the prose survives without the markup", () => {
    const parsed = parseToolCall(REPORTED, TOOLS);
    assert.match(parsed.text, /개와 고양이를 분류하는 모델/);
    assert.ok(!parsed.text.includes("tool_call"), "the user does not read our syntax");
  });
});

describe("the JSON envelope, in the spellings models actually use", () => {
  const call = (body: string): ReturnType<typeof parseToolCall> => parseToolCall(body, TOOLS);

  test("tool_call, function_call, tool_use", () => {
    for (const tag of ["tool_call", "function_call", "tool_use"]) {
      const parsed = call(`<${tag}>{"name": "read_file", "arguments": {"path": "a.py"}}</${tag}>`);
      assert.equal(parsed.call?.name, "read_file", tag);
      assert.equal((parsed.call?.arguments as Record<string, unknown>)["path"], "a.py", tag);
    }
  });

  test("`parameters` and `args` are read as arguments too", () => {
    for (const key of ["arguments", "parameters", "args"]) {
      const parsed = call(`<tool_call>{"name": "read_file", "${key}": {"path": "a.py"}}</tool_call>`);
      assert.equal((parsed.call?.arguments as Record<string, unknown>)["path"], "a.py", key);
    }
  });

  test("a fenced block inside the envelope", () => {
    const parsed = call('<tool_call>\n```json\n{"name": "read_file", "arguments": {"path": "a.py"}}\n```\n</tool_call>');
    assert.equal(parsed.call?.name, "read_file");
  });

  test("prose around it is kept and the envelope is not", () => {
    const parsed = call(`먼저 파일을 읽겠습니다.\n<tool_call>{"name": "read_file", "arguments": {"path": "a.py"}}</tool_call>\n그 다음 고치겠습니다.`);
    assert.match(parsed.text, /먼저 파일을 읽겠습니다/);
    assert.match(parsed.text, /그 다음 고치겠습니다/);
    assert.ok(!parsed.text.includes("read_file"));
  });

  test("the documented XML format still wins where both could match", () => {
    // A model that follows the prompt is unaffected. The envelope is read only
    // when no real tool tag was found.
    const parsed = call(`<read_file><path>real.py</path></read_file>`);
    assert.equal((parsed.call?.arguments as Record<string, unknown>)["path"], "real.py");
  });
});

describe("what the envelope must still refuse", () => {
  test("a tool that does not exist is still an invented tool", () => {
    const parsed = parseToolCall('<tool_call>{"name": "delete_everything", "arguments": {}}</tool_call>', TOOLS);
    assert.equal(parsed.call, null);
    assert.match(parsed.problem ?? "", /is not a tool/);
  });

  test("a body that is not JSON is not silently swallowed", () => {
    const parsed = parseToolCall("<tool_call>read the file please</tool_call>", TOOLS);
    assert.equal(parsed.call, null);
    // It falls through to the existing paths, which say something useful rather
    // than treating a visible attempt as prose.
    assert.notEqual(parsed.problem, undefined);
  });

  test("an envelope cut off mid-write is reported as cut off", () => {
    const parsed = parseToolCall('<tool_call>{"name": "read_file", "argum', TOOLS);
    assert.equal(parsed.call, null);
    assert.match(parsed.problem ?? "", /unclosed|never closed/i);
  });

  test("required parameters are still required", () => {
    const parsed = parseToolCall('<tool_call>{"name": "read_file", "arguments": {}}</tool_call>', TOOLS);
    // The envelope hands arguments over as they came; the tool's own validation
    // is what rejects an empty path, exactly as on the native path.
    assert.equal(parsed.call?.name, "read_file");
    assert.deepEqual(parsed.call?.arguments, {});
  });
});

describe("a list-shaped argument that arrived as a list", () => {
  test("an array becomes lines", () => {
    assert.equal(argText(["a", "b", "c"]), "a\nb\nc");
  });

  test("a string is left alone", () => {
    assert.equal(argText("a\nb"), "a\nb");
  });

  test("objects with an obvious text field, because models wrap items", () => {
    assert.equal(argText([{ step: "설치" }, { description: "실행" }, { text: "확인" }]), "설치\n실행\n확인");
  });

  test("nothing becomes nothing, never [object Object]", () => {
    assert.equal(argText([{ unrelated: 1 }]), "");
    assert.equal(argText(null), "");
    assert.equal(argText(undefined), "");
    assert.ok(!argText([{ unrelated: 1 }]).includes("object"));
  });

  test("a plan sent as an array is a plan", () => {
    // `update_plan` is the other call every turn makes, and it dropped arrays
    // the same way.
    const parsed = parseToolCall(
      '<tool_call>{"name": "update_plan", "arguments": {"steps": ["데이터 준비", "CNN 학습", "비교"], "current": 1}}</tool_call>',
      TOOLS,
    );
    assert.ok(parsed.call !== null);
    const args = parsed.call.arguments as Record<string, unknown>;
    const plan = parsePlan(argText(args["steps"]), args["current"]);
    assert.deepEqual(plan?.steps, ["데이터 준비", "CNN 학습", "비교"]);
    assert.equal(plan?.current, 1);
  });

  test("a contract sent as arrays keeps every requirement", () => {
    const contract = parseTurnContract(
      {
        goal: "분류기 만들기",
        relation: "new_task",
        intents: ["modify", "execute"],
        requirements: ["CNN", "Transformer", "학습", "비교"],
        constraints: ["no_execute: 실행하지 마"],
      },
      "t0",
    );
    assert.ok(contract.ok);
    assert.equal(contract.contract.requirements.length, 4);
    assert.equal(contract.contract.constraints[0]?.kind, "no_execute");
  });
});
