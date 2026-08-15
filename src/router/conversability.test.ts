import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { emptyContract, mergeContract, parseTurnContract } from "../agent/turnContract.ts";
import { unknownCapabilities, type ProviderModel } from "../provider/types.ts";
import { canConverse, type Modality } from "../provider/hasa/hasaCatalog.ts";
import { projectTaskProfile, type TaskProfile } from "./taskProfile.ts";
import { buildRegistry } from "./modelRegistry.ts";
import { filterEligible } from "./eligibility.ts";
import {
  classifyStatus,
  conversabilityFor,
  fourOhFourIsAboutTheModel,
  isVerifiedNonConversational,
  mayBeWorker,
  preferEvidence,
  probedConversability,
  stateOf,
} from "./conversability.ts";

/**
 * Being unmeasured is not being able to talk.
 *
 * `protocolFor` answers `text` for a model nobody probed, and that is the right
 * answer for a chat model waiting to be measured. It is the wrong answer for a
 * video endpoint, and in a live routing run it produced a candidate list of
 * twenty-eight containing four quantum simulators, a text-to-speech model, an
 * OCR model and a speech recogniser — every one of which answers 404 on
 * `/v1/chat/completions`.
 *
 *     unknown  ≠  text-capable
 *
 * The fix is not a list of names. Evidence is supplied by whoever has it — the
 * portal catalogue publishes a modality, an invocation probe settles it — and
 * absence of evidence still leaves a model a candidate.
 */

function providerModel(id: string): ProviderModel {
  return {
    id,
    ownedBy: null,
    // Deliberately unmeasured: this is the state the defect lived in.
    capabilities: unknownCapabilities(),
    limits: { maxOutputTokens: null, contextWindow: null },
  };
}

function task(): TaskProfile {
  const parsed = parseTurnContract(
    { goal: "g", relation: "new_task", intents: "modify", requirements: "r" },
    "t1",
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return projectTaskProfile(mergeContract(emptyContract(), parsed.contract));
}

describe("conversability · unknown is not promoted to text-capable", () => {
  test("C — an unmeasured model is still a candidate when nothing says otherwise", () => {
    const registry = buildRegistry([providerModel("nobody-measured-this")]);
    const { eligible } = filterEligible(registry, task());
    assert.equal(eligible.length, 1, "absence of evidence is not evidence of absence");
  });

  test("C — but its protocol is not silently asserted as usable", () => {
    // The model is a candidate; what must not happen is evidence being
    // manufactured for it. Nothing here claims it was measured.
    const registry = buildRegistry([providerModel("nobody-measured-this")]);
    assert.equal(registry[0]!.capabilities.coding, undefined);
    assert.equal(registry[0]!.evidence.evalSampleCount, 0);
  });

  test("B — an invocation that says it does not chat excludes it", () => {
    const converses = new Map([["answers-404-on-chat", false]]);
    const registry = buildRegistry([providerModel("answers-404-on-chat")], [], { converses });
    const { eligible, filteredOut } = filterEligible(registry, task());
    assert.equal(eligible.length, 0);
    assert.equal(filteredOut[0]?.code, "CANNOT_CONVERSE");
  });

  test("A — a non-chat modality from the catalogue is such evidence", () => {
    // The mapping the caller applies, checked here so the rule is pinned even
    // though the lookup itself lives in the catalogue module.
    const nonChat: Modality[] = ["image", "video", "audio", "embeddings", "rerank"];
    for (const modality of nonChat) {
      assert.equal(canConverse(modality), false, modality);
    }
    assert.equal(canConverse("chat"), true);
    // `safety` is a chat endpoint that is not a worker — that is the role
    // layer's job, not this one's, and the two must not be conflated.
    assert.equal(canConverse("safety"), true);
  });

  test("A — and it reaches the filter", () => {
    const converses = new Map(
      ["an-image-model", "a-video-model", "a-tts-model"].map((id) => [id, false] as const),
    );
    const registry = buildRegistry(
      ["an-image-model", "a-video-model", "a-tts-model", "a-chat-model"].map(providerModel),
      [],
      { converses },
    );
    const { eligible, filteredOut } = filterEligible(registry, task());
    assert.deepEqual(eligible.map((p) => p.modelId), ["a-chat-model"]);
    assert.equal(filteredOut.length, 3);
    assert.ok(filteredOut.every((f) => f.code === "CANNOT_CONVERSE"));
  });

  test("D — an explicitly chat-capable entry stays a candidate", () => {
    const converses = new Map([["a-chat-model", true]]);
    const registry = buildRegistry([providerModel("a-chat-model")], [], { converses });
    assert.equal(filterEligible(registry, task()).eligible.length, 1);
  });

  test("E — nothing is inferred from the id", () => {
    // Names that look like non-chat endpoints, with no evidence supplied.
    const looksLikeNonChat = [
      "whisper-large-v3-turbo",
      "some-embedding-model",
      "text-to-speech-ko",
      "cuquantum-statevector",
    ].map(providerModel);
    const registry = buildRegistry(looksLikeNonChat);
    const { eligible, filteredOut } = filterEligible(registry, task());
    assert.equal(filteredOut.length, 0, "an id is not evidence, in either direction");
    assert.equal(eligible.length, 4);
  });

  test("F — refreshed evidence changes the answer without a code change", () => {
    const models = [providerModel("changed-its-modality")];
    assert.equal(filterEligible(buildRegistry(models), task()).eligible.length, 1);
    // The catalogue is re-read after its TTL and now reports a non-chat
    // modality. Same registry code, different answer.
    const after = buildRegistry(models, [], {
      converses: new Map([["changed-its-modality", false]]),
    });
    assert.equal(filterEligible(after, task()).eligible.length, 0);
  });

  test("G — a live-shaped catalogue does not put non-chat models in the pool", () => {
    // Shaped like the gateway's, with the modalities the portal publishes.
    const catalogue: Array<[string, Modality]> = [
      ["chat-a", "chat"],
      ["chat-b", "chat"],
      ["an-image", "image"],
      ["a-video", "video"],
      ["a-voice", "audio"],
      ["an-embedding", "embeddings"],
      ["a-reranker", "rerank"],
    ];
    const converses = new Map(
      catalogue.filter(([, m]) => !canConverse(m)).map(([id]) => [id, false] as const),
    );
    const registry = buildRegistry(
      catalogue.map(([id]) => providerModel(id)),
      [],
      { converses },
    );
    const { eligible } = filterEligible(registry, task());
    assert.deepEqual(eligible.map((p) => p.modelId).sort(), ["chat-a", "chat-b"]);
  });

  test("evidence for one model does not leak to another", () => {
    const converses = new Map([["excluded", false]]);
    const registry = buildRegistry([providerModel("excluded"), providerModel("untouched")], [], {
      converses,
    });
    const { eligible } = filterEligible(registry, task());
    assert.deepEqual(eligible.map((p) => p.modelId), ["untouched"]);
  });
});

// ---------------------------------------------------------------------------
// The five-state model
// ---------------------------------------------------------------------------

describe("conversability · a two-value answer to a five-value question", () => {
  const CONTEXT = {
    baseUrlFingerprint: "fp-13m45m71wq56bd",
    credentialFingerprint: "fp-hlsenstbj6to",
  };

  test("only a verified conversation makes a model a worker", () => {
    assert.equal(mayBeWorker("CONVERSATIONAL_VERIFIED"), true);
    for (const state of ["NON_CONVERSATIONAL_VERIFIED", "INCONCLUSIVE", "UNKNOWN", "STALE"] as const) {
      assert.equal(mayBeWorker(state), false, state);
    }
  });

  test("only a verified refusal excludes one", () => {
    assert.equal(isVerifiedNonConversational("NON_CONVERSATIONAL_VERIFIED"), true);
    for (const state of ["INCONCLUSIVE", "UNKNOWN", "STALE", "CONVERSATIONAL_VERIFIED"] as const) {
      assert.equal(isVerifiedNonConversational(state), false, state);
    }
  });

  const STATUSES: ReadonlyArray<[number, string]> = [
    [200, "CONVERSATIONAL_VERIFIED"],
    [404, "NON_CONVERSATIONAL_VERIFIED"],
    [405, "NON_CONVERSATIONAL_VERIFIED"],
    // Facts about the credential, the payload, the moment or the gateway —
    // none of them about the model.
    [401, "INCONCLUSIVE"],
    [403, "INCONCLUSIVE"],
    [400, "INCONCLUSIVE"],
    [422, "INCONCLUSIVE"],
    [408, "INCONCLUSIVE"],
    [429, "INCONCLUSIVE"],
    [500, "INCONCLUSIVE"],
    [503, "INCONCLUSIVE"],
  ];

  for (const [status, expected] of STATUSES) {
    test(`${status} is ${expected}`, () => {
      assert.equal(classifyStatus(status).state, expected);
    });
  }

  test("a 403 never takes a model off the list", () => {
    // The failure being guarded: one permission error permanently excluding a
    // model that works perfectly well for a different key.
    assert.equal(isVerifiedNonConversational(classifyStatus(403).state), false);
  });

  test("a timeout never takes a model off the list", () => {
    assert.equal(isVerifiedNonConversational(classifyStatus(408).state), false);
    assert.equal(isVerifiedNonConversational(classifyStatus(504).state), false);
  });

  test("a 404 counts only when another model answered on the same path", () => {
    // A doubled `/v1` produced exactly this 404 once, for a model that has an
    // embeddings endpoint and works.
    assert.equal(fourOhFourIsAboutTheModel(true), true);
    assert.equal(fourOhFourIsAboutTheModel(false), false);
  });

  test("a record expires", () => {
    const record = probedConversability()[0]!;
    const withTtl = { ...record, expiresAt: new Date(1000).toISOString() };
    assert.equal(stateOf(withTtl, 500, CONTEXT), "NON_CONVERSATIONAL_VERIFIED");
    assert.equal(stateOf(withTtl, 2000, CONTEXT), "STALE");
  });

  test("a record taken with another credential is stale, not applied", () => {
    const record = probedConversability()[0]!;
    assert.equal(
      stateOf(record, Date.now(), { ...CONTEXT, credentialFingerprint: "fp-someone-else" }),
      "STALE",
    );
    assert.equal(
      conversabilityFor({ ...CONTEXT, credentialFingerprint: "fp-someone-else" }).size,
      0,
      "a key that may have different access must not inherit these answers",
    );
  });

  test("a record taken against another endpoint is stale too", () => {
    assert.equal(
      conversabilityFor({ ...CONTEXT, baseUrlFingerprint: "fp-another-gateway" }).size,
      0,
    );
  });

  test("the probed records exclude exactly what was measured", () => {
    const map = conversabilityFor(CONTEXT);
    for (const record of probedConversability()) {
      assert.equal(map.get(record.modelId), false, record.modelId);
      assert.equal(record.evidence, "invocation");
      assert.equal(record.status, 404);
    }
  });

  test("no record carries key material", () => {
    for (const record of probedConversability()) {
      const text = JSON.stringify(record);
      assert.ok(!text.includes("sk-"), "no key");
      assert.ok(!text.toLowerCase().includes("bearer"), "no header");
      assert.match(record.credentialFingerprint, /^fp-/);
      assert.match(record.baseUrlFingerprint, /^fp-/);
    }
  });

  test("stronger evidence wins, and ties go to the newer measurement", () => {
    const base = probedConversability()[0]!;
    const weak = { ...base, evidence: "provider_documentation" as const };
    const strong = { ...base, evidence: "invocation" as const };
    assert.equal(preferEvidence(weak, strong), strong);
    assert.equal(preferEvidence(strong, weak), strong);

    const older = { ...base, measuredAt: "2026-01-01T00:00:00.000Z" };
    const newer = { ...base, measuredAt: "2026-08-16T00:00:00.000Z" };
    assert.equal(preferEvidence(older, newer), newer);
  });

  test("the six that the catalogue could not classify are now excluded", () => {
    const converses = conversabilityFor(CONTEXT);
    const registry = buildRegistry(
      [...converses.keys(), "a-real-chat-model"].map(providerModel),
      [],
      { converses },
    );
    const { eligible, filteredOut } = filterEligible(registry, task());
    assert.deepEqual(eligible.map((p) => p.modelId), ["a-real-chat-model"]);
    assert.equal(filteredOut.length, 6);
    assert.ok(filteredOut.every((f) => f.code === "CANNOT_CONVERSE"));
  });
});
