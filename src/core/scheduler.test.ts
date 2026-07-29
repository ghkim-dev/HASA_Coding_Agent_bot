import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { nullLogger } from "../hasa-client/logger.ts";
import { Scheduler, getScheduler, resetScheduler } from "./scheduler.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

afterEach(() => resetScheduler());

describe("Scheduler", () => {
  test("never exceeds the global cap, however many callers submit at once", async () => {
    const scheduler = new Scheduler({ globalLimit: 2, perModelLimit: 99, logger: nullLogger });
    const gates = Array.from({ length: 6 }, () => deferred<string>());

    const jobs = gates.map((gate, i) =>
      scheduler.submit({ modelId: `model-${i}`, run: () => gate.promise }),
    );
    await tick();
    assert.equal(scheduler.stats().inFlight, 2);
    assert.equal(scheduler.stats().waiting, 4);

    gates.forEach((g, i) => g.resolve(`ok-${i}`));
    await Promise.all(jobs);
    assert.ok(scheduler.stats().peakInFlight <= 2, "global cap was breached");
  });

  test("enforces the per-model cap independently of the global cap", async () => {
    const scheduler = new Scheduler({ globalLimit: 8, perModelLimit: 1, logger: nullLogger });
    const gates = Array.from({ length: 4 }, () => deferred<string>());

    const jobs = gates.map((gate) => scheduler.submit({ modelId: "same-model", run: () => gate.promise }));
    await tick();
    assert.equal(scheduler.stats().inFlight, 1, "one model must not saturate the global pool");

    gates.forEach((g, i) => g.resolve(`ok-${i}`));
    await Promise.all(jobs);
    assert.equal(scheduler.stats().peakPerModel, 1);
  });

  test("spreads work across models up to the global cap", async () => {
    const scheduler = new Scheduler({ globalLimit: 3, perModelLimit: 1, logger: nullLogger });
    const gates = Array.from({ length: 3 }, () => deferred<string>());
    const jobs = gates.map((gate, i) => scheduler.submit({ modelId: `m${i}`, run: () => gate.promise }));
    await tick();
    assert.equal(scheduler.stats().inFlight, 3);
    gates.forEach((g) => g.resolve("ok"));
    await Promise.all(jobs);
  });

  test("higher priority jumps the queue", async () => {
    const scheduler = new Scheduler({ globalLimit: 1, perModelLimit: 1, logger: nullLogger });
    const blocker = deferred<string>();
    const order: string[] = [];

    const held = scheduler.submit({ modelId: "blocker", run: () => blocker.promise });
    await tick();

    const low = scheduler.submit({
      modelId: "a",
      priority: 0,
      run: async () => {
        order.push("low");
      },
    });
    const high = scheduler.submit({
      modelId: "b",
      priority: 1,
      run: async () => {
        order.push("high");
      },
    });

    blocker.resolve("done");
    await Promise.all([held, low, high]);
    assert.deepEqual(order, ["high", "low"]);
  });

  test("a paused model yields its slot to other models", async () => {
    const timers: Array<() => void> = [];
    const scheduler = new Scheduler({
      globalLimit: 1,
      perModelLimit: 1,
      logger: nullLogger,
      setTimeoutImpl: (fn) => timers.push(fn),
    });

    scheduler.pauseModel("slow", 1000);
    const ran: string[] = [];
    const paused = scheduler.submit({
      modelId: "slow",
      run: async () => {
        ran.push("slow");
      },
    });
    const other = scheduler.submit({
      modelId: "fast",
      run: async () => {
        ran.push("fast");
      },
    });

    await other;
    assert.deepEqual(ran, ["fast"], "the paused model must not block the queue");

    timers.forEach((fn) => fn());
    await paused;
    assert.deepEqual(ran, ["fast", "slow"]);
  });

  test("pausing for zero or negative time is a no-op", () => {
    const scheduler = new Scheduler({ globalLimit: 1, perModelLimit: 1, logger: nullLogger });
    scheduler.pauseModel("m", 0);
    assert.deepEqual(scheduler.stats().pausedModels, []);
  });

  test("aborting a queued job rejects it without ever running", async () => {
    const scheduler = new Scheduler({ globalLimit: 1, perModelLimit: 1, logger: nullLogger });
    const blocker = deferred<string>();
    const held = scheduler.submit({ modelId: "blocker", run: () => blocker.promise });
    await tick();

    const controller = new AbortController();
    let ran = false;
    const queued = scheduler.submit({
      modelId: "queued",
      signal: controller.signal,
      run: async () => {
        ran = true;
      },
    });
    controller.abort(new Error("cancelled"));
    await assert.rejects(queued);
    assert.equal(ran, false);

    blocker.resolve("done");
    await held;
  });

  test("a failing job releases its slot", async () => {
    const scheduler = new Scheduler({ globalLimit: 1, perModelLimit: 1, logger: nullLogger });
    await assert.rejects(
      scheduler.submit({
        modelId: "m",
        run: async () => {
          throw new Error("boom");
        },
      }),
    );
    assert.equal(scheduler.stats().inFlight, 0);
    assert.equal(await scheduler.submit({ modelId: "m", run: async () => "recovered" }), "recovered");
  });

  test("getScheduler returns one process-wide instance", () => {
    // The regression this guards: a limiter constructed inside a request
    // handler gives each caller its own cap, so the real limit is never applied.
    assert.equal(getScheduler(), getScheduler());
  });
});
