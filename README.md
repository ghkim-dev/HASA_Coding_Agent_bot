# HASA 하네스 자동 설계 디자이너

**요구사항을 그대로 쓰면, 그 일에 맞는 LLM을 근거와 함께 추천합니다.**

무엇을 만들고 싶은지 자연어로 쓰면 — 요구사항을 읽어내고, 그 일이 모델에게 무엇을
요구하는지(코드 작성·도구 사용·웹 조사·실패 복구…)를 뽑고, 가진 모델 중 어느 것이
그 형태의 일에 맞는지 **점수 분해와 선정 이유, 탈락 사유까지** 보여줍니다.

```
요구사항  →  읽어낸 것 (사용자의 말에서 확인 / 런타임이 보탠 것)
          →  이 일이 요구하는 능력
          →  추천 모델 + 왜 · 다음 후보 · 왜 탈락했는지
          →  아직 정해지지 않은 것 (묻고, 대신 정하지 않음)
```

설계 단계에서는 **아무것도 실행되지 않습니다.** 파일을 쓰지도, 명령을 돌리지도 않습니다.
`HASA: 하네스 설계` 명령 하나로 열립니다.

설계가 끝나면 **코딩 에이전트로 넘기기** 버튼이 요청과 추천 모델을 그대로 들고 에이전트를 엽니다.
넘어가는 것은 사용자가 쓴 문장과 모델 하나뿐입니다 — 금지사항·요구사항·의도는 넘기지 않고
에이전트가 같은 문장에서 같은 코드로 다시 읽습니다. 문장에서 파생된 결론을 복사해 두면
원문과 어긋날 수 있고, 그때 신뢰해야 하는 쪽은 언제나 원문입니다.
넘긴 뒤에도 **보내지지는 않습니다.** 아직 정해지지 않은 것이 남아 있으면 넘기기 전에 그것부터 보여줍니다.

```
HASA Coding Agent
├─ CODE       기능 구현, 수정, 리팩터링
├─ ARCHITECT  분석과 변경 계획 (코드는 건드리지 않음)
├─ DEBUG      원인 탐색과 수정
└─ ASK        코드 설명과 질문
```

사용자가 아는 것은 세 가지뿐이다 — **API Key 입력, Mode 선택, 자연어로 요청.** 모델은 `✨ Auto`가 고르고, 파일이 바뀌기 전에는 반드시 물어본다.

추천의 근거가 되는 능력치는 **Arena**가 만든다. 여러 모델에게 같은 작업을 독립적으로 시키고 객관 지표와 blind pairwise judge로 비교하는 평가 엔진으로, 디자이너가 읽는 `harness_eval` 측정치가 여기서 나온다. 제품의 앞면이 아니라 추천을 뒷받침하는 계측 장치이며, 직접 돌리고 싶으면 `HASA: Compare Models` 명령이 그대로 있다.

## 빠르게 써보기 (VS Code)

```bash
pnpm install
pnpm build:extension
```

VS Code에서 이 폴더를 열고 `F5`. 새 창에서 `Ctrl+Shift+P` → **HASA: Coding Agent 열기** → API Key 입력.

기본값은 안전한 쪽이다.

| | Safe (기본) | Balanced | Auto |
|---|---|---|---|
| 파일 읽기 | 자동 | 자동 | 자동 |
| 파일 수정 | **확인** | 자동 | 자동 |
| 명령 실행 | **확인** | **확인** | 자동 |
| 위험한 작업 | 차단 | 차단 | 차단 |

되돌리기는 언제든 가능하다 — 에이전트는 첫 수정 **전에** 작업 상태를 보관한다.

게이트웨이가 tool calling을 막아 둔 모델도 쓸 수 있다. 그런 모델에는 도구를 프롬프트로 설명하고 응답 텍스트에서 호출을 읽어낸다(Cline과 같은 방식). 에이전트 루프는 두 경로를 구분하지 못하므로, 서버 설정 문제가 기능 부재로 번지지 않는다.

## 얼마나 잘 읽는가 (분모와 함께)

비율이 아니라 분자와 분모를 적는다. `0.98`은 49/50에서도 490/500에서도 같게 읽히고 두 번째가 훨씬 강한 주장이므로, 주장의 세기를 숫자에 남긴다.

**요구사항을 얼마나 읽어내는가**

| 말뭉치 | 크기 | 성격 |
|---|---|---|
| Gold | 43개 사례 | 개발셋. 정답을 먼저 쓰고 나중에 돌렸다 |
| Holdout | 33개 사례, sha256 고정 | 구현이 한 번도 맞춰본 적 없다 |
| 평가기 시나리오 | 20개 대화 / 31턴 | 키워드 정답이 손으로 붙어 있다 |
| 생성형 미디어 (한국어) | 24문장 / 요구사항 26 | 사용자가 준 세 가지 주제 |
| 생성형 미디어 (영어) | 25문장 / 요구사항 30 | 같은 주제, 다른 언어 + 적대적 5문장 |
| 여러 턴 대화 | 13개 (한국어 8 · 영어 5) | 마지막 턴에 무엇이 살아 있는가 |

**점수**

| 무엇을 | 얼마나 | 어디서 |
|---|---|---|
| 사용자가 말한 낱말이 살아남는 비율 | **43/47** | `evalScenarioRecall.test.ts` |
| 미디어 요청을 읽는 비율 (한국어) | **23/24** · 행위 25/26 · 대상 25/26 | `mediaCases.test.ts` |
| 미디어 요청을 읽는 비율 (영어) | **25/25** · 행위 30/30 · 대상 30/30 | `mediaCasesEnglish.test.ts` |
| 모델 추천 정확도 | **14/14** | `recommendationCases.test.ts` |
| 관계 분류 (새 작업·정정·이어감) | **29/31** | 시나리오 정답 대비 |

**측정이 무력하지 않은지 확인하는 것들**

| 무엇을 | 얼마나 | 어디서 |
|---|---|---|
| 불변식 — 지어내지 않음, 근거 일치, 금지 일관성 | 117턴 / 후보 129개 | `extractInvariants.test.ts` |
| 생성된 문장에 대한 같은 불변식 | 매 실행 수천 건 | `*.fuzz.test.ts` |
| 패널이 사용자에게 말하는 것 | 10개 검사 | `designerPayload.test.ts` |
| 방어선이 실제로 지탱하는지 | 변이 **239개**, 예상 밖 무반응 0 | `pnpm design:mutate` |
| 치환 문자열이 코드와 어긋나지 않았는지 | 239/239 | `pnpm design:anchors` |
| 정규식이 자기 이스케이프를 먹지 않았는지 | 소스 전체 | `sourceHygiene.test.ts` |

아직 재지 않은 것은 재지 않았다고 말한다 — `goldRequirements.ts`의 `UNMEASURED`가 그 목록이고, 0으로 채우지 않는다.
일부러 읽지 않기로 한 것도 테스트로 고정해 둔다: `쓰다`(쓰기와 사용하기를 가릴 수 없음),
`고르다`(어떤 행위인지 정할 수 없음), `마무리`(남은 일이 무엇인지 문장이 말하지 않음),
명사를 잇는 `하고`(동사 어미와 구별되지 않음).

## 현재 상태

| Phase | 범위 | 상태 |
|---|---|---|
| -1 | 환경 부트스트랩 (Node 24, 워크스페이스) | 완료 |
| 0 | capability probe CLI | 완료 — 최근 실측 2026-08-03, 21개 모델 중 12개 응답비교·5개 coding 자격 |
| 1 | Response Compare 모드 + 오케스트레이터 | 완료 |
| 2 | Code Candidate 모드 (worktree, 게이트, apply) | 완료 |
| 3 | VS Code Extension | 완료 (타입검사·빌드 검증. UI 동작은 수동 확인 필요) |
| 4 | 판정 사다리 (S0~S4) + 개선 루프 | 완료 — [docs/redesign-plan.md](docs/redesign-plan.md) |

### HASA Coding Agent (확장 중)

Arena 위에 **일반 개발자용 Coding Agent**를 올린다. Arena는 그대로 유지되며, 어려운 작업에서만 호출되는 Harness 내부의 evaluation engine이 된다. 설계 전체는 [docs/hasa-coding-agent-architecture.md](docs/hasa-coding-agent-architecture.md).

| Phase | 범위 | 상태 |
|---|---|---|
| Z0 | 구조 분석 + 목표 아키텍처 | 완료 |
| Z1 | HASA Provider (`src/provider/`) | 완료 — 키 보관, 동적 모델 조회, 스트리밍 정규화, 에러/검증 |
| — | Z1 테스트 강화 | 완료 — 경계·속성·구조 테스트 565개. 결함 16건 + 성능 1건 발견·수정 |
| Z2 | Coding Agent Core (AgentSession / AgentLoop / Approval / Checkpoint) | 완료 — CODE·ARCHITECT·DEBUG·ASK 4개 Mode, 승인·되돌리기 동작 |
| Z3 | VS Code Chat UX (Mode, Diff, 승인) | 완료 — 확장이 `src/`를 in-process로 사용 |
| Z4~ | Harness (라우팅 → single / generate_review / best_of_n) | 예정 |

## 요구 사항

- **Node 24 이상** — 빌드 단계 없이 `.ts`를 직접 실행한다 (네이티브 타입 스트리핑)
- pnpm

## 빠른 시작

```bash
pnpm install
cp .env.example .env          # HASA_API_KEY 를 채운다 (.env 는 gitignore 대상)

pnpm probe                    # 모델 능력을 실제 요청으로 측정 → .arena/capability-matrix.json
pnpm arena models             # 어떤 모델을 어느 모드에 쓸 수 있는지 확인

pnpm arena compare \
  --models "modelA,modelB" \
  --judge  "modelC" \
  --prompt "비교할 과제"
```

코드 모드는 git 저장소 루트에서, 워킹트리가 clean한 상태로 실행한다.

```bash
pnpm arena compare --code --repo . \
  --models "modelA,modelB" --judge "modelC" \
  --prompt "src/foo.ts 의 버그를 고쳐라" \
  --test "pnpm test" --accept
```

후보는 각자의 worktree에서만 작업하고, **`Apply` 전까지 현재 workspace는 변경되지 않는다.** 결과는 `.arena/runs/<runId>/` 에 남는다.

## 설치

```bash
pnpm install
```

## 명령

```bash
pnpm probe          # capability probe (HASA_API_KEY 필요)
pnpm probe --mock   # 키·네트워크 없이 mock 게이트웨이로 실행
pnpm probe --deep   # long_context, seed 포함
pnpm probe --help

pnpm arena models   # 자격이 확인된 모델 목록
pnpm arena compare --models "a,b" --judge "c" --prompt "..."   # 한 번에 실행하고 결과 출력
pnpm arena --help

pnpm serve          # 오케스트레이터 HTTP 서버 (127.0.0.1 전용)
pnpm test           # 전체 테스트 (계약 + 경계 + 속성)
pnpm test:fuzz      # 속성 테스트만
pnpm test:extension # 실제 VS Code를 띄워 확장을 검증 (F5를 자동화한 것)
pnpm typecheck      # src + extension 타입 검사
pnpm build:extension # VS Code 확장 컴파일 → extension/out

pnpm design:anchors  # 변이 치환 문자열이 코드와 어긋나지 않았는지 (몇 초)
pnpm design:mutate   # 방어선 239개를 하나씩 지우고 테스트가 잡는지 (수십 분)
```

속성 테스트는 시드 기반이라 실패가 항상 재현됩니다. 기본 반복 횟수는 CI가 몇 초에 끝나도록 작게 잡혀 있고, 필요하면 얼마든지 늘릴 수 있습니다.

```bash
HASA_FUZZ_ITERATIONS=2000000 pnpm test:fuzz    # soak
HASA_FUZZ_SEED=24307 HASA_FUZZ_ITERATIONS=1 pnpm test:fuzz   # 보고된 실패 재현
```

실제 HASA 게이트웨이를 대상으로 한 검사는 opt-in입니다. `HASA_API_KEY`가 없으면 건너뛰므로 CI는 키를 요구하지 않습니다.

```bash
HASA_API_KEY=… node --test "src/**/*.integration.test.ts"
```

VS Code 확장은 [extension/](extension/) 에 있습니다. 신뢰 경계와 화면 구성은 [extension/README.md](extension/README.md) 참조.

## 환경 변수

`.env.example` 참조. **API Key는 소스·저장소·webview 어디에도 두지 않는다.** 셸 환경변수로만 전달한다.

```powershell
$env:HASA_API_KEY = '<key>'      # PowerShell
```

```bash
export HASA_API_KEY='<key>'      # bash
```

## API (Phase 1)

```
POST   /runs                              응답 비교 Run 생성
POST   /code-runs                         코드 후보 비교 Run 생성 (Phase 2)
GET    /runs                              목록
GET    /runs/:id                          상태 + 결과
GET    /runs/:id/events                   SSE (Last-Event-ID 재개 지원)
GET    /runs/:id/candidates               후보별 상태·응답·게이트 결과
GET    /runs/:id/candidates/:cid/diff     후보 diff (코드 모드)
GET    /runs/:id/verdicts                 judge 판정 요약
POST   /runs/:id/cancel
POST   /runs/:id/apply                    winner 적용 — 명시적 승인 전용
POST   /runs/:id/reject                   전체 기각 + worktree 정리
GET    /healthz
```

`/healthz`를 제외한 모든 요청에 `x-arena-token` 헤더가 필요하다. 토큰은 서버 기동 시 출력된다.

### 예시

```bash
curl -X POST http://127.0.0.1:7801/runs \
  -H "x-arena-token: <token>" -H "content-type: application/json" \
  -d '{
    "taskSpec": { "prompt": "REST와 gRPC의 트레이드오프를 설명하라." },
    "candidates": [{ "modelId": "<model-a>" }, { "modelId": "<model-b>" }],
    "judge": { "modelId": "<model-c>" }
  }'
```

모델 ID는 하드코딩되어 있지 않다. `pnpm probe` 결과(`.arena/capability-matrix.json`) 또는 `GET /v1/models`에서 고른다.

## 설계 문서

- [docs/architecture.md](docs/architecture.md) — 시스템 구성, 도메인 모델, 스케줄러, 런타임 추상화
- [docs/compatibility-matrix.md](docs/compatibility-matrix.md) — probe 항목, 판정 기준, 모델 자격 규칙
- [docs/security-policy.md](docs/security-policy.md) — 키 취급, 명령 allowlist, 격리, judge 제한
- [docs/evaluation-protocol.md](docs/evaluation-protocol.md) — 게이트, 점수, blind pairwise 절차
- [docs/implementation-plan.md](docs/implementation-plan.md) — Phase 계획, 위험 레지스터, 불확실 SDK API

## 판정 사다리

판정이 갈렸다고 곧바로 사람에게 넘기지 않는다. 한 번 물어보고 애매해서 넘기는 것은 유보가 아니라
조기 포기다. 갈린 쌍만 다음 계단으로 올라간다.

| 단계 | 무엇을 하는가 | 비용 |
|---|---|---|
| S0 | 객관 검사 (코드 모드는 게이트, 응답 모드는 `--require` 등) | 0회 |
| S1 | blind pairwise, 순서 뒤집어 2회 | 2회 |
| S2 | 같은 judge를 temperature>0으로 반복 — 잡음인지 진짜 애매함인지 측정 | 2k회 |
| S3 | 다른 judge 모델들의 합의 | 2m회 |
| S4 | judge에게 **확인 가능한 주장**을 받아 직접 실행 | 1회 |

사다리를 다 오르고도 갈리면 `undecidable`이고, 그때 사람에게 넘긴다 — 무엇을 시도했는지는
`ladderTrace`에 남는다. 예산이 먼저 끝나면 `budget_exhausted`로 **따로** 보고한다. 전자는 인식
문제이고 후자는 돈 문제이며, 처방이 다르다.

```bash
pnpm arena compare --models "a,b" --judge "c" --prompt "..."   --require "지연시간,처리량" \        # S0 객관 검사
  --ensemble "d,e" \                   # S3 앙상블
  --critic "f" --rounds 2               # 개선 루프
```

## 개선 루프

`--critic`을 주면 토너먼트 승자를 개선해 본다. critic이 검증 가능한 결함을 지목하고, **같은 모델**이
그것을 고쳐 다시 답한다. 이웃은 blind pairwise에서 **이겼을 때만** 챔피언을 교체한다.

그래서 최종 출력은 구조적으로 첫 라운드 최고 답보다 나쁠 수 없고, `convergedBy:
"neighbour_not_better"`가 "이웃을 만들어봤는데 졌다" — 즉 local optimum이라는 **측정된 주장**이 된다.

critic은 judge와도, 후보와도 달라야 한다. 같으면 개선이 채점자의 취향으로 수렴한다.

## 설계상 지키는 것

- 후보는 **modelId만 다르고 나머지는 전부 동일**하다. 위반하면 Run이 시작되지 않는다 (`400`).
  개선 라운드는 예외이며, 그쪽은 `assertComparable(a, b, "refinement")`이 별도로 검사한다.
- judge는 도구도 파일 접근도 없고, **모델명·후보 라벨을 보지 못한다**.
- **`no_winner`는 정상 결과다.** 억지 승자를 만들지 않는다.
- **사람 검토 요청은 시도 기록과 함께 온다.** 모든 분기에서 켜지는 플래그는 신호가 아니라 책임 전가다.
- API Key는 **VS Code SecretStorage와 그것을 읽는 프로세스 밖으로 나가지 않는다.** Coding Agent는 확장 호스트에서, Arena는 오케스트레이터 프로세스에서 키를 쥔다. 어느 쪽도 webview·로그·SSE·HTTP 응답에 키를 싣지 않으며, webview가 받는 것은 `hasApiKey: true` 뿐이다. 빌드·테스트 자식 프로세스에는 allowlist로 만든 환경변수만 전달되므로 키를 상속하지 않는다.
