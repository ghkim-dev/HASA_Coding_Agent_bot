import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CheckSchema, type Check } from "../protocol/index.ts";
import { passedCount, runChecks } from "./checks.ts";

const check = (raw: unknown): Check => CheckSchema.parse(raw);

describe("objective checks", () => {
  test("must_include is case-insensitive and names what is missing", () => {
    const checks = [check({ kind: "must_include", items: ["latency", "Throughput"] })];
    const [hit] = runChecks("Latency and throughput both matter.", checks);
    assert.equal(hit?.passed, true);

    const [miss] = runChecks("Only latency matters.", checks);
    assert.equal(miss?.passed, false);
    // The detail has to be actionable: "failed" alone leaves the user diffing
    // two long answers to find out which phrase was absent.
    assert.match(miss?.detail ?? "", /Throughput/);
  });

  test("json_parses accepts a fenced block, which is how models actually answer", () => {
    const checks = [check({ kind: "json_parses" })];
    assert.equal(runChecks('{"a": 1}', checks)[0]?.passed, true);
    assert.equal(runChecks('```json\n{"a": 1}\n```', checks)[0]?.passed, true);
    assert.equal(runChecks("Here you go:\n```\n{\"a\": 1}\n```", checks)[0]?.passed, true);
    assert.equal(runChecks("I would rather explain it in prose.", checks)[0]?.passed, false);
  });

  test("word bounds count words, not characters", () => {
    assert.equal(runChecks("one two three", [check({ kind: "max_words", limit: 3 })])[0]?.passed, true);
    assert.equal(runChecks("one two three four", [check({ kind: "max_words", limit: 3 })])[0]?.passed, false);
    assert.equal(runChecks("   ", [check({ kind: "min_words", limit: 1 })])[0]?.passed, false);
  });

  test("a regex can require a match or require its absence", () => {
    const required = [check({ kind: "regex", pattern: "TODO", expect: true })];
    const forbidden = [check({ kind: "regex", pattern: "TODO", expect: false })];
    assert.equal(runChecks("has a TODO", required)[0]?.passed, true);
    assert.equal(runChecks("has a TODO", forbidden)[0]?.passed, false);
    assert.equal(runChecks("clean", forbidden)[0]?.passed, true);
  });

  test("a check is a pure function of the text — no clock, no network, no order", () => {
    // Two runs of the same input must agree, or S0 would make the ladder's
    // cheapest rung its least reproducible one.
    const checks = [
      check({ kind: "must_include", items: ["a"] }),
      check({ kind: "max_words", limit: 2 }),
      check({ kind: "json_parses" }),
    ];
    assert.deepEqual(runChecks("a b", checks), runChecks("a b", checks));
    assert.equal(passedCount(runChecks("a b", checks)), 2);
  });
});
