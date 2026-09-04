import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { HOLDOUT_CASES, type HoldoutCase } from "./holdoutCases.ts";
import { GOLD_CASES } from "./goldCases.ts";
import { scoreGold, type GoldScore } from "./goldRequirements.ts";
import { previewDesign, type PreviewResult, type Proposer } from "./preview.ts";
import { parseProposals } from "./proposalParse.ts";

/**
 * The unseen measurement, and the hash that keeps it honest.
 *
 * The 43 development cases cannot measure generalisation any more — the
 * implementation was debugged against them, so they measure its memory. These 33
 * were written first and run after, and the sha256 below pins the answers so that
 * ordering stays checkable instead of being a claim in a commit message. Edit an
 * answer and this test fails until the digest is updated deliberately, next to a
 * change-log entry saying why.
 *
 * Not a rewording of the development set either — that would measure tolerance
 * for synonyms. Every case is a shape the other file does not contain: three-turn
 * inheritance, a correction that supersedes one requirement and keeps another, an
 * English prohibition, a model proposal that invented a requirement, a model
 * response that forged an authority field.
 *
 * ## What the first run said
 *
 * Before any of the fixes it prompted: recall 37/43, precision 37/38, target
 * accuracy 31/37, startability 27/33. Those numbers are the reason a holdout
 * exists, and they are recorded in the commit message rather than quietly
 * replaced by the current ones.
 *
 * ## 집계와 사례, 둘 다
 *
 * 아래에는 두 층이 있고 하나가 다른 하나를 대신하지 않는다. 집계 핀(recall
 * 43/43 처럼 분모를 함께 적은 것)은 그대로 둔다 — 사례별 테스트만 남기면
 * 말뭉치가 사례를 잃었을 때 남은 것들만 조용히 통과한다. 그 위에 사례별·축별
 * 테스트를 얹어, 실패가 "숫자가 움직였다" 가 아니라 "이 사례의 이 축이
 * 어긋났다" 를 말하게 한다.
 */

/**
 * sha256 of `holdoutCases.ts`, over its content with line endings normalised.
 *
 * Kept here rather than in the data file, because a digest cannot include itself.
 * Normalised because `.gitattributes` checks out `eol=lf` while a Windows working
 * tree can hold CRLF: hashing raw bytes pins the answers to one platform and fails
 * everywhere else, which would make this test a portability bug rather than a
 * guarantee.
 *
 * ## Changes to the answers, with their reasons
 *
 * `1cdbfd1c…` — `h-continue-changes-nothing` expected the standing requirement
 * to read "마이그레이션 스크립트를 추가한다". The extractor rendered every
 * `만들다` with its class phrase 추가한다, which the file's own rule forbids for
 * noun-verbs and had never been applied to the entries written as inflections —
 * "이미지를 동영상으로 만들어줘" was coming back as "이미지를 동영상으로
 * 추가한다". The answer moved because the rendering was corrected, not because
 * the reading changed: the act, the target and the relation are all as they were.
 */
const HOLDOUT_DIGEST = "1cdbfd1c823ce2ac35440dc3450ffc46e304f522bf08ec16e149ee7f6e611e46";

/** The content this digest is over. One definition, used to pin and to verify. */
function normalise(source: string): string {
  return source.split("\r\n").join("\n");
}

/**
 * A proposer that returns a fixed string, exactly as a provider would.
 *
 * 모듈 수준에 있는 이유는 하나다: 주입된 답을 먹인 preview 를 `before()` 에서
 * 사례당 한 번만 만들고, 테스트는 그 결과를 읽기만 하기 위해서다.
 */
const injected = (raw: string): Proposer => async ({ turnId }) => {
  const parse = parseProposals(raw, turnId);
  return { proposals: parse.proposals, modelId: "mock", calls: 1, parse };
};

let score: GoldScore;
const previews = new Map<string, PreviewResult>();

/**
 * 사례 하나만 담아 다시 센 점수. 사례별 테스트가 읽는 곳.
 *
 * 집계 점수를 사례별로 되돌릴 방법이 따로 없어서, 같은 채점기를 사례 하나짜리
 * 목록에 다시 적용한다. 공짜는 아니다. `previewDesign` 은 사례당 한 번만 돌고 그
 * 결과를 재사용하지만, `scoreGold` 는 preview 를 읽기만 하는 함수가 아니다 —
 * 턴마다 `readExtraction` 을 불러 추출기를 다시 돌린다(goldRequirements.ts 의
 * `scoreGold` 안쪽 루프). 그러니 이 한 줄은 사례별로 추출을 한 번 더 하는 값을
 * 치른다. 그 값을 치르는 이유는 실패가 사례 이름을 갖기 때문이고, 33개 사례를
 * 다시 돌려도 이 파일 전체가 1초 안에 끝나므로 구조는 그대로 둔다.
 */
const perCase = new Map<string, GoldScore>();

/** 주입된 모델 답을 먹인 preview. `modelAnswer` 를 가진 사례마다 한 번. */
const proposed = new Map<string, PreviewResult>();

/**
 * 말뭉치를 만들다 터진 오류. 던지지 않고 여기 담아 두는 이유가 있다.
 *
 * `node --test` 는 `before()` 가 throw 하면 그 아래 테스트를 전부 **cancelled** 로
 * 처리하고, 요약줄에는 `fail 0` 을 찍는다. 이 파일의 사본으로 확인했다 — 훅에
 * 오류 한 줄을 넣자 그때 있던 테스트 317개가 한 줄도 실행되지 않았는데 요약은
 * `# fail 0`, `# cancelled 317` 이었다. 요약줄만 읽는 눈에는 초록으로 보인다는
 * 뜻이고, 위에서 사례별로 갈라 놓은 입도가 통째로 훅 하나에 매달려 있다는 뜻이다.
 *
 * 그래서 훅은 오류를 삼켜 기록만 하고, 아래 첫 테스트가 그것을 주장한다. 말뭉치가
 * 깨지면 취소 0, 실패 N 이 된다 — 사례별 테스트가 빈 맵을 읽고 각자 자기 이름으로
 * 실패하는 것이, 이름 없이 취소되어 사라지는 것보다 낫다.
 */
let buildError: unknown = null;

before(async () => {
  try {
    for (const holdout of HOLDOUT_CASES) {
      previews.set(holdout.id, await previewDesign({ turns: holdout.turns.map((t) => t.text) }));
    }
    score = scoreGold(HOLDOUT_CASES, previews);
    for (const holdout of HOLDOUT_CASES) perCase.set(holdout.id, scoreGold([holdout], previews));
    for (const holdout of HOLDOUT_CASES) {
      const answer = holdout.extras?.modelAnswer;
      if (answer === undefined) continue;
      proposed.set(
        holdout.id,
        await previewDesign({
          turns: holdout.turns.map((t) => t.text),
          propose: injected(answer.raw),
        }),
      );
    }
  } catch (err) {
    buildError = err;
  }
});

/** 그 사례만 담아 센 점수를 읽는다. 계산하지 않는다. */
function only(id: string): GoldScore {
  const one = perCase.get(id);
  assert.ok(one !== undefined, `${id}: 사례별 채점 결과가 없습니다`);
  return one;
}

/** 그 사례의 preview 를 읽는다. 마찬가지로 계산하지 않는다. */
function previewOf(id: string): PreviewResult {
  const preview = previews.get(id);
  assert.ok(preview !== undefined, `${id}: preview 가 없습니다`);
  return preview;
}

/** 주입된 모델 답을 먹인 그 사례의 preview. */
function proposalOf(id: string): PreviewResult {
  const run = proposed.get(id);
  assert.ok(run !== undefined, `${id}: 모델 제안 preview 가 없습니다`);
  return run;
}

/** 마지막 턴까지 살아남은, 사용자가 말한 요구사항의 텍스트. */
function liveTexts(preview: PreviewResult): string[] {
  return preview.requirements
    .filter((spec) => spec.status !== "system_added" && spec.supersededBy === undefined)
    .map((spec) => spec.text);
}

/** 정답이 적어 둔 요구사항 수. 테스트 이름의 분모라 모듈 로드 시점에 센다. */
function goldCount(holdout: HoldoutCase): number {
  return holdout.turns.reduce((n, turn) => n + turn.requirements.length, 0);
}

/** 분모가 n 이고 전부 맞은 비율. 분모가 0이면 value 는 null 이다 — `ratio` 의 규칙 그대로. */
function full(of: number): { hit: number; of: number; value: number | null } {
  return { hit: of, of, value: of === 0 ? null : 1 };
}

/**
 * 말뭉치가 만들어졌다는 주장. 이 파일에서 가장 먼저 도는 테스트다.
 *
 * `before()` 가 삼킨 오류를 여기서 이름 있는 실패로 되돌린다. 빌드가 깨지면 아래
 * 사례별 테스트도 빈 맵을 읽고 각자 실패하지만, *왜* 비었는지를 들고 있는 것은 이
 * 테스트 하나다 — 그래서 스택을 통째로 메시지에 싣는다.
 */
describe("말뭉치 빌드", () => {
  test("말뭉치가 만들어졌다", () => {
    assert.equal(
      buildError,
      null,
      `말뭉치를 만들지 못했습니다: ${buildError instanceof Error ? buildError.stack : String(buildError)}`,
    );
    assert.equal(previews.size, HOLDOUT_CASES.length, `preview 를 ${previews.size} 개만 만들었습니다`);
    assert.equal(perCase.size, HOLDOUT_CASES.length, `사례별 채점이 ${perCase.size} 개뿐입니다`);
    assert.ok(proposed.size > 0, "모델 제안 preview 가 하나도 없습니다");
  });
});

describe("Holdout 집합 자체", () => {
  test("정답 파일의 해시가 기록된 값과 같다", async () => {
    const path = new URL("./holdoutCases.ts", import.meta.url);
    const digest = createHash("sha256").update(normalise(await readFile(path, "utf8"))).digest("hex");
    assert.equal(
      digest,
      HOLDOUT_DIGEST,
      "정답이 바뀌었습니다. 의도한 변경이면 변경 이력을 남기고 이 해시를 갱신하십시오.",
    );
  });

  test("30개 이상이다", () => {
    assert.ok(HOLDOUT_CASES.length >= 30, `${HOLDOUT_CASES.length} 개뿐입니다`);
  });

  test("개발 집합의 문장을 재사용하지 않는다", () => {
    // A holdout that shares sentences with the set the code was fitted to is not a
    // holdout. Checked on the text, so a copied case cannot hide behind a new id.
    const seen = new Set(GOLD_CASES.flatMap((c) => c.turns.map((t) => t.text.trim())));
    const reused = HOLDOUT_CASES.flatMap((c) =>
      c.turns.map((t) => ({ id: c.id, text: t.text.trim() })),
    ).filter((t) => seen.has(t.text));
    assert.deepEqual(
      reused.map((r) => `${r.id}: ${r.text}`),
      [],
      `개발 집합과 같은 문장: ${reused.map((r) => `${r.id} "${r.text}"`).join(" / ")}`,
    );
  });
});

/**
 * 개발 집합이 다루지 않는 축을 담는다.
 *
 * 다섯 축이 각자 하나의 테스트다. 한 테스트에 넣으면 첫 번째 `assert` 에서 멈춰,
 * 뒤의 네 축이 남아 있는지 없는지는 실패 메시지에 나오지 않는다.
 */
describe("Holdout 이 담는 추가 축", () => {
  const extras = HOLDOUT_CASES.filter((c) => c.extras !== undefined);

  test("축 standing · 요구사항 승계 사례가 있다", () => {
    assert.ok(extras.some((c) => c.extras?.standing !== undefined), "요구사항 승계 사례가 없습니다");
  });

  test("축 priorities · priority 사례가 있다", () => {
    assert.ok(extras.some((c) => c.extras?.priorities !== undefined), "priority 사례가 없습니다");
  });

  test("축 kinds · kind 사례가 있다", () => {
    assert.ok(extras.some((c) => c.extras?.kinds !== undefined), "kind 사례가 없습니다");
  });

  test("축 minimalSpan · 최소 span 사례가 있다", () => {
    assert.ok(extras.some((c) => c.extras?.minimalSpan !== undefined), "최소 span 사례가 없습니다");
  });

  test("축 modelAnswer · 모델 제안 사례가 있다", () => {
    assert.ok(extras.some((c) => c.extras?.modelAnswer !== undefined), "모델 제안 사례가 없습니다");
  });
});

describe("Holdout 요구사항 정확성 — 분모를 함께", () => {
  test("recall 43/43", () => {
    // Was 42/43. The miss was `h-english-request` — a sentence with no Korean
    // verb in it — and the English pass added to `functionalExtract` closed it.
    // The holdout answers are unchanged: this is the code moving to meet them,
    // which is the only direction a frozen set may be met from.
    assert.deepEqual(score.requirementRecall, { hit: 43, of: 43, value: 1 });
    assert.deepEqual(score.missed, []);
  });

  test("precision 43/43 — 발명이 0이다", () => {
    // The number that mattered while the English pass was written. Reading a
    // new language is only worth it if nothing is invented on the way, and a
    // pass that raised recall by inventing a requirement would show up here.
    assert.deepEqual(score.requirementPrecision, { hit: 43, of: 43, value: 1 });
    assert.deepEqual(score.spurious, []);
  });

  test("target 43/43, span 근거 43/43, relation 38/38", () => {
    assert.deepEqual(score.targetAccuracy, { hit: 43, of: 43, value: 1 });
    assert.deepEqual(score.spanGrounding, { hit: 43, of: 43, value: 1 });
    assert.deepEqual(score.relationAccuracy, { hit: 38, of: 38, value: 1 });
  });

  test("사례 33개, 턴 38개를 실제로 셌다", () => {
    // 위 분모들이 어디서 왔는지. 사례별 테스트는 말뭉치에서 생성되므로 사례가
    // 사라지면 그 테스트도 함께 사라진다 — 그래서 개수 자체를 따로 못박는다.
    assert.equal(score.cases, 33);
    assert.equal(score.turns, 38);
  });
});

/**
 * 사례별 요구사항 recall — 놓친 것이 어느 사례인지.
 *
 * 집계 43/43 은 어느 문장을 읽지 못했는지 말해 주지 않는다. 분모는 그 사례의
 * 정답에 적힌 요구사항 수이고, 이름에 적어 두어 말뭉치가 답을 바꾸면 테스트
 * 이름부터 달라지게 했다.
 */
describe("사례별 요구사항 recall", () => {
  for (const holdout of HOLDOUT_CASES) {
    const of = goldCount(holdout);
    // 분모가 0인 사례는 아래 "요구사항이 없는 사례" 가 하나로 맡는다. 여기에
    // 찍으면 missed 도 recall 도 무엇을 하든 통과하는 항진명제가 된다.
    if (of === 0) continue;
    test(`${holdout.id} · 요구사항 recall ${of}/${of}`, () => {
      const one = only(holdout.id);
      assert.deepEqual(
        one.missed.map((m) => `${m.turnId} "${m.gold.quote}"`),
        [],
        `${holdout.id}: 정답에 있는 요구사항을 읽지 못했습니다`,
      );
      assert.deepEqual(one.requirementRecall, full(of));
    });
  }
});

/**
 * 사례별 요구사항 precision — 발명이 어느 사례에서 나오는지.
 *
 * 분모는 그 사례에서 런타임이 뽑은 개수다. 정답 개수와 같아야 하고, 어긋나면
 * 정답에 없는 요구사항을 만들었다는 뜻이다 — 그 문장을 메시지가 인용한다.
 */
describe("사례별 요구사항 precision", () => {
  for (const holdout of HOLDOUT_CASES) {
    const of = goldCount(holdout);
    // 분모가 0인 사례에서도 이 축만은 주장할 것이 있다(발명이 0이다). 그 주장은
    // 아래 "요구사항이 없는 사례" 로 옮겼고, 여기서는 두 번 찍지 않는다.
    if (of === 0) continue;
    test(`${holdout.id} · 요구사항 precision ${of}/${of}`, () => {
      const one = only(holdout.id);
      assert.deepEqual(
        one.spurious.map((s) => `${s.turnId} "${s.got.sourceText}"`),
        [],
        `${holdout.id}: 정답에 없는 요구사항을 만들었습니다`,
      );
      assert.deepEqual(one.requirementPrecision, full(of));
    });
  }
});

/**
 * 정답에 요구사항이 하나도 없는 사례 — 한 번만 묻는다.
 *
 * gold 가 0이면 recall·대상·근거 span 은 분모가 0이라 무엇을 하든 통과한다.
 * `full(0)` 은 {hit:0, of:0, value:null} 이고, 짝지어진 쌍이 없으니 대상과 근거의
 * 분모도 0이다 — 두 사례에 걸쳐 여섯 개가 전부 항진명제였다. 분모가 0이어도 살아
 * 있는 주장은 하나뿐이고, 그것만 남긴다: 요청이 아닌 말에서 요구사항을 만들지
 * 않았다. 발명이 생기면 precision 의 분모가 0에서 올라가고 `spurious` 가 그
 * 문장을 인용한다.
 */
describe("요구사항이 없는 사례", () => {
  for (const holdout of HOLDOUT_CASES) {
    if (goldCount(holdout) > 0) continue;
    test(`${holdout.id} · 요구사항이 없다 — 발명 0/0`, () => {
      const one = only(holdout.id);
      assert.deepEqual(
        one.spurious.map((s) => `${s.turnId} "${s.got.sourceText}"`),
        [],
        `${holdout.id}: 요청이 아닌 말에서 요구사항을 만들었습니다`,
      );
      assert.deepEqual(
        liveTexts(previewOf(holdout.id)),
        [],
        `${holdout.id}: 살아남은 사용자 요구사항이 있습니다`,
      );
      assert.deepEqual(one.requirementPrecision, full(0));
    });
  }
});

/**
 * 사례별 대상과 근거 구간.
 *
 * 짝지어진 요구사항의 품질이고, 두 축은 따로 실패한다. 대상이 어긋나는 것은
 * 문장이 말한 명사구를 잘못 묶은 것이고, 근거가 어긋나는 것은 맞는 요구사항을
 * 엉뚱한 글자에서 잘라 온 것이다. 한 테스트에 넣으면 앞의 실패가 뒤를 가린다.
 */
describe("사례별 대상·근거", () => {
  for (const holdout of HOLDOUT_CASES) {
    const of = goldCount(holdout);
    // 분모가 0인 사례는 두 축 다 짝지어진 쌍이 없어 무엇을 하든 통과한다. 위의
    // "요구사항이 없는 사례" 가 그 사례들을 대신 맡는다.
    if (of === 0) continue;
    test(`${holdout.id} · 대상 ${of}/${of}`, () => {
      const one = only(holdout.id);
      assert.deepEqual(
        one.targetAccuracy,
        full(of),
        `${holdout.id}: 런타임이 읽은 것 — ${liveTexts(previewOf(holdout.id)).join(" / ")}`,
      );
    });

    test(`${holdout.id} · 근거 span ${of}/${of}`, () => {
      const one = only(holdout.id);
      assert.deepEqual(
        one.spanGrounding,
        full(of),
        `${holdout.id}: 잘라 온 구간 — ${previewOf(holdout.id)
          .requirements.filter((spec) => spec.status !== "system_added")
          .map((spec) => `"${spec.sourceText}"`)
          .join(" / ")}`,
      );
    });
  }
});

/**
 * 사례별 턴 관계.
 *
 * 분모는 그 사례의 턴 수다. 집계 38/38 은 어느 대화에서 관계를 잘못 읽었는지
 * 감추므로, 세 턴짜리 승계 사례와 한 턴짜리 요청을 갈라 둔다.
 */
describe("사례별 턴 관계", () => {
  for (const holdout of HOLDOUT_CASES) {
    const of = holdout.turns.length;
    test(`${holdout.id} · 턴 관계 ${of}/${of}`, () => {
      const one = only(holdout.id);
      assert.equal(one.turns, of, `${holdout.id}: 센 턴 수가 다릅니다`);
      assert.deepEqual(
        one.relationAccuracy,
        full(of),
        `${holdout.id}: 정답 관계 — ${holdout.turns.map((t) => t.relation).join(" / ")}`,
      );
    });
  }
});

/**
 * 사례별로 런타임이 실제로 물은 질문 수. 질문 precision 의 분모다.
 *
 * 다른 축의 분모는 정답에서 세지만 이것만은 정답에 없다. `questionPrecision` 은
 * `ratio(기대에 든 질문, 물은 질문)` 이고 "물은 질문" 은 런타임이 정하기 때문이다.
 * 그래서 `hit === of` 만 보면 2/2 가 조용히 0/0 이 되어도 이 테스트는 통과한다 —
 * 아무것도 묻지 않게 된 회귀가 정확히 그 모양이다. 집계 핀(5/5)이 잡아 주기는 하지만
 * 그 실패는 사례 이름을 갖지 않고, 사례별 층은 바로 그 이름 때문에 있다. 그래서
 * 개수를 여기 못 박아 다른 축과 같은 강도로 만든다. 적히지 않은 사례는 0이다.
 *
 * `h-conflict-same-subject` 만 기대 코드 수(1)와 분모(2)가 다르다. 한
 * `REQUIREMENT_CONFLICT` 기대에 주어가 다른 질문 두 개가 걸리는 사례이고, 이는
 * `questionRecall` 이 기대 코드의 집합 위에서 세는 것과 짝을 이룬다.
 */
const ASKED_QUESTIONS: Readonly<Record<string, number>> = {
  "h-conflict-same-subject": 2,
  "h-conditional-then-act": 1,
  "h-conditional-prohibition": 1,
  "h-omitted-target-execute": 1,
};

/**
 * 사례별 질문 판정.
 *
 * 분모는 그 사례가 기대하는 서로 다른 코드의 수이고, 0 도 답이다 — 아무것도
 * 묻지 않아야 하는 사례에서 하나라도 물으면 `unexpectedQuestions` 가 그 코드와
 * 주어를 이름으로 부른다.
 *
 * precision 의 분모는 정답이 아니라 런타임이 정하므로 `ASKED_QUESTIONS` 에서
 * 가져온다. 그쪽에 이유가 적혀 있다.
 */
describe("사례별 질문", () => {
  for (const holdout of HOLDOUT_CASES) {
    const of = new Set(holdout.questions.expected).size;
    const asked = ASKED_QUESTIONS[holdout.id] ?? 0;
    test(`${holdout.id} · 질문 recall ${of}/${of}, precision ${asked}/${asked}, 상한 ${holdout.questions.max}`, () => {
      const one = only(holdout.id);
      assert.deepEqual(
        one.missingQuestions.map((q) => q.code),
        [],
        `${holdout.id}: 물었어야 할 질문을 묻지 않았습니다`,
      );
      assert.deepEqual(
        one.unexpectedQuestions.map((q) => `${q.code} "${q.subject}"`),
        [],
        `${holdout.id}: 정답에 없는 질문을 물었습니다`,
      );
      assert.deepEqual(one.questionRecall, full(of));
      assert.deepEqual(
        one.questionPrecision,
        full(asked),
        `${holdout.id}: 물은 질문 ${one.questionPrecision.of} 개 중 정답에 든 것이 ` +
          `${one.questionPrecision.hit} 개입니다 (분모는 ${asked} 이어야 합니다)`,
      );
      assert.deepEqual(one.questionCeiling, { hit: 1, of: 1, value: 1 });
    });
  }

  // 표의 키가 사라진 사례를 가리키면(오타를 포함해) 그 사례의 분모는 조용히 0이
  // 되고, 질문을 묻지 않게 된 회귀가 통과한다. HOLDOUT_GAPS 와 같은 검사다.
  test("ASKED_QUESTIONS 의 키는 실재하는 사례를 가리킨다", () => {
    const ids = new Set(HOLDOUT_CASES.map((c) => c.id));
    assert.deepEqual(
      Object.keys(ASKED_QUESTIONS).filter((id) => !ids.has(id)),
      [],
      "없는 사례에 분모가 적혀 있습니다",
    );
  });
});

/**
 * 사례별 착수와 실행.
 *
 * 두 축은 다른 주장이고 여기서도 갈라 둔다. 착수는 "문장을 알아들었는가", 실행은
 * "검증 규칙까지 갖춰 돌릴 수 있는가" 다. 하나로 묶으면 규칙이 빠진 것이 문장을
 * 못 읽은 것처럼 보인다.
 */
describe("사례별 착수·실행", () => {
  for (const holdout of HOLDOUT_CASES) {
    test(`${holdout.id} · 착수(startable=${holdout.startable})`, () => {
      const one = only(holdout.id);
      assert.deepEqual(
        one.requirementStartability,
        { hit: 1, of: 1, value: 1 },
        `${holdout.id}: 정답은 startable=${holdout.startable} 인데 판정이 다릅니다 — ` +
          liveTexts(previewOf(holdout.id)).join(" / "),
      );
    });

    test(`${holdout.id} · 실행(executable=${holdout.executable})`, () => {
      const one = only(holdout.id);
      assert.deepEqual(
        one.harnessExecutability,
        { hit: 1, of: 1, value: 1 },
        `${holdout.id}: 정답은 executable=${holdout.executable} 인데 엔진은 ` +
          `${previewOf(holdout.id).executable} 라고 합니다`,
      );
    });
  }
});

describe("Holdout 질문·실행 판정", () => {
  test("질문 recall 4/4, precision 5/5", () => {
    assert.deepEqual(score.questionRecall, { hit: 4, of: 4, value: 1 });
    assert.deepEqual(score.questionPrecision, { hit: 5, of: 5, value: 1 });
    assert.deepEqual(score.questionCeiling, { hit: 33, of: 33, value: 1 });
  });

  test("Requirement Startability 33/33, Harness Executability 33/33", () => {
    // Both were 32/33, and the one short of each was the English request the
    // extractor could not read: with no requirement there was nothing to start.
    assert.deepEqual(score.requirementStartability, { hit: 33, of: 33, value: 1 });
    assert.deepEqual(score.harnessExecutability, { hit: 33, of: 33, value: 1 });
  });

  test("사용자 요구사항이 없는데 Executable 인 사례는 0건이다", () => {
    assert.deepEqual(score.cross.executableWithoutUserRequirement, []);
    assert.deepEqual(score.cross.startableNotExecutable, []);
    assert.deepEqual(score.cross.executableNotStartable, []);
  });
});

/**
 * 여러 턴에 걸친 요구사항 승계.
 *
 * 정답은 요구사항의 *텍스트* 로 적혀 있다. 승계란 정정과 다듬기와 질문과 계속
 * 턴을 지나 무엇이 남는가에 대한 것이고, 남아야 하는 문장 하나하나가 따로 실패할
 * 수 있어야 어느 요구사항이 사라졌는지 이름으로 보인다.
 */
describe("여러 턴에 걸친 요구사항 승계", () => {
  for (const holdout of HOLDOUT_CASES) {
    for (const text of holdout.extras?.standing ?? []) {
      test(`${holdout.id} · 승계 "${text}"`, () => {
        const live = liveTexts(previewOf(holdout.id));
        assert.ok(live.includes(text), `${holdout.id}: "${text}" 가 사라졌습니다 (${live.join(" / ")})`);
      });
    }
  }

  // The correction case, checked from the other side: the re-run request must not
  // still be standing next to the prohibition that replaced it.
  test("h-correction-supersedes-one · 정정된 요구사항은 supersede 된다", () => {
    const live = liveTexts(previewOf("h-correction-supersedes-one"));
    assert.ok(!live.some((text) => text.includes("서버를 실행")), live.join(" / "));
    assert.ok(live.includes("이번 요청에서 명령을 실행하지 않는다"), live.join(" / "));
  });

  for (const id of ["h-question-changes-nothing", "h-continue-changes-nothing"]) {
    test(`${id} · 질문·계속 턴은 요구사항을 바꾸지 않는다`, () => {
      const own = liveTexts(previewOf(id));
      assert.equal(own.length, 1, `${id}: ${own.join(" / ")}`);
    });
  }
});

describe("priority 와 kind", () => {
  /** The spec a quote belongs to, found by the runtime's own cut. */
  function specFor(preview: PreviewResult, quote: string) {
    return preview.requirements.find(
      (spec) => spec.status !== "system_added" && spec.sourceText.includes(quote),
    );
  }

  for (const holdout of HOLDOUT_CASES) {
    for (const want of holdout.extras?.priorities ?? []) {
      test(`${holdout.id} · 우선순위 ${want.priority} — "${want.quote}"`, () => {
        const spec = specFor(previewOf(holdout.id), want.quote);
        assert.ok(spec !== undefined, `${holdout.id}: "${want.quote}" 의 요구사항을 찾지 못했습니다`);
        assert.equal(spec.priority, want.priority, `${holdout.id}: "${want.quote}"`);
      });
    }
  }

  for (const holdout of HOLDOUT_CASES) {
    for (const want of holdout.extras?.kinds ?? []) {
      test(`${holdout.id} · 분류 ${want.kind} — "${want.quote}"`, () => {
        const spec = specFor(previewOf(holdout.id), want.quote);
        assert.ok(spec !== undefined, `${holdout.id}: "${want.quote}" 의 요구사항을 찾지 못했습니다`);
        assert.equal(spec.kind, want.kind, `${holdout.id}: "${want.quote}"`);
      });
    }
  }

  // Containing the right words is not enough: a span covering three sentences
  // technically contains them and points a user at the wrong place.
  for (const holdout of HOLDOUT_CASES) {
    for (const want of holdout.extras?.minimalSpan ?? []) {
      test(`${holdout.id} · 최소 span ${want.maxLength}자 이하 — "${want.quote}"`, () => {
        const spec = specFor(previewOf(holdout.id), want.quote);
        assert.ok(spec !== undefined, `${holdout.id}: "${want.quote}" 의 요구사항을 찾지 못했습니다`);
        assert.ok(
          spec.sourceText.length <= want.maxLength,
          `${holdout.id}: "${want.quote}" 의 근거가 ${spec.sourceText.length}자입니다 — "${spec.sourceText}"`,
        );
      });
    }
  }
});

/**
 * 모델 제안 경로 — 주입된 문자열만 사용한다.
 *
 * 정직한 제안은 받아들여지고, 발명·위조는 거부된다. 사례마다 둘을 따로 묻는다:
 * 몇 개가 살아남았는가, 그리고 거부된 것들이 *어떤 이유로* 거부됐는가. 개수만
 * 맞고 이유가 다르면 우연히 같은 숫자가 나온 것이므로 한 테스트로 묶지 않는다.
 */
describe("모델 제안 경로 — 주입된 문자열만 사용한다", () => {
  for (const holdout of HOLDOUT_CASES) {
    const answer = holdout.extras?.modelAnswer;
    if (answer === undefined) continue;

    test(`${holdout.id} · 수락 개수 ${answer.accepted}`, () => {
      const run = proposalOf(holdout.id);
      const accepted = run.proposals.perTurn.reduce((sum, turn) => sum + turn.accepted, 0);
      assert.equal(accepted, answer.accepted, `${holdout.id}: 수락 개수`);
    });

    test(`${holdout.id} · 거부 사유 [${[...answer.rejectedReasons].sort().join(", ")}]`, () => {
      const run = proposalOf(holdout.id);
      assert.deepEqual(
        [...new Set(run.rejected.flatMap((r) => r.reasons))].sort(),
        [...answer.rejectedReasons].sort(),
        `${holdout.id}: 거부 사유`,
      );
    });
  }

  test("h-model-honest-proposal · 사례와 그 답이 있다", () => {
    const holdout = HOLDOUT_CASES.find((c) => c.id === "h-model-honest-proposal");
    assert.ok(holdout !== undefined);
    assert.ok(holdout.extras?.modelAnswer !== undefined, "정직한 제안의 답이 없습니다");
  });

  test("h-model-honest-proposal · 모델이 만든 요구사항은 1건이다", () => {
    const specs = proposalOf("h-model-honest-proposal").requirements.filter(
      (spec) => spec.derivedBy === "model_proposal",
    );
    assert.equal(specs.length, 1);
  });

  test("h-model-honest-proposal · intent — 모델 제안은 확정으로 승격되지 않는다", () => {
    const specs = proposalOf("h-model-honest-proposal").requirements.filter(
      (spec) => spec.derivedBy === "model_proposal",
    );
    assert.equal(specs[0]?.intent, "ambiguous", "모델 제안이 confirmed 로 올라갔습니다");
  });

  test("h-model-honest-proposal · provenance 는 verified 다", () => {
    const specs = proposalOf("h-model-honest-proposal").requirements.filter(
      (spec) => spec.derivedBy === "model_proposal",
    );
    assert.equal(specs[0]?.provenance, "verified");
  });

  // Structural, and read from the *import list* rather than the whole file: a
  // test that greps its own body for forbidden names finds the names it is
  // grepping for. What matters is what this file can reach, and the only
  // proposer it builds is `injected`, declared at the top of this file next to
  // the score maps, which returns a fixture string.
  for (const forbidden of ["provider", "hasa-client", "modelProposer", "previewCli", "node:http"]) {
    test(`import 금지 · ${forbidden} — 실제 모델을 호출할 경로가 없다`, async () => {
      const source = await readFile(new URL("./holdoutCases.test.ts", import.meta.url), "utf8");
      const modules = source
        .split("\n")
        .map((line) => line.replace(/\r$/, "").trim())
        .filter((line) => line.startsWith("import ") || line.startsWith("} from"))
        .join(" ");
      assert.ok(!modules.includes(forbidden), `${forbidden} 을 import 합니다`);
    });
  }
});

/**
 * What the holdout found and this pass did not close, with a reason.
 *
 * One entry now. The English gap that used to sit here was closed rather than
 * carried: `functionalExtract` grew a separate English pass — its own verb list,
 * the object taken on the other side of the verb, and an imperative-position
 * check so a report ("The previous run did not use web search") and a question
 * ("Why did the build fail?") are not read as instructions. Precision stayed at
 * 1 through the change, which was the condition for making it at all.
 *
 * The entry left is a different shape of problem, and it is still open.
 */
export const HOLDOUT_GAPS: readonly { caseId: string; axis: string; reason: string }[] = [
  {
    caseId: "h-correction-supersedes-one",
    axis: "verb coverage",
    reason:
      "'변경만 해줘' 의 `변경` 은 추출기 동사 목록에 없다. 추가하면 대상 없는 modify 가 생기고, " +
      "앞 턴에서 이미 대상을 말한 사용자에게 대상을 다시 묻게 된다. 턴 간 대상 승계 설계가 먼저 필요하다.",
  },
];

describe("남은 격차는 이름을 갖는다", () => {
  test("놓친 사례는 HOLDOUT_GAPS 에 기록돼 있다", () => {
    const named = new Set(HOLDOUT_GAPS.map((g) => g.caseId));
    for (const miss of score.missed) {
      assert.ok(named.has(miss.caseId), `${miss.caseId} 가 기록되지 않았습니다`);
    }
  });

  for (const gap of HOLDOUT_GAPS) {
    test(`${gap.caseId} · 격차(${gap.axis})에 이유가 적혀 있다`, () => {
      assert.ok(gap.reason.length > 40, `${gap.caseId}: 이유가 너무 짧습니다`);
    });

    test(`${gap.caseId} · 격차(${gap.axis})는 실재하는 사례를 가리킨다`, () => {
      assert.ok(HOLDOUT_CASES.some((c) => c.id === gap.caseId), `${gap.caseId}: 없는 사례입니다`);
    });
  }
});
