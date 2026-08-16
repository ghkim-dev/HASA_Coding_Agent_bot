import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classForbidding, prohibitionsIn } from "./statedProhibitions.ts";

/**
 * The second opinion on what the user forbade.
 *
 * Every string in the first two groups is taken from a fixture or a live
 * transcript rather than invented, because the whole point is that this reads
 * sentences people actually write. The third group matters most: this can only
 * deny, so a miss is harmless and a false positive refuses work the user asked
 * for.
 */

const forbids = (text: string): string[] => [...prohibitionsIn(text)].sort();

describe("sentences that forbid, from the fixtures they came from", () => {
  test("S05 — both classes, chained under one negation", () => {
    assert.deepEqual(
      forbids("수정하거나 실행하지 말고 main.py 코드만 분석해줘."),
      ["execute", "modify"],
    );
  });

  test("the live analysis-only prompt — the other chain order", () => {
    assert.deepEqual(
      forbids("실행하거나 수정하지 말고, src/inventory.py 의 구조적 문제만 분석해서 알려주세요."),
      ["execute", "modify"],
    );
  });

  test("S04 turn two — a correction, which is the sentence this exists for", () => {
    // The gate saw an empty constraint list for this turn in three of six runs.
    assert.deepEqual(
      forbids("아니, 실행하라는 게 아니라 코드 결과물을 대화창에서 보여달라는 말이야."),
      ["execute"],
    );
  });

  test("a bare prohibition", () => {
    assert.deepEqual(forbids("실행하지 마세요."), ["execute"]);
    assert.deepEqual(forbids("파일을 고치지 말고 설명만 해주세요."), ["modify"]);
  });

  test("English", () => {
    assert.deepEqual(forbids("Don't run it, just show me the code."), ["execute"]);
    assert.deepEqual(forbids("Explain it without modifying anything."), ["modify"]);
    assert.deepEqual(forbids("Do not execute the script."), ["execute"]);
  });
});

describe("sentences that forbid nothing", () => {
  /**
   * Each of these asks for the work. A refusal here is worse than the defect
   * this module exists for, because the user asked and was told no.
   */
  const ALLOWED = [
    "main.py를 실행해서 결과를 보여줘.",
    "src/calc.py 의 divide 함수에 0으로 나누는 버그가 있습니다. 고치고 python -m pytest 로 확인해 주세요.",
    "pytest 가 실패하고 있습니다. src/stats.py 를 고쳐서 통과시켜 주세요.",
    "테스트를 실행하고 결과를 알려주세요.",
    "이 파일을 수정해서 버그를 고쳐주세요.",
    "실행 결과를 보여줘.",
    "Run the tests and fix what fails.",
    "Please modify the config and restart.",
  ];

  for (const text of ALLOWED) {
    test(`no prohibition: ${text.slice(0, 44)}`, () => {
      assert.deepEqual(forbids(text), [], `falsely forbade: ${text}`);
    });
  }

  test("a report of failure is not an instruction", () => {
    // "못" is excluded deliberately. This is the user telling us what happened,
    // and reading it as a prohibition would refuse the fix they want.
    assert.deepEqual(forbids("pytest 를 실행하지 못했습니다. 왜 그런지 봐주세요."), []);
    assert.deepEqual(forbids("파일을 수정하지 못했어요. 대신 해주세요."), []);
  });

  test("a past tense is not a prohibition", () => {
    assert.deepEqual(forbids("아직 실행하지 않았습니다. 실행해 주세요."), []);
  });

  test("empty text forbids nothing", () => {
    assert.deepEqual(forbids(""), []);
  });
});

describe("mapping a prohibition to the tools it covers", () => {
  test("execution covers run_command and nothing else", () => {
    const p = prohibitionsIn("실행하지 말고 보여줘.");
    assert.equal(classForbidding(p, "run_command"), "execute");
    assert.equal(classForbidding(p, "write_file"), null);
    assert.equal(classForbidding(p, "read_file"), null);
  });

  test("modification covers every write tool", () => {
    const p = prohibitionsIn("수정하지 말고 분석만 해주세요.");
    for (const tool of ["write_file", "create_file", "apply_patch", "delete_file"]) {
      assert.equal(classForbidding(p, tool), "modify", tool);
    }
    assert.equal(classForbidding(p, "run_command"), null);
  });

  test("reading is never forbidden by either class", () => {
    const both = prohibitionsIn("수정하거나 실행하지 말고 분석해줘.");
    for (const tool of ["read_file", "search_files", "list_files", "get_git_diff"]) {
      assert.equal(classForbidding(both, tool), null, tool);
    }
  });

  test("nothing forbidden means nothing refused", () => {
    const none = prohibitionsIn("main.py를 실행해줘.");
    assert.equal(classForbidding(none, "run_command"), null);
  });
});
