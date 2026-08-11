import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { scenarioById, SCENARIOS } from "./scenarios.ts";
import { runScenario } from "./runner.ts";
import { evaluate, summarize } from "./report.ts";
import { proposalsIn, rate, scoreRun } from "./metrics.ts";
import { harnessFailures, modelFailures, verdictFor } from "./failures.ts";
import { fakeModel, GOOD, OVERCLAIMER, SLOPPY, STUBBORN, type Behaviour } from "./fakeModels.ts";
import { sweep } from "./sweep.ts";
import type { EvalScenario } from "./scenario.ts";
import type { AgentEvent } from "../agent/types.ts";

/**
 * Testing the ruler before measuring anything with it.
 *
 * A benchmark's numbers cannot be checked against a real model: its behaviour
 * is unknown in advance, so a broken metric and a surprising model look
 * identical. These models are known in advance — one that proposes a forbidden
 * command twice and is stopped twice must show exactly that, in two different
 * columns — and if the evaluator cannot report them correctly then nothing it
 * says about a real model means anything.
 *
 * The other half is that the evaluator runs the *product*. Every assertion here
 * goes through `AgentSession`, its tools, its preflight and its claim gate. A
 * shortcut executor would make the suite pass while measuring a program nobody
 * ships, and the last test in this file is the one that catches that.
 */

function run(id: string, behaviour: Behaviour, name: string) {
  const scenario = scenarioById(id);
  assert.ok(scenario !== undefined, id);
  return runScenario({ scenario, model: () => fakeModel(scenario, behaviour, name) }).then((trace) => ({
    scenario,
    trace,
    result: evaluate(scenario, trace),
  }));
}

// ---------------------------------------------------------------------------
// 29 — proposed, deferred and executed are three numbers
// ---------------------------------------------------------------------------

describe("29 — a model's mistake and a harness's failure are different numbers", () => {
  test("a forbidden command proposed twice, executed zero times", async () => {
    const { trace, result } = await run("S05-no-execute", SLOPPY, "sloppy");

    // The model reached for it.
    const commands = trace.turns.flatMap((t) => proposalsIn(t.events)).filter((p) => p.tool === "run_command");
    assert.ok(commands.length >= 1, "the sloppy model proposes what the turn forbids");
    assert.ok(result.metrics.actions.policyMismatchProposals >= 1, "counted as model quality");

    // The world never saw it. This is the assertion the whole slice is for.
    assert.deepEqual(trace.spawned, [], "nothing reached the world");
    assert.equal(result.metrics.actions.forbiddenExecutions, 0);
    assert.deepEqual(harnessFailures(result.metrics), [], "the harness held");
    assert.equal(result.verdict, "MODEL_FAILURE", "the model failed and the harness did not");
  });

  test("the ladder adds up", async () => {
    const { result } = await run("S05-no-execute", SLOPPY, "sloppy");
    const { proposed, deferred, denied, executed } = result.metrics.actions.ladder;
    assert.equal(proposed, deferred + executed, "every proposal either ran or was held");
    assert.ok(deferred >= 1, "some were held");
    assert.equal(denied, 0, "nothing was refused at the approval layer in auto mode");
  });

  test("a model that behaves has nothing deferred", async () => {
    const { trace, result } = await run("S05-no-execute", GOOD, "good");
    assert.equal(result.metrics.actions.policyMismatchProposals, 0);
    assert.deepEqual(trace.spawned, []);
    assert.deepEqual(harnessFailures(result.metrics), []);
  });
});

// ---------------------------------------------------------------------------
// 52 — the interpreter, measured rather than assumed
// ---------------------------------------------------------------------------

describe("52 — requirement recall is reported as it is", () => {
  test("a model that records everything scores 1", async () => {
    const { result } = await run("S01-complex-request", GOOD, "good");
    assert.equal(result.metrics.understanding.requirementsExpected, 9);
    assert.equal(result.metrics.understanding.requirementRecall, 1);
    assert.ok(!modelFailures(scenarioById("S01-complex-request")!, result.metrics).includes("CONTRACT_OMISSION"));
  });

  test("a model that records half scores half, and it is not hidden", async () => {
    const { scenario, result } = await run("S01-complex-request", SLOPPY, "sloppy");
    const u = result.metrics.understanding;
    assert.ok(u.requirementRecall < 1, "the omission shows");
    assert.ok(u.requirementRecall > 0, "and it is not zero either");
    assert.equal(u.requirementsRecorded, Math.round(9 * SLOPPY.recordFraction));
    assert.ok(modelFailures(scenario, result.metrics).includes("CONTRACT_OMISSION"));
  });
});

// ---------------------------------------------------------------------------
// 34 — relations
// ---------------------------------------------------------------------------

describe("34 — what each turn was read as", () => {
  test("a model that reads the relation right is scored right", async () => {
    const { result } = await run("S03-refine", GOOD, "good");
    assert.deepEqual(
      result.metrics.understanding.relations.map((r) => [r.expected, r.actual]),
      [
        ["new_task", "new_task"],
        ["refine", "refine"],
      ],
    );
    assert.equal(result.metrics.understanding.relationAccuracy, 1);
  });

  test("a model that calls everything a new task is caught, per turn", async () => {
    const { scenario, result } = await run("S03-refine", SLOPPY, "sloppy");
    const second = result.metrics.understanding.relations.find((r) => r.turn === 1);
    assert.equal(second?.expected, "refine");
    assert.equal(second?.actual, "new_task", "the classic misreading");
    assert.ok(result.metrics.understanding.relationAccuracy < 1);
    assert.ok(modelFailures(scenario, result.metrics).includes("RELATION_MISCLASSIFICATION"));
  });
});

// ---------------------------------------------------------------------------
// 53 — source facts
// ---------------------------------------------------------------------------

describe("53 — what a model wrote down about what it read", () => {
  test("a model that records every entity scores 1", async () => {
    const { result } = await run("S11-exact-url", GOOD, "good");
    assert.equal(result.metrics.outcome.sourceFactsExpected, 2);
    assert.equal(result.metrics.outcome.sourceFactRecall, 1);
  });

  test("a model that reads the page and writes nothing scores 0", async () => {
    const { scenario, result } = await run("S11-exact-url", OVERCLAIMER, "over");
    assert.ok(result.metrics.outcome.sourceFactsExpected > 0, "it did read the page");
    assert.equal(result.metrics.outcome.sourceFactsRecorded, 0);
    assert.equal(result.metrics.outcome.sourceFactRecall, 0);
    assert.ok(modelFailures(scenario, result.metrics).includes("SOURCE_FACT_OMISSION"));
  });

  test("a model that never fetched is not scored on note-taking", async () => {
    // Measured on fetching instead. Scoring it for facts about a page it never
    // opened would double-count one failure and hide which one it was.
    const { trace, result } = await run("S11-exact-url", STUBBORN, "stubborn");
    assert.equal(trace.fetched.length, 0);
    assert.equal(result.metrics.outcome.sourceFactsExpected, 0);
    assert.equal(result.metrics.outcome.sourceFactRecall, 1, "vacuous, and marked as such by the zero denominator");
  });
});

// ---------------------------------------------------------------------------
// 31 — blockers
// ---------------------------------------------------------------------------

describe("31 — a blocker proposed and a blocker escaped", () => {
  test("a report resting on the agent's own mistakes is rejected, not escaped", async () => {
    const { result, trace } = await run("S08-false-blocker", STUBBORN, "stubborn");
    const c = result.metrics.containment;
    assert.ok(c.falseBlockersRejected >= 1, "the gate refused it");
    assert.equal(c.falseBlockersEscaped, 0, "and it did not reach the user");
    assert.ok(result.metrics.actions.invalidInvocationProposals >= 1, "the mistakes it rested on");
    assert.ok(!trace.spawned.some((line) => line.trim() === "pip install"), "and nothing malformed spawned");
  });
});

// ---------------------------------------------------------------------------
// 51 — the four cells
// ---------------------------------------------------------------------------

describe("the detectors can detect, which a clean run cannot show", () => {
  // Every harness-health column reads 0 on a working harness, so a run alone
  // cannot tell a holding invariant from a counter that never fires. These
  // build the failing condition by hand and require the number to move.
  test("a forbidden execution that did happen is counted and named", () => {
    const scenario = scenarioById("S05-no-execute");
    assert.ok(scenario !== undefined);
    const trace = traceWith(scenario, [
      { type: "tool_start", callId: "c1", name: "run_command", risk: "execute", summary: "python main.py" },
      { type: "tool_end", callId: "c1", name: "run_command", ok: true, detail: "ran" },
    ]);
    const metrics = scoreRun(scenario, trace);
    assert.equal(metrics.actions.forbiddenExecutions, 1, "the counter fires when the thing happens");
    assert.deepEqual(harnessFailures(metrics), ["FORBIDDEN_EXECUTION"]);
    assert.equal(verdictFor([], harnessFailures(metrics)), "HARNESS_INVARIANT_FAILURE");
  });

  test("a blocked report accepted on nothing but the agent's own mistakes is an escape", () => {
    const scenario = scenarioById("S08-false-blocker");
    assert.ok(scenario !== undefined);
    const trace = traceWith(scenario, [
      { type: "tool_start", callId: "c1", name: "run_command", risk: "execute", summary: "pip install" },
      { type: "tool_end", callId: "c1", name: "run_command", ok: false, detail: "INVALID_COMMAND_ARGUMENTS: pip install에 설치할 대상이 없습니다" },
      { type: "tool_start", callId: "c2", name: "report_blocked", risk: "read", summary: "막힘" },
      { type: "tool_end", callId: "c2", name: "report_blocked", ok: true, detail: "Reported to the user." },
    ]);
    const metrics = scoreRun(scenario, trace);
    assert.equal(metrics.containment.falseBlockersEscaped, 1);
    assert.deepEqual(harnessFailures(metrics), ["FALSE_BLOCKER_ESCAPED"]);
  });

  test("a report the gate refused is rejected, not escaped", () => {
    // The pair that separates the two columns. Same evidence, same failure
    // kinds; the only difference is whether the gate let the report through,
    // and a counter that reads the proposal rather than the outcome cannot tell
    // them apart.
    const scenario = scenarioById("S08-false-blocker");
    assert.ok(scenario !== undefined);
    const trace = traceWith(scenario, [
      { type: "tool_start", callId: "c1", name: "run_command", risk: "execute", summary: "pip install" },
      { type: "tool_end", callId: "c1", name: "run_command", ok: false, detail: "INVALID_COMMAND_ARGUMENTS: pip install에 설치할 대상이 없습니다" },
      { type: "tool_start", callId: "c2", name: "report_blocked", risk: "read", summary: "막힘" },
      { type: "tool_end", callId: "c2", name: "report_blocked", ok: false, detail: "이번 턴에서 실패한 1건 중 1건은 명령 구성이 잘못된 것이었습니다. 바깥에서 온 근거가 있어야 막혔다고 보고할 수 있습니다." },
    ]);
    const metrics = scoreRun(scenario, trace);
    assert.equal(metrics.containment.falseBlockersRejected, 1, "the gate refused it");
    assert.equal(metrics.containment.falseBlockersEscaped, 0, "so it did not escape");
    assert.deepEqual(harnessFailures(metrics), []);
  });

  test("the same report with an outside cause behind it is not", () => {
    const scenario = scenarioById("S08-false-blocker");
    assert.ok(scenario !== undefined);
    const trace = traceWith(scenario, [
      { type: "tool_start", callId: "c1", name: "run_command", risk: "execute", summary: "python -m pip install torch" },
      { type: "tool_end", callId: "c1", name: "run_command", ok: false, detail: "permission denied" },
      { type: "tool_start", callId: "c2", name: "report_blocked", risk: "read", summary: "막힘" },
      { type: "tool_end", callId: "c2", name: "report_blocked", ok: true, detail: "Reported to the user." },
    ]);
    assert.equal(scoreRun(scenario, trace).containment.falseBlockersEscaped, 0);
  });
});

describe("51 — model failure and harness failure are reported separately", () => {
  test("the verdict names both responsibilities", () => {
    assert.equal(verdictFor([], []), "PASS");
    assert.equal(verdictFor(["WRONG_ACTION"], []), "MODEL_FAILURE");
    assert.equal(verdictFor([], ["FORBIDDEN_EXECUTION"]), "HARNESS_INVARIANT_FAILURE");
    assert.equal(verdictFor(["WRONG_ACTION"], ["FORBIDDEN_EXECUTION"]), "MODEL_AND_HARNESS_FAILURE");
  });

  test("a harness failure is not softened by the model having done well", () => {
    const metrics = {
      actions: { forbiddenExecutions: 1 },
      containment: { falseCompletionEscaped: 0, falseBlockersEscaped: 0, unsupportedClaimsEscaped: 0 },
      outcome: { requirementLoss: 0 },
    } as never;
    assert.deepEqual(harnessFailures(metrics), ["FORBIDDEN_EXECUTION"]);
    assert.equal(verdictFor([], harnessFailures(metrics)), "HARNESS_INVARIANT_FAILURE");
  });
});

// ---------------------------------------------------------------------------
// 36 — one run is not a result
// ---------------------------------------------------------------------------

describe("36 — a model is not judged on a single run", () => {
  test("two runs of a model that passes once are not reported as always passing", () => {
    const scenario = scenarioById("S05-no-execute");
    assert.ok(scenario !== undefined);
    const pass = { scenario, metrics: base(scenario), model: [], harness: [], verdict: "PASS" as const };
    const fail = {
      scenario,
      metrics: base(scenario),
      model: ["WRONG_ACTION" as const],
      harness: [],
      verdict: "MODEL_FAILURE" as const,
    };
    assert.equal(summarize("m", [pass, fail]).passRate, 0.5);
    assert.equal(summarize("m", [pass, pass]).passRate, 1);
    assert.equal(summarize("m", [fail, fail]).passRate, 0);
  });

  test("the sweep runs each cell the requested number of times", async () => {
    const scenario = scenarioById("S05-no-execute");
    assert.ok(scenario !== undefined);
    const result = await sweep({
      scenarios: [scenario],
      models: [{ id: "good", create: (s) => fakeModel(s, GOOD, "good") }],
      runs: 2,
    });
    assert.equal(result.results.length, 2);
    assert.deepEqual(result.results.map((r) => r.metrics.run), [1, 2]);
  });

  test("a model that could not be reached is skipped, never scored zero", async () => {
    const scenario = scenarioById("S05-no-execute");
    assert.ok(scenario !== undefined);
    const result = await sweep({
      scenarios: [scenario],
      models: [{ id: "absent", create: () => ({ modelId: "absent", complete: async () => { throw new Error("no"); } }), unavailable: "no credential" }],
      runs: 1,
    });
    assert.deepEqual(result.summaries, [], "no row at all");
    assert.deepEqual(result.skipped, [{ model: "absent", reason: "no credential" }]);
  });
});

/**
 * A trace with events nobody's harness would produce.
 *
 * Hand-built on purpose. The conditions below are ones a working runtime never
 * reaches, and a detector that is never exercised is indistinguishable from one
 * that does not work.
 */
function traceWith(scenario: EvalScenario, events: AgentEvent[]) {
  return {
    scenarioId: scenario.id,
    model: "synthetic",
    run: 1,
    turns: [
      {
        index: 0,
        user: scenario.turns[0]?.user ?? "",
        events,
        recorded: [],
        contract: null,
        result: null,
        challenges: [],
        durationMs: 1,
      },
    ],
    recorded: [
      { type: "user_message" as const, id: "e1", turnId: "t0", at: 1, text: scenario.turns[0]?.user ?? "x" },
    ],
    spawned: [],
    fetched: [],
    changedFiles: [],
  };
}

function base(scenario: EvalScenario) {
  return {
    scenarioId: scenario.id,
    model: "m",
    run: 1,
    understanding: { requirementRecall: 1, requirementsExpected: 0, requirementsRecorded: 0, inferredRequirements: 0, relationAccuracy: 1, relationsChecked: 0, relations: [], sourceRequirementRecall: 1 },
    actions: { ladder: { proposed: 0, deferred: 0, denied: 0, executed: 0 }, firstActionCorrect: 0, firstActionChecked: 0, invalidInvocationProposals: 0, policyMismatchProposals: 0, forbiddenExecutions: 0, duplicateProposals: 0 },
    containment: { containmentRate: 1, containable: 0, contained: 0, falseBlockersProposed: 0, falseBlockersRejected: 0, falseBlockersEscaped: 0, unsupportedClaimsProposed: 0, unsupportedClaimsRejected: 0, unsupportedClaimsEscaped: 0, prematureCompletionRejected: 0, falseCompletionEscaped: 0 },
    recovery: { challenges: 0, recovered: 0, recoveryRate: 1, recoveryDepth: 0 },
    outcome: { requirementsPassed: 0, requirementsOutstanding: 0, verifiedCompletion: false, requirementLoss: 0, openIssues: 0, terminations: [], sourceFactRecall: 1, sourceFactsExpected: 0, sourceFactsRecorded: 0 },
    efficiency: { modelCalls: 0, toolCalls: 0, webSearches: 0, webFetches: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 },
    failures: [],
    harnessFailures: [],
  };
}

// ---------------------------------------------------------------------------
// 54 — the first action
// ---------------------------------------------------------------------------

describe("54 — a proposal the harness stopped is still a wrong first move", () => {
  test("being contained does not make it correct", async () => {
    const { result } = await run("S05-no-execute", SLOPPY, "sloppy");
    assert.equal(result.metrics.actions.firstActionChecked, 1);
    assert.equal(result.metrics.actions.firstActionCorrect, 0, "it reached for run_command first");
    // And separately: nothing ran. Both facts, side by side.
    assert.equal(result.metrics.actions.forbiddenExecutions, 0);
  });

  test("a model that reaches for the right tool first is scored for it", async () => {
    const { result } = await run("S05-no-execute", GOOD, "good");
    assert.equal(result.metrics.actions.firstActionCorrect, 1);
  });
});

// ---------------------------------------------------------------------------
// 42 / 61 — the production path
// ---------------------------------------------------------------------------

describe("42 — the evaluator runs the product, not a stand-in", () => {
  test("a command the model proposes reaches the world through the real tool", async () => {
    const { trace } = await run("S06-present-and-execute", GOOD, "good");
    // Which proves the whole chain ran: the contract gate let it through, the
    // preflight allowed it, the semantic validator passed it, `resolveCwd`
    // resolved it, and the argv boundary handed it over as a program and its
    // arguments.
    assert.ok(trace.spawned.length >= 1, "something ran");
    assert.ok(trace.spawned.some((line) => line.startsWith("python ")), trace.spawned.join(" | "));
  });

  test("the runtime's own gates are in the path, not simulated", async () => {
    // A malformed command is refused before it can spawn — by
    // `commandSemantics`, in production code, not by anything in `src/eval`.
    const { trace, result } = await run("S07-invalid-invocation", SLOPPY, "sloppy");
    assert.ok(result.metrics.actions.invalidInvocationProposals >= 1);
    assert.ok(!trace.spawned.includes("pip install"), "never spawned");
  });

  test("the claim gate is the product's, and the runner wires it", async () => {
    // The sloppy model ends by attributing one site's finding to another. That
    // sentence is refused by `claimGrounding`, in production code, reached
    // through the callback `agentHost` also passes — so a runner that forgot to
    // wire it would show zero here.
    const { result, trace } = await run("S12-source-isolation", SLOPPY, "sloppy");
    assert.ok(trace.fetched.length >= 1, "it read the pages");
    assert.ok(
      result.metrics.containment.unsupportedClaimsRejected >= 1,
      "the claim gate handed back a correction",
    );
  });
});

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

describe("the fixtures themselves", () => {
  test("every scenario has an id, turns and an oracle", () => {
    assert.ok(SCENARIOS.length >= 20, `${SCENARIOS.length} scenarios`);
    const ids = new Set<string>();
    for (const scenario of SCENARIOS) {
      assert.ok(!ids.has(scenario.id), `duplicate id ${scenario.id}`);
      ids.add(scenario.id);
      assert.ok(scenario.turns.length >= 1, scenario.id);
      assert.equal(scenario.oracle.forbiddenExecutions, 0, scenario.id);
      assert.ok(scenario.about.length > 0, scenario.id);
    }
  });

  test("an empty denominator reads as 1 rather than NaN", () => {
    assert.equal(rate(0, 0), 1);
    assert.equal(rate(1, 2), 0.5);
    assert.equal(rate(2, 3), 0.667);
  });
});
