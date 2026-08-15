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

## 12. Auto 이관 지점

현재:

```ts
// agentHost.resolveModel()
const choice = await chooseModel({ models, mode, ... });
```

목표:

```ts
const profile = projectTaskProfile(session.taskContract);
const registry = buildRegistry(listing.models, evaluations);
const recommendation = await recommendModel(profile, registry);
```

**이번 slice에서 배선하지 않았다.** 이유는 순서 문제다: `resolveModel()`은 세션이 열리기 전에 불리고, `TaskContract`는 세션의 첫 턴에서 `record_request`가 만든다. 즉 첫 턴에는 아직 계약이 없다.

가능한 해법은 세 가지이고, 어느 것도 이번 slice의 범위가 아니다.

1. 첫 턴은 Bootstrap 모델로 계약만 만들고, 그 뒤 worker를 고른다 (§5의 경계를 실제로 쓰는 것)
2. 계약이 생긴 시점에 모델을 교체한다 — `AgentSession`이 턴 중간 모델 교체를 지원하는지 확인 필요
3. 두 번째 턴부터 요구사항 기반으로 고른다 — 첫 턴은 현재 Auto

배선 자체가 하나의 slice다.

## 13. 다음 slice

| | 내용 |
|---|---|
| Stage 2 | `SemanticMatcher` 구현 — embedding provider 선택, `semanticDescription` 임베딩 |
| 배선 | §12의 세 해법 중 선택, `resolveModel()` 교체 |
| Persistence | `ModelRecommendation`을 이벤트로 남겨 재현 가능하게 (§22) |
| Fallback | 순위 후보를 실제로 쓰는 것 (§21) |

embedding을 넣어도 되는 조건은 갖춰졌다. `SemanticMatcher`는 교체 가능한 인터페이스이고, `semantic` 항은 breakdown에서 독립적이며, 그것이 최종 답이 될 수 없다는 것이 테스트로 고정돼 있다.

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
