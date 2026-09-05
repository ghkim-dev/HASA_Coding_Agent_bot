import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  evidenceFrom,
  indistinguishable,
  starvedAt,
  type ProposerEvidence,
} from "./proposerEvidence.ts";
import { MIN_SAMPLES_FOR_EVIDENCE } from "../router/modelRegistry.ts";
import { CAPABILITY_KEYS } from "../router/taskProfile.ts";
import type { CaseOutcome, ProposerMeasurement, ProposerScore } from "./proposerMetrics.ts";
import { scoreProposer } from "./proposerMetrics.ts";

/**
 * The bridge, scored against measurements written here.
 *
 * Every sweep this repo runs is a fact about one day and one gateway; a test
 * built on `.probe/*.json` would go red when the models changed and green when
 * a bug happened to cancel out. So the inputs below are constructed, and each
 * expectation is argued before the code sees it.
 */

const outcome = (over: Partial<CaseOutcome> = {}): CaseOutcome => ({
  turnId: "t1",
  parse: "parsed_candidate",
  accepted: 1,
  rejected: 0,
  named: 1,
  pointed: 0,
  invented: 0,
  transcribed: 0,
  ...over,
});

/** A model's sweep result, built from the same function the sweep uses. */
function scoreFor(input: {
  modelId: string;
  cases: number;
  wants: number;
  named: number;
  invented: number;
  proposals: number;
  shapeOk: number;
  truncated?: number;
}): ProposerScore {
  const outcomes: CaseOutcome[] = [];
  let namedLeft = input.named;
  let inventedLeft = input.invented;
  let proposalsLeft = input.proposals;
  for (let i = 0; i < input.cases; i += 1) {
    const takeNamed = Math.min(namedLeft, 2);
    const takeInvented = Math.min(inventedLeft, 2);
    const takeProposals = Math.min(proposalsLeft, 3);
    namedLeft -= takeNamed;
    inventedLeft -= takeInvented;
    proposalsLeft -= takeProposals;
    outcomes.push(
      outcome({
        parse: i < input.shapeOk ? "parsed_candidate" : "no_json_array",
        named: takeNamed,
        invented: takeInvented,
        accepted: takeProposals,
        rejected: 0,
      }),
    );
  }
  return scoreProposer({
    modelId: input.modelId,
    outcomes,
    wantsTotal: input.wants,
    unanswered: 0,
    truncated: input.truncated ?? 0,
  });
}

const measurement = (maxTokens: number, scores: readonly ProposerScore[]): ProposerMeasurement => ({
  prompt: "SYSTEM",
  takenAt: 0,
  baseUrl: "https://example.invalid/v1",
  cases: 10,
  wants: 16,
  maxTokens,
  scores,
});

/** A model that answers well at 6000 and produces nothing at 800. */
const starvedHigh = scoreFor({
  modelId: "reasoner",
  cases: 10,
  wants: 16,
  named: 16,
  invented: 4,
  proposals: 20,
  shapeOk: 9,
});
const starvedLow = scoreProposer({
  modelId: "reasoner",
  outcomes: Array.from({ length: 10 }, () => outcome({ parse: "empty_response", accepted: 0, named: 0 })),
  wantsTotal: 16,
  unanswered: 0,
  truncated: 10,
});

/** A model that answers at both budgets. */
const steadyHigh = scoreFor({
  modelId: "steady",
  cases: 10,
  wants: 16,
  named: 14,
  invented: 2,
  proposals: 15,
  shapeOk: 9,
});
const steadyLow = scoreFor({
  modelId: "steady",
  cases: 10,
  wants: 16,
  named: 14,
  invented: 2,
  proposals: 15,
  shapeOk: 9,
});

const bothBudgets = (): readonly ProposerEvidence[] =>
  evidenceFrom([
    measurement(800, [starvedLow, steadyLow]),
    measurement(6000, [starvedHigh, steadyHigh]),
  ]);

describe("evidenceFrom — 잰 것만 주장한다", () => {
  it("실측이 하나도 없으면 조용히 비지 않고 거부한다", () => {
    assert.throws(() => evidenceFrom([]), /실측이 하나도 없습니다/);
  });

  it("열두 축 중 잰 둘만 채우고 나머지는 비운다", () => {
    const [first] = bothBudgets();
    assert.ok(first !== undefined);
    const filled = Object.keys(first.capabilities);
    assert.deepEqual(new Set(filled), new Set(["sourceGrounding", "instructionFollowing"]));
    // 나머지 열은 0 이 아니라 없어야 한다 — 라우터는 없음을 '모름' 으로 읽는다.
    for (const key of CAPABILITY_KEYS) {
      if (key === "sourceGrounding" || key === "instructionFollowing") continue;
      assert.equal(first.capabilities[key], undefined, `${key} 를 지어냈다`);
    }
  });

  it("표본이 문턱을 넘으면 harness_eval, 못 넘으면 declared 로 남는다", () => {
    const many = bothBudgets()[0];
    assert.ok(many !== undefined);
    assert.equal(many.capabilities.sourceGrounding?.origin, "harness_eval");
    assert.equal(many.capabilities.sourceGrounding?.samples, 10);

    const few = scoreFor({
      modelId: "anecdote",
      cases: MIN_SAMPLES_FOR_EVIDENCE - 1,
      wants: 4,
      named: 3,
      invented: 0,
      proposals: 3,
      shapeOk: MIN_SAMPLES_FOR_EVIDENCE - 1,
    });
    const [thin] = evidenceFrom([measurement(6000, [few])]);
    assert.ok(thin !== undefined);
    assert.equal(
      thin.capabilities.sourceGrounding?.origin,
      "declared",
      "한두 번 돌린 값이 백 번 잰 값을 이기면 안 된다",
    );
  });

  it("능력은 가장 큰 예산에서 읽는다 — 굶긴 예산의 수는 모델이 아니라 예산에 대한 것이다", () => {
    const [reasoner] = bothBudgets();
    assert.ok(reasoner !== undefined);
    assert.equal(reasoner.modelId, "reasoner");
    // 800 에서는 아무것도 못 냈지만 능력은 6000 쪽에서 온다.
    assert.ok((reasoner.capabilities.sourceGrounding?.value ?? 0) > 0.5);
  });
});

describe("근거 점수는 재현이 아니라 재현과 정밀의 조화평균이다", () => {
  it("전부 찾지만 절반을 지어내는 모델이, 고르게 잘하는 모델을 이기지 않는다", () => {
    // 재현만 보면 16/16 이 14/16 을 이긴다. 지어냄까지 보면 그러면 안 된다.
    const sloppy = scoreFor({
      modelId: "sloppy",
      cases: 10, wants: 16, named: 16, invented: 10, proposals: 20, shapeOk: 10,
    });
    const balanced = scoreFor({
      modelId: "balanced",
      cases: 10, wants: 16, named: 14, invented: 1, proposals: 15, shapeOk: 10,
    });
    const ev = evidenceFrom([measurement(6000, [sloppy, balanced])]);
    const value = (id: string): number =>
      ev.find((e) => e.modelId === id)?.capabilities.sourceGrounding?.value ?? 0;
    assert.ok(
      value("balanced") > value("sloppy"),
      `균형 ${value("balanced")} 이 남발 ${value("sloppy")} 보다 높아야 한다`,
    );
  });

  it("후보를 하나도 내지 않은 모델에는 근거 점수를 주지 않는다", () => {
    const silent = scoreProposer({
      modelId: "silent",
      outcomes: [outcome({ parse: "empty_array", accepted: 0, named: 0, invented: 0 })],
      wantsTotal: 16,
      unanswered: 0,
    });
    const [ev] = evidenceFrom([measurement(6000, [silent])]);
    assert.ok(ev !== undefined);
    assert.equal(
      ev.capabilities.sourceGrounding,
      undefined,
      "침묵에 점수를 매기면 그것은 측정이 아니라 발명이다",
    );
  });

  it("형식 점수에 옮겨적음을 섞지 않는다", () => {
    // 같은 형식 성공률에 옮겨적음만 다른 두 모델은 instructionFollowing 이 같아야
    // 한다. 섞으면 프롬프트가 유발한 행동으로 모델 능력을 깎게 된다.
    const copier = scoreFor({ modelId: "copier", cases: 10, wants: 16, named: 8, invented: 0, proposals: 10, shapeOk: 7 });
    const original = scoreFor({ modelId: "original", cases: 10, wants: 16, named: 8, invented: 0, proposals: 10, shapeOk: 7 });
    const withCopying: ProposerScore = { ...copier, transcribed: { hit: 9, of: 10, value: 0.9 } };
    const ev = evidenceFrom([measurement(6000, [withCopying, original])]);
    const value = (id: string): number | undefined =>
      ev.find((e) => e.modelId === id)?.capabilities.instructionFollowing?.value;
    assert.equal(value("copier"), value("original"));
  });
});

describe("예산 바닥", () => {
  it("답을 낸 가장 작은 예산을 바닥으로 잡는다", () => {
    const steady = bothBudgets().find((e) => e.modelId === "steady");
    assert.ok(steady !== undefined);
    assert.equal(steady.budget.tokens, 800);
  });

  it("작은 예산에서 아무것도 못 내면 바닥은 더 큰 쪽이다", () => {
    const reasoner = bothBudgets().find((e) => e.modelId === "reasoner");
    assert.ok(reasoner !== undefined);
    assert.equal(reasoner.budget.tokens, 6000);
  });

  it("어느 예산에서도 못 내면 null 이고, 무엇에 대해 잰 null 인지 남긴다", () => {
    const dead = scoreProposer({
      modelId: "dead",
      outcomes: Array.from({ length: 10 }, () => outcome({ parse: "empty_response", accepted: 0, named: 0 })),
      wantsTotal: 16,
      unanswered: 0,
      truncated: 10,
    });
    const [ev] = evidenceFrom([measurement(800, [dead]), measurement(6000, [dead])]);
    assert.ok(ev !== undefined);
    assert.equal(ev.budget.tokens, null);
    assert.deepEqual(
      ev.budget.measured,
      [800, 6000],
      "무엇에 대해 잰 null 인지 없으면 'null' 은 아무 뜻도 없다",
    );
  });

  it("답을 낸 모델에도 잰 예산 목록을 남긴다", () => {
    // 처음에는 답을 못 낸 모델에 대해서만 이걸 못 박아 두었고, 그래서 답을 낸
    // 쪽 경로에서 목록을 통째로 비우는 변이가 물리지 않았다. 바닥이 800 이라는
    // 말은 6000 도 같이 재 봤을 때만 뜻이 있다 — 800 하나만 재고도 같은 문장을
    // 쓸 수 있으니, 무엇에 대해 잰 바닥인지가 바닥만큼 중요하다.
    const steady = bothBudgets().find((e) => e.modelId === "steady");
    assert.ok(steady !== undefined);
    assert.equal(steady.budget.tokens, 800);
    assert.deepEqual(steady.budget.measured, [800, 6000]);
  });

  it("바닥에서 잘린 답의 수를 남긴다 — 남은 위험이지 실패가 아니다", () => {
    const edgy = scoreFor({ modelId: "edgy", cases: 10, wants: 16, named: 8, invented: 0, proposals: 10, shapeOk: 6, truncated: 4 });
    const [ev] = evidenceFrom([measurement(6000, [edgy])]);
    assert.ok(ev !== undefined);
    assert.equal(ev.budget.truncatedAtFloor, 4);
  });
});

describe("starvedAt — 하네스 예산이 후보를 지운다", () => {
  it("예산이 바닥보다 낮은 모델을 지목한다", () => {
    const starved = starvedAt(800, bothBudgets());
    assert.deepEqual(starved.map((s) => s.modelId), ["reasoner"]);
    assert.equal(starved[0]?.needs, 6000);
  });

  it("예산이 넉넉하면 아무도 지우지 않는다", () => {
    assert.equal(starvedAt(6000, bothBudgets()).length, 0);
  });

  it("어느 예산에서도 못 낸 모델은 어떤 예산에서도 지워진다", () => {
    const dead = scoreProposer({
      modelId: "dead",
      outcomes: Array.from({ length: 10 }, () => outcome({ parse: "empty_response", accepted: 0, named: 0 })),
      wantsTotal: 16,
      unanswered: 0,
    });
    const ev = evidenceFrom([measurement(6000, [dead])]);
    assert.equal(starvedAt(1_000_000, ev).length, 1, "잰 결과 아무것도 못 냈다면 그것은 측정이다");
  });
});

describe("indistinguishable — 말뭉치가 못 가르는 것을 가른 척하지 않는다", () => {
  it("표준오차 안의 후보를 모두 돌려준다", () => {
    const a = scoreFor({ modelId: "a", cases: 10, wants: 16, named: 14, invented: 2, proposals: 15, shapeOk: 9 });
    const b = scoreFor({ modelId: "b", cases: 10, wants: 16, named: 13, invented: 2, proposals: 14, shapeOk: 9 });
    const far = scoreFor({ modelId: "far", cases: 10, wants: 16, named: 2, invented: 8, proposals: 10, shapeOk: 3 });
    const ev = evidenceFrom([measurement(6000, [a, b, far])]);
    const tied = indistinguishable(ev).map((e) => e.modelId);
    assert.ok(tied.includes("a") && tied.includes("b"), "한 요구 차이는 이 표본이 가를 수 없다");
    assert.ok(!tied.includes("far"), "확실히 뒤진 후보까지 묶으면 아무 말도 안 하는 것이다");
  });

  it("정말로 갈릴 때는 하나만 돌려준다 — 빈 목록으로 얼버무리지 않는다", () => {
    const best = scoreFor({ modelId: "best", cases: 10, wants: 16, named: 16, invented: 0, proposals: 16, shapeOk: 10 });
    const worst = scoreFor({ modelId: "worst", cases: 10, wants: 16, named: 1, invented: 9, proposals: 10, shapeOk: 2 });
    const tied = indistinguishable(evidenceFrom([measurement(6000, [best, worst])]));
    assert.deepEqual(tied.map((e) => e.modelId), ["best"]);
  });

  it("점수가 없는 후보는 묶음에 들어가지 않는다", () => {
    const silent = scoreProposer({
      modelId: "silent",
      outcomes: [outcome({ parse: "empty_array", accepted: 0, named: 0, invented: 0 })],
      wantsTotal: 16,
      unanswered: 0,
    });
    const good = scoreFor({ modelId: "good", cases: 10, wants: 16, named: 14, invented: 2, proposals: 15, shapeOk: 9 });
    const tied = indistinguishable(evidenceFrom([measurement(6000, [silent, good])]));
    assert.deepEqual(tied.map((e) => e.modelId), ["good"]);
  });

  it("표본이 문턱과 정확히 같으면 harness_eval 이다 — 경계는 포함이다", () => {
    // 자동 변이 감사가 찾았다. `samples >= MIN_SAMPLES_FOR_EVIDENCE` 를 `>` 로
    // 바꿔도 통과했는데, 표본이 문턱과 정확히 같은 사례가 없었기 때문이다.
    const exact = scoreFor({
      modelId: "boundary",
      cases: MIN_SAMPLES_FOR_EVIDENCE,
      wants: 4,
      named: 3,
      invented: 0,
      proposals: 3,
      shapeOk: MIN_SAMPLES_FOR_EVIDENCE,
    });
    const [ev] = evidenceFrom([measurement(6000, [exact])]);
    assert.equal(ev?.capabilities.sourceGrounding?.samples, MIN_SAMPLES_FOR_EVIDENCE);
    assert.equal(ev?.capabilities.sourceGrounding?.origin, "harness_eval");
  });

  it("분모가 0 이면 해상도는 가장 넓다 — 모르는 정밀도는 정밀도 없음이다", () => {
    // `value === null || denominator <= 0` 의 두 갈래 모두 시험이 없었다.
    // 요구가 0건인 말뭉치는 분모가 0 이고, 그때 좁은 해상도를 주면 아무 근거
    // 없이 순위를 가를 수 있게 된다.
    const noWants = scoreFor({
      modelId: "empty",
      cases: 4, wants: 0, named: 0, invented: 0, proposals: 4, shapeOk: 4,
    });
    const [ev] = evidenceFrom([measurement(6000, [noWants])]);
    assert.equal(ev?.resolution, 1);
  });

  it("해상도는 표본이 커질수록 좁아진다", () => {
    const small = scoreFor({ modelId: "small", cases: 4, wants: 4, named: 3, invented: 1, proposals: 4, shapeOk: 4 });
    const large = scoreFor({ modelId: "large", cases: 10, wants: 64, named: 48, invented: 16, proposals: 64, shapeOk: 10 });
    const ev = evidenceFrom([measurement(6000, [small, large])]);
    const res = (id: string): number => ev.find((e) => e.modelId === id)?.resolution ?? 0;
    assert.ok(res("small") > res("large"), "작은 말뭉치가 더 좁게 가른다고 말하면 안 된다");
  });
});
