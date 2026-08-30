import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { describeDesign, designHarness } from "./harnessDesign.ts";
import { measure, type Measure, type ModelProfile } from "../router/modelProfile.ts";

/**
 * The designer: one request in, one harness design out.
 *
 * Everything here runs offline. `designHarness` reaches the network only when a
 * `propose` callback is supplied, and none of these supply one — so a failure
 * in this file is a failure of the runtime's own reading, never of a gateway.
 */

/**
 * A model profile with what the router reads and nothing else.
 *
 * Capabilities are `Measure`s rather than bare numbers on purpose — the router
 * distinguishes a value nobody measured from one measured over a hundred runs,
 * and a test that flattened that would be testing a different ranker.
 */
function model(input: {
  id: string;
  coding?: number;
  toolUse?: number;
  contextWindow?: number;
  available?: boolean;
}): ModelProfile {
  const cap = (value: number | undefined): Measure | undefined =>
    value === undefined ? undefined : measure(value, "harness_eval", 20);
  return {
    modelId: input.id,
    availability: {
      available: input.available ?? true,
      protocol: "native",
      contextWindow: input.contextWindow ?? 128_000,
      maxOutputTokens: 8_000,
      supportsNativeTools: true,
    },
    capabilities: {
      ...(cap(input.coding) === undefined ? {} : { coding: cap(input.coding)! }),
      ...(cap(input.toolUse) === undefined ? {} : { toolUse: cap(input.toolUse)! }),
      instructionFollowing: measure(0.6, "harness_eval", 20),
      reasoning: measure(0.6, "harness_eval", 20),
      codeReview: measure(0.6, "harness_eval", 20),
      architecture: measure(0.6, "harness_eval", 20),
    },
    efficiency: {},
    semanticDescription: input.id,
    evidence: { evalSampleCount: 20 },
  };
}

describe("reading a request into a design", () => {
  test("the acts the runtime recognises become the turn's intents", async () => {
    const design = await designHarness({ text: "로그인 오류를 수정하고 테스트해줘." });
    assert.deepEqual([...design.intents].sort(), ["modify", "verify"]);
    const stated = design.requirements.filter((r) => r.status !== "system_added");
    assert.ok(
      stated.some((r) => r.text.includes("수정")),
      `the modify requirement was not read: ${JSON.stringify(stated.map((r) => r.text))}`,
    );
  });

  test("a request naming no act is still a request to look", async () => {
    const design = await designHarness({ text: "이 저장소가 무슨 일을 하는지 궁금해." });
    assert.deepEqual(design.intents, ["inspect"]);
  });

  test("the harness's own baselines are counted apart from the user's words", async () => {
    const design = await designHarness({ text: "로그인 오류를 수정해줘." });
    // Baselines have no span — the runtime cannot point at words for them,
    // because there are none.
    assert.ok(design.confidence.grounded > 0, "nothing was cut from the user's words");
    assert.ok(design.confidence.ungrounded > 0, "the baselines were not counted");
    const baselines = design.requirements.filter((r) => r.status === "system_added");
    assert.ok(baselines.every((r) => r.span === undefined));
  });
});

describe("a prohibition outranks anything the runtime infers", () => {
  // The inversion this file exists to prevent, and one this module committed in
  // its first draft: "웹검색은 하지 마" names the web, so a demand pattern
  // matched the noun *inside the prohibition* and the design came out asking
  // for research the user had just forbidden. The same shape the research
  // decision in `turnContract.ts` was rebuilt to end.

  test("a forbidden web search never becomes a research intent", async () => {
    const design = await designHarness({ text: "README 오타를 고쳐줘. 웹검색은 하지 마." });
    assert.ok(
      !design.intents.includes("research"),
      `the prohibition was read as a demand: ${JSON.stringify(design.intents)}`,
    );
    assert.deepEqual(
      design.prohibitions.map((c) => c.kind),
      ["no_research"],
    );
    // The work the user *did* ask for survives.
    assert.ok(design.intents.includes("modify"));
  });

  test("a forbidden execution never becomes an execute intent", async () => {
    const design = await designHarness({ text: "코드를 실행하지 말고 읽기만 해줘." });
    assert.ok(!design.intents.includes("execute"));
    assert.deepEqual(
      design.prohibitions.map((c) => c.kind),
      ["no_execute"],
    );
  });

  test("a request that genuinely asks for the web still gets it", async () => {
    // The counter-direction. Suppressing the demand must depend on the
    // prohibition, not on the web being mentioned at all.
    const design = await designHarness({ text: "최신 모델을 웹에서 찾아서 코드를 수정해줘." });
    assert.ok(design.intents.includes("research"));
    assert.equal(design.prohibitions.length, 0);
  });

  test("the profile carries the prohibition, so the router can see it", async () => {
    const design = await designHarness({ text: "코드를 실행하지 말고 읽기만 해줘." });
    assert.equal(design.profile.constraints.noExecute, true);
  });
});

describe("recommending a model for the design", () => {
  const MODELS = [
    model({ id: "coder-big", coding: 0.9, toolUse: 0.9, contextWindow: 200_000 }),
    model({ id: "chatty-small", coding: 0.2, toolUse: 0.1, contextWindow: 8_000 }),
  ];

  test("a coding request prefers the coding model, and says why", async () => {
    const design = await designHarness({
      text: "로그인 오류를 수정하고 테스트해줘.",
      models: MODELS,
    });
    assert.ok(design.recommendation !== null);
    assert.equal(design.recommendation.selected?.modelId, "coder-big");
    assert.ok(
      design.recommendation.reasons.length > 0,
      "a recommendation with no reason is a guess wearing a number",
    );
  });

  test("no model list is a question nobody asked, not an empty answer", async () => {
    const design = await designHarness({ text: "로그인 오류를 수정해줘." });
    assert.equal(design.recommendation, null);
    assert.match(describeDesign(design), /모델 목록 없음/);
  });

  test("an empty list reads the same as none supplied", async () => {
    const design = await designHarness({ text: "로그인 오류를 수정해줘.", models: [] });
    assert.equal(design.recommendation, null);
  });

  test("nothing eligible is an answer, and it names the reason", async () => {
    const tiny = [model({ id: "tiny", coding: 0.5, contextWindow: 1_000, available: false })];
    const design = await designHarness({ text: "로그인 오류를 수정해줘.", models: tiny });
    assert.ok(design.recommendation !== null, "an unavailable model is still an answer");
    assert.equal(design.recommendation.selected, null);
    assert.ok(
      design.recommendation.filteredOut.length > 0 ||
        design.recommendation.unavailableReason !== undefined,
      "nothing survived and nothing said why",
    );
  });
});

describe("the design never runs anything", () => {
  test("no tool plan while the design is unresolved", async () => {
    const design = await designHarness({ text: "고마워." });
    // A request holding nothing but the harness's baselines is not permission.
    assert.equal(design.preview.mayExecute, false);
    assert.deepEqual(design.preview.plannedTools, []);
  });

  test("the same request twice gives the same design", async () => {
    const text = "로그인 오류를 수정하고 테스트해줘.";
    const a = await designHarness({ text });
    const b = await designHarness({ text });
    assert.deepEqual(
      a.requirements.map((r) => r.text),
      b.requirements.map((r) => r.text),
    );
    assert.deepEqual(a.intents, b.intents);
    assert.deepEqual(a.confidence, b.confidence);
  });
});

describe("the one-line summary tells the truth", () => {
  test("it names what is unresolved rather than only what was chosen", async () => {
    const design = await designHarness({ text: "로그인 오류를 수정하고 테스트해줘." });
    const line = describeDesign(design);
    assert.match(line, /요구사항 \d+건/);
    if (design.questions.length > 0) assert.match(line, /확인 필요/);
  });
});
