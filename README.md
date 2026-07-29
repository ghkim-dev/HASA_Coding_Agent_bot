# HASA Agent Arena

여러 HASA 모델에게 **같은 작업을 독립적으로** 시키고, 객관 지표와 blind pairwise judge로 비교한 뒤, **사용자가 승인한 경우에만** 결과를 적용하는 시스템.

핵심은 "모델 여러 개를 연결하는 기능"이 아니라 **공정한 후보 생성과 검증 가능한 평가**다.

## 현재 상태

| Phase | 범위 | 상태 |
|---|---|---|
| -1 | 환경 부트스트랩 (Node 24, 워크스페이스) | 완료 |
| 0 | capability probe CLI | 완료 — 실제 HASA 19개 모델 측정 완료 |
| 1 | Response Compare 모드 + 오케스트레이터 | 완료 |
| 2 | Code Candidate 모드 (worktree, 게이트, apply) | 완료 |
| 3 | VS Code Extension | 완료 (타입검사·빌드 검증. UI 동작은 수동 확인 필요) |

## 요구 사항

- **Node 24 이상** — 빌드 단계 없이 `.ts`를 직접 실행한다 (네이티브 타입 스트리핑)
- pnpm

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

pnpm serve          # 오케스트레이터 HTTP 서버 (127.0.0.1 전용)
pnpm test           # 전체 테스트
pnpm typecheck      # src + extension 타입 검사
pnpm build:extension # VS Code 확장 컴파일 → extension/out
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

## 설계상 지키는 것

- 후보는 **modelId만 다르고 나머지는 전부 동일**하다. 위반하면 Run이 시작되지 않는다 (`400`).
- judge는 도구도 파일 접근도 없고, **모델명·후보 라벨을 보지 못한다**. 같은 쌍을 순서만 바꿔 2회 평가하고, 결과가 갈리면 `no_winner`다.
- **`no_winner`는 정상 결과다.** 억지 승자를 만들지 않는다.
- API Key는 오케스트레이터 프로세스 밖으로 나가지 않는다. 로그·SSE·HTTP 응답 어디에도 실리지 않는다.
