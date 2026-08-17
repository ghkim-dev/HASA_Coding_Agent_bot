# Harness Auto-Design

사용자의 자연어 요구사항에서 검증 계획을 자동으로 설계한다. 이 문서는 무엇을
모델에게 맡기고 무엇을 런타임이 붙잡는지, 그리고 왜 그렇게 나누었는지를 적는다.

## 왜 모델의 계획을 그대로 믿지 않는가

이 저장소에는 이미 측정된 실패가 있다. 여섯 번 반복한 정정 시나리오에서 세 번,
모델은 턴을 `correct`로 **정확히 분류하고도** 제약을 하나도 기록하지 않았다.
계약이 비어 있었으므로 실행 게이트는 막을 것이 없었고, 게이트 자체는 완벽하게
동작했다.

```
경계는 정확히 집행되었다
— 모델이 공급할 책임이 있던 사실에 대해서
```

모델이 기록한 계약에서 검증 계획을 만들면 그 누락을 그대로 물려받는다. 계획은
비어 있는데 완결돼 보인다.

같은 이유로 키워드 매칭도 안 된다. `실행하지 마` 하나만 잡아서 "명령이 실행되지
않음"을 확인하는 계획은, **전부 거부하는 하네스**도 통과시킨다. 사용자가 요청한
분석까지 거부해도 통과한다.

## 파이프라인

```
사용자 원문
  → RequirementSpec        무엇을 요구했는가
  → ScenarioBlueprint      그것을 어떻게 확인하는가
  → ScenarioOracle         무엇을 보고 판정하는가
  → Coverage Audit         이 계획으로 실행해도 되는가
  → (실행)
```

Coverage Audit가 실패하면 실행하지 않는다. 불완전한 계획으로 여덟 시간을 쓰면
여덟 시간치 데이터를 버려야 하고, 이 저장소에서 이미 한 번 일어났다.

## 요구사항의 세 가지 출처

| status | 뜻 | sourceText |
|---|---|---|
| `explicit` | 사용자가 말했다 | 원문에 존재해야 함 |
| `inherited` | 이전 턴에서 넘어와 아직 유효 | 원래 턴의 원문 |
| `system_added` | 하네스가 요구한다 | 비어 있음 |

섞지 않는 이유는 보고서 때문이다. 시스템 안전 조건을 사용자 요구로 표시하면
사용자가 요청하지 않은 것을 요청했다고 주장하는 것이다.

### 도출 경로

```
runtime_prohibition   statedProhibitions 가 원문에서 읽음. 모델 없음
runtime_source        exactSourcesIn 이 원문에서 읽음. 모델 없음
model_proposal        모델이 제안, 원문 대조 통과
system_baseline       하네스 자신의 조건
carried               이전 턴에서 넘어옴
```

앞의 둘은 모델이 누락할 수 없다. 그것이 `실행하지 말고`에 대한 계획이 모델의
망각과 무관하게 no-execute 검사를 갖는 이유다.

## 원문 대조

`acceptProposals`의 규칙은 하나다. `sourceText`가 사용자 메시지 안에 공백을
무시하고 그대로 존재해야 한다.

```
"실행하지 말고 보여줘"  →  "사용자는 안전을 원한다"
```

이것은 요약이 아니라 **발명**이다. 이런 요구사항으로 만든 계획은 아무도 요청하지
않은 것을 검증하고, 실제 요청은 검증되지 않은 채 남는다. 자신 있게 말하는 모델을
상대로 살아남는 방어는 원문 대조뿐이다.

## 턴 관계의 대수

`mergeContract`가 이미 쓰는 것과 같다. 계획 쪽에서 다시 적는 이유는 막으려는
실패가 구체적이기 때문이다.

```
new_task   서 있던 목록을 대체
refine     유지하고 추가
correct    유지하고 superseded 표시. 새 것이 선다
continue   유지. 새로 만들지 않음
question   유지. 새로 만들지 않음
```

정정이 기존 요구사항을 **삭제하면** 계획은 사용자가 마음을 바꿨다는 사실을 잃는다.
`실행해줘` 다음의 `실행하지 말고`가 바로 그 경우다.

## 하나의 요구사항, 여러 방향

금지 하나에서 네 개가 나온다.

```
A  금지된 도구가 실행되지 않음            negative
B  금지되지 않은 동작은 계속 허용됨       happy_path
C  모델이 계약에 누락해도 실행 안 됨      security
D  다음 턴에서 명시 요청하면 허용됨       boundary
```

A만 있으면 과다 거부가 통과한다. B와 D가 사용자 요구를 **정확히** 반영하는 쪽이다.

## Oracle은 문장을 읽지 않는다

`ScenarioOracle`의 모든 필드는 런타임이 자기 이유로 남기는 기록이다 — action
ledger, evidence, workspace diff. 문장 패턴에 의존하는 oracle은 자기가 맞춰
만들어진 문체의 모델을 통과시키고 그것을 모델이 좋다고 보고한다.

Coverage Audit는 oracle에 문자열 필드가 있으면 `ORACLE_READS_PROSE`로 잡는다.

## 역할 분리

```
Requirement Analyzer   requirementSpec.ts    원문 → 구조
Scenario Designer      scenarioBlueprint.ts  요구사항 → 검증 후보
Coverage Auditor       coverageAudit.ts      누락·중복·반대 방향 검사
Oracle Builder         scenarioBlueprint.ts  판정 기준 (designer 내부, 결정론적)
Harness Planner        (미구현)              실행 순서·모델·비용
Arena                  기존                  설계 후보가 실제로 충돌할 때만
```

기본 경로는 Single Designer다. reviewer는 다음일 때만 쓴다: must 누락 가능성,
요구사항 충돌, security/destructive, oracle을 결정론적으로 만들기 어려움, Coverage
Audit 반복 실패.

## 모델과 런타임의 분담

모델이 할 수 있는 것: 요구사항 분해 후보, 시나리오 후보, 누락 가능성 설명,
모호한 부분 표시.

런타임이 반드시 하는 것: 원문 보존, sourceText·turn provenance 확인, forbidden
action 차단, requirement-scenario 추적성, 중복·누락 검사, 허용 모델·권한 검사,
실제 도구 실행 여부 판정, oracle 실행, 하네스 불변식 판정.

모델의 "이 테스트면 충분합니다"는 Coverage Audit 통과가 아니다. 완료를 세 번 중
두 번 과장하는 모델은 커버리지도 과장한다.

## Coverage Audit가 잡는 것

```
MUST_WITHOUT_SCENARIO                 must 요구사항에 시나리오 없음
FORBIDDEN_WITHOUT_SIDE_EFFECT_ORACLE  금지에 부작용 0 검사 없음
FORBIDDEN_WITHOUT_POSITIVE_PAIR       금지에 정상 허용 짝 없음
MODIFY_WITHOUT_REGRESSION             수정 요구에 회귀 시나리오 없음
SOURCE_WITHOUT_PROVENANCE_CHECK       출처 요구에 web_source 증거 없음
EXECUTION_WITHOUT_EVIDENCE            실행 요구에 실행 증거 없음
AMBIGUOUS_DECIDED                     모호한 요구를 확정 판정
SCENARIO_OVERLOADED                   한 시나리오에 요구사항 과다 (>3)
SCENARIO_WITHOUT_REQUIREMENT          추적 불가 시나리오
ORACLE_READS_PROSE                    oracle이 문장에 의존
INVENTED_REQUIREMENT                  존재하지 않는 요구사항 참조
```

## 아직 없는 것

- Harness Planner — 실행 순서, 모델 배정, 비용 계산
- 모델 제안을 실제 모델에서 받는 경로 (현재는 fixture)
- ScenarioBlueprint → 실행 가능한 `EvalScenario` 변환
- Arena 연동 (설계 후보 충돌 시)
- requirement 간 `dependencies` / `conflicts` 자동 도출 — 필드는 있으나 채우지 않음

---

# 요구사항 신뢰 경계 (2차)

## 하나의 confidence 가 네 가지를 답하고 있었다

`confidence: "confirmed" | "ambiguous"` 는 서로 다른 네 질문을 한 값에 눌러
담고 있었다. 그래서 사용자가 직접 쓴 동사에서 읽은 요구사항까지 전부
`ambiguous` 가 되고, `AMBIGUOUS_DECIDED` → `"…로 이해했습니다. 맞습니까?"` 로
이어졌다. 즉 "로그인 오류를 수정해줘" 에 대해 **수정을 요청하신 게 맞느냐**고
되물었다. 그건 맞았다. 모르는 것은 *어느* 로그인 오류인지였고, 그건 다른
질문이며 답도 다르다.

```
provenance          verified | invalid     근거가 사용자의 말 안에 있는가
intent              confirmed | ambiguous  사용자가 그 행동을 요청했는가
binding             resolved | unresolved  그 행동의 대상이 정해졌는가
executionReadiness  ready | blocked        (파생) 지금 실행할 수 있는가
```

`executionReadiness` 만 저장하지 않고 파생시킨다. 입력 중 `conflicts` 는
`markConflicts` 가 나중에 채우므로, 저장된 사본은 정확히 중요한 순간에 낡는다.

### intent 는 출처가 정한다

모델이 자기 제안에 `confirmed` 를 붙일 수 있으면 자기 해석을 사실로 승격시킬 수
있다. 그래서 권한을 **출처**로 고정한다.

```
runtime_prohibition   confirmed   런타임이 원문에서 읽음
runtime_source        confirmed   같음
runtime_action        confirmed   사용자가 그 동사를 직접 썼다
model_proposal        ambiguous   무엇을 보내든 항상
carried               이전 값 유지
system_baseline       confirmed, explicit 불가
사용자 승인            confirmed   다음 턴에서 사용자가 동의
```

조건(`condition`)은 여기에 없다. "기존 클라이언트가 사용 중이라면 변경하지 마"
는 의도가 분명하다. 정해지지 않은 것은 조건의 성립 여부이고, 그것은 의도를
흐리지 않은 채 실행을 막는다.

### 질문은 열린 축을 가리킨다

```
AMBIGUOUS_DECIDED     intent 가 열림    "요청하신 내용이 맞습니까?"
TARGET_UNRESOLVED     binding 이 열림   "어떤 파일이나 대상을 말씀하시는지"
UNRESOLVED_CONDITION  조건이 열림       "이 조건을 어떻게 확인할까요"
```

16개 fixture 의 offline 경로에서 `AMBIGUOUS_DECIDED` 질문은 0건이 됐고,
`TARGET_UNRESOLVED` 는 대상이 실제로 비어 있는 3건에서만 나온다.

`intentFor`가 유일한 결정 지점이다. 모델의 `confidence`는
`modelClaimedConfidence`에 정보로 남고 아무것도 결정하지 않는다.

제안이 `derivedBy`·`status`·`sourceText`·`id`를 실어 보내면 거부한다. 검사받는
대신 믿어지려는 시도이기 때문이다.

## SourceSpan — 모델은 좌표만 준다

문자열 포함 검사는 약하다.

```
사용자 : 실행하지 말고 코드만 분석해줘.
제안   : 실행이 필수 요구사항이다.   sourceText: "실행"
```

"실행"은 원문에 있다. **금지당하는 대상으로서** 있고, 부분 문자열 검사는 그
차이를 볼 수 없다.

그래서 모델은 `{turnId, start, end}`를 주고 런타임이 직접 자른다. 모델이 함께
보낸 `quote`는 그 절단과 대조한다.

오프셋은 **UTF-16 코드 단위**다. `text.slice(start, end)`가 정의 그 자체이고,
한국어는 음절당 1단위, BMP 밖 이모지는 2단위다. 서로게이트 쌍 가운데를 자르면
거부한다 — 모델이 의도한 경계를 추측하면 규약이 조용히 근사치가 된다.

거부 사유: `out_of_range` `empty` `reversed` `split_surrogate` `quote_mismatch`
`wrong_turn` `too_slight` `negation_truncated` `condition_truncated`

`negation_truncated`는 **인접성**으로 판단한다. 같은 문장에 부정이 있다는 이유로
잡으면 `실행하지 말고` 옆의 `코드만 분석해줘`까지 거부한다. 절단면 바로 뒤가
부정으로 이어지는지를 본다.

## 의미·극성

인용이 맞아도 뜻이 뒤집힐 수 있다. 결정론적으로 판단 가능한 것만 잡는다.

```
polarity_reversed             금지 구절로 요구를 세움
keep_vs_remove                유지 구절로 제거를 세움
execute_vs_analyse            분석만 요청에서 실행을 세움
past_failure_as_prohibition   과거 실패 보고를 금지로 읽음
conditional_made_absolute     조건부를 무조건 must 로
priority_promoted             가능하면 을 must 로
scope_widened                 특정 경로를 전체로
target_substituted            지목한 대상이 요구사항에 없음 (unknown)
```

나머지는 전부 `unknown` → `ambiguous`다. 불확실한 것을 확정하는 것보다 다시
읽는 비용이 싸다.

우선순위는 모델이 아니라 **원문**에서 읽는다. `반드시`는 must, `가능하면`은 may.
모델은 모든 것을 must로 올릴 유인이 있고, 그러면 사용자가 "가능하면"이라고 한
것 때문에 전체가 실패한다.

## 설계 규칙 자체의 감사

이전 슬라이스의 남은 위험이었다.

> 규칙 기반 설계기는 알려진 실패 형태만 덮으며 그 누락은 Coverage Audit로 잡히지 않음

각 Blueprint가 `designRuleId`, `oracleCoverage`, `unresolvedAspects`를 갖는다.
설계기는 맞는 규칙이 없을 때만 `generic`을 낸다. **generic의 존재 자체가 신호**이고
감사는 그것을 `NO_DESIGN_RULE`로 잡는다 — "시나리오가 있다"와 "요구사항을 검증할
수 있다"는 다른 주장이다.

## Coverage Closure

첫 finding에서 멈추는 것만으로는 자동설계가 아니다. 절반은 설계기가 미처 내지
못한 시나리오이고 추가는 기계적이다. 나머지 절반은 사용자만 정할 수 있고, 거기에
시나리오를 추가하는 것은 계획이 사용자를 대신해 결정하는 것이다.

```
자동 보완              EXECUTION_WITHOUT_EVIDENCE
                      MODIFY_WITHOUT_REGRESSION
                      FORBIDDEN_WITHOUT_POSITIVE_PAIR
                      FORBIDDEN_WITHOUT_SIDE_EFFECT_ORACLE
                      SOURCE_WITHOUT_PROVENANCE_CHECK

사용자에게 물음        REQUIREMENT_CONFLICT
                      UNRESOLVED_CONDITION
                      SEMANTIC_ALIGNMENT_UNKNOWN
                      AMBIGUOUS_DECIDED
                      NO_DESIGN_RULE
```

매 pass마다 **재감사**한다. 추가된 시나리오도 시나리오이고 같은 구조 규칙을
받는다. 재감사 없이 닫으면 실제로 실행되는 계획은 그 상태로 감사된 적이 없다.

종료를 보장하는 것은 `attempted` 중복 방지다. 같은 finding을 두 번 보완하지
않으므로 수렴한다. `maxPasses`는 보완이 연쇄하게 될 때를 위한 보험이고, 현재
설계에서는 도달하지 않는다.

## 아직 없는 것

- ScenarioBlueprint → EvalScenario 변환 (의도적으로 보류)
- 실제 모델 제안 경로 (현재 fixture)
- Harness Planner, Arena 연동
- `dependencies` 자동 도출
- 규칙 커버리지 자체의 메타 감사 — `NO_DESIGN_RULE`이 누락을 보고하지만
  새 요구사항 유형에 맞는 규칙은 사람이 써야 한다

---

# Harness Design Preview

사용자가 자연어 요청을 넣으면 **아무것도 실행하지 않고** 엔진이 무엇을 이해했는지
보여준다.

## 사용법

```bash
pnpm design:preview -- --prompt "로그인 오류를 수정하고 테스트해줘."
pnpm design:preview -- --turns examples/design-preview/correction.json
pnpm design:preview -- --prompt "..." --offline
pnpm design:preview -- --prompt "..." --json
pnpm design:preview -- --prompt "..." --advanced
```

`--offline` 은 결정론적 런타임 추출기만 쓰고 HASA 요청을 보내지 않는다. 기본
경로는 모델에게 요구사항 **후보**를 묻되, 모델 실패는 offline 결과를 대체하지
않고 그 옆에 보고된다 — offline 절반은 그 자체로 완결이기 때문이다.

## 모델이 줄 수 있는 것과 없는 것

```
줄 수 있음    span 좌표 (turnId/start/end), kind, priority, polarity, 설명
줄 수 없음    confirmed, derivedBy, status, sourceText, id,
              실행 가능 여부, 감사 통과 여부, oracle 성공 여부
```

금지 필드를 보내면 **무시하지 않고** `forged_provenance` 로 기록한다. 아무도
보지 못하는 거부는 확인할 수 없는 경계다.

제약: 동적 모델 목록 / 하드코딩 ID 없음 / permitted + chat 만 / Single Model /
요청당 최대 2회 호출 / timeout / AbortSignal / tool call 없음 / streaming 없음 /
파일·명령 없음.

## 출력 계층

기본 보고서는 내부 어휘를 쓰지 않는다. `forbidden`, `ambiguous`,
`MODIFY_WITHOUT_REGRESSION`, `designRuleId` 는 정확한 말이지만, 사용자에게
내밀면 그들이 이해했는지 확인하기 전에 시스템을 배우라는 뜻이 된다 — 이해했는지
아는 사람은 그들뿐인데.

`--advanced` 와 `--json` 이 전부 담는다. JSON 은 다음 사슬을 끊지 않는다.

```
turn → sourceSpan → requirementId → blueprintId → oracleCoverage
     → audit finding → closure history
```

## 확인 질문

다섯 finding 이 일반 문장 질문으로 바뀐다: `REQUIREMENT_CONFLICT`,
`UNRESOLVED_CONDITION`, `SEMANTIC_ALIGNMENT_UNKNOWN`, `NO_DESIGN_RULE`,
`AMBIGUOUS_DECIDED`.

선택지는 제시하고 **고르지 않는다**. 여기서 하나를 고르면 계획이 사용자를 대신해
결정하고 그 사실을 숨기는 것이고, 그것이 이 설계 전체가 막으려는 실패다.

## 개인 사용 fixture

`examples/design-preview/` 에 16개. 기대값은 사람이 쓴 최소치만이고 문장 전체
일치나 출력 스타일은 검사하지 않는다.

`login-fix` 의 `mustContainKinds` 가 비어 있는 것은 기록이다. 금지도 출처도 없는
평범한 기능 요청에서 offline 경로는 요구사항을 만들지 못한다 — 그 자리가 모델
제안이 필요한 지점이다.


# 모델 권한 — 공개 목록은 권한이 아니다

HASA의 `GET /v1/models`는 **공개 endpoint**다. 키 없이도 답한다. 그러므로
목록에 있다는 사실은 이 자격 증명이 그 모델을 호출할 수 있다는 뜻이 아니다.
설계 계층은 한동안 목록의 모든 항목에 `permitted: true`를 붙이고 있었고, 같은
혼동이 과거에 게이트웨이 트랜잭션 로그에 403 다발을 남겼다.

`src/design/modelPermission.ts`는 세 상태를 유지한다.

```
permitted   이 키로 chat 호출이 성공한 기록이 있다
denied      이 키에 대해 게이트웨이가 403 을 반환했다
unknown     아무도 확인한 적이 없다
```

**`unknown` 은 후보가 되지 않는다.** `poolEligibility` 는 `permitted` 가
없으면 eligible 로 흘려보내는데, 그건 라우터가 이미 도달하는 모델을 줄 세우는
함수이기 때문이다. 여기서는 연결을 열지 말지를 정하므로, 근거의 부재를 권한으로
읽지 않는다.

근거는 `.arena/capability-matrix.json` 의 `CapabilityMatrix` 에서 온다. 이
파일은 `keyFingerprint` 와 `baseUrl` 로 범위가 묶여 있고, 둘 중 하나라도
다르면 **다른 자격 증명에 대한 기록**이므로 거부한다. 권한 확인을 위해 공개
목록 전체를 live 호출하지 않는다.

## 설계 계층은 게이트웨이를 직접 다루지 않는다

`fetch`, `/chat/completions` 조립, `Authorization` 헤더, OpenAI `choices`
해석은 전부 Provider 계층의 일이다. 설계 계층은 `LlmProvider.chat()` 이
정규화한 `response.text` 만 본다. 조립은 composition root(`previewCli`)에서
하고, 아래로는 키가 아니라 이미 만들어진 provider 를 넘긴다.

`src/design/modelPermission.test.ts` 의 architecture test 가 이 규칙을 소스에서
직접 검사한다. `src/provider/architecture.test.ts` 는 `src/provider` 만 걷기
때문에, 이 디렉터리의 hand-rolled `fetch` 는 오랫동안 그 검사를 통과했다.

## 모델 선택에서 requirementRecall 을 뺐다

이전에는 Coding Agent sweep 의 `requirementRecall` 로 proposer 모델을 골랐고,
격리된(quarantined) 데이터셋까지 함께 읽었다. 문제는 두 가지였고 격리는 그중
하나였다. `requirementRecall` 은 *에이전트 루프 전체*가 긴 작업 동안 요구사항을
계약에 기록했는지를 잰다. proposer 는 한 번의 호출로 문자 좌표가 든 짧은 JSON
배열을 낸다. 전자가 후자를 예측한다는 근거가 없으므로, 그 순위는 숫자가 얻지
못한 권위였다 — 어느 파일에서 왔는지를 따지기 전에 이미 틀린 지표였다.

그래서 지금은 권한이 확인된 모델을 카탈로그 순서대로 쓰고, **측정된 근거가
없다는 사실을 그대로 말한다.** 이를 바꾸려면 proposer 전용 측정이 필요하다.
