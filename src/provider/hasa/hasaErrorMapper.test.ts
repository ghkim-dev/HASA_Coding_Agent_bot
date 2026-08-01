import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { HasaError, type ErrorKind } from "../../hasa-client/errors.ts";
import { ProviderError } from "../errors.ts";
import { mapHasaError, mapHasaErrorDetailed, parseAllowedModels } from "./hasaErrorMapper.ts";

function hasa(kind: ErrorKind, extra: Partial<ConstructorParameters<typeof HasaError>[0]> = {}): HasaError {
  return new HasaError({
    message: `HASA ${kind}`,
    kind,
    retryable: false,
    terminal: false,
    ...extra,
  });
}

describe("mapHasaError", () => {
  const cases: Array<[ErrorKind, string]> = [
    ["auth", "unauthorized"],
    ["forbidden", "forbidden"],
    ["not_found", "model_not_found"],
    ["rate_limit", "rate_limited"],
    ["unavailable", "unavailable"],
    ["server", "server_error"],
    ["client", "bad_request"],
    ["network", "network"],
    ["timeout", "timeout"],
    ["protocol", "protocol"],
  ];

  for (const [kind, code] of cases) {
    test(`${kind} becomes ${code}`, () => {
      assert.equal(mapHasaError(hasa(kind)).code, code);
    });
  }

  test("every code has a Korean message a non-specialist can act on", () => {
    for (const [kind] of cases) {
      const error = mapHasaError(hasa(kind));
      assert.ok(error.userMessage.length > 0);
      assert.doesNotMatch(error.userMessage, /undefined|\[object/);
    }
  });

  test("the transport's retry judgement is carried through", () => {
    const error = mapHasaError(hasa("rate_limit", { status: 429, retryable: true, retryAfterMs: 30_000 }));
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfterMs, 30_000);
    assert.equal(error.httpStatus, 429);
  });

  test("a caller's cancellation is not reported as a network fault", () => {
    // The transport sees an aborted fetch and calls it a terminal network
    // error, because from its side that is indistinguishable. Here the
    // difference matters: one is a failure, the other is a decision.
    const aborted = hasa("network", { retryable: false, terminal: true });
    assert.equal(mapHasaError(aborted).code, "aborted");

    const genuinelyDown = hasa("network", { retryable: true, terminal: false });
    assert.equal(mapHasaError(genuinelyDown).code, "network");
  });

  test("a timeout that the caller triggered is also a cancellation", () => {
    assert.equal(mapHasaError(hasa("timeout", { retryable: false, terminal: true })).code, "aborted");
    assert.equal(mapHasaError(hasa("timeout", { retryable: true, terminal: false })).code, "timeout");
  });

  test("an already-mapped error passes through unchanged", () => {
    const original = new ProviderError({ code: "config", detail: "x" });
    assert.equal(mapHasaError(original), original);
  });

  test("an unrecognised throwable still becomes a ProviderError", () => {
    const mapped = mapHasaError(new Error("something odd"));
    assert.ok(mapped instanceof ProviderError);
    assert.equal(mapped.code, "network");
  });
});

describe("403 handling", () => {
  test("names the models the key can actually use", () => {
    // Measured behaviour: HASA answers a forbidden model with the allow-list
    // for that key (docs/compatibility-matrix.md §8.2). It turns a dead end
    // into the one thing the user needs to know.
    const { error, allowedModels } = mapHasaErrorDetailed(
      hasa("forbidden", {
        status: 403,
        terminal: true,
        bodySnippet: '{"error":"model_not_on_key","allowed_models":["exaone-4.0-32b","gpt-oss-20b"]}',
      }),
    );

    assert.deepEqual(allowedModels, ["exaone-4.0-32b", "gpt-oss-20b"]);
    assert.match(error.userMessage, /exaone-4\.0-32b/);
    assert.match(error.userMessage, /gpt-oss-20b/);
  });

  test("falls back to a plain message when the body says nothing", () => {
    const { error, allowedModels } = mapHasaErrorDetailed(
      hasa("forbidden", { status: 403, bodySnippet: "model access denied for this key" }),
    );
    assert.equal(allowedModels, null);
    assert.match(error.userMessage, /다른 모델을 선택/);
  });

  test("never tells the user their key is invalid", () => {
    const { error } = mapHasaErrorDetailed(hasa("forbidden", { status: 403 }));
    assert.doesNotMatch(error.userMessage, /유효하지 않/);
  });
});

describe("parseAllowedModels", () => {
  test("reads a JSON array", () => {
    assert.deepEqual(parseAllowedModels('{"allowed_models": ["a", "b"]}'), ["a", "b"]);
  });

  test("reads an unquoted comma list", () => {
    assert.deepEqual(parseAllowedModels("allowed_models: bge-m3, exaone-4.0-32b]"), [
      "bge-m3",
      "exaone-4.0-32b",
    ]);
  });

  test("a quoted name truncated mid-word is simply not matched", () => {
    // Body snippets are cut at 200 characters. A closing quote is the proof
    // that a name arrived whole.
    const clipped = '{"allowed_models":["exaone-4.0-32b","gpt-oss-20b","qwen2.5-cod';
    assert.deepEqual(parseAllowedModels(clipped), ["exaone-4.0-32b", "gpt-oss-20b"]);
  });

  test("an unquoted list drops its last entry when the body was cut off", () => {
    // Nothing here says whether `qwen2.5-cod` is a whole name, and showing a
    // half name as fact sends the user looking for a model that does not exist.
    assert.deepEqual(parseAllowedModels("allowed_models: exaone-4.0-32b, gpt-oss-20b, qwen2.5-cod"), [
      "exaone-4.0-32b",
      "gpt-oss-20b",
    ]);
  });

  test("returns null when there is nothing to read", () => {
    assert.equal(parseAllowedModels(null), null);
    assert.equal(parseAllowedModels("model access denied"), null);
    assert.equal(parseAllowedModels('{"allowed_models": []}'), null);
  });

  test("de-duplicates", () => {
    assert.deepEqual(parseAllowedModels('{"allowed_models":["a","a","b"]}'), ["a", "b"]);
  });
});
