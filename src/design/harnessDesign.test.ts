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
    // This assertion used to read `ungrounded > 0` and pass for the wrong
    // reason: the baselines were being counted among the user's requirements,
    // and `ungrounded` meant "no span" over a list that included them. The
    // three counts are now three different facts.
    const design = await designHarness({ text: "로그인 오류를 수정해줘." });
    const stated = design.requirements.filter((r) => r.status !== "system_added");
    const baselines = design.requirements.filter((r) => r.status === "system_added");

    assert.ok(design.confidence.grounded > 0, "nothing was cut from the user's words");
    assert.equal(design.confidence.baseline, baselines.length);
    assert.equal(design.confidence.grounded + design.confidence.ungrounded, stated.length);
    // Baselines have no span — the runtime cannot point at words for them,
    // because there are none.
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

describe("the design says what it read, and no more", () => {
  // Five defects an audit found in the first draft of this module, each of
  // which made the design claim something the runtime had not established.

  test("a request the extractor cannot read is not reported as understood", async () => {
    // A request with no act the extractor recognises in either language. It is
    // unread — not a request to look at something — and the two used to arrive
    // identically as intents:["inspect"] over two baselines.
    //
    // This case was English until `functionalExtract` grew an English pass;
    // that it had to be replaced is the point, and the invariant is unchanged.
    const design = await designHarness({ text: "적당히 잘 좀 해줘." });
    assert.equal(design.understood, false);
    assert.match(describeDesign(design), /읽지 못했습니다/);
  });

  test("an English request is read, and reported as read", async () => {
    const design = await designHarness({ text: "Please fix the login error." });
    assert.equal(design.understood, true);
    assert.ok(design.intents.includes("modify"));
  });

  test("a pleasantry is unread, not a task", async () => {
    const design = await designHarness({ text: "고마워, 잘 됐어." });
    assert.equal(design.understood, false);
  });

  test("an unread request gets no model recommendation", async () => {
    // A recommendation is a claim about what the work needs. With nothing read
    // there is no work to characterise, and every unread request would
    // otherwise get the same confident pick — the baselines' profile.
    const models = [model({ id: "coder-big", coding: 0.9, toolUse: 0.9 })];
    const design = await designHarness({ text: "적당히 잘 좀 해줘.", models });
    assert.equal(design.understood, false);
    assert.equal(design.recommendation, null);
  });

  test("a request it did read still gets one", async () => {
    const models = [model({ id: "coder-big", coding: 0.9, toolUse: 0.9 })];
    const design = await designHarness({ text: "로그인 오류를 수정하고 테스트해줘.", models });
    assert.equal(design.understood, true);
    assert.equal(design.recommendation?.selected?.modelId, "coder-big");
  });

  test("the requirement count is the user's, not the harness's own rules", async () => {
    const design = await designHarness({ text: "로그인 오류를 수정하고 테스트해줘." });
    const stated = design.requirements.filter((r) => r.status !== "system_added").length;
    assert.ok(design.confidence.baseline > 0, "the baselines are still on the record");
    assert.match(describeDesign(design), new RegExp(`요구사항 ${stated}건`));
    assert.equal(
      design.confidence.grounded + design.confidence.ungrounded,
      stated,
      "confidence counts the baselines among the user's requirements",
    );
  });

  test("unresolved counts the requirements the questions are about", async () => {
    // The field was keyed on requirement *text* while a question carries the
    // requirement's *id*, so the sets never intersected and it read zero on
    // every case — including the ones raising a question.
    const design = await designHarness({ text: "로그인 오류를 수정하고 테스트해줘." });
    assert.ok(design.questions.length > 0, "this request should raise a question");
    assert.equal(design.confidence.unresolved, design.questions.length);
  });

  test("the harness's baselines do not inflate the profile", async () => {
    // Two baselines went into the synthesised contract, so every request
    // crossed the three-requirement threshold that raises recovery and
    // multiTurnContinuity — on 53 of 76 corpus cases.
    const design = await designHarness({ text: "빌드를 실행해줘." });
    const stated = design.requirements.filter((r) => r.status !== "system_added");
    assert.equal(stated.length, 1, "this request states exactly one thing");
    assert.equal(
      design.profile.demands.multiTurnContinuity,
      0,
      "a single-requirement request was profiled as a multi-part one",
    );
  });
});

describe("a ban and an act can both be true", () => {
  test("a scoped ban does not erase the act the same request states", async () => {
    // "README를 고쳐줘. 다른 파일은 수정하지 마." — the requirement list kept
    // "README를 수정한다" while the profile carried no coding demand at all, so
    // the router was asked to staff a modification with a model chosen for
    // reading.
    const design = await designHarness({ text: "README를 고쳐줘. 다른 파일은 수정하지 마." });
    assert.ok(design.intents.includes("modify"), "the stated act was deleted");
    assert.ok((design.profile.demands.coding ?? 0) > 0, "the coding demand was zeroed");
    // The ban still reaches the router, where it filters rather than scores.
    assert.equal(design.profile.constraints.noModify, true);
    // And the contradiction is offered rather than resolved.
    assert.ok(design.questions.length > 0);
  });

  test("creating a file is not modifying one, and the ban must not zero the demand", async () => {
    // This one raises no conflict question at all, so before the fix the
    // coding demand was silently zeroed with nothing flagged anywhere.
    const design = await designHarness({ text: "설정 파일을 만들어줘. 기존 파일은 수정하지 마." });
    assert.ok(design.intents.includes("modify"));
    assert.ok((design.profile.demands.coding ?? 0) > 0);
    assert.equal(design.profile.constraints.noModify, true);
  });

  test("a purely prohibitive sentence still states no act", async () => {
    const design = await designHarness({ text: "코드를 실행하지 말고 읽기만 해줘." });
    assert.ok(!design.intents.includes("execute"));
    // Stated as the reason it holds: the extractor emits no positive execute
    // act here, rather than one being subtracted afterwards.
    assert.equal(
      design.requirements.filter((r) => r.polarity !== "forbidden" && r.act === "execute").length,
      0,
    );
  });
});

describe("the web demand is read with the runtime's own vocabulary", () => {
  test("a pure coding request demands no web research", async () => {
    // A local noun scan matched domain words, so a coding chore came out
    // demanding webResearch 0.9 and sourceGrounding 0.9 of every candidate.
    for (const text of [
      "로그인 오류를 수정하고 테스트해줘.",
      "빌드를 실행해줘.",
      "이 파일을 읽고 설명해줘.",
    ]) {
      const design = await designHarness({ text });
      assert.ok(!design.intents.includes("research"), `research inferred from: ${text}`);
      assert.equal(design.profile.demands.webResearch ?? 0, 0, text);
      assert.equal(design.profile.demands.sourceGrounding ?? 0, 0, text);
    }
  });

  test("a request that names the web still demands it", async () => {
    const design = await designHarness({ text: "최신 모델을 웹에서 찾아서 코드를 수정해줘." });
    assert.ok(design.intents.includes("research"));
    assert.ok((design.profile.demands.webResearch ?? 0) > 0);
  });
});

describe("a tie is reported as a tie", () => {
  /** A model nobody has ever evaluated — the common case on a fresh gateway. */
  function unevaluated(id: string): ModelProfile {
    return {
      modelId: id,
      availability: {
        available: true,
        protocol: "native",
        contextWindow: 128_000,
        maxOutputTokens: 8_000,
        supportsNativeTools: true,
      },
      capabilities: {},
      efficiency: {},
      semanticDescription: id,
      evidence: { evalSampleCount: 0 },
    };
  }

  test("cold start names the models the evidence cannot separate", async () => {
    // Every candidate scores the same default and `ranked[0]` is whichever id
    // sorted first. Shown alone, an arbitrary pick reads as a finding.
    const design = await designHarness({
      text: "로그인 오류를 수정하고 테스트해줘.",
      models: [unevaluated("zebra"), unevaluated("alpha"), unevaluated("middle")],
    });
    const rec = design.recommendation;
    assert.ok(rec !== null);
    assert.ok(rec.selected !== null);
    assert.deepEqual([...(rec.tiedWith ?? [])].sort(), ["middle", "zebra"]);
    assert.equal(rec.selected.confidence.coldStart, true);
  });

  test("a real difference is not reported as a tie", async () => {
    const design = await designHarness({
      text: "로그인 오류를 수정하고 테스트해줘.",
      models: [model({ id: "coder-big", coding: 0.9, toolUse: 0.9 }), model({ id: "weak", coding: 0.1, toolUse: 0.1 })],
    });
    assert.equal(design.recommendation?.tiedWith, undefined);
  });
});
