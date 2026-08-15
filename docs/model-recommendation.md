# Requirement-Aware Model Recommendation

사용자의 요구사항으로부터 **이 작업에 맞는 모델 하나를** 고르는 계층. 가장 강한 모델이 아니라 가장 적합한 모델이다.

## 0. 이 문서가 지키는 한 줄

> 모델을 여러 개 돌려 이긴 것을 고르는 것은 온라인 기본 전략이 아니다.
> 요구사항을 먼저 읽고, 맞는 모델 하나를 고른 뒤, 그 모델로 실행한다.

## 1. 감사 결과 — 무엇이 실제로 있었는가

방향 전환을 설계하기 전에 현재 구조를 감사했고, 문서와 코드가 달랐다.

| 이름 | 문서상 | 코드상 |
|---|---|---|
| `TaskAnalyzer` | Z4 예정 | **없음** |
| `AgentRouter` | Z4 예정 | **없음** |
| `StrategySelector` | Z4 예정 | **없음** |
| `best_of_n` | Z5 예정 | **없음** |
| Arena (`src/core/`) | 제품의 중심 | 존재하나 **확장에서 도달 불가** |

`extension/src/` 어디에도 `src/core/` import가 없다. 즉 **온라인 경쟁 구조는 구현된 적이 없다.** Arena는 CLI(`pnpm arena`)와 오케스트레이터 서버 전용이다.

따라서 이번 전환은 "경쟁을 제거하는 것"이 아니다. 제거할 경쟁이 온라인에 없다. 실제로 바뀌는 것은 하나다:

```
Auto가 mode만 보던 것을 → 요구사항을 보게 한다
```

### 현재 Auto가 실제로 하는 일

`src/agent/autoModel.ts` · `chooseModel()`

**입력**: 모델 카탈로그 + `AgentMode` 4값(`code`/`architect`/`debug`/`ask`) + 선택적 실측

**순서**:
1. `requirementFor(mode)` → `"coding"` 또는 `"chat"` — 모드가 파일을 쓸 수 있는지만 본다
2. `rankModels()` → ① 측정된 적합 모델 우선 ② `maxOutputTokens` 큰 순 ③ 게이트웨이 순서
3. 이미 맞는 것이 있으면 그것, 없으면 텍스트 프로토콜 후보, 없으면 최대 3개 실측, 그래도 없으면 1순위 추측

**사용자 요구사항은 어디에도 들어가지 않는다.** 같은 모드면 "오타 고쳐줘"와 "30개 파일 고치고 테스트까지"가 완전히 같은 모델을 받는다.

### 호출 경로

```
webview → controller → AgentHost.send
    → ensureSession → resolveModel()
        ├─ 사용자가 직접 고른 모델이 있으면 그것
        └─ 없으면 chooseModel({ models, mode, knownUsableModelId, measure, signal })
    → createModelFor({ provider, modelId, toolProtocol })
    → AgentSession.open(...)          ← 여기부터 기존 C4 하네스
```

`resolveModel()`이 유일한 선택 지점이다. Router가 들어갈 자리도 여기 하나뿐이다.

## 2. 새 온라인 흐름

```
User Message
    ↓
Bootstrap Interpreter            현재 경로 그대로 (record_request)
    ↓
TurnContract → TaskContract      turnContract.ts, 기존
    ↓
TaskProfile                      router/taskProfile.ts  ← 신규
    ↓
EligibilityFilter                router/eligibility.ts  ← 신규
    ↓
ModelRecommender                 router/recommend.ts    ← 신규
    ↓
Selected Worker Model
    ↓
AgentSession                     기존 C4 하네스
    ↓
Verified Result
```

Arena는 이 경로에 없다. 아래 §7.

## 3. 책임 분리

| 계층 | 파일 | 책임 | 상태 |
|---|---|---|---|
| Requirement Interpreter | `agent/turnContract.ts` | 산문 → 검증된 계약 | 기존, 무변경 |
| TaskProfiler | `router/taskProfile.ts` | 계약 → 능력 요구 + 하드 제약 | 신규 |
| ModelRegistry | `router/modelRegistry.ts` | 카탈로그 + 평가 → ModelProfile | 신규 |
| EligibilityFilter | `router/eligibility.ts` | 하드 제약 위반 후보 제거 | 신규 |
| ModelRecommender | `router/recommend.ts` | 점수·순위·이유 | 신규 |
| ModelSelector | (recommend의 `selected`) | 1순위 채택 | 신규 |
| AgentSession | `agent/session.ts` | 실행 | 기존, 무변경 |

`AgentRouter`라는 이름은 쓰지 않았다. 코드에 존재한 적이 없어 충돌이 없고, "router"는 무엇을 라우팅하는지 말하지 않는다. `ModelRecommender` / `ModelSelector`가 하는 일을 말한다.

## 4. Bootstrap 문제

```
모델을 고르려면 TaskProfile이 필요하다
TaskProfile을 만들려면 TurnContract가 필요하다
TurnContract를 만드는 것도 LLM이다
```

순환이다. 끊는 방법은 두 역할을 **다른 것으로 인정하는 것**이다.

```
Bootstrap Interpreter   계약을 만드는 모델   ← 이번 slice에서 최적화하지 않음
Worker Model            일을 하는 모델       ← Router가 고르는 대상
```

둘이 같은 모델일 필요는 없다. 이번에는 기존 경로(현재 선택된 모델이 `record_request`를 호출)를 그대로 쓰고, **경계만 문서와 타입에 새겨 둔다.** Bootstrap 모델 선택은 별도로 평가할 수 있는 독립 문제다.

## 5. TaskProfile — 투영이지 재해석이 아니다

```
TurnContract / TaskContract  →  TaskProfile
```

이 화살표가 단방향인 것이 핵심이다. TaskProfile은 원문을 다시 읽지 않는다. 다시 읽으면 해석기가 두 개가 되고, **같은 문장에 대한 두 해석은 어긋날 자리다.**

그래서 모든 필드는 계약의 어느 요소에서 왔는지 말할 수 있다.

### 섞지 않는 두 종류

| | 무엇 | 어떻게 쓰이는가 |
|---|---|---|
| `demands` · `priorities` | 능력 요구, 최적화 선호 | **점수** — 다른 강점으로 상쇄 가능 |
| `constraints` | 사용자가 하지 말라고 한 것 | **필터** — 점수로 못 넘음 |

"실행하지 마"는 아무리 높은 점수로도 살 수 없는 것이다. 섞으면 하드 요건을 못 맞추는 모델이 점수로 이긴다.

### 세 fixture (§15)

| | 요구사항 | complexity | 주요 demand | constraints |
|---|---|---|---|---|
| A. "README 오타만" | 1개 | `low` | coding 0.9, toolUse 0.7 | 없음 |
| B. "30개 파일 분석·수정·테스트" | 4개 | `high` | coding·toolUse·debugging·cmdExec·recovery | 없음 |
| C. "실행·수정 말고 분석만" | 1개 | `low` | instructionFollowing 0.9, reasoning | `noExecute`, `noModify` |

A가 `low`인 것이 중요하다. `modify` intent 하나로 complexity를 올리면 한 줄 수정에 대형 모델을 붙이게 된다. **complexity는 요구사항의 양에서 나오고, intent는 종류만 말한다.**

## 6. ModelProfile — 숫자와 그 숫자를 믿을 이유

능력은 맨 숫자가 아니라 `Measure`다.

```ts
interface Measure {
  value: number;
  origin: "declared" | "benchmark" | "harness_eval" | "observed" | "manual";
  samples: number;
  updatedAt?: string;
}
```

`coding: 0.9`가 120회 측정에서 나온 것과 설정 파일에 손으로 적힌 것은 같은 숫자이고 같은 주장이 아니다. 구분하지 못하는 ranker는 **가장 낙관적으로 적힌 쪽을 선호한다.**

### 병합 규칙

강한 origin이 이긴다. 같은 origin이면 sample이 많은 쪽이 이긴다. **평균 내지 않는다** — 선언과 측정을 평균하면 어느 쪽도 지지하지 않는 제3의 숫자가 나오고, 둘이 불일치했다는 사실이 묻힌다.

### 이름은 증거가 아니다

`profileFromCatalogue`의 `semanticDescription`에 model id를 넣지 않는다. `qwen2.5-coder-32b`는 이름에 coder가 있고 게이트웨이가 도구 호출을 막았다. 이름이 embedding에 들어가면 이 설계가 닫은 문으로 마케팅이 다시 들어온다.

### reference 모델은 모델 데이터가 아니다

`reference:good` / `sloppy` / `stubborn` / `overclaimer`는 **평가기 자체를 검증하는 fixture**다. 손으로 쓴 행동이다. 이것으로 ModelProfile을 만들면 테스트 더블을 벤치마킹하는 것이 된다. `applyEvaluation`과 `buildRegistry`가 prefix로 거부한다.

### 1회 실행은 특성이 아니다 (§12)

`MIN_SAMPLES_FOR_EVIDENCE = 3` 미만이면 숫자는 남기되 origin을 `declared`로 낮춘다. 값은 살아남고 **권위는 살아남지 않는다.** 운 좋은 1회가 100회 측정을 이길 수 없다.

## 7. Arena — 삭제하지 않고 오프라인으로

```
BEFORE (문서상)          AFTER
Arena = 제품             Arena = 오프라인 평가 엔진
       inference-time            ModelProfile 데이터 생산
       경쟁                      명시적 비교 모드
```

바뀌는 것은 **역할이지 코드가 아니다.** `src/core/`, `pnpm arena`, `/runs`, `/code-runs`, judge, refine, 판정 사다리 전부 그대로 둔다. 온라인 기본 경로에 들어가지 않을 뿐이다.

| | 온라인 | 오프라인 |
|---|---|---|
| 담당 | `src/router/` | `src/core/` (Arena), `src/eval/` (C4.7) |
| 모델 수 | **1개** | 여러 개 |
| 목적 | 이 요청을 처리 | 모델 특성 측정 |
| 트리거 | 매 턴 | 명시적 실행 |

C4.7 지표 → ModelProfile 매핑은 좁고 명시적이다. 지표를 통째로 훑지 않는다 — 어떤 지표가 어떤 능력을 뜻하는지는 누군가 결정한 것이고, 그 결정을 적어두는 것이 profile과 숫자 더미의 차이다.

| C4.7 지표 | ModelProfile 능력 |
|---|---|
| `requirementRecall` | `instructionFollowing` |
| `firstActionCorrect / Checked` | `toolUse` |
| 1 − invalid invocation rate | `commandExecution` |
| `recoveryRate` | `recovery` |
| `sourceFactRecall` | `sourceGrounding` |
| `Efficiency.modelCalls` | `efficiency.modelCalls` |
| `containmentRate` | **매핑하지 않음** — 하네스가 버틴 것이지 모델이 잘한 것이 아니다 |

## 8. Eligibility — 점수보다 먼저

```
전체 모델
   ↓  EligibilityFilter        ← 점수가 존재하기 전
후보 모델
   ↓  ModelRecommender
순위
```

이 순서가 §31을 구조적으로 보장한다. ranker는 부적격자가 **이미 없는** 목록을 받으므로, similarity가 아무리 높아도 하드 제약을 이길 방법이 없다.

| 코드 | 언제 |
|---|---|
| `MODEL_UNAVAILABLE` | 게이트웨이가 사용 불가로 보고 |
| `CANNOT_CONVERSE` | 대화 자체가 안 됨 (embedding/reranking) |
| `CONTEXT_TOO_SMALL` | 요구 컨텍스트 미달 |
| `TOOL_CALLING_REQUIRED` | 네이티브 도구 호출 필수인데 미확인 |
| `PROTOCOL_INCOMPATIBLE` | 요구 프로토콜 불일치 |
| `USER_FORBIDDEN` | 사용자가 배제 |
| `NOT_IN_ALLOWLIST` | 허용 목록 밖 |

**컨텍스트가 `null`인 모델은 제외하지 않는다.** 카탈로그가 침묵한 사실로 후보를 떨어뜨리는 것은 측정되지 않은 능력을 실격으로 읽는 것과 같은 실수다. Auto가 이미 그렇게 하지 않는다.

## 9. 점수 — 네 항이 끝까지 따로 산다

```
Final = w₁·semantic + w₂·capability + w₃·evaluation + w₄·efficiency
```

기본 가중치는 `0.15 / 0.40 / 0.30 / 0.15`. **하나의 불투명한 함수로 만들지 않는다.** §17이 답해야 하는 질문 때문이다.

> B는 왜 떨어졌는가?

"점수가 0.71이라서"는 답이 아니다. "recovery 평가가 약했고 이 작업은 recovery를 요구한다"가 답이다. 그래서 `ScoreBreakdown`이 결과에 그대로 실린다.

- **semantic** — 다음 slice의 embedding 자리. 지금은 상수 0.5를 반환하는 `neutralMatcher`. 어휘 겹침 같은 임시방편을 쓰지 않은 이유는, 그것이 측정처럼 보이는 숫자를 만들고 거기에 맞춘 테스트가 그 우연을 고정하기 때문이다.
- **capability** — demand로 가중한 능력. **모르는 능력은 0이 아니라 0.5**다. 침묵을 무능으로 채점하면 cold start 모델이 나쁘다고 측정된 모델보다 아래로 간다.
- **evaluation** — `harness_eval`과 `observed`만 센다. 선언은 평가가 아니다.
- **efficiency** — task의 speed/cost 선호로 스케일된다. 무거운 작업에서는 선호가 0.2이므로 **싸다는 이유로 이길 수 없다.**

### 결정성 (§23)

동점 처리 순서:
1. 점수
2. 요구된 능력 중 **아는 것이 많은** 쪽
3. 평가 sample이 많은 쪽
4. model id (사전순)

`sort`의 우연에 맡기지 않는다. 저장된 추천 이유가 일주일 뒤에도 재현되지 않으면 그 기록은 허구다.

## 10. 제약 누락이 Router에 미치는 영향 (§8)

실측된 문제다. 라이브 실행에서 **같은 문장**에 대해:

- exaone → `no_execute` 기록
- gpt-oss → 누락

Router 입력은 계약이고, 계약은 모델이 만든다. 따라서 **Router의 입력은 추출만큼만 완전하다.**

이번 slice에서 한국어 regex로 때우지 않는다. 그것이 `turnContract.ts`가 명시적으로 거부한 길이다. 대신:

- `TaskProfile.extractionQuality`는 **production에서 항상 부재**한다. 런타임은 사용자가 말한 것 중 무엇이 누락됐는지 알 수 없고, 알 수 없는 값을 가짜 confidence로 만드는 것이 §8이 금지한 것이다.
- 평가기는 다르다. 시나리오가 기대 요구사항을 선언하므로 `src/eval`이 이 필드를 채울 수 있고, **입력이 불완전할 때 Router가 어떻게 동작하는지** 테스트할 수 있다.
- 제약이 기록되지 않으면 `constraints.noExecute`는 `undefined`다. **없는 것으로 취급한다.** 있는 척하는 것보다 낫다.

이 한계는 테스트에 남아 있다 (`§8 — an extraction that recorded no constraint yields no constraint`).

## 11. 선택은 전략이 아니다 (§19)

```
어떤 모델을 쓸 것인가?      ModelSelector
어떤 전략으로 실행할 것인가?  StrategySelector (미구현)
```

합치지 않는다. `ModelRecommendation`에는 `strategy` 필드가 없고, 그것을 확인하는 테스트가 있다 — 나중에 추가하는 것이 **의도적인 행위**가 되도록.

온라인 기본값은 `strategy = single`이다. Arena/`best_of_n`은 별도의 명시적 전략으로 남는다.

## 12. Auto 배선 — R3에서 완료

R2에서 미뤘던 순서 문제를 Bootstrap Interpreter로 끊었다.

```
send(prompt)
  → routeTurn()                        ← 신규, 모델을 고르기 전에 실행
      ├─ 사용자가 모델을 골랐으면 → origin:"user", 라우팅 안 함
      ├─ Bootstrap Interpreter          도구 표면 = record_request 하나
      │     실패 → unroutedEvent(fallback) + notice, 기존 선택으로 진행
      ├─ projectTaskProfile(merge(previous, contract))
      ├─ buildRegistry(listing.models)
      └─ routeTurn(...)                 → WorkerDecision
  → ensureSession(forward, decision.modelId)
  → session.restoreContract(recorded)   ← worker가 계약을 상속
  → session.send(prompt)
```

### Bootstrap이 일을 하지 않는 이유

도구 표면이 **하나**다. "안전한 부분집합"이 아니라 `record_request` 하나. 파일을 쓸 수 있는 bootstrap은 worker가 정해지기도 전에 도는 두 번째 에이전트이고, 그 위에는 승인도 preflight도 checkpoint도 없다. 그 스위치는 **존재하지 않는 것이 가장 안전한 버전**이라 만들지 않았다.

### 계약을 두 번 만들지 않는 이유

acquisition gate는 `contract.lastTurnId === turnId`만 본다. Bootstrap이 **사용자 턴의 id로** 계약을 만들면 그 조건이 이미 성립하므로, worker는 `record_request`를 다시 부를 이유가 없다. 두 번 부르면 router가 순위를 매긴 계약과 worker가 지키는 계약이 달라진다.

`parseTurnContract(args, turnId)`에 넘기는 id는 **사용자의 턴**이다. Interpreter는 문장을 어떻게 읽었는지이지 누가 말했는지가 아니고, interpreter를 source로 적으면 모델이 사용자 요구사항의 저자가 된다.

### 실패는 조용하지 않다

Bootstrap이 실패하면 `selectionOrigin: "fallback"` 이벤트에 사유를 적고 notice를 띄운 뒤 기존 선택으로 진행한다. 조용히 mode-only로 돌아가면 요구사항 기반 경로를 우회하면서 동작하는 것처럼 보이고, **그 상태에서는 이 전체가 반증 불가능해진다.**

## 13. Worker 안정성

매 턴 다시 고르면 점수가 조금 움직일 때마다 worker가 바뀐다. Turn 1은 A, turn 2는 B, turn 3은 다시 A — 한 task 안에서 세 모델이 각자 다르게 읽은 대화를 이어받는다.

그래서 기본은 **affinity**다. worker를 바꾸려면 점수가 아니라 **task에 대한** 이유가 있어야 한다.

| relation | 동작 |
|---|---|
| `continue` / `question` / `refine` | worker 유지 (`carried`) |
| `correct` | **유지** — 같은 task를 명확히 하는 것이다 |
| `correct` + 하드 제약 변경 | 재추천 (`eligibility_changed`) |
| `new_task` | 재추천 |
| 사용자가 모델 지정 | 라우팅 안 함 (`manual`) |

비교하는 것은 **하드 제약뿐**이다. demand와 priority는 refine마다 움직이므로 그것까지 보면 매 턴이 재추천이 되고, 그게 막으려던 thrashing이다.

## 14. 결정의 영속화

새 이벤트는 **하나**다: `model_recommended`. 나머지는 전부 기존 이벤트의 투영이다.

무엇을 담는가:

```
selectionOrigin      recommendation | user | bootstrap | carried | fallback
selectedModelId
bootstrapModelId     계약을 읽은 모델 — worker와 구분된다
alternatives[]       순위 후보 (향후 fallback용)
filteredOut[]        탈락자와 코드
scoreBreakdown       네 항
reasons[]            reason code
taskProfileFingerprint
routerVersion
```

무엇을 담지 않는가: **ModelProfile 전체**. 카탈로그를 모든 턴에 복사하면 registry가 소유한 것의 두 번째 사본이 생기고, 모델이 재평가되는 순간 어긋난다. fingerprint가 "같은 입력이었다"를 말하고 profile은 registry가 갖는다.

### 과거는 다시 계산하지 않는다

`selectedWorkerFor`는 **이벤트를 읽는다.** 오늘의 registry로 과거 결정을 재계산하면 아무도 묻지 않은 질문에 답하는 것이고, 그 답은 그 턴이 실제로 쓴 것과 다르다. 테스트가 이것을 고정한다 — registry를 비워도 저장된 선택은 움직이지 않는다.

### Branch는 공짜로 맞는다

`selectedWorkerFor`와 `actionLedger`는 **호출자가 준 이벤트**를 읽는다. `restoreEvents(turns, head)`가 그 branch의 chain을 주므로, 다른 branch의 이벤트는 애초에 입력에 없다. 격리가 기억해야 할 규칙이 아니라 입력의 성질이다.

## 15. Action은 새 저장소를 만들지 않는다

두 번째 로그(`action-history.json`)를 만들지 않았다. 같은 사실의 두 기록은 정확히 문제되는 경로에서 어긋난다.

lifecycle은 **이미 있는 이벤트에서 읽는다.** 미묘한 부분이 하나 있다: 보류된 호출은 `tool_start` 없이 `tool_end(ok:false)`만 나오므로 `tool_completed(status: failed)` 하나가 된다. 그래서 세 가지가 같은 status를 쓰고 있다.

```
exit 1로 끝난 명령
요청에 답하지 않아 보류된 명령
사용자가 금지해서 거부된 명령
```

구분자는 런타임이 `detail`에 넣은 코드이고, 그것은 저장된다. `proposed`와 `executed`가 별도 필드인 이유가 이것이다 — 런타임이 이미 강제하는 구분이 대화를 다시 여는 순간 사라지면 안 된다.

```
PROPOSED   tool_started 또는 held-back tool_completed
DEFERRED   detail이 ACTION_REQUIRES_JUSTIFICATION / TURN_CONTRACT_REQUIRED
DENIED     detail이 ACTION_DENIED_BY_CONSTRAINT, 또는 status denied
EXECUTED   도구에 도달해서 실제로 돈 것만
```

모델 귀속도 파생이다. 한 턴에는 worker가 하나이므로 `turnId → model_recommended → selectedModelId`가 정확하고, 모든 tool 이벤트에 modelId를 복사하는 것이 바로 이 파일이 피하려는 두 번째 사본이다.

**Action이 기록됐다는 것과 workspace가 바뀌었다는 것은 다르다.** 거부된 `write_file`은 진짜 제안의 진짜 기록이고 변경의 증거는 아니다. `changedWorkspace`가 그 둘을 나눈다.

## 16. Interpreter 실패와 Worker 실패

`bootstrapModelId`와 `selectedModelId`를 따로 적는다. 그래야 나중에 이렇게 물을 수 있다.

```
제약이 누락됐다  →  Interpreter가 못 읽은 것인가?
계약을 어겼다    →  Worker가 안 지킨 것인가?
```

둘을 한 칸에 적으면 §10의 constraint omission이 worker의 tool compliance 문제로 잘못 집계된다.

## 17. Semantic — 아무것도 재지 않던 항

R2/R3에서 `semantic`은 상수 0.5였다. 실제로 붙이려다 알게 된 것은 임베딩 모델의 문제가 아니라 **입력의 문제**였다.

```
Task  : "실시간 회의록 시스템을 만들어 주세요. 화자 분리. 배포 구성."   ← 사용자의 도메인 언어
Model : "코드 작성이 확인된 모델, 네이티브 도구 호출 지원, 컨텍스트 128000 토큰"
                                                            ← 능력 플래그를 문장으로 쓴 것
```

이 둘의 cosine은 "회의록 시스템"이 "도구 호출 지원"과 얼마나 닮았는지를 묻는다. 그리고 그나마 재는 것이 능력 플래그인데, `capabilityScore`가 그것을 이미 0.40으로 채점한다 — **0.15를 써서 이미 센 증거를 다시 센다.**

### 다섯 축을 섞지 않는다

| 축 | 묻는 것 |
|---|---|
| Eligibility | 쓸 수 있는가 |
| **Semantic** | **어떤 도메인·작업 종류에 관한 것인가** |
| Capability | 필요한 능력이 있는가 |
| Evaluation | 이 하네스에서 실제로 잘했는가 |
| Efficiency | 비용·속도는 어떤가 |

`validateModelSemanticProfile`이 이것을 주석이 아니라 코드로 강제한다 — 품질 형용사, 평가 수치, 프로토콜·컨텍스트 메타데이터를 전부 거부한다.

### 모델 쪽에는 임베딩할 도메인 정보가 없었다

게이트웨이 카탈로그에는 id·owner·능력 tristate·limit 두 개뿐이고 **설명 필드가 없다.** 대체할 만한 두 가지는 둘 다 틀렸다.

- **이름은 증거가 아니다.** `qwen2.5-coder-32b`는 id에 coder가 있고 그 배포는 도구 호출이 꺼져 있다. `granite-guardian-3.1-8b`는 이름만으로는 무엇이든 될 수 있고 실제로는 안전성 분류기다. 이름 휴리스틱은 **양방향으로** 틀린다.
- **probe도 이 축에서는 증거가 아니다.** 대화와 도구 호출이 되는지를 재고, 그건 capability이며 이미 다른 데서 채점된다.

남는 것은 사람이다. 그래서 `origin: "manual"`, 필수 `source`, 그리고 `reviewed: false`.

### `reviewed: false`가 뜻하는 것

현재 4개 항목 전부 **published model documentation을 근거로** 작성했고 이름에서 추론하지 않았다. 그리고 **이 프로젝트에 권한을 가진 누구도 승인하지 않았다.** 쓸 수는 있고(프로필이 없는 것보다 낫다) `semanticProfileFor`가 `curated` / `unreviewed` / `cold_start`를 구분해 돌려준다.

먼저 검토할 것은 `granite-guardian-3.1-8b`다 — capability probe가 기계적 근거만으로 response·patch·judge 자격을 줬고, 문서는 훨씬 좁은 것을 말한다. **이 큐레이션 계층이 존재하는 이유가 그 한 줄이다.**

### 부분 큐레이션은 하지 않는다

프로필이 없는 모델은 neutral 0.5를 받고, 있는 모델은 높거나 낮게 받는다. 절반만 큐레이션하면 **안 쓴 모델이 이유 없이 중간에 몰린다.** `coverageOf`가 커버리지를 묻는 함수인 이유고, cold start가 여전히 후보인 이유다.

## 18. 임베딩 — Vector DB 없이

이 키가 대화할 수 있는 모델은 4개다. 30개가 돼도 한 턴은 **task 임베딩 1회 + 메모리 안 벡터 30개와의 cosine**이다. 인덱스는 전수 스캔을 피하려고 있는 것이고, 여기서는 전수 스캔이 싼 쪽이다.

비싼 것은 검색이 아니라 **호출**이다. 매 턴 모델 임베딩을 다시 계산하면 메시지마다 모델 수만큼 왕복이 생긴다. `EmbeddingCache`는 **렌더된 텍스트의 fingerprint + 임베딩 모델 id**로 키를 잡는다 — 프로필이 수정되면 새 키를 받아 낡은 벡터를 재사용할 수 없고, 임베딩 모델이 바뀌면 전부 한 번에 무효화되어 두 공간의 벡터가 한 비교에 섞이지 않는다.

**cosine은 [0,1]로 옮긴다.** 원본은 −1까지 내려가고, 음수 유사도에 양수 가중치를 곱하면 나머지 세 항이 모두 비음수인 점수에서 **혼자만 빼기가 된다.**

### 다국어여야 한다

큐레이션된 모델 설명은 영어이고 사용자는 한국어로 쓴다. 단일 언어 임베딩은 모든 쌍에 대해 평평한 0.5를 돌려주고, 그러면 semantic 항은 다시 아무것도 재지 않는다 — 이번에는 **그럴듯한 숫자가 나오므로 눈에 띄지 않게.** 이 키가 이미 허용하는 `bge-m3`가 다국어다.

### `carried` / `restored`는 임베딩 0회

`routeTurn`이 그 분기에서 `recommendModel`을 아예 부르지 않으므로 matcher도 불리지 않는다. "이어서 해줘"는 임베딩 호출 0, 추천 호출 0이다. 테스트로 고정했다.

## 19. RouterPolicy

가중치는 `recommend.ts`의 상수였고, 그래서 사실처럼 보였다. 사실이 아니다.

이름 없는 상수가 조용히 움직이면 **지난달의 추천을 설명할 수 없다.** "같은 profile인데 왜 그때는 A이고 지금은 B인가"의 답이 둘(registry가 바뀌었다 / policy가 바뀌었다)인데 구분할 방법이 없다. `requirement-router-v1`이라는 id가 결정과 함께 저장되므로 이제 답이 있는 질문이다.

`policyById`는 모르는 id에 대해 **오늘의 정책으로 대체하지 않고 null을 준다.** 이 빌드가 갖지 않은 정책으로 내려진 결정은 이 빌드가 설명할 수 있는 결정이 아니다.

## 20. 다음 slice

| | 내용 |
|---|---|
| 큐레이션 검토 | 4개 항목을 프로젝트 소유자가 승인 → `reviewed: true` |
| 실제 provider | `bge-m3` 임베딩 엔드포인트를 `EmbeddingProvider`로 구현 |
| Task domains | `record_request`에 도메인 축을 더할지 — 지금은 부재가 정직한 상태 |
| Bootstrap 선택 | mode-only 선택기 재사용 중. 이것 자체를 평가 대상으로 |
| Fallback | `alternatives[]`를 실제로 쓰는 것 |
| Observed profile | action ledger를 `observed` 신호로 승격 |

## 14. 지키는 것

```
Requirement           ≠  Plan
TaskProfile           ≠  Raw Prompt
ModelProfile          ≠  Marketing Description
Embedding Similarity  ≠  Final Recommendation
Benchmark Score       ≠  Universal Model Quality
Arena Winner          ≠  Universal Best Model
Model Selection       ≠  Agent Strategy
Declared              ≠  Measured
One Run               ≠  A Characteristic
Reference Model       ≠  Real Model Data
```
