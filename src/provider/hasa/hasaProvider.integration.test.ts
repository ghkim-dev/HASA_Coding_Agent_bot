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

  test("rejects a wrong key even though the model list is public", async () => {
    const wrong = new HasaProvider({
      apiKey: `${apiKey}-definitely-not-valid`,
      cache: new MemoryModelCache(),
      logger: nullLogger,
    });
    const result = await wrong.validate();

    assert.equal(result.endpointReachable, true, "the model list is public and should still answer");
    assert.notEqual(result.credentialValid, true);
  });

  test("streams from a model the key can actually reach", async () => {
    const p = provider();
    const validation = await p.validate();
    const modelId = validation.probedModelId;
    assert.ok(modelId !== null, "no reachable model to stream from");

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
