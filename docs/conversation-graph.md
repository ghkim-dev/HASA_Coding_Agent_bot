# Conversation Graph

대화가 어떻게 turn으로 나뉘고, 저장되고, 과거의 한 시점으로 정확히 되돌아가는가.

## 0. 이 문서가 지키는 한 줄

> 화면이 과거로 돌아간 것처럼 보이는 것만으로는 Branch가 아니다.
> 모델의 실제 conversation context도 정확히 같은 시점으로 돌아가야 한다.

Branch UI는 아직 없다(C2). 이 문서와 이 커밋이 하는 일은 **그 불변식이 성립할 수 있는 자료구조를 만들고, 성립한다는 것을 테스트로 증명하는 것**이다.

## 1. 계층

```
API Key Scope        fingerprint(key) — 키 원문은 어디에도 없다
      └ Workspace    (C3)
          └ Conversation      한 파일
              └ Branch        headTurnId를 가리키는 이름
                  └ Turn      화면 절반 + 모델 절반
                      └ Checkpoint   (C2)
```

## 2. Turn이란 무엇이고 무엇이 아닌가

**Turn은 한 번의 사용자 상호작용이다.** 사용자가 실제로 상호작용하는 지점 — `AgentSession.send` — 에서 만들어지고, 메시지로부터 추론되지 않는다.

이 구분은 하중을 받는다. `role: "user"`는 LLM 프로토콜의 역할이지 사람에 대한 주장이 아니다.

```ts
// loop.ts — 모델이 하겠다고 말하고 아무 도구도 부르지 않았을 때
messages.push({
  role: "user",
  content: "You described what you were about to do but did not do it — no tool was called...",
});
```

이것은 사용자가 한 말이 아니다. Harness가 들어오면 reviewer 피드백과 수정 요청으로 이런 메시지가 더 늘어난다. `role`에서 읽은 turn 경계는 한 번의 상호작용을 여러 개로 쪼개고, **그 가짜 경계에서 분기하면 존재한 적 없는 모델 context가 복원된다.**

그래서: 상호작용 계층이 turn 정체성을 소유하고, 프로토콜 계층이 role을 소유하며, 둘 사이를 번역하는 것은 없다.

`turnBoundary.test.ts`의 G11이 이것을 지킨다 — nudge가 일어난 turn에서 `role: "user"` 메시지는 2개이고 Turn은 1개다.

## 3. Delta이지 Snapshot이 아니다

Turn은 자신이 모델 히스토리에 **더한 것**을 저장한다. 그 시점의 전체 히스토리는 root부터 내려오는 delta들의 연결이다.

Turn마다 전체 스냅샷을 저장하면 대화 길이에 대해 O(n²)이 되고, 긴 세션은 금방 거기에 도달한다.

```ts
restoreMessages(turns, T) === historyAfterTurn(T)
```

### delta는 관측되지 재구성되지 않는다

```ts
// session.ts
const deltaStart = this.messages.length;   // system 재주입 이후에 잡는다
try {
  return await loop.run(this.messages, signal);
} finally {
  this.lastDelta = structuredClone(this.messages.slice(deltaStart));
}
```

- `SessionEvent`에서 역생성하지 않는다. 둘은 상호 변환되지 않고, 재구성은 기록으로 위장한 추측이다.
- `structuredClone`으로 복사한다. 루프는 같은 배열에 계속 push하므로 참조를 들고 있으면 과거의 turn이 미래를 보게 된다.
- `finally`에서 잡는다. 중단되거나 실패한 turn도 모델이 실제로 읽은 것을 남긴다.
- system 메시지는 절대 들어가지 않는다. turn마다 현재 mode에서 다시 주입되므로, 과거의 것을 복원하면 사용자가 떠난 mode의 프롬프트가 되살아난다.

### length slicing이 정당한 이유

인덱싱은 turn 동안 히스토리가 **append-only**일 때만 건전하다. 이것은 가정이 아니라 증명된 사실이다.

`loop.ts`의 메시지 변경 지점은 정확히 여섯 개이고 전부 `push`다 — splice 없음, 대입 없음, 재정렬 없음. `session.ts`가 배열을 교체하는 곳은 system 재주입 한 곳이며 `deltaStart`를 잡기 **전에** 일어난다.

그리고 이것은 문서로만 남지 않는다. `turnBoundary.test.ts`의 G12가 실제 세션을 돌려 앞선 turn의 메시지가 그대로인지 확인한다. 규칙이 깨지면 문서가 아니라 테스트가 먼저 알려준다.

## 4. Turn은 절반만으로는 Turn이 아니다

```ts
interface ConversationTurn {
  id: string;
  parentTurnId: string | null;
  state: "running" | "completed" | "aborted" | "failed";
  createdAt: number;
  completedAt: number | null;

  events: SessionEvent[];          // 사용자가 본 것
  messageDelta: ProviderMessage[]; // 모델이 추가로 읽은 것

  restorable: boolean;
  unrestorableReason?: string;
  terminationReason?: RunTerminationReason;
  metadata?: TurnMetadata;
}
```

한쪽만 있는 turn은 읽을 때 **복구되지 않고 버려진다**(`readTurns`). 반쪽짜리를 살려두면 화면은 한 시점, 모델은 다른 시점으로 복원되고 — 그것이 이 구조가 막으려는 바로 그 실패다.

## 5. state는 선언되지 추론되지 않는다

```ts
finished        → completed
denied          → aborted
aborted         → aborted
timeout         → aborted
loop_detected   → aborted
max_steps       → aborted
max_model_calls → aborted
max_tool_calls  → aborted
error           → failed
없음/모르는 값   → failed
```

`terminationView`가 표인 것과 같은 이유로 표다. 새 사유는 여기 한 줄이 되고, 아무도 매핑하지 않은 사유는 조용히 `completed`로 흘러들지 않는다. **실제로 끝난 실행만 완료다** — 예산이나 거부로 멈춘 turn은 진짜 작업을 했고 보존되지만, 그것을 완료라고 부르는 것은 사용자 자신의 기록에 적는 작은 거짓말이다.

## 6. restorable — 이어갈 수 있는가

규칙은 하나이고 우리 것이 아니라 프로토콜의 것이다: **assistant가 한 모든 도구 호출에는 결과가 있어야 한다.**

timeout·abort·예산이 그 둘 사이에 떨어지면 모든 OpenAI 호환 게이트웨이가 거부하는 히스토리가 남는다. 그래서 다음 요청에서 발견하는 대신 여기서 표시한다.

`canBranchFrom`은 **내려오는 경로의 모든 turn**을 검사한다. 모델에게는 chain 전체가 주어지므로 중간의 끊어진 고리 하나가 요청 전체를 거부당하게 만든다.

디스크의 `restorable` 플래그는 **믿지 않고 다시 계산한다**. 메시지가 바로 옆에 있고, 낡은 플래그는 깨진 chain을 분기점으로 제안하게 만든다.

## 7. 파일

디스크에는 그래프만 쓴다. `events`와 `messages`는 읽을 때 **같은 chain 순회에서 함께** 계산된다.

```ts
function project(turns, branches, activeBranchId) {
  const head = ...;
  return { events: restoreEvents(turns, head), messages: restoreMessages(turns, head) };
}
```

같은 대화를 두 벌 저장하면 둘이 어긋날 자리가 생긴다. 한 벌만 저장하면 어긋날 수 없다.

## 8. createdAt

```ts
createConversation()   // createdAt을 정하는 유일한 곳
appendTurn()           // 인자에 createdAt이 없다
updateConversation()   // patch 타입에 createdAt이 없다
```

이전에는 `persist()`가 저장할 때마다 `createdAt: Date.now()`를 넘겼고, 한 달 된 대화가 방금 시작한 것으로 보고되어 목록을 의미 있게 정렬할 수 없었다.

고친 방식은 "이제 호스트가 옳은 값을 넘긴다"가 아니다. **`appendTurn`에는 그 값을 움직일 수 있는 인자가 없다.** 남아 있는 `save()`도 디스크에 이미 있는 값을 우선한다.

`parentTurnId`도 같은 이유로 호출자의 인자가 아니다. branch head가 어디인지는 store가 안다. 호스트가 그것을 놓쳤을 때 잘못된 부모를 쓰게 두면, 잘못된 부모는 일어난 적 없는 히스토리로의 복원이다.

## 9. 마이그레이션 — 보수적으로

v1/v2 파일은 turn **하나**가 된다. §4의 이유로 양쪽 절반을 모두 갖고, `metadata.legacy`로 표시된다.

이벤트에는 `turnId`가 있지만 메시지에는 없다. 모델 히스토리가 어디서 나뉘었는지는 어디에도 기록되지 않았고, 추측한 경계에서의 분기는 존재한 적 없는 context를 복원한다.

그래서 마이그레이션된 대화는:

- **이어갈 수 있다** — 전체 히스토리가 그대로 있다
- **중간에서 분기할 수 없다** — 관측된 적 없는 내부 경계는 제공되지 않는다

그것을 제공하지 않는 것이 그 파일에 대한 정직한 결과다.

## 10. 보안

- API 키 원문은 저장되지 않는다. 대화는 `fingerprint(key)` 아래에 놓이고, 이는 키로 되돌릴 수 없다.
- 키 교체는 새로운 history scope다. 게이트웨이가 API 키에 계정 정체성을 노출하지 않으므로, 이것을 계정별이라고 부르는 것은 코드가 지킬 수 없는 주장이다.
- Branch 이름은 경로 요소가 되지 않지만 `..`·구분자·드라이브 접두사·제어문자를 거부한다. "오늘은 경로로 쓰이지 않는다"는 오늘의 성질이다.
- `conversationGraphStore.test.ts`가 가짜 키를 넣고 쓰인 모든 파일과 경로를 전수 검사한다.

## 11. 테스트가 지키는 것

| | 무엇 |
|---|---|
| G1 | chain이 그 turn이 끝났을 때의 히스토리를 복원한다 |
| G3/G4 | cycle과 사라진 조상은 반쯤 복원되지 않고 보고된다 |
| G5 | 끊어진 고리가 하나라도 있으면 분기를 거부한다 |
| G6 | branch head에서 도달 가능한 turn |
| G7 | branch 이름은 경로가 아니다 |
| G8 | state는 표에서 나온다. 모르는 값은 `completed`가 아니다 |
| G9 | branch head가 가리킬 수 있는 것 |
| **G10** | **화면과 모델이 같은 시점으로 함께 움직인다** |
| G11 | 내부 nudge는 turn을 시작시키지 않는다 |
| G12 | turn 동안 모델 히스토리는 append-only다 |
| G13 | delta는 그 turn이 더한 것과 정확히 같다 |
| G14 | nudge는 복원된 히스토리에 모델이 읽은 그대로 있다 |
| G15 | 도구 호출과 결과는 함께 이동한다 |
| G16 | 저장된 turn은 이후에 바뀌지 않는다 |
| G17 | 비정상 종료도 진짜 turn이다 |
| T1–T3 | `createdAt`은 움직이지 않고, 부모는 branch head다 |
| M1–M5 | 옛 파일은 담고 있던 것으로 열린다 |

G10과 G13–G17은 순수 함수가 아니라 **실제 세션·실제 recorder·실제 store**를 통과한다(`conversationRestore.test.ts`). 조각들이 각각 옳은 것과 조립된 것이 옳은 것은 다른 주장이기 때문이다.
