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

키도 VS Code도 없이 30초 만에 확인하려면 [docs/verify-it-yourself.md](docs/verify-it-yourself.md) —
요청 한 줄을 넣고 무엇을 읽어냈는지 보는 것부터, 여기 적힌 주장을 직접 다시 재는 것까지.

모델을 바꾸지 않고 추론 성능을 올리는 방향은 [docs/inference-performance.md](docs/inference-performance.md).
근거를 좌표 대신 인용으로도 받게 하자 좌표 정확도가 **12/64 → 36/64** 로 올랐다(한 게이트웨이의
모델 4개 · 사례 10개 · 실행 1회). 같은 실험을 세 번 돌렸고 실행마다 값이 다르므로, 그 문서는
실행을 번호로 구분해 적는다.

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
| Gold | 45개 사례 | 개발셋. 정답을 먼저 쓰고 나중에 돌렸다 (마지막 두 개만 예외 — 이력에 적어 두었다) |
| Holdout | 33개 사례, sha256 고정 | 정답을 먼저 쓰고 나중에 돌렸다. 이후 답 7건이 수정됐고 그중 1건은 렌더링 변경에 맞춘 것 — 이력이 파일 머리에 있다 |
| 평가기 시나리오 | 20개 대화 / 31턴 | 키워드 정답이 손으로 붙어 있다 |
| 생성형 미디어 (한국어) | 31문장 / 요구사항 33 | 세 가지 주제 + 적대적 7문장 |
| 생성형 미디어 (영어) | 25문장 / 요구사항 30 | 같은 주제, 다른 언어 + 적대적 5문장 |
| 여러 턴 대화 | 13개 (한국어 8 · 영어 5) | 마지막 턴에 무엇이 살아 있는가 |
| IT·디지털 전환 컨설팅 | 25문장 / 요구사항 33 | 세 번째 영역. 처음 물어본 모양 |
| 산업군별 고객 요청 | 24문장 / 요구사항 38 · 12개 산업군 | 제조·금융·의료·유통·물류·공공·교육·에너지·통신·보험·건설·미디어 |

**점수**

숫자를 읽는 법을 먼저 적는다. 아래는 전부 **요구사항을 읽어내는 정확도**이지 업무 성공률이
아니다. 하네스가 요청을 옳게 읽었다는 것과 그 하네스로 돌린 결과가 고객 기준을 통과한다는
것은 다른 주장이고, 두 번째는 아직 재지 않았다 — 고객 자료로 한 업무를 끝까지 돌려 본 적이
없기 때문이다. 산업군 말뭉치의 "설계가 만들어졌다" 류 검사도 `understood` 가 참인지를 볼
뿐, 문장의 모든 조건을 옳게 이해했다는 뜻은 아니다. 그 판단은 행위·대상·금지 세 축의 대조가
한다.

| 무엇을 | 얼마나 | 어디서 |
|---|---|---|
| 사용자가 말한 낱말이 살아남는 비율 | **43/47** | `evalScenarioRecall.test.ts` |
| 미디어 요청을 읽는 비율 (한국어) | **30/31** · 행위 32/33 · 대상 32/33 | `mediaCases.test.ts` |
| 미디어 요청을 읽는 비율 (영어) | **25/25** · 행위 30/30 · 대상 30/30 | `mediaCasesEnglish.test.ts` |
| 컨설팅 요청을 읽는 비율 | **25/25** · 행위 33/33 · 대상 30/33 | `consultingCases.test.ts` |
| 산업군 요청 — 금지를 읽어냄 | **7/7** (명시적 금지가 있는 사례) | `industryCases.test.ts` |
| 산업군 요청 — 금지를 지어내지 않음 | **17/17** (금지가 없는 것이 정답인 사례) | `industryCases.test.ts` |
| 산업군 요청 — 행위 / 대상 | 33/38 · **17/38** | `industryCases.test.ts` |
| 모델 추천 정확도 | **20/20** | `recommendationCases.test.ts` |
| 관계 분류 (새 작업·정정·이어감) | **29/31** | `evalScenarioRecall.test.ts` — 오프라인 |

**측정이 무력하지 않은지 확인하는 것들**

| 무엇을 | 얼마나 | 어디서 |
|---|---|---|
| 불변식 — 지어내지 않음, 근거 일치, 금지 일관성 | 117턴 / 후보 129개 | `extractInvariants.test.ts` |
| 생성된 문장에 대한 같은 불변식 | 매 실행 수천 건 | `*.fuzz.test.ts` |
| 패널이 사용자에게 말하는 것 | 10개 검사 | `designerPayload.test.ts` |
| 방어선이 실제로 지탱하는지 | 변이 **313개**, 예상 밖 무반응 0, 낡은 면제 0 | `pnpm design:mutate` |
| 적어 둔 정답이 실제로 검사되는지 | **961/969**, 예상 밖 0, 낡은 면제 0 | `pnpm design:answers` |
| 치환 문자열이 코드와 어긋나지 않았는지 | 313/313 | `pnpm design:anchors` |
| 정규식이 자기 이스케이프를 먹지 않았는지 | 소스 전체 | `sourceHygiene.test.ts` |
| 시험이 정말 무언가를 검사하는지 | 블록 **3567개** 중 단언 미실행 17개(전부 분류됨) | `pnpm audit:assertions` |
| 연산자를 아무도 지키지 않는 자리 | 자동 생성 변이 전수 | `pnpm audit:operators` |

아직 재지 않은 것은 재지 않았다고 말한다 — `goldRequirements.ts`의 `UNMEASURED`가 그 목록이고, 0으로 채우지 않는다.
일부러 읽지 않기로 한 것도 테스트로 고정해 둔다: `쓰다`(쓰기와 사용하기를 가릴 수 없음),
`고르다`(어떤 행위인지 정할 수 없음), `마무리`(남은 일이 무엇인지 문장이 말하지 않음),
명사를 잇는 `하고`(동사 어미와 구별되지 않음), 조사 없는 `봐줘`("이거 봐줘" — 맨 `봐` 는
이 언어의 거의 모든 동사의 보조동사 안에 들어 있다).

산업군 말뭉치가 찾아낸 것 중 가장 큰 것은 **목적어 창이 두 어절**이라는 것이다. 새 결함이
아니라 크기가 새로 밝혀진 결함이다 — 컨설팅 말뭉치는 이것을 세 자리에서 알고 못 박아 두고
있었는데, 산업군 요청에서는 남은 실패 21건 중 **16건이 이것 하나**다. 규제 산업의 도메인
명사가 길고 합성적이기 때문이다("행정 정보 시스템의 접근 권한 모델" → "권한 모델").

넓히면 되는 문제가 아니라는 것을 바깥 정답으로 쟀다. KLUE-DP 검증셋 2,000문장의 목적어구
1,691개에서 고정 창은 어느 폭이든 양쪽으로 함께 틀린다 — 1어절 39.1%, **2어절 27.6%**,
3어절 18.6%. 경계를 표시하는 것은 마지막 형태소이고 그 신호는 깨끗하다(관형격 `의` 99.6%,
관형형 어미 99.5%, 보조사 12.1%). 품사 태그로 경계를 찾으면 **69.4%**, 표면형만으로는
47.1%. 자세한 것은 [docs/inference-performance.md](docs/inference-performance.md) 8절.

**배포·커밋·머지·푸시 금지는 어떤 부류에도 없었다.** 기업·공공 고객이 가장 자주 쓰는
금지인데 관문이 전부 못 봤다. `consultingCases` 는 "실제로 배포하지 말고 계획만 보여줘" 를
`why` 에 "도구 관문이 읽어야 하는 금지" 라고 적어 놓고 정답에는 그 금지를 적지 않아서,
아무것도 재고 있지 않았다. `execute` 부류에 넣었다 — 관문이 같기 때문이고, 다섯 번째 부류는
`decideAction` 이 특별 취급할 것만 하나 늘린다. `반영` 은 자격이 붙어야만 배포다:
"운영에 반영하지 마" 는 실행 금지이고 "그 의견은 반영하지 마" 는 아니다.

`보다` 는 그 목록에 통째로 있었고, 그게 결함이었다. `보여줘` 는 읽히고 `봐줘` 는 안 읽혀서
**"로그를 봐줘" 가 아무 요구사항도 만들지 않았다.** 지금은 조사가 앞에 있을 때만 본동사로
읽는다 — "로그**를** 봐줘"·"코드**만** 봐줘"·"이 파일 **좀** 봐 주세요" 는 읽고,
"실행해 봐줘"·"돌려 봐줘" 는 읽지 않는다. 조사 조건을 빼면 "돌려**를** 살펴본다" 가 나온다.

결과물에 대한 금지는 이제 읽힌다. 여기 "읽히지만 남지 않는다"고 적혀 있었는데, 재어 보니
**읽히지도 않았다** — `prohibitionsIn("워터마크는 넣지 말고")` 은 빈 집합이었다. 세 부류가
전부 도구 관문(실행·수정·웹)이라 어디에도 걸리지 않았던 것이다.

네 번째 부류를 만들지는 않았다. 그 열거형을 쓰는 다섯 자리가 모두 "어떤 도구를 막을까"를
묻는데 결과물 제약의 답은 "없음"이고, 한 곳이라도 빠뜨리면 관문이 조용히 풀린다. 그래서
`outputProhibitions.ts` 가 따로 읽는다. 부류가 아니라 **대상**을 들고 온다는 점이 다르다 —
금지되는 것이 문장마다 다르므로(제품명·가격·경쟁사·추측) 정해진 문장 하나로 접을 수 없고,
사용자가 쓴 말이 그대로 요구사항과 오라클에 들어간다.

같이 좁혀 둔 것: 장소를 말했으면 그 장소가 산출물이어야 한다. "설정 파일에는 쓰지 마" 는
결과물 제약이 아니라 파일에 쓰지 말라는 것이고, 그것은 수정 관문이 결정할 일이다. 장소를
말하지 않은 "추측은 쓰지 말아 주세요" 는 반대로 답변에 대한 제약으로 읽는다.

부정어 없는 제거형("벤더 이름은 빼고 보고서를 정리해줘")도 읽는다. 처음에는 포기했었는데,
그때 방식이 동사 뒤 스무 글자를 훑어 산출물 명사를 찾는 것이었기 때문이다. 그런 창은 다른
뜻의 문장에서도 결국 명사를 찾아낸다. `-고` 가 잇는 **나머지 문장**으로 경계를 바꾸니
지어낸 창이 아니라 실제 경계가 됐다 — "테스트는 빼고 빌드만 해줘" 는 서지 않고,
"테스트는 빼고 빌드해줘. 보고서는 나중에." 도 서지 않는다(마침표 뒤는 다른 생각이다).

검증도 따로 선다. 예전 청사진은 `text.includes("실행")` 로 두 갈래를 갈랐고 나머지를 전부
파일 쓰기 금지로 보냈다 — 결과물 제약이 "파일 수정 금지가 지켜진다" 라는, 아무도 하지 않는
검사 밑에 놓였다는 뜻이다. 지금은 `ScenarioOracle.forbiddenOutput` 이 답을 직접 읽는다.
변이 13개(판독기 7 · 요구사항 3 · 청사진 3) 전부 물었다.

같은 두 갈래가 **웹 금지에도 남아 있었다.** `output` 에 제 갈래를 주면서 눈에 보이던
사례만 고쳤고, "웹 검색은 하지 말고" 는 여전히 파일 쓰기 금지로 검증되고 있었다 — 웹을
보는 사람이 아무도 없었다. 이제 세 부류가 각자 다른 도구를 막고(`run_command` /
쓰기 도구 / `web_search`+`web_fetch`), 셋이 서로 다르다는 것 자체가 테스트다.

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

pnpm design:industry # 12개 산업군 요청에 설계된 하네스를 그대로 출력 (산업군 이름을 인자로)
pnpm design:anchors  # 변이 치환 문자열이 코드와 어긋나지 않았는지 (몇 초)
pnpm design:mutate   # 방어선 313개를 하나씩 지우고 테스트가 잡는지 (수십 분)
pnpm design:answers  # 적어 둔 정답 969개를 하나씩 바꾸고 테스트가 잡는지 (~15분)
pnpm audit:assertions # 시험 블록 중 단언을 한 번도 실행하지 않는 것 (수 분)
pnpm audit:operators src/design/*.ts  # 연산자를 아무도 지키지 않는 자리 (별도 worktree 권장)
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

- **[docs/measurement-and-memory.md](docs/measurement-and-memory.md) — 용어 사전 + 전체 설계 (그림 포함). 처음 읽는다면 여기부터**
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
