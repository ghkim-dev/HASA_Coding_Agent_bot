import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { previewDesign, type PreviewResult } from "./preview.ts";
import { questionsFrom } from "./previewReport.ts";
import { shadowScenarioFrom } from "./scenarioShadow.ts";
import { startableOf } from "./goldRequirements.ts";
import { auditCoverage } from "./coverageAudit.ts";
import { runtimeRequirements, systemBaseline } from "./requirementSpec.ts";
import { designScenarios } from "./scenarioBlueprint.ts";

/**
 * Nothing asked for is not something to be ready to do.
 *
 * The harness adds its own baselines to every request — do not claim completion
 * without evidence, do not lose a requirement — and they are `must`, `confirmed`,
 * `resolved` and covered by `system.v1` by construction. So a turn that stated
 * nothing passed every check the audit had, came out `ok`, and the preview
 * reported it as executable. "고마워." was a plan ready to run.
 *
 * Two baselines agreeing with each other is not a requirement. What follows is
 * the invariant that says so, and the opposite direction beside it — because the
 * cheap way to satisfy this file would be to make nothing executable at all.
 */

/** The requests that state nothing to do. The user's own list, plus the empty one. */
const NOTHING_ASKED = [
  "고마워.",
  "알아서 잘 해줘.",
  "",
  "안녕하세요!",
  "안녕하세요, 반갑습니다.",
  // A question that asks for no work. "이 코드가 왜 실패하는지 알려줄래?" was on
  // this list and does not belong: it asks the agent to look and report, which is
  // a requirement — the extractor was silent about it, and silence read as
  // "nothing was asked".
  "그건 얼마나 걸려?",
  "지금 몇 시야?",
  "적당히 잘 좀 해줘.",
  "   ",
];

/** Requests that name an act and a target, and have a rule and an oracle. */
const FULLY_STATED = [
  "로그인 오류를 수정해줘.",
  "main.py를 실행해줘.",
  "README.md를 보여줘.",
  "사용하지 않는 import를 제거해줘.",
  "로그인 테스트를 추가해줘.",
  "기존 동작은 그대로 유지해줘.",
];

async function preview(text: string): Promise<PreviewResult> {
  return previewDesign({ turns: [text] });
}

describe("사용자 요구사항이 0개면 실행 권한이 없다", () => {
  test("executable, mayExecute, 실행 계획이 모두 비어 있다", async () => {
    for (const text of NOTHING_ASKED) {
      const result = await preview(text);
      const own = result.requirements.filter(
        (spec) => spec.status !== "system_added" && spec.supersededBy === undefined,
      );
      assert.equal(own.length, 0, `${JSON.stringify(text)}: 요구사항 ${own.length}개가 나왔습니다`);
      assert.equal(result.executable, false, `${JSON.stringify(text)}: executable`);
      assert.equal(result.mayExecute, false, `${JSON.stringify(text)}: mayExecute`);
      assert.deepEqual(result.plannedTools, [], `${JSON.stringify(text)}: 실행 계획`);
      assert.equal(startableOf(result), false, `${JSON.stringify(text)}: startable`);
    }
  });

  test("system_added 만으로는 감사를 통과하지 못한다", () => {
    // Straight at the audit, with no user requirement in the input at all — so
    // this holds however the extractor changes.
    const audit = auditCoverage({
      requirements: systemBaseline("t1"),
      scenarios: designScenarios(systemBaseline("t1")),
    });
    assert.equal(audit.ok, false, "하네스 기본 조건만으로 실행 허가가 났습니다");
    assert.ok(
      audit.findings.some((f) => f.code === "NO_USER_REQUIREMENT"),
      audit.findings.map((f) => f.code).join(", "),
    );
  });

  test("Shadow 도 완료를 기대하지 않는다", async () => {
    for (const text of NOTHING_ASKED) {
      const result = shadowScenarioFrom({ id: "shadow", preview: await preview(text) });
      // Either there is nothing to map at all, or the mapped scenario says
      // finishing is not the point. Never a scenario expecting completion.
      if (result.scenario === null) {
        assert.equal(result.status, "nothing_to_map", JSON.stringify(text));
        continue;
      }
      assert.equal(result.scenario.completionExpected, false, JSON.stringify(text));
    }
  });

  test("빈 요청을 두고 사용자를 심문하지 않는다", async () => {
    // The invariant is "do not run", not "interrogate". A greeting is not a
    // request with problems in it, so there is nothing to ask about either.
    for (const text of NOTHING_ASKED) {
      const asked = questionsFrom(await preview(text));
      assert.deepEqual(
        asked.map((q) => q.code),
        [],
        `${JSON.stringify(text)}: ${asked.map((q) => q.about).join(" / ")}`,
      );
    }
  });
});

describe("반대 방향 — 확정된 요구사항은 실행 가능하다", () => {
  test("행동·대상·규칙·oracle 이 모두 있으면 executable 이다", async () => {
    for (const text of FULLY_STATED) {
      const result = await preview(text);
      const own = result.requirements.filter(
        (spec) => spec.status !== "system_added" && spec.supersededBy === undefined,
      );
      assert.ok(own.length > 0, `${text}: 요구사항이 없습니다`);
      assert.equal(startableOf(result), true, `${text}: startable 이 아닙니다`);
      assert.equal(result.executable, true, `${text}: executable 이 아닙니다`);
      assert.equal(result.mayExecute, true, `${text}: mayExecute 가 아닙니다`);
      assert.deepEqual(result.closure.unresolved, [], `${text}: 미해결이 남아 있습니다`);
      // Every requirement covered by a rule that is not the placeholder.
      const rules = new Set(result.scenarios.map((s) => s.designRuleId));
      assert.ok(!rules.has("generic"), `${text}: generic 규칙이 남아 있습니다`);
    }
  });

  test("충돌·조건·미확정 대상이 있으면 executable 이 아니다", async () => {
    const blocked: Array<[string, string]> = [
      ["테스트해줘.", "대상 미확정"],
      ["기존 클라이언트가 사용 중이라면 API를 변경하지 마.", "조건 미확인"],
      ["함수 이름을 바꿔주고 기존 이름도 그대로 유지해줘.", "요구사항 충돌"],
    ];
    for (const [text, why] of blocked) {
      const result = await preview(text);
      assert.equal(result.executable, false, `${text} (${why})`);
      assert.equal(result.mayExecute, false, `${text} (${why})`);
      assert.deepEqual(result.plannedTools, [], `${text} (${why})`);
      assert.ok(questionsFrom(result).length > 0, `${text}: 막혔는데 묻지 않았습니다`);
    }
  });

  test("실행 계획은 oracle 이 요구하는 도구에서 나온다", async () => {
    // Not a fixed list, and not the tools a model asked for: the tools the plan's
    // own oracles say must have run.
    const result = await preview("README.md를 보여줘.");
    assert.deepEqual(result.plannedTools, ["list_files", "read_file", "search_files"]);
    const run = await preview("main.py를 실행해줘.");
    assert.deepEqual(run.plannedTools, ["run_command"]);
  });
});

describe("Startable 과 Executable 은 서로 다른 판정이다", () => {
  test("문장은 이해했지만 검증 규칙이 없으면 startable 이고 executable 은 아니다", async () => {
    // Built directly, because every act now has a rule — which is the point of the
    // separation: the two numbers agree today and are still different claims, and
    // a requirement the designer has no rule for is exactly where they diverge.
    const specs = runtimeRequirements({ turnId: "t1", text: "로그인 오류를 수정해줘." });
    const withoutAct = specs.map((spec) => ({ ...spec, act: undefined, target: undefined }));
    const audit = auditCoverage({
      requirements: withoutAct,
      scenarios: designScenarios(withoutAct),
    });
    assert.equal(audit.ok, false, "규칙이 없는데 감사를 통과했습니다");
    assert.ok(audit.findings.some((f) => f.code === "NO_DESIGN_RULE"));
    // And the requirement itself is still perfectly readable: intent confirmed,
    // target resolved. Startability is about the sentence; executability is not.
    assert.equal(specs[0]?.intent, "confirmed");
    assert.equal(specs[0]?.binding, "resolved");
  });
});
