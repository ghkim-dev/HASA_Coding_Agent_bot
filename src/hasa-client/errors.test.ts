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

  test("the unluckiest draw still leaves the server time to change", () => {
    // This replaced "full jitter can return zero", and the replacement is the
    // whole point of the change. A zero-length wait is a retry that asks the
    // same question before anything could have answered it differently —
    // observed against a model the gateway was still loading, where three
    // retries went out inside 560ms and all three were certain to fail.
    for (const attempt of [0, 1, 2, 5, 12]) {
      assert.ok(backoffMs(attempt, 500, 30_000, () => 0) > 0, `attempt ${attempt} waited nothing`);
    }
  });

  test("the shortest wait is half the window, and it grows with the window", () => {
    const shortest = (attempt: number): number => backoffMs(attempt, 500, 30_000, () => 0);
    assert.deepEqual([shortest(0), shortest(1), shortest(2)], [250, 500, 1_000]);
  });

  test("three retries wait at least 1.75s in total", () => {
    // Stated as a total because that is what a model needs in order to load:
    // the individual waits matter less than whether the budget survives to the
    // point where the answer could differ.
    const worstCase = [0, 1, 2].reduce((sum, a) => sum + backoffMs(a, 500, 30_000, () => 0), 0);
    assert.equal(worstCase, 1_750);
  });

  test("it still randomises, so a herd is still broken up", () => {
    // Half a window is narrower than a whole one, but it is not a constant —
    // and a constant is what would re-synchronise every caller that failed
    // together.
    const draws = new Set(
      Array.from({ length: 64 }, (_, i) => backoffMs(1, 500, 30_000, () => i / 64)),
    );
    assert.ok(draws.size > 16, `only ${draws.size} distinct waits; jitter has collapsed`);
  });

  test("the cap bounds the top without collapsing the bottom onto it", () => {
    assert.ok(backoffMs(20, 500, 30_000, () => 0.999999) <= 30_000);
    assert.equal(backoffMs(20, 500, 30_000, () => 0), 15_000);
  });
});
