import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearSecrets,
  evidence,
  fingerprint,
  redact,
  redactString,
  registerSecret,
  summarizeMessages,
  REDACTED,
} from "./redact.ts";
import { createLogger, setLogSink } from "./logger.ts";

const KEY = "hasa-sk-abcdef0123456789abcdef0123456789";

describe("redact", () => {
  beforeEach(() => {
    clearSecrets();
    registerSecret(KEY);
  });
  afterEach(() => clearSecrets());

  test("removes a registered secret wherever it appears", () => {
    const out = redactString(`token=${KEY} trailing`);
    assert.ok(!out.includes(KEY));
    assert.ok(out.includes(REDACTED));
  });

  test("removes bearer tokens that were never registered", () => {
    const out = redactString("Authorization: Bearer sk-unregistered-9f2c1ab7d4e5");
    assert.ok(!out.includes("sk-unregistered-9f2c1ab7d4e5"));
  });

  test("masks authorization-like object keys regardless of value", () => {
    const out = redact({ authorization: "Bearer x", apiKey: "y", nested: { token: "z" } }) as Record<
      string,
      unknown
    >;
    assert.equal(out["authorization"], REDACTED);
    assert.equal(out["apiKey"], REDACTED);
    assert.deepEqual(out["nested"], { token: REDACTED });
  });

  test("leaves ordinary model ids and short strings intact", () => {
    const text = "model=Qwen2.5-Coder-32B-Instruct status=pass chunks=17";
    assert.equal(redactString(text), text);
  });

  test("survives circular structures", () => {
    const a: Record<string, unknown> = { name: "a" };
    a["self"] = a;
    assert.deepEqual(redact(a), { name: "a", self: "[Circular]" });
  });

  test("redacts error messages and stacks", () => {
    const out = redact(new Error(`failed with ${KEY}`)) as { message: string };
    assert.ok(!out.message.includes(KEY));
  });

  test("fingerprint is stable and does not contain the key", () => {
    const fp = fingerprint(KEY);
    assert.equal(fp, fingerprint(KEY));
    assert.ok(!fp.includes(KEY));
    assert.match(fp, /^sha256:[0-9a-f]{12}$/);
  });

  test("evidence truncates and redacts", () => {
    const long = `${KEY} ${"x".repeat(500)}`;
    const out = evidence(long, 50);
    assert.ok(out.length <= 50);
    assert.ok(!out.includes(KEY));
  });
});

describe("summarizeMessages", () => {
  test("reports shape without the content", () => {
    const summary = summarizeMessages([
      { role: "system", content: "you are helpful" },
      { role: "user", content: "secret business plan" },
    ]);
    assert.equal(summary.messageCount, 2);
    assert.ok(summary.chars > 0);
    assert.match(summary.digest, /^sha256:[0-9a-f]{16}$/);
    assert.equal(summary.preview, undefined);
    assert.ok(!JSON.stringify(summary).includes("secret business plan"));
  });

  test("identical prompts produce identical digests", () => {
    const messages = [{ role: "user", content: "same" }];
    assert.equal(summarizeMessages(messages).digest, summarizeMessages([...messages]).digest);
  });

  test("different prompts produce different digests", () => {
    assert.notEqual(
      summarizeMessages([{ role: "user", content: "a" }]).digest,
      summarizeMessages([{ role: "user", content: "b" }]).digest,
    );
  });
});

describe("logger", () => {
  test("never emits a registered secret, even nested in an unexpected shape", () => {
    clearSecrets();
    registerSecret(KEY);
    const lines: string[] = [];
    const previous = setLogSink((line) => lines.push(line));
    const previousLevel = process.env["ARENA_LOG_LEVEL"];
    process.env["ARENA_LOG_LEVEL"] = "debug";
    try {
      const log = createLogger("test");
      log.info(`direct ${KEY}`);
      log.error("structured", { headers: { authorization: `Bearer ${KEY}` }, deep: [{ k: KEY }] });
    } finally {
      setLogSink(previous);
      if (previousLevel === undefined) delete process.env["ARENA_LOG_LEVEL"];
      else process.env["ARENA_LOG_LEVEL"] = previousLevel;
      clearSecrets();
    }
    assert.ok(lines.length >= 2);
    for (const line of lines) assert.ok(!line.includes(KEY), `leaked in: ${line}`);
  });
});
