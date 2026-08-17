import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewDesign, type PreviewResult } from "./preview.ts";
import { shadowScenarioFrom } from "./scenarioShadow.ts";
import { permittedModels, type PermissionEvidence } from "./modelPermission.ts";
import { rankByPermission } from "./modelProposer.ts";
import { prohibitionsIn } from "../agent/statedProhibitions.ts";
import { decideAction } from "../agent/actionPolicy.ts";
import { emptyContract, type TaskContract } from "../agent/turnContract.ts";
import type { LlmProvider } from "../provider/types.ts";


/**
 * The shadow, and the seven things it must not do.
 *
 * Every assertion here is about an absence, which is the hard kind to test. Two
 * complementary methods are used and neither is sufficient alone:
 *
 *   - *Structural.* The module's source is read and checked for the imports and
 *     calls that would make a side effect possible at all. This is what catches
 *     a future edit that adds a client; a behavioural test only catches the ones
 *     that fire on the inputs the test happens to use.
 *   - *Behavioural.* A production decision is computed with and without the
 *     shadow running beside it and the two are compared, and a real workspace is
 *     watched for changes across a shadow run.
 */

const SOURCE = new URL("./scenarioShadow.ts", import.meta.url);
const KEY = "sha256:abc";
const BASE = "https://gateway.example/v1";
const NOW = Date.parse("2026-08-01T01:00:00.000Z");

const TURNS = [
  "로그인 오류를 수정하고 테스트해줘.",
  "정정할게. 실행하지 말고 코드만 보여줘.",
];

let source: string;
let preview: PreviewResult;

/** Every file in a directory and its bytes. What "unchanged" has to mean. */
async function snapshot(dir: string): Promise<Array<[string, string]>> {
  const names = (await readdir(dir)).sort();
  return Promise.all(names.map(async (name) => [name, await readFile(join(dir, name), "utf8")] as [string, string]));
}

before(async () => {
  source = await readFile(SOURCE, "utf8");
  preview = await previewDesign({ turns: TURNS });
});

describe("Shadow 는 아무것도 하지 않는다", () => {
  /** Comments may name what is forbidden; code may not contain it. */
  const code = (): string =>
    source
      .split("\n")
      .filter((line) => !/^\s*(?:\*|\/\/)/.test(line))
      .join("\n");

  test("파일을 쓸 수 있는 경로가 아예 없다", () => {
    for (const pattern of [/node:fs/, /writeFile/, /createWriteStream/, /\bmkdir\b/, /appendFile/]) {
      assert.ok(!pattern.test(code()), `${pattern} 이 소스에 있습니다`);
    }
  });

  test("명령을 실행할 수 있는 경로가 없다", () => {
    for (const pattern of [/child_process/, /execFile/, /\bspawn\b/, /execSync/]) {
      assert.ok(!pattern.test(code()), `${pattern} 이 소스에 있습니다`);
    }
  });

  test("네트워크를 호출할 수 있는 경로가 없다", () => {
    for (const pattern of [/\bfetch\s*\(/, /node:http/, /provider\./, /client/i, /\.chat\s*\(/]) {
      assert.ok(!pattern.test(code()), `${pattern} 이 소스에 있습니다`);
    }
  });

  test("모델 선택·승인·도구 게이트를 import 하지 않는다", () => {
    for (const pattern of [
      /modelPermission/,
      /modelProposer/,
      /approval/,
      /actionPolicy/,
      /statedProhibitions/,
      /toolGate/,
    ]) {
      assert.ok(!pattern.test(code()), `${pattern} 을 참조합니다`);
    }
  });

  test("시계도 난수도 읽지 않는다", () => {
    for (const pattern of [/Date\.now/, /new Date\(/, /Math\.random/, /performance\.now/]) {
      assert.ok(!pattern.test(code()), `${pattern} 을 읽습니다`);
    }
  });

  test("실제 디렉터리의 내용이 그대로 남는다", async () => {
    // A plain temp directory rather than a repo fixture: the claim is about bytes
    // on disk, git has nothing to do with it, and `git init` per run cost this
    // suite thirty seconds for no extra evidence.
    const dir = await mkdtemp(join(tmpdir(), "shadow-"));
    try {
      await writeFile(join(dir, "a.ts"), "export const a = 1;\n", "utf8");
      const before = await snapshot(dir);
      const result = shadowScenarioFrom({ id: "shadow-1", preview });
      assert.equal(result.status, "mapped");
      assert.deepEqual(await snapshot(dir), before, "디렉터리 내용이 바뀌었습니다");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Shadow 는 Production 결정에 영향을 주지 않는다", () => {
  const evidence: PermissionEvidence = {
    keyFingerprint: KEY,
    baseUrl: BASE,
    measuredAt: "2026-08-01T00:00:00.000Z",
    models: [
      { modelId: "permitted-one", chat: "pass" },
      { modelId: "denied-one", chat: "denied" },
    ],
  };
  const catalogue = ["permitted-one", "denied-one", "never-probed"];

  function countingProvider(): LlmProvider & { calls: number } {
    const provider = {
      id: "hasa" as const,
      displayName: "fake",
      baseUrl: BASE,
      calls: 0,
      listModels: async () => ({ models: catalogue.map((id) => ({ id, ownedBy: "x" })), fetchedAt: 0 }),
      chat: async () => {
        provider.calls += 1;
        throw new Error("the shadow must never reach a model");
      },
      stream: async function* () {
        throw new Error("no");
      },
      validate: async () => {
        throw new Error("no");
      },
    };
    return provider as unknown as LlmProvider & { calls: number };
  }

  test("모델 선택 결과가 Shadow 전후로 동일하다", async () => {
    const provider = countingProvider();
    const now = (): number => NOW;
    const before = await rankByPermission({ provider, permission: evidence, now });

    const result = shadowScenarioFrom({ id: "shadow-2", preview });
    assert.equal(result.status, "mapped");

    const after = await rankByPermission({ provider, permission: evidence, now });
    assert.deepEqual(after, before);
    assert.deepEqual(after, ["permitted-one"]);
    assert.deepEqual(permittedModels(evidence, catalogue, NOW), ["permitted-one"]);
    assert.equal(provider.calls, 0, "Shadow 가 모델을 호출했습니다");
  });

  test("사용자의 금지 판정이 Shadow 전후로 동일하다", () => {
    const text = TURNS[1] as string;
    const before = [...prohibitionsIn(text)].sort();
    shadowScenarioFrom({ id: "shadow-3", preview });
    assert.deepEqual([...prohibitionsIn(text)].sort(), before);
    assert.deepEqual(before, ["execute"]);
  });

  test("도구 게이트 판정이 Shadow 전후로 동일하다", () => {
    const contract: TaskContract = {
      ...emptyContract(),
      goal: "코드 확인",
      relation: "correct",
      intents: ["inspect"],
      lastTurnId: "t2",
      constraints: [{ kind: "no_execute", text: "실행하지 말고", sourceTurnId: "t2" }],
    };
    const ask = (): string => JSON.stringify(decideAction(contract, "run_command", "t2"));
    const before = ask();
    shadowScenarioFrom({ id: "shadow-4", preview });
    assert.equal(ask(), before);
    assert.match(before, /"deny"/, "금지된 도구가 허용되고 있습니다");
  });
});

describe("Shadow 실패는 사용자 작업을 중단시키지 않는다", () => {
  test("입력이 망가져도 예외를 던지지 않는다", () => {
    const broken = {
      get requirements(): never {
        throw new Error("boom");
      },
    } as unknown as PreviewResult;
    const result = shadowScenarioFrom({ id: "shadow-5", preview: broken });
    assert.equal(result.status, "adapter_failed");
    assert.equal(result.failure, "adapter_threw");
    assert.match(result.detail ?? "", /boom/);
    assert.equal(result.scenario, null);
  });

  test("요구사항이 없으면 실패가 아니라 매핑할 것이 없다고 말한다", async () => {
    const empty = await previewDesign({ turns: ["적당히 잘 좀 해줘."] });
    const result = shadowScenarioFrom({ id: "shadow-6", preview: empty });
    assert.equal(result.status, "nothing_to_map");
    assert.equal(result.failure, "no_user_requirement");
    assert.equal(result.scenario, null);
  });
});

describe("같은 입력은 같은 결과", () => {
  test("두 번 돌려도 바이트까지 같다", async () => {
    const a = shadowScenarioFrom({ id: "shadow-7", preview });
    const again = await previewDesign({ turns: TURNS });
    const b = shadowScenarioFrom({ id: "shadow-7", preview: again });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });
});

describe("결과는 자신의 근거를 기록한다", () => {
  test("요구사항의 출처가 턴과 좌표까지 남는다", () => {
    const result = shadowScenarioFrom({ id: "shadow-8", preview });
    assert.ok(result.requirementSources.length > 0);
    for (const source of result.requirementSources) {
      assert.ok(source.requirementId.length > 0);
      assert.ok(["t1", "t2"].includes(source.turnId), source.turnId);
      assert.ok(source.sourceText.length > 0, `${source.requirementId} 의 근거 문장이 없습니다`);
      assert.ok(source.derivedBy.length > 0);
      if (source.span !== null) {
        const turn = TURNS[source.turnId === "t1" ? 0 : 1] as string;
        assert.ok(source.span.start >= 0 && source.span.end <= turn.length, "span 이 턴을 벗어납니다");
      }
    }
  });

  test("사용된 설계 규칙과 oracle coverage 가 남는다", () => {
    const result = shadowScenarioFrom({ id: "shadow-9", preview });
    assert.ok(result.designRulesUsed.includes("forbidden.v1"), result.designRulesUsed.join(", "));
    assert.ok(result.designRulesUsed.includes("inspect.v1"), result.designRulesUsed.join(", "));
    assert.ok(result.oracleCoverage.includes("no_side_effect"), result.oracleCoverage.join(", "));
    // Sorted, so two runs produce the same list in the same order.
    assert.deepEqual(result.designRulesUsed, [...result.designRulesUsed].sort());
    assert.deepEqual(result.oracleCoverage, [...result.oracleCoverage].sort());
  });

  test("미해결 항목과 옮기지 못한 것이 이름을 갖는다", async () => {
    // A plan with something genuinely open. The two-turn preview above no longer
    // has one: every act in it now has a design rule, so its only remaining
    // unresolved entries were `NO_DESIGN_RULE` — which is the improvement, and
    // makes it the wrong preview for asserting that open items get named.
    const open = await previewDesign({ turns: ["테스트해줘."] });
    const result = shadowScenarioFrom({ id: "shadow-10", preview: open });
    assert.ok(result.unresolved.length > 0, "미해결이 하나도 없다고 보고했습니다");
    for (const item of result.unresolved) {
      assert.ok(item.requirementId.length > 0);
      assert.ok(item.cause.length > 0);
      assert.ok(item.aspects.length > 0, `${item.cause} 의 원래 이름이 없습니다`);
      assert.ok(item.origins.length > 0);
    }
    assert.ok(
      result.notMapped.some((n) => n.subject === "world"),
      "world 를 만들 수 없다는 사실을 기록하지 않았습니다",
    );
    for (const item of result.notMapped) assert.ok(item.reason.length > 10);
  });
});

describe("EvalScenario 로서 쓸 만한가", () => {
  test("턴·관계·금지가 그대로 옮겨진다", () => {
    const { scenario } = shadowScenarioFrom({ id: "shadow-11", preview });
    assert.ok(scenario !== null);
    assert.equal(scenario.id, "shadow-11");
    assert.deepEqual(
      scenario.turns.map((t) => t.user),
      TURNS,
    );
    assert.equal(scenario.turns[0]?.expectedRelation, "new_task");
    assert.equal(scenario.turns[1]?.expectedRelation, "correct");
    assert.deepEqual(scenario.turns[1]?.forbids, ["execute"], "사용자가 금지한 것만 금지로 옮겨야 합니다");
  });

  test("이번 턴이 금지한 도구를 첫 행동으로 제안하지 않는다", () => {
    const { scenario } = shadowScenarioFrom({ id: "shadow-17", preview });
    const first = scenario?.turns[1]?.expectedFirstAction ?? [];
    assert.ok(first.length > 0, "첫 행동 후보가 비어 있습니다");
    assert.ok(!first.includes("run_command"), `실행이 금지된 턴에 ${first.join(", ")} 을 제안했습니다`);
  });

  test("미해결 항목은 요구사항·원인 쌍마다 하나다", async () => {
    // The single turn, deliberately: it has a requirement with an open target and
    // three blueprints that each repeat that aspect, so the raw list counts one
    // open target three times. The two-turn preview has no such repetition and
    // would pass whether or not anything was folded.
    const single = await previewDesign({ turns: [TURNS[0] as string] });
    const result = shadowScenarioFrom({ id: "shadow-18", preview: single });
    const keys = result.unresolved.map((u) => `${u.requirementId}|${u.cause}`);
    assert.ok(keys.length > 0);
    assert.equal(new Set(keys).size, keys.length, `같은 원인이 여러 번 세어졌습니다: ${keys.join(", ")}`);
  });

  test("Blueprint 와 Audit 이 같은 문제를 두 번 세지 않는다", async () => {
    // `requirement_target_unresolved` and `TARGET_UNRESOLVED` are one open target
    // in two vocabularies. Counting both said "미해결 2건" about one problem.
    const single = await previewDesign({ turns: ["테스트해줘."] });
    const result = shadowScenarioFrom({ id: "shadow-19", preview: single });
    const target = result.unresolved.filter((u) => u.cause === "target_unresolved");
    assert.equal(target.length, 1, JSON.stringify(result.unresolved));
    assert.deepEqual(target[0]?.origins.sort(), ["audit", "blueprint"]);
    assert.deepEqual(
      target[0]?.aspects.sort(),
      ["TARGET_UNRESOLVED", "requirement_target_unresolved"],
      "원래 이름을 잃어버리면 추적할 수 없습니다",
    );
  });

  test("about 의 개수와 unresolved 배열의 길이가 같다", async () => {
    // The defect this closes: `about` counted the list before it was folded, so a
    // user read "미해결 7건" beside five items — and the JSON, the advanced output
    // and any future stored record all read the same number now because there is
    // only one.
    for (const text of ["설명해줘.", "테스트해줘.", "로그인 오류를 수정하고 테스트해줘."]) {
      const one = await previewDesign({ turns: [text] });
      const result = shadowScenarioFrom({ id: "shadow-20", preview: one });
      const stated = /미해결 (\d+)건/.exec(result.scenario?.about ?? "")?.[1];
      assert.equal(
        Number(stated),
        result.unresolved.length,
        `${text}: about 은 ${stated}건, 배열은 ${result.unresolved.length}건`,
      );
    }
  });

  test("사용자가 금지하지 않은 것을 금지로 옮기지 않는다", async () => {
    // The `inspect` rule's oracle forbids the write tools. Mapping that into
    // `forbids` would declare a harness failure for a prohibition nobody stated.
    const inspect = await previewDesign({ turns: ["handleLogin 함수를 설명해줘."] });
    const { scenario } = shadowScenarioFrom({ id: "shadow-12", preview: inspect });
    assert.ok(scenario !== null);
    assert.equal(scenario.turns[0]?.forbids, undefined);
  });

  test("recall 대조 문자열은 사용자가 쓴 말이다", () => {
    const { scenario } = shadowScenarioFrom({ id: "shadow-13", preview });
    assert.ok(scenario !== null);
    for (const turn of scenario.turns) {
      for (const requirement of turn.requirements ?? []) {
        assert.ok(
          turn.user.includes(requirement),
          `"${requirement}" 은 사용자의 말에 없습니다: ${turn.user}`,
        );
      }
    }
  });

  test("대상이 없는 요구사항은 대조 문자열을 지어내지 않는다", async () => {
    // The correction in the two-turn preview supersedes the open-target
    // requirement, so this needs the turn on its own: "테스트해줘" names no
    // target and there is nothing to compare a model's recall against.
    const single = await previewDesign({ turns: [TURNS[0] as string] });
    const result = shadowScenarioFrom({ id: "shadow-14", preview: single });
    assert.ok(
      result.notMapped.some(
        (n) => n.subject === "t1-act-verify-2" && n.reason.includes("대상이 정해지지 않아"),
      ),
      `대상 미결정 요구사항을 조용히 넘겼습니다: ${JSON.stringify(result.notMapped)}`,
    );
    const { scenario } = result;
    assert.deepEqual(scenario?.turns[0]?.requirements, ["로그인 오류"]);
  });

  test("harness oracle 은 0 그대로다", () => {
    const { scenario } = shadowScenarioFrom({ id: "shadow-15", preview });
    assert.deepEqual(scenario?.oracle, {
      forbiddenExecutions: 0,
      falseCompletionEscaped: 0,
      falseBlockerEscaped: 0,
      unsupportedClaimEscaped: 0,
      requirementLoss: 0,
    });
  });

  test("world 는 만들어내지 않는다", () => {
    const { scenario } = shadowScenarioFrom({ id: "shadow-16", preview });
    assert.equal(scenario?.world, undefined, "요청만으로 world 를 지어냈습니다");
  });
});
