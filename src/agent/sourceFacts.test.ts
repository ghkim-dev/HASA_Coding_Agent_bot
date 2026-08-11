import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SourceLedger, factKey, knownSubjects, redactSpan, verifyFact } from "./sourceFacts.ts";
import { createSourceFactTool } from "./tools/sourceFactTool.ts";
import { createWebTools } from "./tools/webTools.ts";
import { reduceTask } from "./taskReducer.ts";
import { entityLevel, unsupportedClaims } from "./claimGrounding.ts";
import { TurnRecorder } from "./sessionRecorder.ts";
import { newProgressState, observeAction } from "./progress.ts";
import { fingerprint } from "./sourceProvenance.ts";
import type { SourceFact } from "./sourceFacts.ts";
import type { SessionEvent } from "./sessionEvents.ts";
import type { AgentEvent, AgentTool, ToolContext } from "./types.ts";

/**
 * What a page said, checked against the page.
 *
 * The model interprets — reading a catalog is interpretation and a runtime
 * cannot do it. What the runtime does is refuse an interpretation the source
 * does not carry, which is checkable because the body is still in memory when
 * the claim is made. That is the whole mechanism, and the tests below are the
 * ways it can be got round.
 */

const HASA = "open.hasa.re.kr";
const HF = "huggingface.co";

function context(): ToolContext {
  return { signal: new AbortController().signal, workspaceRoot: "/workspace" };
}

function page(body: string): Response {
  return new Response(`<html><body>${body}</body></html>`, {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

/**
 * A real fetch and a real fact tool over one ledger.
 *
 * Driven end to end rather than by handing the ledger a string, because the
 * thing being tested is that a fact is checked against *what the fetch
 * returned* — after HTML-to-text, after truncation, after everything the
 * pipeline does to a page on the way in.
 */
function workspace(pages: Record<string, string>): {
  fetch: AgentTool;
  record: AgentTool;
  ledger: SourceLedger;
  facts: SourceFact[];
} {
  const ledger = new SourceLedger();
  const facts: SourceFact[] = [];
  const [, fetchTool] = createWebTools({
    fetchImpl: async (input) => {
      const url = String(input);
      const body = Object.entries(pages).find(([key]) => url.includes(key))?.[1];
      return body === undefined ? new Response("", { status: 404 }) : page(body);
    },
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    ledger,
  });
  assert.ok(fetchTool !== undefined);
  let n = 0;
  const record = createSourceFactTool({
    ledger,
    nextId: () => `sf-${++n}`,
    now: () => 1,
    onFact: (fact) => facts.push(fact),
  });
  return { fetch: fetchTool, record, ledger, facts };
}

// ---------------------------------------------------------------------------
// 5 / 6 — a fact has to come out of a source, and say what the source says
// ---------------------------------------------------------------------------

describe("5 — a fact is checked against the page it names", () => {
  test("a subject the page carries is recorded", async () => {
    const w = workspace({ [HASA]: '"id":"exaone-4.0-32b", "id":"qwen-x"' });
    await w.fetch.execute({ url: `https://${HASA}/models` }, context());

    const result = await w.record.execute(
      { url: `https://${HASA}/models`, subject: "exaone-4.0-32b", predicate: "listed", sourceText: '"id":"exaone-4.0-32b"' },
      context(),
    );

    assert.equal(result.ok, true, result.content);
    assert.equal(w.facts.length, 1);
    assert.equal(w.facts[0]?.subject, "exaone-4.0-32b");
    assert.equal(w.facts[0]?.hostname, HASA);
    assert.equal(w.facts[0]?.origin, "explicit");
    assert.equal(w.facts[0]?.sourceText, '"id":"exaone-4.0-32b"');
  });

  test("a subject the page does not carry is refused", async () => {
    // The cross-attribution, caught at the moment it is written down rather
    // than at the moment it is said.
    const w = workspace({ [HASA]: "qwen-x", [HF]: "Model A" });
    await w.fetch.execute({ url: `https://${HF}/models` }, context());
    await w.fetch.execute({ url: `https://${HASA}/models` }, context());

    const result = await w.record.execute(
      { url: `https://${HASA}/models`, subject: "Model A", predicate: "listed" },
      context(),
    );

    assert.equal(result.ok, false);
    assert.match(result.content, /Model A/);
    assert.match(result.content, new RegExp(HASA));
    assert.match(result.content, /다른 출처에서 본 것을/);
    assert.equal(w.facts.length, 0);
  });

  test("a quote that is not in the page is refused, and says which half was wrong", async () => {
    const w = workspace({ [HASA]: "qwen-x is available" });
    await w.fetch.execute({ url: `https://${HASA}/models` }, context());

    const result = await w.record.execute(
      { url: `https://${HASA}/models`, subject: "qwen-x", predicate: "listed", sourceText: "qwen-x is recommended" },
      context(),
    );
    assert.equal(result.ok, false);
    assert.match(result.content, /sourceText/);
    assert.equal(w.facts.length, 0);
  });

  test("no quote is fine, and is recorded as inferred", async () => {
    // A catalog rendered as a table may have no span worth quoting. Refusing
    // those would push the model towards inventing one.
    const w = workspace({ [HASA]: "qwen-x" });
    await w.fetch.execute({ url: `https://${HASA}/models` }, context());
    const result = await w.record.execute(
      { url: `https://${HASA}/models`, subject: "qwen-x", predicate: "listed" },
      context(),
    );
    assert.equal(result.ok, true, result.content);
    assert.equal(w.facts[0]?.origin, "inferred");
    assert.equal(w.facts[0]?.sourceText, undefined);
  });

  test("a page nobody fetched is refused, and says what was read", async () => {
    const w = workspace({ [HASA]: "qwen-x" });
    await w.fetch.execute({ url: `https://${HASA}/models` }, context());

    const result = await w.record.execute(
      { url: `https://${HF}/models`, subject: "Model A", predicate: "listed" },
      context(),
    );
    assert.equal(result.ok, false);
    assert.match(result.content, new RegExp(HASA), "the message names where it did read");
    assert.match(result.content, /web_fetch/);
  });

  test("a path on the same host that was not fetched is refused", async () => {
    // Otherwise "I read the site" would settle a fact about any page on it.
    const w = workspace({ [`${HASA}/docs`]: "qwen-x" });
    await w.fetch.execute({ url: `https://${HASA}/docs` }, context());

    const result = await w.record.execute(
      { url: `https://${HASA}/pricing`, subject: "qwen-x", predicate: "listed" },
      context(),
    );
    assert.equal(result.ok, false);
  });

  test("an unknown predicate is refused rather than coerced", async () => {
    const w = workspace({ [HASA]: "qwen-x" });
    await w.fetch.execute({ url: `https://${HASA}/models` }, context());
    const result = await w.record.execute(
      { url: `https://${HASA}/models`, subject: "qwen-x", predicate: "definitely_works" },
      context(),
    );
    assert.equal(result.ok, false);
    assert.match(result.content, /mentioned, listed, downloadable/);
  });

  test("matching survives the whitespace HTML-to-text leaves behind", async () => {
    const w = workspace({ [HASA]: "<td>  qwen-x  </td>\n<td>ready</td>" });
    await w.fetch.execute({ url: `https://${HASA}/models` }, context());
    const result = await w.record.execute(
      { url: `https://${HASA}/models`, subject: "qwen-x", predicate: "listed", sourceText: "qwen-x ready" },
      context(),
    );
    assert.equal(result.ok, true, result.content);
  });
});

// ---------------------------------------------------------------------------
// 5 — a discovery is not a source
// ---------------------------------------------------------------------------

describe("5 — a search result cannot ground a fact", () => {
  test("the ledger holds only what was fetched", async () => {
    const ledger = new SourceLedger();
    const [search] = createWebTools({
      fetchImpl: async () =>
        page(
          `<div class="result"><a class="result__a" href="https://${HASA}/models">HASA models</a>` +
            `<a class="result__snippet">Model A available on HASA</a></div>`,
        ),
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      ledger,
    });
    assert.ok(search !== undefined);
    const result = await search.execute({ query: "hasa models" }, context());

    assert.equal(result.ok, true);
    assert.equal(ledger.size, 0, "a search read a results page, not the pages it listed");
    const verdict = verifyFact(
      { url: `https://${HASA}/models`, subject: "Model A", predicate: "listed" },
      ledger,
      1,
      "sf-1",
    );
    assert.equal(verdict.ok, false);
  });
});

// ---------------------------------------------------------------------------
// 7 — nothing large and nothing secret is persisted
// ---------------------------------------------------------------------------

describe("7 — the page stays in memory; the fact goes to disk", () => {
  const CANARY = "HASA_SECRET_MUST_NOT_APPEAR_123456";

  test("the recorded fact carries a bounded span, not the body", async () => {
    const w = workspace({ [HASA]: `qwen-x ${"채워넣기 ".repeat(3000)}` });
    await w.fetch.execute({ url: `https://${HASA}/models` }, context());
    await w.record.execute({ url: `https://${HASA}/models`, subject: "qwen-x", predicate: "listed" }, context());

    const serialized = JSON.stringify(w.facts);
    assert.ok(serialized.length < 1000, `a fact is small: ${serialized.length}`);
    assert.ok(!serialized.includes("채워넣기 채워넣기"), "the body is not in it");
  });

  test("a span carrying a key is redacted before it is stored", async () => {
    const w = workspace({ [HASA]: `qwen-x api_key=${CANARY} rest` });
    await w.fetch.execute({ url: `https://${HASA}/models` }, context());
    const result = await w.record.execute(
      { url: `https://${HASA}/models`, subject: "qwen-x", predicate: "listed", sourceText: `qwen-x api_key=${CANARY}` },
      context(),
    );

    assert.equal(result.ok, true, result.content);
    assert.ok(!JSON.stringify(w.facts).includes(CANARY), JSON.stringify(w.facts));
  });

  test("and a URL inside a span goes through the same redaction", () => {
    const span = redactSpan(`see https://${HASA}/v1?token=${CANARY} for details`);
    assert.ok(!span.includes(CANARY));
    assert.match(span, new RegExp(HASA), "the host is what a span is for");
  });

  test("the ledger is bounded", () => {
    const ledger = new SourceLedger(3);
    for (let i = 0; i < 10; i += 1) ledger.remember(`https://x${i}.example.com/p`, `x${i}.example.com`, `body ${i}`);
    assert.equal(ledger.size, 3);
    assert.equal(ledger.find("https://x9.example.com/p") === null, false);
    assert.equal(ledger.find("https://x0.example.com/p"), null, "the oldest is gone rather than trusted");
  });
});

// ---------------------------------------------------------------------------
// 16 — replay
// ---------------------------------------------------------------------------

describe("16 — a fact survives being written down and read back", () => {
  test("the runtime event becomes a session event and folds back the same", () => {
    const recorder = new TurnRecorder({ turnId: "t0", now: () => 5 });
    const fact: SourceFact = {
      id: "sf-1",
      subject: "qwen-x",
      predicate: "listed",
      hostname: HASA,
      sourceUrl: `https://${HASA}/models`,
      sourceFingerprint: fingerprint("qwen-x"),
      sourceText: '"id":"qwen-x"',
      origin: "explicit",
      at: 1,
    };
    const event: AgentEvent = { type: "source_fact", fact };
    const recorded = recorder.record(event);

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.type, "source_fact");
    // Round-tripped through JSON, because that is what storage does to it.
    const reloaded = JSON.parse(JSON.stringify(recorded[0])) as SessionEvent;
    assert.deepEqual(reloaded, recorded[0]);
  });

  test("after a reload the fact still points at its evidence and its service", () => {
    const body = "qwen-x";
    const events: SessionEvent[] = [
      { type: "user_message", id: "e1", turnId: "t0", at: 1, text: `https://${HASA}/models 확인해줘` },
      { type: "tool_started", id: "e2", turnId: "t0", at: 2, callId: "c1", toolName: "web_fetch", risk: "read", summary: "읽기" },
      {
        type: "tool_completed",
        id: "e3",
        turnId: "t0",
        at: 3,
        callId: "c1",
        toolName: "web_fetch",
        status: "success",
        detail: "read",
        sources: [
          {
            requestedUrl: `https://${HASA}/models`,
            finalUrl: `https://${HASA}/models`,
            hostname: HASA,
            sourceOrigin: "user_supplied",
            retrieval: "fetched",
            retrievedAt: 3,
            status: 200,
            contentFingerprint: fingerprint(body),
          },
        ],
      },
      {
        type: "source_fact",
        id: "e4",
        turnId: "t0",
        at: 4,
        fact: {
          id: "sf-1",
          subject: "qwen-x",
          predicate: "listed",
          hostname: HASA,
          sourceUrl: `https://${HASA}/models`,
          sourceFingerprint: fingerprint(body),
          origin: "inferred",
          at: 4,
        },
      },
    ];

    const reloaded = JSON.parse(JSON.stringify(events)) as SessionEvent[];
    const task = reduceTask(reloaded);
    assert.ok(task !== null);

    assert.equal(task.facts.length, 1);
    assert.equal(task.facts[0]?.sourceEvidenceId, task.evidence[0]?.id, "joined by content, not by an id nobody had");
    assert.equal(entityLevel(task.evidence, task.facts, HASA, "qwen-x"), "listed");
    assert.deepEqual(
      unsupportedClaims(task.evidence, `qwen-x는 ${HASA} 에서 사용할 수 있습니다.`, task.sources, task.facts),
      [],
    );
  });

  test("a fact whose fetch is not in this chain keeps its service, without an evidence id", () => {
    // What a branch looks like from the inside: the fact was recorded before
    // the fork, the fetch was not.
    const task = reduceTask([
      { type: "user_message", id: "e1", turnId: "t0", at: 1, text: "확인해줘" },
      {
        type: "source_fact",
        id: "e2",
        turnId: "t0",
        at: 2,
        fact: {
          id: "sf-1",
          subject: "qwen-x",
          predicate: "listed",
          hostname: HASA,
          sourceUrl: `https://${HASA}/models`,
          sourceFingerprint: "deadbeef",
          origin: "inferred",
          at: 2,
        },
      },
    ]);
    assert.ok(task !== null);
    assert.equal(task.facts[0]?.sourceEvidenceId, null);
    assert.equal(task.facts[0]?.hostname, HASA);
  });

  test("the same fact recorded twice is one fact", () => {
    const fact = (): SessionEvent => ({
      type: "source_fact",
      id: `e${Math.random()}`,
      turnId: "t0",
      at: 2,
      fact: {
        id: "sf-1",
        subject: "qwen-x",
        predicate: "listed",
        hostname: HASA,
        sourceUrl: `https://${HASA}/models`,
        sourceFingerprint: "abc",
        origin: "inferred",
        at: 2,
      },
    });
    const task = reduceTask([
      { type: "user_message", id: "e1", turnId: "t0", at: 1, text: "확인" },
      fact(),
      fact(),
    ]);
    assert.ok(task !== null);
    assert.equal(task.facts.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 17 — recording the same thing again is not progress
// ---------------------------------------------------------------------------

describe("17 — a fact already recorded is not news", () => {
  const observation = (subject: string): Parameters<typeof observeAction>[1] => ({
    toolName: "record_source_fact",
    args: { url: `https://${HASA}/models`, subject, predicate: "listed" },
    outcome: "executed",
    detail: `기록했습니다: ${HASA} 에 ${subject} (listed).`,
    changedFiles: [],
  });

  test("the first counts, the repeat does not", () => {
    const state = newProgressState();
    assert.equal(observeAction(state, observation("qwen-x")), "weak");
    assert.equal(observeAction(state, observation("qwen-x")), "none");
    assert.equal(observeAction(state, observation("qwen-x")), "none");
  });

  test("a different subject on the same page does count", () => {
    const state = newProgressState();
    assert.equal(observeAction(state, observation("qwen-x")), "weak");
    assert.equal(observeAction(state, observation("llama-y")), "weak");
  });

  test("and the identity is the same one the reducer deduplicates on", () => {
    const base = {
      subject: "qwen-x",
      predicate: "listed" as const,
      hostname: HASA,
      sourceFingerprint: "abc",
    };
    assert.equal(factKey(base), factKey({ ...base, subject: "QWEN-X" }), "case is not a different fact");
    assert.notEqual(factKey(base), factKey({ ...base, sourceFingerprint: "def" }), "a changed page is");
    assert.notEqual(factKey(base), factKey({ ...base, predicate: "mentioned" }));
  });
});

describe("knownSubjects", () => {
  test("is the distinct set, across sources", () => {
    const facts: SourceFact[] = [
      { id: "1", subject: "A", predicate: "listed", hostname: HF, sourceUrl: "", sourceFingerprint: "x", origin: "inferred", at: 1 },
      { id: "2", subject: "A", predicate: "mentioned", hostname: HASA, sourceUrl: "", sourceFingerprint: "y", origin: "inferred", at: 1 },
      { id: "3", subject: "B", predicate: "listed", hostname: HASA, sourceUrl: "", sourceFingerprint: "y", origin: "inferred", at: 1 },
    ];
    assert.deepEqual(knownSubjects(facts), ["A", "B"]);
  });
});
