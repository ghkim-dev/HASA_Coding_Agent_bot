/**
 * 산업군별 요청을 하나씩 설계기에 넣고, 나온 하네스를 그대로 보여준다.
 *
 * 테스트는 "달라야 한다" 를 주장하고 이것은 "무엇이 나왔는지" 를 보여준다. 둘 다
 * 필요하다 — 주장만 있으면 사람이 결과를 볼 수 없고, 출력만 있으면 다음에 바뀌어도
 * 아무도 모른다.
 *
 *   node scripts/industryReport.mjs            # 전부
 *   node scripts/industryReport.mjs finance    # 한 산업군
 */

import { INDUSTRY_CASES } from "../src/design/industryCases.ts";
import { designHarness } from "../src/design/harnessDesign.ts";
import { profileOf } from "../src/design/recommendationCases.ts";
import { CAPABILITY_KEYS } from "../src/router/taskProfile.ts";

const SECTOR_NAME = {
  manufacturing: "제조",
  finance: "금융",
  healthcare: "의료",
  retail: "유통",
  logistics: "물류",
  public: "공공",
  education: "교육",
  energy: "에너지",
  telecom: "통신",
  insurance: "보험",
  construction: "건설",
  media: "미디어",
};

/**
 * 이 키가 실제로 부를 수 있는 네 모델.
 *
 * `.arena/capability-matrix.json` (2026-08-01 측정) 에서 chat 이 통과한 넷이고,
 * `protocol: null` 인 둘은 네이티브 도구가 되지 않는 것으로 실측된 쪽이다. 능력치는
 * `declared` — 그 프로브가 잰 것은 접근과 프로토콜이지 코딩 실력이 아니다.
 */
const FLEET = [
  profileOf({
    id: "exaone-4.0-32b",
    declared: { reasoning: 0.8, instructionFollowing: 0.8, toolUse: 0.7, coding: 0.6 },
  }),
  profileOf({
    id: "gpt-oss-20b",
    declared: { reasoning: 0.7, instructionFollowing: 0.7, toolUse: 0.7, coding: 0.7 },
  }),
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

const only = process.argv[2];
const cases = only === undefined ? INDUSTRY_CASES : INDUSTRY_CASES.filter((c) => c.sector === only);
if (cases.length === 0) {
  console.error(`산업군 «${only}» 이(가) 없습니다. 있는 것: ${Object.keys(SECTOR_NAME).join(", ")}`);
  process.exit(1);
}

const line = (n = 78) => "─".repeat(n);
const demandsOf = (d) =>
  CAPABILITY_KEYS.filter((k) => d.profile.demands[k] >= 0.5)
    .map((k) => `${k} ${d.profile.demands[k].toFixed(2)}`)
    .join(" · ") || "(높은 수요 없음)";

for (const c of cases) {
  const d = await designHarness({ text: c.text, models: FLEET });
  const stated = d.requirements.filter((r) => r.status !== "system_added");
  const forbidden = stated.filter((r) => r.polarity === "forbidden");
  const required = stated.filter((r) => r.polarity === "required");
  const own = d.preview.scenarios.filter((s) => s.generatedBy !== "baseline");
  const rec = d.recommendation;

  console.log(line());
  console.log(`[${SECTOR_NAME[c.sector]}] ${c.id}`);
  console.log(`  요청  ${c.text}`);
  console.log();
  console.log(`  해야 할 일 (${required.length})`);
  for (const r of required) console.log(`    · ${r.text}`);
  console.log(`  하지 않을 일 (${forbidden.length})`);
  if (forbidden.length === 0) console.log("    · 없음");
  for (const r of forbidden) console.log(`    · ${r.text}`);
  console.log();
  console.log(`  이 일이 모델에게 요구하는 것`);
  console.log(`    ${demandsOf(d)}`);
  console.log(`    복잡도 ${d.profile.complexity} · 컨텍스트 ${d.profile.contextDemand}`);
  console.log();
  console.log(`  추천 모델`);
  if (rec?.selected == null) {
    console.log(`    없음 — ${rec?.reasons?.map((x) => x.code).join(", ") ?? "모델 목록 없음"}`);
  } else {
    console.log(`    ${rec.selected.modelId}  (점수 ${rec.selected.score.toFixed(3)})`);
    for (const r of rec.reasons.slice(0, 3)) console.log(`      ${r.code}${r.subject ? `[${r.subject}]` : ""} — ${r.detail}`);
    for (const alt of rec.alternatives.slice(0, 2)) console.log(`      다음 후보 ${alt.modelId} ${alt.score.toFixed(3)}`);
    for (const ex of rec.excluded ?? []) console.log(`      탈락 ${ex.modelId} — ${ex.code}`);
  }
  console.log();
  console.log(`  설계된 검증 시나리오 (${own.length})`);
  for (const s of own) {
    const gate = [
      s.oracle.forbiddenTools.length > 0 ? `막음[${s.oracle.forbiddenTools.join(",")}]` : "",
      s.oracle.requiredTools.length > 0 ? `요구[${s.oracle.requiredTools.join(",")}]` : "",
      s.oracle.forbiddenOutput.length > 0 ? `표현금지[${s.oracle.forbiddenOutput.join(",")}]` : "",
    ]
      .filter(Boolean)
      .join(" ");
    console.log(`    · ${s.title}`);
    if (gate) console.log(`        ${gate}`);
  }
  const asking = d.questions ?? [];
  if (asking.length > 0) {
    console.log();
    console.log(`  아직 정해지지 않아 묻는 것 (${asking.length})`);
    for (const q of asking) console.log(`    · ${q.code}${q.subject ? ` — ${q.subject}` : ""}`);
  }
  console.log();
}

console.log(line());
console.log(`사례 ${cases.length}건. 설계 단계에서는 아무것도 실행되지 않았습니다.`);
