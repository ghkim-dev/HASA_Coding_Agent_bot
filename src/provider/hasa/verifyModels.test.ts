import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { unknownCapabilities, type ModelCapabilities, type ProviderModel } from "../types.ts";
import { candidatesFor, describeVerification, verifyModels } from "./verifyModels.ts";

/**
 * Measuring what a key can reach.
 *
 * The failure this answers is one a user hit: every model labelled
 * "확인되지 않음" while they had full access to four of them. Nothing was
 * broken — nothing had been measured, and there was no way to ask.
 */

function model(id: string, caps: Partial<ModelCapabilities> = {}): ProviderModel {
  return {
    id,
    ownedBy: null,
    capabilities: { ...unknownCapabilities(), ...caps },
    limits: { maxOutputTokens: null, contextWindow: null },
  };
}

/** The catalogue this key sees, and the six it may actually call. */
const CATALOGUE = [
  "qwen3-coder",
  "llama-3.3-70b",
  "exaone-4.0-32b",
  "gpt-oss-20b",
  "qwen2.5-coder-32b",
  "granite-guardian-3.1-8b",
  "bge-m3",
  "bge-reranker-v2-m3",
  "Wan2.1-T2V",
].map((id) => model(id));

const ALLOWED = [
  "bge-m3",
  "bge-reranker-v2-m3",
  "exaone-4.0-32b",
  "gpt-oss-20b",
  "granite-guardian-3.1-8b",
  "qwen2.5-coder-32b",
];

describe("choosing what to measure", () => {
  test("the allow-list wins, because everything outside it answers 403", () => {
    // A 403 says nothing about a model's capabilities, so the request buys
    // nothing but a strike against the clock.
    const chosen = candidatesFor(CATALOGUE, ALLOWED).map((m) => m.id);
    assert.deepEqual(chosen.sort(), [...ALLOWED].sort());
    assert.ok(!chosen.includes("qwen3-coder"), "a model this key cannot call is not measured");
  });

  test("without an allow-list the whole catalogue is a candidate, but bounded", () => {
    const chosen = candidatesFor(CATALOGUE, null, 4);
    assert.equal(chosen.length, 4);
  });

  test("an empty allow-list is treated as no information rather than as nothing allowed", () => {
    // A gateway that returns `allowed_models: []` has told us nothing useful,
    // and measuring nothing would leave the picker exactly as it was.
    assert.equal(candidatesFor(CATALOGUE, []).length, Math.min(CATALOGUE.length, 12));
  });

  test("an allow-list naming models the catalogue does not have is ignored for those", () => {
    const chosen = candidatesFor(CATALOGUE, ["exaone-4.0-32b", "not-in-catalogue"]).map((m) => m.id);
    assert.deepEqual(chosen, ["exaone-4.0-32b"]);
  });

  test("an empty catalogue asks for nothing", () => {
    assert.deepEqual(candidatesFor([], ALLOWED), []);
  });
});

describe("measuring", () => {
  test("measures each candidate once and reports what it found", async () => {
    const asked: string[] = [];
    const result = await verifyModels({
      models: CATALOGUE,
      allowedModels: ALLOWED,
      measure: async (id) => {
        asked.push(id);
        return { ...unknownCapabilities(), chat: !id.startsWith("bge-"), coding: id === "exaone-4.0-32b" };
      },
    });

    assert.equal(asked.length, ALLOWED.length);
    assert.equal(new Set(asked).size, asked.length, "no model is measured twice");
    assert.equal(result.models.filter((m) => m.capabilities.chat === true).length, 4);
  });

  test("thirteen models the key cannot call cost nothing", async () => {
    let requests = 0;
    const result = await verifyModels({
      models: CATALOGUE,
      allowedModels: ALLOWED,
      measure: async () => {
        requests += 1;
        return unknownCapabilities();
      },
    });
    assert.equal(requests, 6);
    assert.equal(result.skipped, CATALOGUE.length - 6);
  });

  test("a model that cannot be measured is not recorded as incapable", async () => {
    // Recording an outage as a verdict is the mistake the tristate exists to
    // prevent — it would outlive the outage.
    const result = await verifyModels({
      models: [model("up"), model("down")],
      allowedModels: null,
      measure: async (id) => {
        if (id === "down") throw new Error("503");
        return { ...unknownCapabilities(), chat: true };
      },
    });

    const down = result.models.find((m) => m.modelId === "down");
    assert.equal(down?.measured, false);
    assert.equal(down?.capabilities.chat, "unknown", "not false");
  });

  test("progress is reported per model and once at the end", async () => {
    const seen: Array<{ done: number; total: number }> = [];
    await verifyModels({
      models: CATALOGUE,
      allowedModels: ALLOWED,
      measure: async () => unknownCapabilities(),
      onProgress: (p) => seen.push({ done: p.done, total: p.total }),
    });

    assert.equal(seen.length, ALLOWED.length + 1);
    assert.deepEqual(seen.at(-1), { done: ALLOWED.length, total: ALLOWED.length });
  });

  test("measurement is sequential, because these share GPU backends", async () => {
    // The recorded probe saw 503s at a concurrency of three.
    let inFlight = 0;
    let peak = 0;
    await verifyModels({
      models: CATALOGUE,
      allowedModels: ALLOWED,
      measure: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return unknownCapabilities();
      },
    });
    assert.equal(peak, 1);
  });

  test("cancelling stops rather than finishing the list", async () => {
    const controller = new AbortController();
    let requests = 0;
    await verifyModels({
      models: CATALOGUE,
      allowedModels: ALLOWED,
      signal: controller.signal,
      measure: async () => {
        requests += 1;
        controller.abort();
        return unknownCapabilities();
      },
    });
    assert.equal(requests, 1);
  });
});

describe("what the user is told", () => {
  test("counts what can be used, and what can code", async () => {
    const result = await verifyModels({
      models: CATALOGUE,
      allowedModels: ALLOWED,
      measure: async (id) => ({
        ...unknownCapabilities(),
        chat: !id.startsWith("bge-"),
        coding: id === "exaone-4.0-32b" || id === "gpt-oss-20b",
        toolCalling: id === "exaone-4.0-32b" || id === "gpt-oss-20b",
      }),
    });

    const text = describeVerification(result);
    assert.match(text, /4개 모델을 사용할 수 있습니다/);
    assert.match(text, /2개는 코드를 직접 수정/);
    assert.match(text, /권한이 없는 3개는 확인하지 않았습니다/);
  });

  test("says when a model works through the compatibility path", async () => {
    const result = await verifyModels({
      models: [model("blocked")],
      allowedModels: null,
      measure: async () => ({ ...unknownCapabilities(), chat: true, toolCalling: false }),
    });
    assert.match(describeVerification(result), /호환 방식/);
  });

  test("says plainly when nothing could be measured", async () => {
    const result = await verifyModels({
      models: [model("a")],
      allowedModels: null,
      measure: async () => {
        throw new Error("503");
      },
    });
    assert.match(describeVerification(result), /확인하지 못했습니다/);
  });

  test("every message is written for the user", async () => {
    const result = await verifyModels({
      models: CATALOGUE,
      allowedModels: ALLOWED,
      measure: async () => ({ ...unknownCapabilities(), chat: true }),
    });
    const text = describeVerification(result);
    assert.match(text, /[가-힣]/);
    assert.doesNotMatch(text, /capability|tool_call|probe/i);
  });
});
