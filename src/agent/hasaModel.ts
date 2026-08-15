import type { LlmProvider, ProviderChatRequest } from "../provider/types.ts";
import { createTextToolModel } from "./textToolModel.ts";
import type { AgentCompletion, AgentModel } from "./types.ts";

/**
 * Binds the loop to a provider.
 *
 * The loop is declared against `AgentModel`, which knows one verb, and this is
 * the only place the two meet. Not indirection for its own sake: it is what
 * lets a test drive the loop with a scripted model and no HTTP at all, and what
 * keeps `listModels`, `validate` and the notion of a gateway out of a file
 * whose job is deciding what to do next.
 */

export interface HasaAgentModelOptions {
  provider: LlmProvider;
  modelId: string;
  temperature?: number;
  maxOutputTokens?: number;
}

/**
 * Removes tool-call markup the gateway left in the prose.
 *
 * The native path is supposed to hand back structured `tool_calls` with the
 * content clean. This deployment does not always: the parser lifts the call out
 * and leaves its opening token behind, so a finished answer ends with a bare
 * `<tool_call>`. Reproduced end to end on 2026-08-04 against `qwen3-coder`, and
 * it is the same stray tag a user reported seeing in the panel weeks earlier —
 * which had been chased in the *text* protocol, where it never was.
 *
 * Only markup is removed, and only at the edges of the reply. A model writing
 * about tool calling in the middle of a sentence keeps its words; what goes is
 * a token that was never meant to be read.
 */
export function stripToolMarkup(text: string): string {
  return text
    // A complete block the parser should have consumed.
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    // The far more common case: an opening or closing token on its own, left at
    // the end when the call itself was extracted.
    .replace(/<\/?tool_call>/g, "")
    .replace(/<\|?(?:tool_calls?|function_call)[^>|]*\|?>/g, "")
    .trim();
}

/**
 * What to ask for when nobody measured the model's ceiling.
 *
 * Sending nothing is not the safe option, which is the thing this constant is
 * here to say. The gateway then applies its own default, and on this one that
 * default is 128,000 output tokens — larger than the room left in a 131,072
 * context once a system prompt and a few files are in it. The request is
 * refused with a 400 before any work begins:
 *
 *     This model's maximum context length is 131072 tokens. However, you
 *     requested 128000 output tokens and your prompt contains at least 3073
 *     input tokens, for a total of at least 131073 tokens.
 *
 * Seen in a live run: `ax-3.1` reports no measured ceiling, so nothing was
 * sent, and the turn died on its first model call in 216ms with `reason:
 * error`. `granite-guardian-3.1-8b` had already produced the same failure for
 * the same reason, and the fix then only covered models whose ceiling *was*
 * known — which left every unmeasured model exposed.
 *
 * 8,192 is chosen to be smaller than any ceiling this gateway has been seen to
 * report, and large enough for a turn's worth of edits. A model that can do
 * more says so through `limitsOf`, and that measurement wins.
 */
export const UNMEASURED_OUTPUT_CEILING = 8192;

export function createAgentModel(opts: HasaAgentModelOptions): AgentModel {
  return {
    modelId: opts.modelId,
    async complete(request, signal): Promise<AgentCompletion> {
      const full: ProviderChatRequest = {
        ...request,
        modelId: opts.modelId,
        // A low temperature by default: the user asked for a change to their
        // code, not for a sample from a distribution over changes.
        temperature: opts.temperature ?? 0.1,
        // Always sent. An absent ceiling is not "no limit", it is "the
        // gateway's limit", and that has been too large twice.
        maxOutputTokens: opts.maxOutputTokens ?? UNMEASURED_OUTPUT_CEILING,
      };
      const response = await opts.provider.chat(full, { signal });
      return {
        text: stripToolMarkup(response.text),
        reasoning: response.reasoning,
        toolCalls: response.toolCalls,
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
      };
    },
  };
}

/**
 * Builds the model a choice calls for.
 *
 * The two paths differ only in how a tool call is expressed, and the loop
 * cannot tell them apart — which is the property that makes a blocked gateway
 * a configuration detail rather than a missing feature.
 */
export function createModelFor(opts: {
  provider: LlmProvider;
  modelId: string;
  toolProtocol: "native" | "text";
  temperature?: number;
  maxOutputTokens?: number;
}): AgentModel {
  const shared = {
    provider: opts.provider,
    modelId: opts.modelId,
    ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
    ...(opts.maxOutputTokens === undefined ? {} : { maxOutputTokens: opts.maxOutputTokens }),
  };
  return opts.toolProtocol === "text" ? createTextToolModel(shared) : createAgentModel(shared);
}
