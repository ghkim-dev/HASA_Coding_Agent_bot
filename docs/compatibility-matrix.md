# HASA Model Compatibility Matrix

> 상태: **명세 (미실행)**. 아래 표의 `status` 열은 전부 `unknown`이다. Phase 0의 `pnpm probe`가 실제 요청으로 채우기 전까지 어떤 값도 사실로 취급하지 않는다.

---

## 1. 왜 필요한가

`GET /v1/models`에 모델이 보이는 것과, 그 모델을 코딩 에이전트에 투입할 수 있는 것은 **완전히 다른 문제**다.

1. **권한**: 모델 목록은 공개되지만 키별 권한에 따라 `403 Model access denied`가 난다.
2. **tool calling**: HASA 문서에 OpenAI 호환 tool calling 지원이 **명시되어 있지 않다.** 목록에 있다는 이유로 `tools`/`tool_choice`를 보내면 무시되거나 오류가 난다.
3. **런타임 요구**: Zoo Code는 [native tool calling 전용이며 XML fallback이 없다](https://docs.zoocode.dev/providers/openai-compatible). Cline 계열도 도구 기반 에이전트 루프가 전제다. tool calling이 안 되는 모델은 **에이전트 런타임에 넣는 순간 조용히 실패**한다.
4. **공정성**: 후보 간 `maxOutputTokens`·context window가 다르면 비교가 무의미하다. 실제 상한을 측정해 **가장 낮은 값에 맞춰야** 한다.

따라서 규칙은 하나다.

> **probe로 `pass`가 확인되지 않은 capability는 존재하지 않는 것으로 취급한다.**

---

## 2. HASA API — 문서로 확인된 것 vs 미확인

[open.hasa.re.kr/docs](https://open.hasa.re.kr/docs) 기준 (2026-07-29 확인).

### 2.1 확인된 사항

| 항목 | 내용 |
|---|---|
| Base URL | `https://open.hasa.re.kr/v1` |
| 인증 | `Authorization: Bearer <API_KEY>` (모든 추론 요청). 모델 목록은 공개 |
| 엔드포인트 | `GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/embeddings`, `POST /rerank`, `POST /v1/agent/chat` |
| 스트리밍 | `stream: true` → SSE |
| Vision | vision 모델은 content에 `image_url` 포함 가능 |
| Rate limit | 구체 수치 미공개. `Retry-After` 헤더 언급됨 |

`POST /rerank`가 `/v1` 접두사 없이 문서화된 점에 주의 (경로 하드코딩 시 오류 유발).

### 2.2 오류 코드와 처리 방침

| 코드 | 의미 | 재시도 | Arena 처리 |
|---|---|---|---|
| `401` | API Key 누락/무효 | ✗ | **전체 중단.** 설정 오류이므로 Run 자체를 실패 처리 |
| `403` | **두 가지 의미** — body의 `violation_code`로 구분 (§2.2.1) | ✗ | `invalid_api_key`면 전체 중단, 아니면 해당 모델을 `denied`로 기록하고 후보에서 **영구 제외** (재프로빙 전까지) |
| `404` | 미등록 모델 | ✗ | 레지스트리 무효화 → `/v1/models` 재조회 |
| `429` | rate limit 초과 | ✓ | **`Retry-After` 준수** 후 재시도. 해당 모델 큐 일시 정지 |
| `503` | GPU 백엔드 사용 불가 | ✓ | backoff 재시도. N회 초과 시 후보 `failed` |
| 기타 5xx | 서버 오류 | ✓ (제한적) | 최대 2회 |

#### 2.2.1 `403`은 무효 키에도 쓰인다 (2026-08-01 실측)

**§2.1의 "401 = API Key 누락/무효"는 불완전하다.** 실제 게이트웨이는 무효·만료 키에 `403`을 반환한다.

```json
403 {"error":"security_policy_blocked",
     "message":"[경고 1/10] 유효하지 않거나 만료된 API Key를 사용했습니다.
                10회 초과부터 차단 시간이 1→2→4→16→32분 으로 늘어납니다.",
     "violation_code":"invalid_api_key", "strike_count":1, "offense_count":1}
```

| `violation_code` | 의미 | 처리 |
|---|---|---|
| `invalid_api_key` | 키 자체가 무효·만료 | **전체 중단.** 모델을 바꿔도 소용없다 |
| 그 외 / 없음 | 키는 유효, 이 모델 권한 없음 | 해당 모델만 `denied` |

**strike 제도가 있다.** 무효 키로 10회 초과 시 1→2→4→16→32분 차단. 따라서 무효 키 판정 후 다른 모델로 재시도하면 안 된다 — 얻는 정보 없이 차단만 앞당긴다.

### 2.3 미확인 항목 — Phase 0 실행으로 해소된 것과 남은 것

| 항목 | 결과 |
|---|---|
| **native tool calling** | **지원됨** — `exaone-4.0-32b`, `gpt-oss-20b`에서 확인. 단 모델별·배포별로 갈린다 (§8.3) |
| 복수 tool call | exaone `pass`, gpt-oss-20b `fail`(1개만 반환) |
| `response_format: json_object` | 접근 가능한 chat 모델 전부 `pass` |
| `response_format: json_schema` | exaone만 `pass`. 나머지는 스키마를 지키지 않음 → judge는 `json_object` 경로를 쓴다 |
| 실제 `max_tokens` 상한 | 3개 모델 모두 **32768 수용** |
| `reasoning_content` 필드 | **전 모델 미반환.** `gpt-oss-20b`는 가시 출력 전에 토큰을 소비하지만 별도 채널로 노출하지는 않는다 |
| SSE 형식 | `data: [DONE]` 사용. 스트리밍 tool_calls는 OpenAI index 규약과 동일하게 조립됨 (`tools_stream: pass`) |
| 오류 코드 | `403`은 본문에 `allowed_models`를 포함. `503`에는 **`Retry-After` 헤더가 없어** backoff로 대응해야 함 (실측 확인) |
| 병렬 tool call (`parallel_tool_calls`) | 미검증 — 별도 옵션으로 시도하지 않았다 |
| `seed` 재현성 | 미검증 — `--deep` 미실행 |
| 실제 context window | 미검증 — `--deep` 미실행 |
| 동시 요청 허용 개수 | 미검증. 현재 `concurrency 3`에서 `503`이 관측되었으므로 보수적으로 시작한다 |

---

## 3. Probe 항목 정의

각 항목은 **독립적으로 실행 가능한 하나의 실제 HTTP 요청**(또는 요청 묶음)이며, 결과는 4가지 중 하나다.

- `pass` — 기대한 동작을 확인
- `fail` — 요청은 도달했으나 기능이 동작하지 않음
- `denied` — `403` (권한 문제. 기능 유무와 구분한다)
- `unknown` — 네트워크 오류·타임아웃 등으로 판정 불가 (재시도 대상)

| # | capability | 요청 요약 | `pass` 판정 기준 |
|---|---|---|---|
| P1 | `listed` | `GET /v1/models` | 응답 목록에 해당 `id` 존재 |
| P2 | `chat` | `messages:[{user:"Reply with exactly: OK"}]`, `max_tokens: 16` | HTTP 200 + `choices[0].message.content` 비어있지 않음 |
| P3 | `stream` | 위 + `stream: true` | SSE 청크 1개 이상 수신 + 재조립된 content가 비어있지 않음 (청크 수는 evidence에 기록). 게이트웨이가 응답 전체를 단일 청크로 보내는 경우가 실재하므로 청크 수로 판정하지 않는다 |
| P4 | `tools` | 단일 함수(`get_weather`) 정의 + 그 함수를 부를 수밖에 없는 프롬프트 | `finish_reason == "tool_calls"` **그리고** `tool_calls[0].function.name == "get_weather"` **그리고** `arguments`가 유효 JSON |
| P5 | `tools_multi` | 두 도시 날씨 동시 질의 | 한 응답에 `tool_calls.length >= 2` |
| P6 | `tools_roundtrip` | P4 결과에 `role:"tool"` 메시지로 응답 후 재호출 | 도구 결과를 반영한 최종 텍스트 반환 |
| P7 | `tools_stream` | P4 + `stream: true` | 스트림에서 tool_calls delta 조립 성공 |
| P8 | `json_object` | `response_format:{type:"json_object"}` | 응답 전문이 유효 JSON |
| P9 | `json_schema` | `response_format:{type:"json_schema", …}` | 스키마 준수 JSON |
| P10 | `vision` | 작은 base64 이미지 + "무슨 색인가" | 색상을 정확히 응답 |
| P11 | `long_context` | 8k / 32k / 128k 토큰 근사 입력에 needle 삽입 | needle 회수 성공한 최대 단계 기록 |
| P12 | `max_output` | `max_tokens`를 2배씩 올려 이분 탐색 | 400 없이 수용된 최대값 |
| P13 | `reasoning_content` | 추론 유도 프롬프트 | 응답에 `reasoning_content` 필드 존재 여부 (`pass`/`fail` 아닌 **정보성**) |
| P14 | `seed` | 동일 `seed`·`temperature:0`로 2회 호출 | 두 응답이 완전히 동일 |
| P15 | `latency` | P2를 3회 | p50/p95 기록 (정보성) |
| P16 | `error_handling` | 잘못된 모델 ID / 무효 키 / 과도 요청 | `404`/`401`/`429` 및 `Retry-After` 헤더 형식 확인 |

> P11·P12는 토큰과 시간을 크게 소모한다. `--deep` 플래그로만 실행하고 기본 probe에서는 제외한다.

---

## 4. Capability Matrix 산출물 스키마

`.arena/capability-matrix.json` (그리고 `capability_matrix` 테이블에 동기화).

```jsonc
{
  "schemaVersion": 1,
  "probedAt": "2026-07-29T12:00:00Z",
  "baseUrl": "https://open.hasa.re.kr/v1",
  "keyFingerprint": "sha256:9f2c…",   // 키 자체가 아니라 지문. 어느 키로 프로빙했는지 추적용
  "probeVersion": "probe-v1",
  "models": [
    {
      "modelId": "…",
      "capabilities": {
        "chat":            { "status": "pass", "evidence": "200, 4 tokens", "durationMs": 812 },
        "stream":          { "status": "pass", "evidence": "17 chunks" },
        "tools":           { "status": "fail", "evidence": "finish_reason=stop, no tool_calls" },
        "tools_multi":     { "status": "unknown", "evidence": "skipped: tools failed" },
        "json_object":     { "status": "pass" },
        "vision":          { "status": "denied", "evidence": "403" }
      },
      "limits": {
        "observedContextWindow": 32768,
        "observedMaxOutputTokens": 8192,
        "latencyMs": { "p50": 780, "p95": 1420 }
      },
      "eligibility": {
        "responseCompare": true,
        "codingAgent": false,
        "patchMode": true,
        "judge": true,
        "reasons": ["tools=fail → codingAgent 제외"]
      }
    }
  ]
}
```

**마스킹 규칙**: 이 파일에는 API Key, 전체 프롬프트, 전체 응답 본문을 저장하지 않는다. `evidence`는 판정 근거를 나타내는 짧은 요약 문자열이며 200자로 절단한다 (`security-policy.md` §4).

---

## 5. 모델 자격 규칙 (Eligibility)

matrix로부터 **결정적으로 계산**된다. 사람이 손으로 수정하지 않는다.

```
responseCompare = chat.pass
                  AND NOT denied

codingAgent     = chat.pass
                  AND stream.pass
                  AND tools.pass
                  AND tools_roundtrip.pass          // 도구 결과를 실제로 소비할 수 있어야 함
                  AND observedMaxOutputTokens >= 4096

patchMode       = chat.pass
                  AND observedMaxOutputTokens >= 4096
                  AND NOT codingAgent               // codingAgent 가능하면 그쪽 우선

judge           = chat.pass
                  AND (json_object.pass OR json_schema.pass)   // 없으면 파싱 재시도 정책으로 강등 허용
                  AND NOT (해당 Run의 후보 모델 중 하나)         // 자기 심사 금지
```

### 5.1 자동 제외 동작

- `codingAgent = false`인 모델을 코드 모드 후보로 지정하면 Run 생성 시점에 **`400`으로 거부**한다. 실행 중 조용히 빠지는 것이 아니라 사전에 거부한다.
- 실행 중 `403`이 발생하면 해당 후보를 `excluded_reason = "403"`으로 마감하고, **남은 후보가 2개 미만이면 Run 전체를 `no_winner`로 종료**한다. 후보 1개짜리 비교는 비교가 아니다.
- matrix가 없거나 `probeVersion`이 현재 코드보다 낮으면 Run 생성을 거부하고 재프로빙을 요구한다.

### 5.2 공정성 정렬 (fairness normalization)

Run 생성 시 후보 전체에 대해:

```
maxOutputTokens = min(모든 후보의 observedMaxOutputTokens, 사용자 지정값)
contextBudget   = min(모든 후보의 observedContextWindow) * 0.8   // 안전 마진
```

한 후보만 더 긴 출력을 낼 수 있으면 그 자체가 유리 편향이므로, **가장 제약이 큰 후보에 맞춘다.** 이 값들이 `Candidate.spec`에 기록되어 재현 가능해진다.

---

## 6. 재프로빙 정책

| 트리거 | 동작 |
|---|---|
| `.arena/capability-matrix.json` 부재 | 전체 probe 필수 |
| `probedAt`이 7일 초과 | 경고. `--stale-ok`로만 진행 허용 |
| `keyFingerprint` 불일치 (키 교체) | 권한이 달라졌을 수 있음 → 전체 재프로빙 필수 |
| `GET /v1/models` 결과에 신규 모델 등장 | 해당 모델만 부분 probe |
| 실행 중 `403`/`404` 발생 | 해당 모델만 즉시 재프로빙 후 자격 갱신 |
| `probeVersion` 변경 (probe 로직 수정) | 전체 재프로빙 |

---

## 7. 실행 방법 (Phase 0 구현 예정)

```bash
pnpm probe                       # 전체 모델, 기본 항목 (P1-P10, P13-P16)
pnpm probe --models a,b          # 특정 모델만
pnpm probe --deep                # P11(long context), P12(max output) 포함
pnpm probe --json out.json       # 산출 경로 지정
pnpm probe --mock                # mock 서버 대상 (CI에서 사용, 실제 HASA 불필요)
```

전제:
- `HASA_API_KEY` 환경변수 (소스·설정 파일에 저장 금지)
- `HASA_BASE_URL` 미설정 시 `https://open.hasa.re.kr/v1`

출력: 콘솔 요약 표 + `.arena/capability-matrix.json` + 실패 모델별 원인 목록.

---

## 8. 실측 매트릭스 (2026-07-29 실행)

`pnpm probe --concurrency 3` — `GET /v1/models`가 반환한 **19개 전체**를 프로빙했다.

### 8.1 접근 가능한 모델

| modelId | chat | stream | tools | tools_multi | tools_roundtrip | tools_stream | json_object | json_schema | maxOutput | 자격 |
|---|---|---|---|---|---|---|---|---|---|---|
| `exaone-4.0-32b` | pass | pass | **pass** | pass | pass | pass | pass | pass | 32768 | response, **coding**, judge |
| `gpt-oss-20b` | pass | pass | **pass** | fail | pass | pass | pass | fail | 32768 | response, **coding**, judge |
| `qwen2.5-coder-32b` | pass | pass | fail¹ | skipped | skipped | skipped | pass | fail | 32768 | response, patch, judge |
| `granite-guardian-3.1-8b` | pass | unknown² | unknown² | skipped | skipped | skipped | unknown² | unknown² | null | response |

¹ 모델 무능력이 아니라 **게이트웨이 설정 문제**. §8.3 참조.
² 프로빙 중 `503 GPU backend unavailable`이 반복되어 판정 불가. `unknown`은 `fail`과 구분된다 — 일시적 장애를 능력 부재로 기록하면 안 되기 때문이다. 재프로빙 대상.

관측 지연시간: exaone p50 231ms, gpt-oss-20b p50 234ms, qwen2.5-coder p50 270ms (trivial completion 기준).

### 8.2 접근 불가 모델 (15개)

| 원인 | 개수 | 모델 |
|---|---|---|
| `403 model_not_on_key` | 13 | `qwen3-coder`, `llama-3.3-70b`, `kanana-2-30b-a3b`, `hyperclovax-seed-32b`, `midm-2.0-base`, `solar-pro`, `gpt-oss-120b`, `qwen2.5-vl-72b`, `whisper-large-v3`, `Qwen-Image`, `Wan2.1-T2V`, `Wan2.2-T2V`, `LTX-2` |
| `404 Not Found` on `/chat/completions` | 2 | `bge-m3`, `bge-reranker-v2-m3` (임베딩·리랭커 모델이므로 정상) |

403 응답 본문이 `allowed_models`를 담고 있어 이 키의 실제 권한 범위를 확인할 수 있었다:

```
bge-m3, bge-reranker-v2-m3, exaone-4.0-32b,
gpt-oss-20b, granite-guardian-3.1-8b, qwen2.5-coder-32b
```

> **§1의 전제가 실측으로 확인됐다.** `/v1/models`는 19개를 반환하지만 이 키로 실제 추론 가능한 것은 6개, 그중 chat 모델은 4개다. 목록 기반으로 후보를 구성했다면 Run의 대부분이 403으로 죽었을 것이다.

### 8.3 운영자 조치 필요 — 게이트웨이가 tool calling을 차단

`qwen2.5-coder-32b`와 `granite-guardian-3.1-8b`는 **모든** `tool_choice` 변형을 거부한다:

| tool_choice | 응답 |
|---|---|
| `auto` | `400 "auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set` |
| `required` | `400 tool_choice="required" requires --tool-call-parser to be set` |
| named function | `400 ... requires --tool-call-parser to be set` |
| 생략 | `400` (auto와 동일) |

vLLM이 해당 플래그 없이 기동된 상태다. **모델 자체는 tool calling이 가능하다** — 특히 `qwen2.5-coder-32b`는 코딩 에이전트용으로 설계된 모델이다. 이를 일반 capability 실패로 기록하면 플래그 하나로 해결될 모델을 영구히 잘못 분류하게 되므로, probe는 이 경우를 `errorCode: "server_tool_calling_disabled"`로 구분하고 CLI가 `OPERATOR ACTION` 섹션으로 따로 출력한다.

### 8.4 Phase 2 런타임 결정

> **tool calling이 확인된 모델이 2개(`exaone-4.0-32b`, `gpt-oss-20b`)이므로, Phase 2의 기본 런타임은 에이전트 루프(ClineCore 어댑터)로 간다.** `patch-mode`는 fallback으로 유지한다 — §8.3이 해결되면 `qwen2.5-coder-32b`가 세 번째 후보로 합류하고, 해결되지 않으면 patch-mode 리그의 주 후보가 된다.

`implementation-plan.md` §3의 분기점 조건("tools=pass 모델이 2개 이상")을 충족한다.

### 8.5 probe 자체에서 발견·수정한 결함

실제 API에 붙이고 나서야 드러난 것들이다. 셋 다 **정상 모델을 부당하게 탈락시키는** 방향의 오류였다.

| 증상 | 실제 원인 | 수정 |
|---|---|---|
| `gpt-oss-20b` → `chat: fail (200 but empty content)` | `max_tokens: 16`으로 잘림. 가시 출력 전에 토큰을 소비하는 모델이며 41 토큰이 필요했다 (`finish_reason: length`) | budget ladder 256 → 1024. `length`로 잘렸을 때만 상향 재시도 |
| `qwen2.5-coder-32b` → `tools: fail` | 게이트웨이 설정 (§8.3) | tool_choice ladder + 전용 errorCode |
| `gpt-oss-20b` → `tools_roundtrip: fail` | 모델이 `–17.5`(en-dash)로 답했는데 `"-17.5"`(ASCII 하이픈)로 문자열 비교 | 유니코드 대시·마크다운·NBSP 정규화 후 비교 |

마지막 항목이 가장 위험했다. 실제 응답은 두 모델 모두 도구 결과를 정확히 반영하고 있었다:

```
gpt-oss-20b    → "The current temperature in Seoul is **–17.5 °C**."
exaone-4.0-32b → "The current temperature in Seoul is -17.5°C."
```

타이포그래피 차이만으로 한쪽을 탈락시키는 판정이 Phase 2의 승자 결정에 쓰이면 조용히 틀린 결론을 낸다. 각 결함에 회귀 테스트를 붙였다 (mock 프로필: `minTokensForContent`, `toolsServerDisabled`, `toolsRejectAuto`, `typographicOutput`).

부수적으로, round-trip의 두 번째 호출에서 불필요한 `tools` 재전송을 제거했다 — tool 결과를 읽고 답하기만 하면 되는데, `tools`를 다시 보내면 §8.3 같은 게이트웨이에서 400이 난다.

---

## 9. 실측 매트릭스 (2026-08-03 실행, 다른 키)

§8과 **다른 키**로 다시 측정했다. 카탈로그가 19개에서 21개로 늘었고, 무엇보다 §8에서 13개를 403으로 막던 권한 제약이 거의 사라져 이 키는 12개 모델에 실제로 추론할 수 있다. 같은 게이트웨이라도 키가 바뀌면 결론이 바뀐다는 §1의 전제를 두 번째로 확인한 셈이다.

`pnpm probe` — `GET /v1/models`가 반환한 21개 전체.

### 9.1 자격이 확인된 모델 (12개)

| modelId | chat | stream | tools | tools_roundtrip | json_object | 자격 |
|---|---|---|---|---|---|---|
| `qwen3-coder` | pass | pass | **pass** | pass | pass | response, **coding**, judge |
| `llama-3.3-70b` | pass | pass | **pass** | pass | pass | response, **coding**, judge |
| `exaone-4.0-32b` | pass | pass | **pass** | pass | pass | response, **coding**, judge |
| `gpt-oss-20b` | pass | pass | **pass** | pass | pass | response, **coding**, judge |
| `gpt-oss-120b` | pass | pass | **pass** | pass | pass | response, **coding**, judge |
| `kanana-2-30b-a3b` | pass | pass | fail¹ | skipped | pass | response, patch, judge |
| `hyperclovax-seed-32b` | pass | pass | fail¹ | skipped | pass | response, patch, judge |
| `midm-2.0-base` | pass | pass | fail¹ | skipped | pass | response, patch, judge |
| `qwen2.5-coder-32b` | pass | pass | fail¹ | skipped | pass | response, patch, judge |
| `qwen2.5-vl-72b` | pass | pass | fail¹ | skipped | pass | response, patch, judge |
| `granite-guardian-3.1-8b` | pass | pass | fail¹ | skipped | pass | response, patch, judge |
| `solar-pro` | pass | pass | fail¹ | skipped | pass | response, judge |

¹ §8.3과 같은 게이트웨이 설정 문제이며, 이번에는 **7개 모델**에서 관측됐다. 플래그가 켜지면 coding 자격 모델이 5개에서 12개로 늘어난다. 모델 능력의 문제가 아니다.

`granite-guardian-3.1-8b`는 §8에서 503으로 판정 불가(`unknown`)였으나 이번에는 전 항목이 측정됐다. `unknown`을 `fail`로 기록하지 않은 §6 규칙이 실제로 값을 한 셈이다.

### 9.2 chat 불가 (9개) — 대부분 정상

| 원인 | 모델 | 판단 |
|---|---|---|
| `404` on `/chat/completions` | `whisper-large-v3`, `bge-m3`, `bge-reranker-v2-m3` | 정상 — 음성·임베딩·리랭커 |
| `404` on `/chat/completions` | `Qwen-Image`, `Wan2.1-T2V`, `Wan2.2-T2V`, `LTX-2` | 정상 — 전용 생성 엔드포인트를 쓴다 (§10) |
| `403 model_not_on_key` | `wan2.2-i2v`, `tts-ko` | 이 키에 권한 없음 |

### 9.3 카탈로그가 같은 모델을 두 번 반환한다

`GET /v1/models`가 **22개 레코드로 21개 모델**을 반환했다. `wan2.2-i2v`가 두 번 실려 있다.

`HasaModelRegistry`는 이를 제거하고 있었으나 **아무 기록도 남기지 않았고**, probe CLI는 제거조차 하지 않았다. 그 결과 클라이언트 로그는 22, 피커는 21을 말했고 요약은 `12/22 usable`로 출력됐다 — 분모가 틀렸다. 양쪽 모두 중복을 제거하되 **무엇을 제거했는지 경고로 남기도록** 고쳤다. 중복 카탈로그를 고칠 수 있는 것은 운영자뿐이고, 아무도 말해주지 않으면 고칠 수 없다.

> **운영자 조치:** `/v1/models` 응답에서 `wan2.2-i2v` 중복 항목을 제거할 것.

---

## 10. 이미지·동영상 생성 (2026-08-03 실측)

생성 모델은 `/v1/chat/completions`가 아니라 전용 엔드포인트를 쓰므로 §9의 `chat: 404`는 실패가 아니다. 실제로 동작하는지는 따로 확인해야 하고, 확인했다.

| 모델 | modality | 결과 |
|---|---|---|
| `Qwen-Image` | image | **OK** — 512x512, 271KB PNG, 4초 |
| `LTX-2` | video | **OK** — mp4, `LOADING → GENERATING → COMPLETED` |
| `Wan2.1-T2V` | video | **처음엔 422**, 수정 후 OK |
| `Wan2.2-T2V` | video | **처음엔 422**, 수정 후 OK |
| `wan2.2-i2v` | video | 카탈로그가 `unavailable`, 키에도 권한 없음 |

### 10.1 `framesFor`가 정렬 단위를 최소값으로 착각하고 있었다

짧은 클립 요청에서 Wan 계열만 실패했다:

```
422 {"detail":[{"type":"greater_than_equal","loc":["body","length"],
     "msg":"Input should be greater than or equal to 5","input":4,"ctx":{"ge":5}}]}
```

`framesFor`의 하한이 `spec.frameAlign`이었다. `LTX-2`는 `frame_align: 8`이라 8을 만들어 우연히 통과했고, Wan 계열은 `frame_align: 4`라 4를 만들어 거부됐다. **모델 문제로 보였지만 산술 문제였다.**

`length`의 최소값 5는 `video_spec` 어디에도 없다. 카탈로그는 `fps`, `frame_align`, `max_frames`를 싣지만 하한은 싣지 않는다. 직접 측정해 확정했다 (`Wan2.1-T2V`):

| `length` | 응답 |
|---|---|
| 4 | `422 greater_than_equal, ge: 5` |
| 5 | `200` |
| 6 | `200` |
| 8 | `200` |

**정렬은 서버가 강제하지 않는다** — `frame_align: 4`인 모델이 5와 6을 받아들였다. 즉 둘은 성격이 다르다: 정렬은 카탈로그가 publish한 *선호*, 최소값은 위반하면 GPU를 만지기도 전에 422가 나는 *규칙*. `MIN_VIDEO_FRAMES = 5`를 두고, 충돌 시 최소값을 정렬 단위로 올림해 양쪽을 모두 지키게 했다.
