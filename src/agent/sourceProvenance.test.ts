import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  atLeast,
  classifyStatus,
  classifyWebFailure,
  exactSourcesIn,
  fingerprint,
  hostMatches,
  isWebBlocker,
  normalizeHost,
  redactUrl,
  serviceName,
} from "./sourceProvenance.ts";
import { createWebTools } from "./tools/webTools.ts";
import { newProgressState, observeAction } from "./progress.ts";
import type { AgentTool, ToolContext, ToolResult } from "./types.ts";

/**
 * Where a fact came from, kept apart from what it is about.
 *
 * The transcript this exists for asked for models on two services, searched the
 * web once, got Hugging Face results, and presented them as what was available
 * on the other service. Every assertion below is a way that sentence cannot be
 * written any more.
 *
 * The web tools are exercised for real — `fetchImpl` is the only thing swapped
 * out — because provenance that is only correct in a mock is provenance that
 * will be wrong the first time a redirect happens.
 */

const HASA = "open.hasa.re.kr";
const HF = "huggingface.co";
const SPOOF = "open.hasa.re.kr.evil.example.com";

function context(): ToolContext {
  return { signal: new AbortController().signal, workspaceRoot: "/workspace" };
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

/** A search results page in the shape `parseSearchResults` reads. */
function results(items: Array<{ title: string; url: string; snippet: string }>): Response {
  const blocks = items
    .map(
      (r) =>
        `<div class="result"><a class="result__a" href="${r.url}">${r.title}</a>` +
        `<a class="result__snippet">${r.snippet}</a></div>`,
    )
    .join("");
  return html(`<html><body>${blocks}</body></html>`);
}

interface Tools {
  search: AgentTool;
  fetch: AgentTool;
}

function webTools(
  fetchImpl: typeof fetch,
  userSources: string[] = [],
): Tools {
  const tools = createWebTools({
    fetchImpl,
    // The private-address guard has nothing to check against a stub fetch and
    // would reject the host for having no resolvable address.
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    userSources: () => exactSourcesIn(userSources.join(" ")),
  });
  const search = tools.find((t) => t.name === "web_search");
  const fetchTool = tools.find((t) => t.name === "web_fetch");
  assert.ok(search !== undefined && fetchTool !== undefined);
  return { search, fetch: fetchTool };
}

// ---------------------------------------------------------------------------
// 20 — hostnames have boundaries
// ---------------------------------------------------------------------------

describe("20 — a hostname is compared on a dot boundary, never as a substring", () => {
  test("the spoof domain is not the service", () => {
    // The whole reason `hostMatches` exists rather than `includes`. This host
    // is somebody else's, named to be read carelessly.
    assert.equal(hostMatches(SPOOF, HASA), false);
    assert.equal(SPOOF.includes(HASA), true, "which is exactly why includes() is not enough");
  });

  test("the host itself and its subdomains are", () => {
    assert.equal(hostMatches(HASA, HASA), true);
    assert.equal(hostMatches("api.open.hasa.re.kr", HASA), true);
    assert.equal(hostMatches("OPEN.HASA.RE.KR.", HASA), true, "case and trailing dot");
    assert.equal(hostMatches("open.hasa.re.kr:8443", HASA), true, "a port is not a different host");
  });

  test("and a near miss is not", () => {
    assert.equal(hostMatches("notopen.hasa.re.kr", "open.hasa.re.kr"), false);
    assert.equal(hostMatches("hasa.re.kr", "open.hasa.re.kr"), false, "a parent is not a child");
    assert.equal(hostMatches("", HASA), false);
    assert.equal(hostMatches(HASA, ""), false);
  });

  test("normalization is the same in both directions", () => {
    assert.equal(normalizeHost("  HuggingFace.CO. "), "huggingface.co");
  });

  test("a service name is for reading prose, and is derived not guessed", () => {
    assert.equal(serviceName(HASA), "hasa");
    assert.equal(serviceName("huggingface.co"), "huggingface");
    assert.equal(serviceName("api.github.com"), "github");
    // The spoof's name is the attacker's, which is the point: it does not
    // become "hasa" by having those letters in it.
    assert.equal(serviceName(SPOOF), "example");
  });
});

// ---------------------------------------------------------------------------
// 2 — URLs the user named
// ---------------------------------------------------------------------------

describe("2 — a URL in the user's message is a source, not a word", () => {
  test("with or without a scheme", () => {
    const found = exactSourcesIn(
      "Hugging Face와 https://open.hasa.re.kr/models 에서 활용할 수 있는 모델을 찾아줘. " +
        "huggingface.co/models 도 봐줘.",
    );
    assert.deepEqual(
      found.map((s) => s.hostname),
      ["open.hasa.re.kr", "huggingface.co"],
    );
  });

  test("trailing punctuation is not part of the URL", () => {
    const [source] = exactSourcesIn("https://open.hasa.re.kr/models, 확인해줘.");
    assert.equal(source?.url, "https://open.hasa.re.kr/models");
  });

  test("a version or a file name is not a host", () => {
    assert.deepEqual(exactSourcesIn("torch 2.1.0 을 설치하고 main.py 를 실행해줘"), []);
  });

  test("the same URL twice is one source", () => {
    assert.equal(exactSourcesIn("open.hasa.re.kr/models 와 open.hasa.re.kr/models").length, 1);
  });
});

// ---------------------------------------------------------------------------
// 7 / 23 — a search discovers; a fetch reads
// ---------------------------------------------------------------------------

describe("7 — search discovers, fetch reads, and they are different records", () => {
  test("a search records every result host as a discovery", async () => {
    const { search } = webTools(async () =>
      results([
        { title: "ViT — Hugging Face", url: "https://huggingface.co/google/vit-base", snippet: "image classification" },
      ]),
    );
    const result = await search.execute({ query: "HASA image classification model" }, context());

    assert.equal(result.ok, true);
    assert.equal(result.sources?.length, 1);
    const [source] = result.sources ?? [];
    assert.equal(source?.retrieval, "search_discovery", "nobody opened it");
    assert.equal(source?.sourceOrigin, "search_result");
    assert.equal(source?.hostname, "huggingface.co");
  });

  test("23 — QUERY SUBJECT ≠ RESULT SOURCE", async () => {
    // The failure in one assertion. Searching for HASA and being handed Hugging
    // Face pages does not make them HASA pages, and the record now says which
    // they were.
    const { search } = webTools(async () =>
      results([
        { title: "ViT", url: "https://huggingface.co/google/vit-base", snippet: "Model X available on HASA…" },
        { title: "ResNet", url: "https://huggingface.co/microsoft/resnet-50", snippet: "…" },
      ]),
    );
    const result = await search.execute({ query: "open.hasa.re.kr 에서 쓸 수 있는 모델" }, context());

    const hosts = new Set((result.sources ?? []).map((s) => s.hostname));
    assert.deepEqual([...hosts], ["huggingface.co"]);
    assert.ok(!hosts.has(HASA), "the subject of the query is not a source");
    // And the query is kept, so the confusion is legible afterwards rather than
    // only preventable.
    assert.match(result.sources?.[0]?.query ?? "", /open\.hasa\.re\.kr/);
  });

  test("a fetch records the body it actually read", async () => {
    const { fetch } = webTools(async () => html("<html><title>Models</title><body>qwen-x</body></html>"));
    const result = await fetch.execute({ url: `https://${HASA}/models` }, context());

    const [source] = result.sources ?? [];
    assert.equal(source?.retrieval, "fetched");
    assert.equal(source?.hostname, HASA);
    assert.equal(source?.status, 200);
    assert.ok((source?.contentFingerprint ?? "").length > 0);
  });

  test("origin says who chose the URL, and nothing about authority", async () => {
    const impl: typeof fetch = async () => html("<html><body>models</body></html>");
    const named = webTools(impl, [`https://${HASA}/models`]);
    const unnamed = webTools(impl, []);

    const mine = await named.fetch.execute({ url: `https://${HASA}/models` }, context());
    const theirs = await unnamed.fetch.execute({ url: `https://${HASA}/models` }, context());

    assert.equal(mine.sources?.[0]?.sourceOrigin, "user_supplied");
    assert.equal(theirs.sources?.[0]?.sourceOrigin, "model_discovered");
    // There is no `first_party` anywhere in what was recorded. The user handing
    // over a URL says who picked it, not that the site is official.
    assert.ok(!JSON.stringify(mine.sources).includes("first_party"));
  });

  test("6 — a spoof host the user never named is not theirs", async () => {
    const { fetch } = webTools(
      async () => html("<html><body>HASA models</body></html>"),
      [`https://${HASA}/models`],
    );
    const result = await fetch.execute({ url: `https://${SPOOF}/models` }, context());

    assert.equal(result.sources?.[0]?.hostname, SPOOF);
    assert.equal(
      result.sources?.[0]?.sourceOrigin,
      "model_discovered",
      "a host that merely contains the named one is a different host",
    );
  });
});

// ---------------------------------------------------------------------------
// Provenance is persisted, so it is held to the storage rule
// ---------------------------------------------------------------------------

describe("a URL is one of the places a credential arrives looking like text", () => {
  const CANARY = "HASA_SECRET_MUST_NOT_APPEAR_123456";

  test("userinfo and secret-shaped parameters are redacted, the host is not", () => {
    const redacted = redactUrl(`https://user:${CANARY}@${HASA}/models?api_key=${CANARY}&page=2`);
    assert.ok(!redacted.includes(CANARY), redacted);
    assert.match(redacted, new RegExp(HASA), "the host is what provenance is for");
    assert.match(redacted, /page=2/, "an ordinary parameter survives");
  });

  test("a parameter that merely contains the letters is left alone", () => {
    const kept = redactUrl(`https://${HASA}/models?keyboard=abc&monkeys=2`);
    assert.match(kept, /keyboard=abc/);
    assert.match(kept, /monkeys=2/);
  });

  test("nothing the fetch records carries it", async () => {
    const { fetch } = webTools(async () => html("<html><body>models</body></html>"));
    const result = await fetch.execute(
      { url: `https://svc:${CANARY}@${HASA}/models?token=${CANARY}` },
      context(),
    );

    // Everything that reaches an event: the provenance, and the two fields the
    // recorder copies alongside it.
    assert.ok(!JSON.stringify(result.sources).includes(CANARY), JSON.stringify(result.sources));
    assert.equal(result.sources?.[0]?.hostname, HASA, "still identifiable as the same host");
  });

  test("and neither does a search result", async () => {
    const { search } = webTools(async () =>
      results([{ title: "x", url: `https://${HF}/x?apikey=${CANARY}`, snippet: "s" }]),
    );
    const result = await search.execute({ query: "models" }, context());
    assert.ok(!JSON.stringify(result.sources).includes(CANARY));
  });
});

// ---------------------------------------------------------------------------
// 19 — redirects
// ---------------------------------------------------------------------------

describe("19 — a redirect can change who answered, so both ends are kept", () => {
  test("requested and final URL both survive a cross-domain hop", async () => {
    const { fetch } = webTools(async (input) => {
      const url = String(input);
      return url.includes(HASA)
        ? new Response("", { status: 302, headers: { location: "https://elsewhere.example.com/models" } })
        : html("<html><body>somebody else's list</body></html>");
    });
    const result = await fetch.execute({ url: `https://${HASA}/models` }, context());

    const [source] = result.sources ?? [];
    assert.match(source?.requestedUrl ?? "", new RegExp(HASA));
    assert.match(source?.finalUrl ?? "", /elsewhere\.example\.com/);
    // The hostname is whoever served the bytes. Content belongs to the host
    // that sent it, not to the one that was asked.
    assert.equal(source?.hostname, "elsewhere.example.com");
    // And the model is told in prose too, because it is about to write a
    // sentence naming a site.
    assert.match(result.content, /elsewhere\.example\.com/);
  });

  test("a same-site redirect is not announced as a change of source", async () => {
    const { fetch } = webTools(async (input) =>
      String(input).endsWith("/models")
        ? new Response("", { status: 302, headers: { location: `https://${HASA}/models/list` } })
        : html("<html><body>list</body></html>"),
    );
    const result = await fetch.execute({ url: `https://${HASA}/models` }, context());

    assert.equal(result.sources?.[0]?.hostname, HASA);
    assert.ok(!result.content.includes("이동했습니다"), "nothing changed hands");
  });
});

// ---------------------------------------------------------------------------
// 21 — truncation
// ---------------------------------------------------------------------------

describe("21 — a page that arrived cut says so", () => {
  test("the byte cap sets truncated on the provenance", async () => {
    // Over the 60,000-character page cap, which is the one a model actually
    // hits; the client's 5 MB byte cap is the other half of the same field.
    const { fetch } = webTools(async () => html(`<html><body>${"모델-목록 ".repeat(15_000)}</body></html>`));
    const result = await fetch.execute({ url: `https://${HASA}/models` }, context());

    // 5 MB is the client's cap and this is nowhere near it; what is exercised
    // here is the char cap, which is the one a model actually hits.
    assert.equal(result.meta?.truncated, true);
    assert.equal(result.sources?.[0]?.truncated, true);
  });

  test("a whole page does not claim to be cut", async () => {
    const { fetch } = webTools(async () => html("<html><body>short</body></html>"));
    const result = await fetch.execute({ url: `https://${HASA}/models` }, context());
    assert.equal(result.sources?.[0]?.truncated, undefined);
  });
});

// ---------------------------------------------------------------------------
// 18 — HTTP failures are not one failure
// ---------------------------------------------------------------------------

describe("18 — what went wrong on the web, told apart", () => {
  test("statuses map to what they mean", () => {
    assert.equal(classifyStatus(401), "auth_required");
    assert.equal(classifyStatus(403), "access_denied");
    assert.equal(classifyStatus(404), "source_not_found");
    assert.equal(classifyStatus(429), "rate_limited");
    assert.equal(classifyStatus(503), "remote_service_failure");
    assert.equal(classifyStatus(418), "unknown_failure", "an unknown status is not a guess");
  });

  test("the distinctions that were being collapsed", () => {
    // Each of these three was the same "the web didn't work" before.
    assert.equal(classifyWebFailure("open.hasa.re.kr answered 404. The page may be gone."), "source_not_found");
    assert.equal(classifyWebFailure("https://x.example did not answer in time."), "network_failure");
    assert.equal(classifyWebFailure("The search service answered 429."), "rate_limited");
    assert.notEqual(classifyWebFailure("answered 404"), "network_failure", "404 is not a network failure");
    assert.notEqual(classifyWebFailure("answered 429"), "source_not_found", "429 is not absence");
  });

  test("no results is an answer, not a blocker", () => {
    const kind = classifyWebFailure('No results for "qwen-x". Try different words.');
    assert.equal(kind, "no_results");
    assert.equal(isWebBlocker(kind), false, "the search worked and found nothing");
  });

  test("a missing page is an answer too; a refused one is not", () => {
    assert.equal(isWebBlocker("source_not_found"), false);
    assert.equal(isWebBlocker("access_denied"), true);
    assert.equal(isWebBlocker("auth_required"), true);
    assert.equal(isWebBlocker("network_failure"), true);
    assert.equal(isWebBlocker("rate_limited"), true);
  });

  test("a real 404 from the client carries its status into the message", async () => {
    const { fetch } = webTools(async () => new Response("", { status: 404 }));
    const result = await fetch.execute({ url: `https://${HASA}/models` }, context());

    assert.equal(result.ok, false);
    assert.equal(classifyWebFailure(result.content), "source_not_found");
    assert.equal(result.sources, undefined, "a page that did not arrive is not a source");
  });
});

// ---------------------------------------------------------------------------
// 8 — nothing promotes on its own
// ---------------------------------------------------------------------------

describe("8 — the levels compare, and nothing raises one", () => {
  test("atLeast is an ordering", () => {
    assert.equal(atLeast("listed", "discovered"), true);
    assert.equal(atLeast("discovered", "listed"), false);
    assert.equal(atLeast("invocation_verified", "listed"), true);
    // The rung the C4.6.1 correction added. Having read a page is above having
    // seen it in search results and below having found the thing on it.
    assert.equal(atLeast("fetched", "discovered"), true);
    assert.equal(atLeast("fetched", "listed"), false, "reading a page is not finding a thing on it");
    assert.equal(atLeast(null, "discovered"), false, "nothing observed reaches nothing");
  });
});

// ---------------------------------------------------------------------------
// 25 / 34 — reading the same page again is not news
// ---------------------------------------------------------------------------

describe("34 — the same page fetched four times is one observation", () => {
  /**
   * Driven through the real tool, and that is the point.
   *
   * A hand-written `detail` misses what makes this hard: the first 200
   * characters of a fetch result are the quarantine banner, identical for every
   * page. `errorGist` sees only that, so two genuinely different pages from the
   * same URL look like the same observation unless something else distinguishes
   * them. Constructing the detail by hand hid that and the mutation slipped
   * through — twice, before this was written the honest way.
   */
  async function fetchOf(url: string, body: string): Promise<Parameters<typeof observeAction>[1]> {
    const { fetch } = webTools(async () => html(`<html><body>${body}</body></html>`));
    const result = await fetch.execute({ url }, context());
    assert.equal(result.ok, true, result.content);
    return {
      toolName: "web_fetch",
      args: { url },
      outcome: "executed",
      detail: result.content,
      changedFiles: [],
      ...(result.sources === undefined ? {} : { sources: result.sources }),
    };
  }

  test("the first read counts and the repeats do not", async () => {
    const state = newProgressState();
    const same = await fetchOf(`https://${HASA}/models`, "qwen-x, llama-y");

    assert.equal(observeAction(state, same), "weak", "reading something new is real work");
    assert.equal(observeAction(state, same), "none");
    assert.equal(observeAction(state, same), "none");
    assert.equal(observeAction(state, same), "none");
    assert.equal(state.streak, 3);
  });

  test("but a page whose content changed is a new observation", async () => {
    // The URL is identical and the banner is identical. Only the fingerprint
    // can tell these two apart.
    const state = newProgressState();
    const first = await fetchOf(`https://${HASA}/models`, "qwen-x");
    const second = await fetchOf(`https://${HASA}/models`, "qwen-x, llama-y");
    assert.notEqual(
      first.detail.slice(0, 200),
      undefined,
      "the assertion below is only meaningful because these share a prefix",
    );
    assert.equal(first.detail.slice(0, 200), second.detail.slice(0, 200), "same banner, as in production");

    assert.equal(observeAction(state, first), "weak");
    assert.equal(observeAction(state, second), "weak", "the page changed; that is news");
  });

  test("and a different source is a new observation", async () => {
    const state = newProgressState();
    assert.equal(observeAction(state, await fetchOf(`https://${HASA}/models`, "qwen-x")), "weak");
    assert.equal(observeAction(state, await fetchOf("https://huggingface.co/models", "vit")), "weak");
  });

  test("the same search answered the same way is not four discoveries", () => {
    const state = newProgressState();
    const search = {
      toolName: "web_search",
      args: { query: "hasa models" },
      outcome: "executed" as const,
      detail: "1. ViT\n   https://huggingface.co/google/vit-base",
      changedFiles: [],
      sources: [
        {
          hostname: "huggingface.co",
          sourceOrigin: "search_result" as const,
          retrieval: "search_discovery" as const,
          retrievedAt: 1,
          query: "hasa models",
          requestedUrl: "https://huggingface.co/google/vit-base",
        },
      ],
    };
    assert.equal(observeAction(state, search), "weak");
    assert.equal(observeAction(state, search), "none");
    assert.equal(observeAction(state, search), "none");
  });
});

// ---------------------------------------------------------------------------
// A fingerprint is for novelty, and has to behave like one
// ---------------------------------------------------------------------------

describe("fingerprints", () => {
  test("same text, same value; different text, different value", () => {
    assert.equal(fingerprint("qwen-x"), fingerprint("qwen-x"));
    assert.notEqual(fingerprint("qwen-x"), fingerprint("qwen-y"));
    assert.notEqual(fingerprint(""), fingerprint(" "));
  });
});

void ((): ToolResult | null => null);
