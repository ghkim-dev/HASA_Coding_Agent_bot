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
  version: 2;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  events: SessionEvent[];   // 사용자가 본 것
  messages: unknown[];      // 모델이 읽을 것
}
```

**두 배열을 모두 저장한다.** 어느 쪽도 다른 쪽을 충실히 복원하지 못한다 — 도구 결과는 사람에게는 요약이고 모델에게는 원문이며, 이벤트 로그를 프롬프트로 재생하면 모델이 실제로 나눈 것과 다른 대화를 읽게 된다.

`version`은 장식이 아니라 검사된다. `modelCache.ts`와 capability matrix가 쓰는 것과 같은 방식으로, 모르는 번호를 만나면 추측하지 않고 거부한다.

### 마이그레이션

v1(`{ id, title, createdAt, updatedAt, messages }`)은 읽을 때 v2로 변환된다. 메시지 배열이 실제로 담고 있던 것 — 텍스트와 도구 호출·결과 — 만 이벤트가 되고, **담고 있지 않던 것은 만들어내지 않는다.** 계획이나 종료 사유를 추측해 채우면 일어난 적 없는 일을 사용자 기록에 적는 셈이다.

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

## 8. 앞으로

`turnId`가 모든 이벤트에 있는 것은 분기 히스토리를 나중에 또 한 번의 마이그레이션 없이 얹기 위해서다. checkpoint는 turn이고, fork는 부모가 직전 turn이 아닌 turn이다. **이 문서의 어떤 것도 그것을 구현하지 않고, 어떤 것도 그것을 막지 않는다.**

## 9. 불변식

테스트가 지키는 것 (`src/agent/sessionView.test.ts`):

```
reduceSession(events) === reduceSession(readSession(writeSession(events)).events)
```

그리고 그 view가 실제로 계획·reasoning·도구 호출 두 건·변경 파일·종료 사유를 담고 있다는 것 — 빈 것끼리의 동일성은 동일성이 아니므로.
