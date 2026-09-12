import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { INDUSTRY_CASES, INDUSTRY_GAPS, type IndustryCase, type Sector } from "./industryCases.ts";
import { readExtraction, type GoldAction } from "./goldRequirements.ts";
import { designHarness } from "./harnessDesign.ts";
import { profileOf } from "./recommendationCases.ts";
import { CAPABILITY_KEYS } from "../router/taskProfile.ts";

/**
 * 산업군 요청을 읽고, 그 요청에 맞는 하네스를 설계하는가.
 *
 * 두 가지를 잰다. 앞쪽은 다른 말뭉치와 같다 — 요구사항과 금지를 읽는 비율.
 * 뒤쪽이 이 파일에만 있는 것이다: 같은 문장이 능력 수요를 만들고, 그 수요가 모델
 * 추천을 만들고, 금지가 검증 오라클을 만드는데 **산업군마다 그 셋이 달라야 한다.**
 * 24개 요청이 같은 하네스를 받는다면 설계는 요청을 읽지 않은 것이고, 그 상태에서도
 * 요구사항 recall 은 만점이 나올 수 있다.
 */

const FORBID_OF: Readonly<Record<string, string>> = {
  forbid_execute: "execute",
  forbid_modify: "modify",
  forbid_research: "research",
  forbid_output: "output",
};

interface Read {
  acts: { action: GoldAction; target: string | null }[];
  bans: string[];
}

function readCase(c: IndustryCase): Read {
  const rows = readExtraction({ turnId: "t1", text: c.text });
  return {
    acts: rows.filter((r) => FORBID_OF[r.action] === undefined).map((r) => ({ action: r.action, target: r.target })),
    bans: rows.flatMap((r) => (FORBID_OF[r.action] === undefined ? [] : [FORBID_OF[r.action]!])).sort(),
  };
}

/** 이 사례가 그 축에서 어긋난다고 표에 적혀 있는가. */
const gapped = (caseId: string, axis: "requirement" | "target" | "forbids"): boolean =>
  INDUSTRY_GAPS.some((g) => g.caseId === caseId && g.axis === axis);

describe("산업군 말뭉치", () => {
  test("12개 산업군이 각각 두 사례씩이다", () => {
    // 한 산업군이 통째로 빠지면 그 산업의 문장 모양이 측정에서 사라지는데,
    // 총 개수만 세면 다른 산업이 늘어난 것과 구별되지 않는다.
    const bySector = new Map<Sector, number>();
    for (const c of INDUSTRY_CASES) bySector.set(c.sector, (bySector.get(c.sector) ?? 0) + 1);
    assert.equal(bySector.size, 12, `산업군 ${bySector.size}개`);
    for (const [sector, n] of bySector) assert.equal(n, 2, `${sector} 가 ${n}개`);
    assert.equal(INDUSTRY_CASES.length, 24);
  });

  test("모든 사례에 이유가 적혀 있다", () => {
    for (const c of INDUSTRY_CASES) {
      assert.ok(c.why.length > 10, `${c.id}: 이유가 없습니다`);
      assert.ok(c.requirements.length > 0, `${c.id}: 요구사항이 없는 사례는 이 말뭉치에 없다`);
    }
  });

  test("표에 있는 사례 id 는 실재한다", () => {
    const known = new Set(INDUSTRY_CASES.map((c) => c.id));
    for (const g of INDUSTRY_GAPS) assert.ok(known.has(g.caseId), `없는 사례: ${g.caseId}`);
  });
});

describe("요청을 읽는다", () => {
  /**
   * 금지는 예외 없이 맞아야 한다.
   *
   * 요구사항을 놓치면 계획이 좁아지지만, 금지를 놓치면 사용자가 하지 말라고 한
   * 일을 하네스가 허용한다. `INDUSTRY_GAPS` 에 `forbids` 축이 있어도 그 항목은
   * 지금 비어 있고, 비어 있는 것이 이 스위트의 주장이다.
   */
  for (const c of INDUSTRY_CASES) {
    test(`${c.id} · 금지 ${JSON.stringify([...c.forbids].sort())}`, () => {
      assert.deepEqual(readCase(c).bans, [...c.forbids].sort());
      assert.equal(gapped(c.id, "forbids"), false, "금지 축에는 면제가 없다");
    });
  }

  for (const c of INDUSTRY_CASES) {
    test(`${c.id} · 요구사항`, () => {
      // 다중집합으로 센다. `some(action)` 으로 세면 같은 동사를 둘 요청한
      // 문장에서 하나가 다른 동사로 읽혀도 통과한다 — "매장별 매출을 비교하고
      // 상위 원인을 정리해줘" 가 정확히 그 모양이고, 두 번째가 `modify` 로
      // 읽히는데도 초록이었다.
      const pool = readCase(c).acts.map((a) => a.action);
      const missing = c.requirements.filter((w) => {
        const at = pool.indexOf(w.action);
        if (at === -1) return true;
        pool.splice(at, 1);
        return false;
      });
      const got = readCase(c).acts;
      if (gapped(c.id, "requirement")) {
        assert.ok(missing.length > 0, `${c.id}: 표에 어긋난다고 적혀 있는데 이제 맞습니다 — 표에서 지우십시오`);
        return;
      }
      assert.deepEqual(
        missing.map((m) => `${m.action}:${m.target}`),
        [],
        `${c.id}: 읽은 것 ${JSON.stringify(got)}`,
      );
    });
  }

  for (const c of INDUSTRY_CASES) {
    test(`${c.id} · 대상`, () => {
      const got = readCase(c).acts;
      const wrong = c.requirements.filter(
        (w) => !got.some((a) => a.action === w.action && a.target === w.target),
      );
      if (gapped(c.id, "target")) {
        assert.ok(wrong.length > 0, `${c.id}: 표에 잘린다고 적혀 있는데 이제 맞습니다 — 표에서 지우십시오`);
        return;
      }
      assert.deepEqual(wrong.map((w) => w.target), [], `${c.id}: 읽은 것 ${JSON.stringify(got)}`);
    });
  }

  test("분자와 분모 — 요구·대상·금지", () => {
    let req = 0;
    let tgt = 0;
    let total = 0;
    let bans = 0;
    for (const c of INDUSTRY_CASES) {
      const got = readCase(c);
      if (JSON.stringify(got.bans) === JSON.stringify([...c.forbids].sort())) bans += 1;
      // 사례별 test 와 같은 다중집합 셈. 여기만 느슨하게 세면 합계가 각 사례가
      // 믿지 않는 숫자를 보고하게 된다.
      const pool = got.acts.map((a) => a.action);
      for (const w of c.requirements) {
        total += 1;
        const at = pool.indexOf(w.action);
        if (at !== -1) {
          req += 1;
          pool.splice(at, 1);
        }
        if (got.acts.some((a) => a.action === w.action && a.target === w.target)) tgt += 1;
      }
    }
    // 못이지 목표가 아니다. 올라가면 이 줄이 실패하고, 그때 올린 쪽이 숫자를
    // 갱신하면서 `INDUSTRY_GAPS` 에서 해당 줄을 지우게 된다.
    assert.deepEqual(
      { 요구: [req, total], 대상: [tgt, total], 금지: [bans, INDUSTRY_CASES.length] },
      { 요구: [33, 38], 대상: [17, 38], 금지: [24, 24] },
    );
  });
});

/**
 * 함대는 이 키가 실제로 부를 수 있는 네 모델이다.
 *
 * `.arena/capability-matrix.json` 의 2026-08-01 측정에서 chat 이 통과한 것이 넷,
 * 그중 네이티브 도구가 되는 것이 둘이다. 능력치는 `declared` 로 둔다 — 그 프로브가
 * 잰 것은 접근과 프로토콜이지 코딩 실력이 아니고, 재지 않은 것을 `harness_eval`
 * 로 올리면 사다리가 뜻을 잃는다.
 */
const FLEET = [
  profileOf({ id: "exaone-4.0-32b", declared: { reasoning: 0.8, instructionFollowing: 0.8, toolUse: 0.7, coding: 0.6 } }),
  profileOf({ id: "gpt-oss-20b", declared: { reasoning: 0.7, instructionFollowing: 0.7, toolUse: 0.7, coding: 0.7 } }),
  profileOf({
    id: "qwen2.5-coder-32b",
    protocol: null,
    declared: { reasoning: 0.6, instructionFollowing: 0.6, toolUse: 0.3, coding: 0.9, debugging: 0.8 },
  }),
  profileOf({
    id: "granite-guardian-3.1-8b",
    protocol: null,
    declared: { reasoning: 0.4, instructionFollowing: 0.6, toolUse: 0.3, coding: 0.2 },
  }),
];

describe("요청마다 다른 하네스가 나온다", () => {
  const designs = new Map<string, Awaited<ReturnType<typeof designHarness>>>();
  let buildError: unknown = null;

  before(async () => {
    try {
      for (const c of INDUSTRY_CASES) designs.set(c.id, await designHarness({ text: c.text, models: FLEET }));
    } catch (err) {
      buildError = err;
    }
  });

  test("24개 설계가 모두 만들어졌다", () => {
    assert.equal(buildError, null, String(buildError));
    assert.equal(designs.size, INDUSTRY_CASES.length);
  });

  for (const c of INDUSTRY_CASES) {
    test(`${c.id} · 요청을 읽었다고 말한다`, () => {
      const d = designs.get(c.id);
      assert.ok(d !== undefined, "설계가 없습니다");
      assert.equal(d.understood, true, `${c.id}: 문장에서 아무것도 읽지 못했다고 보고합니다`);
    });
  }

  test("능력 수요가 요청마다 다르다", () => {
    // 24개가 같은 수요를 내놓아도 요구사항 recall 은 만점일 수 있다. 그때
    // 하네스는 요청이 아니라 상수를 설계하고 있는 것이다.
    const shapes = new Set<string>();
    for (const c of INDUSTRY_CASES) {
      const demand = designs.get(c.id)!.profile.demands;
      shapes.add(CAPABILITY_KEYS.map((k) => `${k}:${demand[k]}`).join("|"));
    }
    assert.ok(shapes.size >= 8, `24개 요청이 서로 다른 수요 ${shapes.size}종류만 만듭니다`);
  });

  test("금지가 있는 요청은 그 금지를 검증하는 시나리오를 받는다", () => {
    const withBan = INDUSTRY_CASES.filter((c) => c.forbids.length > 0);
    assert.ok(withBan.length >= 6, `금지가 있는 사례가 ${withBan.length}개뿐입니다`);
    for (const c of withBan) {
      const scenarios = designs.get(c.id)!.preview.scenarios;
      const negative = scenarios.filter((s) => s.category === "negative");
      assert.ok(negative.length > 0, `${c.id}: 금지를 검증하는 시나리오가 없습니다`);
      // 무엇을 막는지가 부류마다 달라야 한다. 전부 파일 쓰기를 막고 있으면
      // 계획은 금지를 이해했다고 말하면서 아무것도 확인하지 않는 것이다.
      const gates = negative
        .filter((s) => s.generatedBy !== "baseline")
        .flatMap((s) => [...s.oracle.forbiddenTools, ...s.oracle.forbiddenOutput]);
      assert.ok(gates.length > 0, `${c.id}: 금지 시나리오가 아무것도 막지 않습니다`);
    }
  });

  test("웹 금지는 웹 도구를, 배포 금지는 실행 도구를, 결과물 금지는 표현을 막는다", () => {
    const gateOf = (id: string): string[] => {
      const neg = designs
        .get(id)!
        .preview.scenarios.filter((s) => s.category === "negative" && s.generatedBy !== "baseline");
      return [...new Set(neg.flatMap((s) => [...s.oracle.forbiddenTools, ...s.oracle.forbiddenOutput]))].sort();
    };
    // 포함으로 본다. 쓰기 도구 관문은 금지가 아니라 `inspect` 요구사항이
    // 만드는 것("설명 요청이 파일을 바꾸지 않는다")이라, 금지가 없는 요청에도
    // 정당하게 선다. 여기서 주장하는 것은 **그 금지의 관문이 서 있는가** 다.
    for (const t of ["web_fetch", "web_search"]) {
      assert.ok(gateOf("log-warehouse-no-web").includes(t), `웹 금지에 ${t} 가 없습니다`);
    }
    assert.ok(gateOf("pub-access-model-no-deploy").includes("run_command"));
    assert.ok(gateOf("fin-fraud-rules-no-names").includes("고객 실명"));
    assert.ok(gateOf("hc-export-no-phi").includes("환자 식별정보"));
  });

  test("추천은 근거 등급과 함께 나오거나, 왜 없는지 말한다", () => {
    for (const c of INDUSTRY_CASES) {
      const rec = designs.get(c.id)!.recommendation;
      assert.notEqual(rec, null, `${c.id}: 모델 목록을 줬는데 추천이 null 입니다`);
      assert.ok(rec!.selected !== null, `${c.id}: 후보가 하나도 남지 않았습니다`);
      assert.ok(rec!.reasons.length > 0, `${c.id}: 이유 없는 추천입니다`);
    }
  });
});
