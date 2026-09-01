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
    assert.deepEqual(got, ["결과를 설명한다"]);
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
    // `기존` used to be cut off by the two-token window, which is why this read
    // "Arena와 Worktree를" until the window learned about lists. It is the
    // user's own word and it changes what the requirement means — keeping the
    // *existing* Arena is not the same instruction as keeping an Arena.
    assert.deepEqual(texts("기존 Arena와 Worktree를 유지하면서 HASA Coding Agent를 추가해줘."), [
      "기존 Arena와 Worktree를 그대로 유지한다",
      "Coding Agent를 추가한다",
    ]);
  });
});

describe("조사와 파일명", () => {
  test("점이 든 파일명을 문장 경계로 자르지 않는다", () => {
    assert.deepEqual(texts("main.py 코드만 분석해줘."), ["main.py 코드를 분석한다"]);
  });

  test("`도` 는 목적어에 남지 않는다", () => {
    const got = texts("실제 실행 결과도 보여줘.");
    assert.deepEqual(got, ["실행 결과를 살펴본다"]);
    assert.ok(!got.some((t) => t.includes("도를")), "이중 조사가 남았습니다");
  });

  test("`도` 를 지워도 단어가 남을 때만 지운다", () => {
    // "속도" is a word, not a noun plus the additive particle.
    assert.deepEqual(texts("응답 속도를 개선해줘."), ["응답 속도를 개선한다"]);
  });

  test("`만` / `에서만` / `안에서만`", () => {
    assert.deepEqual(texts("auth 폴더 안에서만 수정해줘."), ["auth 폴더를 수정한다"]);
    assert.deepEqual(texts("코드만 보여줘."), ["코드를 살펴본다"]);
  });

  test("조사는 구가 정해진 뒤 마지막 토큰에서만 떼어낸다", () => {
    // Stripping from every token cut `있는` — a verb ending — down to `있`,
    // and the object came out as "있 모델".
    //
    // The phrase around it is not shown either: it begins with `사용할`, which is
    // a verb, and a sentence starting mid-clause reads as a fragment.
    assert.equal(of("사용할 수 있는 모델을 확인해줘.")[0]?.object, "모델");
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

/**
 * A list is one noun phrase, and so is a range.
 *
 * Every case here lost part of what the user named. The window was "the last two
 * noun tokens", which is right for a modifier chain and wrong for an
 * enumeration: it kept the head and deleted the members in front of it, so a
 * request naming two architectures came back naming one — and the member it
 * deleted was always the one the user put first.
 */
describe("나열과 범위는 하나의 목적어다", () => {
  test("접속 조사로 이어진 목록은 통째로 남는다", () => {
    assert.deepEqual(texts("CNN과 ViT로 분류기를 만들고 각각 학습해줘."), [
      "CNN과 ViT로 분류기를 추가한다",
      "각각을 학습한다",
    ]);
    assert.deepEqual(texts("개와 고양이 분류 프로젝트를 만들어줘."), [
      "개와 고양이 분류 프로젝트를 추가한다",
    ]);
    assert.deepEqual(texts("웹과 Hugging Face를 참고해줘."), ["웹과 Hugging Face를 참고한다"]);
  });

  test("범위 조사 부터·까지는 위치가 아니라 목적어의 일부다", () => {
    // Read as location particles, these marked every token in the phrase as
    // grammar and the request came out with no object at all.
    assert.deepEqual(texts("CNN부터 Transformer까지 사용해줘."), [
      "CNN부터 Transformer를 사용한다",
    ]);
  });

  test("목록이 아닌 구는 여전히 두 토큰에서 끊긴다", () => {
    // The widening is for lists only. With no connective the window is what it
    // always was, which is what keeps an adverbial phrase out of the object.
    assert.deepEqual(texts("src 폴더 안에서만 로그를 추가해줘."), ["로그를 추가한다"]);
    // The target, which is the thing the window decides. The sentence around it
    // is wider now and is checked where that rule lives.
    assert.equal(of("사용할 수 있는 모델을 확인해줘.")[0]?.object, "모델");
  });

  test("`과` 로 끝나는 명사와 접속 조사 `과` 는 뒤에 올 말이 있는지로 갈린다", () => {
    // `결과`, `성과`, `효과` end in the syllable that joins a list, and nothing
    // in the shape of the word separates the two readings. What separates them
    // is whether there is another member after it: a connective with nothing to
    // connect to is part of a noun. Without that guard the first sentence widens
    // to "이전 실행 결과" on the strength of a coordination it does not contain.
    assert.deepEqual(texts("이전 실행 결과를 비교해줘."), ["실행 결과를 비교한다"]);
    assert.deepEqual(texts("지난 학습 결과와 로그를 비교해줘."), [
      "지난 학습 결과와 로그를 비교한다",
    ]);
  });
});

/**
 * The act the user named, not a representative of its class.
 *
 * A designer's entire output is a list of sentences saying "this is what I
 * understood". Handing back a different verb from the one that was typed is a
 * misreading the user cannot correct, because they never see the word that was
 * dropped.
 */
describe("사용자가 쓴 동사가 요구사항에 남는다", () => {
  test("분류가 아니라 그 동사로 읽힌다", () => {
    // Was "README 한국어를 번역한다". `한국어로` is how, not what — the target is
    // the README — and welding it on produced a compound noun that does not
    // exist. It is still the user's word, so it moved out of the target and back
    // into the sentence rather than being dropped.
    assert.deepEqual(texts("README를 한국어로 번역해줘."), ["README를 한국어로 번역한다"]);
    assert.deepEqual(texts("두 결과를 비교해줘."), ["두 결과를 비교한다"]);
    assert.deepEqual(texts("모델을 학습해줘."), ["모델을 학습한다"]);
    assert.deepEqual(texts("의존성을 설치해줘."), ["의존성을 설치한다"]);
  });

  test("분류의 말이 더 정확한 곳에서는 분류의 말을 쓴다", () => {
    // `유지` on its own loses 그대로, and "fix한다" is not Korean. Both take the
    // class phrase on purpose.
    assert.deepEqual(texts("기존 동작을 유지해줘."), ["기존 동작을 그대로 유지한다"]);
    assert.deepEqual(texts("로그인 오류를 fix 해줘."), ["로그인 오류를 수정한다"]);
  });

  test("살펴보다는 출력하는 말이면서 읽는 말이기도 하다", () => {
    // It was only ever the former: the verb this file renders for the whole
    // inspect class could not be typed as input.
    assert.deepEqual(texts("결과와 로그를 살펴봐줘."), ["결과와 로그를 살펴본다"]);
  });
});

/**
 * What a sentence says about its target, and what the target is.
 *
 * Every case here came from the first request in a domain nobody had tested —
 * turning images into video. Half of those sentences produced nothing and most
 * of the rest produced a target that was not a word: `동영상으`, `해상`,
 * `5초짜리`. What they have in common is that Korean puts a great deal in front
 * of its verb that is *not* the object, and telling those apart is most of the
 * work.
 */
describe("무엇이 대상이고 무엇이 대상이 아닌가", () => {
  test("도구격 `-로`/`-으로` 는 방법이지 대상이 아니다", () => {
    // `동영상으로` had only its `로` taken off, so the target was `동영상으` — a
    // fragment, shown to the user as the thing their request was about. The
    // means stays in the sentence, out of the target.
    assert.deepEqual(texts("이미지를 동영상으로 만들어줘."), ["이미지를 동영상으로 추가한다"]);
    assert.equal(of("이미지를 동영상으로 만들어줘.")[0]?.object, "이미지");
    assert.deepEqual(texts("설정을 기본값으로 되돌려줘."), ["설정을 기본값으로 수정한다"]);
    assert.deepEqual(texts("결과를 미리보기로 보여줘."), ["결과를 미리보기로 살펴본다"]);
  });

  test("목적어 표시가 없으면 `-로` 구가 유일한 명사다", () => {
    // The other side of the rule above, and the shape no corpus contained: with
    // nothing marked by `을`/`를`, the instrumental phrase is not competing with
    // an object — it *is* the only noun in the sentence. Dropping it would leave
    // the request with no target at all, so it stays, and the particle strip at
    // the end of the phrase is then the only thing standing between the user and
    // `동영상으`.
    assert.deepEqual(texts("동영상으로 만들어줘."), ["동영상을 추가한다"]);
    assert.deepEqual(texts("기본값으로 되돌려줘."), ["기본값을 수정한다"]);
    assert.deepEqual(texts("한국어로 번역해줘."), ["한국어를 번역한다"]);
  });

  test("숫자로 끝나는 대상에 조사를 올바르게 붙인다", () => {
    // `mp4을` — digits were falling to the consonant-final default. They are read
    // as their Korean names, and 사 ends in a vowel.
    assert.deepEqual(texts("mp4로 내보내줘."), ["mp4를 내보낸다"]);
    assert.deepEqual(texts("결과 영상을 mp4로 내보내줘."), ["결과 영상을 mp4로 내보낸다"]);
  });

  test("`-도` 로 끝나는 측정 명사에서 조사를 떼지 않는다", () => {
    // The length guard passed `해상도` because `해상` is two syllables and looks
    // like a word. `-도` builds measure nouns and they are exactly what a
    // project measuring anything names.
    assert.deepEqual(texts("해상도를 설정해줘."), ["해상도를 설정한다"]);
    assert.deepEqual(texts("정확도를 측정해줘."), ["정확도를 측정한다"]);
    // The additive particle still comes off where it is one.
    assert.deepEqual(texts("결과도 확인해줘."), ["결과를 확인한다"]);
  });

  test("관형절의 동사는 목적어의 일부가 아니다", () => {
    assert.equal(of("생성하는 도구를 만들어줘.")[0]?.object, "도구");
    assert.equal(of("생성된 영상을 저장해줘.")[0]?.object, "영상");
    // A contentful modifier is still kept — `업로드` is not one of the acts.
    assert.equal(of("업로드한 사진을 바꿔줘.")[0]?.object, "업로드한 사진");
  });

  test("수사와 단위는 한 낱말이다", () => {
    // The two-token window ended at `한 장` — a quantity with nothing to
    // quantify — because Korean writes the counter as its own word.
    assert.deepEqual(texts("이미지 한 장을 영상으로 변환해줘."), [
      "이미지 한 장을 영상으로 변환한다",
    ]);
  });

  test("`-ㄹ 수 있게 해줘` 는 기능 요청이다", () => {
    // The commonest way to ask for a feature in Korean, and it read as nothing.
    assert.deepEqual(texts("프레임 수와 해상도를 설정할 수 있게 해줘."), [
      "프레임 수와 해상도를 설정한다",
    ]);
    assert.deepEqual(texts("실패하면 다시 시도하게 해줘."), ["요청한 명령을 실행한다"]);
  });

  test("조건절의 동사는 요청이 아니고, 대상도 아니다", () => {
    // Two failures in one sentence: `-면` marks a hypothesis and the table
    // happens to try 바꾸 before 비교, so the design recorded a change nobody
    // asked for and lost the comparison. The target then came out of the
    // condition as well.
    assert.deepEqual(texts("프롬프트를 바꾸면 결과가 어떻게 달라지는지 비교해줘."), [
      "결과를 비교한다",
    ]);
  });

  test("대상이 조건절 뒤에 있으면 수식어를 대상으로 삼지 않는다", () => {
    // "5초짜리를 영상으로 변환한다" — a size with nothing to size, produced
    // because the marked object sits on the far side of the condition. Nothing
    // is the honest answer here; inventing one out of the nearest modifier is
    // not.
    assert.deepEqual(texts("이미지를 업로드하면 5초짜리 영상으로 변환해줘."), []);
  });
});

describe("정정문은 요청이 아니다", () => {
  test("`-라는 게 아니라` 는 앞의 동사를 부정한다", () => {
    // How a person corrects an agent that did the wrong thing — and it produced
    // a requirement to do that thing again.
    const got = texts("아니, 실행하라는 게 아니라 코드 결과물을 보여달라는 말이야.");
    assert.deepEqual(got, ["코드 결과물을 살펴본다"]);
    assert.ok(!got.some((t) => t.includes("실행")), got.join(", "));
  });
});

describe("읽지 않기로 한 것들", () => {
  // Pinned so the gaps stay visible. Asserting that nothing is produced is the
  // only way a deliberate omission stays a decision instead of decaying into an
  // oversight nobody remembers making.
  test("`쓰다` 는 읽지 않는다 — 쓰기와 사용하기를 가릴 수 없다", () => {
    assert.deepEqual(texts("CNN과 Transformer를 쓰고 학습까지 해줘."), []);
    assert.deepEqual(texts("보고서를 쓰고 공유해줘."), []);
  });

  test("`실제로` 는 목적어가 아니다", () => {
    // It became one: "실제를 살펴본다" named a target the sentence does not have.
    assert.deepEqual(texts("실제로 호출되는지도 알려줘."), ["요청한 내용을 살펴본다"]);
  });
});

/**
 * Where the noun phrase starts, which is not "two tokens back".
 *
 * Every case here produced a wrong target while the window was "the last two
 * surviving tokens": the tokens that survived were not adjacent in the sentence,
 * so an adverbial phrase sitting between the object and its verb became part of
 * the object. Reading right-to-left and stopping at the first non-noun is what
 * fixed them, and these are the sentences that decide it.
 */
describe("목적어 구는 어디서 끊기는가", () => {
  test("위치를 나타내는 말은 목적어에 붙지 않는다", () => {
    assert.deepEqual(texts("src 폴더 안에서만 로그를 추가해줘."), ["로그를 추가한다"]);
    assert.deepEqual(texts("CI에서 pytest를 실행해줘."), ["pytest를 실행한다"]);
  });

  test("뒤따르는 부사는 목적어를 끊지 않는다", () => {
    // The mirror image, and the reason the rule is not "stop at anything odd":
    // Korean puts trailing adverbs between the object and its verb.
    assert.deepEqual(texts("auth 폴더 안에서만 수정하고 끝내줘."), ["auth 폴더를 수정한다"]);
    assert.deepEqual(texts("기존 동작은 그대로 유지해줘."), ["기존 동작을 그대로 유지한다"]);
  });

  test("조건절은 목적어에 붙지 않는다", () => {
    assert.deepEqual(texts("테스트가 실패하면 로그를 추가해줘."), ["로그를 추가한다"]);
  });

  test("주제 조사가 붙은 앞말은 다른 구다", () => {
    assert.deepEqual(texts("오늘은 main.py를 실행해줘."), ["main.py를 실행한다"]);
  });

  test("때를 나타내는 말은 목적어가 아니다", () => {
    // Bare, with no particle to give it away. Without the word list these become
    // "오늘 main.py" and "어제 로그" — a date bound to a file.
    assert.deepEqual(texts("오늘 main.py를 실행해줘."), ["main.py를 실행한다"]);
    assert.deepEqual(texts("내일 로그를 추가해줘."), ["로그를 추가한다"]);
  });

  test("관형형은 목적어의 일부로 남는다", () => {
    // The other direction: `실패한` modifies `부분` and belongs to the phrase.
    assert.deepEqual(texts("실패한 부분을 수정해줘."), ["실패한 부분을 수정한다"]);
  });

  test("보조 용언은 목적어에 남지 않는다", () => {
    assert.deepEqual(texts("사용하지 않는 import를 제거해줘."), ["import를 제거한다"]);
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

  test("영어 명령문은 어순을 바꿔 읽는다", () => {
    // Korean is verb-final and English is not, so the English pass takes its
    // object on the other side of the verb. This test used to assert the
    // opposite — that English produced nothing — and it recorded a real
    // limitation until the pass was written.
    const got = of("Fix the login bug and run the tests.");
    assert.deepEqual(
      got.map((c) => c.action),
      ["modify", "execute"],
    );
    assert.deepEqual(
      got.map((c) => c.object),
      ["login bug", "tests"],
    );
  });

  test("영어 서술문과 의문문은 명령으로 읽지 않는다", () => {
    // The direction that must not fail. English marks the imperative by
    // position, so a verb in the middle of a sentence is doing another job —
    // a noun, a subordinate clause, a report about what already happened.
    for (const text of [
      "Why did the build fail?",
      "The previous run did not use web search.",
      "The tests run in CI.",
      "I wonder if we should refactor this.",
      "Thanks, that works!",
    ]) {
      assert.deepEqual(of(text), [], text);
    }
  });

  test("영어 금지문은 그 동사를 요구로 만들지 않는다", () => {
    // `statedProhibitions` reads these as bans; emitting the positive act here
    // would have the runtime contradict itself about one sentence.
    assert.deepEqual(of("Don't run the tests."), []);
    const mixed = of("Do not modify anything, just explain.");
    assert.ok(!mixed.some((c) => c.action === "modify"), "the forbidden act was read as a request");
    assert.ok(mixed.some((c) => c.action === "inspect"), "the act that *was* asked for went missing");
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
