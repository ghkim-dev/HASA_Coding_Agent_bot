import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { unknownCapabilities, type ModelCapabilities, type ProviderModel } from "../provider/types.ts";
import { chooseModel, rankModels, requirementFor } from "./autoModel.ts";
import { AGENT_MODES } from "./types.ts";

/**
 * What "✨ Auto" picks.
 *
 * The failure this guards against is specific: a model without tool calling
 * accepts a CODE request and then *describes* the change instead of making it.
 * Nothing errors, the user gets prose where they expected a diff, and the agent
 * looks broken. So a model measured as unable to code is never offered for a
 * mode that codes.
 */

function model(
  id: string,
  caps: Partial<ModelCapabilities> = {},
  maxOutputTokens: number | null = null,
): ProviderModel {
  return {
    id,
    ownedBy: null,
    capabilities: { ...unknownCapabilities(), ...caps },
    limits: { maxOutputTokens, contextWindow: null },
  };
}

/** The catalogue this key actually has, as measured on 2026-08-01. */
const REAL_CATALOGUE: ProviderModel[] = [
  model("bge-m3", { chat: false, coding: false }),
  model("bge-reranker-v2-m3", { chat: false, coding: false }),
  model("exaone-4.0-32b", { chat: true, streaming: true, toolCalling: true, coding: true }, 32768),
  model("gpt-oss-20b", { chat: true, streaming: true, toolCalling: true, coding: true }, 32768),
  model("granite-guardian-3.1-8b", { chat: true, streaming: true, toolCalling: false, coding: false }, 4096),
  model("qwen2.5-coder-32b", { chat: true, streaming: true, toolCalling: false, coding: false }, 32768),
];

describe("what each mode needs", () => {
  test("modes that write need tool calling; modes that read need chat", () => {
    assert.equal(requirementFor("code"), "coding");
    assert.equal(requirementFor("debug"), "coding");
    assert.equal(requirementFor("architect"), "chat");
    assert.equal(requirementFor("ask"), "chat");
  });

  test("every mode has a requirement", () => {
    for (const mode of AGENT_MODES) {
      assert.ok(["coding", "chat"].includes(requirementFor(mode)), mode);
    }
  });
});

describe("ranking", () => {
  test("a model that cannot chat is dropped — there is nothing to talk to", () => {
    const ranked = rankModels(REAL_CATALOGUE, "code").map((m) => m.id);
    assert.ok(!ranked.includes("bge-m3"));
    assert.ok(!ranked.includes("bge-reranker-v2-m3"));
  });

  test("a model whose gateway blocks tool calls is still offered, but ranked below", () => {
    // It is the deployment that refuses, not the model, and the text protocol
    // works. Dropping it would make the best coding model on the key unusable
    // because of a flag nobody here can set.
    const ranked = rankModels(REAL_CATALOGUE, "code").map((m) => m.id);
    assert.deepEqual(ranked, [
      "exaone-4.0-32b",
      "gpt-oss-20b",
      "qwen2.5-coder-32b",
      "granite-guardian-3.1-8b",
    ]);
  });

  test("the name is never the evidence", () => {
    // `qwen2.5-coder-32b` is the most coder-sounding id in the catalogue and
    // still ranks below two models with measured native tool calling.
    const ranked = rankModels(REAL_CATALOGUE, "code").map((m) => m.id);
    assert.ok(ranked.indexOf("qwen2.5-coder-32b") > ranked.indexOf("exaone-4.0-32b"));
    assert.ok(ranked.indexOf("qwen2.5-coder-32b") > ranked.indexOf("gpt-oss-20b"));
  });

  test("a chat-only mode keeps the chat models the coding mode dropped", () => {
    const ranked = rankModels(REAL_CATALOGUE, "ask").map((m) => m.id);
    assert.ok(ranked.includes("qwen2.5-coder-32b"));
    assert.ok(ranked.includes("granite-guardian-3.1-8b"));
    assert.ok(!ranked.includes("bge-m3"), "an embedding model cannot chat");
  });

  test("measured capability outranks an unmeasured model", () => {
    const ranked = rankModels(
      [model("unknown-one"), model("measured", { coding: true })],
      "code",
    ).map((m) => m.id);
    assert.deepEqual(ranked, ["measured", "unknown-one"]);
  });

  test("among equals, the larger output ceiling wins", () => {
    // A 4096-token cap truncates real edits, and a truncated patch is worse
    // than a slower one.
    const ranked = rankModels(
      [model("small", { coding: true }, 4096), model("large", { coding: true }, 32768)],
      "code",
    ).map((m) => m.id);
    assert.deepEqual(ranked, ["large", "small"]);
  });

  test("otherwise the gateway's own order is kept, so the pick is stable", () => {
    const ranked = rankModels([model("b", { coding: true }), model("a", { coding: true })], "code");
    assert.deepEqual(ranked.map((m) => m.id), ["b", "a"]);
  });

  test("an empty catalogue ranks to nothing", () => {
    assert.deepEqual(rankModels([], "code"), []);
  });
});

describe("choosing without measuring", () => {
  test("picks a model already known to fit, and says it is confirmed", async () => {
    const choice = await chooseModel({ models: REAL_CATALOGUE, mode: "code" });
    assert.equal(choice?.modelId, "exaone-4.0-32b");
    assert.equal(choice?.confidence, "measured");
    assert.equal(choice?.toolProtocol, "native");
    assert.match(choice?.reason ?? "", /확인된/);
  });

  test("returns nothing when every model is ruled out", async () => {
    // Better than silently selecting a reranker.
    const embeddingsOnly = REAL_CATALOGUE.slice(0, 2);
    assert.equal(await chooseModel({ models: embeddingsOnly, mode: "code" }), null);
  });

  test("falls back to the text protocol when no model calls tools natively", async () => {
    // The whole reason the fallback exists: this key's strongest coding model
    // sits behind a gateway started without --tool-call-parser.
    const blocked = REAL_CATALOGUE.filter((m) => m.capabilities.coding !== true);
    const choice = await chooseModel({ models: blocked, mode: "code" });

    assert.equal(choice?.modelId, "qwen2.5-coder-32b");
    assert.equal(choice?.toolProtocol, "text");
    assert.equal(choice?.confidence, "measured", "the gateway's refusal is a measurement, not a gap");
    assert.match(choice?.reason ?? "", /호환 방식/);
  });

  test("the text fallback costs no probes — the answer is already known", async () => {
    let probes = 0;
    const blocked = REAL_CATALOGUE.filter((m) => m.capabilities.coding !== true);
    await chooseModel({
      models: blocked,
      mode: "code",
      measure: async () => {
        probes += 1;
        return unknownCapabilities();
      },
    });
    assert.equal(probes, 0);
  });

  test("native is always preferred when both are available", async () => {
    const choice = await chooseModel({ models: REAL_CATALOGUE, mode: "code" });
    assert.equal(choice?.toolProtocol, "native");
  });

  test("an empty catalogue yields nothing", async () => {
    assert.equal(await chooseModel({ models: [], mode: "code" }), null);
  });

  test("with nothing measured it still starts, and says the pick is unverified", async () => {
    // A fresh install has measured nothing. Refusing to begin would be worse
    // than beginning with a caveat.
    const fresh = [model("a"), model("b")];
    const choice = await chooseModel({ models: fresh, mode: "code" });

    assert.equal(choice?.modelId, "a");
    assert.equal(choice?.confidence, "unverified");
    assert.match(choice?.reason ?? "", /확인되지 않은/);
    assert.match(choice?.reason ?? "", /다른 모델을 선택/, "and says what to do about it");
  });
});

describe("choosing with measurement", () => {
  test("measures only until something fits", async () => {
    const probed: string[] = [];
    const choice = await chooseModel({
      models: [model("a"), model("b"), model("c")],
      mode: "code",
      measure: async (id) => {
        probed.push(id);
        return { ...unknownCapabilities(), coding: id === "b" };
      },
    });

    assert.equal(choice?.modelId, "b");
    assert.equal(choice?.confidence, "measured");
    assert.deepEqual(probed, ["a", "b"], "it stops as soon as one fits");
  });

  test("the probe budget is small, because each one is a real request", async () => {
    const probed: string[] = [];
    const many = Array.from({ length: 19 }, (_, i) => model(`m${i}`));
    await chooseModel({
      models: many,
      mode: "code",
      measure: async (id) => {
        probed.push(id);
        return unknownCapabilities();
      },
    });
    assert.equal(probed.length, 3, "19 models must not become 19 inference requests");
  });

  test("a model the credential check already reached is measured first", async () => {
    // The key is known to work for it, so it is the cheapest thing to try.
    const probed: string[] = [];
    await chooseModel({
      models: [model("a"), model("b"), model("c")],
      mode: "code",
      knownUsableModelId: "c",
      measure: async (id) => {
        probed.push(id);
        return unknownCapabilities();
      },
    });
    assert.equal(probed[0], "c");
  });

  test("nothing is measured when the catalogue already answers the question", async () => {
    let probes = 0;
    await chooseModel({
      models: REAL_CATALOGUE,
      mode: "code",
      measure: async () => {
        probes += 1;
        return unknownCapabilities();
      },
    });
    assert.equal(probes, 0);
  });

  test("a model that cannot be measured is skipped, not fatal", async () => {
    const choice = await chooseModel({
      models: [model("broken"), model("fine")],
      mode: "code",
      measure: async (id) => {
        if (id === "broken") throw new Error("503");
        return { ...unknownCapabilities(), coding: true };
      },
    });
    assert.equal(choice?.modelId, "fine");
  });

  test("when measuring proves nothing, the best guess is still offered", async () => {
    const choice = await chooseModel({
      models: [model("a"), model("b")],
      mode: "code",
      measure: async () => unknownCapabilities(),
    });
    assert.equal(choice?.confidence, "unverified");
    assert.equal(choice?.modelId, "a");
  });

  test("a measurement that rules a model out removes it from consideration", async () => {
    const choice = await chooseModel({
      models: [model("a"), model("b")],
      mode: "code",
      measure: async (id) => ({ ...unknownCapabilities(), coding: id === "b" }),
    });
    assert.equal(choice?.modelId, "b");
  });

  test("an aborted choice stops measuring", async () => {
    const controller = new AbortController();
    let probes = 0;
    await chooseModel({
      models: [model("a"), model("b"), model("c")],
      mode: "code",
      signal: controller.signal,
      measure: async () => {
        probes += 1;
        controller.abort();
        return unknownCapabilities();
      },
    });
    assert.equal(probes, 1);
  });
});

describe("the real catalogue, per mode", () => {
  test("CODE and DEBUG get a model that can actually call tools", async () => {
    for (const mode of ["code", "debug"] as const) {
      const choice = await chooseModel({ models: REAL_CATALOGUE, mode });
      assert.ok(choice !== null, mode);
      const chosen = REAL_CATALOGUE.find((m) => m.id === choice.modelId);
      assert.equal(chosen?.capabilities.coding, true, `${mode} chose a model that cannot code`);
    }
  });

  test("ASK and ARCHITECT may use a chat model that cannot call tools", async () => {
    for (const mode of ["ask", "architect"] as const) {
      const choice = await chooseModel({ models: REAL_CATALOGUE, mode });
      assert.ok(choice !== null, mode);
      const chosen = REAL_CATALOGUE.find((m) => m.id === choice.modelId);
      assert.notEqual(chosen?.capabilities.chat, false, `${mode} chose a model that cannot chat`);
    }
  });

  test("no mode ever picks an embedding or reranking model", async () => {
    for (const mode of AGENT_MODES) {
      const choice = await chooseModel({ models: REAL_CATALOGUE, mode });
      assert.ok(!choice?.modelId.startsWith("bge-"), `${mode} picked ${choice?.modelId}`);
    }
  });

  test("every reason is written for the user", async () => {
    for (const mode of AGENT_MODES) {
      const choice = await chooseModel({ models: REAL_CATALOGUE, mode });
      assert.match(choice?.reason ?? "", /[가-힣]/, mode);
      assert.doesNotMatch(choice?.reason ?? "", /tool|capability|token/i, mode);
    }
  });
});
