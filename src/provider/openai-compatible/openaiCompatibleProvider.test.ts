import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "../../protocol/index.ts";
import { ProviderError } from "../errors.ts";
import type {
  ModelListOptions,
  ModelListing,
  ProviderRequestOptions,
  ProviderStreamEvent,
  ProviderValidation,
} from "../types.ts";
import {
  OpenAiCompatibleProvider,
  type ChatTransport,
  type TransportRequestOptions,
} from "./openaiCompatibleProvider.ts";

/**
 * The base class, exercised without HASA.
 *
 * `HasaProvider` is the only subclass today, so every test of the base runs
 * through HASA-specific code and cannot tell the two apart. This file builds a
 * second, deliberately alien subclass: a different gateway, a different error
 * vocabulary, a different catalogue. If any HASA assumption has leaked down
 * into the base, it shows up here.
 */

interface Recorded {
  chatCalls: ChatCompletionRequest[];
  streamCalls: ChatCompletionRequest[];
  options: TransportRequestOptions[];
}

class NotHasaProvider extends OpenAiCompatibleProvider {
  readonly recorded: Recorded = { chatCalls: [], streamCalls: [], options: [] };
  mapped = 0;

  constructor(transport: ChatTransport) {
    super({ id: "hasa", displayName: "Some Other Gateway", transport });
  }

  async listModels(_opts: ModelListOptions = {}): Promise<ModelListing> {
    const records = await this.transport.listModelRecords();
    return {
      models: records.map((r) => ({
        id: r.id,
        ownedBy: r.ownedBy,
        capabilities: {
          chat: "unknown",
          streaming: "unknown",
          toolCalling: "unknown",
          coding: "unknown",
          reasoning: "unknown",
          vision: "unknown",
          embedding: "unknown",
          reranking: "unknown",
        },
        limits: { maxOutputTokens: null, contextWindow: null },
      })),
      source: "network",
      fetchedAt: new Date(0).toISOString(),
      stale: false,
      warning: null,
    };
  }

  async validate(_opts: ProviderRequestOptions = {}): Promise<ProviderValidation> {
    return {
      endpointReachable: true,
      credentialValid: "unknown",
      modelCount: 0,
      probedModelId: null,
      allowedModels: null,
      detail: "확인하지 않았습니다.",
      error: null,
    };
  }

  /** A vocabulary that shares nothing with HASA's. */
  protected mapError(err: unknown): ProviderError {
    this.mapped += 1;
    if (err instanceof ProviderError) return err;
    return new ProviderError({
      code: "protocol",
      detail: "some other gateway said no",
      userMessage: "다른 게이트웨이가 요청을 거절했습니다.",
      cause: err,
    });
  }
}

function providerWith(opts: {
  chat?: (req: ChatCompletionRequest) => Promise<ChatCompletionResponse>;
  chunks?: ChatCompletionChunk[];
  streamThrows?: unknown;
}): NotHasaProvider {
  let provider: NotHasaProvider;
  const transport: ChatTransport = {
    baseUrl: "https://elsewhere.example/v1",
    listModelRecords: async () => [{ id: "their-model", ownedBy: "them" }],
    chat: async (req, o = {}) => {
      provider.recorded.chatCalls.push(req);
      provider.recorded.options.push(o);
      if (!opts.chat) throw new Error("boom");
      return opts.chat(req);
    },
    streamChunks: async function* (req, o = {}) {
      provider.recorded.streamCalls.push(req);
      provider.recorded.options.push(o);
      if (opts.streamThrows !== undefined) throw opts.streamThrows;
      for (const chunk of opts.chunks ?? []) yield chunk;
    },
  };
  provider = new NotHasaProvider(transport);
  return provider;
}

async function collect(events: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("identity comes from the subclass, not the base", () => {
  test("the display name and base URL are the subclass's own", () => {
    const provider = providerWith({});
    assert.equal(provider.displayName, "Some Other Gateway");
    assert.equal(provider.baseUrl, "https://elsewhere.example/v1");
  });

  test("the base URL tracks the transport rather than being copied at construction", () => {
    // A transport that reconfigures itself — a redirect, a failover — must not
    // leave the provider reporting the old host.
    let host = "https://first.example/v1";
    const provider = new NotHasaProvider({
      get baseUrl() {
        return host;
      },
      listModelRecords: async () => [],
      chat: async () => ({ choices: [] }),
      streamChunks: async function* () {},
    });
    assert.equal(provider.baseUrl, "https://first.example/v1");
    host = "https://second.example/v1";
    assert.equal(provider.baseUrl, "https://second.example/v1");
  });
});

describe("chat, with no HASA anywhere in the path", () => {
  test("translates the request and the response", async () => {
    const provider = providerWith({
      chat: async () => ({
        model: "their-model",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      }),
    });

    const res = await provider.chat({
      modelId: "their-model",
      messages: [{ role: "user", content: "hello" }],
      maxOutputTokens: 8,
    });

    assert.equal(res.text, "hi");
    assert.equal(res.modelId, "their-model");
    assert.equal(provider.recorded.chatCalls[0]?.max_tokens, 8);
    assert.equal(provider.recorded.chatCalls[0]?.stream, false);
  });

  test("failures go through the subclass's mapper, not a built-in one", async () => {
    const provider = providerWith({});
    await assert.rejects(
      provider.chat({ modelId: "m", messages: [] }),
      (e: unknown) =>
        e instanceof ProviderError && e.code === "protocol" && e.userMessage.includes("다른 게이트웨이"),
    );
    assert.equal(provider.mapped, 1);
  });
});

describe("streaming, with no HASA anywhere in the path", () => {
  test("emits normalised events", async () => {
    const provider = providerWith({
      chunks: [
        { choices: [{ index: 0, delta: { content: "a" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: "b" }, finish_reason: "stop" }] },
      ],
    });

    const events = await collect(provider.stream({ modelId: "m", messages: [] }));
    assert.deepEqual(events, [
      { type: "text", delta: "a" },
      { type: "text", delta: "b" },
      { type: "done", finishReason: "stop" },
    ]);
    assert.equal(provider.recorded.streamCalls[0]?.stream, true);
  });

  test("a transport that throws while being pulled is still mapped", async () => {
    // The mapping has to wrap the iteration, not the call: an async generator
    // does not fail until something reads from it.
    const provider = providerWith({ streamThrows: new Error("mid-stream") });
    await assert.rejects(
      collect(provider.stream({ modelId: "m", messages: [] })),
      (e: unknown) => e instanceof ProviderError && e.code === "protocol",
    );
    assert.equal(provider.mapped, 1);
  });

  test("an already-mapped error is not mapped twice", async () => {
    const provider = providerWith({
      streamThrows: new ProviderError({ code: "rate_limited", detail: "slow down" }),
    });
    await assert.rejects(
      collect(provider.stream({ modelId: "m", messages: [] })),
      (e: unknown) => e instanceof ProviderError && e.code === "rate_limited",
    );
  });
});

describe("request options", () => {
  test("only the options the caller set are forwarded", async () => {
    const provider = providerWith({ chat: async () => ({ choices: [] }) });

    await provider.chat({ modelId: "m", messages: [] });
    assert.deepEqual(Object.keys(provider.recorded.options[0] ?? {}), []);

    const controller = new AbortController();
    await provider.chat({ modelId: "m", messages: [] }, { signal: controller.signal, maxRetries: 0 });
    assert.deepEqual(Object.keys(provider.recorded.options[1] ?? {}).sort(), ["maxRetries", "signal"]);
    assert.equal(provider.recorded.options[1]?.maxRetries, 0);
  });

  test("a zero timeout is forwarded rather than treated as absent", async () => {
    const provider = providerWith({ chat: async () => ({ choices: [] }) });
    await provider.chat({ modelId: "m", messages: [] }, { timeoutMs: 0 });
    assert.equal(provider.recorded.options[0]?.timeoutMs, 0);
  });

  test("options reach the streaming path too", async () => {
    const provider = providerWith({ chunks: [] });
    await collect(provider.stream({ modelId: "m", messages: [] }, { timeoutMs: 77 }));
    assert.equal(provider.recorded.options[0]?.timeoutMs, 77);
  });
});
