import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PERMISSION_MAX_AGE_MS,
  PERMISSION_MAX_FUTURE_SKEW_MS,
  denyObserved,
  evidenceFromMatrix,
  isForbiddenDenial,
  permissionFor,
  permissionReport,
  permittedModels,
  type PermissionEvidence,
} from "./modelPermission.ts";
import {
  SYSTEM,
  chooseProposerModel,
  createModelProposer,
  demoteRemembered,
  rankByPermission,
} from "./modelProposer.ts";
import type { CapabilityMatrix } from "../protocol/capability.ts";
import type { LlmProvider, ProviderChatResponse } from "../provider/types.ts";

/**
 * The public catalogue is not this key's permission.
 *
 * Every test here runs with no API key and touches no network. That is not
 * incidental — the defect being guarded is precisely that permission was being
 * inferred from an endpoint that answers *without* a credential, so a test that
 * needed one could not tell the two apart either.
 *
 * No test reads the real clock either, for the same kind of reason: the record
 * has a maximum age, and a suite whose verdict depends on when it runs cannot
 * tell an expiry rule from a passing minute.
 */

const KEY = "sha256:abc123abc123";
const BASE = "https://gateway.example/v1";

/** A gateway that publishes five models. Publishing is not permitting. */
const CATALOGUE = ["public-a", "public-b", "permitted-one", "denied-one", "never-probed"];

/** When the evidence was measured, and the moment every test judges it from. */
const MEASURED_AT = "2026-08-01T00:00:00.000Z";
const NOW = Date.parse("2026-08-01T01:00:00.000Z");

const EVIDENCE: PermissionEvidence = {
  keyFingerprint: KEY,
  baseUrl: BASE,
  measuredAt: MEASURED_AT,
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
    const permitted = permittedModels(EVIDENCE, CATALOGUE, NOW);
    assert.deepEqual(permitted, ["permitted-one"]);
    assert.equal(CATALOGUE.length, 5, "카탈로그에는 다섯 개가 있습니다");
  });

  test("403 을 받은 모델은 제외된다", () => {
    assert.equal(permissionFor(EVIDENCE, "denied-one", NOW).standing, "server_forbidden");
    assert.ok(!permittedModels(EVIDENCE, CATALOGUE, NOW).includes("denied-one"));
  });

  test("내부 상태 이름은 영구 권한을 단정하지 않는다", () => {
    // A 403 says the server refused this call. Which of a serving policy, a
    // temporary block, an account restriction or a plan change caused it is not
    // in an HTTP status, and a name like `denied` invites code that acts as
    // though it were.
    const row = permissionFor(EVIDENCE, "denied-one", NOW);
    assert.equal(row.standing, "server_forbidden");
    assert.equal(row.reason, "server_forbidden_at_probe");
    assert.match(row.basis, /서버 정책·일시 차단·계정 정책/);
    assert.doesNotMatch(row.basis, /영구|권한이 없습니다/);
  });

  test("권한 unknown 은 permitted 로 승격되지 않는다", () => {
    // The whole defect in one assertion. `never-probed` is in the public
    // catalogue and nothing has ever been established about it for this key.
    assert.equal(permissionFor(EVIDENCE, "never-probed", NOW).standing, "unknown");
    assert.ok(!permittedModels(EVIDENCE, CATALOGUE, NOW).includes("never-probed"));
  });

  test("pass 가 아닌 어떤 상태도 permitted 가 아니다", () => {
    for (const id of ["public-a", "public-b"]) {
      assert.notEqual(permissionFor(EVIDENCE, id, NOW).standing, "permitted", id);
    }
  });

  test("근거가 아예 없으면 아무것도 permitted 가 아니다", () => {
    assert.deepEqual(permittedModels(null, CATALOGUE, NOW), []);
    assert.equal(permissionFor(null, "permitted-one", NOW).standing, "unknown");
  });

  test("모든 판정은 근거 문장을 함께 낸다", () => {
    for (const row of permissionReport(EVIDENCE, CATALOGUE, NOW)) {
      assert.ok(row.basis.length > 0, `${row.modelId} 의 근거가 비어 있습니다`);
    }
  });

  test("공개 목록 자체는 근거가 되지 못한다", () => {
    // The catalogue is the only thing available, and it establishes nothing:
    // every entry comes back unknown with the reason saying why.
    const report = permissionReport(null, CATALOGUE, NOW);
    assert.deepEqual(
      report.map((r) => r.standing),
      CATALOGUE.map(() => "unknown"),
    );
    assert.deepEqual(new Set(report.map((r) => r.reason)), new Set(["never_probed"]));
  });
});

describe("측정 시각에는 유효기간이 있다", () => {
  /** Evidence measured at `MEASURED_AT`, judged from a chosen distance. */
  const at = (offsetMs: number): number => Date.parse(MEASURED_AT) + offsetMs;

  test("유효기간 안이면 permitted 로 남는다", () => {
    const row = permissionFor(EVIDENCE, "permitted-one", at(PERMISSION_MAX_AGE_MS - 1));
    assert.equal(row.standing, "permitted");
    assert.equal(row.reason, "chat_succeeded");
  });

  test("유효기간을 넘긴 기록은 unknown 이다", () => {
    const row = permissionFor(EVIDENCE, "permitted-one", at(PERMISSION_MAX_AGE_MS + 1));
    assert.equal(row.standing, "unknown", "만료된 기록으로 호출을 열어서는 안 됩니다");
    assert.equal(row.reason, "expired");
    assert.deepEqual(permittedModels(EVIDENCE, CATALOGUE, at(PERMISSION_MAX_AGE_MS + 1)), []);
  });

  test("거부는 만료로 풀리지 않는다", () => {
    // Reversed deliberately, and this is the safety half of the policy. An
    // expired `permitted` becoming `unknown` costs one re-probe. An expired
    // refusal becoming `unknown` would mean the next request calls the model to
    // find out whether it is still forbidden — using a real credential to explore
    // an access boundary, which is how a key gets blocked. It stays forbidden
    // until a permission API or the user says otherwise.
    const row = permissionFor(EVIDENCE, "denied-one", at(PERMISSION_MAX_AGE_MS * 30));
    assert.equal(row.standing, "server_forbidden");
    assert.ok(!permittedModels(EVIDENCE, CATALOGUE, at(PERMISSION_MAX_AGE_MS * 30)).includes("denied-one"));
  });

  test("permitted 는 여전히 만료된다", () => {
    // The asymmetry only makes sense if the other side still expires.
    const row = permissionFor(EVIDENCE, "permitted-one", at(PERMISSION_MAX_AGE_MS + 1));
    assert.equal(row.standing, "unknown");
    assert.equal(row.reason, "expired");
  });

  test("읽을 수 없는 날짜는 시각이 아니다", () => {
    for (const measuredAt of ["", "어제", "2026-13-45T99:99:99Z", "NaN", "0000-00-00"]) {
      const row = permissionFor({ ...EVIDENCE, measuredAt }, "permitted-one", NOW);
      assert.equal(row.standing, "unknown", `${measuredAt} 를 시각으로 받아들였습니다`);
      assert.equal(row.reason, "unreadable_time", measuredAt);
    }
  });

  test("작은 시계 오차는 허용한다", () => {
    // The matrix was written on a machine a minute ahead of this one. That is
    // clock skew, not a claim about the future.
    const row = permissionFor(EVIDENCE, "permitted-one", at(-PERMISSION_MAX_FUTURE_SKEW_MS + 1_000));
    assert.equal(row.standing, "permitted");
    assert.equal(row.ageMs, 0, "미래 시각이 음수 나이로 새어나가지 않습니다");
  });

  test("허용 범위를 넘는 미래 시각은 거부한다", () => {
    const row = permissionFor(EVIDENCE, "permitted-one", at(-PERMISSION_MAX_FUTURE_SKEW_MS - 1));
    assert.equal(row.standing, "unknown", "미래 시각을 '아주 신선함'으로 읽어서는 안 됩니다");
    assert.equal(row.reason, "future_dated");
  });

  test("한 시간 전 기록의 나이가 보고된다", () => {
    const row = permissionFor(EVIDENCE, "permitted-one", NOW);
    assert.equal(row.ageMs, 3_600_000);
    assert.match(row.basis, /1시간/);
  });
});

describe("실제 403 은 기록보다 우선한다", () => {
  test("permitted 기록이 있어도 403 을 관측하면 server_forbidden 이 된다", () => {
    const before = permissionFor(EVIDENCE, "permitted-one", NOW);
    assert.equal(before.standing, "permitted");

    const corrected = denyObserved(EVIDENCE, "permitted-one", NOW);
    const after = permissionFor(corrected, "permitted-one", NOW);
    assert.equal(after.standing, "server_forbidden");
    assert.equal(after.reason, "server_forbidden_live");
    assert.deepEqual(permittedModels(corrected, CATALOGUE, NOW), []);
  });

  test("관측된 거부는 파일의 측정 시각이 아니라 자신의 시각으로 판단된다", () => {
    // The file has lapsed; the 403 happened a moment ago. Dating the refusal by
    // the file would expire it and quietly restore `unknown`.
    const late = Date.parse(MEASURED_AT) + PERMISSION_MAX_AGE_MS * 2;
    const corrected = denyObserved(EVIDENCE, "permitted-one", late);
    const row = permissionFor(corrected, "permitted-one", late);
    assert.equal(row.standing, "server_forbidden");
    assert.equal(row.reason, "server_forbidden_live");
  });

  test("기록에 없던 모델의 거부도 기록된다", () => {
    const corrected = denyObserved(EVIDENCE, "never-probed", NOW);
    assert.equal(permissionFor(corrected, "never-probed", NOW).standing, "server_forbidden");
  });

  test("기록이 없으면 만들어내지 않는다", () => {
    // Inventing a record would mean inventing the credential and gateway it was
    // measured under. `unknown` already excludes the model.
    assert.equal(denyObserved(null, "permitted-one", NOW), null);
  });

  test("403 은 여러 모양으로 도착한다", () => {
    assert.ok(isForbiddenDenial({ code: "forbidden" }));
    assert.ok(isForbiddenDenial({ httpStatus: 403 }));
    assert.ok(isForbiddenDenial({ status: 403 }));
    assert.ok(!isForbiddenDenial({ code: "rate_limited", httpStatus: 429 }));
    assert.ok(!isForbiddenDenial(new Error("boom")));
    assert.ok(!isForbiddenDenial(null));
    assert.ok(!isForbiddenDenial("403"));
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
    const got = evidenceFromMatrix({ matrix, keyFingerprint: KEY, baseUrl: BASE, now: NOW });
    assert.ok(got !== null);
    assert.deepEqual(permittedModels(got, CATALOGUE, NOW), ["permitted-one"]);
  });

  test("다른 키의 기록은 권한 근거가 아니다", () => {
    // Not weaker evidence — evidence about somebody else. A key upgrade widens
    // what is callable and a downgrade narrows it; either way this file
    // describes a credential that is not the one about to be used.
    const got = evidenceFromMatrix({
      matrix,
      keyFingerprint: "sha256:different",
      baseUrl: BASE,
      now: NOW,
    });
    assert.equal(got, null);
    assert.deepEqual(permittedModels(got, CATALOGUE, NOW), []);
  });

  test("다른 게이트웨이의 기록도 마찬가지다", () => {
    const got = evidenceFromMatrix({
      matrix,
      keyFingerprint: KEY,
      baseUrl: "https://other/v1",
      now: NOW,
    });
    assert.equal(got, null);
  });

  test("기록이 없으면 null 이다", () => {
    assert.equal(evidenceFromMatrix({ matrix: null, keyFingerprint: KEY, baseUrl: BASE, now: NOW }), null);
  });

  test("읽을 수 없는 probedAt 은 측정이 아니다", () => {
    const broken = { ...matrix, probedAt: "언젠가" } as unknown as CapabilityMatrix;
    assert.equal(evidenceFromMatrix({ matrix: broken, keyFingerprint: KEY, baseUrl: BASE, now: NOW }), null);
  });

  test("미래에 측정된 파일은 받아들이지 않는다", () => {
    const ahead = {
      ...matrix,
      probedAt: new Date(NOW + PERMISSION_MAX_FUTURE_SKEW_MS + 60_000).toISOString(),
    } as unknown as CapabilityMatrix;
    assert.equal(evidenceFromMatrix({ matrix: ahead, keyFingerprint: KEY, baseUrl: BASE, now: NOW }), null);
  });

  test("오래된 파일은 버리지 않고 만료로 실어 보낸다", () => {
    // A lapsed measurement and a missing one are different things to a report:
    // "24시간이 지났습니다" is actionable and "기록이 없습니다" is not the same
    // sentence. So the age check lives in `permissionFor`, not here.
    const old = evidenceFromMatrix({
      matrix,
      keyFingerprint: KEY,
      baseUrl: BASE,
      now: NOW + PERMISSION_MAX_AGE_MS * 2,
    });
    assert.ok(old !== null, "오래된 것은 손상된 것과 다릅니다");
    const row = permissionFor(old, "permitted-one", NOW + PERMISSION_MAX_AGE_MS * 2);
    assert.equal(row.standing, "unknown");
    assert.equal(row.reason, "expired");
  });
});

describe("proposer 는 권한이 확인된 모델만 사용한다", () => {
  /** The clock the proposer is given. Fixed, so nothing here waits or drifts. */
  const now = (): number => NOW;

  test("허용된 모델만 후보가 된다", async () => {
    const provider = fakeProvider();
    assert.deepEqual(await rankByPermission({ provider, permission: EVIDENCE, now }), ["permitted-one"]);
  });

  test("권한 근거가 없으면 후보가 없다", async () => {
    const provider = fakeProvider();
    assert.deepEqual(await rankByPermission({ provider, permission: null, now }), []);
  });

  test("후보가 없으면 만들지 않고 실패한다", async () => {
    const provider = fakeProvider();
    await assert.rejects(() => createModelProposer({ provider, permission: null, now }));
    assert.deepEqual(provider.asked, [], "권한이 없는데도 호출을 시도했습니다");
  });

  test("한 번도 재지 않았으면 재라고 말한다", async () => {
    // 제품을 사용자처럼 써 보고서야 필요한 줄 알았다. 유효한 키에 35개를 답하는
    // 게이트웨이인데 「부를 수 있는 모델이 없습니다」만 나왔다 — 런타임은 이유가
    // `never_probed` 인 것을 알고 있었고 아무에게도 말하지 않았다.
    const provider = fakeProvider();
    await assert.rejects(
      () => createModelProposer({ provider, permission: null, now }),
      (err: Error) => {
        assert.match(err.message, /재지 않았습니다/, "무엇이 없는지 말해야 한다");
        assert.match(err.message, /probe/, "무엇을 하면 되는지 말해야 한다");
        return true;
      },
    );
  });

  test("전부 거부됐으면 다시 재라고 말하지 않는다", async () => {
    // 거부는 재측정으로 바뀌지 않는다. 여기서 probe 를 권하면 고칠 수 없는 일을
    // 시키는 것이고, 사용자는 키 권한이라는 진짜 원인에서 멀어진다.
    const allDenied: PermissionEvidence = {
      ...EVIDENCE,
      models: CATALOGUE.map((modelId) => ({ modelId, chat: "denied" as const })),
    };
    const provider = fakeProvider();
    await assert.rejects(
      () => createModelProposer({ provider, permission: allDenied, now }),
      (err: Error) => {
        assert.match(err.message, /거부/);
        assert.doesNotMatch(err.message, /probe/, "재도 소용없는데 재라고 하면 안 된다");
        return true;
      },
    );
  });

  test("거부와 미측정이 섞이면 남은 것을 재라고 말한다", async () => {
    // 처음 쓴 메시지는 이 경우에도 「다시 재도 바뀌지 않는다」고 말했다. 미측정이
    // 남아 있으면 재는 것이 정확히 할 일이므로, 고칠 수 있는 사람을 돌려보내는
    // 조언이었다.
    const mixed: PermissionEvidence = {
      ...EVIDENCE,
      models: [{ modelId: "denied-one", chat: "denied" }],
    };
    const provider = fakeProvider();
    await assert.rejects(
      () => createModelProposer({ provider, permission: mixed, now }),
      (err: Error) => {
        assert.match(err.message, /probe/, "미측정이 남았으면 재라고 해야 한다");
        assert.match(err.message, /거부 1개/, "거부된 수도 함께 말해야 한다");
        return true;
      },
    );
  });

  test("권한 없는 모델에는 한 번도 호출하지 않는다", async () => {
    const provider = fakeProvider('[{"text":"x","start":0,"end":4}]');
    const propose = await createModelProposer({ provider, permission: EVIDENCE, now });
    await propose({ turnId: "t1", text: "코드를 보여줘." });
    assert.deepEqual(provider.asked, ["permitted-one"]);
    for (const id of ["public-a", "public-b", "denied-one", "never-probed"]) {
      assert.ok(!provider.asked.includes(id), `${id} 를 호출했습니다`);
    }
  });

  test("기록이 만료됐으면 후보가 없다", async () => {
    const provider = fakeProvider();
    const stale = (): number => Date.parse(MEASURED_AT) + PERMISSION_MAX_AGE_MS + 1;
    assert.deepEqual(await rankByPermission({ provider, permission: EVIDENCE, now: stale }), []);
    await assert.rejects(() => createModelProposer({ provider, permission: EVIDENCE, now: stale }));
    assert.deepEqual(provider.asked, [], "만료된 기록으로 호출했습니다");
  });

  test("403 을 받으면 permitted 기록을 계속 쓰지 않는다", async () => {
    // The record says `permitted` and the gateway says otherwise. The gateway is
    // the one holding the answer, and a second attempt on the strength of the
    // file is how a burst of 403s reaches a provider's transaction log.
    const asked: string[] = [];
    const denials: Array<{ modelId: string; permitted: string[] }> = [];
    const provider = {
      id: "hasa" as const,
      displayName: "fake",
      baseUrl: BASE,
      listModels: async () => ({ models: CATALOGUE.map((id) => ({ id, ownedBy: "x" })), fetchedAt: 0 }),
      chat: async (req: { modelId: string }): Promise<ProviderChatResponse> => {
        asked.push(req.modelId);
        throw Object.assign(new Error("forbidden: this key may not call permitted-one"), {
          code: "forbidden",
          httpStatus: 403,
        });
      },
      stream: async function* () {
        throw new Error("the proposer must not stream");
      },
      validate: async () => {
        throw new Error("not used");
      },
    } as unknown as LlmProvider;

    const propose = await createModelProposer({
      provider,
      permission: EVIDENCE,
      now,
      onDenied: ({ modelId, permission }) =>
        denials.push({ modelId, permitted: permittedModels(permission, CATALOGUE, NOW) }),
    });

    await assert.rejects(() => propose({ turnId: "t1", text: "코드를 보여줘." }));
    assert.deepEqual(asked, ["permitted-one"], "403 을 받고도 재시도했습니다");
    assert.deepEqual(denials, [{ modelId: "permitted-one", permitted: [] }]);

    // And the next turn does not go back to it.
    await assert.rejects(() => propose({ turnId: "t2", text: "다시 보여줘." }));
    assert.deepEqual(asked, ["permitted-one"], "취소된 모델을 다시 호출했습니다");
  });

  test("403 이 아닌 실패는 모델을 취소하지 않는다", async () => {
    // A timeout is not a permission verdict. Revoking on one would drop a model
    // the key really may call, and there is nothing that would restore it.
    const asked: string[] = [];
    let calls = 0;
    const provider = {
      id: "hasa" as const,
      displayName: "fake",
      baseUrl: BASE,
      listModels: async () => ({ models: CATALOGUE.map((id) => ({ id, ownedBy: "x" })), fetchedAt: 0 }),
      chat: async (req: { modelId: string }): Promise<ProviderChatResponse> => {
        asked.push(req.modelId);
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("timeout"), { code: "timeout", httpStatus: null });
        }
        return {
          modelId: req.modelId,
          text: '[{"text":"x","start":0,"end":4}]',
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
    } as unknown as LlmProvider;

    const propose = await createModelProposer({ provider, permission: EVIDENCE, now });
    await assert.rejects(() => propose({ turnId: "t1", text: "코드를 보여줘." }));
    const second = await propose({ turnId: "t2", text: "코드를 보여줘." });
    assert.equal(second.modelId, "permitted-one");
    assert.deepEqual(asked, ["permitted-one", "permitted-one"]);
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
        // The trailing `\r` comes off first, and that is not cosmetic: `.` does
        // not match a carriage return, so `//.*$` could never reach the end of a
        // CRLF line and every comment in a CRLF file was scanned as code. This
        // test reported `modelProposer.ts` for the comment explaining why that
        // file does *not* unwrap `choices[0]`.
        source.split("\n").forEach((raw, i) => {
          const line = raw.replace(/\r$/, "");
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

describe("기억이 제안자 선택을 움직인다", () => {
  const SPACE = "hasa|bge-m3|3|";

  const seen = (
    modelId: string,
    outcome: "accepted" | "superseded",
    n: number,
    budget: number | null = 800,
  ) =>
    Array.from({ length: n }, (_, i) => ({
      similarity: 0.9,
      row: {
        id: `${modelId}-${outcome}-${i}`,
        turnId: "t1",
        sourceText: "로그인 오류를 고쳐",
        proposedBy: modelId,
        budget,
        outcome,
        vector: [1, 0, 0],
        space: SPACE,
        at: 0,
      },
    }));

  test("기억이 없으면 카탈로그 순서 그대로다", () => {
    const order = ["a", "b", "c"];
    assert.deepEqual(demoteRemembered(order, [], 0), order);
  });

  test("정정당한 모델이 뒤로 밀린다", () => {
    // 마디 3 이 실제로 하는 일. 지난 비슷한 요청에서 사용자가 고쳐야 했던
    // 제안자는 이번에도 덜 신뢰한다.
    const order = ["나쁜모델", "좋은모델"];
    const neighbours = [
      ...seen("나쁜모델", "superseded", 4),
      ...seen("좋은모델", "accepted", 4),
    ];
    assert.deepEqual(demoteRemembered(order, neighbours, 0), ["좋은모델", "나쁜모델"]);
  });

  test("기억이 모르는 모델은 자리를 지킨다", () => {
    // 의견이 없는 것은 나쁘다는 뜻이 아니다. 모르는 모델을 뒤로 미는 것은
    // 침묵을 최하점으로 읽는 일이고, 그러면 새 모델은 영영 뽑히지 않는다.
    const order = ["모르는모델", "나쁜모델"];
    assert.deepEqual(
      demoteRemembered(order, seen("나쁜모델", "superseded", 4), 0),
      ["모르는모델", "나쁜모델"],
    );
  });

  test("이웃이 문턱보다 적으면 순서를 바꾸지 않는다", () => {
    const order = ["a", "b"];
    assert.deepEqual(demoteRemembered(order, seen("a", "superseded", 1), 0), order);
  });

  test("제외하지는 않는다 — 권한은 이 함수의 것이 아니다", () => {
    const order = ["나쁜모델", "좋은모델"];
    const after = demoteRemembered(order, seen("나쁜모델", "superseded", 5), 0);
    assert.equal(after.length, 2, "밀어내되 빼지 않는다");
    assert.ok(after.includes("나쁜모델"));
  });

  test("한 예산에서만 나빴어도 그 판정을 쓴다", () => {
    // 프로필에 예산 칸이 없으니, 좋은 날 성적으로 뽑고 나쁜 날에 부르는 일이
    // 없도록 최악을 쓴다.
    const order = ["양면모델", "고른모델"];
    const neighbours = [
      ...seen("양면모델", "accepted", 4, 6000),
      ...seen("양면모델", "superseded", 4, 800),
      ...seen("고른모델", "accepted", 4, 800),
    ];
    assert.deepEqual(demoteRemembered(order, neighbours, 0), ["고른모델", "양면모델"]);
  });

  /** Two permitted models, so a reorder can actually change the answer. */
  const TWO_PERMITTED: PermissionEvidence = {
    ...EVIDENCE,
    models: [
      { modelId: "public-a", chat: "pass" },
      { modelId: "permitted-one", chat: "pass" },
    ],
  };

  test("chooseProposerModel 이 기억의 순서를 따른다", async () => {
    // 처음 쓴 이 시험은 권한 있는 모델이 하나뿐이어서, 기억을 통째로 무시하는
    // 변이를 넣어도 통과했다 — 재정렬이 답을 바꿀 수 없는 판이었다.
    const provider = fakeProvider();
    const chosen = await chooseProposerModel({
      provider,
      permission: TWO_PERMITTED,
      now: () => NOW,
      // public-a 가 카탈로그에서 앞이지만, 기억이 그것을 밀어낸다.
      remembered: [...seen("public-a", "superseded", 4), ...seen("permitted-one", "accepted", 4)],
    });
    assert.equal(chosen, "permitted-one");
  });

  test("기억이 없으면 chooseProposerModel 은 카탈로그 순서를 쓴다", async () => {
    const provider = fakeProvider();
    const chosen = await chooseProposerModel({ provider, permission: TWO_PERMITTED, now: () => NOW });
    assert.equal(chosen, "public-a", "기억이 없으면 앞선 것이 뽑힌다");
  });

  test("의견 없는 모델은 나쁜 모델보다 앞에 남는다", () => {
    // 앞선 시험은 둘뿐이라 비교자가 뒤집혀도 우연히 통과했다. 셋으로 두면
    // 「모르는 것은 앞, 나쁜 것은 뒤」가 순서로 드러난다.
    const order = ["나쁜모델", "모르는모델", "덜나쁜모델"];
    const neighbours = [
      ...seen("나쁜모델", "superseded", 4),
      ...seen("덜나쁜모델", "superseded", 2).concat(seen("덜나쁜모델", "accepted", 2)),
    ];
    assert.deepEqual(demoteRemembered(order, neighbours, 0), [
      "모르는모델",
      "덜나쁜모델",
      "나쁜모델",
    ]);
  });
});

/**
 * 제안자가 근거를 어떻게 받는가.
 *
 * 네 모델에 열 사례씩 물어 잰 결과(`scripts/quoteVsOffset.mjs`)로 프롬프트와
 * 파서를 함께 바꿨다. 좌표만 받을 때 `pointed` 10/64, 인용을 받을 때 33/64,
 * 둘 다 받을 때 32/64 였고 — 두 모델은 좌표를 **0%** 맞혔다. 그런데 한 모델은
 * 인용만 요구하면 빈 배열을 돌려주므로 둘 다 요구한다.
 *
 * 아래 둘은 그 결정이 배선에서 살아 있는지를 잰다. 파서 쪽 단위 테스트는
 * `parseProposals` 를 직접 부르므로, 제안자가 **원문을 넘기는지** 는 여기서만
 * 확인된다 — 안 넘기면 인용은 위치를 못 찾고 옛 동작으로 조용히 돌아간다.
 */
describe("제안자는 인용으로 지목한 근거를 쓴다", () => {
  const now = (): number => NOW;
  const TEXT = "로그인 오류를 고쳐주고 테스트도 돌려주세요.";

  test("프롬프트가 인용을 요구한다", () => {
    assert.match(SYSTEM, /quote/, "인용 필드를 요구하지 않습니다");
    assert.match(SYSTEM, /그대로 베낀/, "무엇을 넣으라는 것인지 말해야 합니다");
    // 좌표도 함께 요구해야 한다. 인용만 요구하면 그것을 못 하는 모델이 있다.
    assert.match(SYSTEM, /start/, "좌표를 함께 요구하지 않습니다");
  });

  test("좌표 없는 인용만 와도 제안이 선다", async () => {
    const provider = fakeProvider('[{"text":"로그인 오류를 고친다","quote":"로그인 오류를 고쳐주고"}]');
    const propose = await createModelProposer({ provider, permission: EVIDENCE, now });
    const out = await propose({ turnId: "t1", text: TEXT });
    assert.equal(out.proposals.length, 1, `읽지 못했습니다: ${JSON.stringify(out.parse.outcome)}`);
    assert.deepEqual(
      { s: out.proposals[0]?.span.start, e: out.proposals[0]?.span.end },
      { s: 0, e: TEXT.indexOf("로그인 오류를 고쳐주고") + "로그인 오류를 고쳐주고".length },
    );
  });
});
