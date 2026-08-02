import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createMediaTransport, HasaHttpError } from "./hasaMediaTransport.ts";

/**
 * The media transport.
 *
 * Two properties here are load-bearing and neither is obvious from reading the
 * calling code: the public catalogue must not be sent the API key, and a 200
 * response must not be trusted to contain a media file. The second is not
 * defensive programming — it is the observed behaviour of `/files/{name}`,
 * which answers 200 with `{"detail":"not found"}` and a `video/webm` content
 * type for an API key.
 */

const KEY = "sk-test-0123456789abcdef";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function recorder(reply: (url: string) => Response): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return reply(String(input));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const authOf = (call: Call | undefined): string | undefined => {
  const headers = (call?.init?.headers ?? {}) as Record<string, string>;
  return headers["Authorization"];
};

describe("the public catalogue is not sent the key", () => {
  test("no Authorization header reaches /api/catalog", async () => {
    // It does not need one, and attaching it anyway widens where the key can
    // appear — in a proxy log, in a trace, in a bug report.
    const { calls, fetchImpl } = recorder(() => json([]));
    const transport = createMediaTransport({ origin: "https://gw.example", apiKey: KEY, fetchImpl });
    await transport.fetchJson("/api/catalog");
    assert.equal(calls.length, 1);
    assert.equal(authOf(calls[0]), undefined);
  });

  test("the key never appears anywhere in the catalogue request", async () => {
    const { calls, fetchImpl } = recorder(() => json([]));
    const transport = createMediaTransport({ origin: "https://gw.example", apiKey: KEY, fetchImpl });
    await transport.fetchJson("/api/catalog");
    assert.ok(!JSON.stringify(calls[0]).includes(KEY), "the key leaked into the catalogue call");
  });

  test("the generation endpoints do carry it", async () => {
    const { calls, fetchImpl } = recorder(() => json({ data: [] }));
    const transport = createMediaTransport({ origin: "https://gw.example", apiKey: KEY, fetchImpl });
    await transport.postJson("/v1/images/generations", {});
    assert.equal(authOf(calls[0]), `Bearer ${KEY}`);
  });
});

describe("a 200 is not proof of a media file", () => {
  const withBody = (body: string | Uint8Array, status = 200, type = "video/webm"): typeof fetch =>
    (async () => new Response(body, { status, headers: { "Content-Type": type } })) as typeof fetch;

  test("the observed not-found body is rejected despite the 200 and the content type", async () => {
    // Verbatim from the live gateway: 22 bytes, video/webm, HTTP 200.
    const transport = createMediaTransport({
      origin: "https://gw.example",
      apiKey: KEY,
      fetchImpl: withBody('{"detail":"not found"}'),
    });
    assert.equal(await transport.getBinary("/files/vid_00052_.webm"), null);
  });

  test("any JSON object body is rejected, whatever it says", async () => {
    const transport = createMediaTransport({
      origin: "https://gw.example",
      apiKey: KEY,
      fetchImpl: withBody('{"error":"gone"}'),
    });
    assert.equal(await transport.getBinary("/files/x.webm"), null);
  });

  test("a real container is returned intact", async () => {
    // EBML magic — the start of a WebM file.
    const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03]);
    const transport = createMediaTransport({
      origin: "https://gw.example",
      apiKey: KEY,
      fetchImpl: withBody(bytes),
    });
    assert.deepEqual([...(await transport.getBinary("/files/x.webm") ?? [])], [...bytes]);
  });

  test("an empty body is null rather than a zero-byte file", async () => {
    const transport = createMediaTransport({
      origin: "https://gw.example",
      apiKey: KEY,
      fetchImpl: withBody(new Uint8Array()),
    });
    assert.equal(await transport.getBinary("/files/x.webm"), null);
  });

  test("a non-2xx is null rather than a thrown error", async () => {
    // The caller has a completed job to report; an exception here would turn a
    // successful generation into a failed one.
    const transport = createMediaTransport({
      origin: "https://gw.example",
      apiKey: KEY,
      fetchImpl: withBody("nope", 404, "application/json"),
    });
    assert.equal(await transport.getBinary("/files/x.webm"), null);
  });
});

describe("errors and urls", () => {
  test("a failed POST carries the status and a trimmed body", async () => {
    const { fetchImpl } = recorder(() => json({ detail: "model_not_on_key" }, 403));
    const transport = createMediaTransport({ origin: "https://gw.example", apiKey: KEY, fetchImpl });
    await assert.rejects(
      () => transport.postJson("/v1/images/generations", {}),
      (err: unknown) => err instanceof HasaHttpError && err.status === 403,
    );
  });

  test("a huge error body is trimmed rather than logged whole", async () => {
    const { fetchImpl } = recorder(() => new Response("x".repeat(50_000), { status: 500 }));
    const transport = createMediaTransport({ origin: "https://gw.example", apiKey: KEY, fetchImpl });
    await assert.rejects(
      () => transport.postJson("/v1/videos/generations", {}),
      (err: unknown) => err instanceof Error && err.message.length < 600,
    );
  });

  test("an empty 200 body is an empty object rather than a parse error", async () => {
    const { fetchImpl } = recorder(() => new Response("", { status: 200 }));
    const transport = createMediaTransport({ origin: "https://gw.example", apiKey: KEY, fetchImpl });
    assert.deepEqual(await transport.getJson("/v1/jobs/j"), {});
  });

  test("a trailing slash on the origin does not double up", async () => {
    const { calls, fetchImpl } = recorder(() => json({}));
    const transport = createMediaTransport({ origin: "https://gw.example/", apiKey: KEY, fetchImpl });
    await transport.getJson("/v1/jobs/j");
    assert.equal(calls[0]?.url, "https://gw.example/v1/jobs/j");
  });

  test("a path without a leading slash is still joined correctly", async () => {
    const { calls, fetchImpl } = recorder(() => json({}));
    const transport = createMediaTransport({ origin: "https://gw.example", apiKey: KEY, fetchImpl });
    await transport.getJson("v1/jobs/j");
    assert.equal(calls[0]?.url, "https://gw.example/v1/jobs/j");
  });
});

describe("cancellation", () => {
  test("the caller's signal aborts the request", async () => {
    const controller = new AbortController();
    const fetchImpl = (async (_i: unknown, init?: RequestInit) => {
      controller.abort();
      // Mirrors what a real fetch does once its signal fires.
      if (init?.signal?.aborted === true) throw new DOMException("aborted", "AbortError");
      return json({});
    }) as typeof fetch;

    const transport = createMediaTransport({ origin: "https://gw.example", apiKey: KEY, fetchImpl });
    await assert.rejects(() => transport.getJson("/v1/jobs/j", controller.signal));
  });

  test("a request that finishes does not leave its timeout pending", async () => {
    // A leaked timer keeps the extension host's event loop alive for the whole
    // timeout, which for a video request is three minutes.
    const { fetchImpl } = recorder(() => json({}));
    const transport = createMediaTransport({
      origin: "https://gw.example",
      apiKey: KEY,
      fetchImpl,
      requestTimeoutMs: 60_000,
    });
    await transport.getJson("/v1/jobs/j");

    const pending = process.getActiveResourcesInfo().filter((r) => r === "Timeout");
    assert.equal(pending.length, 0, `${pending.length} timer(s) still pending`);
  });
});
