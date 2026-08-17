import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  permissionFor,
  permittedModels,
  type PermissionEvidence,
  type PermissionEvidenceStore,
} from "./modelPermission.ts";
import { createModelProposer, rankByPermission } from "./modelProposer.ts";
import { createFilePermissionStore } from "../cli/permissionEvidenceFile.ts";
import type { LlmProvider, ProviderChatResponse } from "../provider/types.ts";

/**
 * A 403 that survives the process, and is never used to explore anything.
 *
 * Every call in this file goes to a mock provider. Nothing here reaches HASA, no
 * key exists, and the one model that "answers" 403 does so because a test object
 * was told to throw — which is the only acceptable way to test this, since the
 * behaviour under test is *not making a call*.
 *
 * The gap being closed: the proposer stopped calling a refused model for the rest
 * of its run, and the refusal lived in a closure. The process exited, the next one
 * read a record that still said `permitted`, and called the model again. Spread
 * across restarts that is a stream of 403s against a real credential, which is
 * indistinguishable from probing an access boundary — and is how keys get blocked.
 */

const KEY = "sha256:abc123abc123";
const OTHER_KEY = "sha256:different0000";
const BASE = "https://gateway.example/v1";
const OTHER_BASE = "https://other.example/v1";
const NOW = Date.parse("2026-08-01T01:00:00.000Z");
const CATALOGUE = ["permitted-one", "permitted-two", "never-probed"];

/** Both models measured callable. The record a probe would have left. */
const MATRIX_EVIDENCE: PermissionEvidence = {
  keyFingerprint: KEY,
  baseUrl: BASE,
  measuredAt: "2026-08-01T00:00:00.000Z",
  models: [
    { modelId: "permitted-one", chat: "pass" },
    { modelId: "permitted-two", chat: "pass" },
  ],
};

/** A provider whose every `chat` is a 403. It records what it was asked. */
function forbiddenProvider(): LlmProvider & { asked: string[] } {
  const asked: string[] = [];
  const provider = {
    id: "hasa" as const,
    displayName: "mock",
    baseUrl: BASE,
    asked,
    listModels: async () => ({ models: CATALOGUE.map((id) => ({ id, ownedBy: "x" })), fetchedAt: 0 }),
    chat: async (req: { modelId: string }): Promise<ProviderChatResponse> => {
      asked.push(req.modelId);
      throw Object.assign(new Error("forbidden"), { code: "forbidden", httpStatus: 403 });
    },
    stream: async function* () {
      throw new Error("no");
    },
    validate: async () => {
      throw new Error("no");
    },
  };
  return provider as unknown as LlmProvider & { asked: string[] };
}

async function withStore(
  run: (input: { dir: string; store: PermissionEvidenceStore }) => Promise<void>,
  base: PermissionEvidence | null = MATRIX_EVIDENCE,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "permission-"));
  try {
    await run({ dir, store: createFilePermissionStore({ dir, base }) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("403 은 프로세스를 넘어 기억된다", () => {
  test("같은 요청에서 재시도하지 않고, 다른 모델로 우회하지도 않는다", async () => {
    await withStore(async ({ store }) => {
      const provider = forbiddenProvider();
      const propose = await createModelProposer({
        provider,
        permission: await store.load({ keyFingerprint: KEY, baseUrl: BASE }),
        now: () => NOW,
        store,
      });

      await assert.rejects(() => propose({ turnId: "t1", text: "코드를 보여줘." }));
      // One call. Not a retry, and not `permitted-two` — a 403 on one model says
      // nothing about another, and walking the list to find one that answers is
      // the probing this must never do.
      assert.deepEqual(provider.asked, ["permitted-one"]);

      await assert.rejects(() => propose({ turnId: "t2", text: "다시 보여줘." }));
      assert.deepEqual(provider.asked, ["permitted-one"]);
    });
  });

  test("재시작한 프로세스는 그 모델을 다시 호출하지 않는다", async () => {
    await withStore(async ({ dir, store }) => {
      const first = forbiddenProvider();
      const propose = await createModelProposer({
        provider: first,
        permission: await store.load({ keyFingerprint: KEY, baseUrl: BASE }),
        now: () => NOW,
        store,
      });
      await assert.rejects(() => propose({ turnId: "t1", text: "코드를 보여줘." }));
      assert.deepEqual(first.asked, ["permitted-one"]);

      // A new process: a new store object over the same directory, a new provider,
      // and the same probe matrix that still says `permitted-one` is callable.
      const restarted = createFilePermissionStore({ dir, base: MATRIX_EVIDENCE });
      const evidence = await restarted.load({ keyFingerprint: KEY, baseUrl: BASE });
      assert.equal(
        permissionFor(evidence, "permitted-one", NOW).standing,
        "server_forbidden",
        "재시작 후 기록이 사라졌습니다",
      );
      assert.deepEqual(permittedModels(evidence, CATALOGUE, NOW), ["permitted-two"]);

      const second = forbiddenProvider();
      const again = await createModelProposer({
        provider: second,
        permission: evidence,
        now: () => NOW,
        store: restarted,
      });
      await assert.rejects(() => again({ turnId: "t1", text: "코드를 보여줘." }));
      assert.ok(!second.asked.includes("permitted-one"), `${second.asked.join(", ")} 를 호출했습니다`);
    });
  });

  test("기록은 만료로 풀리지 않는다", async () => {
    await withStore(async ({ dir, store }) => {
      await store.recordForbidden({ keyFingerprint: KEY, baseUrl: BASE, modelId: "permitted-one", at: NOW });
      const later = NOW + 400 * 24 * 60 * 60 * 1000;
      const evidence = await createFilePermissionStore({ dir, base: MATRIX_EVIDENCE }).load({
        keyFingerprint: KEY,
        baseUrl: BASE,
      });
      assert.equal(permissionFor(evidence, "permitted-one", later).standing, "server_forbidden");
      assert.ok(!permittedModels(evidence, CATALOGUE, later).includes("permitted-one"));
    });
  });

  test("사용자가 명시적으로 지우면 기록이 사라진다", async () => {
    await withStore(async ({ dir, store }) => {
      await store.recordForbidden({ keyFingerprint: KEY, baseUrl: BASE, modelId: "permitted-one", at: NOW });
      await store.invalidate({ keyFingerprint: KEY, baseUrl: BASE });
      const evidence = await createFilePermissionStore({ dir, base: MATRIX_EVIDENCE }).load({
        keyFingerprint: KEY,
        baseUrl: BASE,
      });
      // Back to what the probe measured — because a person asked for that, not
      // because a timer decided the refusal had gone stale.
      assert.equal(permissionFor(evidence, "permitted-one", NOW).standing, "permitted");
    });
  });

  test("다음 Probe 가 기록을 덮어쓰지 않는다", async () => {
    await withStore(async ({ dir }) => {
      const store = createFilePermissionStore({ dir, base: MATRIX_EVIDENCE });
      await store.recordForbidden({ keyFingerprint: KEY, baseUrl: BASE, modelId: "permitted-one", at: NOW });
      // A fresh probe run, measured later, still saying both models are callable.
      const reprobed: PermissionEvidence = { ...MATRIX_EVIDENCE, measuredAt: new Date(NOW).toISOString() };
      const evidence = await createFilePermissionStore({ dir, base: reprobed }).load({
        keyFingerprint: KEY,
        baseUrl: BASE,
      });
      assert.equal(
        permissionFor(evidence, "permitted-one", NOW).standing,
        "server_forbidden",
        "probe 결과가 실측된 403 을 덮었습니다",
      );
      assert.equal(permissionFor(evidence, "permitted-two", NOW).standing, "permitted");
    });
  });
});

describe("기록은 자격 증명과 게이트웨이에 묶인다", () => {
  test("다른 키의 기록은 읽지 않는다", async () => {
    await withStore(async ({ dir }) => {
      const store = createFilePermissionStore({ dir, base: MATRIX_EVIDENCE });
      await store.recordForbidden({ keyFingerprint: OTHER_KEY, baseUrl: BASE, modelId: "permitted-one", at: NOW });
      const evidence = await store.load({ keyFingerprint: KEY, baseUrl: BASE });
      // Not weaker evidence — evidence about another credential. The matrix for
      // *this* key is what stands.
      assert.equal(permissionFor(evidence, "permitted-one", NOW).standing, "permitted");
    });
  });

  test("다른 게이트웨이의 기록도 읽지 않는다", async () => {
    await withStore(async ({ dir }) => {
      const store = createFilePermissionStore({ dir, base: MATRIX_EVIDENCE });
      await store.recordForbidden({ keyFingerprint: KEY, baseUrl: OTHER_BASE, modelId: "permitted-one", at: NOW });
      const evidence = await store.load({ keyFingerprint: KEY, baseUrl: BASE });
      assert.equal(permissionFor(evidence, "permitted-one", NOW).standing, "permitted");
    });
  });

  test("근거가 없는 상태에서도 기록만으로 거부를 읽는다", async () => {
    await withStore(
      async ({ dir }) => {
        const store = createFilePermissionStore({ dir, base: null });
        await store.recordForbidden({ keyFingerprint: KEY, baseUrl: BASE, modelId: "permitted-one", at: NOW });
        const evidence = await store.load({ keyFingerprint: KEY, baseUrl: BASE });
        assert.equal(permissionFor(evidence, "permitted-one", NOW).standing, "server_forbidden");
        assert.deepEqual(permittedModels(evidence, CATALOGUE, NOW), []);
      },
      null,
    );
  });
});

describe("저장된 것에 자격 증명이 없다", () => {
  test("파일에는 fingerprint·모델 id·시각만 남는다", async () => {
    await withStore(async ({ dir, store }) => {
      await store.recordForbidden({ keyFingerprint: KEY, baseUrl: BASE, modelId: "permitted-one", at: NOW });
      const files = await readdir(dir);
      assert.deepEqual(files, ["permission-evidence.json"], files.join(", "));
      const body = await readFile(join(dir, files[0] as string), "utf8");

      assert.match(body, /sha256:abc123abc123/, "fingerprint 는 남아야 합니다");
      assert.match(body, /permitted-one/);
      assert.match(body, /"source": "live"/);
      // And none of these, ever.
      for (const forbidden of [/bearer/i, /authorization/i, /sk-[A-Za-z0-9]/, /api[_-]?key/i]) {
        assert.doesNotMatch(body, forbidden, `${forbidden} 이 파일에 있습니다`);
      }
      // No response body either: the record is a status and a time, not an answer.
      assert.ok(!body.includes("forbidden\","), "응답 본문이 저장됐습니다");
    });
  });

  test("자격 증명처럼 보이는 값은 저장을 거부한다", async () => {
    await withStore(async ({ dir }) => {
      const store = createFilePermissionStore({ dir, base: null });
      await assert.rejects(
        () =>
          store.recordForbidden({
            keyFingerprint: KEY,
            baseUrl: BASE,
            modelId: "sk-live-0123456789abcdef",
            at: NOW,
          }),
        /자격 증명/,
      );
    });
  });
});

describe("쓰기는 원자적이다", () => {
  test("임시 파일이 남지 않는다", async () => {
    await withStore(async ({ dir, store }) => {
      await store.recordForbidden({ keyFingerprint: KEY, baseUrl: BASE, modelId: "permitted-one", at: NOW });
      await store.recordForbidden({ keyFingerprint: KEY, baseUrl: BASE, modelId: "permitted-two", at: NOW });
      const files = await readdir(dir);
      assert.deepEqual(files.filter((f) => f.endsWith(".tmp")), [], files.join(", "));
      assert.deepEqual(files, ["permission-evidence.json"]);
    });
  });

  test("두 번째 거부가 첫 번째를 지우지 않는다", async () => {
    await withStore(async ({ dir, store }) => {
      await store.recordForbidden({ keyFingerprint: KEY, baseUrl: BASE, modelId: "permitted-one", at: NOW });
      await store.recordForbidden({ keyFingerprint: KEY, baseUrl: BASE, modelId: "permitted-two", at: NOW });
      const evidence = await store.load({ keyFingerprint: KEY, baseUrl: BASE });
      assert.deepEqual(permittedModels(evidence, CATALOGUE, NOW), []);
      for (const id of ["permitted-one", "permitted-two"]) {
        assert.equal(permissionFor(evidence, id, NOW).standing, "server_forbidden", id);
      }
    });
  });

  test("깨진 파일은 요청을 실패시키지 않는다", async () => {
    await withStore(async ({ dir }) => {
      await writeFile(join(dir, "permission-evidence.json"), "{ not json", "utf8");
      const store = createFilePermissionStore({ dir, base: MATRIX_EVIDENCE });
      // Unreadable means "nothing recorded here", which is what the probe matrix
      // is for. A corrupt cache is not a reason to fail a user's request.
      const evidence = await store.load({ keyFingerprint: KEY, baseUrl: BASE });
      assert.deepEqual(permittedModels(evidence, CATALOGUE, NOW), ["permitted-one", "permitted-two"]);
    });
  });

  test("저장 실패가 403 을 가리지 않는다", async () => {
    // The caller must see why their request stopped. A filesystem error replacing
    // the 403 would hide the only fact that matters.
    const provider = forbiddenProvider();
    const failing: PermissionEvidenceStore = {
      load: async () => MATRIX_EVIDENCE,
      recordForbidden: async () => {
        throw new Error("disk full");
      },
      invalidate: async () => undefined,
    };
    const propose = await createModelProposer({
      provider,
      permission: MATRIX_EVIDENCE,
      now: () => NOW,
      store: failing,
    });
    await assert.rejects(() => propose({ turnId: "t1", text: "코드를 보여줘." }), /forbidden/);
  });
});

describe("실제 HASA 호출은 0회다", () => {
  test("어떤 테스트도 provider.chat 을 성공적으로 통과시키지 않는다", async () => {
    // The whole file's provider is a mock that throws 403 and counts calls, and
    // the ranking path never calls `chat` at all.
    await withStore(async ({ store }) => {
      const provider = forbiddenProvider();
      const ranked = await rankByPermission({
        provider,
        permission: await store.load({ keyFingerprint: KEY, baseUrl: BASE }),
        now: () => NOW,
      });
      assert.deepEqual(ranked, ["permitted-one", "permitted-two"]);
      assert.deepEqual(provider.asked, [], "권한 순위를 정하며 모델을 호출했습니다");
    });
  });
});
