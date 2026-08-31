import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { forEachSeedAsync, fuzzIterations, type Rng } from "../testing/fuzz.ts";
import { designHarness } from "./harnessDesign.ts";
import { profileOf } from "./recommendationCases.ts";

/**
 * The designer, over generated requests.
 *
 * This is the product's front door and it takes whatever a person types. Every
 * other test here feeds it a sentence somebody composed on purpose; this feeds
 * it the sentences nobody composes — a request that is only punctuation, one
 * that forbids and asks in the same breath, one 4000 characters long, one made
 * of lone surrogates.
 *
 * The properties are the claims the design makes about itself, and each one is
 * a sentence a user reads:
 *
 *   · it does not fall over
 *   · it does not recommend a model for a request it could not read
 *   · every target it shows back is a word the user wrote
 *   · every prohibition it reports is quoted from the request
 *   · the same request twice is the same design
 *
 * Fewer iterations than the extractor's own fuzz, because a design is the whole
 * pipeline — extraction, audit, closure, profile, ranking — and the point is
 * coverage of shapes rather than of seeds. `HASA_FUZZ_ITERATIONS` raises it.
 */

const MODELS = [
  profileOf({ id: "generalist", strong: { coding: 0.7, toolUse: 0.7, reasoning: 0.6 } }),
  profileOf({ id: "specialist", strong: { coding: 0.9, webResearch: 0.2 } }),
  profileOf({ id: "researcher", strong: { webResearch: 0.9, sourceGrounding: 0.8 } }),
];

const FRAGMENTS = [
  "로그인 오류를 수정해줘",
  "main.py 코드만 분석해줘",
  "CNN과 ViT로 분류기를 만들고",
  "테스트해줘",
  "실행하지 마",
  "수정하지 말고 설명만 해줘",
  "웹에서 최신 모델을 찾아줘",
  "https://open.hasa.re.kr/models 를 확인해줘",
  "기존 동작은 그대로 유지해줘",
  "안녕하세요",
  "적당히 잘 좀 해줘",
  "please fix the login bug",
  "결제 모듈을 리팩터링해줘",
  "학습과 추론을 하고",
  "다시",
  "?",
  "",
];

const JOIN = [" ", ". ", ", ", "\n", " 그리고 ", " 하지만 "];

function request(rng: Rng): string {
  const parts: string[] = [];
  for (let i = 0; i < rng.int(1, 5); i += 1) {
    parts.push(rng.pick(FRAGMENTS));
    if (i < 4) parts.push(rng.pick(JOIN));
  }
  // One in six is not a sentence at all. A designer that only survives
  // well-formed Korean survives nothing a user will actually paste in.
  return rng.bool(0.17) ? rng.string(rng.int(0, 4000)) : parts.join("");
}

const ITERATIONS = fuzzIterations(60);

describe("디자이너, 생성된 요청에 대해", () => {
  test("어떤 입력에도 설계를 끝낸다", async () => {
    await forEachSeedAsync(async (rng, seed) => {
      const text = request(rng);
      await assert.doesNotReject(
        () => designHarness({ text, models: MODELS }),
        `seed ${seed}: ${JSON.stringify(text.slice(0, 80))}`,
      );
    }, ITERATIONS);
  });

  test("읽지 못한 요청에는 모델을 추천하지 않는다", async () => {
    // The claim `understood` exists to make. A design that says it read nothing
    // and then names a model has recommended one for a request it invented.
    await forEachSeedAsync(async (rng, seed) => {
      const text = request(rng);
      const design = await designHarness({ text, models: MODELS });
      if (design.understood) return;
      assert.equal(
        design.recommendation,
        null,
        `seed ${seed}: 읽지 못했는데 추천했습니다\n  입력: ${JSON.stringify(text.slice(0, 120))}`,
      );
    }, ITERATIONS);
  });

  test("사용자의 요구사항으로 표시된 것은 사용자의 낱말로 되어 있다", async () => {
    // Baselines are excluded: those are the harness's own rules and say so.
    // What is left claims to be the user's, and every word of its target has to
    // come from the request.
    await forEachSeedAsync(async (rng, seed) => {
      const text = request(rng);
      const design = await designHarness({ text, models: MODELS });
      for (const spec of design.requirements) {
        if (spec.status === "system_added") continue;
        if (spec.target === undefined) continue;
        for (const word of spec.target.split(/\s+/)) {
          if (word.length === 0) continue;
          assert.ok(
            text.includes(word),
            `seed ${seed}: "${word}" 는 입력에 없습니다\n  입력: ${JSON.stringify(text.slice(0, 120))}\n  요구사항: ${spec.text}`,
          );
        }
      }
    }, ITERATIONS);
  });

  test("보고된 금지는 요청에서 인용된 것이다", async () => {
    // The safety invariant, from the reporting end. A prohibition the design
    // shows but cannot quote is one it decided on, and a model-decided
    // prohibition is the thing this codebase refuses to let outrank the user.
    await forEachSeedAsync(async (rng, seed) => {
      const text = request(rng);
      const design = await designHarness({ text, models: MODELS });
      for (const constraint of design.prohibitions) {
        assert.ok(
          text.includes(constraint.text),
          `seed ${seed}: 금지 "${constraint.text}" 가 원문에 없습니다\n  입력: ${JSON.stringify(text.slice(0, 120))}`,
        );
      }
    }, ITERATIONS);
  });

  test("같은 요청은 같은 설계를 낸다", async () => {
    await forEachSeedAsync(async (rng, seed) => {
      const text = request(rng);
      const once = await designHarness({ text, models: MODELS });
      const twice = await designHarness({ text, models: MODELS });
      assert.deepEqual(
        twice.requirements.map((r) => r.text),
        once.requirements.map((r) => r.text),
        `seed ${seed}: ${JSON.stringify(text.slice(0, 80))}`,
      );
      assert.equal(twice.recommendation?.selected?.modelId, once.recommendation?.selected?.modelId);
      assert.equal(twice.understood, once.understood);
    }, ITERATIONS);
  });
});
