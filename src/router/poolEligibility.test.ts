import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { inPool, poolEligibility } from "./poolEligibility.ts";
import { semanticProfileFor } from "./modelSemanticCatalog.ts";
import type { Modality } from "../provider/hasa/hasaCatalog.ts";

/**
 * Who belongs in the coding pool, decided the same way for every model.
 *
 * The rule under test is that *how much someone has written down about a model*
 * must not change its basic eligibility. Curation describes what a model is
 * for; it does not grant or withhold membership by being present or absent.
 *
 * The live catalogue produced the counterexample in three lines:
 *
 *     paddleocr-vl        vision   curated       excluded
 *     qwen2.5-vl-72b      vision   curated       excluded
 *     nemotron-omni-30b   vision   no profile    admitted
 */

const standing = (modality: Modality | null, modelId = "unlisted-model-x"): string =>
  poolEligibility({ modelId, modality }).standing;

// --- the two live defects, reproduced ---------------------------------------

describe("the defects this replaces", () => {
  test("a safety classifier does not enter the coding pool", () => {
    // `nemotron-safety-4b` is curated *as* a safety classifier, and the
    // exclusion did not apply because the evidence behind the profile was not
    // strong enough to reach `hard_exclude`. Evidence strength is the right
    // control for a claim about a model and the wrong one for "this endpoint is
    // a classifier", which the catalogue states outright.
    const result = poolEligibility({ modelId: "nemotron-safety-4b", modality: "safety" });
    assert.equal(result.standing, "excluded");
    assert.equal(result.basis, "modality");
    assert.equal(inPool({ modelId: "nemotron-safety-4b", modality: "safety" }), false);
  });

  test("an uncurated vision model is not admitted for lack of a profile", () => {
    // `nemotron-omni-30b` passed because nobody had written it up.
    const result = poolEligibility({ modelId: "nemotron-omni-30b", modality: "vision" });
    assert.equal(result.standing, "unknown", "not admitted");
    assert.notEqual(result.standing, "excluded", "and no claim made about it either");
    assert.equal(inPool({ modelId: "nemotron-omni-30b", modality: "vision" }), false);
  });

  test("the curated vision models keep behaving exactly as they did", () => {
    for (const id of ["paddleocr-vl", "qwen2.5-vl-72b"]) {
      const result = poolEligibility({ modelId: id, modality: "vision" });
      assert.equal(result.standing, "excluded", id);
      assert.equal(result.basis, "curation", id);
      assert.match(result.reason, /\S/, id);
    }
  });
});

// --- the property the defects violated --------------------------------------

describe("the same measured modality gets the same rule", () => {
  test("curation cannot make an unlisted model eligible", () => {
    // Two ids, same modality, one curated and one not. Curation may narrow the
    // answer; it may never be the reason one is admitted and the other is not.
    const curated = poolEligibility({ modelId: "paddleocr-vl", modality: "vision" });
    const bare = poolEligibility({ modelId: "no-such-model-in-catalogue", modality: "vision" });
    assert.notEqual(curated.standing, "eligible");
    assert.notEqual(bare.standing, "eligible");
  });

  test("every dedicated-endpoint modality is excluded, curated or not", () => {
    for (const modality of ["image", "video", "audio", "embeddings", "rerank", "safety"] as const) {
      assert.equal(standing(modality), "excluded", modality);
      assert.equal(standing(modality, "granite-guardian-3.1-8b"), "excluded", `curated ${modality}`);
    }
  });

  test("chat is eligible whether or not anyone wrote a profile", () => {
    assert.equal(standing("chat", "exaone-4.0-32b"), "eligible", "curated general_worker");
    assert.equal(standing("chat", "no-such-model-in-catalogue"), "eligible", "uncurated");
  });
});

// --- unknown is its own answer ----------------------------------------------

describe("unknown is not promoted and not condemned", () => {
  test("an unlisted model is unknown, not eligible", () => {
    const result = poolEligibility({ modelId: "who-knows", modality: null });
    assert.equal(result.standing, "unknown");
    assert.equal(result.basis, "absent");
    assert.equal(inPool({ modelId: "who-knows", modality: null }), false);
  });

  test("a catalogue that declines to classify leaves it unknown", () => {
    assert.equal(standing("unknown"), "unknown");
  });

  test("vision alone settles nothing, in either direction", () => {
    // Not excluded: a conversational multimodal model that can code is a real
    // thing and this must not throw it away on the modality alone.
    const result = poolEligibility({ modelId: "some-multimodal", modality: "vision" });
    assert.equal(result.standing, "unknown");
    assert.match(result.reason, /멀티모달/);
  });

  test("a measurement is what promotes a vision model, not a profile", () => {
    // The route in is `converses`, which is an invocation result.
    const measured = poolEligibility({
      modelId: "some-multimodal",
      modality: "chat",
      converses: true,
    });
    assert.equal(measured.standing, "eligible");
  });
});

// --- measurement outranks the catalogue --------------------------------------

describe("what the gateway answered wins", () => {
  test("a model measured not to converse is excluded whatever the catalogue says", () => {
    const result = poolEligibility({ modelId: "pii-ko", modality: "chat", converses: false });
    assert.equal(result.standing, "excluded");
    assert.equal(result.basis, "invocation");
  });

  test("the four probed quantum endpoints stay out", () => {
    for (const id of [
      "cuquantum-densitymatrix",
      "cuquantum-expectation",
      "cuquantum-statevector",
      "cuquantum-tensornet",
    ]) {
      assert.equal(inPool({ modelId: id, modality: "unknown", converses: false }), false, id);
    }
  });
});

// --- the id is a key, never a source of meaning ------------------------------

describe("nothing is inferred from the model id", () => {
  test("a name that reads like a coder does not become eligible", () => {
    assert.equal(standing("embeddings", "super-coder-9000"), "excluded");
    assert.equal(standing("vision", "definitely-a-coding-model"), "unknown");
  });

  test("a name that reads like an image model does not become excluded", () => {
    assert.equal(standing("chat", "image-generator-xl"), "eligible");
    assert.equal(standing("chat", "whisper-like-name"), "eligible");
    assert.equal(standing("chat", "safety-sounding-name"), "eligible");
  });
});

// --- the whole live catalogue, as one table ----------------------------------

describe("the live catalogue lands where it should", () => {
  const CATALOGUE: ReadonlyArray<[string, Modality, boolean | null, string]> = [
    ["ax-3.1", "chat", null, "eligible"],
    ["exaone-4.0-32b", "chat", null, "eligible"],
    ["glm-4.7-flash", "chat", null, "eligible"],
    ["gpt-oss-120b", "chat", null, "eligible"],
    ["gpt-oss-20b", "chat", null, "eligible"],
    ["hyperclovax-seed-32b", "chat", null, "eligible"],
    ["kanana-2-30b-a3b", "chat", null, "eligible"],
    ["llama-3.3-70b", "chat", null, "eligible"],
    ["midm-2.0-base", "chat", null, "eligible"],
    ["nemotron-nano-30b", "chat", null, "eligible"],
    ["nemotron-super-120b", "chat", null, "eligible"],
    ["qwen3-coder", "chat", null, "eligible"],
    ["solar-open-100b", "chat", null, "eligible"],
    ["nemotron-safety-4b", "safety", null, "excluded"],
    ["granite-guardian-3.1-8b", "safety", null, "excluded"],
    ["paddleocr-vl", "vision", null, "excluded"],
    ["qwen2.5-vl-72b", "vision", null, "excluded"],
    ["nemotron-omni-30b", "vision", null, "unknown"],
    ["bge-m3", "embeddings", null, "excluded"],
    ["nemotron-embed-8b", "embeddings", null, "excluded"],
    ["bge-reranker-v2-m3", "rerank", null, "excluded"],
    ["melotts-ko", "audio", null, "excluded"],
    ["whisper-large-v3-turbo", "audio", null, "excluded"],
    ["LTX-2", "video", null, "excluded"],
    ["Wan2.2-T2V", "video", null, "excluded"],
    ["wan2.2-i2v", "video", null, "excluded"],
    ["Qwen-Image", "image", null, "excluded"],
    ["Qwen-Image-Edit", "image", null, "excluded"],
    ["cuquantum-densitymatrix", "unknown", false, "excluded"],
    ["cuquantum-expectation", "unknown", false, "excluded"],
    ["cuquantum-statevector", "unknown", false, "excluded"],
    ["cuquantum-tensornet", "unknown", false, "excluded"],
    ["groot-n17-3b", "unknown", false, "excluded"],
    ["pii-ko", "safety", false, "excluded"],
  ];

  test("all thirty-four are classified, and only chat models are in", () => {
    assert.equal(CATALOGUE.length, 34);
    const eligible: string[] = [];
    for (const [id, modality, converses, expected] of CATALOGUE) {
      const result = poolEligibility({
        modelId: id,
        modality,
        ...(converses === null ? {} : { converses }),
      });
      assert.equal(result.standing, expected, `${id} (${modality})`);
      if (result.standing === "eligible") eligible.push(id);
    }
    assert.equal(eligible.length, 13, eligible.join(", "));
  });

  test("no model is eligible whose modality is not chat", () => {
    for (const [id, modality, converses] of CATALOGUE) {
      if (modality === "chat" && converses !== false) continue;
      assert.equal(
        inPool({ modelId: id, modality, ...(converses === null ? {} : { converses }) }),
        false,
        id,
      );
    }
  });
});

// --- curation still carries what it is for -----------------------------------

describe("curated profiles are kept and still describe roles", () => {
  test("the curated roles are still readable", () => {
    assert.equal(semanticProfileFor("paddleocr-vl").profile?.role, "ocr_worker");
    assert.equal(semanticProfileFor("qwen2.5-vl-72b").profile?.role, "vision_worker");
    assert.equal(semanticProfileFor("granite-guardian-3.1-8b").profile?.role, "safety_classifier");
    assert.equal(semanticProfileFor("exaone-4.0-32b").profile?.role, "general_worker");
  });

  test("removing a profile does not flip a chat model's standing", () => {
    // The mutation the design has to survive: curation is not what admits a
    // model, so a model with no profile at all must land in the same place as
    // one with a profile whose role is a worker.
    const curated = poolEligibility({ modelId: "exaone-4.0-32b", modality: "chat" });
    const uncurated = poolEligibility({ modelId: "not-in-the-catalogue-at-all", modality: "chat" });
    assert.equal(curated.standing, uncurated.standing);
    assert.equal(curated.basis, uncurated.basis);
  });

  test("removing a profile does not flip a dedicated-endpoint model's standing", () => {
    const curated = poolEligibility({ modelId: "granite-guardian-3.1-8b", modality: "safety" });
    const uncurated = poolEligibility({ modelId: "nothing-written-about-this", modality: "safety" });
    assert.equal(curated.standing, "excluded");
    assert.equal(uncurated.standing, "excluded");
    assert.equal(uncurated.basis, "modality", "excluded by what it is, not by what was written");
  });
});

describe("permission is a fact about the key, not about the model", () => {
  test("a model this credential may not call is out of the pool", () => {
    // T1 found twelve of these, one of them `chat` modality. Without this it
    // was eligible: the catalogue says chat, nothing said we cannot call it.
    const result = poolEligibility({ modelId: "qwen3-32b", modality: "chat", permitted: false });
    assert.equal(result.standing, "excluded");
    assert.equal(result.basis, "invocation");
    assert.match(result.reason, /접근 권한/);
    assert.equal(inPool({ modelId: "qwen3-32b", modality: "chat", permitted: false }), false);
  });

  test("the refusal says it is about access rather than the model", () => {
    const denied = poolEligibility({ modelId: "m", modality: "chat", permitted: false });
    const cannotChat = poolEligibility({ modelId: "m", modality: "chat", converses: false });
    assert.notEqual(denied.reason, cannotChat.reason, "two different facts, two different reasons");
  });

  test("permission unknown is not permission denied", () => {
    assert.equal(poolEligibility({ modelId: "m", modality: "chat" }).standing, "eligible");
    assert.equal(
      poolEligibility({ modelId: "m", modality: "chat", permitted: true }).standing,
      "eligible",
    );
  });

  test("a model that answers chat and is vision is still unknown", () => {
    // The live probe settles this one: `paddleocr-vl` and `nemotron-omni-30b`
    // both answered a chat request with 200, so answering is not what tells an
    // OCR model from a multimodal coder. The measurement available does not
    // decide it, so it stays undecided rather than being guessed either way.
    const answered = poolEligibility({
      modelId: "nemotron-omni-30b",
      modality: "vision",
      converses: true,
      permitted: true,
    });
    assert.equal(answered.standing, "unknown");
  });
});
