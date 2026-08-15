import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { UNMEASURED_OUTPUT_CEILING, createModelFor } from "./hasaModel.ts";
import type { LlmProvider, ProviderChatRequest } from "../provider/types.ts";

/**
 * The request that dies before any work begins.
 *
 * Twice now. `granite-guardian-3.1-8b` first: a small context, the gateway's
 * own default output ceiling applied because none was sent, and a 400 on the
 * first call. The fix then passed the *measured* ceiling — which left every
 * model whose ceiling nobody measured exactly where it had been.
 *
 * The second time was a live routing run. `ax-3.1` reports no measured ceiling,
 * so nothing was sent, and the gateway answered:
 *
 *     This model's maximum context length is 131072 tokens. However, you
 *     requested 128000 output tokens and your prompt contains at least 3073
 *     input tokens, for a total of at least 131073 tokens.
 *
 * The turn ended `reason: error` in 216ms with zero actions, which is what the
 * whole R3 routing path looked like from the outside — a wiring failure. It was
 * one absent field.
 *
 * So: the ceiling is always sent. An absent measurement means the gateway's
 * limit, not the absence of one.
 */

function capturing(): { provider: LlmProvider; sent: ProviderChatRequest[] } {
  const sent: ProviderChatRequest[] = [];
  const provider = {
    async chat(request: ProviderChatRequest) {
      sent.push(request);
      return { text: "ok", reasoning: "", toolCalls: [], usage: null };
    },
  } as unknown as LlmProvider;
  return { provider, sent };
}

describe("an output ceiling is always sent", () => {
  for (const toolProtocol of ["native", "text"] as const) {
    test(`${toolProtocol} — an unmeasured model still bounds its request`, async () => {
      const { provider, sent } = capturing();
      const model = createModelFor({ provider, modelId: "unmeasured", toolProtocol });
      await model.complete({ messages: [{ role: "user", content: "hi" }] }, AbortSignal.timeout(1000));

      assert.equal(sent.length, 1);
      assert.equal(
        sent[0]!.maxOutputTokens,
        UNMEASURED_OUTPUT_CEILING,
        "omitting the field hands the decision to the gateway, which asked for 128000",
      );
    });

    test(`${toolProtocol} — a measured ceiling wins over the default`, async () => {
      const { provider, sent } = capturing();
      const model = createModelFor({
        provider,
        modelId: "measured",
        toolProtocol,
        maxOutputTokens: 32_768,
      });
      await model.complete({ messages: [{ role: "user", content: "hi" }] }, AbortSignal.timeout(1000));
      assert.equal(sent[0]!.maxOutputTokens, 32_768);
    });

    test(`${toolProtocol} — the field is never absent`, async () => {
      const { provider, sent } = capturing();
      const model = createModelFor({ provider, modelId: "m", toolProtocol });
      await model.complete({ messages: [{ role: "user", content: "hi" }] }, AbortSignal.timeout(1000));
      assert.notEqual(sent[0]!.maxOutputTokens, undefined);
    });
  }

  test("the default leaves room in the smallest context this gateway reports", () => {
    // The failure was 128000 output against a 131072 context. Whatever the
    // number is, it has to leave room for a system prompt and some files.
    assert.ok(UNMEASURED_OUTPUT_CEILING <= 16_384);
    assert.ok(UNMEASURED_OUTPUT_CEILING >= 2048, "and be enough for a turn's edits");
  });
});
