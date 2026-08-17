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
