import { parseTurnContract, type TurnContract } from "../agent/turnContract.ts";
import type { AgentModel } from "../agent/types.ts";
import type { ProviderTool } from "../provider/types.ts";

/**
 * Reading the request, before anyone decides who should do the work.
 *
 * The circularity this breaks: choosing a worker needs a `TaskProfile`, a
 * profile needs a `TurnContract`, and a contract needs a model. Something has
 * to go first, and the honest way to say so is to give it its own name and its
 * own budget rather than to pretend the worker can bootstrap itself.
 *
 * ## It does not do the work
 *
 * The tool surface is one tool. Not "mostly reading tools", not "the safe
 * subset" — `record_request` and nothing else. A bootstrap pass that can write
 * a file is a second agent running before the first one was chosen, with none
 * of the gates that exist because agents get things wrong: no approval, no
 * preflight, no checkpoint. There is no configuration here that turns another
 * tool on, because the safest version of that switch is the one that does not
 * exist.
 *
 * ## It is not a second schema
 *
 * The contract it produces goes through `parseTurnContract`, the same function
 * the `record_request` tool calls, and comes out as the same `TurnContract`.
 * Two schemas would mean two things called "what the user asked for", and the
 * router would rank against one while the worker honoured the other.
 *
 * ## It does not become the source of what was asked
 *
 * `parseTurnContract(args, turnId)` stamps every requirement's provenance with
 * the turn id it is given, and the id given is the *user's* turn. The
 * interpreter is how the sentence was read, not who said it — recording the
 * interpreter as the source would make the model the author of the user's
 * requirements.
 */

/** Bumped when the interpretation contract changes in a way replay must see. */
export const BOOTSTRAP_VERSION = "r3.1";

export type BootstrapFailure =
  /** The model produced no `record_request` call at all. */
  | "NO_CONTRACT_CALL"
  /** It called something else, which the surface does not have. */
  | "WRONG_TOOL"
  /** The arguments did not pass `parseTurnContract`. */
  | "INVALID_CONTRACT"
  /** The call could not be read — a protocol problem, not a content one. */
  | "PROTOCOL_PROBLEM"
  /** The gateway failed or the deadline passed. */
  | "MODEL_UNAVAILABLE"
  | "TIMEOUT";

export interface BootstrapSuccess {
  ok: true;
  contract: TurnContract;
  bootstrapModelId: string;
  attempts: number;
}

export interface BootstrapFailed {
  ok: false;
  failure: BootstrapFailure;
  /** What went wrong, for the event and for the user. */
  detail: string;
  bootstrapModelId: string;
  attempts: number;
}

export type BootstrapResult = BootstrapSuccess | BootstrapFailed;

/**
 * The only tool a bootstrap pass is given.
 *
 * Duplicated from `createRequestTool` rather than imported, and the duplication
 * is deliberate and small: the tool object carries an `execute` that mutates
 * session state, and the bootstrap has no session. What is shared is the part
 * that matters — `parseTurnContract` — and the schema below is a description of
 * the same fields for a model that will never run the tool.
 */
export function bootstrapToolSurface(): ProviderTool[] {
  return [
    {
      name: "record_request",
      description:
        "Write down what the user actually asked for. This is the only thing you do in this " +
        "step: you are not implementing anything, not reading files, not running commands. " +
        "Record what the user said, not what you would do about it.",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "The request in one line, in the user's terms." },
          relation: {
            type: "string",
            description:
              "How this message relates to what came before — one of: new_task, continue, " +
              "refine, correct, question.",
          },
          intents: {
            type: "string",
            description:
              "What they want done, one per line, from: discuss, inspect, present, modify, " +
              "execute, verify, research, continue.",
          },
          requirements: {
            type: "string",
            description:
              "Everything the user asked for, one per line. Every distinct thing, including " +
              "the ones nobody knows how to do yet. Their words, not steps.",
          },
          deliverables: {
            type: "string",
            description: "What they should have in front of them when this is done, one per line.",
          },
          constraints: {
            type: "string",
            description:
              "Anything they told you not to do, or must do, one per line as `kind: their " +
              "words`. Kinds: no_execute, no_modify, no_research, must_execute, present_only, " +
              "other. Leave this out if they said no such thing — do not write 없음.",
          },
          ambiguities: {
            type: "string",
            description: "Anything you could not settle from what they said, one per line.",
          },
        },
        required: ["goal", "relation", "intents"],
        additionalProperties: false,
      },
    },
  ];
}

const SYSTEM_PROMPT = [
  "You read a user's request and record what it asks for. That is your whole job in this step.",
  "",
  "You are not the agent that will do the work — another model will, and it is chosen based on",
  "what you record here. So record the request, not a plan for it.",
  "",
  "Call `record_request` exactly once. Do not answer the user, do not describe how you would",
  "approach the task, and do not add requirements the user did not state.",
  "",
  "If the user forbade something — 실행하지 마, 수정하지 말고, 보여만 줘 — that is a constraint",
  "and it must appear in `constraints` with its kind. A constraint you leave out is one the",
  "runtime will never enforce.",
].join("\n");

export interface BootstrapOptions {
  model: AgentModel;
  /** What the user typed, verbatim. */
  prompt: string;
  /** The *user's* turn. Stamped onto every requirement's provenance. */
  turnId: string;
  /** Prior conversation, so a "이어서 해줘" is read as a continuation. */
  history?: readonly { role: string; content: string }[];
  signal?: AbortSignal;
  /** How many times a malformed contract may be sent back. Small on purpose. */
  maxAttempts?: number;
}

const DEFAULT_ATTEMPTS = 2;

/**
 * Interprets one user message into a contract.
 *
 * Bounded rather than persistent: at most `maxAttempts` calls, and a failure is
 * reported as a failure. §41 is explicit that a bootstrap that quietly falls
 * back to mode-only selection would route around the entire requirement-aware
 * path while looking like it worked — so this returns why, and the caller
 * decides in the open.
 */
export async function interpretRequest(opts: BootstrapOptions): Promise<BootstrapResult> {
  const attempts = Math.max(1, opts.maxAttempts ?? DEFAULT_ATTEMPTS);
  const modelId = opts.model.modelId;
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(opts.history ?? []).map((m) => ({
      role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
      content: m.content,
    })),
    { role: "user", content: opts.prompt },
  ];

  let lastProblem = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (opts.signal?.aborted === true) {
      return fail("TIMEOUT", "요청을 정리하는 단계가 중단되었습니다.", modelId, attempt - 1);
    }

    let completion;
    try {
      completion = await opts.model.complete(
        {
          messages: messages as never,
          tools: bootstrapToolSurface(),
          // Asked for, not hoped for. A bootstrap pass that answers in prose has
          // produced nothing this step can use.
          toolChoice: { name: "record_request" },
          temperature: 0,
        },
        opts.signal ?? new AbortController().signal,
      );
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      // Read after the call rather than before: the abort is what interrupted
      // it, so the flag is only meaningful now. A deadline reached mid-request
      // and a gateway that refused are different facts for the user.
      const aborted: boolean = opts.signal?.aborted ?? false;
      return fail(aborted ? "TIMEOUT" : "MODEL_UNAVAILABLE", message, modelId, attempt);
    }

    const call = completion.toolCalls[0];
    if (call === undefined) {
      lastProblem =
        completion.protocolProblem ??
        "record_request 호출이 없었습니다. 사용자의 요청을 그 도구로 기록해야 합니다.";
      if (completion.protocolProblem !== undefined && attempt === attempts) {
        return fail("PROTOCOL_PROBLEM", lastProblem, modelId, attempt);
      }
      if (attempt === attempts) return fail("NO_CONTRACT_CALL", lastProblem, modelId, attempt);
      messages.push({ role: "user", content: lastProblem });
      continue;
    }

    if (call.name !== "record_request") {
      lastProblem = `이 단계에서는 record_request만 쓸 수 있습니다. ${call.name} 은(는) 없습니다.`;
      if (attempt === attempts) return fail("WRONG_TOOL", lastProblem, modelId, attempt);
      messages.push({ role: "user", content: lastProblem });
      continue;
    }

    const args =
      call.argumentsValid && typeof call.arguments === "object" && call.arguments !== null
        ? (call.arguments as Record<string, unknown>)
        : null;
    if (args === null) {
      lastProblem = `record_request의 인자를 읽지 못했습니다: ${call.rawArguments.slice(0, 200)}`;
      if (attempt === attempts) return fail("PROTOCOL_PROBLEM", lastProblem, modelId, attempt);
      messages.push({ role: "user", content: lastProblem });
      continue;
    }

    // The user's turn id, not the interpreter's. See the header.
    const parsed = parseTurnContract(args, opts.turnId);
    if (parsed.ok) {
      return { ok: true, contract: parsed.contract, bootstrapModelId: modelId, attempts: attempt };
    }

    lastProblem = parsed.problem.reason;
    if (attempt === attempts) return fail("INVALID_CONTRACT", lastProblem, modelId, attempt);
    messages.push({ role: "user", content: `요청을 기록하지 못했습니다. ${lastProblem}` });
  }

  return fail("INVALID_CONTRACT", lastProblem, modelId, attempts);
}

function fail(
  failure: BootstrapFailure,
  detail: string,
  bootstrapModelId: string,
  attempts: number,
): BootstrapFailed {
  return { ok: false, failure, detail, bootstrapModelId, attempts };
}

/** What the user is told when interpretation failed. Names the step. */
export function describeBootstrapFailure(result: BootstrapFailed): string {
  return (
    `요청을 정리하는 단계에서 실패했습니다 (${result.failure}). ${result.detail} ` +
    "요구사항에 맞는 모델을 고르지 못했으므로, 기본 선택으로 진행합니다."
  );
}
