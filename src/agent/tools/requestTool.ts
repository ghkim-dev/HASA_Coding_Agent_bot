import type { AgentTool, ToolResult } from "../types.ts";
import {
  TURN_INTENTS,
  TURN_RELATIONS,
  parseTurnContract,
  type Constraint,
  type TurnContract,
} from "../turnContract.ts";

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

/**
 * What the runtime actually adopted, as opposed to what was proposed.
 *
 * The tool used to describe the contract it had just *parsed*, and by the time
 * that sentence reached the model the relation guard and the research decision
 * had already changed it — so the model was told "이 제약은 런타임이
 * 강제합니다" about a constraint the session had quarantined a microsecond
 * earlier. Adoption returns what it did, and the tool reports that.
 */
export interface ContractAdoptionResult {
  /** Constraints the tool gate will actually refuse calls for. */
  enforced: Constraint[];
  /** Recorded and shown, enforcing nothing — `other`, `must_execute`. */
  recordedOnly: Constraint[];
  /** Established as the model's own invention. Recorded, never enforced. */
  quarantined: Constraint[];
  /** What to say about the research question, when there is anything to say. */
  researchNote: string | null;
  /** Whether `web_search`/`web_fetch` may run this turn. */
  webToolsAllowed: boolean;
}

export interface RequestToolOptions {
  onContract: (contract: TurnContract) => ContractAdoptionResult | void;
  /** The turn this call belongs to. Supplied by the session, never the model. */
  turnId: () => string;
  /**
   * Whether this turn's contract already exists on the record.
   *
   * True when the host's bootstrap pass interpreted the request before the
   * worker ran. The worker's prompt still says "record the request first" —
   * that instruction is right for the turns the bootstrap missed — so the tool
   * is where the duplicate is refused, with a pointer at the work instead.
   */
  alreadyRecorded?: () => boolean;
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
      if (opts.alreadyRecorded?.() === true) {
        return {
          ok: false,
          content:
            "이번 턴의 요청은 런타임이 이미 기록했습니다. 다시 기록하지 말고, " +
            "시스템 메시지의 '지금까지 확인된 요청'에서 남은 작업을 이어서 진행하십시오.",
        };
      }
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
      const adopted = opts.onContract(parsed.contract) ?? null;
      const { contract } = parsed;

      // Everything below describes what was *adopted*. When a caller supplies
      // no adoption result — a test, an embedder — the parsed contract is the
      // best available account and is reported as proposed rather than as
      // enforced.
      const lines = [
        `기록했습니다. ${contract.requirements.length}개 요구사항, ` +
          `intent=${contract.intents.join("+")}, relation=${contract.relation}.`,
      ];
      if (adopted === null) {
        if (contract.constraints.length > 0) {
          lines.push(
            `기록된 제약: ${contract.constraints.map((c) => `${c.kind}(${c.text})`).join(", ")}.`,
          );
        }
      } else {
        if (adopted.enforced.length > 0) {
          lines.push(
            `런타임이 강제하는 제약: ${adopted.enforced.map((c) => `${c.kind}(${c.text})`).join(", ")}.`,
          );
        }
        if (adopted.recordedOnly.length > 0) {
          lines.push(
            `기록만 된 제약(강제되지 않음): ${adopted.recordedOnly.map((c) => c.text).join(", ")}.`,
          );
        }
        if (adopted.quarantined.length > 0) {
          lines.push(
            `사용자 원문에서 확인되지 않아 격리된 제약: ${adopted.quarantined
              .map((c) => c.text)
              .join(", ")}. 이 제약은 강제되지 않습니다.`,
          );
        }
        if (adopted.researchNote !== null) lines.push(adopted.researchNote);
        if (!adopted.webToolsAllowed) {
          lines.push("이번 턴에는 web_search와 web_fetch를 쓸 수 없습니다.");
        }
      }
      // The result points at the work. An acknowledgement alone is somewhere a
      // model can stop, which is the failure `update_plan` was already shaped
      // to avoid.
      lines.push(
        "이제 이 요구사항을 만족시키기 위한 작업을 시작하십시오. 이 호출은 아무것도 바꾸지 않았습니다.",
      );
      return { ok: true, content: lines.join(" ") };
    },
  };
}
