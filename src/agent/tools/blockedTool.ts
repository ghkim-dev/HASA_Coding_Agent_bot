import type { AgentTool, ToolResult } from "../types.ts";

/**
 * A way to stop and say the requested thing could not be done.
 *
 * This exists because there was no way to. Every turn ended `finished`, which
 * the panel draws in the same colour as success, so "I could not download the
 * dataset" and "I evaluated the model" were the same shape on screen and the
 * only difference was prose the user had to read carefully to notice.
 *
 * That is not a gap a prompt can close. Telling a model to stop and report when
 * it is blocked, while the only available ending is one that looks like
 * success, asks it to choose the outcome that reads as failure for no
 * structural reason. What happened instead is the thing this was written after:
 * asked to download a real dataset and evaluate on it, the agent hit a loading
 * error, silently substituted twenty synthetic samples, reported "Accuracy
 * 0.8000" from a classifier head that the load report had said was randomly
 * reinitialised, and closed with "실제 데이터셋을 다운받아 테스트하는 방식으로
 * 진행했습니다" — in the same message that admitted it had not.
 *
 * So there is now an ending that means what it says. Calling this ends the turn
 * with `blocked`, the panel shows it as unfinished, and the conversation records
 * it as a turn that did not complete.
 *
 * `read` risk: it changes nothing and must never wait on a modal.
 */

const MAX_FIELD = 600;

function clip(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > MAX_FIELD ? `${text.slice(0, MAX_FIELD)}…` : text;
}

export interface BlockedReport {
  /** The part of the request that could not be done. */
  goal: string;
  /** What stopped it — the actual error, not a paraphrase. */
  obstacle: string;
  /** What was already attempted, so the user is not told to retry it. */
  tried: string;
  /** What would unblock it, when that is known. */
  needed?: string;
}

export interface BlockedToolOptions {
  onBlocked: (report: BlockedReport) => void;
}

/** The report as the user reads it. */
export function describeBlocked(report: BlockedReport): string {
  const lines = [`하지 못한 것: ${report.goal}`, `막힌 이유: ${report.obstacle}`];
  if (report.tried.length > 0) lines.push(`시도한 것:\n${report.tried}`);
  if (report.needed !== undefined) lines.push(`필요한 것: ${report.needed}`);
  return lines.join("\n\n");
}

export function createBlockedTool(opts: BlockedToolOptions): AgentTool {
  return {
    name: "report_blocked",
    risk: "read",
    description:
      "Stop and tell the user that part of what they asked for cannot be done. Call this instead " +
      "of substituting something else for what they asked for — a different dataset, a synthetic " +
      "sample, a different file, a smaller version of the task. Substituting and reporting the " +
      "result as though it answered the request is the worst outcome available: the numbers look " +
      "real and mean nothing. Ending the turn here is a correct outcome, not a failure.",
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description:
            "The part of the request that cannot be done, in the user's terms — " +
            "'실제 CIFAR-10 데이터셋을 내려받아 평가', not 'load_dataset 호출'.",
        },
        obstacle: {
          type: "string",
          description:
            "What actually stopped it. Quote the error. A paraphrase is not something the user " +
            "can search for or act on.",
        },
        tried: {
          type: "string",
          description:
            "What you already attempted, one per line, so the user is not told to retry what " +
            "has failed.",
        },
        needed: {
          type: "string",
          description:
            "What would unblock it, if you know — a credential, a package, a decision only the " +
            "user can make. Leave it out rather than guessing.",
        },
      },
      required: ["goal", "obstacle", "tried"],
      additionalProperties: false,
    },
    summarize: (args) => {
      const goal = clip(args["goal"]);
      return goal.length === 0 ? "막힌 지점을 보고합니다" : `막힘: ${goal}`;
    },
    async execute(args): Promise<ToolResult> {
      const goal = clip(args["goal"]);
      const obstacle = clip(args["obstacle"]);
      const tried = clip(args["tried"]);
      const needed = clip(args["needed"]);

      // Refused rather than accepted empty. A blocked report with no obstacle is
      // the same dead end as the summary it replaces, and this is the one call
      // whose whole value is that it carries the specifics.
      if (goal.length === 0 || obstacle.length === 0) {
        return {
          ok: false,
          content:
            "A blocked report needs both what could not be done and what stopped it, " +
            "with the actual error rather than a paraphrase.",
        };
      }

      const report: BlockedReport = { goal, obstacle, tried, ...(needed.length === 0 ? {} : { needed }) };
      opts.onBlocked(report);

      // The turn ends here; the loop reads `blocked` rather than this string.
      // Said anyway, because a model handed an encouraging acknowledgement is a
      // model that keeps going and finds something to substitute after all.
      return {
        ok: true,
        blocked: true,
        // Shown verbatim. `display` exists for exactly this: "I could not do it"
        // with no detail is the dead end this tool replaces, and a user who
        // cannot see the error has to take the model's word for the one thing
        // they asked it to find out.
        display: describeBlocked(report),
        content: "Reported to the user. The turn ends here. Do not continue.",
      };
    },
  };
}
