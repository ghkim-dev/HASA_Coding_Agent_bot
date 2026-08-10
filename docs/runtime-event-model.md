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

## 11. 무엇을 요구했는가 — Requirement 계약

§10이 "무엇이 일어났는가"를 런타임 소유로 만들었다. 그런데 **"무엇을 원했는가"의 목록은 여전히 `update_plan`에서 왔다** — 모델이 어떻게 진행할 생각인지에 대한 자기 서술이다.

그래서 Hugging Face를 쓸 계획이 애초에 없던 모델은 Hugging Face 요구사항이 없는 task를 만들었고, 런타임은 그 부재를 정확하게 추적했다.

> Plan은 어떻게. Requirement는 무엇을.

계획은 수정되고 버려지고 틀릴 수 있다. 사용자가 말한 요구사항을 런타임이 지우는 것은 다른 문제다.

### 경계

한국어 산문을 해석하는 것은 런타임이 할 수 있는 일이 아니고, 할 수 있는 척하면 매주 다른 방식으로 틀리는 키워드 매칭 더미가 된다. **모델이 해석한다.** 바뀌는 것은 그 다음이다.

```
모델의 해석
     ↓  schema validation      ← record_request
TurnContract                   ← 여기서부터 런타임 소유
     ↓
requirements · constraints · corrections
```

이 선 아래에서 모델은 행동을 제안하고 산문을 쓴다. 계획으로 우회해서 요구사항을 조용히 없앨 수 없고, 실행하지 말라는 지시가 이제 적용되지 않는다고 판단할 수 없다.

### 병합 대수

| relation | 동작 |
|---|---|
| `new_task` | 전부 교체 |
| `refine` | **더한다** — "오픈소스도 추가해줘"가 CNN·ViT를 잃으면 안 된다 |
| `correct` | 모순되는 것을 **superseded**로, 요구하는 것을 추가 |
| `continue` / `question` | 아무것도 더하지 않는다 |

`correct`에서 삭제가 아니라 supersede인 이유: 철회된 요구는 존재한 적 없는 요구와 다른 것이고, 기록은 읽을 수 있어야 한다.

### 두 가지 강도

**Constraint는 강제된다.** 사용자의 말이고, "실행하지 마"에 대해 실행이 도움이 되는 해석은 없다. 승인 창보다 **먼저** 거부한다 — 이미 말로 거절한 것을 모달로 다시 묻는 것은 같은 질문을 두 번 하는 것이다.

**Intent는 강제되지 않는다.** 해석이고, 해석은 틀릴 때가 있다. `present`로 읽힌 턴이 파일을 찾기 위해 `search_files`가 필요하다면 해야 한다. 무엇이 답변에 필요한지 미리 정해놓고 답을 못 하는 에이전트가 되는 것보다 낫다.

선을 가르는 기준은 **사용자가 말했는가**이다. 분류되지 않은 `other` 제약이 아무것도 강제하지 않는 이유도 같다.

### Plan coverage

요구사항과 계획을 비교해 **경고할 뿐 손대지 않는다.** 계획이 빠뜨린 것을 지우는 것이 바로 이 계층이 막으려는 버그다.

## 12. 계약도 이벤트다

§11이 계약을 만들었지만 세션 메모리에 뒀다. 그래서 내일 다시 연 대화에는 계약이 없었다 — 그 계층이 막으려던 실패가 다른 문으로 들어온 것이다.

고친 방식은 저장이 아니라 **관측된 것을 남기고 접는 것**이다. turn graph가 메시지에 대해 이미 하는 일과 같다.

```
record_request (검증 통과)
      ↓
turn_contract 이벤트
      ↓  reduceContract = mergeContract 접기
TaskContract
```

live와 replay가 **같은 입력에 대한 같은 계산**이므로 맞출 것이 없다. 그리고 branch가 공짜로 맞는다 — fork 이후 이벤트는 그 chain에 없으므로 거기 실린 요구사항도 없다.

### 계약이 없으면 행동도 없다

계약 계층이 보장하는 모든 것은 **계약을 만든 턴에 대해서만** 보장된다. `record_request`를 건너뛰고 파일을 쓰기 시작하는 모델은 이 전부가 없던 상태를 얻는데, 그건 fallback이 아니라 버그에 단계만 더한 것이다.

그래서 substantive action은 기다린다:

```
write · patch · run_command · web_*  →  TURN_CONTRACT_REQUIRED
read · search · plan · report        →  통과
```

읽기가 열려 있는 이유: 아무것도 볼 수 없는 모델은 무엇을 요구받았는지도 알아낼 수 없고, 이해를 막는 게이트는 추측을 강요한다.

### 세 단계

| | |
|---|---|
| `deny` | 사용자가 말한 제약. "실행하지 마"에 실행이 도움이 되는 해석은 없다 |
| `requires_justification` | 해석과 어긋남. **실행을 보류한다** |
| `allow` | |

가운데가 필요한 이유: 코드만 보여달라는 턴에서 명령을 실행하는 것은 금지된 일이 아니라 **아무도 요청하지 않은 일**이고, 둘은 다르다.

### Preflight — 주석만 다는 정책은 정책이 아니다

`requires_justification`는 처음에 호출을 통과시키고 결과에 조언을 붙이는 형태였다. 그러면 명령은 이미 실행됐고, 워크스페이스는 이미 바뀌었고, 반대 의견은 각주로 도착한다. 그것을 막으려고 쓴 실패가 그대로 일어난다.

그래서 판단은 **레지스트리보다도, 승인보다도 먼저** 한 번 일어나고, 세 결과 중 하나만 실행한다.

```
proposed   모델이 하겠다고 한 것
deferred   런타임이 붙잡은 것
executed   실제로 돌아간 것
```

의미 있는 숫자는 세 번째다. 모델이 옳은 행동을 고르는지 보는 테스트는 모델의 테스트이고, **틀리게 골라도 견디는지** 보는 테스트가 런타임의 테스트다.

### 필요하다는 주장은 근거가 아니다

모델이 "이 명령이 반드시 필요합니다"라고 해도 답은 같다. 기준은 사용자가 요청한 것이고, 그것을 바꾸는 것은 새 계약뿐이다. 보류에서 나가는 길은 더 나은 문장이 아니라 **요청을 만족시키는 다른 행동**이거나 `report_blocked`다.

## 13. 무언가 하는 것과 나아가는 것

```
python -c "print('프로젝트 완료')"
python -c "print('프로젝트 최종 완료')"
python -c "print('모든 구성 요소 정상')"
```

문자열이 각각 다르므로 기존 detector(`이름 + rawArguments` 해시)는 **서로 무관한 세 호출**로 봤다. 셋 다 tool result를 만들었으므로 이벤트를 세는 어떤 것도 **진전으로** 봤다. 그리고 아무것도 검증하지 않았고, 바꾸지 않았고, 알아내지 않았다.

> New event ≠ new evidence ≠ progress

### 세 단계

| | |
|---|---|
| LEVEL 1 | 기존 exact repetition. 그대로 둔다 — 싸고 가장 단순한 루프를 즉시 잡는다 |
| LEVEL 2 | **연산의 모양**. 위 셋은 하나의 `run_command:print_only`다 |
| LEVEL 3 | **판단**. 모양이 반복되면서 검증·변경·해결·새 관측이 전부 없으면 stall |

LEVEL 2 혼자로는 종료하지 않는다. `pytest test_a.py`와 `pytest test_b.py`는 같은 모양이고 지극히 정상이다. 두 신호가 함께여야 false positive가 없다.

### 어려운 절반은 조용히 있는 것

- 처음 보는 파일 세 개를 읽는 것은 **조사**다 (`weak`)
- 실패 → 수정 → 같은 테스트 재실행은 **정상**이다 (`strong`)
- 새로운 오류를 발견하는 것도 진전이다 (`weak`)
- 같은 오류를 사이에 아무 변경 없이 다시 얻는 것은 아니다 (`none`)

증거의 동일성은 stdout 해시가 아니라 **대상과 결과**로 본다. 같은 실패의 두 실행은 타이밍이 다르지만 문제는 하나이고, 다른 축하 문구 두 개는 검증이 아니라 하나다.

### 붙잡힌 호출은 진전이 아니다

f4b4a30이 만든 루프: present-only 계약에서 모델이 계속 명령을 제안하면 매번 challenge를 받고 `maxSteps`까지 간다. 실행되지 않은 호출은 정의상 아무것도 옮기지 않는다.

### 종료 의미

`no_progress`는 **Run의 종료**이지 Task의 완료가 아니다. 요구사항도 미해결 오류도 그대로 남고, 다음 턴에서 이어갈 수 있다. `maxSteps`는 마지막 안전핀으로 남는다.
