import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  nearest,
  outcomeOf,
  recordTurn,
  remember,
  revise,
  verdictFor,
  type RememberedRequirement,
} from "./requirementMemory.ts";
import { spaceKey, type EmbeddingSpaceIdentity } from "../router/embedding.ts";
import type { RequirementSpec } from "./requirementSpec.ts";

/**
 * The memory, scored against rows written here.
 *
 * Nothing below reads a live embedding. A vector is three numbers chosen so the
 * expected neighbour is obvious by inspection — a test whose expectation
 * depends on what `bge-m3` happened to produce is a test of `bge-m3`.
 */

const SPACE: EmbeddingSpaceIdentity = { provider: "hasa", modelId: "bge-m3", dimension: 3 };
const OTHER_SPACE: EmbeddingSpaceIdentity = {
  provider: "hasa",
  modelId: "nemotron-embed-8b",
  dimension: 3,
};

const spec = (over: Partial<RequirementSpec> & { id: string }): RequirementSpec => ({
  text: "아키텍처를 분석한다",
  sourceText: "시스템 아키텍처를 분석해",
  sourceTurnId: "t1",
  kind: "functional",
  priority: "must",
  polarity: "required",
  status: "explicit",
  provenance: "verified",
  intent: "confirmed",
  binding: "resolved",
  dependencies: [],
  conflicts: [],
  derivedBy: "model_proposal",
  ...over,
});

const row = (over: Partial<RememberedRequirement> & { id: string }): RememberedRequirement => ({
  turnId: "t1",
  sourceText: "시스템 아키텍처를 분석해",
  proposedBy: "llama-3.3-70b",
  budget: 6000,
  outcome: "accepted",
  vector: [1, 0, 0],
  space: spaceKey(SPACE),
  at: 0,
  ...over,
});

describe("outcomeOf — 결과는 물어보는 게 아니라 이미 기록된 것에서 읽는다", () => {
  it("사용자가 뒤집었으면 superseded 다", () => {
    assert.equal(outcomeOf(spec({ id: "r1", supersededBy: "t2" })), "superseded");
  });

  it("런타임이 좌표를 거부했으면 rejected 다", () => {
    assert.equal(outcomeOf(spec({ id: "r1", provenance: "invalid" })), "rejected");
  });

  it("정정도 거부도 없으면 accepted 다", () => {
    assert.equal(outcomeOf(spec({ id: "r1" })), "accepted");
  });

  it("정정이 거부보다 앞선다 — 런타임이 놓친 것을 사용자가 잡은 쪽이 더 나쁘다", () => {
    const both = spec({ id: "r1", supersededBy: "t2", provenance: "invalid" });
    assert.equal(outcomeOf(both), "superseded");
  });
});

describe("remember", () => {
  it("하네스가 스스로 붙인 요구는 담지 않는다", () => {
    const rows = remember({
      sessionId: "s1",
      specs: [spec({ id: "r1" }), spec({ id: "r2", status: "system_added" })],
      proposedBy: null,
      budget: null,
      at: 0,
    });
    assert.deepEqual(rows.map((r) => r.id), ["s1/r1"]);
  });

  it("다른 세션의 같은 요구는 다른 행이다", () => {
    // 이 시험은 실제로 돌려 보고서야 필요한 줄 알았다. 턴 아이디는 프로세스마다
    // t1 부터 다시 시작하므로, 세션 접두사가 없으면 서로 다른 세 요청이 모두
    // `t1-act-create-1` 이 되어 한 행으로 덮어써진다. 기억이 들은 것의 3분의 1만
    // 갖고 있었고, 단위 시험은 전부 통과하고 있었다.
    const one = remember({ sessionId: "세션A", specs: [spec({ id: "t1-act-create-1" })], proposedBy: null, budget: null, at: 0 });
    const two = remember({ sessionId: "세션B", specs: [spec({ id: "t1-act-create-1" })], proposedBy: null, budget: null, at: 1 });
    assert.notEqual(one[0]?.id, two[0]?.id);
  });

  it("같은 세션의 같은 요구는 같은 행이다 — 다시 기록해도 합쳐져야 한다", () => {
    const first = remember({ sessionId: "세션A", specs: [spec({ id: "r1" })], proposedBy: null, budget: null, at: 0 });
    const again = remember({ sessionId: "세션A", specs: [spec({ id: "r1" })], proposedBy: null, budget: null, at: 9 });
    assert.equal(first[0]?.id, again[0]?.id);
  });

  it("모델의 문장이 아니라 런타임이 자른 말을 담는다", () => {
    const [only] = remember({
      sessionId: "s1",
      specs: [spec({ id: "r1", text: "모델이 지어낸 문장", sourceText: "사용자가 쓴 말" })],
      proposedBy: "m",
      budget: 800,
      at: 0,
    });
    assert.ok(only !== undefined);
    assert.equal(only.sourceText, "사용자가 쓴 말");
    assert.equal(
      JSON.stringify(only).includes("모델이 지어낸 문장"),
      false,
      "기억은 세션보다 오래 남는다 — 모델 문장을 담으면 안 된다",
    );
  });

  it("누가 어떤 예산으로 냈는지 함께 담는다", () => {
    const [only] = remember({
      sessionId: "s1",
      specs: [spec({ id: "r1" })],
      proposedBy: "glm-4.7-flash",
      budget: 800,
      at: 7,
    });
    assert.ok(only !== undefined);
    assert.equal(only.proposedBy, "glm-4.7-flash");
    assert.equal(only.budget, 800);
    assert.equal(only.at, 7);
  });

  it("벡터는 공간과 함께일 때만 담는다", () => {
    const withoutSpace = remember({
      sessionId: "s1",
      specs: [spec({ id: "r1" })],
      proposedBy: null,
      budget: null,
      at: 0,
      vectors: new Map([["r1", [1, 0, 0]]]),
    });
    assert.equal(withoutSpace[0]?.vector, undefined, "공간 없는 벡터는 쓸 수 없다");
    assert.equal(withoutSpace[0]?.space, undefined);

    const withSpace = remember({
      sessionId: "s1",
      specs: [spec({ id: "r1" })],
      proposedBy: null,
      budget: null,
      at: 0,
      vectors: new Map([["r1", [1, 0, 0]]]),
      space: SPACE,
    });
    assert.deepEqual(withSpace[0]?.vector, [1, 0, 0]);
    assert.equal(withSpace[0]?.space, spaceKey(SPACE));
  });

  it("읽어낸 행위와 대상을 행에 담는다", () => {
    // 자동 변이 감사가 찾은 구멍. `spec.act === undefined ? {} : {act}` 를
    // `!==` 로 뒤집어도 전체 스위트가 통과했다 — 행이 행위와 대상을 나른다는
    // 것을 아무 시험도 주장하지 않았다. 이웃의 결과를 모델 증거로 읽으려면
    // 그 둘이 있어야 한다.
    const [only] = remember({
      sessionId: "s1",
      specs: [spec({ id: "r1", act: "inspect", target: "시스템 아키텍처" })],
      proposedBy: null,
      budget: null,
      at: 0,
    });
    assert.equal(only?.act, "inspect");
    assert.equal(only?.target, "시스템 아키텍처");
  });

  it("문장이 대상을 대지 않았으면 대상 칸이 없다 — undefined 를 값으로 담지 않는다", () => {
    const [only] = remember({
      sessionId: "s1",
      specs: [spec({ id: "r1", act: "inspect" })],
      proposedBy: null,
      budget: null,
      at: 0,
    });
    assert.equal("target" in (only ?? {}), false);
  });

  it("임베딩이 없어도 행은 남는다 — 못 잰 것이 없던 일은 아니다", () => {
    const rows = remember({
      sessionId: "s1",
      specs: [spec({ id: "r1" })],
      proposedBy: null,
      budget: null,
      at: 0,
      space: SPACE,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.vector, undefined);
  });
});

describe("recordTurn", () => {
  // 이 함수에는 시험이 하나도 없었다. 자동 변이가 벡터·공간 전달을 통째로
  // 끊어도 전체 스위트가 통과해서 드러났다 — 쓴 사람이 시험을 잊은 자리다.
  it("벡터와 공간을 그대로 넘긴다", () => {
    const record = recordTurn({
      requirements: [spec({ id: "r1" })],
      sessionId: "s1",
      refusedProposals: 0,
      proposedBy: "m",
      budget: 800,
      at: 0,
      vectors: new Map([["r1", [1, 0, 0]]]),
      space: SPACE,
    });
    assert.deepEqual(record.rows[0]?.vector, [1, 0, 0]);
    assert.equal(record.rows[0]?.space, spaceKey(SPACE));
  });

  it("거부된 제안 수를 그대로 들고 나온다 — 기록 못 한 것을 숨기지 않는다", () => {
    const record = recordTurn({
      requirements: [],
      sessionId: "s1",
      refusedProposals: 3,
      proposedBy: "m",
      budget: 800,
      at: 0,
    });
    assert.equal(record.refusedProposals, 3);
    assert.equal(record.rows.length, 0);
  });

  it("벡터를 주지 않으면 행에도 벡터가 없다", () => {
    const record = recordTurn({
      requirements: [spec({ id: "r1" })],
      sessionId: "s1",
      refusedProposals: 0,
      proposedBy: null,
      budget: null,
      at: 0,
    });
    assert.equal(record.rows[0]?.vector, undefined);
    assert.equal(record.rows[0]?.space, undefined);
  });
});

describe("revise — 정정은 되돌아가지 않는다", () => {
  it("나쁜 쪽으로는 바뀐다", () => {
    assert.equal(revise(row({ id: "r1" }), "superseded").outcome, "superseded");
  });

  it("좋은 쪽으로는 바뀌지 않는다", () => {
    const corrected = row({ id: "r1", outcome: "superseded" });
    assert.equal(
      revise(corrected, "accepted").outcome,
      "superseded",
      "세 번째 턴이 첫 번째에 동의해도 정정은 정정이다",
    );
  });

  it("unconfirmed 는 무엇으로든 바뀐다", () => {
    assert.equal(revise(row({ id: "r1", outcome: "unconfirmed" }), "accepted").outcome, "accepted");
  });

  it("바뀌지 않을 때 같은 값을 새 객체로 만들지 않는다", () => {
    const original = row({ id: "r1", outcome: "superseded" });
    assert.equal(revise(original, "accepted"), original);
  });
});

describe("nearest — 다른 공간은 덜 비슷한 게 아니라 비교 불가다", () => {
  const rows = [
    row({ id: "near", vector: [1, 0, 0] }),
    row({ id: "middling", vector: [0.6, 0.8, 0] }),
    row({ id: "far", vector: [0, 0, 1] }),
  ];

  it("가까운 순으로 k개를 준다", () => {
    const got = nearest({ vector: [1, 0, 0], space: SPACE, rows, k: 2 });
    assert.deepEqual(got.map((n) => n.row.id), ["near", "middling"]);
  });

  it("다른 공간의 행은 점수조차 매기지 않는다", () => {
    const alien = [row({ id: "alien", vector: [1, 0, 0], space: spaceKey(OTHER_SPACE) })];
    assert.equal(nearest({ vector: [1, 0, 0], space: SPACE, rows: alien, k: 5 }).length, 0);
  });

  it("차원이 어긋나면 버린다 — 같은 이름의 공간이 재배포되었을 수 있다", () => {
    const stale = [row({ id: "stale", vector: [1, 0, 0, 0] })];
    assert.equal(nearest({ vector: [1, 0, 0], space: SPACE, rows: stale, k: 5 }).length, 0);
  });

  it("벡터 없는 행은 이웃이 되지 않는다", () => {
    const blind = [row({ id: "blind", vector: undefined, space: undefined })];
    assert.equal(nearest({ vector: [1, 0, 0], space: SPACE, rows: blind, k: 5 }).length, 0);
  });

  it("같은 유사도는 아이디순으로 갈라 결과가 흔들리지 않는다", () => {
    const twins = [row({ id: "b", vector: [1, 0, 0] }), row({ id: "a", vector: [1, 0, 0] })];
    const got = nearest({ vector: [1, 0, 0], space: SPACE, rows: twins, k: 2 });
    assert.deepEqual(got.map((n) => n.row.id), ["a", "b"]);
  });

  it("k 가 0 이면 아무것도 주지 않는다", () => {
    assert.equal(nearest({ vector: [1, 0, 0], space: SPACE, rows, k: 0 }).length, 0);
  });
});

describe("verdictFor — 모르는 것을 아는 척하지 않는다", () => {
  const at = (id: string, over: Partial<RememberedRequirement>) =>
    ({ row: row({ id, ...over }), similarity: 0.9 });

  it("이웃이 없으면 비율은 null 이다", () => {
    const v = verdictFor([], "llama-3.3-70b", 6000);
    assert.equal(v.seen, 0);
    assert.equal(v.rate, null, "0 은 '나쁜 적 없음' 으로 읽힌다 — 모른다와 다르다");
  });

  it("이웃이 전부 unconfirmed 면 비율은 null 이다", () => {
    const v = verdictFor(
      [at("a", { outcome: "unconfirmed" }), at("b", { outcome: "unconfirmed" })],
      "llama-3.3-70b",
      6000,
    );
    assert.equal(v.seen, 2, "본 것은 둘이다");
    assert.equal(v.rate, null, "아직 아무 일도 일어나지 않은 둘은 의견이 아니다");
  });

  it("다른 모델의 이웃은 세지 않는다", () => {
    const v = verdictFor(
      [at("a", { proposedBy: "다른모델", outcome: "superseded" })],
      "llama-3.3-70b",
      6000,
    );
    assert.equal(v.seen, 0);
    assert.equal(v.rate, null);
  });

  it("같은 모델이라도 다른 예산의 이웃은 세지 않는다", () => {
    // proposerEvidence 가 세운 사실: 같은 모델이 6000에서 1위, 800에서 0/16.
    // 예산을 무시하고 묶으면 두 다른 것을 한 증거로 합치게 된다.
    const v = verdictFor([at("a", { budget: 800, outcome: "superseded" })], "llama-3.3-70b", 6000);
    assert.equal(v.seen, 0);
  });

  it("정정과 거부를 함께 세되 따로도 남긴다", () => {
    const v = verdictFor(
      [
        at("a", { outcome: "superseded" }),
        at("b", { outcome: "rejected" }),
        at("c", { outcome: "accepted" }),
        at("d", { outcome: "accepted" }),
      ],
      "llama-3.3-70b",
      6000,
    );
    assert.equal(v.seen, 4);
    assert.equal(v.superseded, 1);
    assert.equal(v.rejected, 1);
    assert.equal(v.rate, 0.5);
  });

  it("결정된 이웃만 분모에 들어간다", () => {
    const v = verdictFor(
      [at("a", { outcome: "superseded" }), at("b", { outcome: "unconfirmed" })],
      "llama-3.3-70b",
      6000,
    );
    assert.equal(v.seen, 2);
    assert.equal(v.rate, 1, "아직 결과가 없는 이웃이 나쁜 비율을 희석하면 안 된다");
  });

  it("예산이 null 인 행은 null 예산으로 물었을 때만 잡힌다", () => {
    // 결정론 계층이 읽은 요구는 모델도 예산도 없다. 그것을 모델 증거로 세면
    // 아무도 하지 않은 일에 대한 판단이 된다.
    const runtimeRead = [at("a", { proposedBy: null, budget: null, outcome: "superseded" })];
    assert.equal(verdictFor(runtimeRead, "llama-3.3-70b", 6000).seen, 0);
    assert.equal(verdictFor(runtimeRead, "llama-3.3-70b", null).seen, 0);
  });
});
