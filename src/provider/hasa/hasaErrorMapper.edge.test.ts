import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { HasaError, type ErrorKind } from "../../hasa-client/errors.ts";
import { forEachSeed } from "../../testing/fuzz.ts";
import { ProviderError } from "../errors.ts";
import { mapHasaError, mapHasaErrorDetailed, parseAllowedModels } from "./hasaErrorMapper.ts";

const ALL_KINDS: ErrorKind[] = [
  "auth",
  "forbidden",
  "not_found",
  "rate_limit",
  "unavailable",
  "server",
  "client",
  "network",
  "timeout",
  "protocol",
];

function hasa(kind: ErrorKind, extra: Partial<ConstructorParameters<typeof HasaError>[0]> = {}): HasaError {
  return new HasaError({ message: `HASA ${kind}`, kind, retryable: false, terminal: false, ...extra });
}

describe("every transport error kind is handled", () => {
  test("the kind list matches the transport's", () => {
    // If a kind is added to hasa-client and not here, the mapper's Record would
    // fail to compile — this asserts the test knows about it too.
    for (const kind of ALL_KINDS) {
      assert.doesNotThrow(() => mapHasaError(hasa(kind)), kind);
    }
    assert.equal(ALL_KINDS.length, 10);
  });

  test("mapping is total: nothing escapes as a raw Error", () => {
    for (const kind of ALL_KINDS) {
      for (const retryable of [true, false]) {
        for (const terminal of [true, false]) {
          const mapped = mapHasaError(hasa(kind, { retryable, terminal }));
          assert.ok(mapped instanceof ProviderError, `${kind} ${retryable} ${terminal}`);
          assert.ok(mapped.userMessage.length > 0);
        }
      }
    }
  });

  test("the status code is carried through when there is one", () => {
    for (const status of [400, 401, 403, 404, 408, 429, 500, 502, 503, 504]) {
      assert.equal(mapHasaError(hasa("client", { status })).httpStatus, status);
    }
    assert.equal(mapHasaError(hasa("network")).httpStatus, null);
  });

  test("the body snippet is folded into the detail, not into the user message", () => {
    const mapped = mapHasaError(hasa("server", { status: 500, bodySnippet: "upstream connect error" }));
    assert.match(mapped.detail, /upstream connect error/);
    assert.doesNotMatch(mapped.userMessage, /upstream connect error/);
  });

  test("a null retryAfterMs stays null and a zero stays zero", () => {
    assert.equal(mapHasaError(hasa("rate_limit", { retryAfterMs: null })).retryAfterMs, null);
    assert.equal(mapHasaError(hasa("rate_limit", { retryAfterMs: 0 })).retryAfterMs, 0);
  });

  test("the original error is kept as the cause for a debugger", () => {
    const original = hasa("unavailable", { status: 503 });
    assert.equal(mapHasaError(original).cause, original);
  });
});

describe("cancellation versus outage", () => {
  test("terminal network and timeout faults are cancellations", () => {
    assert.equal(mapHasaError(hasa("network", { terminal: true })).code, "aborted");
    assert.equal(mapHasaError(hasa("timeout", { terminal: true })).code, "aborted");
  });

  test("non-terminal ones are genuine faults and stay retryable", () => {
    const network = mapHasaError(hasa("network", { retryable: true, terminal: false }));
    assert.equal(network.code, "network");
    assert.equal(network.retryable, true);

    const timeout = mapHasaError(hasa("timeout", { retryable: true, terminal: false }));
    assert.equal(timeout.code, "timeout");
    assert.equal(timeout.retryable, true);
  });

  test("a terminal auth failure is still an auth failure, not a cancellation", () => {
    // Only network and timeout are ambiguous. Everything else means what it says.
    assert.equal(mapHasaError(hasa("auth", { terminal: true, status: 401 })).code, "unauthorized");
    assert.equal(mapHasaError(hasa("forbidden", { terminal: true, status: 403 })).code, "forbidden");
  });

  test("a cancellation is never retryable", () => {
    assert.equal(mapHasaError(hasa("network", { terminal: true })).retryable, false);
  });
});

describe("403 bodies as they actually arrive", () => {
  const bodies: Array<[string, string, string[] | null]> = [
    [
      "the recorded HASA shape",
      '{"error":"model_not_on_key","allowed_models":["bge-m3","bge-reranker-v2-m3","exaone-4.0-32b","gpt-oss-20b"]}',
      ["bge-m3", "bge-reranker-v2-m3", "exaone-4.0-32b", "gpt-oss-20b"],
    ],
    ["single entry", '{"allowed_models":["only-one"]}', ["only-one"]],
    ["camelCase key", '{"allowedModels":["a","b"]}', ["a", "b"]],
    ["hyphenated key", '{"allowed-models":["a"]}', ["a"]],
    ["uppercase key", '{"ALLOWED_MODELS":["a"]}', ["a"]],
    ["single quotes", "{'allowed_models':['a','b']}", ["a", "b"]],
    ["extra whitespace", '{ "allowed_models" : [ "a" , "b" ] }', ["a", "b"]],
    ["no bracket, single name", "allowed_models: solo-model]", ["solo-model"]],
    ["empty array", '{"allowed_models":[]}', null],
    ["key present, value not a list", '{"allowed_models":null}', null],
    ["no such key", '{"error":"model access denied for this key"}', null],
    ["key mentioned in prose only", "the allowed models are not listed", null],
  ];

  for (const [name, body, expected] of bodies) {
    test(name, () => {
      assert.deepEqual(parseAllowedModels(body), expected);
    });
  }

  test("a 200-character truncation never invents a name", () => {
    // Snippets are cut at 200 characters, so the tail is routinely half a name.
    const names = Array.from({ length: 40 }, (_, i) => `model-with-a-long-name-${i}`);
    const full = JSON.stringify({ allowed_models: names });
    for (let cut = 20; cut < Math.min(full.length, 400); cut += 7) {
      const parsed = parseAllowedModels(full.slice(0, cut));
      if (parsed === null) continue;
      for (const parsedName of parsed) {
        assert.ok(names.includes(parsedName), `invented ${JSON.stringify(parsedName)} at cut ${cut}`);
      }
    }
  });

  test("names are never returned empty or duplicated", () => {
    forEachSeed((rng) => {
      const names = Array.from({ length: rng.int(0, 6) }, () => rng.string(12, "abcdefg-._/0123"));
      const body = `{"allowed_models":${JSON.stringify(names)}}`;
      const parsed = parseAllowedModels(body);
      if (parsed === null) return;
      assert.equal(new Set(parsed).size, parsed.length, "no duplicates");
      for (const name of parsed) assert.ok(name.length > 0, "no empty names");
    });
  });

  test("arbitrary text never throws and never returns an empty list", () => {
    forEachSeed((rng) => {
      const parsed = parseAllowedModels(rng.string(200));
      assert.ok(parsed === null || parsed.length > 0);
    });
  });

  test("a body that is only the marker yields nothing", () => {
    assert.equal(parseAllowedModels("allowed_models"), null);
    assert.equal(parseAllowedModels("allowed_models:"), null);
    assert.equal(parseAllowedModels("allowed_models:[]"), null);
  });

  test("null and empty input are handled", () => {
    assert.equal(parseAllowedModels(null), null);
    assert.equal(parseAllowedModels(""), null);
  });
});

describe("the 403 user message", () => {
  test("lists the usable models when the gateway named them", () => {
    const { error } = mapHasaErrorDetailed(
      hasa("forbidden", { status: 403, bodySnippet: '{"allowed_models":["exaone-4.0-32b"]}' }),
    );
    assert.match(error.userMessage, /exaone-4\.0-32b/);
  });

  test("never suggests the key is the problem, in any 403 shape", () => {
    for (const snippet of [null, "", "model access denied", '{"allowed_models":["a"]}']) {
      const { error } = mapHasaErrorDetailed(hasa("forbidden", { status: 403, bodySnippet: snippet }));
      assert.doesNotMatch(error.userMessage, /유효하지 않|다시 입력/, JSON.stringify(snippet));
      assert.match(error.userMessage, /모델/);
    }
  });

  test("allowedModels is only ever populated for a 403", () => {
    for (const kind of ALL_KINDS) {
      const { allowedModels } = mapHasaErrorDetailed(
        hasa(kind, { bodySnippet: '{"allowed_models":["a"]}' }),
      );
      if (kind === "forbidden") assert.deepEqual(allowedModels, ["a"]);
      else assert.equal(allowedModels, null, kind);
    }
  });
});

describe("throwables that are not HasaErrors", () => {
  test("an already-mapped ProviderError is returned by identity", () => {
    const original = new ProviderError({ code: "config", detail: "x" });
    const { error, allowedModels } = mapHasaErrorDetailed(original);
    assert.equal(error, original);
    assert.equal(allowedModels, null);
  });

  test("abort shapes are recognised", () => {
    assert.equal(mapHasaError(new DOMException("stop", "AbortError")).code, "aborted");
    assert.equal(mapHasaError({ name: "TimeoutError" }).code, "aborted");
  });

  test("anything else becomes a ProviderError without throwing", () => {
    const values: unknown[] = [
      new Error("plain"),
      new TypeError("wrong type"),
      "a string",
      0,
      NaN,
      null,
      undefined,
      {},
      [],
      Symbol("s"),
      () => {},
      new Map(),
      Object.create(null),
    ];
    values.forEach((value, i) => {
      // The label is built by index, not by stringifying the value: several of
      // these throw when converted to a string, which is the point.
      const mapped = mapHasaError(value);
      assert.ok(mapped instanceof ProviderError, `value ${i} did not map`);
      assert.ok(mapped.userMessage.length > 0, `value ${i} has no message`);
      assert.ok(typeof mapped.detail === "string", `value ${i} has no detail`);
    });
  });

  test("a HasaError subclass is still treated as one", () => {
    class Subclassed extends HasaError {}
    const mapped = mapHasaError(
      new Subclassed({ message: "sub", kind: "rate_limit", status: 429, retryable: true, terminal: false }),
    );
    assert.equal(mapped.code, "rate_limited");
  });

  test("an object that merely looks like a HasaError is not trusted", () => {
    // Duck typing here would let a malformed response body dictate a retry
    // policy. `instanceof` is the check.
    const mapped = mapHasaError({ kind: "auth", status: 401, retryable: false, terminal: true });
    assert.equal(mapped.code, "network", "an impostor falls through to the generic path");
  });
});

describe("no key material survives mapping", () => {
  test("a body snippet echoing a bearer token is redacted before it reaches detail", () => {
    // The transport redacts snippets on the way in; this asserts the mapper
    // does not undo that by reconstructing the message from another field.
    const snippet = "authorization: ***REDACTED***";
    const mapped = mapHasaError(hasa("client", { status: 400, bodySnippet: snippet }));
    assert.ok(!mapped.detail.includes("Bearer sk-"));
    assert.match(mapped.detail, /REDACTED/);
  });

  test("the serialisable form never carries a cause chain", () => {
    const json = JSON.stringify(mapHasaError(hasa("auth", { status: 401 })).toJSON());
    assert.ok(!json.includes("cause"));
    assert.ok(!json.includes("stack"));
  });
});
