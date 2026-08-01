import type { LlmProvider, ProviderChatRequest } from "../provider/types.ts";
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
        ...(opts.maxOutputTokens === undefined ? {} : { maxOutputTokens: opts.maxOutputTokens }),
      };
      const response = await opts.provider.chat(full, { signal });
      return {
        text: response.text,
        reasoning: response.reasoning,
        toolCalls: response.toolCalls,
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
      };
    },
  };
}
