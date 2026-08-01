import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { nullLogger } from "../../hasa-client/logger.ts";
import { MemoryModelCache } from "../modelCache.ts";
import { HasaProvider } from "./hasaProvider.ts";

/**
 * Opt-in checks against the real gateway.
 *
 * These run only when `HASA_API_KEY` is present, and are skipped otherwise —
 * including in CI, which must never need a credential to go green. Everything
 * that can be asserted without a live key is asserted in `hasaProvider.test.ts`
 * against the in-process mock; what is left here is the small set of facts only
 * the real service can confirm.
 *
 *   HASA_API_KEY=… node --test src/provider/hasa/hasaProvider.integration.test.ts
 */

const apiKey = process.env["HASA_API_KEY"] ?? "";
const skip = apiKey.length === 0 ? "HASA_API_KEY is not set" : false;

function provider(): HasaProvider {
  const opts: ConstructorParameters<typeof HasaProvider>[0] = {
    apiKey,
    cache: new MemoryModelCache(),
    logger: nullLogger,
  };
  const baseUrl = process.env["HASA_BASE_URL"];
  if (baseUrl !== undefined && baseUrl.length > 0) opts.baseUrl = baseUrl;
  return new HasaProvider(opts);
}

describe("HasaProvider against open.hasa.re.kr", { skip }, () => {
  test("lists a non-empty catalogue", async () => {
    const listing = await provider().listModels();
    assert.ok(listing.models.length > 0, "the gateway returned no models");
    assert.equal(listing.source, "network");
  });

  test("validates the credential separately from reachability", async () => {
    const result = await provider().validate();
    assert.equal(result.endpointReachable, true);
    assert.equal(result.credentialValid, true, result.detail);
  });

  test("a 403 names the models the key can reach", async () => {
    // The most useful thing a rejection can carry. Verified live because the
    // body is truncated on the way through, and a list cut off after two of
    // six entries reads as a shorter allow-list rather than a clipped one.
    const p = provider();
    const listing = await p.listModels();
    const denied = listing.models.find((m) => m.id === "qwen3-coder") ?? listing.models[0];
    assert.ok(denied !== undefined);

    try {
      await p.chat(
        { modelId: denied.id, messages: [{ role: "user", content: "ping" }], maxOutputTokens: 1 },
        { maxRetries: 0 },
      );
    } catch (err) {
      const error = err as { code?: string; allowedModels?: string[] | null };
      if (error.code !== "forbidden") return; // the key can reach this one; nothing to check
      assert.ok(error.allowedModels !== null && error.allowedModels !== undefined);
      assert.ok(error.allowedModels.length >= 3, `only ${error.allowedModels.length} models survived truncation`);
    }
  });

  test("streams from a model the key can actually reach", async () => {
    const p = provider();
    const validation = await p.validate();
    // `usableModelId`, not `probedModelId`: the latter is only what validation
    // tried, and against this gateway that is routinely a model the key cannot
    // call — or an embedding model that answers /chat/completions with a 404.
    const modelId = validation.usableModelId;
    assert.ok(modelId !== null, `no usable model found: ${validation.detail}`);

    let text = "";
    let done = 0;
    for await (const event of p.stream({
      modelId,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      maxOutputTokens: 1024,
    })) {
      if (event.type === "text") text += event.delta;
      if (event.type === "done") done += 1;
    }

    assert.equal(done, 1, "exactly one done event");
    assert.ok(text.trim().length > 0, "the stream produced no text");
  });
});
