import type { AgentTool, ToolResult } from "../types.ts";
import { TURN_INTENTS, TURN_RELATIONS, parseTurnContract, type TurnContract } from "../turnContract.ts";

/**
 * Where the model's reading of the request becomes something binding.
 *
 * A tool rather than a second model call, for two reasons. The obvious one is
 * cost: a separate interpreter pass per turn doubles latency on every message,
 * including "고마워". The better one is that a tool call is already how this
 * codebase gets structured output from models with uneven JSON support — the
 * text protocol writes parameters as tag bodies, the arguments are validated,
 * and a malformed call comes back as a result the model can act on instead of a
 * parse failure nobody sees.
 *
 * What is validated here is not correctness — nothing can check that the model
 * read the Korean right. It is *shape*: a goal, a relation, at least one
 * intent, and requirements unless the turn is a continuation or a question. A
 * contract that passes is one the runtime can hold to, and from there the model
 * cannot drop a requirement by planning around it.
 *
 * `read` risk. It records what was asked; it changes nothing.
 */

export interface RequestToolOptions {
  onContract: (contract: TurnContract) => void;
  /** The turn this call belongs to. Supplied by the session, never the model. */
  turnId: () => string;
}

export function createRequestTool(opts: RequestToolOptions): AgentTool {
  /** The turn whose contract has already been recorded. */
  let recordedFor: string | null = null;
  return {
    name: "record_request",
    risk: "read",
    description:
      "Write down what the user actually asked for, before doing any of it. Call this first on " +
      "every turn that carries a request, a correction or a follow-up. What you record here is " +
      "kept by the runtime for the rest of the task: a requirement written down now does not " +
      "disappear because a later plan does not mention it. That is the point — your plan is how " +
      "you mean to proceed, and this is what you were asked for, and the two are not the same. " +
      "Record what the user said, not what you intend to do about it.",
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "The request in one line, in the user's terms.",
        },
        relation: {
          type: "string",
          description:
            `How this message relates to what came before — one of: ${TURN_RELATIONS.join(", ")}. ` +
            `"correct" when the user is telling you that you misread them ("아니, 그게 아니라"); ` +
            `"refine" when they are adding to a live request; "continue" when they are asking you ` +
            `to carry on ("이어서 해줘"); "question" when they want an answer rather than work; ` +
            `"new_task" otherwise.`,
        },
        intents: {
          type: "string",
          description:
            `What they want done, one per line, from: ${TURN_INTENTS.join(", ")}. More than one ` +
            `is normal — "수정하고 테스트해줘" is modify and verify. "코드 보여줘" is present, ` +
            `not execute.`,
        },
        requirements: {
          type: "string",
          description:
            "Everything the user asked for, one per line. Every distinct thing, including the " +
            "ones you do not yet know how to do — a requirement you leave out here is one the " +
            "runtime will never know was wanted. Their words, not your steps.",
        },
        deliverables: {
          type: "string",
          description:
            "What they should have in front of them when this is done, one per line — a running " +
            "project, the source of a file, a comparison, an answer.",
        },
        constraints: {
          type: "string",
          description:
            "Anything they told you not to do, or must do, one per line as `kind: their words`. " +
            "Kinds: no_execute, no_modify, no_research, must_execute, present_only, other. " +
            '"코드는 수정하지 말고 분석만" is `no_modify: 코드는 수정하지 말고`.',
        },
        ambiguities: {
          type: "string",
          description: "Anything you could not settle from what they said, one per line.",
        },
      },
      required: ["goal", "relation", "intents"],
      additionalProperties: false,
    },
    summarize: (args) => {
      const goal = typeof args["goal"] === "string" ? args["goal"].trim() : "";
      return goal.length === 0 ? "요청을 정리합니다" : `요청 확인: ${goal.slice(0, 60)}`;
    },
    async execute(args): Promise<ToolResult> {
      // One user message, one contract.
      //
      // A second call in the same turn is not a correction — a correction is a
      // *new* user message with `relation: "correct"`, which is a new turn. It
      // is a model with nothing left to do reaching for the first tool it knows,
      // and it re-opens the task it just finished.
      //
      // Seen in a live run against `exaone-4.0-32b`: two files written, `pytest`
      // exit 0, all three requirements passed, and then `record_request` with
      // `relation: new_task` four times until the step budget ran out. The user
      // got "한 번에 처리할 수 있는 분량을 넘어 중단했습니다" for work that was
      // sitting finished on disk.
      const turn = opts.turnId();
      if (recordedFor === turn) {
        return {
          ok: false,
          content:
            "이번 요청은 이미 기록했습니다. 다시 기록하지 말고, 남은 작업을 하거나 " +
            "무엇을 했는지 사용자에게 답하십시오.",
        };
      }

      const parsed = parseTurnContract(args, turn);
      if (!parsed.ok) {
        // Returned as a result rather than thrown: the model gets one look at
        // what was wrong and can send it again. `loop.ts` already stops a call
        // that repeats identically, so this cannot become a retry loop.
        return { ok: false, content: `요청을 기록하지 못했습니다. ${parsed.problem.reason}` };
      }

      recordedFor = turn;
      opts.onContract(parsed.contract);
      const { contract } = parsed;

      // The result names what was recorded and points at the work. An
      // acknowledgement alone is somewhere a model can stop, which is the
      // failure `update_plan` was already shaped to avoid.
      return {
        ok: true,
        content: [
          `기록했습니다. ${contract.requirements.length}개 요구사항, ` +
            `intent=${contract.intents.join("+")}, relation=${contract.relation}.`,
          contract.constraints.length === 0
            ? ""
            : `제약: ${contract.constraints.map((c) => `${c.kind}(${c.text})`).join(", ")}. ` +
              "이 제약은 런타임이 강제합니다.",
          "이제 이 요구사항을 만족시키기 위한 작업을 시작하십시오. 이 호출은 아무것도 바꾸지 않았습니다.",
        ]
          .filter((line) => line.length > 0)
          .join(" "),
      };
    },
  };
}
