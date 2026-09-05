import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { previewDesign, relationOf, type Proposer } from "./preview.ts";
import { questionsFrom, renderAdvanced, renderJson, renderReport } from "./previewReport.ts";
import { MAX_CALLS } from "./modelProposer.ts";
import { parseProposals } from "./proposalParse.ts";
import { measurePreviews, renderMetrics } from "./previewMetrics.ts";
import { spansOf } from "./sourceSpan.ts";

/**
 * The preview, and the promises it makes.
 *
 * Two of them carry the weight. Nothing is executed — no file is written, no
 * command runs — and nothing a model says decides anything. Both are asserted
 * by behaviour rather than by inspection, because a preview that quietly did
 * something would look identical from the outside.
 */

const FIXTURES = "examples/design-preview";

/**
 * before() 는 던지지 않는다.
 *
 * `node --test` 는 before() 훅이 throw 하면 그 아래 테스트를 실행하지 않고
 * **cancelled** 로 처리하는데, 요약줄은 그것을 `fail 0` 으로 찍는다. 실제로
 * 재어 보았다 — 말뭉치를 만드는 훅 하나를 일부러 터뜨리자 이 파일의 테스트
 * 148개가 실행되지 않았고, 요약은 `fail 0 / cancelled 148` 이었다. 요약줄만
 * 보는 사람에게 그것은 초록이다. 즉 `fail 0` 이 거짓말을 한다.
 *
 * 사례별로 갈라 놓은 입도가 통째로 훅 하나에 매달려 있으므로, 말뭉치를 만드는
 * 훅은 오류를 던지지 않고 `buildError` 에 적어 둔다. 그 describe 의 첫 test 가
 * 말뭉치가 만들어졌다는 것을 주장하고, 나머지 test 들은 빈 맵을 읽어 각자 자기
 * 이름으로 실패한다. 취소 148 · 실패 0 보다, 취소 0 · 이름을 가진 실패 148 이
 * 낫다 — 뒤쪽만이 어디가 깨졌는지 말한다.
 */
function errorText(err: unknown): string {
  if (err === null) return "(오류 없음)";
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/**
 * A model that answers exactly what a test wants, without a gateway.
 *
 * The raw string goes through the real parser. A helper that handed back a
 * hand-written outcome would be testing the fixture rather than the code that
 * has to tell an empty answer from a malformed one.
 */
function proposerReturning(raw: string, modelId = "test-model"): Proposer {
  let calls = 0;
  return async ({ turnId }) => {
    calls += 1;
    const parse = parseProposals(raw, turnId);
    return { proposals: parse.proposals, modelId, calls, parse };
  };
}

// --- offline is offline ------------------------------------------------------

describe("offline 모드는 아무것도 밖으로 보내지 않는다", () => {
  test("propose 가 없으면 네트워크 호출 0", async () => {
    const original = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("preview must not reach the network");
    }) as typeof fetch;
    try {
      const result = await previewDesign({ turns: ["실행하지 말고 코드만 보여줘."] });
      assert.equal(fetches, 0);
      assert.equal(result.proposals.source, "offline");
      assert.equal(result.proposals.calls, 0);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("offline 에서도 금지는 읽힌다", async () => {
    const result = await previewDesign({ turns: ["수정도 하지 말고 실행도 하지 마."] });
    const forbidden = result.requirements.filter((s) => s.polarity === "forbidden" && s.status === "explicit");
    assert.equal(forbidden.length, 2);
  });
});

describe("preview 는 아무것도 실행하지 않는다", () => {
  test("파일을 쓰지 않고 명령을 실행하지 않는다", async () => {
    // The two capabilities that would make a preview not a preview. Replaced
    // rather than trusted: an accidental import of a tool module would show up
    // here and nowhere else.
    const fsMod = await import("node:fs/promises");
    const cp = await import("node:child_process");
    const writes: string[] = [];
    const spawns: string[] = [];
    const realWrite = fsMod.default.writeFile;
    const realSpawn = cp.default.spawn;
    (fsMod.default as { writeFile: unknown }).writeFile = ((path: string) => {
      writes.push(String(path));
      throw new Error("preview wrote a file");
    }) as unknown;
    (cp.default as { spawn: unknown }).spawn = ((cmd: string) => {
      spawns.push(cmd);
      throw new Error("preview ran a command");
    }) as unknown;
    try {
      await previewDesign({ turns: ["로그인 오류를 수정하고 테스트해줘."] });
      assert.deepEqual(writes, []);
      assert.deepEqual(spawns, []);
    } finally {
      (fsMod.default as { writeFile: unknown }).writeFile = realWrite;
      (cp.default as { spawn: unknown }).spawn = realSpawn;
    }
  });
});

// --- the model decides nothing ----------------------------------------------

describe("모델은 제안만 한다", () => {
  const TEXT = "실행하지 말고 코드만 설명해줘.";

  test("confirmed 를 보내도 ambiguous 로 남는다", async () => {
    const [span] = spansOf(TEXT, "코드만 설명해줘", "t1");
    const raw = JSON.stringify([
      { text: "코드를 설명한다", start: span!.start, end: span!.end, confidence: "confirmed" },
    ]);
    const result = await previewDesign({ turns: [TEXT], propose: proposerReturning(raw) });
    const fromModel = result.requirements.filter((s) => s.derivedBy === "model_proposal");
    const refused = result.rejected;
    // Either it was refused for over-reaching, or it was accepted as ambiguous.
    // Never confirmed.
    assert.ok(fromModel.every((s) => s.intent === "ambiguous"));
    assert.ok(fromModel.length + refused.length > 0);
  });

  /**
   * sourceText / derivedBy / id / status 를 보내면 위조로 거부된다.
   *
   * 네 필드는 한 test 안에서 한 반복문으로 검사되었다. 첫 필드가 통과하지
   * 못하면 나머지 셋은 아예 검사되지 않았고, 실패는 어느 필드가 뚫렸는지를
   * 이름으로 말하지 못했다. 필드마다 하나씩 세운다.
   */
  describe("권한 필드를 보내면 위조로 거부된다", () => {
    const FORGEABLE = ["sourceText", "derivedBy", "id", "status"];

    test("네 개다", () => {
      // 표에서 한 줄을 지우면 그 필드는 검사되지 않는데 test 수만 하나 줄고
      // 스위트는 초록이다. 개수를 세는 것은 이 줄뿐이다.
      assert.equal(FORGEABLE.length, 4);
    });

    for (const field of FORGEABLE) {
      test(`${field} · forged_provenance 로 거부`, async () => {
        const [span] = spansOf(TEXT, "코드만 설명해줘", "t1");
        const raw = JSON.stringify([
          { text: "코드를 설명한다", start: span!.start, end: span!.end, [field]: "x" },
        ]);
        const result = await previewDesign({ turns: [TEXT], propose: proposerReturning(raw) });
        assert.ok(
          result.rejected.some((r) => r.reasons.includes("forged_provenance")),
          `${field} 가 위조로 거부되지 않았습니다`,
        );
      });
    }
  });

  test("요청에 없는 근거는 거부된다", async () => {
    const raw = JSON.stringify([{ text: "성능을 두 배로 개선한다", start: 0, end: 4 }]);
    const result = await previewDesign({ turns: [TEXT], propose: proposerReturning(raw) });
    assert.equal(result.requirements.filter((s) => s.derivedBy === "model_proposal").length, 0);
    assert.ok(result.rejected.length > 0);
  });
});

describe("모델 응답이 정상이 아닐 때", () => {
  const TEXT = "로그인 오류를 수정해줘.";

  /**
   * malformed / empty 는 offline 결과로 되돌아간다.
   *
   * 다섯 가지 고장난 응답이 한 반복문에 있었다. 첫 응답에서 멈추면 나머지 넷은
   * 검사되지 않으므로, 응답 모양마다 하나씩 세운다.
   */
  describe("malformed / empty 는 offline 결과로 되돌아간다", () => {
    const BROKEN = ["", "not json at all", "[", "{}", "[1,2,3]"];

    test("다섯 개다", () => {
      assert.equal(BROKEN.length, 5);
    });

    for (const raw of BROKEN) {
      const label = raw === "" ? "(빈 문자열)" : raw;
      test(`${label} · offline 결과`, async () => {
        const result = await previewDesign({ turns: [TEXT], propose: proposerReturning(raw) });
        assert.equal(result.proposals.error, null, raw);
        assert.equal(result.requirements.filter((s) => s.derivedBy === "model_proposal").length, 0, raw);
      });
    }
  });

  test("모델 실패는 보고되고 offline 결과는 남는다", async () => {
    const failing: Proposer = async () => {
      throw new Error("gateway 500");
    };
    const result = await previewDesign({
      turns: ["실행하지 말고 보여줘."],
      propose: failing,
    });
    assert.match(result.proposals.error ?? "", /gateway 500/);
    assert.ok(result.requirements.some((s) => s.derivedBy === "runtime_prohibition"));
    assert.match(renderReport(result), /모델에 요구사항 후보를 물어보지 못했습니다/);
  });

  test("abort 는 즉시 멈춘다", async () => {
    const controller = new AbortController();
    controller.abort();
    const aborting: Proposer = async ({ signal, turnId }) => {
      if (signal?.aborted === true) throw new Error("aborted");
      return { proposals: [], modelId: null, calls: 1, parse: parseProposals("", turnId) };
    };
    const result = await previewDesign({
      turns: [TEXT],
      propose: aborting,
      signal: controller.signal,
    });
    assert.match(result.proposals.error ?? "", /aborted/);
  });

  test("호출 상한은 2", () => {
    assert.equal(MAX_CALLS, 2);
  });
});

// --- multi-turn --------------------------------------------------------------

describe("여러 턴", () => {
  /**
   * 관계를 원문에서 읽는다.
   *
   * 다섯 관계가 한 test 에 있었다. `assert.equal` 은 첫 실패에서 멈추므로
   * `new_task` 가 깨지면 나머지 넷은 검사되지도 않았다. 문장마다 하나씩 세운다.
   */
  describe("관계를 원문에서 읽는다", () => {
    test('"main.py를 실행해줘." · 첫 턴 관계 = new_task', () => {
      assert.equal(relationOf("main.py를 실행해줘.", true), "new_task");
    });

    test('"정정할게. 실행하지 말고 코드만 보여줘." · 관계 = correct', () => {
      assert.equal(relationOf("정정할게. 실행하지 말고 코드만 보여줘.", false), "correct");
    });

    test('"이어서 계속해줘." · 관계 = continue', () => {
      assert.equal(relationOf("이어서 계속해줘.", false), "continue");
    });

    test('"이게 무엇인가요?" · 관계 = question', () => {
      assert.equal(relationOf("이게 무엇인가요?", false), "question");
    });

    test('"추가로 테스트도 해줘." · 관계 = refine', () => {
      assert.equal(relationOf("추가로 테스트도 해줘.", false), "refine");
    });
  });

  /**
   * 사람이 실제로 쓰는 이어감·정정 표현.
   *
   * 위 다섯 줄은 각 관계를 한 번씩만 보여 주고, 그 한 번은 패턴이 이미 아는
   * 표현이었다. 미디어 프로젝트를 다듬는 대화를 상정해 16문장을 적어 보니
   * 6개가 틀렸고, 그중 넷은 "계속 진행해줘" 처럼 띄어쓰기 하나 때문이었다.
   *
   * `harnessDesign` 이 이 함수에게 "이 턴은 어떤 모양의 일인가" 를 묻기
   * 시작한 뒤로 이것은 대화 밖에서도 지탱한다 — 알아보지 못한 이어감은 읽기
   * 요청으로 라우팅되고, 이어감을 좌우하는 능력은 아무도 요구하지 않게 된다.
   *
   * 그 여섯이 다시 틀릴 때 어느 문장이 틀렸는지 이름이 말하도록, 문장마다
   * 하나씩 세운다.
   */
  describe("이어가자는 말은 여러 가지 모양으로 온다", () => {
    test('"계속 진행해줘." · 관계 = continue', () => {
      assert.equal(relationOf("계속 진행해줘.", false), "continue");
    });

    test('"하던 거 마저 해줘." · 관계 = continue', () => {
      assert.equal(relationOf("하던 거 마저 해줘.", false), "continue");
    });

    test('"Keep going." · 관계 = continue', () => {
      assert.equal(relationOf("Keep going.", false), "continue");
    });

    test('"Carry on with the render." · 관계 = continue', () => {
      assert.equal(relationOf("Carry on with the render.", false), "continue");
    });

    // 문두의 `다시` 만 이어감이다. 문장 가운데의 `다시` 는 그 문장이 말하는
    // 행위를 꾸미므로, 제 행위를 부르는 요청이 된다.
    test('"다시 해줘." · 관계 = continue', () => {
      assert.equal(relationOf("다시 해줘.", false), "continue");
    });

    test('"로그를 다시 확인해줘." · 관계 = refine', () => {
      assert.equal(relationOf("로그를 다시 확인해줘.", false), "refine");
    });

    test('"실패하면 다시 시도하게 해줘." · 관계 = refine', () => {
      assert.equal(relationOf("실패하면 다시 시도하게 해줘.", false), "refine");
    });
  });

  describe("앞 턴을 가리키며 무시하라는 말은 정정이다", () => {
    test('"방금 건 무시하고 처음 요청대로 해줘." · 관계 = correct', () => {
      assert.equal(relationOf("방금 건 무시하고 처음 요청대로 해줘.", false), "correct");
    });

    test('"Ignore what I just said and use the original prompt." · 관계 = correct', () => {
      assert.equal(relationOf("Ignore what I just said and use the original prompt.", false), "correct");
    });

    // 경고를 무시하는 것은 요청을 물리는 것이 아니다. 앞 턴을 가리키는 낱말이
    // 없으면 정정이 아니다.
    test('"경고는 무시하고 진행해줘." · 관계 = refine', () => {
      assert.equal(relationOf("경고는 무시하고 진행해줘.", false), "refine");
    });
  });

  describe("답을 찾아 달라는 물음은 물음이 아니라 요청이다", () => {
    // 처음 이 문장을 적었을 때 정답을 `question` 이라고 썼고, 그것이 틀렸다.
    // `question` 은 서 있는 것을 그대로 옮기고 아무것도 더하지 않는 관계다.
    // "어떤 모델이 제일 빠른지 알려줘" 는 에이전트가 나가서 알아내야 하는
    // 일이므로, 물음으로 분류하면 그 일이 통째로 사라진다.
    test('"어떤 모델이 제일 빠른지 알려줘." · 관계 = refine', () => {
      assert.equal(relationOf("어떤 모델이 제일 빠른지 알려줘.", false), "refine");
    });

    // 대화 자체에 대해 묻는 것은 물음이다.
    test('"왜 이렇게 느려?" · 관계 = question', () => {
      assert.equal(relationOf("왜 이렇게 느려?", false), "question");
    });
  });

  test("정정은 이전 요구사항을 지우지 않고 새 금지를 세운다", async () => {
    const result = await previewDesign({
      turns: ["main.py를 실행해줘.", "정정할게. 실행하지 말고 코드만 보여줘."],
    });
    assert.equal(result.turns[1]?.relation, "correct");
    const forbidden = result.requirements.filter(
      (s) => s.polarity === "forbidden" && s.supersededBy === undefined,
    );
    assert.ok(forbidden.length > 0, "정정 후 금지가 서지 않았습니다");
  });

  /**
   * question 과 continue 는 요구사항을 만들지 않는다.
   *
   * 두 후속 턴이 한 반복문에 있었다. 갈라 놓되 preview 는 늘리지 않는다 —
   * 기준 하나와 후속 둘, 모두 before() 에서 한 번씩만 돈다.
   */
  describe("question 과 continue 는 요구사항을 만들지 않는다", () => {
    const FOLLOWS = ["이게 무엇인가요?", "이어서 계속해줘."];
    // `liveAfter.size === FOLLOWS.length` 는 양변이 같은 상수에서 나오는
    // 항등식이라 표가 줄어든 것을 잡지 못한다. 개수는 여기서 센다.
    const FOLLOW_COUNT = 2;
    const liveAfter = new Map<string, number>();
    let baseLive = -1;
    let buildError: unknown = null;

    before(async () => {
      try {
        const live = (r: Awaited<ReturnType<typeof previewDesign>>): number =>
          r.requirements.filter((s) => s.supersededBy === undefined).length;
        baseLive = live(await previewDesign({ turns: ["실행하지 말고 보여줘."] }));
        for (const follow of FOLLOWS) {
          liveAfter.set(follow, live(await previewDesign({ turns: ["실행하지 말고 보여줘.", follow] })));
        }
      } catch (err) {
        buildError = err;
      }
    });

    // 훅이 던지지 않으므로 빌드가 깨진 것을 실패로 만드는 것은 이 test 다.
    // 아래 후속 test 들은 준비되지 않은 맵을 읽고 각자 자기 이름으로 실패한다.
    test("기준과 후속 preview 가 준비되었다", () => {
      assert.equal(buildError, null, `preview 를 준비하지 못했습니다: ${errorText(buildError)}`);
      assert.ok(baseLive >= 0, "기준 preview 가 돌지 않았습니다");
      assert.equal(FOLLOWS.length, FOLLOW_COUNT, "후속 표에서 줄이 사라졌습니다");
      assert.equal(
        liveAfter.size,
        FOLLOWS.length,
        `후속 ${FOLLOWS.length} 개 중 ${liveAfter.size} 개만 준비되었습니다`,
      );
    });

    for (const follow of FOLLOWS) {
      test(`"${follow}" · 살아 있는 요구사항 수는 그대로`, () => {
        assert.equal(liveAfter.get(follow), baseLive, follow);
      });
    }
  });
});

// --- span conventions --------------------------------------------------------

describe("span 규약", () => {
  test("이모지가 있어도 좌표가 맞는다", async () => {
    const TEXT = "🚀 실행하지 말고 코드만 분석해줘.";
    const result = await previewDesign({ turns: [TEXT] });
    for (const spec of result.requirements) {
      if (spec.span === undefined) continue;
      assert.equal(TEXT.slice(spec.span.start, spec.span.end).trim(), spec.sourceText);
    }
  });
});

// --- output ------------------------------------------------------------------

describe("사용자용 출력", () => {
  test("내부 용어가 새어 나오지 않는다", async () => {
    const result = await previewDesign({
      turns: ["기존 클라이언트가 사용 중이라면 API 형식을 변경하지 마."],
    });
    const report = renderReport(result);
    const leaks = [
      "designRuleId",
      "MUST_WITHOUT_SCENARIO",
      "UNRESOLVED_CONDITION",
      "runtime_prohibition",
      "model_proposal",
      "system_added",
      "ambiguous",
      "forbidden",
      "oracleCoverage",
      "sourceSpan",
      "generic",
    ];
    // 열한 개다. 이 목록에서 한 줄을 지우면 그 낱말은 다시 새어 나가도 되는데
    // test 수조차 줄지 않는다 — 반복문이 한 test 안에 있기 때문이다. 여기서
    // 세는 것이 그 유일한 방어선이다.
    assert.equal(leaks.length, 11);
    for (const term of leaks) {
      assert.ok(!report.includes(term), `사용자용 출력에 ${term} 이(가) 있습니다`);
    }
  });

  test("advanced 에는 내부 용어가 있다", async () => {
    const result = await previewDesign({ turns: ["실행하지 말고 보여줘."] });
    const advanced = renderAdvanced(result);
    assert.match(advanced, /designRuleId|forbidden\.v1/);
    assert.match(advanced, /runtime_prohibition/);
  });

  test("확인이 필요한 내용이 질문 문장으로 나온다", async () => {
    const result = await previewDesign({
      turns: ["기존 클라이언트가 사용 중이라면 API 형식을 변경하지 마."],
    });
    const questions = questionsFrom(result);
    assert.ok(questions.length > 0);
    for (const q of questions) {
      assert.ok(q.options.length >= 2, "선택지가 하나뿐이면 사실상 골라준 것입니다");
      assert.ok(q.about.length > 0);
    }
    assert.match(renderReport(result), /확인이 필요한 내용/);
  });

  test("모호하거나 충돌하면 실행 가능으로 표시하지 않는다", async () => {
    const result = await previewDesign({
      turns: ["기존 클라이언트가 사용 중이라면 API 형식을 변경하지 마."],
    });
    assert.equal(result.executable, false);
    assert.ok(!renderReport(result).includes("검증 계획을 만들었습니다."));
  });
});

describe("JSON 추적", () => {
  test("턴에서 finding 까지 사슬이 끊기지 않는다", async () => {
    const result = await previewDesign({ turns: ["실행하지 말고 코드만 보여줘."] });
    const json = renderJson(result) as {
      turns: Array<{ turnId: string }>;
      requirements: Array<{
        id: string;
        sourceTurnId: string;
        sourceSpan: { turnId: string; start: number; end: number } | null;
        blueprintIds: string[];
      }>;
      scenarios: Array<{ id: string; requirementIds: string[]; oracleCoverage: string[] }>;
      finalAudit: { findings: Array<{ subject: string }> };
      closure: { history: unknown[] };
    };

    const turnIds = new Set(json.turns.map((t) => t.turnId));
    const scenarioIds = new Set(json.scenarios.map((s) => s.id));
    const requirementIds = new Set(json.requirements.map((r) => r.id));

    for (const req of json.requirements) {
      if (req.sourceSpan !== null) {
        assert.ok(turnIds.has(req.sourceSpan.turnId), `${req.id} 의 span 이 턴을 가리키지 않습니다`);
      }
      assert.ok(turnIds.has(req.sourceTurnId) || req.sourceTurnId.length > 0);
      for (const id of req.blueprintIds) {
        assert.ok(scenarioIds.has(id), `${req.id} → ${id} 가 시나리오에 없습니다`);
      }
    }
    for (const scenario of json.scenarios) {
      for (const id of scenario.requirementIds) {
        assert.ok(requirementIds.has(id), `${scenario.id} → ${id} 가 요구사항에 없습니다`);
      }
    }
    assert.ok(Array.isArray(json.closure.history));
  });

  test("같은 입력은 같은 출력을 낸다", async () => {
    const a = await previewDesign({ turns: ["실행하지 말고 보여줘.", "추가로 테스트도 해줘."] });
    const b = await previewDesign({ turns: ["실행하지 말고 보여줘.", "추가로 테스트도 해줘."] });
    assert.deepEqual(JSON.stringify(renderJson(a)), JSON.stringify(renderJson(b)));
  });
});

// --- secrets -----------------------------------------------------------------

describe("자격 증명은 어디에도 나타나지 않는다", () => {
  test("보고서·advanced·JSON 어디에도 없다", async () => {
    const key = process.env["HASA_API_KEY"] ?? "";
    const result = await previewDesign({ turns: ["실행하지 말고 보여줘."] });
    const all = [renderReport(result), renderAdvanced(result), JSON.stringify(renderJson(result))].join("\n");
    if (key.length > 0) assert.ok(!all.includes(key));
    assert.ok(!/bearer/i.test(all));
    assert.ok(!/authorization/i.test(all));
  });
});

// --- the fifteen -------------------------------------------------------------

/** What a fixture claims about the preview of its turns. */
interface FixtureExpect {
  mustContainKinds?: string[];
  forbiddenActions?: string[];
  maxQuestions?: number;
  minQuestions?: number;
  mustNotInvent?: string[];
  /** Questions this request makes it right to ask. */
  requiredQuestionCodes?: string[];
  /** Questions this request must never produce. */
  forbiddenQuestionCodes?: string[];
  /** The exact set of requirements asked about. Pins the count too. */
  exactQuestionSubjects?: string[];
  /** Requirement texts the extractor must produce for this turn. */
  mustContainText?: string[];
}

interface Fixture {
  file: string;
  /** `conditional-compat` — 테스트 이름에 그대로 실린다. */
  id: string;
  turns: string[];
  expect: FixtureExpect;
}

/**
 * 말뭉치 목록은 모듈을 읽을 때 한 번 읽는다.
 *
 * 사례마다 test 를 세우려면 이름을 지을 때 파일과 기대값이 이미 손에 있어야
 * 한다. 여기서 읽는 것은 fixture 의 JSON 뿐이고, preview 는 한 번도 돌지
 * 않는다 — 그건 before() 의 몫이다.
 */
const FIXTURE_FILES = (await readdir(FIXTURES)).filter((f) => f.endsWith(".json")).sort();
const CORPUS: Fixture[] = await Promise.all(
  FIXTURE_FILES.map(async (file): Promise<Fixture> => {
    const parsed = JSON.parse(await readFile(join(FIXTURES, file), "utf8")) as {
      turns: string[];
      expect: FixtureExpect;
    };
    return { file, id: file.replace(/\.json$/u, ""), turns: parsed.turns, expect: parsed.expect };
  }),
);

/** 한 사례를 한 번 돌리고, 축별 테스트가 읽을 조각으로 갈라 둔다. */
async function runCase(turns: string[]) {
  const result = await previewDesign({ turns });
  const live = result.requirements.filter((s) => s.supersededBy === undefined);
  const questions = questionsFrom(result);
  return {
    result,
    live,
    kinds: new Set(live.map((s) => s.kind)),
    forbidden: live.filter((s) => s.polarity === "forbidden" && s.status !== "system_added"),
    texts: live.map((s) => s.text),
    questions,
    codes: new Set(questions.map((q) => q.code)),
  };
}

type CaseView = Awaited<ReturnType<typeof runCase>>;

/**
 * 개인 사용 fixture 16개 — 사례별로, 축별로.
 *
 * 예전에는 반복문 하나가 모든 fixture 의 모든 축을 돌며 실패 문자열을 모아
 * `assert.deepEqual(failures, [])` 로 한 번에 터뜨렸다. 빨간 줄 하나가 "무언가
 * 틀렸다" 만 말했고, 어느 사례의 어느 축인지는 메시지를 읽어야 알 수 있었다.
 * 지금은 fixture 마다, 축마다 test 가 하나씩이라 이름만으로 진단이 된다.
 *
 * 개수 핀은 그대로 남는다. 사례별 test 는 말뭉치에서 파생되므로, 말뭉치가
 * 사례를 잃으면 그 사례의 test 들도 조용히 사라진다 — 사라졌다는 사실을
 * 실패로 만드는 것은 개수 핀뿐이다.
 *
 * previewDesign 은 사례당 한 번, before() 에서만 돈다. 아래 test 들은 그
 * 미리 계산된 결과를 읽기만 한다. 지표 test 들도 같은 결과를 쓴다.
 */
describe("개인 사용 fixture 16개", () => {
  const cases = new Map<string, CaseView>();
  let metrics: ReturnType<typeof measurePreviews> | null = null;
  let renderedCorpus = "";
  let buildError: unknown = null;

  before(async () => {
    try {
      const ordered: Array<CaseView["result"]> = [];
      for (const fixture of CORPUS) {
        const view = await runCase(fixture.turns);
        cases.set(fixture.file, view);
        ordered.push(view.result);
      }
      metrics = measurePreviews(ordered);
      renderedCorpus = renderMetrics(metrics);
    } catch (err) {
      buildError = err;
    }
  });

  const caseOf = (file: string): CaseView => {
    const view = cases.get(file);
    if (view === undefined) throw new Error(`${file} 의 preview 결과가 준비되지 않았습니다`);
    return view;
  };

  const measured = (): ReturnType<typeof measurePreviews> => {
    if (metrics === null) throw new Error("지표가 준비되지 않았습니다");
    return metrics;
  };

  /**
   * 말뭉치가 만들어졌다는 것부터 주장한다.
   *
   * 위 before() 는 던지지 않으므로, 빌드가 깨졌다는 사실을 실패로 만드는 것은
   * 이 test 하나다. 아래 사례별 test 들은 빈 맵을 읽고 `caseOf` 가 던지는
   * 오류로 각자 자기 이름으로 실패한다 — 148개가 취소되어 조용히 사라지는
   * 대신, 148개가 이름을 달고 빨개진다.
   */
  test("말뭉치가 만들어졌다", () => {
    assert.equal(buildError, null, `말뭉치를 만들지 못했습니다: ${errorText(buildError)}`);
    assert.ok(cases.size > 0, "사례가 하나도 준비되지 않았습니다");
    assert.equal(cases.size, CORPUS.length, `사례 ${CORPUS.length} 개 중 ${cases.size} 개만 준비되었습니다`);
    assert.notEqual(metrics, null, "지표가 준비되지 않았습니다");
    assert.ok(renderedCorpus.length > 0, "지표 출력이 비어 있습니다");
  });

  /**
   * 말뭉치를 이름으로 못 박는다.
   *
   * `>= 15` 였고 파일은 16개였다 — 여유가 정확히 1이라, fixture 하나를 지우면
   * 그 사례의 test 12개가 조용히 사라지면서 스위트는 초록으로 남았다. 실측:
   * login-fix.json 을 지우면 196 → 184, fail 0. 두 개를 지워야 비로소 이 핀이
   * 실패했다.
   *
   * 개수 대신 이름을 고정하면 삭제도 치환도 그 자리가 비는 순간 실패한다.
   * 그리고 이 목록이 곧 아래 사례별 test 들의 분모다 — 여기 없는 이름은
   * 아무도 검사하지 않는다.
   */
  test("말뭉치의 fixture 이름", () => {
    assert.deepEqual(FIXTURE_FILES, [
      "conditional-compat.json",
      "conflict-keep-and-rename.json",
      "correction.json",
      "do-everything.json",
      "korean-particle-prohibition.json",
      "login-fix.json",
      "must-and-may.json",
      "named-source.json",
      "no-execute-show-code.json",
      "no-modify-no-execute.json",
      "regression-preserve.json",
      "retry-after-failure.json",
      "scoped-write.json",
      "secret-storage.json",
      "vague-do-it-well.json",
      "while-modifying-not-conditional.json",
    ]);
  });

  /**
   * 아무것도 나오지 않는 것이 정답인 fixture.
   *
   * "알아서 다 해줘." 와 "적당히 잘 좀 해줘." 는 요구사항이 없어야 맞다. 그래서
   * 이 둘의 `expect` 는 상한과 부정만 담고 있고, 그 상태로는 **아무것도 읽지
   * 못하는 추출기와 올바른 추출기를 구별하지 못한다** — 실측했다: previewDesign
   * 이 이 문장들에 대해 빈 결과를 돌려주게 만들어도 이 둘은 통과한다.
   *
   * 구별을 못 하는 것 자체는 결함이 아니다. 이 둘이 재는 것은 거절이고, 거절은
   * 다른 fixture 들이 거절하지 않는다는 것과 나란히 놓일 때만 뜻이 있다(말뭉치
   * 전체에 빈 결과를 주면 47건이 실패한다). 결함이었던 것은 **그 사실이 어디에도
   * 적혀 있지 않았다**는 것이다 — 빈 `expect` 는 아직 정답을 쓰지 않은 fixture 와
   * 글자 모양이 같다.
   *
   * 그래서 이름을 적고, 0이라는 것을 주장으로 만든다. 셋째였던
   * `secret-storage` 는 여기서 빠졌다 — 그 문장은 실제로 무언가를 요구하고
   * 있었고, 정답이 없는 동안 **Key는 SecretStorage에를 저장한다** 를 내놓고
   * 있었다(API 가 사라지고 조사가 겹친, 비밀 저장 위치에 대한 요구사항).
   */
  describe("아무것도 나오지 않는 것이 정답인 fixture", () => {
    const REFUSALS = ["do-everything.json", "vague-do-it-well.json"];

    test("두 개다", () => {
      assert.equal(REFUSALS.length, 2);
      for (const file of REFUSALS) {
        assert.ok(FIXTURE_FILES.includes(file), `${file} 이(가) 말뭉치에 없습니다`);
      }
    });

    for (const file of REFUSALS) {
      test(`${file} · 사용자 요구사항 0건`, () => {
        const found = caseOf(file);
        const stated = found.result.requirements.filter((s) => s.status !== "system_added");
        assert.deepEqual(
          stated.map((s) => s.text),
          [],
          `${file}: 읽어낼 것이 없는 문장에서 요구사항이 나왔습니다`,
        );
      });
    }
  });

  /**
   * `minQuestions` 축은 지금 비어 있다.
   *
   * fixture 16개 중 이 축을 쓰는 것은 하나도 없다. 아래 `if (min !== undefined)`
   * 는 한 번도 test 를 세우지 않으므로, 질문의 하한을 실제로 지탱하는 것은 이
   * 축이 아니라 requiredQuestionCodes · exactQuestionSubjects · mustContainText
   * 세 검사다 — 위 주석이 "the floor comes back as three checks" 라고 적은
   * 그것이다. 축이 비어 있다는 사실 자체를 못 박지 않으면, "하한" 을 말하는
   * 주석 옆에서 아무것도 세지 않는 코드가 계속 하한을 지키는 것처럼 보인다.
   *
   * 그래도 축을 지우지 않는 것은, "질문 몇 개 이상" 이라는 하한이 언젠가
   * 필요해질 때 fixture 쪽 이름이 이미 정해져 있어야 하기 때문이다. fixture 가
   * 이 축을 쓰기 시작하면 이 핀이 실패하는데, 그 실패가 곧 "축이 살아났다" 는
   * 신호다 — 그때 이 핀을 지우면 아래 `if` 가 그 fixture 의 test 를 세운다.
   */
  test("minQuestions 축을 쓰는 fixture 는 0개다", () => {
    const users = CORPUS.filter((f) => f.expect.minQuestions !== undefined).map((f) => f.id);
    assert.deepEqual(users, [], `minQuestions 를 쓰는 fixture: ${users.join(", ")}`);
  });

  for (const fixture of CORPUS) {
    const { id, file, expect } = fixture;

    describe(id, () => {
      for (const kind of expect.mustContainKinds ?? []) {
        test(`${id} · 요구사항 종류 ${kind}`, () => {
          assert.ok(caseOf(file).kinds.has(kind as never), `요구사항 종류 ${kind} 없음`);
        });
      }

      for (const action of expect.forbiddenActions ?? []) {
        test(`${id} · 금지 ${action}`, () => {
          const { forbidden } = caseOf(file);
          // 부류로 대조한다. 여기 있던 것은 `action === "execute" ? "실행" : "수정"`
          // 였고, 그것은 **execute 가 아닌 모든 값을 조용히 수정으로 읽는다**. 답에
          // 무엇을 적든 `수정` 금지가 하나라도 있으면 통과했다는 뜻이고, 답이
          // 스스로 이름 붙인 것에 대해 아무 말도 하지 않았다. 답을 바꿔 보는
          // 하네스(`scripts/answers.mjs`)가 execute 를 다른 값으로 바꿔도 초록인
          // 것을 보고 이 자리를 가리켰다.
          //
          // 금지 요구사항의 id 는 `t1-forbid-execute` 꼴이고, 그 꼬리가 부류다.
          const kinds = forbidden.map((s) => s.id.split("-forbid-")[1] ?? "");
          assert.ok(
            kinds.includes(action),
            `금지 ${action} 없음: ${JSON.stringify(kinds)} — ${JSON.stringify(forbidden.map((s) => s.text))}`,
          );
        });
      }

      if ((expect.forbiddenActions ?? []).length === 0) {
        test(`${id} · 금지는 서지 않는다`, () => {
          const { forbidden } = caseOf(file);
          assert.deepEqual(
            forbidden.map((s) => s.text),
            [],
            `금지가 없어야 하는데 ${forbidden.map((s) => s.text).join(", ")}`,
          );
        });
      }

      // A ceiling alone could not fail. `expectedQuestions` was an exact
      // count; replacing it with `maxQuestions` left fifteen of sixteen
      // fixtures with no lower bound at all, so a regression that stopped
      // asking a needed question passed silently. The ceiling is kept — an
      // interrogating preview is its own failure — and the floor comes back as
      // three checks that say *which* questions, not how many.
      const max = expect.maxQuestions;
      if (max !== undefined) {
        test(`${id} · 질문 상한 ${max}`, () => {
          const { questions } = caseOf(file);
          assert.ok(questions.length <= max, `질문 ${questions.length} 개, 상한 ${max}`);
        });
      }

      const min = expect.minQuestions;
      if (min !== undefined) {
        test(`${id} · 질문 최소 ${min}`, () => {
          const { questions } = caseOf(file);
          assert.ok(questions.length >= min, `질문 ${questions.length} 개, 최소 ${min}`);
        });
      }

      for (const code of expect.requiredQuestionCodes ?? []) {
        test(`${id} · 반드시 있어야 할 질문 ${code}`, () => {
          assert.ok(caseOf(file).codes.has(code as never), `반드시 있어야 할 질문 ${code} 이(가) 없습니다`);
        });
      }

      for (const code of expect.forbiddenQuestionCodes ?? []) {
        test(`${id} · 있어서는 안 될 질문 ${code}`, () => {
          assert.ok(!caseOf(file).codes.has(code as never), `있어서는 안 될 질문 ${code} 이(가) 나왔습니다`);
        });
      }

      if (expect.exactQuestionSubjects !== undefined) {
        const want = [...expect.exactQuestionSubjects].sort();
        test(`${id} · 질문 대상`, () => {
          const got = [...new Set(caseOf(file).questions.map((q) => q.subject))].sort();
          assert.deepEqual(got, want, `질문 대상이 다릅니다: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
        });
      }

      // What the extractor must read out of this turn. Without this a
      // regression that stops extracting anything satisfies every question
      // check above by asking nothing.
      for (const want of expect.mustContainText ?? []) {
        test(`${id} · 요구사항 "${want}"`, () => {
          const { texts } = caseOf(file);
          assert.ok(
            texts.includes(want),
            `요구사항 "${want}" 이(가) 추출되지 않았습니다: ${JSON.stringify(texts)}`,
          );
        });
      }

      // Nothing the user did not ask for. Checked against the requirement text
      // rather than the report, so wording changes cannot hide an invention.
      for (const word of expect.mustNotInvent ?? []) {
        test(`${id} · 발명 없음 "${word}"`, () => {
          const invented = caseOf(file).live.filter(
            (s) => s.status !== "system_added" && s.text.includes(word),
          );
          assert.deepEqual(
            invented.map((s) => s.text),
            [],
            `발명: ${word} — ${invented.map((s) => s.text).join(", ")}`,
          );
        });
      }
    });
  }

  test("16개 전체에 대한 지표가 나온다", () => {
    const m = measured();
    assert.equal(m.source, "offline");
    assert.equal(m.cases, FIXTURE_FILES.length);
    assert.equal(m.refusedProposalInventionCount, 0, "offline 경로에서 발명이 나왔습니다");
    assert.ok(m.ambiguousIntentRate.of > 0, "요구사항이 하나도 없으면 비율은 의미가 없습니다");
    assert.ok(m.ambiguousIntentRate.hit <= m.ambiguousIntentRate.of);
  });

  /**
   * 모든 비율은 분모를 함께 보고한다.
   *
   * A rate on its own cannot be checked. `1.0` over one case and `1.0` over
   * fifteen were printed identically, and the first one is not a result.
   *
   * 아홉 비율이 한 반복문에 있었고, 첫 비율에서 멈추면 나머지 여덟은 검사되지
   * 않았다. 비율마다 하나씩 세운다.
   */
  describe("모든 비율은 분모를 함께 보고한다", () => {
    const RATIOS = [
      "ambiguousIntentRate",
      "unresolvedBindingRate",
      "blockedRate",
      "semanticUnknownRate",
      "noDesignRuleRate",
      "questionCases",
      "remediableClosureRate",
      "fullyResolvedRate",
      "executableRate",
    ] as const;

    test("아홉 개다", () => {
      // 표에서 한 줄을 지우면 test 하나가 조용히 줄어들 뿐이다.
      assert.equal(RATIOS.length, 9);
    });

    /**
     * 값도 함께 못 박는다.
     *
     * `hit <= of` 와 "분모가 출력에 있다" 는 **모든 틀린 답에 대해서도 참**이다.
     * 실측: measurePreviews 를 감싸 16사례의 모든 비율을 hit=0 으로 무너뜨려도
     * 이 아홉 개는 전부 통과했다. 분모를 함께 보고한다는 주장은 지켜지고 있었고,
     * 보고된 값이 맞는지는 아무도 보지 않고 있었다.
     *
     * 핀이지 문턱이 아니다. 값이 움직이면 그것은 결과이거나 회귀이고, 어느
     * 쪽인지는 사람이 정한다.
     */
    const EXPECTED: Readonly<Record<(typeof RATIOS)[number], readonly [number, number]>> = {
      ambiguousIntentRate: [0, 27],
      unresolvedBindingRate: [3, 27],
      blockedRate: [6, 27],
      semanticUnknownRate: [0, 27],
      noDesignRuleRate: [0, 27],
      questionCases: [5, 16],
      remediableClosureRate: [16, 16],
      fullyResolvedRate: [9, 16],
      executableRate: [9, 16],
    };

    for (const name of RATIOS) {
      test(`${name} · 분자·분모·출력`, () => {
        const r = measured()[name];
        assert.ok(r.hit <= r.of, `${name}: 분자 ${r.hit} 가 분모 ${r.of} 보다 큽니다`);
        assert.equal(r.value === null, r.of === 0, `${name}: 분모 0 이면 value 는 null 이어야 합니다`);
        if (r.value !== null) {
          assert.ok(renderedCorpus.includes(`(${r.hit}/${r.of})`), `${name} 의 분모가 출력에 없습니다`);
        }
        const [hit, of] = EXPECTED[name];
        assert.deepEqual([r.hit, r.of], [hit, of], `${name} 가 움직였습니다`);
      });
    }
  });
});

// --- 말뭉치를 쓰지 않는 지표 검사 ---------------------------------------------

/**
 * 이 둘은 말뭉치를 읽지 않는다.
 *
 * 각자 preview 를 한 번 돌려 그 하나로 지표를 재는 검사인데, 말뭉치를 만드는
 * before() 와 같은 describe 안에 있었다. 그 훅이 터지면 이 둘도 함께 취소되었다
 * — 말뭉치와 아무 상관 없는 주장이 말뭉치의 사고로 사라진 것이다. 훅이 이제
 * 던지지 않더라도, 훅에 매달릴 이유가 없는 것을 훅 아래 두지는 않는다.
 */
describe("지표는 재지 않은 것을 재었다고 말하지 않는다", () => {
  test("gold annotation 없이 recall·precision 을 출력하지 않는다", async () => {
    const result = await previewDesign({ turns: ["로그인 오류를 수정하고 테스트해줘."] });
    const rendered = renderMetrics(measurePreviews([result]));
    // Naming a number "recall" without a gold list is the failure this guards.
    for (const word of ["recall", "Recall", "precision", "Precision", "재현율", "정밀도", "정확도"]) {
      const inMeasured = rendered.split("[이 fixture 로는 계산할 수 없는 값]")[0] ?? "";
      assert.ok(!inMeasured.includes(word), `측정하지 않은 ${word} 를 지표로 출력했습니다`);
    }
    assert.ok(rendered.includes("계산할 수 없는 값"), "무엇을 못 재는지 밝히지 않았습니다");
  });

  test("closure 지표는 미해결이 남은 사례를 성공으로 세지 않는다", async () => {
    // The old `closureSuccessRate` was 1 for this case: every finding left is
    // one nobody may repair without the user, so "all remediable ones closed"
    // is true — and reading that as "closed" is how twenty open questions get
    // reported as a success.
    const result = await previewDesign({ turns: ["기존 클라이언트가 사용 중이라면 API 형식을 변경하지 마."] });
    const metrics = measurePreviews([result]);
    assert.ok(result.closure.unresolved.length > 0, "이 fixture 는 미해결 finding 이 있어야 합니다");
    assert.equal(metrics.remediableClosureRate.value, 1, "보완 가능한 finding 은 모두 닫혔습니다");
    assert.equal(metrics.fullyResolvedRate.value, 0, "그런데도 finding 은 남아 있습니다");
    assert.ok(metrics.unresolvedFindingsPerCase > 0);
    assert.equal(metrics.executableRate.value, 0);
  });
});
