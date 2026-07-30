# HASA Agent Arena — 판정 사다리와 개선 루프 재설계

> 상태: **실행 계획**. §3의 여섯 단계를 순서대로 구현하며, 각 단계는 독립적으로 배포 가능하다.
> 각 단계의 "프롬프트"는 그 단계를 착수하는 사람(또는 에이전트)에게 주는 작업 명세다.

---

## 1. 왜 고치는가 — 실측된 결함

`.arena/runs`의 실행 기록이 근거다. 추측이 아니다.

```
07-30T13:48 | response | no_winner  |        | tie            | true
07-30T13:49 | response | winner     | judge  | judge_only     | true
07-30T13:50 | response | winner     | judge  | judge_only     | true
07-30T13:52 | response | winner     | judge  | judge_only     | true
07-30T13:53 | response | winner     | judge  | judge_only     | true
07-30T13:56 | response | no_winner  |        | unstable_judge | true
```

`reviewReason`을 도입한 커밋(6c90625) **이후**의 응답 모드 런 6개가 전부 `requiresHumanReview: true`다.
승자가 나온 4개는 모두 `judge_only`. 그 커밋이 코드 모드에서 고친 결함 — "거의 모든 분기에서 켜지는
플래그는 아무것도 구분하지 못한 채 책임만 넘긴다" — 이 응답 모드에서 그대로 남아 있었다.

### 결함 1 — `judge_only`는 런의 속성이 아니라 모드의 속성이다

응답 모드에는 객관 게이트가 없으므로 이 값은 **항상** 참이다. 런마다 변하지 않는 값은 런의 판정 필드에
실릴 자격이 없다. 이것은 "이 판정을 믿을 수 있는가"에 대한 답이 아니라 "이 모드에는 어떤 증거 축이
있는가"에 대한 답이며, 후자는 결과 메타데이터에 속한다.

### 결함 2 — 판단 불가를 선언하는 시점이 너무 이르다

현재 판정은 judge 한 모델에 AB/BA 두 번 호출이 전부다. 갈리면 즉시 종료하고 사람에게 넘긴다.
그러나 아직 쓰지 않은 수단이 남아 있다 — 같은 judge의 자기일관성 반복, 다른 judge 모델, 두 후보를
가르는 검증 가능한 주장을 뽑아 기계로 확인하기.

> **"판단할 수 없다"는 결론은 더 쓸 수단이 없을 때만 정직하다.**
> 한 번 해보고 애매해서 넘기는 것은 유보가 아니라 조기 포기다.

### 결함 3 — 평가 결과가 생성으로 되먹임되지 않는다

judge가 만든 `reasons`·`concerns`는 저장된 뒤 어디에도 쓰이지 않는다. 현재 구조는 N개를 한 번씩 뽑아
argmax를 고르는 **best-of-N 선택**이지 최적화가 아니다. "local optimal"이 성립하려면 이웃 해를
만들어보고 더 나은 것이 없음을 확인해야 하는데, 이웃을 만드는 코드가 존재하지 않는다.

### 결함 4 — 공정성 불변식이 최적화를 금지하는 형태다

`assertFairness`는 `modelId` 외 모든 필드가 후보 간 동일할 것을 요구한다. "어느 모델이 나은가"를
측정할 때는 옳지만, 개선 루프에서는 2라운드 후보의 입력이 1라운드와 다르다. 공정성은 **런의 속성이
아니라 비교 한 쌍의 속성**으로 재정의해야 한다.

### 결함 5 — 응답 모드에 객관 축이 아예 없다

결함 1은 플래그를 고쳐서 해결되지 않는다. 응답 모드에 검증 가능한 축을 만들어야 `reviewReason: null`이
정당해진다.

---

## 2. 목표 구조

### 2.1 판정 사다리 — 유보는 마지막 계단에서만

| 단계 | 내용 | 산출 증거 |
|---|---|---|
| S0 | 결정론적 검사 — 코드 모드는 게이트, 응답 모드는 `checks` | pass/fail |
| S1 | blind pairwise AB/BA | 일치 / 불일치 |
| S2 | 자기일관성 — 같은 judge를 temperature>0으로 k회, 다수결 | 일치율 |
| S3 | judge 앙상블 — 다른 judge 모델로 반복 | 모델 간 합의 |
| S4 | 차별화 심문 — "가르는 검증 가능한 주장"을 받아 기계로 확인 | 객관 증거 |
| S5 | 사람 | — |

**규칙: `reviewReason`은 사다리를 소진했거나 예산이 끝났을 때만 non-null이며, 어느 단계에서 왜
멈췄는지를 `ladderTrace`에 함께 싣는다.** 그래야 사람에게 넘기는 근거가 곧 시도 기록이 된다.

`reviewReason` 값:

| 값 | 의미 |
|---|---|
| `null` | 사다리 어느 단계에서 결론이 났다 (`decidedAt`에 단계 기록) |
| `undecidable` | 사다리를 끝까지 돌렸는데 갈렸다 — 진짜 판단 불가 |
| `budget_exhausted` | 예산이 먼저 끝났다 — 예산을 주면 결론이 날 수도 있다 |
| `never_compared` | 생존 후보 1개 — 비교 자체가 없었다 |
| `judge_unavailable` | judge가 파싱 가능한 출력을 못 냈다 — 불일치가 아니라 도구 고장 |

`judge_only`는 삭제하고, 결과에 `evidenceAxes`를 실어 모드의 성질을 표현한다.

### 2.2 개선 루프 — local optimal을 정의 가능하게

```
round 0 (탐색):  N개 모델 × 1 샘플 → 사다리로 평가 → incumbent 선출
round r (개선):  incumbent에 대해 이웃 생성
                neighbor = 같은 모델 + 같은 과제 + critique(검증 가능한 결함 목록)
                incumbent vs neighbor 를 blind pairwise (사다리 동일 적용)
                neighbor 승 → incumbent 교체 / 패 또는 무승부 → 이 후보는 수렴
종료:  모든 후보 수렴 | 라운드 예산 소진 | 개선 실패
```

두 가지가 핵심이다.

1. **critic ≠ judge.** 개선을 지시하는 모델과 심사하는 모델이 같으면 judge의 취향에 최적화된다(Goodhart).
2. **incumbent 단조성.** 라운드는 blind pairwise에서 incumbent를 **이겨야만** 챔피언을 교체한다.
   이 규칙 덕분에 최종 출력이 구조적으로 round-0 최고 샘플보다 나쁠 수 없다.

이때 비로소 local optimum이 측정 가능한 문장이 된다 —
**"이 후보에 대해 k회의 개선 시도가 모두 incumbent를 이기지 못했다."**

### 2.3 공정성 재정의

```ts
type ComparisonKind =
  | "model"       // modelId만 다름 — "어느 모델이 나은가"
  | "refinement"  // 모델 동일, 입력만 다름 — "개선됐는가"

assertComparable(a, b, kind)   // kind에 따라 무엇이 같아야 하는지가 다르다
```

두 종류의 verdict는 **같은 순위표에 섞이지 않는다.** 섞으면 두 질문의 답이 서로를 오염시킨다.

---

## 3. 실행 단계와 프롬프트

각 단계는 `pnpm test`와 `pnpm typecheck`가 통과해야 완료로 친다.

### 단계 1 — `judge_only` 제거, 증거 축 분리

> **프롬프트**
> `src/protocol/run.ts`의 `ReviewReasonSchema`에서 `judge_only`를 삭제하고, `judge_unavailable`을
> 추가하라. `RunResultSchema`에 `evidenceAxes: ("objective" | "judge")[]`를 추가한다 — 응답 모드는
> `["judge"]`, 코드 모드는 `["objective", "judge"]`다.
>
> `src/core/runManager.ts`의 `evaluate`에서, AB/BA가 일치해 승자가 정해진 분기의 `reviewReason`을
> `null`로 바꾼다. 근거: 그 값은 응답 모드의 모든 런에서 참이므로 런당 0비트를 전달하며, 커밋
> 6c90625가 코드 모드에서 제거한 것과 같은 결함이다.
>
> judge 출력 **파싱 실패**를 판정 **불일치**와 분리하라. 현재 두 경우가 모두 `unstable_judge`로
> 뭉쳐지는데, 전자는 예산·모델 교체로 고치고 후자는 증거 추가로 고친다 — 처방이 반대다.
>
> `runManager.test.ts`의 "네 시나리오가 네 값을 낸다" 테스트를 새 값 집합에 맞게 갱신하고,
> **응답 모드에서 `reviewReason: null`이 실제로 나오는 경로가 있음**을 고정하는 테스트를 추가하라.
> 확장(`extension/src/types.ts`, `extension/media/main.js`)과 `docs/evaluation-protocol.md` §3.2도 함께 고친다.

### 단계 2 — `core/decide.ts` 신설, 중복 판정 로직 흡수

> **프롬프트**
> AB/BA 판정 로직이 `runManager.ts:374`(`judgePair`)와 `codeRunManager.ts:627`(`judgeSurvivors`)에
> 두 벌 존재하고, 후자는 `winnerLabel`을 두 번 계산한다. 사다리를 얹기 전에 하나로 합쳐야 한다.
>
> `src/core/decide.ts`를 만들고 다음을 정의하라.
>
> ```ts
> interface DecisionSubject { id: string; label: string; text: string }
> interface DecisionInput {
>   taskPrompt: string; rubric?: string; subjects: DecisionSubject[];
>   forbidden: string[]; judge: JudgeConfig; kind: ComparisonKind;
> }
> interface Decision {
>   winnerId: string | null; decidedAt: LadderStage | null;
>   reviewReason: ReviewReason | null; trace: LadderStep[];
> }
> ```
>
> 현재 동작(S1만)을 그대로 이식하고 두 매니저가 이것을 호출하게 한다. **이 단계에서 판정 결과는
> 바뀌지 않아야 한다** — 기존 테스트가 전부 통과하는 것이 완료 조건이다. 순수 리팩터링이다.

### 단계 3 — 사다리 S2·S3와 예산

> **프롬프트**
> `decide.ts`에 S2(자기일관성)와 S3(앙상블)을 추가하라.
>
> - S2: S1이 AB/BA 불일치를 냈을 때만 실행. 같은 judge 모델을 `temperature > 0`으로 k회(기본 3),
>   각 회차마다 AB/BA 양쪽. 다수결과 **일치율**을 함께 기록한다. 일치율이 임계값(기본 2/3) 미만이면
>   결론 없음으로 다음 단계에 넘긴다.
> - S3: `judge.ensemble: string[]`에 다른 judge 모델이 선언된 경우에만 실행. 각 모델에 S1을 돌리고
>   과반 합의를 요구한다. 갈리면 결론 없음.
>
> `DecisionBudget { maxJudgeCalls: number; spent: number }`를 도입하고, 각 단계 진입 전에 남은 예산을
> 확인하라. 예산이 부족해 멈춘 경우 `budget_exhausted`, 사다리를 끝까지 돌리고도 갈린 경우
> `undecidable`이다. **이 둘을 같은 값으로 보고하면 단계 1에서 고친 결함을 반복하는 것이다** —
> 전자는 돈 문제고 후자는 인식 문제다.
>
> 모든 단계의 시도·비용·산출을 `LadderStep[]`으로 기록하고 `result.json`에 싣는다.

### 단계 4 — `core/checks.ts`, 응답 모드의 S0

> **프롬프트**
> 응답 모드에 객관 축을 만들어라. `TaskSpec`에 `checks: Check[]`를 추가한다.
>
> ```ts
> type Check =
>   | { kind: "must_include";  items: string[] }
>   | { kind: "must_not";      patterns: string[] }
>   | { kind: "json_parses" }
>   | { kind: "max_words";     limit: number }
>   | { kind: "min_words";     limit: number }
>   | { kind: "regex";         pattern: string; flags?: string; expect: boolean }
> ```
>
> `src/core/checks.ts`에 순수 함수로 구현하라 — 네트워크도 파일 접근도 없다. 모든 후보에 동일하게
> 적용되며(공정성), 후보 실행 **전에** 확정된다. 결과는 `GateResult` 형태로 기록해 코드 모드와 같은
> 경로로 흐르게 한다.
>
> `decide.ts`의 S0가 이것을 소비하게 하고, 검사 통과 수가 갈리면 judge 없이 승자를 정한다.
> 응답 모드의 `evidenceAxes`는 `checks`가 선언된 경우에만 `["objective", "judge"]`가 된다.

### 단계 5 — `core/refine.ts`, 개선 루프

> **프롬프트**
> §2.2의 개선 루프를 구현하라.
>
> - `candidates` 테이블에 `round`, `parent_candidate_id`, `origin('seed'|'refinement')`를 추가한다.
> - `RefineConfig { criticModelId: string; maxRounds: number; }` — `criticModelId`는 judge 모델과도,
>   후보 모델과도 달라야 한다. 위반 시 런을 시작하지 않는다.
> - critic은 incumbent 응답 하나만 보고 **검증 가능한 결함 목록**을 낸다. "더 좋게 써라"가 아니라
>   "3절의 주장에 근거가 없다" 수준이어야 한다.
> - 이웃은 원래 후보와 **같은 모델**에 원래 프롬프트 + critique를 주어 생성한다.
> - incumbent vs neighbor를 `decide.ts`에 `kind: "refinement"`로 넘긴다. **neighbor가 이겼을 때만**
>   교체한다. 무승부·판단불가는 교체하지 않는다 — 이것이 단조성 보장이다.
> - `assertFairness`를 `assertComparable(a, b, kind)`로 재작성한다. `kind: "model"`은 지금 규칙,
>   `kind: "refinement"`는 모델·샘플링이 같고 입력만 다를 것을 요구한다.
>
> 결과에 `rounds`와 후보별 `convergedAfter`를 기록하라. local optimum의 정의가 그 숫자다.

### 단계 6 — S4 차별화 심문

> **프롬프트**
> `decide.ts`에 마지막 계단을 추가하라. S3까지 갈렸을 때만 실행한다.
>
> judge에게 "어느 쪽이 나은가"를 묻는 대신 **"두 제출물을 가르는, 기계로 확인 가능한 주장을 하나
> 대라"**고 요구한다. 출력은 `Check` 형식이어야 한다(단계 4의 타입 재사용). 받은 주장을 두 제출물에
> 실제로 적용해 한쪽만 통과하면 그쪽이 승자다 — 이때 근거는 judge의 의견이 아니라 **측정값**이다.
>
> judge가 분별 주장을 만들지 못하거나, 만든 주장이 양쪽에서 같은 결과를 내면 사다리는 소진된 것이고
> `undecidable`이다. 이 시점의 사람 호출은 정직하다 — 시도 기록이 `ladderTrace`에 남아 있다.

---

## 4. 위험

| 위험 | 완화 |
|---|---|
| 사다리·루프가 런 비용을 곱으로 키운다 | `DecisionBudget`을 필수로 두고 `budget_exhausted`를 별도 값으로 보고 |
| critic이 judge 취향에 최적화 (Goodhart) | critic ≠ judge ≠ 후보 모델을 런 생성 시 강제 |
| 개선 루프가 결과를 나쁘게 만든다 | incumbent 단조성 — 이겨야만 교체 |
| 모델 비교와 개선 비교의 혼합 | `ComparisonKind`를 verdict에 기록하고 순위표를 분리 |
| S2의 temperature>0가 재현성을 깬다 | 회차별 원문을 전부 기록. 재현은 기록 재생으로 보장 |
