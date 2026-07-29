# HASA Agent Arena — Implementation Plan

> 상태: **계획**. 코드는 아직 한 줄도 작성하지 않았다. 본 단계의 산출물은 분석 결과와 이 계획서다.

---

## 1. 착수 전 실측 요약

| 확인 항목 | 결과 |
|---|---|
| 작업 디렉터리 내용 | **비어 있음** (파일 0개) |
| `package.json` / lockfile / 테스트 | **없음** |
| git 저장소 루트 | **`C:/Users/KimGiHu`** — 홈 디렉터리 전체. remote `GITC_YNU_Education.git` |
| `git worktree list` | 단일 worktree (`C:/Users/KimGiHu`) |
| `node` / `npm` / `pnpm` / `corepack` | **PATH에 없음** |
| `git` | `2.36.1.windows.1` |
| VS Code CLI | 설치됨 |
| Cline SDK 설치본 | **없음** → 실제 API는 공식 문서·저장소 예제로만 확인 (§6) |

**두 가지 blocker가 있으며 코드 작성보다 먼저 해결해야 한다: Node 미설치, 그리고 홈 디렉터리가 git 루트라는 점.**

---

## 2. Phase -1 — 환경 부트스트랩 (blocker 해소)

이 단계 없이는 Phase 0을 시작할 수 없다.

### B1. 저장소 분리 (최우선)

현재 `HAFA_Extension`은 홈 디렉터리 저장소의 untracked 하위 폴더다. 이 상태의 문제:

1. `git worktree` 설계가 성립하지 않는다. worktree의 기준 저장소가 홈 디렉터리가 되어버린다.
2. Zoo Worktrees 문서도 "workspace는 **repository root**여야 하며 하위 폴더는 안 된다"고 명시한다. 동일 제약이 우리에게도 적용된다.
3. **사고 위험**: 홈 저장소에서 `git add -A`가 실행되면 `.ssh/`, `.aws/`, `.claude.json` 등 자격증명이 커밋된다.

조치:

```bash
cd /c/Users/KimGiHu/Downloads/HAFA_Extension
git init -b main
# .gitignore 작성 (node_modules, .arena/, .env*, dist, *.log …)
git add . && git commit -m "chore: bootstrap HASA Agent Arena"
```

- 홈 저장소 입장에서 이 폴더는 중첩 저장소가 되어 무시된다. 필요하면 홈 저장소 `.gitignore`에 경로를 추가한다.
- 원격 push는 사용자가 요청한 대로 **테스트 완료 후**에 진행한다.

> 별도 검토 필요: 홈 디렉터리가 git 저장소인 상태 자체가 위험하다. Arena와 무관하지만 사용자에게 별도로 알린다.

### B2. Node 22+ 설치

- `node`, `npm`이 전혀 없다. Node 22 LTS 설치 후 `corepack enable`로 pnpm 활성화.
- 검증: `node -v` (v22 이상), `pnpm -v`.
- Cline SDK가 **Node 22 이상을 요구**하므로 22 미만은 선택지가 아니다.

### B3. 워크스페이스 스캐폴딩

`architecture.md` §8의 패키지 레이아웃대로 pnpm workspace를 생성하고, TypeScript strict·lint·테스트 러너를 설정한다. 이 시점에 `pnpm typecheck` / `pnpm test` / `pnpm lint`가 빈 상태로도 통과해야 한다.

**수용 기준**: `pnpm install && pnpm typecheck && pnpm test`가 성공. `git log`에 최초 커밋 1개.

---

## 3. Phase 0 — Capability Probe

> 목적: **HASA가 native tool calling을 지원하는가**를 확인한다. 이 답에 따라 Phase 2의 기본 런타임이 결정되므로, 이것이 전체 계획에서 가장 중요한 단일 질문이다.

### 범위

- `packages/hasa-client` — 인증, 타임아웃, SSE 파서, `Retry-After` 준수 재시도, 로그 마스킹
- `packages/probe` — `compatibility-matrix.md` §3의 P1~P16 구현
- CLI: `pnpm probe`, `pnpm probe --deep`, `pnpm probe --mock`
- 산출물: `.arena/capability-matrix.json` + 콘솔 요약 + 실패 원인 목록
- **mock 서버**: 실제 HASA 없이 동작하는 fixture 기반 서버 (CI에서 사용)

### 하지 않는 것

파일 수정, worktree, 에이전트 루프, judge, HTTP 서버.

### 수용 기준

| # | 기준 |
|---|---|
| A0-1 | `pnpm probe`가 실제 HASA에 대해 완주하고 matrix JSON 생성 |
| A0-2 | 모든 모델에 대해 `tools` 항목이 `pass`/`fail`/`denied` 중 하나로 확정 |
| A0-3 | 401/403/404/429/503 각각에 대한 처리 동작이 mock 테스트로 검증됨 |
| A0-4 | `429`에서 `Retry-After`를 실제로 준수함이 mock으로 검증됨 |
| A0-5 | 로그·matrix 어디에도 API Key와 프롬프트 전문이 없음 (`security-policy.md` S1~S3) |
| A0-6 | `pnpm test`, `pnpm typecheck` 통과 |
| A0-7 | 실패한 모델의 원인(권한/미지원/오류)이 문서에 정리됨 |

### Phase 0 말미의 spike (별도, 시간 상자 1일)

**ClineCore + HASA provider 플러그인 연결 검증.** §6의 불확실 API를 실제 설치본으로 확인한다. 산출물은 코드가 아니라 "된다/안 된다 + 근거" 보고서다. 이 결과가 Phase 2 설계를 확정한다.

### 분기점 — **해소됨 (2026-07-29)**

```
tools = pass 인 모델이 2개 이상  →  Phase 2 기본 런타임 = ClineCore 어댑터   ← 이쪽
tools = pass 인 모델이 0~1개     →  Phase 2 기본 런타임 = patch-mode 어댑터
```

실측 결과 `exaone-4.0-32b`와 `gpt-oss-20b`가 native tool calling·round-trip·streaming tool_calls를 모두 통과했다. **Phase 2는 에이전트 루프 경로로 진행한다.** patch-mode 어댑터는 fallback으로 유지한다 — `qwen2.5-coder-32b`는 게이트웨이가 `--tool-call-parser` 없이 기동되어 차단된 상태이며(`compatibility-matrix.md` §8.3), 운영자 조치가 이루어지면 세 번째 agent 후보로, 아니면 patch-mode 리그의 주 후보로 합류한다.

R1(HASA가 tool calling 미지원)은 **해소**되었다. 다만 새로운 제약이 확인되었다: 이 키로 쓸 수 있는 chat 모델이 4개뿐이고 그중 agent 가능 모델이 2개이므로, **Phase 2의 코드 모드는 당분간 정확히 2개 후보로만 돌아간다.**

---

## 4. Phase 1 — Response Compare + 오케스트레이터 골격

> 목적: 코드 실행 없이 **평가 파이프라인 자체를 검증**한다. 익명화, 순서 뒤집기, 파싱 재시도, `no_winner` 경로를 전부 여기서 완성한다.

### 범위

- `packages/protocol` — Zod 스키마 (TaskSpec, CandidateSpec, ArenaEvent, 판정 결과)
- `packages/core`
  - **전역 스케줄러** — 모듈 스코프 싱글턴. 전역 + 모델별 동시성 제한. 요청 핸들러 내 생성 금지 (lint 규칙)
  - Run Manager, Registry(matrix 로드·자격 계산), `assertFairness`
  - Judge 클라이언트 (도구 없음, read-only)
- `packages/server` — Fastify + SSE. `127.0.0.1` 바인딩
- SQLite + JSONL 이중 저장
- CLI로 Run 생성·조회

### API

```
POST /runs           { mode: "response", candidates[], taskSpec, judge }
GET  /runs/:id
GET  /runs/:id/events        (SSE: queued/running/completed/failed)
GET  /runs/:id/candidates
GET  /runs/:id/verdicts
POST /runs/:id/cancel
GET  /models
```

### 수용 기준

| # | 기준 |
|---|---|
| A1-1 | 동일 프롬프트로 2개 모델 후보 실행 → 판정까지 완주 |
| A1-2 | judge 입력에 모델명·candidateId·경로가 없음 (테스트로 검증, S11) |
| A1-3 | AB/BA 2회 평가 수행, 불일치 시 `no_winner` (E1, E6) |
| A1-4 | judge JSON 파싱 실패 → 2회 재시도 → `no_winner` |
| A1-5 | 전역 동시성 제한이 **동시 다중 요청 상황에서** 실제로 적용됨 (부하 테스트) |
| A1-6 | `429` 시 `Retry-After` 기반 backoff 동작 |
| A1-7 | 후보 스펙 불일치 시 Run 생성 `400` (E7) |
| A1-8 | SSE 이벤트에 키·프롬프트 전문이 없음 (S4) |
| A1-9 | 서버가 `127.0.0.1` 외부에 바인딩되지 않음 (S14) |
| A1-10 | mock 모드로 전체 시나리오 테스트 가능 |

---

## 5. Phase 2 — Code Candidate 모드

> 목적: worktree 격리 + 객관 게이트 + diff 비교.

### 범위

- worktree 관리 (`architecture.md` §7) — 생성, baseline, diff 추출, 정리, 크래시 복구
- **baseline 실행** (`evaluation-protocol.md` §2.2) — 후보 실행 전 기준선 측정
- 명령 실행 샌드박스 — allowlist, `shell:false`, timeout, 프로세스 트리 kill
- 파일 접근 제한 — realpath 기준 worktree 경계, 금지 파일 목록
- `AgentRunner` 인터페이스 + 어댑터 2종 (ClineCore / patch-mode)
- 게이트 G0~G9 + 점수 산정
- `POST /runs/:id/apply` (명시적 승인 후에만) / `reject`

### 초반 필수 벤치마크

worktree마다 `node_modules` 설치가 필요한지, 비용이 얼마인지 **가장 먼저 측정**한다. 후보당 5분씩 걸리면 제품이 성립하지 않는다. pnpm store 공유·하드링크 전략을 여기서 결정한다.

### 수용 기준

| # | 기준 |
|---|---|
| A2-1 | 후보별 worktree가 동일 base commit에서 생성됨 |
| A2-2 | 후보 A가 후보 B의 worktree에 접근 불가 (S8) |
| A2-3 | worktree 밖 경로 접근 차단 — `..`, 절대경로, **symlink 경유** 포함 (S7) |
| A2-4 | `.env` 등 금지 파일 읽기 차단 (S9) |
| A2-5 | allowlist 밖 명령·셸 메타문자 차단 (S5, S6) |
| A2-6 | 후보 실패(빌드/테스트/타임아웃/403)가 Run 전체를 죽이지 않음 |
| A2-7 | 모든 후보 미달 시 `no_winner` (E3) |
| A2-8 | apply 전 메인 workspace의 `git status`가 깨끗함 (S10, E10) |
| A2-9 | apply 후 diff가 승자 후보의 diff와 일치. apply 전 상태로 복구 가능 |
| A2-10 | cancel / timeout / retry / cleanup 동작 |
| A2-11 | worktree가 검토 완료 전에 삭제되지 않음 |
| A2-12 | 프롬프트 인젝션이 판정을 뒤집지 못함 (S12, E5) |
| A2-13 | flaky 테스트 재실행 정책 동작 (E9) |

---

## 6. Phase 3 — VS Code Extension

### 범위

명령: `HASA: Compare Models`, `HASA: Show Run`, `HASA: Cancel Run`

화면: 모델 선택(자격 있는 모델만 표시) / 후보 수 / judge 모델 / acceptance command 입력 / 실행·취소 / 후보별 진행 상태 / 후보별 diff / 게이트 결과 / 점수와 판정 근거 / **Apply winner** / **Reject all**

### 보안 요구

- 키는 `SecretStorage`에서 읽어 **orchestrator 프로세스 env로만** 전달. webview 미전달 (S13)
- webview는 SSE/WebSocket으로 상태·결과만 수신
- Apply 버튼 이전에는 workspace 무변경
- diff는 VS Code 네이티브 diff 뷰어 사용

### 수용 기준

`403`/`429`/취소/`no_winner` 상태가 UI에 명확히 구분 표시되고, 접근성(키보드 탐색·대비)이 VS Code 기본 테마와 일관될 것.

---

## 7. 위험 레지스터

| # | 위험 | 확률 | 영향 | 완화 | 확인 시점 |
|---|---|---|---|---|---|
| R1 | ~~HASA가 native tool calling 미지원~~ | — | — | **해소됨.** `exaone-4.0-32b`·`gpt-oss-20b`에서 확인 | Phase 0 완료 |
| R1b | **키 권한이 4개 chat 모델로 제한** (agent 가능 2개) | 확정 | 중 — 후보 다양성 부족 | 코드 모드는 2개 후보로 시작. 권한 확대 또는 게이트웨이 조치로 완화 | Phase 0 완료 |
| R1c | **503에 `Retry-After` 헤더가 없음** | 확정 | 중 | backoff로 대응 (구현·실측 확인). `concurrency 3`에서 503이 관측되어 스케줄러 상한을 보수적으로 유지 | Phase 0 완료 |
| R1d | **probe 판정 로직 자체의 오탐** | 확정 | 대 — 정상 모델을 탈락시킴 | 실제 API 연동에서 3건 발견·수정 (`compatibility-matrix.md` §8.5). 각각 회귀 테스트 보유 | Phase 0 완료 |
| R2 | ClineCore가 plugin provider 등록으로 custom baseUrl을 실제로는 지원하지 않음 | 중 | 대 — 런타임 교체 | `AgentRunner` 인터페이스로 격리. Phase 0 spike로 조기 확인 | Phase 0 spike |
| R3 | 홈 디렉터리가 git 루트 | 확정 | 대 — worktree 불성립 + 자격증명 커밋 사고 | Phase -1 B1 | Phase -1 |
| R4 | Node 미설치 | 확정 | 대 — 착수 불가 | Phase -1 B2 | Phase -1 |
| R5 | worktree별 의존성 설치 비용 과다 | 중 | 대 — 실행 시간 비현실적 | Phase 2 초반 벤치마크. pnpm store 공유 | Phase 2 |
| R6 | 모델별 403으로 후보가 1개만 남음 | 중 | 중 — 비교 불가 | 후보 2개 미만이면 `no_winner`로 명시 종료 | Phase 1 |
| R7 | judge position bias | 고 | 대 — 평가 신뢰 붕괴 | AB/BA 2회 + 불일치 시 `no_winner` | Phase 1 |
| R8 | judge 프롬프트 인젝션 | 중 | 대 | 데이터 구분자 + judge에 최종 결정권 없음 | Phase 1~2 |
| R9 | flaky 테스트로 인한 오탈락 | 고 | 중 | 1회 재실행 + baseline 대비 판정 | Phase 2 |
| R10 | 429 재시도 폭풍 | 중 | 중 | `Retry-After` 준수 + 모델 큐 일시 정지 | Phase 0~1 |
| R11 | git 2.36 구버전의 worktree 동작 차이 | 저 | 중 | Phase 2에서 실제 검증. 필요 시 git 업그레이드 | Phase 2 |
| R12 | Windows 경로 길이 260자 제한 | 저 | 중 | worktree 경로를 짧게 유지 | Phase 2 |
| R13 | HASA 미공개 rate limit이 병렬 실행에 부적합 | 중 | 중 | 스케줄러 상한을 보수적으로 시작(모델당 1~2) 후 상향 | Phase 1 |
| R14 | 후보 실행 비용(토큰) 과다 | 중 | 중 | 후보 2개로 시작. 토큰 상한과 반복 상한 강제 | 전체 |
| R15 | `.worktreeinclude` 유사 기능으로 `.env` 복사 유혹 | 중 | 대 — 자격증명 유출 | 정책상 금지. 필요한 값은 orchestrator가 주입 | Phase 2 |

---

## 8. 불확실한 SDK API — 검증 필요 목록

> **중요:** Cline SDK가 이 환경에 설치되어 있지 않으므로(§1), 아래 내용은 전부 **공식 문서와 저장소 예제에서 읽은 것**이며 설치본으로 확인한 것이 아니다. 설치 후 실제 타입 정의로 재확인해야 한다.

### 8.1 문서·예제로 확인한 사항

| 항목 | 확인된 내용 | 출처 |
|---|---|---|
| 패키지 | `@cline/sdk`, `@cline/core`, `@cline/agents`, `@cline/llms`, `@cline/shared` | [SDK Overview](https://docs.cline.bot/sdk/overview) |
| Node 요구 | **22 이상** | 동일 |
| 진입점 | `new Agent({providerId, modelId, apiKey, maxIterations})`, `agent.subscribe(cb)`, `agent.run(prompt)` | 동일 |
| ClineCore | `ClineCore.create({clientName, backendMode})`, `start(input)`, `send({sessionId, prompt})`, `list()`, `readMessages(sessionId)`, `abort(sessionId)`, `subscribe(cb)` | [ClineCore](https://docs.cline.bot/sdk/clinecore) |
| 세션 config | `providerId`, `modelId`, `apiKey`, `systemPrompt`, `cwd`, `workspaceRoot`, `enableTools`, `toolPolicies` | 동일 |
| 도구 승인 | `toolPolicies: { read_files:{autoApprove:true}, run_commands:{autoApprove:false} }` 또는 `capabilities.requestToolApproval(request)` | 동일 |
| 플러그인 등록 | `config.extensions: [plugin]` 또는 `config.pluginPaths: ["/abs/path.ts"]` | [Plugins](https://docs.cline.bot/sdk/plugins) |
| **custom baseUrl (세션 config)** | **지원됨** (설치본 검증 완료). `CoreModelConfig`에 `providerId`, `modelId`, `apiKey`, `baseUrl`, `headers`, `knownModels`, `temperature`, `maxTokensPerTurn`가 있다 | `@cline/core@0.0.66` `dist/types/config.d.ts` |
| ~~discussion #10322~~ | **낡은 정보였다.** 그 논의는 미지원 상태를 전제하지만, 0.0.66에는 이미 구현되어 있다. 설치본 타입 정의가 문서·논의보다 우선한다 | 실측 |
| `LlmsConfig.providers` | `ProviderSelectionConfig`에 `baseUrl`, `apiKey`, `apiKeyEnv`, `headers`, `timeoutMs`, `capabilities`가 있어 provider 단위 등록도 가능 | `services/llms/runtime-types.d.ts` |
| **custom baseUrl (플러그인)** | `Llms.registerProvider({ provider: { id, protocol:"openai-chat", client:"openai-compatible", baseUrl, defaultModelId, env:[…], capabilities, source:"file" }, models })` + `api.registerProvider({name, description, metadata})` | [openrouter-provider 예제](https://github.com/cline/cline/tree/main/sdk/examples/plugins) |
| 키 해석 | 예제 주석: "게이트웨이가 `baseUrl`로 핸들러를 만들고, API 키는 **세션 config 또는 provider에 선언된 `env` 변수**에서 해석" | 동일 |

### 8.2 검증해야 할 불확실 항목

| # | 불확실 항목 | 왜 중요한가 | 검증 방법 |
|---|---|---|---|
| U1 | `Llms.registerProvider`가 설치된 버전에서 동일 시그니처인지 | HASA 연결의 유일한 경로 | 설치 후 `@cline/core` 타입 정의 확인 + 최소 재현 실행 |
| U2 | `Llms.ModelInfo.capabilities` 허용값 정확한 집합 | probe 결과를 매핑해야 함 | 타입 정의 확인 |
| U3 | 모델 카탈로그를 **런타임에 동적 구성**해도 되는지 (예제는 정적) | 모델 ID 하드코딩 금지 제약 | spike에서 동적 카탈로그로 실행 |
| U4 | 세션 config의 `apiKey`가 플러그인 provider에도 적용되는지, 아니면 `env`만 유효한지 | 키 취급 정책(§`security-policy.md` §1.3)에 직결 | spike |
| U5 | provider `env`로 선언한 키가 **에이전트가 실행하는 셸 명령에 상속되는지** | 상속되면 키 유출 경로 | spike에서 `env` 덤프 명령으로 확인 |
| U6 | `requestToolApproval` request 객체에 **명령 인자가 포함되는지** | allowlist 검사에 인자가 필요 | spike |
| U7 | `run_commands` 도구의 `cwd`를 worktree로 강제할 수 있는지 | 격리의 핵심 | spike |
| U8 | ClineCore가 **한 프로세스에서 다중 세션 병렬 실행**을 지원하는지 | 후보 병렬 실행 구조 결정 | spike (2세션 동시 실행) |
| U9 | `backendMode: "local"`이 외부 서비스 의존 없이 동작하는지 | 오프라인·폐쇄망 요구 | spike |
| U10 | `abort(sessionId)`가 실행 중 자식 프로세스까지 정리하는지 | cancel 정확성 | spike |
| U11 | 세션 이벤트에 토큰 사용량·도구 호출 수가 포함되는지 | G9 비용 게이트 | spike |
| U12 | 플러그인이 TypeScript 소스(`pluginPaths`)로 로드될 때 트랜스파일 요구사항 | 배포 형태 결정 | spike |
| U13 | SDK가 자체 텔레메트리를 전송하는지 | 보안 정책 | 설치 후 네트워크 관찰 + 문서 확인 |
| U14 | `@cline/sdk` 라이선스 및 임베드 조건 | 배포 가능성 | 패키지 LICENSE 확인 |

> **U1~U12는 Phase 0 spike에서 한 번에 확인한다.** 결과에 따라 `runtime-cline` 어댑터를 채택하거나, `runtime-patch`만으로 Phase 2를 진행한다. **어느 쪽이든 Phase 2를 시작할 수 있도록 `AgentRunner` 인터페이스를 먼저 확정한다.**

### 8.3 HASA API 불확실 항목

`compatibility-matrix.md` §2.3에 정리되어 있다. 요약하면 **tool calling·structured output·seed·실제 context/output 상한·동시 요청 허용치**가 전부 미확인이며 Phase 0에서 확정된다.

---

## 9. 단계별 게이트

각 Phase는 앞 Phase의 수용 기준을 모두 만족해야 시작한다.

```
Phase -1  →  node -v ≥ 22, 독립 git 저장소, pnpm test 통과
Phase 0   →  capability matrix 확정, tool calling 여부 확정, spike 보고서
Phase 1   →  judge 파이프라인 검증 완료 (E1/E6/E7 통과), 전역 동시성 검증
Phase 2   →  격리·게이트·apply 검증 완료 (S5~S10, E2/E3/E5 통과)
Phase 3   →  UI
```

**원격 저장소 push는 사용자 요청대로 Phase 0~1 테스트 통과 후에 진행한다.** push 전 secret 스캔을 반드시 1회 실행한다.

---

## 10. 지금 단계에서 하지 않은 것

- 소스 코드 작성 (요청에 따라 분석·계획만 제출)
- 기존 파일 수정 (수정 대상 파일 자체가 없음)
- `git init` 실행 (Phase -1 승인 후 진행)
- Node 설치 (사용자 환경 변경이므로 승인 필요)
- 실제 HASA API 호출 (API Key 미보유)
- Cline SDK 설치 (Node 부재)
