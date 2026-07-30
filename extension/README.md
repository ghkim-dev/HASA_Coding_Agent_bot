# HASA Agent Arena — VS Code Extension

같은 과제를 여러 HASA 모델에게 독립적으로 시키고, 격리된 git worktree에서 결과를 비교한 뒤, **검토를 마친 뒤에만** 승자를 적용하는 패널.

## 신뢰 경계

```
SecretStorage ──(키)──► Extension Host ──(env)──► Orchestrator 프로세스
                              │                        │
                              │                   HASA API 호출
                              │
                    상태·결과만 postMessage
                              ▼
                          Webview
```

- **API Key는 webview로 전달되지 않습니다.** VS Code `SecretStorage`에 저장되고, 오케스트레이터 자식 프로세스를 띄울 때 환경변수로만 넘어갑니다.
- **오케스트레이터 토큰도 webview로 전달되지 않습니다.** SSE 스트림은 확장 호스트가 소비하고, 패널에는 상태 스냅샷만 `postMessage`로 중계합니다.
- webview의 CSP는 `connect-src 'none'`입니다. 패널 스크립트는 애초에 네트워크에 접근할 수 없습니다.
- 오케스트레이터는 `127.0.0.1`에만 바인딩되고 포트는 매 기동마다 새로 할당됩니다.

자세한 정책은 [../docs/security-policy.md](../docs/security-policy.md) §1.3, §4.3 참조.

## 명령

| 명령 | 설명 |
|---|---|
| `HASA: Compare Models` | 비교 패널 열기 |
| `HASA: Set API Key` | 키 저장 (SecretStorage) |
| `HASA: Clear Stored API Key` | 키 삭제 + 실행 중인 오케스트레이터 종료 |
| `HASA: Show Orchestrator Log` | 출력 채널 열기 |

## 설정

| 키 | 기본값 | 설명 |
|---|---|---|
| `hasaArena.orchestratorPath` | `""` | 아레나 체크아웃 경로. 비우면 확장 설치 위치 기준 |
| `hasaArena.orchestratorUrl` | `""` | 이미 실행 중인 오케스트레이터에 연결 |
| `hasaArena.defaultCandidateCount` | `2` | 새 비교의 기본 후보 수 |
| `hasaArena.requestTimeoutSeconds` | `30` | HTTP 요청 타임아웃 |

## 화면

1. **비교 설정** — 모드(코드/응답), 런타임(agent/patch), 후보 모델 다중 선택, judge 모델, 과제 프롬프트, acceptance 명령, 쓰기 허용 경로
2. **진행 상황** — 후보별 상태 배지, 점수, 소요 시간, diff 규모, tool 호출 수, 재시도 횟수
3. **게이트 결과** — 빌드·테스트·타입검사·정적분석 결과 표 (flaky 표시 포함)
4. **판정 결과** — winner / no_winner, 근거 유형, blind pairwise 판정 내역(AB/BA 양쪽)
5. **적용** — `Apply winner` / `Reject all`

모델 피커는 **자격 없는 모델도 이유와 함께 표시**합니다. 게이트웨이 설정 때문에 tool calling이 막힌 모델은 "모델 문제 아님"이라고 명시합니다 — 목록에서 지워버리면 사용자가 원인을 알 방법이 없습니다.

## 상태 표시

`401` / `403` / `429` / `503` / 취소 / 사전조건 실패는 각각 다른 안내와 실행 가능한 조치를 함께 보여줍니다. 예를 들어 `403`은 모델 새로고침 버튼을, `401`은 키 재설정 버튼을 제공합니다.

## Apply 안전장치

- 서버가 `expectedBaseCommit`을 요구하므로, 실행 시작 이후 workspace HEAD가 움직였으면 적용이 거부됩니다
- 적용 직전 `git stash`로 이전 상태를 보존하고 되돌리기용 ref를 알려줍니다
- 게이트를 통과하지 못한 후보는 적용할 수 없습니다
- 모달 확인 단계에서 **diff 먼저 보기**를 고를 수 있습니다

## 개발

```bash
pnpm install
pnpm build:extension     # extension/out 으로 컴파일
```

**저장소 루트**(`HAFA_Extension`)를 VS Code로 열고 F5를 누르면 됩니다. `.vscode/launch.json`의 `Run HASA Arena Extension` 구성이 자동 선택되고, `preLaunchTask`가 확장을 먼저 빌드합니다.

- `extension` 폴더를 직접 열면 안 됩니다 — 빌드 스크립트와 `tsconfig`가 루트 기준입니다
- F5에서 "Select debugger" 목록이 뜬다면 루트가 아닌 폴더를 열었거나 `.vscode/launch.json`이 없는 경우입니다
- 디버그 사이드바 상단 드롭다운에서 구성을 직접 고를 수도 있습니다

> **검증 상태:** 확장 코드는 타입 검사와 컴파일로 검증되었습니다. VS Code UI 동작(패널 렌더링, 명령 등록, SecretStorage 연동)은 Extension Development Host에서의 수동 확인이 필요합니다 — 자동화 테스트 범위 밖입니다.
