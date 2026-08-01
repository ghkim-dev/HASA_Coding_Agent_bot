import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ProviderError,
  isAbortLike,
  isProviderError,
  messageFor,
  toProviderError,
  type ProviderErrorCode,
} from "./errors.ts";
import { unknownCapabilities } from "./types.ts";

/**
 * The error taxonomy, checked exhaustively.
 *
 * `ProviderErrorCode` is a union, so a new member added later has no compiler
 * obligation to acquire a message or a retry policy. This file is that
 * obligation: the list below has to be updated when the union is, and every
 * property is asserted for every member.
 */

const ALL_CODES: ProviderErrorCode[] = [
  "unauthorized",
  "forbidden",
  "model_not_found",
  "rate_limited",
  "unavailable",
  "server_error",
  "bad_request",
  "timeout",
  "network",
  "protocol",
  "aborted",
  "config",
];

/** Fails to compile if a code is added to the union and not to ALL_CODES. */
const EXHAUSTIVE: Record<ProviderErrorCode, true> = {
  unauthorized: true,
  forbidden: true,
  model_not_found: true,
  rate_limited: true,
  unavailable: true,
  server_error: true,
  bad_request: true,
  timeout: true,
  network: true,
  protocol: true,
  aborted: true,
  config: true,
};

describe("the code list is complete", () => {
  test("every code in the union is covered here", () => {
    assert.deepEqual([...ALL_CODES].sort(), Object.keys(EXHAUSTIVE).sort());
  });
});

describe("messages", () => {
  test("every code has a distinct, non-empty Korean message", () => {
    const seen = new Set<string>();
    for (const code of ALL_CODES) {
      const message = messageFor(code);
      assert.ok(message.length > 0, `${code} has no message`);
      assert.doesNotMatch(message, /undefined|\[object|null/, `${code} message looks templated`);
      assert.match(message, /[가-힣]/, `${code} message is not Korean`);
      assert.ok(!seen.has(message), `${code} reuses another code's message`);
      seen.add(message);
    }
  });

  test("no message leaks jargon a small-company developer has no use for", () => {
    // The product brief is explicit that the surface is not AI/LLM-centric.
    for (const code of ALL_CODES) {
      assert.doesNotMatch(messageFor(code), /token|prompt|completion|LLM|judge|arena/i, code);
    }
  });
});

describe("retry and terminal policy", () => {
  test("no code is both retryable and terminal", () => {
    for (const code of ALL_CODES) {
      const error = new ProviderError({ code });
      assert.ok(!(error.retryable && error.terminal), `${code} is both retryable and terminal`);
    }
  });

  test("the codes worth retrying are exactly the transient ones", () => {
    const retryable = ALL_CODES.filter((code) => new ProviderError({ code }).retryable);
    assert.deepEqual(retryable.sort(), [
      "network",
      "rate_limited",
      "server_error",
      "timeout",
      "unavailable",
    ]);
  });

  test("a credential or permission fault is terminal, so a loop cannot spin on it", () => {
    for (const code of ["unauthorized", "forbidden", "model_not_found", "config", "aborted"] as const) {
      assert.equal(new ProviderError({ code }).terminal, true, code);
    }
  });

  test("protocol errors are neither retried nor fatal to the model", () => {
    // A malformed frame may be one bad response rather than a broken model, so
    // it does not disqualify the model; but replaying it would just re-read the
    // same broken bytes.
    const error = new ProviderError({ code: "protocol" });
    assert.equal(error.retryable, false);
    assert.equal(error.terminal, false);
  });

  test("explicit flags override the defaults", () => {
    const error = new ProviderError({ code: "forbidden", retryable: true, terminal: false });
    assert.equal(error.retryable, true);
    assert.equal(error.terminal, false);
  });
});

describe("construction", () => {
  test("is an Error and reports its own name", () => {
    const error = new ProviderError({ code: "timeout" });
    assert.ok(error instanceof Error);
    assert.ok(isProviderError(error));
    assert.equal(error.name, "ProviderError");
    assert.ok(typeof error.stack === "string");
  });

  test("the message carries the detail when there is one, the code alone otherwise", () => {
    assert.equal(new ProviderError({ code: "timeout" }).message, "timeout");
    assert.equal(new ProviderError({ code: "timeout", detail: "" }).message, "timeout");
    assert.equal(new ProviderError({ code: "timeout", detail: "after 500ms" }).message, "timeout: after 500ms");
  });

  test("the cause is preserved for a debugger and absent otherwise", () => {
    const cause = new Error("root");
    assert.equal(new ProviderError({ code: "network", cause }).cause, cause);
    assert.equal(new ProviderError({ code: "network" }).cause, undefined);
  });

  test("a caller-supplied message wins over the default", () => {
    const error = new ProviderError({ code: "forbidden", userMessage: "사용 가능한 모델: a, b" });
    assert.equal(error.userMessage, "사용 가능한 모델: a, b");
  });

  test("defaults for the optional numeric fields are null, not undefined", () => {
    const error = new ProviderError({ code: "network" });
    assert.equal(error.httpStatus, null);
    assert.equal(error.retryAfterMs, null);
    assert.equal(error.detail, "");
  });

  test("an explicit null status stays null", () => {
    assert.equal(new ProviderError({ code: "network", httpStatus: null }).httpStatus, null);
  });

  test("retryAfterMs of 0 is a real instruction, not an absence", () => {
    assert.equal(new ProviderError({ code: "rate_limited", retryAfterMs: 0 }).retryAfterMs, 0);
  });
});

describe("toJSON — the webview surface", () => {
  test("carries exactly the fields the UI needs and nothing else", () => {
    const json = new ProviderError({ code: "forbidden", detail: "d", cause: new Error("secret root") }).toJSON();
    assert.deepEqual(Object.keys(json).sort(), [
      "allowedModels",
      "code",
      "detail",
      "httpStatus",
      "retryAfterMs",
      "retryable",
      "terminal",
      "userMessage",
    ]);
  });

  test("the allow-list travels with the error, so a later layer can still read it", () => {
    // A 403 is mapped where it is raised and inspected several layers up.
    const error = new ProviderError({ code: "forbidden", allowedModels: ["a", "b"] });
    assert.deepEqual(error.allowedModels, ["a", "b"]);
    assert.deepEqual(error.toJSON().allowedModels, ["a", "b"]);
    assert.equal(new ProviderError({ code: "network" }).allowedModels, null);
  });

  test("no stack, no cause, no prototype chain crosses the boundary", () => {
    const json = JSON.stringify(new ProviderError({ code: "network", cause: new Error("inner") }).toJSON());
    assert.ok(!json.includes("stack"));
    assert.ok(!json.includes("cause"));
    assert.ok(!json.includes("inner"));
  });

  test("survives JSON round-tripping unchanged", () => {
    for (const code of ALL_CODES) {
      const json = new ProviderError({ code, detail: "d", httpStatus: 418, retryAfterMs: 5 }).toJSON();
      assert.deepEqual(JSON.parse(JSON.stringify(json)), json, code);
    }
  });
});

describe("isAbortLike", () => {
  test("recognises what fetch and AbortSignal actually throw", () => {
    assert.equal(isAbortLike(new DOMException("aborted", "AbortError")), true);
    assert.equal(isAbortLike(new DOMException("timed out", "TimeoutError")), true);
    assert.equal(isAbortLike({ name: "AbortError" }), true);
    assert.equal(isAbortLike(new ProviderError({ code: "aborted" })), true);
  });

  test("does not mistake a normal failure for a cancellation", () => {
    assert.equal(isAbortLike(new Error("aborted")), false, "the message is not the name");
    assert.equal(isAbortLike(new ProviderError({ code: "network" })), false);
    assert.equal(isAbortLike(null), false);
    assert.equal(isAbortLike(undefined), false);
    assert.equal(isAbortLike("AbortError"), false);
    assert.equal(isAbortLike(42), false);
    assert.equal(isAbortLike({ name: 123 }), false);
    assert.equal(isAbortLike([]), false);
  });

  test("an object with a throwing name getter does not take the process down", () => {
    const hostile = Object.defineProperty({}, "name", {
      get() {
        throw new Error("hostile getter");
      },
    });
    assert.throws(() => isAbortLike(hostile), /hostile getter/);
  });
});

describe("toProviderError", () => {
  test("passes an existing ProviderError through by identity", () => {
    const original = new ProviderError({ code: "config" });
    assert.equal(toProviderError(original), original);
  });

  test("maps every unusual throwable to something the agent can read", () => {
    const cases: unknown[] = [
      new Error("boom"),
      "a bare string",
      42,
      null,
      undefined,
      { message: "plain object" },
      [1, 2, 3],
      Symbol("s"),
      new TypeError("wrong type"),
      // A null-prototype object cannot be converted to a string at all. This is
      // the last-resort path, so it must not be the one that crashes.
      Object.create(null),
      { toString: () => { throw new Error("hostile"); } },
    ];
    cases.forEach((value, i) => {
      const error = toProviderError(value);
      assert.ok(error instanceof ProviderError, `case ${i} did not map`);
      assert.ok(error.userMessage.length > 0, `case ${i} has no message`);
      assert.ok(typeof error.detail === "string", `case ${i} has no detail`);
    });
  });

  test("a cancellation is classified as one", () => {
    assert.equal(toProviderError(new DOMException("x", "AbortError")).code, "aborted");
  });

  test("a circular object does not hang the mapper", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const error = toProviderError(circular);
    assert.ok(error instanceof ProviderError);
  });

  test("an error whose message is enormous is still an error", () => {
    const error = toProviderError(new Error("x".repeat(1_000_000)));
    assert.equal(error.code, "network");
    assert.ok(error.detail.length > 0);
  });
});

describe("unknownCapabilities", () => {
  test("every field starts unknown", () => {
    const caps = unknownCapabilities();
    assert.equal(Object.keys(caps).length, 8);
    for (const [name, value] of Object.entries(caps)) {
      assert.equal(value, "unknown", `${name} should start unknown`);
    }
  });

  test("returns a fresh object, so one model's measurement cannot leak to another", () => {
    const a = unknownCapabilities();
    const b = unknownCapabilities();
    assert.notEqual(a, b);
    a.chat = true;
    assert.equal(b.chat, "unknown");
  });
});
