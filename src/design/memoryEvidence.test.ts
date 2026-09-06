import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { evidenceFromMemory, ranked } from "./memoryEvidence.ts";
import { MIN_SAMPLES_FOR_EVIDENCE } from "../router/modelRegistry.ts";
import { spaceKey, type EmbeddingSpaceIdentity } from "../router/embedding.ts";
import type { Neighbour, RememberedRequirement, RequirementOutcome } from "./requirementMemory.ts";

/**
 * The bridge, against neighbours written here.
 *
 * Nothing below reads a real memory file or a real embedding. What is being
 * checked is the judgement — when the memory speaks and when it refuses — and a
 * fixture that came out of a live run would make those assertions about
 * whatever happened to be on disk.
 */

const SPACE: EmbeddingSpaceIdentity = { provider: "hasa", modelId: "bge-m3", dimension: 3 };
const NOW = 1_700_000_000_000;

const near = (
  id: string,
  over: Partial<RememberedRequirement> = {},
): Neighbour => ({
  similarity: 0.9,
  row: {
    id,
    turnId: "t1",
    sourceText: "시스템 아키텍처를 분석해",
    proposedBy: "llama-3.3-70b",
    budget: 6000,
    outcome: "accepted",
    vector: [1, 0, 0],
    space: spaceKey(SPACE),
    at: 0,
    ...over,
  },
});

/** n neighbours of one outcome, all from the same model and budget. */
const runOf = (n: number, outcome: RequirementOutcome, over: Partial<RememberedRequirement> = {}) =>
  Array.from({ length: n }, (_, i) => near(`r${outcome}${i}`, { outcome, ...over }));

describe("evidenceFromMemory — 말할 수 있을 때만 말한다", () => {
  it("이웃이 문턱보다 적으면 아무 능력도 주장하지 않는다", () => {
    const few = runOf(MIN_SAMPLES_FOR_EVIDENCE - 1, "superseded");
    const [ev] = evidenceFromMemory({ neighbours: few, now: NOW });
    assert.ok(ev !== undefined, "짝은 나와야 한다 — 본 것이 없다는 말도 답이다");
    assert.equal(ev.capabilities.sourceGrounding, undefined, "한 건은 일화다");
    assert.equal(ev.basis.seen, MIN_SAMPLES_FOR_EVIDENCE - 1);
  });

  it("문턱을 넘으면 주장한다", () => {
    const enough = runOf(MIN_SAMPLES_FOR_EVIDENCE, "accepted");
    const [ev] = evidenceFromMemory({ neighbours: enough, now: NOW });
    assert.equal(ev?.capabilities.sourceGrounding?.value, 1);
    assert.equal(ev?.capabilities.sourceGrounding?.samples, MIN_SAMPLES_FOR_EVIDENCE);
  });

  it("정정된 비율이 그대로 감점이 된다", () => {
    // 넷 중 하나가 정정 → 나쁜 비율 0.25 → 근거 0.75.
    const mixed = [...runOf(3, "accepted"), ...runOf(1, "superseded")];
    const [ev] = evidenceFromMemory({ neighbours: mixed, now: NOW });
    assert.equal(ev?.capabilities.sourceGrounding?.value, 0.75);
  });

  it("아직 아무 일도 없은 이웃뿐이면 침묵한다", () => {
    // 「이웃이 모자람」과 「이웃은 있는데 결과가 없음」은 다른 침묵이고, 둘 다
    // 0 점이 아니다. 0 점은 나쁘다는 주장이다.
    const pending = runOf(MIN_SAMPLES_FOR_EVIDENCE + 2, "unconfirmed");
    const [ev] = evidenceFromMemory({ neighbours: pending, now: NOW });
    assert.equal(ev?.basis.seen, MIN_SAMPLES_FOR_EVIDENCE + 2, "본 것은 있다");
    assert.equal(ev?.capabilities.sourceGrounding, undefined, "의견은 없다");
  });

  it("잰 적 없는 축은 비워 둔다 — 한 신호를 열둘로 세탁하지 않는다", () => {
    const enough = runOf(MIN_SAMPLES_FOR_EVIDENCE, "accepted");
    const [ev] = evidenceFromMemory({ neighbours: enough, now: NOW });
    assert.deepEqual(Object.keys(ev?.capabilities ?? {}), ["sourceGrounding"]);
  });
});

describe("증거의 등급과 짝", () => {
  it("실사용에서 온 것이므로 observed 다", () => {
    const enough = runOf(MIN_SAMPLES_FOR_EVIDENCE, "accepted");
    const [ev] = evidenceFromMemory({ neighbours: enough, now: NOW });
    assert.equal(ev?.capabilities.sourceGrounding?.origin, "observed");
  });

  it("언제 본 것인지 남긴다", () => {
    const enough = runOf(MIN_SAMPLES_FOR_EVIDENCE, "accepted");
    const [ev] = evidenceFromMemory({ neighbours: enough, now: NOW });
    assert.equal(ev?.capabilities.sourceGrounding?.updatedAt, new Date(NOW).toISOString());
  });

  it("같은 모델이라도 예산이 다르면 다른 짝이다", () => {
    // 같은 모델이 6000에서 1위, 800에서 0/16 이었다. 예산을 무시하고 묶으면
    // 서로 다른 두 사실을 한 증거로 합치게 된다.
    const both = [
      ...runOf(MIN_SAMPLES_FOR_EVIDENCE, "accepted", { budget: 6000 }),
      ...runOf(MIN_SAMPLES_FOR_EVIDENCE, "superseded", { budget: 800 }),
    ];
    const ev = evidenceFromMemory({ neighbours: both, now: NOW });
    assert.equal(ev.length, 2);
    const at = (b: number) => ev.find((e) => e.budget === b)?.capabilities.sourceGrounding?.value;
    assert.equal(at(6000), 1);
    assert.equal(at(800), 0);
  });

  it("결정론 계층이 읽은 행은 어느 모델의 증거도 아니다", () => {
    const runtimeRead = runOf(MIN_SAMPLES_FOR_EVIDENCE, "superseded", { proposedBy: null });
    assert.deepEqual(evidenceFromMemory({ neighbours: runtimeRead, now: NOW }), []);
  });

  it("이웃이 없으면 짝도 없다", () => {
    assert.deepEqual(evidenceFromMemory({ neighbours: [], now: NOW }), []);
  });
});

describe("ranked", () => {
  it("나쁜 쪽이 앞에 온다", () => {
    const ev = evidenceFromMemory({
      neighbours: [
        ...runOf(MIN_SAMPLES_FOR_EVIDENCE, "accepted", { proposedBy: "좋은모델" }),
        ...runOf(MIN_SAMPLES_FOR_EVIDENCE, "superseded", { proposedBy: "나쁜모델" }),
      ],
      now: NOW,
    });
    assert.deepEqual(ranked(ev).map((e) => e.modelId), ["나쁜모델", "좋은모델"]);
  });

  it("의견이 없는 짝은 목록에서 빼 버린다 — 침묵을 최하점으로 읽히게 두지 않는다", () => {
    const ev = evidenceFromMemory({
      neighbours: [
        ...runOf(MIN_SAMPLES_FOR_EVIDENCE, "accepted", { proposedBy: "아는모델" }),
        ...runOf(1, "superseded", { proposedBy: "모르는모델" }),
      ],
      now: NOW,
    });
    assert.deepEqual(ranked(ev).map((e) => e.modelId), ["아는모델"]);
  });

  it("점수가 같으면 이름순으로 갈라 결과가 흔들리지 않는다", () => {
    const ev = evidenceFromMemory({
      neighbours: [
        ...runOf(MIN_SAMPLES_FOR_EVIDENCE, "accepted", { proposedBy: "b모델" }),
        ...runOf(MIN_SAMPLES_FOR_EVIDENCE, "accepted", { proposedBy: "a모델" }),
      ],
      now: NOW,
    });
    assert.deepEqual(ranked(ev).map((e) => e.modelId), ["a모델", "b모델"]);
  });
});
