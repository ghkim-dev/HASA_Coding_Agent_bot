import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { backoffMs, classifyStatus, parseRetryAfter } from "./errors.ts";

describe("classifyStatus", () => {
  test("401 is fatal configuration, never retried", () => {
    const c = classifyStatus(401);
    assert.equal(c.kind, "auth");
    assert.equal(c.retryable, false);
    assert.equal(c.terminal, true);
  });

  test("403 disqualifies the model rather than the request", () => {
    const c = classifyStatus(403);
    assert.equal(c.kind, "forbidden");
    assert.equal(c.retryable, false);
    assert.equal(c.terminal, true);
  });

  test("429 and 503 are transient", () => {
    for (const status of [429, 503]) {
      const c = classifyStatus(status);
      assert.equal(c.retryable, true, `${status} should be retryable`);
      assert.equal(c.terminal, false);
    }
  });

  test("404 stops retries — a missing model will not appear by waiting", () => {
    assert.equal(classifyStatus(404).retryable, false);
  });

  test("400 is a client fault and not retried", () => {
    const c = classifyStatus(400);
    assert.equal(c.kind, "client");
    assert.equal(c.retryable, false);
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-07-30T00:00:00Z");

  test("delta-seconds form", () => {
    assert.equal(parseRetryAfter("30", now), 30_000);
  });

  test("HTTP-date form", () => {
    assert.equal(parseRetryAfter("Thu, 30 Jul 2026 00:00:10 GMT", now), 10_000);
  });

  test("a date already in the past clamps to zero rather than going negative", () => {
    assert.equal(parseRetryAfter("Thu, 30 Jul 2026 00:00:00 GMT", now + 5_000), 0);
  });

  test("absent or unparseable header yields null so backoff takes over", () => {
    assert.equal(parseRetryAfter(null, now), null);
    assert.equal(parseRetryAfter("soon", now), null);
  });
});

describe("backoffMs", () => {
  test("grows exponentially and stays within the cap", () => {
    const max = (attempt: number): number => backoffMs(attempt, 500, 30_000, () => 0.999999);
    assert.ok(max(0) < 500);
    assert.ok(max(1) < 1000 && max(1) > max(0));
    assert.ok(max(10) <= 30_000);
  });

  test("full jitter can return zero", () => {
    assert.equal(backoffMs(5, 500, 30_000, () => 0), 0);
  });
});
