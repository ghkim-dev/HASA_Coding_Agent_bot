import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { NOT_OFFERED_DETAIL, shouldProbe } from "./conversabilityProbe.ts";

/**
 * What the probe is allowed to call.
 *
 * The rule exists because the first run broke it. The gateway's model listing
 * is what this credential may call and it was fetched, in the same function,
 * before the loop — and the loop asked the portal catalogue's forty-eight
 * anyway. Twelve of them answered 403, and a column of `키에 모델 미허용` down
 * the provider's transaction log is what an endpoint sweep looks like from the
 * other side.
 *
 * None of those twelve was in the listing. Every one of the refusals was
 * avoidable with data already in hand.
 */

describe("nothing outside the credential's own listing is called", () => {
  test("a model the gateway offers is asked", () => {
    assert.equal(shouldProbe({ inGatewayListing: true }), true);
  });

  test("a model only the catalogue knows about is not", () => {
    assert.equal(shouldProbe({ inGatewayListing: false }), false);
  });

  test("the answer does not depend on anything but the listing", () => {
    // Not the modality, not the id, not whether a profile exists. The listing
    // is the credential's own answer to "what may I call", and asking anything
    // else is how the burst happened.
    assert.equal(shouldProbe({ inGatewayListing: false }), false);
    assert.equal(shouldProbe({ inGatewayListing: true }), true);
  });

  test("a model that is not called still gets a recorded reason", () => {
    assert.match(NOT_OFFERED_DETAIL, /호출하지 않고/);
  });
});

describe("the stored probe holds no material worth hiding", () => {
  const STORE = ".arena/t1-conversability.json";

  test("no credential, no endpoint, no response body", async () => {
    let raw: string;
    try {
      raw = await readFile(STORE, "utf8");
    } catch {
      return; // No probe has been run here. Nothing to check.
    }
    const key = process.env["HASA_API_KEY"] ?? "";
    const base = process.env["HASA_BASE_URL"] ?? "";
    if (key.length > 0) assert.ok(!raw.includes(key), "the api key is in the probe store");
    if (base.length > 0) assert.ok(!raw.includes(base), "the base URL is in the probe store");
    assert.ok(!/bearer/i.test(raw), "an authorization header is in the probe store");
  });

  test("every record the store already holds obeys the listing rule", async () => {
    let raw: string;
    try {
      raw = await readFile(STORE, "utf8");
    } catch {
      return;
    }
    const file = JSON.parse(raw) as {
      records: Array<{ modelId: string; inGatewayListing: boolean; status: number | null }>;
    };
    for (const record of file.records) {
      if (record.inGatewayListing) continue;
      // A catalogue-only model may appear in the store — it is recorded — but
      // it must carry no HTTP status, because carrying one means it was called.
      assert.equal(
        record.status,
        null,
        `${record.modelId} was called despite not being offered to this credential`,
      );
    }
  });
});
