import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { dedupeModelIds } from "./cli.ts";

/**
 * Probing an id twice is not free.
 *
 * Each repeat is a full ladder of live inference requests against shared GPUs,
 * and the answer it produces overwrites the identical one already there. What
 * survives is a matrix with two rows for one model — which is how a summary
 * came to read "12/22 usable" for a gateway serving 21 models.
 */
describe("dedupeModelIds", () => {
  test("keeps every distinct id, in the order the gateway gave them", () => {
    // Order is the gateway's statement about its own catalogue, and the
    // validation ladder reads it as a preference. Sorting here would discard it.
    const { ids, duplicated } = dedupeModelIds(["c", "a", "b"]);
    assert.deepEqual(ids, ["c", "a", "b"]);
    assert.deepEqual(duplicated, []);
  });

  test("a repeated id is probed once and named once", () => {
    // Observed: GET /v1/models returned 22 records for 21 models.
    const { ids, duplicated } = dedupeModelIds(["Wan2.2-T2V", "wan2.2-i2v", "tts-ko", "wan2.2-i2v"]);
    assert.deepEqual(ids, ["Wan2.2-T2V", "wan2.2-i2v", "tts-ko"]);
    assert.deepEqual(duplicated, ["wan2.2-i2v"]);
  });

  test("the first occurrence is the one kept", () => {
    const { ids } = dedupeModelIds(["a", "b", "a"]);
    assert.deepEqual(ids, ["a", "b"]);
  });

  test("an id repeated many times is reported once, not once per repeat", () => {
    const { ids, duplicated } = dedupeModelIds(["a", "a", "a", "a"]);
    assert.deepEqual(ids, ["a"]);
    assert.deepEqual(duplicated, ["a"]);
  });

  test("two different repeats are both named", () => {
    const { duplicated } = dedupeModelIds(["a", "b", "a", "c", "b"]);
    assert.deepEqual(duplicated, ["a", "b"]);
  });

  test("ids that merely look alike are left alone", () => {
    // Case matters to the gateway: `Qwen-Image` and `qwen-image` are different
    // addresses, and folding them would drop a model that does exist.
    const { ids, duplicated } = dedupeModelIds(["Qwen-Image", "qwen-image", "Wan2.1-T2V", "Wan2.2-T2V"]);
    assert.equal(ids.length, 4);
    assert.deepEqual(duplicated, []);
  });

  test("a clean list is returned unchanged and reports nothing", () => {
    // The silence is the signal: an operator who fixes the catalogue should see
    // the warning stop, which only works if a healthy list is quiet.
    const input = ["qwen3-coder", "llama-3.3-70b", "exaone-4.0-32b"];
    const { ids, duplicated } = dedupeModelIds(input);
    assert.deepEqual(ids, input);
    assert.deepEqual(duplicated, []);
  });

  test("an empty list is not an error", () => {
    assert.deepEqual(dedupeModelIds([]), { ids: [], duplicated: [] });
  });

  test("the input is not mutated", () => {
    const input = ["a", "a", "b"];
    dedupeModelIds(input);
    assert.deepEqual(input, ["a", "a", "b"]);
  });
});
