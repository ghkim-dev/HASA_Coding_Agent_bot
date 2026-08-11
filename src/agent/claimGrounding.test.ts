import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  describeSources,
  describeUnsupportedClaims,
  entityLevel,
  knownServices,
  levelFor,
  serviceApiAnswered,
  sourceMetrics,
  unsupportedClaims,
} from "./claimGrounding.ts";
import { reduceTask } from "./taskReducer.ts";
import { assessCompletion, describeTask, type Evidence } from "./taskState.ts";
import { fingerprint, type WebSourceProvenance } from "./sourceProvenance.ts";
import type { SessionEvent } from "./sessionEvents.ts";

/**
 * The sentence the runtime would not previously have questioned.
 *
 *     evidence: huggingface.co, fetched
 *     answer:   "이 모델은 Open HASA에서 사용할 수 있습니다."
 *
 * Nothing in the record contradicts it. Nothing supports it either, and until
 * this slice there was nowhere that difference could be noticed — `web_source`
 * evidence carried a 200-character status line and no hostname at all.
 *
 * The tests below are the original transcript rebuilt as events, plus each
 * adversarial variant of it: search standing in for a read, a catalog standing
 * in for a call, half a page standing in for the whole of one.
 */

const HASA = "open.hasa.re.kr";
const HF = "huggingface.co";

// ---------------------------------------------------------------------------
// Building a conversation out of events, the way one actually arrives
// ---------------------------------------------------------------------------

let seq = 0;
function id(): { id: string; turnId: string; at: number } {
  seq += 1;
  return { id: `e${seq}`, turnId: "t0", at: 1_700_000_000_000 + seq };
}

function userMessage(text: string): SessionEvent {
  return { type: "user_message", ...id(), text };
}

function plan(...steps: string[]): SessionEvent {
  return { type: "plan", ...id(), steps, current: 0 };
}

function discovered(hostname: string, query: string, url = `https://${hostname}/x`): WebSourceProvenance {
  return {
    requestedUrl: url,
    hostname,
    sourceOrigin: "search_result",
    retrieval: "search_discovery",
    retrievedAt: 1,
    query,
  };
}

function fetched(hostname: string, body: string, opts: { truncated?: boolean; json?: boolean } = {}): WebSourceProvenance {
  const url = `https://${hostname}/models`;
  return {
    requestedUrl: url,
    finalUrl: url,
    hostname,
    sourceOrigin: "user_supplied",
    retrieval: "fetched",
    retrievedAt: 1,
    status: 200,
    ...(opts.json === true ? { contentType: "application/json" } : { contentType: "text/html" }),
    ...(opts.truncated === true ? { truncated: true } : {}),
    contentFingerprint: fingerprint(body),
  };
}

/**
 * One thing the model recorded out of a page it read.
 *
 * Built as the event the tool emits, so the tests exercise the same fold the
 * runtime does. Whether the tool would have *accepted* it is checked separately
 * against a real page in `sourceFacts.test.ts`.
 */
function factEvent(
  hostname: string,
  subject: string,
  predicate: "mentioned" | "listed" | "downloadable",
  body: string,
  sourceText?: string,
): SessionEvent {
  return {
    type: "source_fact",
    ...id(),
    fact: {
      id: `sf-${seq}`,
      subject,
      predicate,
      hostname,
      sourceUrl: `https://${hostname}/models`,
      sourceFingerprint: fingerprint(body),
      ...(sourceText === undefined ? {} : { sourceText }),
      origin: sourceText === undefined ? "inferred" : "explicit",
      at: 1,
    },
  };
}

/** A tool call that ran, with whatever it read from. */
function toolRun(
  toolName: string,
  summary: string,
  opts: { ok?: boolean; detail?: string; sources?: WebSourceProvenance[] } = {},
): SessionEvent[] {
  const callId = `c${seq + 1}`;
  return [
    { type: "tool_started", ...id(), callId, toolName, risk: "read", summary },
    {
      type: "tool_completed",
      ...id(),
      callId,
      toolName,
      status: opts.ok === false ? "failed" : "success",
      detail: opts.detail ?? summary,
      ...(opts.sources === undefined ? {} : { sources: opts.sources }),
    },
  ];
}

function evidenceOf(events: SessionEvent[]): Evidence[] {
  const task = reduceTask(events, "task");
  assert.ok(task !== null);
  return task.evidence;
}

// ---------------------------------------------------------------------------
// 8 / 10 — what each kind of observation is worth
// ---------------------------------------------------------------------------

describe("10 — a level is reached, never inferred", () => {
  test("a search result reaches discovered and stops there", () => {
    const evidence = evidenceOf([
      userMessage("모델 찾아줘"),
      ...toolRun("web_search", "검색", { sources: [discovered(HF, "vit")] }),
    ]);
    assert.equal(levelFor(evidence, HF), "discovered");
  });

  test("a page that was read reaches fetched, and stops there", () => {
    const evidence = evidenceOf([
      userMessage("확인해줘"),
      ...toolRun("web_fetch", "읽기", { sources: [fetched(HASA, "qwen-x")] }),
    ]);
    // The C4.6.1 correction. Reading the page is not knowing what was on it,
    // and while those were the same rung a model seen on one site inherited
    // another site's standing.
    assert.equal(levelFor(evidence, HASA), "fetched");
    assert.equal(entityLevel(evidence, [], HASA, "qwen-x"), "fetched", "no fact, no listing");
  });

  test("a fact recorded out of that page raises that one subject", () => {
    const events = [
      userMessage("확인해줘"),
      ...toolRun("web_fetch", "읽기", { sources: [fetched(HASA, "qwen-x")] }),
      factEvent(HASA, "qwen-x", "listed", "qwen-x"),
    ];
    const task = reduceTask(events);
    assert.ok(task !== null);
    assert.equal(entityLevel(task.evidence, task.facts, HASA, "qwen-x"), "listed");
    // And only that one. The page is not a licence for everything named in the
    // conversation.
    assert.equal(entityLevel(task.evidence, task.facts, HASA, "llama-y"), "fetched");
  });

  test("19 — a JSON catalog answering is beside the ladder, not above it", () => {
    const evidence = evidenceOf([
      userMessage("확인해줘"),
      ...toolRun("web_fetch", "읽기", { sources: [fetched(HASA, '{"models":["Model B"]}', { json: true })] }),
    ]);
    // It answered, and that is a fact about the endpoint.
    assert.equal(serviceApiAnswered(evidence, HASA), true);
    // It is not a fact about any model. `accessible` used to sit above
    // `listed`, so one successful GET outranked having found the thing.
    assert.equal(levelFor(evidence, HASA), "fetched");
    assert.equal(entityLevel(evidence, [], HASA, "Model A"), "fetched");
    assert.notEqual(levelFor(evidence, HASA), "invocation_verified", "the API answering is not a model running");
  });

  test("only an execution reaches invocation_verified", () => {
    const evidence = evidenceOf([
      userMessage("호출해줘"),
      ...toolRun("web_fetch", "읽기", { sources: [fetched(HASA, "qwen-x")] }),
      ...toolRun("run_command", `python call.py`, { detail: `POST https://${HASA}/v1/chat → 200 ok` }),
    ]);
    assert.equal(levelFor(evidence, HASA), "invocation_verified");
  });

  test("reading a page *about* an API is not calling it", () => {
    // The exclusion is by evidence kind, not by hoping the page text avoids
    // mentioning the host. A catalog page naturally names its own service.
    const evidence = evidenceOf([
      userMessage("확인해줘"),
      ...toolRun("web_fetch", "읽기", {
        detail: `${HASA} API로 qwen-x를 호출할 수 있습니다`,
        sources: [fetched(HASA, "qwen-x")],
      }),
    ]);
    assert.equal(levelFor(evidence, HASA), "fetched");
  });

  test("a spoof host contributes nothing to the real one", () => {
    const evidence = evidenceOf([
      userMessage("확인해줘"),
      ...toolRun("web_fetch", "읽기", { sources: [fetched(`${HASA}.evil.example.com`, "qwen-x")] }),
    ]);
    assert.equal(levelFor(evidence, HASA), null);
    assert.equal(levelFor(evidence, `${HASA}.evil.example.com`), "fetched");
  });

  test("services are listed with what each was shown to be", () => {
    const evidence = evidenceOf([
      userMessage("둘 다 봐줘"),
      ...toolRun("web_search", "검색", { sources: [discovered(HF, "vit")] }),
      ...toolRun("web_fetch", "읽기", { sources: [fetched(HASA, "qwen-x")] }),
    ]);
    assert.deepEqual(
      knownServices(evidence).map((s) => [s.hostname, s.level]),
      [
        [HF, "discovered"],
        [HASA, "fetched"],
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// 30 / 35 — Hugging Face evidence is Hugging Face evidence
// ---------------------------------------------------------------------------

describe("30 — a claim about one service cannot rest on another's page", () => {
  /** The transcript: HASA was named, Hugging Face was what got read. */
  const asked = `Hugging Face와 https://${HASA}/models 에서 쓸 모델을 찾아줘`;
  const hfOnly = (): { evidence: Evidence[]; named: Array<{ hostname: string }> } => ({
    evidence: evidenceOf([
      userMessage(asked),
      ...toolRun("web_search", "검색", { sources: [discovered(HF, "hasa image classification")] }),
      ...toolRun("web_fetch", "읽기", { sources: [fetched(HF, "google/vit-base")] }),
    ]),
    named: [{ hostname: HASA }],
  });

  test("the exact failing sentence is refused", () => {
    const { evidence, named } = hfOnly();
    const claims = unsupportedClaims(evidence, "이 모델은 Open HASA에서 사용할 수 있습니다.", named);
    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.kind, "availability");
    assert.equal(claims[0]?.hostname, HASA);
    // Nothing at all was observed about it, which is precisely why the sentence
    // was easy to write: an absence contradicts nothing.
    assert.equal(claims[0]?.have, null);
  });

  test("the same sentence about the service that was read is fine", () => {
    const { evidence, named } = hfOnly();
    assert.deepEqual(unsupportedClaims(evidence, "이 모델은 Hugging Face에서 사용할 수 있습니다.", named), []);
  });

  test("27 — one service's findings are not copied to the other", () => {
    const evidence = evidenceOf([
      userMessage(`Hugging Face와 https://${HASA}/models 에서 각각 활용할 수 있는 모델을 찾아줘`),
      ...toolRun("web_fetch", "HF 읽기", { sources: [fetched(HF, "vit-base, resnet-50")] }),
      ...toolRun("web_fetch", "HASA 읽기", { sources: [fetched(HASA, "qwen-x, llama-y")] }),
    ]);
    // Both were read, so a sentence about either is grounded — and the answer
    // that groups them correctly passes untouched.
    const grouped =
      "Hugging Face에서는 vit-base와 resnet-50을 사용할 수 있습니다.\n" +
      `${HASA} 에서는 qwen-x와 llama-y를 사용할 수 있습니다.`;
    assert.deepEqual(unsupportedClaims(evidence, grouped), []);
  });

  test("and the correction says what was actually established", () => {
    const { evidence, named } = hfOnly();
    const message = describeUnsupportedClaims(
      unsupportedClaims(evidence, "이 모델은 Open HASA에서 사용할 수 있습니다.", named),
    );
    assert.match(message, new RegExp(HASA));
    assert.match(message, /이 서비스에 대해 확인된 것이 없습니다/);
    assert.match(message, /다른 사이트에서 찾은 것은 그 사이트에서 찾은 것/);
  });

  test("a service that was only in the search results is discovered, not read", () => {
    const evidence = evidenceOf([
      userMessage("HASA 모델 찾아줘"),
      ...toolRun("web_search", "검색", { sources: [discovered(HASA, "hasa models")] }),
    ]);
    const claims = unsupportedClaims(evidence, `${HASA} 에서 qwen-x를 사용할 수 있습니다.`);
    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.have, "discovered", "the search knew the page existed and nobody opened it");
  });
});

// ---------------------------------------------------------------------------
// 29 — a snippet is not a page
// ---------------------------------------------------------------------------

describe("29 — a snippet that says something is not that thing being confirmed", () => {
  test("a search result claiming availability does not establish it", () => {
    // The snippet itself says "Model X available on HASA". It is text on
    // somebody's search results page, and the record says exactly that much.
    const evidence = evidenceOf([
      userMessage("HASA 모델 찾아줘"),
      ...toolRun("web_search", "검색", {
        detail: "1. Model X available on HASA…\n   https://huggingface.co/x",
        sources: [discovered(HF, "hasa models")],
      }),
    ]);
    assert.equal(levelFor(evidence, HF), "discovered");
    const claims = unsupportedClaims(evidence, `${HF} 에서 Model X를 사용할 수 있습니다.`);
    assert.equal(claims.length, 1, "even about the host that was in the results");
    assert.equal(claims[0]?.needed, "fetched", "the sentence names no entity, so reading the page is the bar");
  });
});

// ---------------------------------------------------------------------------
// 31 — a catalog is not a call
// ---------------------------------------------------------------------------

describe("31 — being in the list is not having run", () => {
  const catalogOnly = (): Evidence[] =>
    evidenceOf([
      userMessage(`https://${HASA}/models 확인해줘`),
      ...toolRun("web_fetch", "읽기", { sources: [fetched(HASA, "qwen-x")] }),
    ]);

  test("claiming a successful invocation from a catalog page is refused", () => {
    // Named or not. The words `inference`/`추론` can only be about a model
    // service, so when there is exactly one in play the sentence is about it —
    // which is how it was written in the transcript.
    for (const answer of [
      "Model B inference를 성공적으로 실행했습니다.",
      `${HASA} 에서 Model B를 성공적으로 호출했습니다.`,
    ]) {
      const claims = unsupportedClaims(catalogOnly(), answer);
      assert.equal(claims.length, 1, answer);
      assert.equal(claims[0]?.kind, "invocation");
      assert.equal(claims[0]?.have, "fetched");
    }
  });

  test("saying it is in the list is fine", () => {
    assert.deepEqual(
      unsupportedClaims(catalogOnly(), `${HASA} 모델 목록에 qwen-x가 등록되어 있습니다.`),
      [],
    );
  });

  test("with an execution behind it, the same sentence stands", () => {
    const evidence = evidenceOf([
      userMessage(`https://${HASA}/models 확인하고 호출해줘`),
      ...toolRun("web_fetch", "읽기", { sources: [fetched(HASA, "qwen-x")] }),
      ...toolRun("run_command", "python call.py", { detail: `${HASA} 응답 200, 토큰 12개` }),
    ]);
    assert.deepEqual(unsupportedClaims(evidence, `${HASA} 호출에 성공했습니다.`), []);
  });

  test("a failed execution does not count as one", () => {
    const evidence = evidenceOf([
      userMessage(`https://${HASA}/models 호출해줘`),
      ...toolRun("web_fetch", "읽기", { sources: [fetched(HASA, "qwen-x")] }),
      ...toolRun("run_command", "python call.py", { ok: false, detail: `${HASA} 연결 실패` }),
    ]);
    assert.equal(levelFor(evidence, HASA), "fetched");
    assert.equal(unsupportedClaims(evidence, `${HASA} 호출에 성공했습니다.`).length, 1);
  });
});

// ---------------------------------------------------------------------------
// 22 / 33 — negative claims
// ---------------------------------------------------------------------------

describe("33 — half a page cannot say what a whole one does not contain", () => {
  const cut = (): Evidence[] =>
    evidenceOf([
      userMessage(`https://${HASA}/models 에서 Model X 찾아줘`),
      ...toolRun("web_fetch", "읽기", { sources: [fetched(HASA, "qwen-x, llama-y", { truncated: true })] }),
    ]);

  test("a flat denial from a truncated page is refused", () => {
    const claims = unsupportedClaims(cut(), `${HASA} 는 Model X를 지원하지 않습니다.`);
    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.kind, "absence");
  });

  test("the qualified form is what the runtime is asking for", () => {
    assert.deepEqual(
      unsupportedClaims(cut(), `확인한 목록에서는 ${HASA} 에 Model X가 없었습니다.`),
      [],
    );
  });

  test("15 — a whole page is still not enough on its own", () => {
    // Stronger than C4.6, and deliberately. Reading a page and recording
    // nothing out of it leaves the runtime unable to say what was on it, so it
    // cannot back a claim about what was *not*.
    const whole = reduceTask([
      userMessage(`https://${HASA}/models 확인해줘`),
      ...toolRun("web_fetch", "읽기", { sources: [fetched(HASA, "qwen-x, llama-y")] }),
    ]);
    assert.ok(whole !== null);
    assert.equal(
      unsupportedClaims(whole.evidence, `${HASA} 는 Model X를 지원하지 않습니다.`, [], whole.facts).length,
      1,
    );
  });

  test("having enumerated it, the flat denial stands", () => {
    const enumerated = reduceTask([
      userMessage(`https://${HASA}/models 확인해줘`),
      ...toolRun("web_fetch", "읽기", { sources: [fetched(HASA, "qwen-x, llama-y")] }),
      factEvent(HASA, "qwen-x", "listed", "qwen-x, llama-y"),
      factEvent(HASA, "llama-y", "listed", "qwen-x, llama-y"),
    ]);
    assert.ok(enumerated !== null);
    assert.deepEqual(
      unsupportedClaims(enumerated.evidence, `${HASA} 는 Model X를 지원하지 않습니다.`, [], enumerated.facts),
      [],
    );
  });

  test("and the correction names the range rather than only refusing", () => {
    const message = describeUnsupportedClaims(unsupportedClaims(cut(), `${HASA} 는 Model X를 지원하지 않습니다.`));
    assert.match(message, /확인한 범위에서는/);
  });
});

// ---------------------------------------------------------------------------
// 16 / 28 — a named page is not met by a search
// ---------------------------------------------------------------------------

describe("16 — an exact source requirement is settled by reading it, and only that", () => {
  const asked = `Hugging Face와 https://${HASA}/models 에서 활용할 수 있는 모델도 찾아서 사용해줘.`;

  test("28 — a generic search leaves the named page unread", () => {
    const task = reduceTask([
      userMessage(asked),
      plan("HASA와 Hugging Face에서 모델 검색", "결과 정리"),
      ...toolRun("web_search", "검색", { sources: [discovered(HF, "hasa models")] }),
    ]);
    assert.ok(task !== null);

    // Only the URL is a source. "Hugging Face" written as words is a topic the
    // model has to interpret, and the runtime does not guess at it — see
    // `exactSourcesIn`.
    assert.deepEqual(
      task.sources.map((s) => [s.hostname, s.status]),
      [[HASA, "pending"]],
    );
    // The bug in one assertion. `찾기` matches the web keyword group, the search
    // succeeded, and before this slice that marked the requirement passed.
    assert.equal(task.requirements[0]?.status, "pending", "a search is not the page they named");
    assert.equal(assessCompletion(task).complete, false);
    assert.equal(assessCompletion(task).unreadSources.length, 1);
  });

  test("fetching the page settles it", () => {
    const task = reduceTask([
      userMessage(asked),
      plan("HASA와 Hugging Face에서 모델 검색"),
      ...toolRun("web_search", "검색", { sources: [discovered(HF, "hasa models")] }),
      ...toolRun("web_fetch", "HASA 읽기", { sources: [fetched(HASA, "qwen-x")] }),
      ...toolRun("web_fetch", "HF 읽기", { sources: [fetched(HF, "vit-base")] }),
    ]);
    assert.ok(task !== null);
    assert.deepEqual(task.sources.map((s) => s.status), ["fetched"]);
    assert.equal(assessCompletion(task).unreadSources.length, 0);
    assert.equal(task.requirements[0]?.status, "passed");
  });

  test("29 — a search that returns the named page does not read it", () => {
    // The sharper version of §28: the search results include the very URL the
    // user gave. A search engine listing a page still is not the page, and the
    // requirement stays open until somebody opens it.
    const task = reduceTask([
      userMessage(`https://${HASA}/models 에 있는 모델을 확인해줘`),
      plan("모델 목록 검색"),
      ...toolRun("web_search", "검색", {
        detail: `1. HASA Models\n   https://${HASA}/models\n   qwen-x, llama-y available…`,
        sources: [discovered(HASA, "hasa models", `https://${HASA}/models`)],
      }),
    ]);
    assert.ok(task !== null);
    assert.equal(task.sources[0]?.status, "pending", "listed by a search is not read");
    assert.equal(assessCompletion(task).unreadSources.length, 1);
    assert.equal(task.requirements[0]?.status, "pending");
    // And a claim built on it is limited to what a search result is worth.
    const claims = unsupportedClaims(task.evidence, `${HASA} 에서 qwen-x를 사용할 수 있습니다.`, task.sources);
    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.have, "discovered");
  });

  test("fetching a lookalike host does not", () => {
    const task = reduceTask([
      userMessage(`https://${HASA}/models 확인해줘`),
      plan("모델 목록 확인"),
      ...toolRun("web_fetch", "읽기", { sources: [fetched(`${HASA}.evil.example.com`, "qwen-x")] }),
    ]);
    assert.ok(task !== null);
    assert.equal(task.sources[0]?.status, "pending");
    assert.equal(assessCompletion(task).complete, false);
  });

  test("32 — a fetch that failed is attempted, not read", () => {
    const task = reduceTask([
      userMessage(`https://${HASA}/models 확인해줘`),
      plan("모델 목록 확인"),
      ...toolRun("web_fetch", "읽기", {
        ok: false,
        detail: `${HASA} answered 503. The page may be gone.`,
      }),
      ...toolRun("web_search", "대신 검색", { sources: [discovered(HF, "hasa models")] }),
    ]);
    assert.ok(task !== null);
    assert.equal(task.sources[0]?.status, "attempted");
    assert.equal(assessCompletion(task).complete, false);
    // And what the model is told before it answers is the difference between
    // "could not fetch it" and "did not try".
    assert.match(describeTask(task), /가져오지 못했습니다/);
    assert.ok(!describeTask(task).includes("아직 읽지 않았습니다"));
  });

  test("a URL the user pasted for another purpose is not a research gate", () => {
    // A repository URL in "여기에 commit 해줘" names no page anyone asked to
    // read, and holding the task open for it would be the runtime inventing a
    // requirement. Nothing went to the web, so nothing is outstanding.
    const task = reduceTask([
      userMessage("https://github.com/ghkim-dev/HASA_Coding_Agent_bot 에 commit 해줘"),
      plan("커밋"),
      ...toolRun("run_command", "git commit", { detail: "1 file changed" }),
    ]);
    assert.ok(task !== null);
    assert.equal(task.sources.length, 1, "recorded either way");
    assert.equal(assessCompletion(task).unreadSources.length, 0, "but not held against a turn that never searched");
  });
});

// ---------------------------------------------------------------------------
// 26 — the original transcript, rebuilt
// ---------------------------------------------------------------------------

describe("26 — the dog/cat provenance failure, end to end", () => {
  /**
   * "좋은 오픈소스 모델이나 open.hasa.re.kr/models에서 활용할 수 있는 것도
   *  사용해서 결과를 정리해줘."
   *
   * Model A exists on Hugging Face. Model B is in the HASA catalog and Model A
   * is not. Neither was ever called.
   */
  const transcript = (): SessionEvent[] => [
    userMessage(
      `좋은 오픈소스 모델이나 https://${HASA}/models 에서 활용할 수 있는 것도 사용해서 결과를 정리해줘.`,
    ),
    plan("모델 후보 조사", "결과 정리"),
    ...toolRun("web_fetch", "HF 읽기", { sources: [fetched(HF, "Model A")] }),
    ...toolRun("web_fetch", "HASA 읽기", { sources: [fetched(HASA, "Model B")] }),
  ];

  test("as it actually happened — HASA never opened — the claim is refused", () => {
    // The transcript in its real form: one search, Hugging Face results, and a
    // report about the other service. Nothing was ever read from HASA.
    const searched = evidenceOf([
      userMessage(`좋은 오픈소스 모델이나 https://${HASA}/models 에서 활용할 수 있는 것도 사용해줘.`),
      ...toolRun("web_search", "검색", { sources: [discovered(HF, "hasa 이미지 분류 모델")] }),
    ]);
    const named = [{ hostname: HASA }];

    assert.deepEqual(unsupportedClaims(searched, "Model A는 Hugging Face에서 확인했습니다.", named), []);
    const wrong = unsupportedClaims(searched, `Model A는 ${HASA} 에서 사용할 수 있습니다.`, named);
    assert.equal(wrong.length, 1, "a finding from one site, presented as the other's");
    assert.equal(wrong[0]?.have, null);
  });

  test("9 — with both pages read, the cross-attribution is still caught", () => {
    // The gap C4.6 left open and C4.6.1 closes. Both hosts are `fetched`, so
    // every service-level check passes; what separates them is which page each
    // model was actually recorded out of.
    const task = reduceTask([
      ...transcript(),
      factEvent(HF, "Model A", "listed", "Model A"),
      factEvent(HASA, "Model B", "listed", "Model B"),
    ]);
    assert.ok(task !== null);
    const claim = (text: string): number =>
      unsupportedClaims(task.evidence, text, task.sources, task.facts).length;

    assert.equal(claim(`Model A는 ${HASA} 에서 사용할 수 있습니다.`), 1, "A came from the other site");
    assert.equal(claim("Model A는 Hugging Face에서 확인했습니다."), 0);
    assert.equal(claim(`Model B는 ${HASA} 카탈로그에서 확인했습니다.`), 0);
    assert.equal(claim(`Model B를 ${HASA} 에서 사용할 수 있습니다.`), 0);
    // And it names what is wrong rather than only refusing.
    const message = describeUnsupportedClaims(
      unsupportedClaims(task.evidence, `Model A는 ${HASA} 에서 사용할 수 있습니다.`, task.sources, task.facts),
    );
    assert.match(message, /Model A/);
    assert.match(message, /record_source_fact/);
  });

  test("18 — a sentence claiming both at once is judged per entity", () => {
    const task = reduceTask([
      ...transcript(),
      factEvent(HF, "Model A", "listed", "Model A"),
      factEvent(HASA, "Model B", "listed", "Model B"),
    ]);
    assert.ok(task !== null);
    const claims = unsupportedClaims(
      task.evidence,
      `Model A, Model B 모두 ${HASA} 에서 제공됩니다.`,
      task.sources,
      task.facts,
    );
    assert.equal(claims.length, 1, "one of the two is wrong, and only that one");
    assert.equal(claims[0]?.subject, "Model A");
  });

  test("the brief names what each source carried", () => {
    const task = reduceTask([
      ...transcript(),
      factEvent(HF, "Model A", "listed", "Model A"),
      factEvent(HASA, "Model B", "listed", "Model B"),
    ]);
    assert.ok(task !== null);
    const brief = describeTask(task);
    assert.match(brief, new RegExp(`${HF}:[^\n]*\n  이 출처에서 확인된 항목: Model A`));
    assert.match(brief, /이 출처에서 확인된 항목: Model B/);
  });

  test("Model B is in the catalog, and that is not a run", () => {
    const evidence = evidenceOf(transcript());
    assert.deepEqual(unsupportedClaims(evidence, `Model B는 ${HASA} 모델 목록에 있습니다.`), []);
    assert.equal(
      unsupportedClaims(evidence, `Model B를 ${HASA} 에서 정상적으로 실행했습니다.`).length,
      1,
    );
  });

  test("the brief the model gets before answering says which was which", () => {
    const task = reduceTask(transcript());
    assert.ok(task !== null);
    const brief = describeTask(task);

    assert.match(brief, new RegExp(`${HF}: .*직접 읽음`));
    assert.match(brief, new RegExp(`${HASA.replace(/\./g, "\\.")}: .*직접 읽음`));
    assert.match(brief, /한 사이트에서 확인한 것을 다른 사이트에서 확인했다고 쓰지 마십시오/);
  });

  test("with only a search, the brief says the named page is still unread", () => {
    const task = reduceTask([
      userMessage(`https://${HASA}/models 에서 활용할 수 있는 모델을 찾아줘`),
      plan("모델 찾기"),
      ...toolRun("web_search", "검색", { sources: [discovered(HF, "hasa models")] }),
    ]);
    assert.ok(task !== null);
    const brief = describeTask(task);
    assert.match(brief, /검색 결과는 이 페이지를 대신하지 못합니다/);
    assert.match(brief, /web_fetch로 직접 읽으십시오/);
    assert.ok(!brief.includes("요구사항이 모두 확인되었습니다"));
  });
});

// ---------------------------------------------------------------------------
// 44 — counting what happened
// ---------------------------------------------------------------------------

describe("44 — the numbers come out of the record, not out of a counter", () => {
  test("a turn's web work, counted", () => {
    const task = reduceTask([
      userMessage(`https://${HASA}/models 와 https://${HF}/models 확인해줘`),
      plan("모델 검색"),
      ...toolRun("web_search", "검색", {
        sources: [discovered(HF, "models"), discovered("example.com", "models")],
      }),
      ...toolRun("web_fetch", "HASA 읽기", { sources: [fetched(HASA, "qwen-x")] }),
      ...toolRun("web_fetch", "HASA 다시 읽기", { sources: [fetched(HASA, "qwen-x")] }),
      ...toolRun("web_fetch", "HF 읽기", { sources: [fetched(HF, "vit", { truncated: true })] }),
      factEvent(HASA, "qwen-x", "listed", "qwen-x"),
    ]);
    assert.ok(task !== null);

    assert.deepEqual(sourceMetrics(task.evidence, task.sources, task.facts), {
      userSuppliedUrls: 2,
      successfulExactFetches: 2,
      unreadUserSources: 0,
      genericSearches: 1,
      searchResults: 2,
      fetchedSources: 3,
      duplicateFetches: 1,
      truncatedFetches: 1,
      // One, not two. Both sites were read; only one had anything recorded out
      // of it, and that is what `listed` now means.
      listedServices: 1,
      invocationVerifiedServices: 0,
      recordedFacts: 1,
      distinctSubjects: 1,
    });
  });

  test("and a task that never went to the web counts nothing", () => {
    const task = reduceTask([userMessage("테스트 실행해줘"), plan("테스트"), ...toolRun("run_command", "pnpm test")]);
    assert.ok(task !== null);
    const metrics = sourceMetrics(task.evidence, task.sources, task.facts);
    assert.equal(metrics.fetchedSources, 0);
    assert.equal(metrics.searchResults, 0);
    assert.equal(metrics.listedServices, 0);
  });
});

// ---------------------------------------------------------------------------
// The check has to stay quiet when there is nothing to say
// ---------------------------------------------------------------------------

describe("a narrow check, which is the only kind worth having", () => {
  test("no web evidence, no opinion", () => {
    const evidence = evidenceOf([
      userMessage("테스트 실행해줘"),
      ...toolRun("run_command", "pnpm test", { detail: "2175 passed" }),
    ]);
    assert.deepEqual(unsupportedClaims(evidence, "HASA에서 전부 사용할 수 있습니다."), []);
    assert.equal(describeSources(evidence), null);
  });

  test("prose about the work is not a claim about a service", () => {
    const evidence = evidenceOf([
      userMessage(`https://${HASA}/models 확인해줘`),
      ...toolRun("web_fetch", "읽기", { sources: [fetched(HASA, "qwen-x")] }),
    ]);
    for (const answer of [
      `${HASA} 목록을 읽어 qwen-x를 찾았습니다.`,
      "테스트를 실행했고 모두 통과했습니다.",
      `${HASA} 페이지에는 모델이 세 개 있습니다.`,
    ]) {
      assert.deepEqual(unsupportedClaims(evidence, answer), [], answer);
    }
  });

  test("a service nobody looked at is not judged", () => {
    const evidence = evidenceOf([
      userMessage("HF 확인해줘"),
      ...toolRun("web_fetch", "읽기", { sources: [fetched(HF, "vit")] }),
    ]);
    // `replicate.com` appears in no evidence, so there is no level to compare
    // against and no basis for an accusation.
    assert.deepEqual(unsupportedClaims(evidence, "replicate.com 에서도 사용할 수 있습니다."), []);
  });

  test("a name that merely contains a service name is not a mention of it", () => {
    const evidence = evidenceOf([
      userMessage(`https://${HASA}/models 확인해줘`),
      ...toolRun("web_search", "검색", { sources: [discovered(HASA, "models")] }),
    ]);
    assert.deepEqual(
      unsupportedClaims(evidence, "hasagi-net 은 사용할 수 있습니다."),
      [],
      "a word boundary, not a substring",
    );
  });
});
