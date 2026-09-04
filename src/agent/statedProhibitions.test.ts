import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import {
  classForbidding,
  describeProhibition,
  prohibitionsIn,
  type ProhibitedClass,
} from "./statedProhibitions.ts";

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

/** 한 사례 = 한 문장, 한 축 = 그 문장이 금지하는 클래스 집합. */
type Sentence = readonly [text: string, klasses: readonly string[]];

/**
 * 한 사례 = 미리 읽어 둔 금지 집합 하나, 한 축 = 도구 하나.
 *
 * 도구 축 표는 실행·수정·읽기 세 군데와 웹 블록에서 같은 모양을 쓴다. 웹
 * 블록이 그 모양을 인라인으로 한 번 더 적어 두는 바람에 같은 표가 두 벌
 * 따로 움직일 수 있었다. 이름은 하나다.
 */
type Cover = readonly [tool: string, klass: string | null];

const label = (klasses: readonly string[]): string =>
  klasses.length === 0 ? "금지 없음" : klasses.join("+");

/**
 * 미리 읽어 두는 금지 집합은 before() 에서 만들고, 터져도 throw 하지 않는다.
 *
 * `node --test` 는 before() 훅이(그리고 describe 본문이) throw 하면 그 아래
 * 테스트를 전부 **cancelled** 로 처리하면서 요약줄에는 `fail 0` 을 찍는다.
 * 실제로 확인했다: 훅 하나가 터지면 그 describe 의 테스트가 통째로 실행되지
 * 않는데 요약은 초록이다 — 요약줄의 `fail 0` 이 거짓말을 한다. 사례별로 갈라
 * 놓은 입도가 바로 그 훅 하나에 매달려 있으므로, 실패는 던지지 말고
 * `buildError` 에 담는다.
 *
 * 담아 두면 그 describe 의 첫 테스트가 "만들어졌다"를 이름 가진 실패로 말하고,
 * 축별 테스트들은 빈 집합을 읽어 각자 자기 이름으로 실패한다. 취소 0, 실패 N.
 * 사례별 테스트가 빈 집합을 읽고 제 이름으로 실패하는 편이, 취소되어 사라지는
 * 것보다 낫다.
 */
const buildFailed = (err: unknown): string =>
  `금지 집합을 만들지 못했습니다: ${err instanceof Error ? err.stack : String(err)}`;

describe("sentences that forbid, from the fixtures they came from", () => {
  test("S05 — both classes, chained under one negation · execute+modify", () => {
    assert.deepEqual(
      forbids("수정하거나 실행하지 말고 main.py 코드만 분석해줘."),
      ["execute", "modify"],
    );
  });

  test("the live analysis-only prompt — the other chain order · execute+modify", () => {
    assert.deepEqual(
      forbids("실행하거나 수정하지 말고, src/inventory.py 의 구조적 문제만 분석해서 알려주세요."),
      ["execute", "modify"],
    );
  });

  test("S04 turn two — a correction, which is the sentence this exists for · execute", () => {
    // The gate saw an empty constraint list for this turn in three of six runs.
    assert.deepEqual(
      forbids("아니, 실행하라는 게 아니라 코드 결과물을 대화창에서 보여달라는 말이야."),
      ["execute"],
    );
  });

  const BARE: readonly Sentence[] = [
    ["실행하지 마세요.", ["execute"]],
    ["파일을 고치지 말고 설명만 해주세요.", ["modify"]],
  ];

  for (const [text, klasses] of BARE) {
    test(`a bare prohibition: ${text} · ${label(klasses)}`, () => {
      assert.deepEqual(forbids(text), klasses, text);
    });
  }

  const ENGLISH: readonly Sentence[] = [
    ["Don't run it, just show me the code.", ["execute"]],
    ["Explain it without modifying anything.", ["modify"]],
    ["Do not execute the script.", ["execute"]],
  ];

  for (const [text, klasses] of ENGLISH) {
    test(`English: ${text} · ${label(klasses)}`, () => {
      assert.deepEqual(forbids(text), klasses, text);
    });
  }

  // 길이 핀. 표에서 한 줄을 지우면 테스트 수만 줄고 나머지는 초록으로 남는다.
  // 사라진 사례는 이 핀에서만 이름을 가진 실패가 된다. 아래 표마다 같은 핀이 붙는다.
  test("표의 줄 수 · BARE 2 + ENGLISH 3", () => {
    assert.equal(BARE.length, 2);
    assert.equal(ENGLISH.length, 3);
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

  test("표의 줄 수 · ALLOWED 8", () => {
    assert.equal(ALLOWED.length, 8);
  });

  describe("a report of failure is not an instruction", () => {
    /**
     * "못" is excluded deliberately. This is the user telling us what happened,
     * and reading it as a prohibition would refuse the fix they want.
     */
    const REPORTED_FAILURES: readonly Sentence[] = [
      ["pytest 를 실행하지 못했습니다. 왜 그런지 봐주세요.", []],
      ["파일을 수정하지 못했어요. 대신 해주세요.", []],
    ];

    for (const [text, klasses] of REPORTED_FAILURES) {
      test(`못 — a report: ${text} · ${label(klasses)}`, () => {
        assert.deepEqual(forbids(text), klasses, text);
      });
    }

    test("표의 줄 수 · REPORTED_FAILURES 2", () => {
      assert.equal(REPORTED_FAILURES.length, 2);
    });
  });

  test("a past tense is not a prohibition · 아직 실행하지 않았습니다. 실행해 주세요. · 금지 없음", () => {
    assert.deepEqual(forbids("아직 실행하지 않았습니다. 실행해 주세요."), []);
  });

  test("empty text forbids nothing · (빈 문자열) · 금지 없음", () => {
    assert.deepEqual(forbids(""), []);
  });
});

describe("mapping a prohibition to the tools it covers", () => {
  // 문장마다 한 번만 읽는다. 아래 축별 테스트는 이 결과를 다시 계산하지 않고 읽기만 한다.
  // 읽는 자리는 before() 이고, 터져도 던지지 않는다 — 위 `buildFailed` 의 주석을 보라.
  let buildError: unknown = null;
  let EXECUTE_ONLY: ReadonlySet<ProhibitedClass> = new Set();
  let MODIFY_ONLY: ReadonlySet<ProhibitedClass> = new Set();
  let BOTH: ReadonlySet<ProhibitedClass> = new Set();
  let NONE: ReadonlySet<ProhibitedClass> = new Set();

  before(() => {
    try {
      EXECUTE_ONLY = prohibitionsIn("실행하지 말고 보여줘.");
      MODIFY_ONLY = prohibitionsIn("수정하지 말고 분석만 해주세요.");
      BOTH = prohibitionsIn("수정하거나 실행하지 말고 분석해줘.");
      NONE = prohibitionsIn("main.py를 실행해줘.");
    } catch (err) {
      buildError = err;
    }
  });

  test("미리 읽어 둔 금지 집합이 만들어졌다", () => {
    assert.equal(buildError, null, buildFailed(buildError));
    assert.deepEqual([...EXECUTE_ONLY].sort(), ["execute"]);
    assert.deepEqual([...MODIFY_ONLY].sort(), ["modify"]);
    assert.deepEqual([...BOTH].sort(), ["execute", "modify"]);
    assert.deepEqual([...NONE], []);
  });

  // execution covers run_command and nothing else.
  const EXECUTE_COVERS: readonly Cover[] = [
    ["run_command", "execute"],
    ["write_file", null],
    ["read_file", null],
  ];

  for (const [tool, klass] of EXECUTE_COVERS) {
    test(`실행하지 말고 보여줘. · ${tool} → ${klass ?? "허용"}`, () => {
      assert.equal(classForbidding(EXECUTE_ONLY, tool), klass, tool);
    });
  }

  // modification covers every write tool, and nothing that runs.
  const MODIFY_COVERS: readonly Cover[] = [
    ["write_file", "modify"],
    ["create_file", "modify"],
    ["apply_patch", "modify"],
    ["delete_file", "modify"],
    ["run_command", null],
  ];

  for (const [tool, klass] of MODIFY_COVERS) {
    test(`수정하지 말고 분석만 해주세요. · ${tool} → ${klass ?? "허용"}`, () => {
      assert.equal(classForbidding(MODIFY_ONLY, tool), klass, tool);
    });
  }

  // reading is never forbidden by either class.
  const READ_COVERS: readonly Cover[] = [
    ["read_file", null],
    ["search_files", null],
    ["list_files", null],
    ["get_git_diff", null],
  ];

  for (const [tool, klass] of READ_COVERS) {
    test(`수정하거나 실행하지 말고 분석해줘. · ${tool} → ${klass ?? "허용"}`, () => {
      assert.equal(classForbidding(BOTH, tool), klass, tool);
    });
  }

  test("nothing forbidden means nothing refused · main.py를 실행해줘. · run_command → 허용", () => {
    assert.equal(classForbidding(NONE, "run_command"), null);
  });

  test("표의 줄 수 · EXECUTE_COVERS 3 + MODIFY_COVERS 5 + READ_COVERS 4", () => {
    assert.equal(EXECUTE_COVERS.length, 3);
    assert.equal(MODIFY_COVERS.length, 5);
    assert.equal(READ_COVERS.length, 4);
  });
});

describe("조사가 낀 금지도 읽는다", () => {
  /**
   * 동사 어간과 하지 사이의 조사.
   *
   * Found while writing the auto-design demos: "수정도 하지 말아줘" is a plain
   * prohibition and was not read as one, because the patterns required the
   * stem and 하지 to be joined. A missed prohibition is the direction that
   * lets a forbidden action through.
   */
  const WITH_PARTICLE: readonly Sentence[] = [
    ["수정도 하지 말아줘.", ["modify"]],
    ["실행도 하지 마세요.", ["execute"]],
    ["수정은 하지 말고 분석만 해줘.", ["modify"]],
    ["실행만 하지 말아주세요.", ["execute"]],
  ];

  for (const [text, klasses] of WITH_PARTICLE) {
    test(`조사 낀 금지: ${text} · ${label(klasses)}`, () => {
      assert.deepEqual(forbids(text), klasses, text);
    });
  }

  // 조사를 넓혀도 요청은 여전히 통과한다.
  const STILL_A_REQUEST: readonly Sentence[] = [
    ["실행을 해서 결과를 보여줘.", []],
    ["수정을 해서 버그를 고쳐줘.", []],
    ["실행은 했는데 결과가 이상해.", []],
  ];

  for (const [text, klasses] of STILL_A_REQUEST) {
    test(`조사를 넓혀도 요청은 통과: ${text} · ${label(klasses)}`, () => {
      assert.deepEqual(forbids(text), klasses, text);
    });
  }

  test("표의 줄 수 · WITH_PARTICLE 4 + STILL_A_REQUEST 3", () => {
    assert.equal(WITH_PARTICLE.length, 4);
    assert.equal(STILL_A_REQUEST.length, 3);
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
    test(`forbids: ${text} · research`, () => {
      assert.equal(has(text), true);
    });
  }
  for (const text of ASKS) {
    test(`asks for it: ${text} · research 아님`, () => {
      assert.equal(has(text), false, "a request for the web read as a prohibition");
    });
  }
  for (const text of NEITHER) {
    test(`instructs nothing: ${text} · research 아님`, () => {
      assert.equal(has(text), false, "a report or question read as a prohibition");
    });
  }

  test("표의 줄 수 · FORBIDS 14 + ASKS 5 + NEITHER 6", () => {
    assert.equal(FORBIDS.length, 14);
    assert.equal(ASKS.length, 5);
    assert.equal(NEITHER.length, 6);
  });

  // only the web tools, so a local search stays available. 문장은 한 번만
  // 읽고, 도구별로 나누어 본다. 읽는 자리는 before() 이고, 터져도 던지지 않는다.
  let buildError: unknown = null;
  let WEB_ONLY: ReadonlySet<ProhibitedClass> = new Set();

  before(() => {
    try {
      WEB_ONLY = prohibitionsIn("웹검색하지 말고 저장소 안에서 search_files로 찾아줘.");
    } catch (err) {
      buildError = err;
    }
  });

  test("미리 읽어 둔 웹 금지 집합이 만들어졌다", () => {
    assert.equal(buildError, null, buildFailed(buildError));
    assert.deepEqual([...WEB_ONLY], ["research"]);
  });

  const WEB_COVERS: readonly Cover[] = [
    ["web_search", "research"],
    ["web_fetch", "research"],
    ["search_files", null],
    ["read_file", null],
    ["run_command", null],
  ];

  for (const [tool, klass] of WEB_COVERS) {
    test(`웹검색하지 말고 저장소 안에서 search_files로 찾아줘. · ${tool} → ${klass ?? "허용"}`, () => {
      assert.equal(classForbidding(WEB_ONLY, tool), klass, tool);
    });
  }

  test("표의 줄 수 · WEB_COVERS 5", () => {
    assert.equal(WEB_COVERS.length, 5);
  });

  test("the refusal names what it is honouring · research/web_search · 문구", () => {
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

  test("표의 줄 수 · FORBIDS 12 + REPORTS 4", () => {
    assert.equal(FORBIDS.length, 12);
    assert.equal(REPORTS.length, 4);
  });
});
