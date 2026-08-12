import { argText } from "../argValues.ts";
import type { AgentEvent, AgentTool, ToolResult } from "../types.ts";

/**
 * What the agent is doing, and what it means to do next.
 *
 * A tool rather than a prompt instruction, and that choice was made the hard
 * way. Asking a model in the system prompt to narrate before acting produced
 * turns that narrated and then stopped — the narration became the whole reply.
 * A tool call is different in kind: it is a thing the model *does*, the harness
 * sees it happen, and a turn that calls it has not ended.
 *
 * `read` risk, so it is never gated behind approval. A progress report that
 * waits for a modal is worse than none: it would stop the very thing it exists
 * to describe.
 *
 * The plan is sent whole every time rather than as a diff. Models keep a list
 * far more reliably than they keep a cursor into one, and a whole list cannot
 * drift out of step with itself.
 */

const MAX_STEPS = 12;
const MAX_STEP_CHARS = 120;

export interface PlanState {
  steps: string[];
  /** 1-based. The step being worked on now. */
  current: number;
}

/**
 * Reads a plan out of whatever the model sent.
 *
 * Newline-separated text rather than an array, because the text protocol writes
 * parameters as tag bodies and an array has no natural spelling there. Numbering
 * and bullets are stripped: models add them, and a step rendered as "1. 1. 설치"
 * looks like a bug in the panel.
 */
export function parsePlan(raw: string, current: unknown): PlanState | null {
  const steps = raw
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    // A checkbox the model drew itself is not the state — `current` is.
    .map((line) => line.replace(/^\[[ x]\]\s*/i, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_STEPS)
    .map((line) => (line.length > MAX_STEP_CHARS ? `${line.slice(0, MAX_STEP_CHARS)}…` : line));

  if (steps.length === 0) return null;
  const asked = typeof current === "number" && Number.isFinite(current) ? Math.round(current) : 1;
  return { steps, current: Math.min(steps.length, Math.max(1, asked)) };
}

export interface PlanToolOptions {
  onPlan: (event: Extract<AgentEvent, { type: "plan" }>) => void;
}

export function createPlanTool(opts: PlanToolOptions): AgentTool {
  return {
    name: "update_plan",
    risk: "read",
    description:
      "Show the user your plan and where you are in it. Call this first for anything that takes " +
      "more than one step, and again each time you move to the next step — before you do the work, " +
      "not after. Send the whole plan every time, one step per line, and say which step you are on " +
      "now. This is what the user watches to know what is happening and what is coming; it changes " +
      "nothing and needs no permission.",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "string",
          description:
            "The whole plan, one step per line, in order. Short phrases describing outcomes — " +
            "'필요한 패키지를 설치한다', not 'run_command를 호출한다'.",
        },
        current: {
          type: "number",
          description: "Which step you are starting now, counting from 1.",
        },
      },
      required: ["steps", "current"],
      additionalProperties: false,
    },
    summarize: (args) => {
      const plan = parsePlan(argText(args["steps"]), args["current"]);
      if (plan === null) return "계획을 정리합니다";
      return `${plan.current}/${plan.steps.length} · ${plan.steps[plan.current - 1] ?? ""}`;
    },
    async execute(args): Promise<ToolResult> {
      const raw = argText(args["steps"]);
      const plan = parsePlan(raw, args["current"]);
      if (plan === null) {
        return { ok: false, content: "The plan was empty. Send one step per line." };
      }
      opts.onPlan({ type: "plan", steps: plan.steps, current: plan.current });

      // The result names the next step rather than acknowledging the call. A
      // model that has just been told "next: install the package" is being
      // pointed at the work; "plan updated" would let it stop here, which is the
      // failure this whole tool exists to prevent.
      const next = plan.steps[plan.current];
      return {
        ok: true,
        content:
          next === undefined
            ? `Plan shown. This is the last step (${plan.current}/${plan.steps.length}): ` +
              `${plan.steps[plan.current - 1] ?? ""}. Do it now, then report what happened.`
            : `Plan shown. Now do step ${plan.current}: ${plan.steps[plan.current - 1] ?? ""}. ` +
              `After it, step ${plan.current + 1} is: ${next}. Do not stop here — this call changed nothing.`,
      };
    },
  };
}
