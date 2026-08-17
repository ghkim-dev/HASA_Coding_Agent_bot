import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  evidenceFromMatrix,
  permissionFor,
  permissionReport,
  permittedModels,
  type PermissionEvidence,
} from "./modelPermission.ts";
import { createModelProposer, rankByPermission } from "./modelProposer.ts";
import type { CapabilityMatrix } from "../protocol/capability.ts";
import type { LlmProvider, ProviderChatResponse } from "../provider/types.ts";

/**
 * The public catalogue is not this key's permission.
 *
 * Every test here runs with no API key and touches no network. That is not
 * incidental — the defect being guarded is precisely that permission was being
 * inferred from an endpoint that answers *without* a credential, so a test that
 * needed one could not tell the two apart either.
 */

const KEY = "sha256:abc123abc123";
const BASE = "https://gateway.example/v1";

/** A gateway that publishes five models. Publishing is not permitting. */
const CATALOGUE = ["public-a", "public-b", "permitted-one", "denied-one", "never-probed"];

const EVIDENCE: PermissionEvidence = {
  keyFingerprint: KEY,
  baseUrl: BASE,
  measuredAt: "2026-08-01T00:00:00.000Z",
  models: [
    { modelId: "permitted-one", chat: "pass" },
    { modelId: "denied-one", chat: "denied" },
    { modelId: "public-a", chat: "fail" },
    { modelId: "public-b", chat: "skipped" },
  ],
};

/** A provider that hands back the catalogue and records every call made. */
function fakeProvider(answer = "[]"): LlmProvider & { asked: string[] } {
  const asked: string[] = [];
  const provider = {
    id: "hasa" as const,
    displayName: "fake",
    baseUrl: BASE,
    asked,
    listModels: async () => ({ models: CATALOGUE.map((id) => ({ id, ownedBy: "x" })), fetchedAt: 0 }),
    chat: async (req: { modelId: string }): Promise<ProviderChatResponse> => {
      asked.push(req.modelId);
      return {
        modelId: req.modelId,
        text: answer,
        reasoning: "",
        toolCalls: [],
        finishReason: "stop" as const,
        usage: null,
      };
    },
    stream: async function* () {
      throw new Error("the proposer must not stream");
    },
    validate: async () => {
      throw new Error("not used");
    },
  };
  return provider as unknown as LlmProvider & { asked: string[] };
}

describe("공개 목록은 이 키의 호출 권한이 아니다", () => {
  test("목록에 있다고 permitted 가 되지 않는다", () => {
    const permitted = permittedModels(EVIDENCE, CATALOGUE);
    assert.deepEqual(permitted, ["permitted-one"]);
    assert.equal(CATALOGUE.length, 5, "카탈로그에는 다섯 개가 있습니다");
  });

  test("403 을 받은 모델은 제외된다", () => {
    assert.equal(permissionFor(EVIDENCE, "denied-one").standing, "denied");
    assert.ok(!permittedModels(EVIDENCE, CATALOGUE).includes("denied-one"));
  });

  test("권한 unknown 은 permitted 로 승격되지 않는다", () => {
    // The whole defect in one assertion. `never-probed` is in the public
    // catalogue and nothing has ever been established about it for this key.
    assert.equal(permissionFor(EVIDENCE, "never-probed").standing, "unknown");
    assert.ok(!permittedModels(EVIDENCE, CATALOGUE).includes("never-probed"));
  });

  test("pass 가 아닌 어떤 상태도 permitted 가 아니다", () => {
    for (const id of ["public-a", "public-b"]) {
      assert.notEqual(permissionFor(EVIDENCE, id).standing, "permitted", id);
    }
  });

  test("근거가 아예 없으면 아무것도 permitted 가 아니다", () => {
    assert.deepEqual(permittedModels(null, CATALOGUE), []);
    assert.equal(permissionFor(null, "permitted-one").standing, "unknown");
  });

  test("모든 판정은 근거 문장을 함께 낸다", () => {
    for (const row of permissionReport(EVIDENCE, CATALOGUE)) {
      assert.ok(row.basis.length > 0, `${row.modelId} 의 근거가 비어 있습니다`);
    }
  });
});

describe("권한 기록은 자격 증명에 묶인다", () => {
  const matrix = {
    schemaVersion: 1,
    probeVersion: "probe-v1",
    probedAt: "2026-08-01T00:00:00.000Z",
    baseUrl: BASE,
    keyFingerprint: KEY,
    models: [
      {
        modelId: "permitted-one",
        capabilities: { chat: { status: "pass" } },
        limits: { observedContextWindow: null, observedMaxOutputTokens: null, latencyMs: null },
        eligibility: { responseCompare: true, codingAgent: false, patchMode: false, judge: false, reasons: [] },
      },
    ],
  } as unknown as CapabilityMatrix;

  test("같은 키·같은 게이트웨이면 근거가 된다", () => {
    const got = evidenceFromMatrix({ matrix, keyFingerprint: KEY, baseUrl: BASE });
    assert.ok(got !== null);
    assert.deepEqual(permittedModels(got, CATALOGUE), ["permitted-one"]);
  });

  test("다른 키의 기록은 권한 근거가 아니다", () => {
    // Not weaker evidence — evidence about somebody else. A key upgrade widens
    // what is callable and a downgrade narrows it; either way this file
    // describes a credential that is not the one about to be used.
    const got = evidenceFromMatrix({ matrix, keyFingerprint: "sha256:different", baseUrl: BASE });
    assert.equal(got, null);
    assert.deepEqual(permittedModels(got, CATALOGUE), []);
  });

  test("다른 게이트웨이의 기록도 마찬가지다", () => {
    const got = evidenceFromMatrix({ matrix, keyFingerprint: KEY, baseUrl: "https://other/v1" });
    assert.equal(got, null);
  });

  test("기록이 없으면 null 이다", () => {
    assert.equal(evidenceFromMatrix({ matrix: null, keyFingerprint: KEY, baseUrl: BASE }), null);
  });
});

describe("proposer 는 권한이 확인된 모델만 사용한다", () => {
  test("허용된 모델만 후보가 된다", async () => {
    const provider = fakeProvider();
    assert.deepEqual(await rankByPermission({ provider, permission: EVIDENCE }), ["permitted-one"]);
  });

  test("권한 근거가 없으면 후보가 없다", async () => {
    const provider = fakeProvider();
    assert.deepEqual(await rankByPermission({ provider, permission: null }), []);
  });

  test("후보가 없으면 만들지 않고 실패한다", async () => {
    const provider = fakeProvider();
    await assert.rejects(() => createModelProposer({ provider, permission: null }));
    assert.deepEqual(provider.asked, [], "권한이 없는데도 호출을 시도했습니다");
  });

  test("권한 없는 모델에는 한 번도 호출하지 않는다", async () => {
    const provider = fakeProvider('[{"text":"x","start":0,"end":4}]');
    const propose = await createModelProposer({ provider, permission: EVIDENCE });
    await propose({ turnId: "t1", text: "코드를 보여줘." });
    assert.deepEqual(provider.asked, ["permitted-one"]);
    for (const id of ["public-a", "public-b", "denied-one", "never-probed"]) {
      assert.ok(!provider.asked.includes(id), `${id} 를 호출했습니다`);
    }
  });
});

// --- the boundary itself -----------------------------------------------------

describe("design 계층은 게이트웨이를 직접 다루지 않는다", () => {
  /**
   * Enforced by reading the source, because the alternative is trusting that
   * nobody re-adds it. `src/provider/architecture.test.ts` already does this for
   * the provider tree and its walk stops there, which is why a hand-rolled
   * `fetch` survived in this directory for as long as it did.
   */
  const FORBIDDEN: Array<[RegExp, string]> = [
    [/\bfetch\s*\(/, "직접 fetch"],
    [/["'`][^"'`]*\/chat\/completions/, "엔드포인트 조립"],
    [/authorization\s*:/i, "Authorization 헤더 생성"],
    [/\bBearer\b/, "Bearer 토큰 조립"],
    [/\bchoices\s*[?.[]/, "OpenAI choices 해석"],
    [/\bmax_tokens\b/, "wire 필드 이름"],
  ];

  test("fetch·엔드포인트·Authorization·choices 가 없다", async () => {
    const dir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const offences: string[] = [];
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".ts"))) {
      // Tests may name what they forbid; production code may not contain it.
      if (file.endsWith(".test.ts")) continue;
      const source = await readFile(join(dir, file), "utf8");
      for (const [pattern, label] of FORBIDDEN) {
        source.split("\n").forEach((line, i) => {
          // A comment explaining why the thing is absent is not the thing.
          const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
          if (pattern.test(code)) offences.push(`${file}:${i + 1} ${label} — ${line.trim()}`);
        });
      }
    }
    assert.deepEqual(offences, [], offences.join("\n"));
  });

  test("자격 증명은 composition root 에서만 읽는다", async () => {
    const dir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const offenders: string[] = [];
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".ts"))) {
      if (file.endsWith(".test.ts") || file === "previewCli.ts") continue;
      const source = await readFile(join(dir, file), "utf8");
      if (/HASA_API_KEY/.test(source.replace(/^\s*\*.*$/gm, ""))) offenders.push(file);
    }
    assert.deepEqual(offenders, [], "previewCli 밖에서 키를 읽습니다");
  });
});
