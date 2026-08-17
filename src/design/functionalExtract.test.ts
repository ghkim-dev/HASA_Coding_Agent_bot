import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { functionalCandidates, type FunctionalCandidate } from "./functionalExtract.ts";
import { runtimeRequirements } from "./requirementSpec.ts";
import { checkSpan } from "./sourceSpan.ts";

/**
 * What the offline extractor reads, and what it refuses to invent.
 *
 * Written as one case per linguistic situation rather than per fixture, because
 * the failures it exists to prevent were all grammar: a particle that pushed the
 * noun out of the window, a connective that survived as an object, a negation
 * form the pattern did not recognise and so read as a request.
 */

const T = "t1";
const of = (text: string): FunctionalCandidate[] => functionalCandidates({ turnId: T, text });
const texts = (text: string): string[] => of(text).map((c) => c.text);

describe("동사와 목적어", () => {
  test("동사+목적어", () => {
    assert.deepEqual(texts("로그인 오류를 수정해줘."), ["로그인 오류를 수정한다"]);
  });

  test("목적어 없는 수정은 만들지 않는다", () => {
    // The target is what the runtime would have to invent, so it stops.
    assert.deepEqual(texts("수정해줘"), []);
    assert.deepEqual(texts("추가해줘"), []);
    assert.deepEqual(texts("삭제해줘"), []);
  });

  test("목적어 생략이 허용되는 테스트·실행·설명", () => {
    assert.deepEqual(texts("테스트해줘"), ["테스트를 실행해 결과를 확인한다"]);
    assert.deepEqual(texts("실행해줘"), ["요청한 명령을 실행한다"]);
    assert.deepEqual(texts("설명해줘"), ["요청한 내용을 살펴본다"]);
  });

  test("생략된 목적어는 unresolved 로 기록되고 지어내지 않는다", () => {
    const [spec] = runtimeRequirements({ turnId: T, text: "테스트해줘" });
    assert.equal(spec?.binding, "unresolved");
    assert.equal(spec?.intent, "confirmed", "요청 자체는 분명하다");
  });

  test("목적어가 있으면 binding 이 resolved", () => {
    const spec = runtimeRequirements({ turnId: T, text: "로그인 오류를 수정해줘." })[0];
    assert.equal(spec?.binding, "resolved");
    assert.equal(spec?.intent, "confirmed");
  });
});

describe("부정문", () => {
  test("부정문에서 긍정 요구사항을 만들지 않는다", () => {
    for (const text of [
      "파일을 수정하지 마.",
      "파일을 수정하진 마.",
      "코드를 수정하지는 말아줘.",
      "테스트를 실행하면 안 돼.",
      "테스트를 실행해서는 안 된다.",
      "코드를 보여주지 마.",
    ]) {
      assert.deepEqual(of(text), [], text);
    }
  });

  test("`-지 말고` 뒤의 긍정 요청은 살린다", () => {
    assert.deepEqual(texts("수정하지 말고 설명만 해줘."), ["요청한 내용을 살펴본다"]);
    assert.deepEqual(texts("실행하지 말고 코드만 보여줘."), ["코드를 살펴본다"]);
  });

  test("`말고` 는 목적어가 되지 않는다", () => {
    // "말고 결과를 살펴본다" — the connective ending the prohibition survived
    // into the noun window and became the thing to inspect.
    const got = texts("테스트는 실행하지 말고 결과만 설명해줘.");
    assert.deepEqual(got, ["결과를 살펴본다"]);
    assert.ok(!got.some((t) => t.includes("말고")), got.join(", "));
  });

  test("금지 절은 긍정 요청의 span 에 들어가지 않는다", () => {
    const [candidate] = of("테스트는 실행하지 말고 결과만 설명해줘.");
    assert.ok(candidate !== undefined);
    const quoted = "테스트는 실행하지 말고 결과만 설명해줘.".slice(candidate.span.start, candidate.span.end);
    assert.ok(!quoted.includes("실행하지 말고"), `근거에 금지가 들어 있습니다: "${quoted}"`);
  });
});

describe("과거 실패 보고", () => {
  test("과거의 실패는 요청이 아니다", () => {
    assert.deepEqual(of("아까는 실행하지 못했어."), []);
    assert.deepEqual(of("테스트가 실패했어."), []);
  });

  test("실패 보고 뒤의 요청은 읽는다", () => {
    assert.deepEqual(texts("아까는 실행하지 못했어. 원인을 고치고 이번에는 다시 실행해줘."), [
      "원인을 수정한다",
      "요청한 명령을 실행한다",
    ]);
  });
});

describe("병렬 요청", () => {
  test("`-고` 로 이어진 두 요청을 둘 다 읽는다", () => {
    assert.deepEqual(texts("로그인 오류를 수정하고 테스트해줘."), [
      "로그인 오류를 수정한다",
      "테스트를 실행해 결과를 확인한다",
    ]);
  });

  test("`하고` 가 아닌 `-고` 도 절 경계다", () => {
    // Matching the literal "하고" left this one clause, and the single
    // requirement-per-clause rule then dropped the first request entirely.
    assert.deepEqual(texts("main.py 코드도 보여주고 실제 실행 결과도 보여줘."), [
      "main.py 코드를 살펴본다",
      "실행 결과를 살펴본다",
    ]);
  });

  test("`면서` 로 이어진 두 요청", () => {
    assert.deepEqual(texts("기존 Arena와 Worktree를 유지하면서 HASA Coding Agent를 추가해줘."), [
      "Arena와 Worktree를 그대로 유지한다",
      "Coding Agent를 추가한다",
    ]);
  });
});

describe("조사와 파일명", () => {
  test("점이 든 파일명을 문장 경계로 자르지 않는다", () => {
    assert.deepEqual(texts("main.py 코드만 분석해줘."), ["main.py 코드를 살펴본다"]);
  });

  test("`도` 는 목적어에 남지 않는다", () => {
    const got = texts("실제 실행 결과도 보여줘.");
    assert.deepEqual(got, ["실행 결과를 살펴본다"]);
    assert.ok(!got.some((t) => t.includes("도를")), "이중 조사가 남았습니다");
  });

  test("`도` 를 지워도 단어가 남을 때만 지운다", () => {
    // "속도" is a word, not a noun plus the additive particle.
    assert.deepEqual(texts("응답 속도를 개선해줘."), ["응답 속도를 수정한다"]);
  });

  test("`만` / `에서만` / `안에서만`", () => {
    assert.deepEqual(texts("auth 폴더 안에서만 수정해줘."), ["auth 폴더를 수정한다"]);
    assert.deepEqual(texts("코드만 보여줘."), ["코드를 살펴본다"]);
  });

  test("조사는 구가 정해진 뒤 마지막 토큰에서만 떼어낸다", () => {
    // Stripping from every token cut `있는` — a verb ending — down to `있`,
    // and the object came out as "있 모델".
    assert.deepEqual(texts("사용할 수 있는 모델을 확인해줘."), ["모델을 확인한다"]);
    assert.deepEqual(texts("기존 API 호환성은 반드시 유지해줘."), ["API 호환성을 그대로 유지한다"]);
  });

  test("조사 을/를 을 올바르게 붙인다", () => {
    assert.ok(texts("로그인 오류를 수정해줘.")[0]?.startsWith("로그인 오류를"));
    assert.ok(texts("main.py 코드를 보여줘.")[0]?.startsWith("main.py 코드를"));
    // Latin endings read as their Korean transliteration: `t` → 트, vowel-final.
    assert.ok(texts("Coding Agent를 추가해줘.")[0]?.startsWith("Coding Agent를"));
  });
});

describe("유지 요청", () => {
  test("호환성 유지는 요구사항이 된다", () => {
    assert.deepEqual(texts("API 호환성을 유지해줘."), ["API 호환성을 그대로 유지한다"]);
  });

  test("유지를 수정으로 읽지 않는다", () => {
    const [candidate] = of("API 호환성을 유지해줘.");
    assert.equal(candidate?.action, "preserve");
    assert.notEqual(candidate?.action, "modify");
  });

  test("유지 요구사항은 compatibility 로 분류된다", () => {
    const spec = runtimeRequirements({ turnId: T, text: "API 호환성을 유지해줘." })[0];
    assert.equal(spec?.kind, "compatibility");
    assert.equal(spec?.polarity, "required");
  });

  test("`그대로 유지` 도 읽는다", () => {
    assert.deepEqual(texts("수정하면서 기존 테스트는 그대로 유지해줘."), ["기존 테스트를 그대로 유지한다"]);
  });
});

describe("설명·분석 요청", () => {
  test("분석과 설명은 inspect 다", () => {
    for (const text of ["코드를 분석해줘.", "코드를 설명해줘.", "코드를 보여줘."]) {
      assert.equal(of(text)[0]?.action, "inspect", text);
    }
  });
});

describe("범위 제한과 조건", () => {
  test("scope 는 원문에서 다시 읽는다", () => {
    const spec = runtimeRequirements({ turnId: T, text: "auth 폴더 안에서만 수정해줘." }).find(
      (s) => s.derivedBy === "runtime_action",
    );
    assert.ok((spec?.scope ?? []).length > 0, "범위가 기록되지 않았습니다");
  });

  test("조건부 요청은 조건을 남긴다", () => {
    const spec = runtimeRequirements({
      turnId: T,
      text: "기존 클라이언트가 사용 중이라면 API 형식을 변경하지 마.",
    })[0];
    assert.ok(spec?.condition !== undefined);
  });
});

describe("경계 입력", () => {
  test("빈 문자열", () => {
    assert.deepEqual(of(""), []);
    assert.deepEqual(of("   \n  "), []);
  });

  test("동사가 없으면 아무것도 만들지 않는다", () => {
    assert.deepEqual(of("적당히 잘 좀 해줘."), []);
    assert.deepEqual(of("알아서 다 해줘."), []);
  });

  test("영어 문장은 읽지 않는다", () => {
    // Korean-only by construction. Recorded so a silent zero is a known
    // limitation rather than a bug somebody rediscovers.
    assert.deepEqual(of("Fix the login bug and run the tests."), []);
  });

  test("접속사는 목적어가 되지 않는다", () => {
    const got = texts("재현해줘. 그리고 검증해줘.");
    assert.ok(!got.some((t) => t.includes("그리고")), got.join(", "));
  });

  test("한국어와 영어 식별자가 섞인 문장", () => {
    assert.deepEqual(texts("HASA Coding Agent를 추가해줘."), ["Coding Agent를 추가한다"]);
  });
});

describe("span 은 UTF-16 좌표로 정확하다", () => {
  test("이모지가 있어도 원문을 가리킨다", () => {
    const TEXT = "🔥 로그인 오류를 수정해줘";
    const [candidate] = of(TEXT);
    assert.ok(candidate !== undefined);
    assert.equal(checkSpan({ span: candidate.span, turnId: T, full: TEXT }).ok, true);
    assert.ok(TEXT.slice(candidate.span.start, candidate.span.end).includes("로그인 오류"));
  });

  test("같은 절이 반복돼도 각 span 이 제자리를 가리킨다", () => {
    const TEXT = "테스트해줘. 테스트해줘. 테스트해줘.";
    const starts = functionalCandidates({ turnId: T, text: TEXT }).map((c) => c.span.start);
    assert.deepEqual([...new Set(starts)].length, starts.length, "span 이 겹칩니다");
  });

  test("모든 span 이 원문 범위 안에 있다", () => {
    for (const TEXT of [
      "로그인 오류를 수정하고 테스트해줘.",
      "main.py 코드도 보여주고 실제 실행 결과도 보여줘.",
      "기존 Arena와 Worktree를 유지하면서 HASA Coding Agent를 추가해줘.",
    ]) {
      for (const candidate of functionalCandidates({ turnId: T, text: TEXT })) {
        assert.equal(checkSpan({ span: candidate.span, turnId: T, full: TEXT }).ok, true, `${TEXT} / ${candidate.text}`);
        assert.ok(candidate.span.end <= TEXT.length);
      }
    }
  });
});

describe("같은 동사가 여러 번 나오는 문장", () => {
  test("같은 행동과 같은 대상은 한 번만 기록한다", () => {
    assert.deepEqual(texts("로그인 오류를 수정해줘. 그리고 로그인 오류를 다시 수정해줘."), [
      "로그인 오류를 수정한다",
    ]);
  });

  test("대상이 다르면 둘 다 기록한다", () => {
    assert.deepEqual(texts("로그인 오류를 수정하고 결제 오류를 수정해줘."), [
      "로그인 오류를 수정한다",
      "결제 오류를 수정한다",
    ]);
  });
});

describe("결정론", () => {
  test("같은 입력은 같은 결과를 낸다", () => {
    for (const TEXT of ["로그인 오류를 수정하고 테스트해줘.", "수정하지 말고 설명만 해줘."]) {
      assert.deepEqual(of(TEXT), of(TEXT));
    }
  });
});
