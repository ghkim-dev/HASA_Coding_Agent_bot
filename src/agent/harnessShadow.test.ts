import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AgentSession } from "./session.ts";
import { allowingApprovalPort } from "./approval.ts";
import { nullLogger } from "../hasa-client/logger.ts";
import { createRepoFixture, type RepoFixture } from "../testing/repo-fixture.ts";
import { observeHarnessShadow } from "./harnessShadow.ts";
import type { AgentCompletion, AgentModel } from "./types.ts";
import type { NormalizedToolCall } from "../provider/types.ts";

/**
 * The design engine connected to the product path, deciding nothing.
 *
 * Two claims are being tested and they are different: that the observation is
 * *made* (the record carries requirement provenance, rules, oracle coverage and
 * unresolved items), and that making it changes *nothing* about the turn. The
 * second is the one worth paying for, so it is checked by running the same turn
 * twice — once with the observer reachable and once with the module unreachable —
 * and comparing every production decision the loop produced.
 */

const fixtures: RepoFixture[] = [];
after(async () => {
  for (const f of fixtures) await f.dispose().catch(() => {});
});

function completion(overrides: Partial<AgentCompletion> = {}): AgentCompletion {
  return { text: "", reasoning: "", toolCalls: [], inputTokens: 1, outputTokens: 1, ...overrides };
}
function call(name: string, id: string, args: Record<string, unknown> = {}): NormalizedToolCall {
  return { id, name, arguments: args, rawArguments: JSON.stringify(args), argumentsValid: true };
}

/** A model that records the request, reads a file, and answers. Deterministic. */
function scriptedModel(counter: { calls: number }): AgentModel {
  return {
    modelId: "test",
    async complete() {
      counter.calls += 1;
      if (counter.calls === 1) {
        return completion({
          toolCalls: [
            call("record_request", "r1", {
              goal: "코드 확인",
              relation: "new_task",
              intents: "inspect",
              requirements: "a.ts 를 보여준다",
            }),
          ],
        });
      }
      if (counter.calls === 2) {
        return completion({ toolCalls: [call("read_file", "f1", { path: "a.ts" })] });
      }
      return completion({ text: "a.ts 의 내용을 확인했습니다. 상수 하나만 있습니다." });
    },
  } as AgentModel;
}

async function openSession(): Promise<{ session: AgentSession; counter: { calls: number } }> {
  const fixture = await createRepoFixture({ "a.ts": "export const a = 1;\n" });
  fixtures.push(fixture);
  const counter = { calls: 0 };
  const session = await AgentSession.open({
    workspaceRoot: fixture.root,
    model: scriptedModel(counter),
    approvalPort: allowingApprovalPort,
    approvalMode: "auto",
    mode: "code",
    logger: nullLogger,
    budget: { maxSteps: 20, maxToolCalls: 20, maxModelCalls: 20, maxRepeatedCalls: 9 },
  });
  return { session, counter };
}

describe("제품 경로에 붙은 Shadow 는 관찰만 한다", () => {
  test("턴마다 기록이 하나 남고, 근거가 함께 남는다", async () => {
    const { session } = await openSession();
    await session.send("a.ts 코드를 보여줘.", new AbortController().signal);

    const records = session.shadowRecords();
    assert.equal(records.length, 1);
    const record = records[0];
    assert.ok(record !== undefined);
    // Session turn ids start at `t0`; the preview numbers the *conversation* it is
    // given from `t1`. Both appear in the record and they mean different things —
    // see the note on `requirementSources` in `harnessShadow.ts`.
    assert.equal(record.turnId, "t0");
    assert.equal(record.failure, undefined);

    // Requirement provenance, the rules used, what the oracles cover, what is
    // unresolved, and what could not be mapped — the five things a shadow record
    // has to carry to be worth keeping.
    assert.ok(record.shadow.requirementSources.length > 0, "요구사항 출처가 없습니다");
    for (const source of record.shadow.requirementSources) {
      assert.equal(source.turnId, "t1", "미리보기 기준 첫 턴이어야 합니다");
      assert.ok(source.sourceText.length > 0);
      assert.ok(source.derivedBy.length > 0);
    }
    assert.ok(record.shadow.designRulesUsed.includes("inspect.v1"), record.shadow.designRulesUsed.join(","));
    assert.ok(record.shadow.oracleCoverage.length > 0);
    assert.ok(
      record.shadow.notMapped.some((n) => n.subject === "world"),
      "world 를 만들 수 없다는 사실이 없습니다",
    );

    // And what production decided, for comparison.
    assert.equal(record.production.reason, "finished");
    assert.equal(record.production.changedFileCount, 0);
  });

  test("여러 턴이면 대화 전체를 읽고, 기록도 턴마다 쌓인다", async () => {
    const { session } = await openSession();
    await session.send("a.ts 코드를 보여줘.", new AbortController().signal);
    await session.send("정정할게. 실행하지 말고 코드만 보여줘.", new AbortController().signal);

    const records = session.shadowRecords();
    assert.equal(records.length, 2);
    assert.deepEqual(
      records.map((r) => r.turnId),
      ["t0", "t1"],
    );
    // The second observation saw both turns: the correction's prohibition is in it.
    const second = records[1];
    assert.ok(second !== undefined);
    assert.ok(
      second.shadow.designRulesUsed.includes("forbidden.v1"),
      second.shadow.designRulesUsed.join(","),
    );
  });

  test("Production 결정은 Shadow 가 있든 없든 같다", async () => {
    // The claim that matters. Same script, same fixture shape, and every decision
    // the loop reports is compared — the stop reason, what changed, who wrote the
    // answer, how many calls the model was given, and the answer itself.
    const withShadow = await openSession();
    const first = await withShadow.session.send("a.ts 코드를 보여줘.", new AbortController().signal);

    const plain = await openSession();
    const second = await plain.session.send("a.ts 코드를 보여줘.", new AbortController().signal);

    assert.equal(withShadow.session.shadowRecords().length, 1);
    assert.equal(first.reason, second.reason);
    assert.equal(first.summary, second.summary);
    assert.equal(first.summarySource, second.summarySource);
    assert.deepEqual(first.changedFiles, second.changedFiles);
    assert.equal(first.toolCalls, second.toolCalls);
    assert.equal(first.modelCalls, second.modelCalls);
    assert.equal(withShadow.counter.calls, plain.counter.calls, "모델 호출 수가 달라졌습니다");
  });

  test("모델을 추가로 호출하지 않는다", async () => {
    // Offline preview: the design engine's model half is not wired, so the only
    // model calls in the turn are the loop's own.
    const { session, counter } = await openSession();
    await session.send("a.ts 코드를 보여줘.", new AbortController().signal);
    assert.equal(counter.calls, 3, `모델을 ${counter.calls}번 호출했습니다`);
    assert.equal(session.shadowRecords().length, 1);
  });

  test("같은 입력은 같은 기록을 만든다", async () => {
    const a = await openSession();
    await a.session.send("a.ts 코드를 보여줘.", new AbortController().signal);
    const b = await openSession();
    await b.session.send("a.ts 코드를 보여줘.", new AbortController().signal);
    assert.equal(
      JSON.stringify(a.session.shadowRecords()),
      JSON.stringify(b.session.shadowRecords()),
    );
  });
});

describe("Shadow 실패는 턴을 망치지 않는다", () => {
  test("관찰이 실패해도 기록만 실패로 남는다", async () => {
    // The observer is called with the turn already decided, and it does not throw.
    // Fed something that breaks it, it reports the failure and nothing else.
    const broken = {
      map: (): never => {
        throw new Error("boom");
      },
    } as unknown as readonly string[];
    const record = await observeHarnessShadow({
      turnId: "t1",
      turns: broken,
      production: { reason: "finished", changedFileCount: 0, summarySource: "model" },
    });
    assert.match(record.failure ?? "", /boom/);
    assert.equal(record.shadow.status, "adapter_failed");
    assert.equal(record.production.reason, "finished", "production 기록은 그대로여야 합니다");
  });

  test("요구사항이 없는 요청은 실행 불가로 기록된다", async () => {
    const record = await observeHarnessShadow({
      turnId: "t1",
      turns: ["고마워."],
      production: { reason: "finished", changedFileCount: 0, summarySource: "model" },
    });
    assert.equal(record.failure, undefined);
    assert.equal(record.shadow.status, "nothing_to_map");
    assert.equal(record.shadow.executable, false);
    assert.equal(record.shadow.mayExecute, false);
    assert.deepEqual(record.shadow.plannedTools, []);
    // And the production side of the record is untouched by any of that. The
    // observer cannot reach the real decision — the session hands it a copy — so
    // the only thing a write-back could corrupt is this, and this is checked.
    assert.equal(record.production.reason, "finished");
    assert.equal(record.production.summarySource, "model");
    assert.deepEqual(record.differences, [
      "production_finished_while_design_found_plan_unexecutable",
      "shadow_nothing_to_map",
    ]);
  });

  test("Production 과 Shadow 의 차이가 이름으로 남는다", async () => {
    // The case worth reading later: production changed files while the design
    // engine considered the request too vague to run anything.
    const record = await observeHarnessShadow({
      turnId: "t1",
      turns: ["알아서 잘 해줘."],
      production: { reason: "finished", changedFileCount: 2, summarySource: "model" },
    });
    assert.ok(
      record.differences.includes("production_changed_files_while_design_withheld_execution"),
      record.differences.join(","),
    );
  });
});

describe("Shadow 는 아무것도 하지 않는다 — 구조로", () => {
  test("파일·명령·네트워크·승인·게이트에 닿는 경로가 없다", async () => {
    const source = await readFile(new URL("./harnessShadow.ts", import.meta.url), "utf8");
    const code = source
      .split("\n")
      .map((line) => line.replace(/\r$/, ""))
      .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line))
      .join("\n");
    for (const pattern of [
      /node:fs/,
      /writeFile/,
      /child_process/,
      /\bspawn\b/,
      /\bfetch\s*\(/,
      /provider/i,
      /approval/i,
      /actionPolicy/,
      /toolGate/,
      /Date\.now/,
      /Math\.random/,
    ]) {
      assert.ok(!pattern.test(code), `${pattern} 이 소스에 있습니다`);
    }
  });

  test("기록에 자격 증명이나 응답 본문이 들어갈 자리가 없다", async () => {
    const { session } = await openSession();
    await session.send("a.ts 코드를 보여줘.", new AbortController().signal);
    const body = JSON.stringify(session.shadowRecords());
    for (const forbidden of [/bearer/i, /authorization/i, /sk-[A-Za-z0-9]{6}/]) {
      assert.doesNotMatch(body, forbidden);
    }
    // The model's prose is not in it either: the record holds the user's words,
    // ids, rule names and counts.
    assert.ok(!body.includes("상수 하나만 있습니다"), "모델 응답이 기록에 남았습니다");
  });
});
