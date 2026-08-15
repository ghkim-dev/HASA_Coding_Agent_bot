import type { LlmProvider, ProviderChatRequest, ProviderMessage } from "../provider/types.ts";
import { UNMEASURED_OUTPUT_CEILING } from "./hasaModel.ts";
import { renderToolCall, renderToolInstructions, parseToolCall } from "./textTools.ts";
import type { AgentCompletion, AgentModel } from "./types.ts";

/**
 * An `AgentModel` for a gateway that will not accept tool calls.
 *
 * Two jobs, and the second is the one that is easy to miss.
 *
 * It describes the tools in the prompt and reads the calls back out of the
 * text. And it keeps every trace of tool calling *off the wire*: a deployment
 * that rejects `tools` in a request rejects `tool_calls` on an assistant
 * message and a `role: "tool"` message for the same reason, so the conversation
 * is flattened into the plain text it originally was before being sent.
 *
 * The tool list comes from each request rather than from construction. The loop
 * already puts it there, and taking it from there means this wrapper does not
 * need to know which mode the session is in or when the mode changed.
 *
 * Above this file, nothing changes. The loop, the approval policy, the
 * checkpoint and the tool registry all see the same `NormalizedToolCall` they
 * see from a model with native support.
 */

export interface TextToolModelOptions {
  provider: LlmProvider;
  modelId: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export function createTextToolModel(opts: TextToolModelOptions): AgentModel {
  return {
    modelId: opts.modelId,
    async complete(request, signal): Promise<AgentCompletion> {
      const tools = request.tools ?? [];
      const instructions = renderToolInstructions(tools);

      const full: ProviderChatRequest = {
        modelId: opts.modelId,
        messages: flatten(request.messages, instructions),
        temperature: opts.temperature ?? 0.1,
        // Same reasoning as the native path: an absent ceiling means the
        // gateway's own, and that has been larger than the context twice. See
        // `UNMEASURED_OUTPUT_CEILING`.
        maxOutputTokens: opts.maxOutputTokens ?? UNMEASURED_OUTPUT_CEILING,
        // Deliberately no `tools` and no `toolChoice`. Sending either is the
        // thing this whole path exists to avoid.
      };

      const response = await opts.provider.chat(full, { signal });
      const parsed = parseToolCall(response.text, tools);

      return {
        // The prose only. A failed attempt is reported beside it rather than
        // inside it: the loop hands the problem back to the model, and the user
        // never reads a message that was written for a parser.
        //
        // It used to be appended here, and in a live run that produced a turn
        // ending after two steps whose entire answer was
        // `<update_plan>\ncurrent: 1` followed by a bracketed parser complaint.
        text: parsed.text,
        ...(parsed.problem === null ? {} : { protocolProblem: parsed.problem }),
        reasoning: response.reasoning,
        toolCalls: parsed.call === null ? [] : [parsed.call],
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
      };
    },
  };
}

/**
 * Rewrites the conversation into something a tool-less gateway accepts.
 *
 *   system            → system, with the tool instructions appended
 *   assistant + calls → assistant, with the call written back as the XML it was
 *   tool result       → user, labelled so the model knows which call it answers
 *
 * The assistant turn is re-rendered rather than replayed verbatim because the
 * loop stores a parsed call, not the original text. Semantically identical is
 * enough: the model needs to recognise what it did, not to re-read its own
 * whitespace.
 */
export function flatten(
  messages: readonly ProviderMessage[],
  instructions: string,
): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  let instructionsPlaced = false;
  const callNames = new Map<string, string>();

  for (const message of messages) {
    switch (message.role) {
      case "system":
        out.push({ role: "system", content: `${message.content}${instructions}` });
        instructionsPlaced = true;
        break;

      case "assistant": {
        const calls = message.toolCalls ?? [];
        for (const call of calls) callNames.set(call.id, call.name);
        const rendered = calls.map(renderToolCall).join("\n");
        const text = [message.content ?? "", rendered].filter((s) => s.length > 0).join("\n\n");
        // An assistant turn with neither text nor a call has nothing to replay,
        // and an empty message is rejected by some gateways.
        if (text.length > 0) out.push({ role: "assistant", content: text });
        break;
      }

      case "tool": {
        const name = callNames.get(message.toolCallId) ?? "tool";
        out.push({ role: "user", content: `[${name} result]\n${message.content}` });
        break;
      }

      default:
        out.push(message);
        break;
    }
  }

  // A conversation with no system message still needs the instructions, or the
  // model is being asked to use a format nobody described.
  if (!instructionsPlaced && instructions.length > 0) {
    out.unshift({ role: "system", content: instructions.trimStart() });
  }
  return out;
}
