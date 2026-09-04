import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classForbidding, describeProhibition, prohibitionsIn } from "./statedProhibitions.ts";

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

describe("조사가 낀 금지도 읽는다", () => {
  test("동사 어간과 하지 사이의 조사", () => {
    // Found while writing the auto-design demos: "수정도 하지 말아줘" is a plain
    // prohibition and was not read as one, because the patterns required the
    // stem and 하지 to be joined. A missed prohibition is the direction that
    // lets a forbidden action through.
    assert.deepEqual(forbids("수정도 하지 말아줘."), ["modify"]);
    assert.deepEqual(forbids("실행도 하지 마세요."), ["execute"]);
    assert.deepEqual(forbids("수정은 하지 말고 분석만 해줘."), ["modify"]);
    assert.deepEqual(forbids("실행만 하지 말아주세요."), ["execute"]);
  });

  test("조사를 넓혀도 요청은 여전히 통과한다", () => {
    assert.deepEqual(forbids("실행을 해서 결과를 보여줘."), []);
    assert.deepEqual(forbids("수정을 해서 버그를 고쳐줘."), []);
    assert.deepEqual(forbids("실행은 했는데 결과가 이상해."), []);
  });
});

describe("going to the web, as the user forbids it", () => {
  // The corpus this class was written against. Every line here is a sentence a
  // user actually types, and the class only ever denies — a miss leaves the
  // contract in charge, a false positive refuses work that was asked for.
  const has = (text: string): boolean => prohibitionsIn(text).has("research");

  const FORBIDS = [
    "웹검색하지 마.",
    "웹 검색하지 말아 주세요.",
    "웹검색은 하지 말고 로컬 코드만 분석해줘.",
    "인터넷 조사는 하지 마세요.",
    "웹을 사용하지 말아줘.",
    "웹 검색 없이 저장소 파일만 확인해줘.",
    "Hugging Face 관련 내용도 웹에서 찾지 말아줘.",
    "웹검색하면 안 돼.",
    "인터넷 검색은 빼줘.",
    "Do not use web search.",
    "Don't browse the web.",
    "Never research this online.",
    "Without web search, inspect the local files only.",
    "Avoid web_search and web_fetch.",
  ];

  const ASKS = [
    "웹검색해서 최신 모델을 확인해줘.",
    "인터넷에서 관련 자료를 조사해줘.",
    "Hugging Face에서 현재 사용할 수 있는 모델을 찾아줘.",
    "Search the web for the latest documentation.",
    "Research this online and cite the sources.",
  ];

  // Reports, questions and history. None of these instructs anything.
  const NEITHER = [
    "웹검색하지 못했습니다.",
    "이전 에이전트가 웹검색을 사용하지 않았습니다.",
    "웹검색을 하지 말아야 하나요?",
    "웹검색 결과가 없었습니다.",
    "The previous run did not use web search.",
    "Why didn't the agent browse the web?",
  ];

  for (const text of FORBIDS) {
    test(`forbids: ${text}`, () => {
      assert.equal(has(text), true);
    });
  }
  for (const text of ASKS) {
    test(`asks for it: ${text}`, () => {
      assert.equal(has(text), false, "a request for the web read as a prohibition");
    });
  }
  for (const text of NEITHER) {
    test(`instructs nothing: ${text}`, () => {
      assert.equal(has(text), false, "a report or question read as a prohibition");
    });
  }

  test("only the web tools, so a local search stays available", () => {
    const found = prohibitionsIn("웹검색하지 말고 저장소 안에서 search_files로 찾아줘.");
    assert.equal(classForbidding(found, "web_search"), "research");
    assert.equal(classForbidding(found, "web_fetch"), "research");
    assert.equal(classForbidding(found, "search_files"), null);
    assert.equal(classForbidding(found, "read_file"), null);
    assert.equal(classForbidding(found, "run_command"), null);
  });

  test("the refusal names what it is honouring", () => {
    assert.match(describeProhibition("research", "web_search"), /웹 검색/);
  });
});

/**
 * The English half, and the two words that were only in one class.
 *
 * `never` and `avoid` were read by the research class and by neither of the
 * other two, so "Never run the tests" and "Avoid running commands" raised no ban
 * at all — while `functionalExtract`'s `ENGLISH_NEGATED` reads both words and
 * refuses to make a requirement out of the verb after them. The two modules
 * disagreed about the same sentence in the direction this file's header calls
 * the dangerous one: no requirement to run, and nothing stopping it.
 *
 * The words then needed a position. "I never run these locally, but please run
 * them" raised an execute ban, so a habit the user reported would have blocked
 * the request they made in the same sentence. An instruction is imperative and
 * opens a clause; anything else in front of the word is a subject, and a
 * sentence with a subject is a report.
 */
describe("영어 금지문", () => {
  const FORBIDS: ReadonlyArray<[string, string]> = [
    ["Never run the tests.", "execute"],
    ["Avoid running commands.", "execute"],
    ["Instead of running it, show me the code.", "execute"],
    ["Never modify the config.", "modify"],
    ["Avoid editing the lockfile.", "modify"],
    ["Rather than changing it, explain what it does.", "modify"],
    ["Never search the web.", "research"],
    ["Avoid web search.", "research"],
    // The clause openers, so a ban chained onto an instruction still reads.
    ["First, install. Never run the tests.", "execute"],
    ["Please never modify the config.", "modify"],
    ["Read the docs and never browse the web.", "research"],
    // `dont` without the apostrophe, which the execute and modify classes
    // required and the research class did not.
    ["Dont run it.", "execute"],
  ];

  for (const [text, klass] of FORBIDS) {
    test(`forbids ${klass}: ${text}`, () => {
      assert.deepEqual([...prohibitionsIn(text)], [klass], text);
    });
  }

  const REPORTS: readonly string[] = [
    "I never run these locally, but please run them.",
    "I avoid editing that file, but go ahead and edit it.",
    "I never search online for this kind of thing, but search now.",
    // `never mind` is not a ban on minding anything.
    "Run the tests and never mind the warnings.",
  ];

  for (const text of REPORTS) {
    test(`reports rather than forbids: ${text}`, () => {
      assert.deepEqual([...prohibitionsIn(text)], [], text);
    });
  }
});
