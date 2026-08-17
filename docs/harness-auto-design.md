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

## 확정 권한은 출처가 정한다

`confirmed`는 계획이 묻지 않고 행동해도 되는 표시다. 모델이 자기 제안에 그것을
붙일 수 있으면 자기 해석을 사실로 승격시킬 수 있다. 그래서 권한을 **출처**로
고정한다.

```
runtime_prohibition   confirmed   런타임이 원문에서 읽음
runtime_source        confirmed   같음
model_proposal        ambiguous   무엇을 보내든 항상
carried               이전 값 유지
system_baseline       confirmed, explicit 불가
사용자 승인            confirmed   다음 턴에서 사용자가 동의
```

`confidenceFor`가 유일한 결정 지점이다. 모델의 `confidence`는
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
