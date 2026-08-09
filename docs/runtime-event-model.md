# Runtime Event Model

에이전트가 한 일이 어떻게 화면에 나타나고, 어떻게 저장되며, 어떻게 다시 나타나는가.

## 1. 왜 이 문서가 있는가

실사용에서 나온 결함들이 개별 버그처럼 보였지만 하나의 구조적 불일치였다.

**살아 있는 턴과 다시 연 대화가 서로 다른 입력을, 서로 다른 코드로 그리고 있었다.**

- 살아 있는 턴 → `AgentEvent` 스트림 → 증분 DOM 코드
- 다시 연 대화 → **모델의 프롬프트 배열**(`ProviderMessage[]`) → 별도의 함수

두 번째 경로의 입력에는 계획도, reasoning도, 파일 변경도, 종료 사유도 담길 자리가 없었다. 게다가 그 함수는 담겨 있던 도구 호출마저 버렸다(`role: "tool"` 메시지를 건너뛰고 `toolCalls`를 읽지 않았다). 렌더러를 아무리 고쳐도 복원할 수 없는 정보였다.

두 렌더러는 주의로 일치시킬 수 없다. **하나면 일치할 필요가 없다.**

## 2. 파이프라인

```
Model output
      ↓
AgentEvent                     (src/agent/types.ts — 런타임의 언어, 일시적)
      ↓
TurnRecorder                   (src/agent/sessionRecorder.ts — 무엇을 남길지 결정)
      ↓
SessionEvent                   (src/agent/sessionEvents.ts — 대화를 이루는 것)
      ↓
   ┌──┴──────────────┐
   ↓                 ↓
Persistence        Live UI
(sessionLog.ts)        │
   ↓                   │
Replay                 │
   ↓                   │
   └──────┬────────────┘
          ↓
    reduceSession                (src/agent/sessionView.ts)
          ↓
      SessionView
          ↓
     WebviewRenderer             (extension/media/chat.js)
```

핵심은 마지막 세 단계다. **살아 있는 이벤트와 저장된 이벤트가 같은 리듀서에 들어간다.** 리듀서가 `src/`에 있으므로 webview가 그대로 import한다 — `parseMarkdown`을 쓰는 방식과 같다.

### 실제 파일 기준 경로

| 단계 | 파일 |
|---|---|
| 모델 응답 | `src/agent/hasaModel.ts`, `src/agent/textToolModel.ts` |
| 런타임 이벤트 발생 | `src/agent/loop.ts` (`this.emit`) |
| 이벤트 싱크 | `src/agent/session.ts` (`setEventSink`, 턴마다 교체) |
| 기록 | `src/agent/sessionRecorder.ts` (`TurnRecorder.record`) |
| 저장 | `src/agent/conversationStore.ts` → `src/agent/sessionLog.ts` |
| 재생 | `sessionLog.readSession` → `extension/src/agent/controller.ts` |
| 투영 | `src/agent/sessionView.ts` (`reduceSession`) |
| 렌더 | `extension/media/chat.js` (`renderTurn`, `renderEvent`) |

## 3. 저장되는 것과 저장되지 않는 것

규칙은 한 줄이다.

> 사용자가 볼 수 있었고 다시 보고 싶어 할 것은 이벤트다.
> 움직이는 동안에만 의미가 있던 것은 아니다.

**저장된다** — `assistant_text` · `reasoning` · `plan` · `tool_started` · `tool_completed` · `file_changed` · `notice` · `run_completed` · `user_message`

**저장되지 않는다** — `step`(스피너 카운터) · `phase`(스피너 라벨) · `checkpoint`(워크스페이스가 그대로일 때만 유효한 되돌리기 수단) · `changed`(도구별 `file_changed`로 대체됨, 그대로 두면 이중 계산)

### reasoning은 요약이지 원문이 아니다

`ReasoningEvent.summary`는 런타임이 책임질 수 있는 요약이다. 프로바이더가 반환하는 private reasoning 스트림 원문을 저장하지 않는다 — 모델이 누구에게 보이려고 쓴 글이 아닌 것을 사용자가 열 수 있는 파일에 넣는 일이고, 화면에 그대로 띄우면 답변으로 읽히기 때문이다.

## 4. 저장 스키마

```ts
interface PersistedSession {
  version: 3;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;

  turns: ConversationTurn[];          // 디스크에 실제로 쓰이는 것
  branches: ConversationBranch[];
  checkpoints: ConversationCheckpoint[];
  activeBranchId: string;

  events: SessionEvent[];   // 사용자가 본 것 ─┐ 읽을 때 turns에서
  messages: unknown[];      // 모델이 읽을 것 ─┘ 계산된다. 저장되지 않는다.
}
```

**두 배열은 여전히 둘 다 필요하다.** 어느 쪽도 다른 쪽을 충실히 복원하지 못한다 — 도구 결과는 사람에게는 요약이고 모델에게는 원문이며, 이벤트 로그를 프롬프트로 재생하면 모델이 실제로 나눈 것과 다른 대화를 읽게 된다.

**하지만 v3는 둘을 나란히 저장하지 않는다.** v2는 평평한 두 배열이었고, 그러면 둘이 어긋날 자리가 생긴다. v3는 turn을 저장하고 두 배열은 읽을 때 같은 chain 순회에서 함께 계산한다. "화면과 모델이 같이 움직인다"가 지켜야 하는 규칙이 아니라 코드의 성질이 된다. 자세한 것은 [conversation-graph.md](conversation-graph.md).

`version`은 장식이 아니라 검사된다. `modelCache.ts`와 capability matrix가 쓰는 것과 같은 방식으로, 모르는 번호를 만나면 추측하지 않고 거부한다.

### 마이그레이션

v1(`{ id, title, createdAt, updatedAt, messages }`)과 v2는 읽을 때 v3로 변환된다. 메시지 배열이 실제로 담고 있던 것 — 텍스트와 도구 호출·결과 — 만 이벤트가 되고, **담고 있지 않던 것은 만들어내지 않는다.** 계획이나 종료 사유를 추측해 채우면 일어난 적 없는 일을 사용자 기록에 적는 셈이다.

같은 이유로 **v1/v2는 turn 하나가 된다.** 이벤트에는 `turnId`가 있지만 메시지에는 없어서, 모델 히스토리가 어디서 나뉘었는지는 어디에도 기록되어 있지 않다. `role: "user"`로 쪼개는 것은 추측이고, 추측한 경계에서 분기하면 존재한 적 없는 context가 복원된다. turn 하나면 대화는 그대로 이어지고 중간 분기점은 제공되지 않는다 — 그것이 그 파일에 대한 사실이다.

## 5. 종료 사유

`RunTerminationReason`은 런타임의 `AgentStopReason`과 **같은 어휘**를 쓴다. 두 벌을 두면 매핑이 필요하고, 매핑은 둘이 어긋나는 자리가 된다.

UI가 문자열을 비교하지 않는 것은 `terminationView(reason, detail)`가 표를 통해 필드로 바꾸기 때문이다.

```ts
{ reason, tone: "ok" | "warning" | "error", label: string, detail?: string }
```

webview는 `tone`·`label`·`detail`만 읽는다. **새 사유가 생기면 이 표만 바뀐다.**

`detail`은 그 실행이 왜 그 사유에 도달했는지다 — 어떤 호출이 몇 번 반복됐는지, 어떤 예산이 소진됐는지. 사유만으로는 분류이고, detail이 있어야 사용자가 손댈 수 있다.

## 6. 파일 변경 추적

**source of truth는 git이 아니라 변경을 일으킨 도구다.**

```ts
interface FileChange {
  path: string;
  change: "created" | "modified" | "deleted" | "renamed";
  previousPath?: string;
}
```

`ToolResult.changes`로 보고되고, `tool_end` 이벤트를 타고, `file_changed` 이벤트로 저장된다. git은 **보강**한다 — 명령이 바꾼 것은 어떤 도구도 보고하지 않으므로 `git status`가 잡아준다. 하지만 git이 없다고 목록이 비지 않는다.

## 7. 잘림은 조용하지 않다

```ts
interface TruncationMeta {
  truncated: boolean;
  originalLength?: number;
  returnedLength?: number;
  reason?: "max_chars" | "max_lines" | "max_bytes" | "response_limit" | "file_too_large";
  hint?: string;   // 나머지를 얻는 방법
}
```

`ToolResult.meta`에 실리고 `tool_end`를 타고 저장된다. **모델에게도 알린다** — `content` 안에 문장으로도 들어간다. 잘린 문서를 전체 문서로 착각한 모델은 전체 문서에 대한 답을 한다.

`read_file`은 256KB 초과 파일을 거부하는 대신 첫 chunk와 다음 호출(`startLine`)을 돌려준다. 재시도 루프를 설계 단계에서 없애는 쪽이 나중에 감지하는 것보다 낫다.

## 8. Turn Graph

`turnId`가 모든 이벤트에 있던 것은 분기 히스토리를 또 한 번의 마이그레이션 없이 얹기 위해서였다. v3가 그것을 얹었다 — checkpoint는 turn이고, fork는 부모가 직전 turn이 아닌 turn이다.

한 Turn은 **양쪽 절반을 모두** 소유한다. 화면(`events`)과 모델이 추가로 읽은 것(`messageDelta`)이 같은 레코드에 있으므로, 하나만 되돌리는 배치가 존재하지 않는다.

Turn 경계는 **실제 사용자 상호작용 지점**(`AgentSession.send`)에서 만들어지며 메시지에서 추론되지 않는다. `role: "user"`는 프로토콜 역할이지 사람에 대한 주장이 아니다 — 루프는 모델이 행동을 예고하고 하지 않았을 때 스스로 하나를 밀어 넣는다.

[conversation-graph.md](conversation-graph.md)에 전체가 있다.

## 9. 불변식

테스트가 지키는 것 (`src/agent/sessionView.test.ts`):

```
reduceSession(events) === reduceSession(readSession(writeSession(events)).events)
```

그리고 그 view가 실제로 계획·reasoning·도구 호출 두 건·변경 파일·종료 사유를 담고 있다는 것 — 빈 것끼리의 동일성은 동일성이 아니므로.

## 10. 무엇이 실제로 일어났는가 — Task 원장

C4에서 추가됐다. 실사용 실패 하나에서 나왔다: 에이전트가 분류기를 작성하고, 모델 로드에 실패하고, `python -c "print('모든 코드가 정상적으로 작동합니다')"`를 실행한 뒤 전부 정상 동작한다고 보고했다.

그 실패의 모든 단계가 런타임에는 **사실로** 있었다 — 실패한 도구 호출, 자기가 쓴 문장만 출력한 명령. 아무것도 보관되지 않았고, 유일한 기록은 모델의 산문이었으며, 주장은 거기서 나왔다.

규칙:

> 모델은 제안한다. 런타임은 기록한다.
> 텍스트로 한 주장이 기록을 바꿀 수 없다.

### 투영이지 저장소가 아니다

`TaskState`는 `SessionEvent`에서 파생된다 — `SessionView`와 같은 방식이다. 이것이 continuation이 동작하는 이유다. timeout된 run은 이미 이벤트를 썼고, 재생하면 그 run이 있던 상태가 그대로 돌아온다. 대화를 다시 여는 것도, 브랜치로 전환하는 것도 같은 재생이고 — **브랜치에서는 그 브랜치의 상태가** 나온다. fork 이후 이벤트가 그 chain에 없기 때문이다.

별도 스냅샷 파일은 두 번째 진실 원천이 되고, 둘은 정확히 문제가 되는 경로에서 어긋난다.

### 증거는 도구 관측에서만 온다

`evidenceFrom`이 유일한 문이다. `assistant_text`에서 증거로 가는 경로는 없다. 그래서 "테스트를 통과했습니다"라고 쓰는 모델은 **테스트 증거를 만들지 못하고**, 완료 게이트는 테스트를 보지 못한다.

그리고 명령이라고 다 같지 않다:

```
pytest -q                              → test_result
python -c "print('all tests passed')"  → command_result   (검증 아님)
echo "ALL TESTS PASSED"                → command_result   (검증 아님)
```

exit 0은 인터프리터가 돌았다는 사실이다. 그 안의 문장에 대해서는 아무 말도 하지 않는다.

### 답하기 전에 기록을 건넨다

모델이 턴을 끝내려 할 때, 런타임이 관측한 것을 한 번 건넨다. 끝난 주장을 나중에 고치는 것이 아니라 — 그건 그 사람이 갖지 못했던 사실을 근거로 남의 산문을 고쳐 쓰는 일이다 — **문장을 쓰기 전에** 사실을 준다.

### 구분

```
Plan                ≠ Progress
Tool success        ≠ Task success
Command stdout      ≠ Verification
File exists         ≠ Feature works
Model loaded        ≠ Model trained
Run timeout         ≠ Task completion
```
