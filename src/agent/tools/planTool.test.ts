import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createPlanTool, parsePlan } from "./planTool.ts";
import type { AgentEvent } from "../types.ts";

/**
 * Saying what is happening and what comes next.
 *
 * A tool rather than a prompt instruction, because the prompt version was tried
 * and failed in a specific way: asked to narrate before acting, the model
 * narrated and stopped, and the loop read the narration as the answer. A tool
 * call cannot be mistaken for a finished turn — the harness sees it happen, and
 * the result it returns points at the work rather than acknowledging the call.
 */

function toolWith(): { tool: ReturnType<typeof createPlanTool>; plans: Array<Extract<AgentEvent, { type: "plan" }>> } {
  const plans: Array<Extract<AgentEvent, { type: "plan" }>> = [];
  return { tool: createPlanTool({ onPlan: (event) => plans.push(event) }), plans };
}

const ctx = { workspaceRoot: "/w", signal: new AbortController().signal };

describe("reading a plan", () => {
  test("one step per line, in order", () => {
    const plan = parsePlan("예제를 찾는다\n패키지를 설치한다\n실행한다", 2);
    assert.deepEqual(plan?.steps, ["예제를 찾는다", "패키지를 설치한다", "실행한다"]);
    assert.equal(plan?.current, 2);
  });

  test("numbering and bullets the model added are stripped", () => {
    // Models write lists as lists. Left in, the panel renders "1. 1. 설치".
    for (const raw of ["1. 설치한다\n2. 실행한다", "- 설치한다\n- 실행한다", "* 설치한다\n* 실행한다"]) {
      assert.deepEqual(parsePlan(raw, 1)?.steps, ["설치한다", "실행한다"], raw);
    }
  });

  test("a checkbox the model drew is not the state", () => {
    // `current` is the state. A model that also ticks its own boxes would
    // otherwise put two contradictory marks on one line.
    assert.deepEqual(parsePlan("[x] 설치한다\n[ ] 실행한다", 2)?.steps, ["설치한다", "실행한다"]);
  });

  test("blank lines and padding do not become steps", () => {
    assert.deepEqual(parsePlan("  설치한다  \n\n\n  실행한다\n", 1)?.steps, ["설치한다", "실행한다"]);
  });

  test("current is clamped into the plan rather than trusted", () => {
    assert.equal(parsePlan("a\nb", 0)?.current, 1);
    assert.equal(parsePlan("a\nb", 99)?.current, 2);
    assert.equal(parsePlan("a\nb", -3)?.current, 1);
    assert.equal(parsePlan("a\nb", "second")?.current, 1);
  });

  test("an empty plan is nothing, not an empty list", () => {
    for (const raw of ["", "   ", "\n\n"]) assert.equal(parsePlan(raw, 1), null, JSON.stringify(raw));
  });

  test("a runaway plan is bounded", () => {
    const many = Array.from({ length: 40 }, (_, i) => `step ${i}`).join("\n");
    assert.equal(parsePlan(many, 1)?.steps.length, 12);
    const long = parsePlan("x".repeat(400), 1);
    assert.ok((long?.steps[0]?.length ?? 0) <= 121);
  });
});

describe("the tool", () => {
  test("never needs approval, because a progress report must not wait for one", () => {
    const { tool } = toolWith();
    assert.equal(tool.risk, "read");
  });

  test("emits the plan for the panel to render", async () => {
    const { tool, plans } = toolWith();
    await tool.execute({ steps: "찾는다\n설치한다\n실행한다", current: 2 }, ctx);

    assert.equal(plans.length, 1);
    assert.deepEqual(plans[0]?.steps, ["찾는다", "설치한다", "실행한다"]);
    assert.equal(plans[0]?.current, 2);
  });

  test("the result names the next step, so the turn does not stop here", async () => {
    // The failure this is written against: a model calls the tool, reads "plan
    // updated", and treats that as having done something.
    const { tool } = toolWith();
    const result = await tool.execute({ steps: "설치한다\n실행한다", current: 1 }, ctx);

    assert.equal(result.ok, true);
    assert.match(result.content, /Now do step 1: 설치한다/);
    assert.match(result.content, /step 2 is: 실행한다/);
    assert.match(result.content, /Do not stop here/);
  });

  test("the last step says it is the last, and to report afterwards", async () => {
    const { tool } = toolWith();
    const result = await tool.execute({ steps: "설치한다\n실행한다", current: 2 }, ctx);
    assert.match(result.content, /last step \(2\/2\)/);
    assert.match(result.content, /report what happened/);
  });

  test("an empty plan is refused with what to do instead", async () => {
    const { tool, plans } = toolWith();
    const result = await tool.execute({ steps: "  ", current: 1 }, ctx);
    assert.equal(result.ok, false);
    assert.match(result.content, /one step per line/i);
    assert.deepEqual(plans, [], "nothing should reach the panel");
  });

  test("the summary shows position and the current step", () => {
    const { tool } = toolWith();
    assert.equal(tool.summarize({ steps: "찾는다\n설치한다", current: 2 }), "2/2 · 설치한다");
  });

  test("a revised plan replaces the old one rather than appending", async () => {
    // Plans are state. A model that learns step two was wrong sends a new list,
    // and the panel should show that list — not both.
    const { tool, plans } = toolWith();
    await tool.execute({ steps: "찾는다\n설치한다", current: 1 }, ctx);
    await tool.execute({ steps: "찾는다\n의존성을 확인한다\n설치한다", current: 2 }, ctx);

    assert.equal(plans.length, 2);
    assert.deepEqual(plans[1]?.steps, ["찾는다", "의존성을 확인한다", "설치한다"]);
  });
});
