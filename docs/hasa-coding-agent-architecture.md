# HASA Coding Agent — Architecture (Phase Z0)

> 상태: **분석 완료 / 설계 확정**. 이 문서는 Z0의 산출물이며, 코드는 Z1부터 들어간다.
> 기준 커밋: `3c7b49c` (2026-08-01 clone). 베이스라인 실측: `pnpm test` 277 pass / `pnpm typecheck` OK / `pnpm build:extension` OK.

이 저장소를 **"모델 비교 프로그램(Agent Arena)"** 에서 **"일반 개발자가 쓰는 Coding Agent"** 로 확장한다.
Arena는 삭제되지 않는다. Arena는 **UI에서 내려오고 Harness 내부의 고급 evaluation engine으로 승격**된다.

```
지금:  사용자 → Arena(모델 A/B/C + Judge) → 승자 diff
목표:  사용자 → Coding Agent → (필요할 때만) Harness → (아주 어려울 때만) Arena
```

---

## 0. 한 줄 요약

| | 지금 (Arena) | 목표 (Coding Agent) |
|---|---|---|
| 사용자가 아는 것 | 후보 모델 N개, judge 모델, runtimeAdapter, acceptanceCommands, writeScope | **API Key 1개 + Mode 1개 + 자연어** |
| 기본 실행 | 항상 N개 후보 + judge | **Single Agent 1개** |
| 모델 선택 | 사용자가 직접 고름 | **✨ Auto** (Harness가 결정) |
| Arena의 위치 | 제품 그 자체 | Harness의 `best_of_n` 전략 |
| 차별점 | — | **멀티 모델 검증/하네스 엔진** (Zoo/Cline에 없는 것) |

---

## 1. 현재 구조

### 1.1 디렉터리와 책임

```
HASA_Harness/
├── src/                         Node 24 네이티브 타입 스트리핑 — 빌드 단계 없음
│   ├── protocol/                Zod 스키마 + 타입 (서버·CLI·probe 공유)
│   │   ├── chat.ts              OpenAI 호환 chat 타입 (손으로 작성, SDK 미사용)
│   │   ├── capability.ts        CapabilityMatrix / Eligibility / ModelsResponse
│   │   ├── code.ts, run.ts      Run·Candidate·TaskSpec 스키마
│   ├── hasa-client/             ★ HASA HTTP 클라이언트 (재사용 대상)
│   │   ├── client.ts            auth, timeout, retry(Retry-After), listModels/chat/streamChunks
│   │   ├── errors.ts            HasaError + ErrorKind 분류 (401/403/404/429/503/…)
│   │   ├── sse.ts               SSE 파서 + tool_calls 조립 (index 규약)
│   │   ├── redact.ts            registerSecret / redact / fingerprint / summarizeMessages
│   │   └── logger.ts
│   ├── probe/                   ★ Capability Probe (재사용 대상)
│   │   ├── probes.ts            P1~P16 실제 HTTP 요청 정의
│   │   ├── runner.ts            모델별 순차 probe + 동시성 제한
│   │   └── matrix.ts            computeEligibility / checkStaleness / buildMatrix
│   ├── core/                    Arena 코어
│   │   ├── runManager.ts        Response Compare 모드
│   │   ├── codeRunManager.ts    Code Candidate 모드 (worktree, 게이트, apply)
│   │   ├── decide.ts            판정 사다리 S0~S4
│   │   ├── judge.ts, refine.ts, fairness.ts, gates.ts, checks.ts
│   │   ├── git.ts               ★ worktree/diff/apply/stash snapshot (재사용 대상)
│   │   ├── sandbox.ts           ★ realpath 기준 경로 감금 (재사용 대상)
│   │   ├── commands.ts          ★ allowlist 명령 실행 (재사용 대상)
│   │   ├── scheduler.ts         전역 + 모델별 동시성
│   │   ├── registry.ts          CapabilityMatrix 기반 모델 자격 조회
│   │   ├── store.ts             node:sqlite + JSONL
│   │   └── events.ts            EventHub → SSE
│   ├── runtime/
│   │   ├── agentRunner.ts       ★ tool-calling 루프 (Coding Agent의 씨앗)
│   │   └── patchRunner.ts       unified diff fallback
│   ├── server/app.ts            Fastify HTTP + SSE (localhost, x-arena-token)
│   ├── cli/main.ts              pnpm arena
│   └── testing/
│       ├── mock-hasa.ts         ★ in-process HASA 게이트웨이 mock (재사용 대상)
│       └── repo-fixture.ts
└── extension/                   VS Code 확장 (별도 컴파일 단위, tsc → CommonJS)
    ├── src/extension.ts         SecretStorage, 명령 등록, diff/apply UX
    ├── src/orchestrator.ts      ★ 자식 프로세스 기동 + 신뢰 경계 (재사용 대상)
    ├── src/panel.ts, types.ts   webview 메시지 계약
    └── media/main.js, main.css  webview UI
```

### 1.2 의존 방향 (현재)

```
protocol ← hasa-client ← probe / core ← runtime ← server ← cli
                                                        ↑
                                    extension (HTTP + 자식 프로세스로만 연결)
```

`src/`와 `extension/`은 **두 개의 독립 컴파일 단위**다.

* `src/` — `module: NodeNext`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `noEmit`. Node가 `.ts`를 직접 실행한다.
* `extension/` — `module: Node16`, `rootDir: src`, `outDir: out`. `tsc`로 CJS 컴파일.

둘은 **소스를 import하지 않는다.** 확장은 필요한 타입을 `extension/src/types.ts`에 좁게 재선언하고, 런타임에는 HTTP + 자식 프로세스로만 통신한다. 이 경계는 의도된 것이며(§10 Security), Z1도 이를 유지한다.

### 1.3 검증된 사실 (추측 아님)

| 항목 | 근거 |
|---|---|
| `pnpm test` = `node --test "src/**/*.test.ts"` → 277 pass | 실행함 |
| `pnpm typecheck` = `tsc --noEmit && tsc -p extension --noEmit` → OK | 실행함 |
| `pnpm build:extension` = `tsc -p extension` → OK | 실행함 |
| 런타임 의존성은 `fastify`, `zod` 2개뿐 | `package.json` |
| Node 24.18.0 / pnpm 10.15.0 설치됨 | 실행함 |

---

## 2. 기존 Arena에서 재사용할 부분

Arena는 "비교 제품"이 아니라 **Coding Agent가 필요로 하는 인프라의 창고**다. 아래는 Z2 이후 그대로 쓴다.

| 자산 | 파일 | Coding Agent에서의 역할 |
|---|---|---|
| **HASA HTTP 클라이언트** | `src/hasa-client/client.ts` | `HasaProvider`의 transport. **중복 구현 금지** |
| **에러 분류** | `src/hasa-client/errors.ts` | `ProviderError`의 원천. 401/403/404/429/503 + retryable/terminal |
| **SSE 파서 + tool_call 조립** | `src/hasa-client/sse.ts` | Streaming 정규화의 하부. `data: [DONE]`, index 규약 실측 검증됨 |
| **비밀 마스킹** | `src/hasa-client/redact.ts` | `registerSecret`/`fingerprint`/`evidence` — 로그·캐시 키 |
| **Capability Probe** | `src/probe/**` | §11 "이름으로 능력을 추측하지 마라"의 유일한 합법적 해답 |
| **Eligibility 계산** | `src/probe/matrix.ts` | Auto 모델 선택의 기초 (`codingAgent`, `judge`, `patchMode`) |
| **Sandbox (realpath 감금)** | `src/core/sandbox.ts` | Coding Agent의 `read_file`/`apply_patch` 경계 |
| **명령 allowlist** | `src/core/commands.ts` | `execute_command` 툴의 Approval 하부 |
| **Git worktree / diff / apply / stash** | `src/core/git.ts` | **CheckpointManager의 실체.** `snapshot()`이 이미 stash 기반 revert를 제공 |
| **Tool-calling 루프** | `src/runtime/agentRunner.ts` | `AgentLoop`의 원형. 거부를 예외가 아니라 tool 결과로 되돌리는 설계가 이미 옳다 |
| **스케줄러** | `src/core/scheduler.ts` | 전역/모델별 동시성 — Harness가 다중 모델을 쓸 때 필요 |
| **Store / EventHub** | `src/core/store.ts`, `events.ts` | 세션 영속 + 스트림 |
| **Mock HASA 게이트웨이** | `src/testing/mock-hasa.ts` | **키·네트워크 없이 Z1 전체를 테스트**하는 수단 |
| **확장 신뢰 경계** | `extension/src/orchestrator.ts` | 키를 자식 프로세스 env로만 전달, webview에 절대 노출 안 함 |
| **판정 사다리 S0~S4** | `src/core/decide.ts` | Harness의 Adaptive Escalation(§23)이 그대로 재사용 |

> **핵심 판단:** 이 저장소에는 Coding Agent에 필요한 것의 **약 70%가 이미 있다.** 없는 것은 (a) Provider 추상화, (b) 대화형 AgentSession, (c) Approval UX, (d) Harness 라우터, (e) 새 Webview다.

---

## 3. 현재 HASA API 계층

### 3.1 실제 API (문서 + 실측 확인)

`open.hasa.re.kr/docs` 및 이 저장소의 실측 probe(2026-07-29, `docs/compatibility-matrix.md` §8) 기준.

| 항목 | 값 |
|---|---|
| Base URL | `https://open.hasa.re.kr/v1` |
| 인증 | `Authorization: Bearer <API_KEY>` |
| **모델 목록** | `GET /v1/models` — **공개 API. 키 없이도 200이 돌아온다** |
| Chat | `POST /v1/chat/completions` (OpenAI 호환) |
| Streaming | `stream: true` → SSE, `data: [DONE]` 종료 |
| Embedding | `POST /v1/embeddings` |
| Rerank | `POST /rerank` — **`/v1` 접두사 없음** (경로 하드코딩 시 오류) |
| Agent | `POST /v1/agent/chat` (웹검색 에이전트. 우리 Coding Agent와 무관) |
| 오류 | 401 / 403 / 404 / 429(`Retry-After` 있음) / 503(**`Retry-After` 없음** — 실측) |
| 403 본문 | `allowed_models` 배열 포함 — 키의 실제 권한 범위를 알 수 있다 |

실측 결과 한 개의 키에서 `GET /v1/models`는 19개를 반환했지만 실제 추론 가능한 것은 6개, chat 가능한 것은 4개였다.

### 3.2 실측으로 확인된 정정 (2026-08-01)

> **HASA는 잘못된 키에 401이 아니라 403을 반환한다.**

실제 게이트웨이에 붙여서 확인했다. 문서의 오류 표와 이 저장소의 모든 mock은 401이라고 말하고 있었다.

```json
403 {"error":"security_policy_blocked",
     "message":"[경고 1/10] 유효하지 않거나 만료된 API Key를 사용했습니다.
                10회 초과부터 차단 시간이 1→2→4→16→32분 으로 늘어납니다.",
     "violation_code":"invalid_api_key", "strike_count":1, "offense_count":1}
```

두 가지가 따라온다.

* **403은 두 가지 의미를 갖는다.** `violation_code`로만 구분된다.
  * `invalid_api_key` → 키가 무효 (= 사실상 401)
  * 그 외 / 없음 → 키는 유효, 이 모델 권한 없음
* **strike 제도가 있다.** 잘못된 키로 10회 초과 시 1→2→4→16→32분 차단. 따라서 **검증은 첫 거절에서 멈춰야 한다.** 카탈로그를 순회하면 검증 1회에 strike를 3개 소모한다.

모델 권한 403은 형태가 다르다 (`detail` 아래 중첩).

```json
403 {"detail":{"error":"model_not_on_key",
                "message":"이 Key에 「qwen3-coder」 모델 권한이 없습니다.",
                "hint":"관리 콘솔 한도 정책(키 허용 모델) …",
                "allowed_models":["bge-m3","bge-reranker-v2-m3","exaone-4.0-32b",
                                  "gpt-oss-20b","granite-guardian-3.1-8b","qwen2.5-coder-32b"]}}
```

여기서 두 가지가 더 나왔다.

* **body가 200자에서 잘리면 allow-list 6개 중 2개만 남는다.** 잘린 목록은 "짧은 허용 목록"처럼 읽히므로, 403에 한해 스니펫 예산을 800자로 늘렸다. 마스킹은 그대로다.
* **allow-list의 앞쪽이 chat 모델이 아니다.** 실제 키의 목록은 임베딩(`bge-m3`)과 리랭커(`bge-reranker-v2-m3`)로 시작하고, 둘 다 `/chat/completions`에 404를 반환한다. 시도 예산 3회로는 대화 가능한 첫 모델에 도달하지 못했다 → 예산 6회 + **측정된 capability 순으로 정렬**(이름 추측 금지 §11 유지).

### 3.2.1 `probedModelId` ≠ 쓸 수 있는 모델

검증이 "키는 유효"까지만 답하면, 호출자는 **첫 사용에서 실패하는 모델 ID를 들고 있게 된다.** 게이트웨이 카탈로그의 첫 항목이 이 키로 못 쓰는 모델인 경우가 흔하기 때문이다.

그래서 `ProviderValidation`에 `usableModelId`를 두었다 — 200으로 **실제 응답이 확인된** 모델. 403이 실려 온 allow-list를 따라가면 보통 요청 한 번 더로 찾아진다.

```
qwen3-coder      403 → allow-list 획득
bge-m3           404  (임베딩)
bge-reranker     404  (리랭커)
exaone-4.0-32b   200 → usableModelId
```

### 3.2.2 라이브 capability 측정 (2026-08-01)

`HasaCapabilityProbe`에 실제 probe를 연결하고 이 키의 6개 모델을 측정했다. 2026-07-29에 503으로 `unknown`이 남아 있던 `granite-guardian-3.1-8b`가 해소됐다.

| model | chat | stream | tools | coding | maxOutput |
|---|---|---|---|---|---|
| `exaone-4.0-32b` | ✅ | ✅ | ✅ | **✅** | 32768 |
| `gpt-oss-20b` | ✅ | ✅ | ✅ | **✅** | 32768 |
| `qwen2.5-coder-32b` | ✅ | ✅ | ❌¹ | ❌ | 32768 |
| `granite-guardian-3.1-8b` | ✅ | ✅ | ❌ | ❌ | 4096 |
| `bge-m3` | ❌ | — | — | ❌ | — |
| `bge-reranker-v2-m3` | ❌ | — | — | ❌ | — |

¹ 모델 무능력이 아니라 게이트웨이 설정 (compatibility-matrix.md §8.3). **텍스트 프로토콜로 사용 가능** — §3.2.3.

### 3.2.3 tool calling이 막힌 모델 (텍스트 프로토콜)

`qwen2.5-coder-32b`는 이 키에서 가장 강한 코딩 모델이고, 그 배포가 `--tool-call-parser` 없이 떠서 모든 `tool_choice`를 거부한다. 모델은 할 수 있는데 우리가 설정할 수 없는 플래그가 막는다 — 제외는 틀린 답이다.

그래서 도구를 **프롬프트에 기술하고 응답 텍스트에서 호출을 읽는다.** Cline이 native tool call을 못 쓸 때 하는 방식이고, XML을 쓰는 이유는 코딩 에이전트에 특유하다: 도구 인자가 대개 소스 코드인데 **JSON 이스케이프(따옴표·백슬래시·개행)가 모델이 가장 자주 틀리는 것**이다. 태그로 구분하면 코드가 그대로 실린다.

```
<apply_patch>
<path>src/a.ts</path>
<find>
  const x = 1;
</find>
<replace>
  const x = 2;
</replace>
</apply_patch>
```

`tool_calls`를 거부하는 게이트웨이는 assistant 메시지의 `tool_calls`와 `role:"tool"`도 같은 이유로 거부하므로, **대화 자체를 원래의 평문으로 되돌려서** 보낸다.

**루프 위쪽은 아무것도 달라지지 않는다.** 동일한 `NormalizedToolCall`이 나오므로 승인·체크포인트·도구 레지스트리는 두 경로를 구분하지 못한다. 그것이 서버 설정 문제를 기능 부재로 번지지 않게 하는 속성이다.

실측: 막힌 모델이 실제 수정을 완료한다 (4 step, 실패 0회).

**agent 루프를 돌릴 수 있는 모델이 2개다.** Z2의 전제가 충족된다.

### 3.3 이것이 설계에 강제하는 것

1. **모델 목록 성공 ≠ 키 유효.** `/v1/models`가 공개이므로 Provider Validation은 **인증이 필요한 호출을 따로 해야 한다** (Z1 §8).
2. **403은 body를 읽어야 의미가 정해진다.** `violation_code`를 보지 않고 403을 "모델 권한 없음"으로 단정하면 **죽은 키를 "연결됨"으로 보고하게 된다** — Provider Validation이 막으려던 바로 그 실패다.
3. **모델 목록에 있다 ≠ 코딩 에이전트에 쓸 수 있다.** tool calling은 모델별·게이트웨이 설정별로 갈린다 (§8.3: vLLM `--tool-call-parser` 미설정 시 400).
4. **503에는 `Retry-After`가 없다.** backoff로 대응해야 한다. 이미 `client.ts`가 그렇게 한다.

---

## 4. Zoo Code에서 참고할 구조

조사 대상: `Zoo-Code-Org/Zoo-Code`. **코드를 복사하지 않고 설계만 가져온다.**

### 4.1 확인한 실제 구조

```
src/api/
  index.ts                              buildApiHandler(ProviderSettings) → ApiHandler  (switch 팩토리)
  providers/
    base-provider.ts                    공통 기반
    base-openai-compatible-provider.ts  ★ OpenAI 호환 계열의 단일 상위 클래스
    openai-compatible.ts, openai.ts, openrouter.ts, lite-llm.ts, zoo-gateway.ts, … (40+)
    router-provider.ts                  라우터형 provider 공통
    fetchers/
      modelCache.ts                     ★ 모델 목록 캐시 (메모리 + 디스크)
      modelEndpointCache.ts
      openrouter.ts, ollama.ts, litellm.ts, …   provider별 모델 조회기
webview-ui/                             React webview
```

### 4.2 차용하는 설계 5가지

| # | Zoo의 설계 | 우리가 가져가는 형태 |
|---|---|---|
| **Z-1** | `ApiHandler` 단일 인터페이스 + `buildApiHandler` 팩토리. 40개 provider가 전부 같은 계약을 만족 | `LlmProvider` 인터페이스 + `createProvider()`. 지금은 HASA 하나지만 **계약을 먼저 만든다** |
| **Z-2** | `BaseOpenAiCompatibleProvider` — OpenAI 호환 게이트웨이는 baseURL/헤더만 다르고 나머지는 공유 | `OpenAiCompatibleProvider` 추상 클래스. HASA는 여기를 상속해 default baseUrl·capability 힌트·에러 해석만 덮어씀 |
| **Z-3** | 스트리밍을 `tool_call_partial` → `tool_call_end` 이벤트로 정규화. 소비자가 `delta.tool_calls`를 몰라도 됨 | `ProviderStreamEvent` 합타입 (§27 요구사항 그대로). Agent Core는 `choices[0].delta`를 **타입 레벨에서 볼 수 없다** |
| **Z-4** | `modelCache.ts`: 메모리(TTL) + 디스크 2단 캐시, **in-flight 중복 요청 제거**, 실패 시 기존 캐시로 graceful degradation | `HasaModelRegistry`. 동일 설계 |
| **Z-5** | 캐시 키를 API Key **자체가 아니라 되돌릴 수 없는 축약 다이제스트**로 스코프. auth-scoped provider는 캐시 자체를 우회 | `fingerprint()`(sha256 앞 12자)로 스코프. 이 저장소에 이미 존재하므로 새로 만들지 않는다 |

### 4.3 차용하지 않는 것

* **Generic OpenAI Compatible provider를 사용자에게 노출하는 것** — §8 요구사항대로 HASA는 First-Class Provider다. base URL·헤더를 사용자가 입력하게 만들지 않는다.
* Zoo의 40개 provider 목록 — 우리는 HASA 하나면 된다. 추상화는 **교체 가능성이 아니라 테스트 가능성**을 위해 만든다.
* Zoo의 Mode 구현 세부 — Mode 이름(CODE/ARCHITECT/DEBUG/ASK)만 정합성 있게 맞춘다.

---

## 5. Cline에서 참고할 구조

조사 대상: `cline/cline`. 저장소는 `apps/{vscode,cli,cline-hub}` + `sdk/` 구조다.

### 5.1 차용하는 설계 6가지

| # | Cline의 설계 | 우리가 가져가는 형태 |
|---|---|---|
| **C-1** | **Plan / Act 분리** — 계획 단계에서는 파일을 쓰지 않는다 | `ARCHITECT` Mode = 쓰기 도구 미노출. Mode가 ToolRegistry의 필터가 된다 |
| **C-2** | **모든 쓰기·실행은 사람 승인을 거친다.** LLM은 "요청"만 하고 실행은 호스트가 한다 | `ApprovalManager`. 이 저장소의 `commands.ts` allowlist + `sandbox.ts` 감금이 이미 하부에 있다 |
| **C-3** | **Checkpoint / Revert** — 에이전트가 쓰기 전 상태를 스냅샷하고 되돌릴 수 있게 한다 | `CheckpointManager`. `git.ts`의 `snapshot()`(stash 기반)과 worktree를 재사용 |
| **C-4** | **Diff 기반 리뷰** — 변경을 에디터 diff로 보여주고 승인받는다 | 확장이 이미 `openTextDocument({language:"diff"})`로 한다. 그대로 승격 |
| **C-5** | **`.clinerules` 프로젝트 규칙** | `HASA.md` / `.hasa/rules.md` / 기존 `AGENTS.md` 인식 (§18) |
| **C-6** | **Context management** — 파일을 통째로 넣지 않고 필요한 만큼 조립 | `ContextBuilder`. Z2 이후 |

### 5.2 핵심 루프 (§5 요구사항)

```
LLM → Tool Request → Safety/Approval → Execution → Tool Result → LLM
```

이 저장소의 `src/runtime/agentRunner.ts`가 **이미 이 형태다.** 다만 두 가지가 없다:

1. **사람 승인 지점이 없다** — 후보는 격리된 worktree에서 돌기 때문에 승인 없이 자동 실행한다.
2. **대화가 아니다** — 한 번의 `run()`으로 끝난다. 후속 지시를 받을 수 없다.

Z2의 `AgentLoop`는 `agentRunner.ts`를 **버리는 것이 아니라 확장**한다: 승인 훅과 세션 지속성을 추가한다.

### 5.3 차용하지 않는 것

* Cline SDK(`@cline/sdk`) 임베드 — `docs/architecture.md` §6.2.1의 판단을 유지한다. sandbox 보증(realpath 감금, allowlist, 키 비상속)은 **우리 코드에서 테스트로 증명**해야 하고, 승인 콜백만으로는 증명할 수 없다.
* Agent Teams / 멀티 에이전트 위임 — 우리의 멀티 모델은 **위임이 아니라 중복 실행 + 검증**이다. 목적이 다르다.

---

## 6. 발견한 문제

Z0 분석에서 실제로 나온 것들이다. Z1~Z3 계획이 이것을 해결한다.

| # | 문제 | 영향 | 해소 시점 |
|---|---|---|---|
| **P1** | **Provider 추상화가 없다.** `HasaClient`가 곧 HASA이고, `agentRunner.ts`가 `client.chat(...)`로 OpenAI wire 형식을 직접 다룬다 | §27 위반. Agent Core에 provider 지식이 샌다 | **Z1** |
| **P2** | **모델 목록과 Capability가 파일(`.arena/capability-matrix.json`)에 묶여 있다.** `ModelRegistry.load()`가 파일이 없으면 빈 목록을 반환하고, 확장의 모델 선택기가 비어버린다 | 사용자가 `pnpm probe`를 CLI로 먼저 돌려야 모델이 보인다. "API Key만 넣으면 된다"는 목표와 충돌 | **Z1** (동적 조회 + 캐시), Z2(확장 연결) |
| **P3** | **`/v1/models` 성공을 키 유효성으로 착각할 여지가 있다.** 현재 확장의 `loadModels()`는 orchestrator `/models`(=matrix 파일)만 보므로 키 검증 경로 자체가 없다 | 잘못된 키로도 "연결됨"처럼 보일 수 있다 | **Z1** (Provider Validation) |
| **P4** | **API Key가 `SecretStorage` → 자식 프로세스 env로 흐른다.** 안전하지만, Provider를 확장 호스트에서 직접 쓰려면 다른 경로가 필요하다 | Z2에서 확장 호스트가 Provider를 직접 들 때 재설계 필요 | Z2 (문서화만 Z1) |
| **P5** | **Arena가 기본 경로다.** `extension.ts`의 유일한 진입점이 `hasaArena.compare`이고, webview는 후보 수·judge 모델을 사용자에게 묻는다 | §24 UI 원칙과 정면 충돌 | Z3 |
| **P6** | **`erasableSyntaxOnly` 제약** — enum, parameter property 금지. 상대 import에 `.ts` 확장자 필수 | 새 코드가 이 제약을 어기면 typecheck가 깨진다 | Z1부터 준수 |
| **P7** | **`extension/`이 `src/`를 import할 수 없다.** rootDir·모듈 시스템이 다르다 | Provider를 확장에서 쓰려면 (a) HTTP 경유, (b) 타입 재선언, (c) 빌드 파이프라인 도입 중 택1 | Z2에서 결정. **Z1은 `src/`에만 둔다** |
| **P8** | **`granite-guardian-3.1-8b`의 capability가 `unknown`으로 남아 있다** (503 반복) | Auto 선택이 `unknown`을 `fail`로 취급하면 정상 모델을 배제한다 | Z1의 `ModelCapabilities` 3-상태(§11)가 이를 타입으로 강제 |

---

## 7. 목표 Architecture

### 7.1 전체 계층

```
┌───────────────────────────────────────────────────────────┐
│  VS Code Extension            (Z3)                        │
│  Chat / Mode 선택 / Diff / Approval / 설정                 │
│  — webview는 신뢰 경계 밖. { hasApiKey: true } 만 받는다   │
└───────────────────────────┬───────────────────────────────┘
                            │  AgentStreamEvent (SSE / postMessage)
                            ▼
┌───────────────────────────────────────────────────────────┐
│  Coding Agent Core            (Z2)                        │
│  AgentSession · AgentLoop · ContextBuilder                │
│  ToolRegistry · ToolExecutor · ApprovalManager             │
│  CheckpointManager                                        │
│  — provider-agnostic. OpenAI wire 형식을 모른다           │
└───────────────────────────┬───────────────────────────────┘
                            │  LlmProvider (정규화 계약)
              ┌─────────────┴─────────────┐
              ▼                           │
┌───────────────────────────────┐         │
│  HASA Harness      (Z4)       │         │
│  TaskAnalyzer · AgentRouter   │         │
│  StrategySelector             │         │
│  ConfidenceManager            │         │
└───┬───────────────────────┬───┘         │
    │ single                │ best_of_n   │
    ▼                       ▼             │
 Coding Agent          Arena Adapter      │
 (위와 동일)                │             │
                            ▼             │
              ┌──────────────────────────┐│
              │ 기존 Arena (그대로 유지) ││
              │ RunManager/CodeRunManager││
              │ decide S0~S4 / judge     ││
              └────────────┬─────────────┘│
                           │              │
                           ▼              ▼
┌───────────────────────────────────────────────────────────┐
│  HASA Provider                (Z1) ← 이번 구현 범위        │
│  LlmProvider 계약 · OpenAiCompatibleProvider               │
│  HasaProvider · HasaCredentialStore · HasaModelRegistry    │
│  HasaCapabilityResolver · hasaErrorMapper                  │
└───────────────────────────┬───────────────────────────────┘
                            │  reuse (중복 HTTP 구현 없음)
                            ▼
              ┌──────────────────────────┐
              │  HasaClient (기존)       │
              │  auth/retry/SSE/redact   │
              └────────────┬─────────────┘
                           ▼
                   open.hasa.re.kr/v1
```

### 7.2 Z1이 만드는 파일 구조

```
src/provider/
  index.ts                    배럴
  types.ts                    LlmProvider 계약 + 정규화 타입
  errors.ts                   ProviderError + ProviderErrorCode
  credentials.ts              CredentialStore 포트 + 메모리/환경변수 구현
  modelCache.ts               ModelCacheStore 포트 + 메모리/파일 구현
  openai-compatible/
    wire.ts                   정규화 타입 ↔ OpenAI wire 변환 (양방향)
    openaiCompatibleProvider.ts   OpenAI 호환 게이트웨이 공통 구현
  hasa/
    defaults.ts               기본 endpoint·타임아웃 (모델 ID는 없음)
    hasaTransport.ts          HasaClient 어댑터 (ChatTransport 포트)
    hasaErrorMapper.ts        HasaError → ProviderError (403 allowed_models 등)
    hasaCredentialStore.ts    SecretStorage 포트 기반 키 보관
    hasaModelRegistry.ts      동적 모델 조회 + 2단 캐시 + fallback
    hasaCapabilityResolver.ts lazy capability 조회 + 캐시
    hasaProvider.ts           HasaProvider (validate 포함)
```

### 7.3 정규화 계약의 핵심 (§27)

```ts
// Agent Core가 보는 유일한 도구 호출 형태
interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: unknown;      // 파싱된 값
  rawArguments: string;    // 파싱 실패 시 원문을 모델에게 되돌려주기 위해 보존
  argumentsValid: boolean;
}

// Agent Core가 보는 유일한 스트림 형태
type ProviderStreamEvent =
  | { type: "text";            delta: string }
  | { type: "reasoning";       delta: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_delta"; index: number; argumentsDelta: string }
  | { type: "tool_call_end";   index: number; toolCall: NormalizedToolCall }
  | { type: "usage";           usage: NormalizedUsage }
  | { type: "done";            finishReason: FinishReason };
```

`choices[0].delta.tool_calls`는 `src/provider/openai-compatible/` 밖으로 나가지 않는다.

### 7.4 Capability는 3-상태다 (§11)

```ts
type CapabilityState = boolean | "unknown";
```

`unknown`을 `false`로 접으면 안 된다. 실측에서 `granite-guardian-3.1-8b`가 503 때문에 `unknown`으로 남았고, 이를 `false`로 취급하면 게이트웨이 장애를 모델의 무능력으로 영구 기록하게 된다. **모델 이름으로 능력을 추측하는 코드는 넣지 않는다.**

---

## 8. Dependency Direction

```
protocol
   ↑
hasa-client ──────────────┐
   ↑                      │ (재사용)
probe                     │
   ↑                      │
provider  ────────────────┘        ← Z1
   ↑
agent (Coding Agent Core)          ← Z2
   ↑
harness                            ← Z4
   ↑            ↘
server/cli       arena-adapter → core (기존 Arena)
   ↑
extension (HTTP + 자식 프로세스로만)
```

**불변식**

1. `provider`는 `core`(Arena)를 **모른다.** Arena가 provider를 쓰는 것은 가능하지만 역방향은 금지.
2. `agent`는 `hasa-client`를 **직접 import하지 않는다.** `provider` 계약만 본다.
3. `harness`는 `arena-adapter`를 통해서만 Arena를 부른다. **Arena 로직을 harness 안에 복사하지 않는다** (§22).
4. `provider`는 `vscode` 모듈을 import하지 않는다. VS Code 의존은 **구조적 포트**(`SecretStorageLike`)로만 표현한다 — 그래야 `pnpm test`가 확장 없이 돈다.

---

## 9. 유지 / 재사용 / 분리 / 신규

### 9.1 그대로 유지 (건드리지 않는다)

```
src/core/**          Arena 전부 — runManager, codeRunManager, decide, judge, refine,
                     fairness, gates, checks, scheduler, store, events, registry
src/runtime/**       agentRunner, patchRunner
src/server/**        Fastify 라우트
src/cli/**           pnpm arena
extension/**         현재 Arena UI (Z3에서 확장하되 Z1에서는 무변경)
기존 테스트 277개    하나도 삭제하거나 완화하지 않는다
```

### 9.2 재사용 (import해서 쓴다)

| 재사용 | 어디서 |
|---|---|
| `HasaClient` | `HasaProvider`의 transport. 새 HTTP 클라이언트를 만들지 않는다 |
| `HasaError`, `classifyStatus` | `hasaErrorMapper.ts`의 입력 |
| `assembleStream`, `parseChunk` 개념 | `wire.ts`가 같은 index 규약으로 조립 |
| `fingerprint`, `registerSecret`, `evidence` | 캐시 키 스코프 + 로그 마스킹 |
| `ModelsResponseSchema` | 모델 목록 파싱 |
| `CapabilityMatrix` 타입·`computeEligibility` | `hasaCapabilityResolver.ts` |
| `startMockHasa` | Z1 테스트 전부 |
| `git.ts`, `sandbox.ts`, `commands.ts` | Z2 CheckpointManager / ToolExecutor |

### 9.3 분리 (책임을 옮긴다)

| 지금 | 옮길 곳 | 시점 |
|---|---|---|
| `agentRunner.ts`가 `client.chat()`을 직접 호출 | `LlmProvider.stream()` 경유 | Z2 (**Z1에서는 건드리지 않음** — 회귀 위험) |
| `ModelRegistry`(matrix 파일 전용) | `HasaModelRegistry`(네트워크) + `HasaCapabilityResolver`(matrix) 2개로 분리 | Z1 |
| 확장의 `SECRET_KEY = "hasaArena.apiKey"` 상수 | `HasaCredentialStore` | Z2 (키 이름은 하위 호환 유지) |

### 9.4 신규 구현

| 시점 | 신규 |
|---|---|
| **Z1** | `src/provider/**` 전체 (§7.2) |
| Z2 | `src/agent/**` — AgentSession, AgentLoop, ContextBuilder, ToolRegistry, ToolExecutor, ApprovalManager, CheckpointManager |
| Z3 | 확장의 Chat webview, Mode 선택기, Approval/Diff UX, 설정 화면 |
| Z4 | `src/harness/**` — TaskAnalyzer, AgentRouter, StrategySelector, ConfidenceManager, ArenaAdapter |

---

## 10. Security Architecture

기존 `docs/security-policy.md`를 **확장하되 완화하지 않는다.**

### 10.1 API Key 흐름

```
사용자 입력 (webview 또는 VS Code InputBox)
        │  postMessage { type: "submitApiKey", value }   ← 이 방향만 허용
        ▼
Extension Host
        │  context.secrets.store("hasaArena.apiKey", value)
        ▼
VS Code SecretStorage  (OS 키체인)
        │
        ├─► 자식 프로세스 env HASA_API_KEY  (현재 Arena 경로, 유지)
        └─► HasaCredentialStore.get()       (Z2 in-process Provider 경로)
                ▼
        HasaClient — Authorization: Bearer …

Webview ◄── { hasApiKey: true, keyFingerprint?: "sha256:9f2c…" }   ← 이것만
```

### 10.2 금지 사항 (테스트로 강제)

| 금지 | Z1 테스트 |
|---|---|
| `settings.json` / `workspaceState` / `globalState` / JSON 평문 저장 | `CredentialStore`가 SecretStorage 포트만 받도록 타입 강제 |
| **모델 캐시 파일에 키 저장** | 캐시 직렬화 결과에 키 문자열이 없음을 assert |
| Extension Host → Webview 로 키 재전송 | 확장 메시지 타입에 키 필드 부재 (기존 `types.ts`가 이미 보장) |
| 로그·에러 본문에 키 노출 | `bodySnippet`/`message`에 키 미포함 assert (기존 테스트 확장) |
| webview가 HASA API 직접 호출 | webview에 키·baseUrl을 주지 않음 (§26) |

### 10.3 캐시 키 스코프 (Zoo Z-5 차용)

모델 캐시는 서로 다른 키의 결과가 섞이면 **권한 정보가 교차 노출**된다. 따라서 캐시 엔트리는 다음으로 스코프한다.

```
cacheKey = `${baseUrl}::${fingerprint(apiKey)}`      // fingerprint = sha256 앞 12자
```

키 자체는 캐시에 들어가지 않고, 지문은 되돌릴 수 없다. 이 함수는 이미 `redact.ts`에 있다.

---

## 11. Phase별 구현 계획

| Phase | 범위 | 산출물 | 금지 |
|---|---|---|---|
| **Z0** | 분석 + 설계 | 이 문서 | 대규모 리팩터링 |
| **Z1** | **HASA Provider** | `src/provider/**` + 단위 테스트 | AgentLoop, Harness, Arena 수정, Webview 재설계 |
| **Z2** | **Coding Agent Core — 완료** | `src/agent/**`. Mode 4개, 승인, 체크포인트/되돌리기 | Harness 라우팅, 다중 모델 |
| Z3 | VS Code Chat UX | Mode 선택, Approval/Diff, 설정 화면, ✨Auto 표시 | Arena UI 제거(병존시킨다) |
| Z4 | Harness | TaskAnalyzer/Router/Strategy + `single` / `generate_review` | Adaptive escalation |
| Z5 | Arena Adapter | `best_of_n` 전략으로 기존 Arena 호출 | Arena 재작성 |
| Z6 | Adaptive Escalation | LEVEL 0~3 (`decide.ts` S0~S4 재사용) + Synthesis | — |

### 11.0 Z2 상세 — **완료**

```
src/agent/
  types.ts            계약 — Mode, ToolRisk, 승인, 이벤트, 예산
  modes.ts            CODE / ARCHITECT / DEBUG / ASK
  approval.ts         Safe / Balanced / Auto 정책
  checkpoint.ts       git stash 기반 스냅샷·되돌리기
  tools/registry.ts   Mode 상한으로 필터링되는 도구 목록
  tools/fileTools.ts  list_files, read_file, search_files, create_file, apply_patch
  tools/shellTools.ts execute_command (allowlist), get_git_diff
  loop.ts             AgentLoop
  session.ts          AgentSession (대화 + 체크포인트 소유)
  hasaModel.ts        Provider ↔ Loop 결합
```

핵심 설계 결정 4가지.

1. **Mode는 프롬프트 이전에 능력 경계다.** ARCHITECT는 쓰기 도구를 승인 단계에서 막는 게 아니라 **애초에 받지 않는다**. 모델이 볼 수 있는 제약은 언젠가 협상 대상이 된다.
2. **`dangerous`는 어떤 Mode도 허용하지 않고, 묻지도 않는다.** 사용자가 예라고 답할 수 있는 질문은 언젠가 잘못된 순간에 예라고 답하게 된다.
3. **체크포인트는 첫 쓰기 *전*에 잡는다.** 마지막 쓰기 후가 아니라 — 그 사이에 크래시가 나는 순간이 정확히 스냅샷이 필요한 때다.
4. **거부는 예외가 아니라 결과다.** sandbox 위반, 명령 거부, 없는 도구, 사용자의 "아니오" — 전부 모델이 읽고 다르게 시도할 수 있는 텍스트로 돌아간다.

예산 4개(`maxSteps`/`maxModelCalls`/`maxToolCalls`/`timeoutMs`)와 **동일 도구·동일 인자 반복 감지**를 분리한 이유는 실패 양상이 다르기 때문이다 — 앞의 넷은 비용 문제이고, 반복은 진전이 없다는 신호다.

Arena의 `sandbox.ts`(realpath 감금)·`commands.ts`(allowlist)·`git.ts`(stash)를 **수정 없이 재사용**했다. 새로 만든 것은 *언제* 부르는지와 *누구에게 먼저 묻는지*다.

`git.ts`에는 사용자 저장소용 연산 3개를 추가했다: `changedPaths`(인덱스 미변경 목록), `diffAgainst`(인덱스 미변경 diff), `discardTo`/`restore`(되돌리기). 되돌리기는 **HEAD가 움직였으면 거부**하고, **stash를 top이 아니라 identity로 찾는다** — 사용자가 그 사이에 stash를 만들었다면 top을 pop하는 순간 남의 작업을 잃는다.

### 11.1 Z1 상세 — **완료**

| # | 항목 | 파일 | 완료 기준 | 상태 |
|---|---|---|---|---|
| 1 | Provider 추상화 | `types.ts`, `openai-compatible/**` | Agent Core가 OpenAI 타입을 보지 않는다 (타입 레벨) | ✅ |
| 2 | Credential Store | `credentials.ts`, `hasa/hasaCredentialStore.ts` | save/get/delete + 지문. vscode import 없음 | ✅ |
| 3 | Model Registry | `hasa/hasaModelRegistry.ts` | 하드코딩 모델 ID 0개. `GET /v1/models` 동적 조회 | ✅ |
| 4 | Model Cache | `modelCache.ts` | 네트워크 실패 시 마지막 성공 목록 반환. 캐시에 키 없음 | ✅ |
| 5 | Chat Completion | `hasa/hasaProvider.ts` | 선택 모델로 요청 성공 | ✅ |
| 6 | Streaming | `openai-compatible/wire.ts` | `AsyncGenerator<ProviderStreamEvent>` | ✅ |
| 7 | Error Mapper | `hasa/hasaErrorMapper.ts` | 401/403/404/429/503/timeout/network 구조화 | ✅ |
| 8 | Provider Validation | `hasa/hasaProvider.ts` | **모델 목록 성공 ≠ 키 유효**를 구분 | ✅ |

추가로 `hasa/hasaCapabilityProbe.ts`(lazy + cache), `hasa/hasaTransport.ts`(기존 `HasaClient` 어댑터), `hasa/defaults.ts`를 구현했다.

검증: `pnpm test` 842 pass (기존 277 + 신규 565) / `pnpm typecheck` OK / `pnpm build:extension` OK / `pnpm probe --mock` OK.
기존 Arena·서버·확장 코드는 한 줄도 수정하지 않았다. `src/hasa-client/client.ts`에 `listModelRecords()`가 **추가**됐을 뿐이며 `listModels()`의 동작은 동일하다.

### 11.2 Z1 테스트 (§31) — 3계층

전부 `src/testing/mock-hasa.ts` 또는 주입된 stub 기반. **실제 키·네트워크 불필요.**

파일 이름이 곧 계층이다.

| 계층 | 파일 | 무엇을 잡는가 |
|---|---|---|
| **`*.test.ts`** | 계약 | 명세된 동작. "이렇게 쓰면 이렇게 된다" |
| **`*.edge.test.ts`** | 경계 | 게이트웨이가 실제로 하는 이상한 짓, 그리고 falsy·빈 값·손상된 상태 |
| **`*.fuzz.test.ts`** | 속성 | 생성된 입력에 대한 불변식. **작성자가 고르지 않은 케이스** |
| `*.integration.test.ts` | 실물 | `HASA_API_KEY` 있을 때만. CI는 키를 요구하지 않는다 |

#### 필수 커버리지 (§31 요구 항목)

| 테스트 | 위치 |
|---|---|
| SecretStorage save / get / delete | `credentials*.test.ts` |
| 키 누출 방지 (캐시 파일 바이트·로그·에러·검증 결과) | 전 계층 + fuzz 불변식 |
| model list 성공 / 빈 목록 / malformed | `hasaModelRegistry*.test.ts` |
| network error / timeout / cache fallback | 〃 |
| stream parsing (text / reasoning / tool_call) | `wire*.test.ts` |
| 401 / 403 / 404 / 429 / 503 | `hasaErrorMapper*.test.ts` |
| abort | `hasaProvider*.test.ts` |
| **validation: 목록 공개 ≠ 키 유효** | `hasaProvider*.test.ts` |

#### Fuzz / Soak

시드 기반이라 실패는 항상 재현 가능하고, 기본 반복 횟수는 CI가 몇 초에 끝날 만큼 작다.

```bash
pnpm test                                  # 경계 + 속성 포함, 기본 반복
pnpm test:fuzz                             # 속성 테스트만
HASA_FUZZ_ITERATIONS=2000000 pnpm test:fuzz    # soak (수십 분~시간)
HASA_FUZZ_SEED=13579246 pnpm test:fuzz         # 다른 영역 탐색
HASA_FUZZ_SEED=24307 HASA_FUZZ_ITERATIONS=1 pnpm test:fuzz   # 실패 재현
```

실패 메시지에 재현 명령이 그대로 들어간다.

실행한 soak 결과:

| 규모 | 속성 수 | 결과 | 소요 |
|---|---|---|---|
| 케이스 2,000,000개 | 10 | 0 fail | 12.7분 |
| 케이스 3,000,000개 (seed 777000111) | 17 | 0 fail | 26.3분 |

검증되는 주요 불변식:

```text
streamEvents
  done은 정확히 1회, 항상 마지막
  text/reasoning delta를 이으면 원문과 바이트 단위로 동일
  tool_call_end 앞에는 반드시 같은 index의 start가 있다
  한 index의 delta를 모두 이으면 그 호출의 arguments와 정확히 같다
  usage는 최대 1회, 바로 done 앞

HasaProvider
  chat  → 정상 응답 또는 분류된 ProviderError
  stream→ done으로 끝나거나 분류된 ProviderError
  validate → 항상 보고서를 반환. 취소 외에는 예외를 던지지 않는다
  목록에 빈 ID·중복 ID가 없다
  어떤 표면에도 API Key가 없다
```

#### 이 3계층이 실제로 찾아낸 결함 (16건 + 성능 1건)

**전부 계약 테스트를 통과하던 것들이다.** 어느 것도 예외를 던지지 않았고, 그럴듯한 결과를 반환했다.

| # | 결함 | 증상 | 발견 |
|---|---|---|---|
| 1 | `arguments`가 JSON 스칼라(`5`, `null`, `[1,2]`)여도 valid 처리 | `arguments.path`가 조용히 `undefined` | edge |
| 2 | 게이트웨이가 `"model": ""`을 echo하면 요청 모델 ID가 지워짐 | 라벨이 빈칸 | edge |
| 3 | 이름보다 먼저 온 tool argument 조각이 delta로 방출 안 됨 | UI는 잘린 인자, 에이전트는 전체 | **fuzz** |
| 4 | **동시 캐시 쓰기가 여러 writer의 내용이 섞인 파일을 게시** | 40회 중 16회 손상, 1회 파싱 불가 | edge |
| 5 | 고유 임시 파일명 도입 후 Windows에서 rename 실패분이 영구 잔류 | 1회 실행에 265개 잔해 | edge |
| 6 | 시계 역행 시 캐시가 TTL을 넘겨 계속 fresh | 역행 폭만큼 stale 목록 고정 | edge |
| 7 | 빈 ID·중복 ID가 모델 선택기까지 도달 | 빈 행, 중복 행 | edge |
| 8 | 캐시 쓰기 실패가 목록 조회 전체를 실패시킴 | 디스크가 차면 모델 목록이 안 보임 | edge |
| 9 | 동일 모델에 대한 동시 `ensure`가 중복 추론 요청 | 패널 하나 열면 10회 요청 | edge |
| 10 | 로드 중 `invalidate`가 무시되어 폐기한 matrix가 부활 | 잘못된 capability 재적용 | edge |
| 11 | `save`의 동기 예외가 측정 결과를 유실 | 실제 요청 비용을 낭비 | edge |
| 12 | `retryable`과 `terminal`이 동시에 참일 수 있음 | 에이전트가 403을 재시도하며 예산 소진 | **fuzz** |
| 13 | **캐시된 목록을 "연결됨"으로 보고** | 장애 진단 중인 사용자에게 정반대를 알림 | edge |
| 14 | `Object.create(null)`이 에러 매퍼를 크래시 | 예외를 막는 경로가 예외를 발생 | edge |
| 15 | `allowed_models: null`이 `"null"` 모델로 표시 | 없는 모델을 안내 | edge |
| 16 | 403의 `allowed_models`가 이중 매핑에서 유실 | 유일한 실행 가능 정보가 사라짐 | edge |
| P1 | 모델 조회가 카탈로그 크기에 대해 제곱 | 1000개 9ms → 4000개 112ms (수정 후 6ms) | scaling |

세 번째 결함은 특히 fuzz가 아니면 나오기 어려웠다. 불변식 하나 —
**"한 index의 delta를 모두 이으면 그 호출의 arguments와 정확히 같다"** — 이 잡아냈고,
그 불변식은 손으로 케이스를 고르는 방식으로는 떠올리기 어려운 종류다.

---

## 12. 최종 제품에서 사용자가 보는 것 (참고)

```
HASA

Mode
[ CODE ▼ ]

Model
[ ✨ Auto ]

─────────────────────

무엇을 만들어 드릴까요?

[                      ]

                 [Send]
```

결과는 개발 실무자의 언어로 보고한다 (§29).

```
수정 완료

원인
로그인 토큰 갱신 과정에서 예외가 정상 처리되지 않았습니다.

변경
2개 파일을 수정했습니다.

검증
✓ TypeScript
✓ Tests

[변경 내용 보기]   [적용]   [되돌리기]
```

`S0~S3`, `pairwise`, `consensus`, `judge model` 같은 어휘는 **Advanced Execution Details 안에만** 둔다.

---

## 13. 관련 문서

* `architecture.md` — Arena 아키텍처 (여전히 유효)
* `compatibility-matrix.md` — HASA API 실측 + probe 규약
* `security-policy.md` — 키 취급·명령 allowlist·격리 (이 문서가 확장)
* `evaluation-protocol.md` — 판정 사다리 (Z6의 재료)
* `redesign-plan.md`, `implementation-plan.md` — Arena Phase 0~4 기록
