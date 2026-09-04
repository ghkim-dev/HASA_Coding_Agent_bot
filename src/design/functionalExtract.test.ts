import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { functionalCandidates, type FunctionalCandidate } from "./functionalExtract.ts";
import { runtimeRequirements } from "./requirementSpec.ts";
import { checkSpan } from "./sourceSpan.ts";
import { prohibitionsIn } from "../agent/statedProhibitions.ts";

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
    // The class phrase stays where it still says the user's word — 테스트 and
    // 실행 are both inside their own — and steps aside where it does not.
    // "설명해줘" used to come back as "요청한 내용을 살펴본다", which is a
    // different act: explaining is not inspecting, and the same file already
    // says so for the case with an object ("결과를 설명한다", below). The two
    // now agree.
    assert.deepEqual(texts("테스트해줘"), ["테스트를 실행해 결과를 확인한다"]);
    assert.deepEqual(texts("실행해줘"), ["요청한 명령을 실행한다"]);
    assert.deepEqual(texts("설명해줘"), ["설명한다"]);
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
    assert.deepEqual(texts("수정하지 말고 설명만 해줘."), ["설명한다"]);
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
      "CNN과 ViT로 분류기를 만든다",
      "각각을 학습한다",
    ]);
    assert.deepEqual(texts("개와 고양이 분류 프로젝트를 만들어줘."), [
      "개와 고양이 분류 프로젝트를 만든다",
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
    assert.deepEqual(texts("이미지를 동영상으로 만들어줘."), ["이미지를 동영상으로 만든다"]);
    assert.equal(of("이미지를 동영상으로 만들어줘.")[0]?.object, "이미지");
    // 되돌리는 것과 고치는 것은 다른 결과물이다 — 하나는 있던 자리로 돌려놓고
    // 다른 하나는 새것으로 바꾼다. 부류는 같지만 동사는 다르다.
    assert.deepEqual(texts("설정을 기본값으로 되돌려줘."), ["설정을 기본값으로 되돌린다"]);
    assert.deepEqual(texts("결과를 미리보기로 보여줘."), ["결과를 미리보기로 살펴본다"]);
  });

  test("목적어 표시가 없으면 `-로` 구가 유일한 명사다", () => {
    // The other side of the rule above, and the shape no corpus contained: with
    // nothing marked by `을`/`를`, the instrumental phrase is not competing with
    // an object — it *is* the only noun in the sentence. Dropping it would leave
    // the request with no target at all, so it stays, and the particle strip at
    // the end of the phrase is then the only thing standing between the user and
    // `동영상으`.
    assert.deepEqual(texts("동영상으로 만들어줘."), ["동영상을 만든다"]);
    assert.deepEqual(texts("기본값으로 되돌려줘."), ["기본값을 되돌린다"]);
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
    // "시도한다", not "요청한 명령을 실행한다". Neither says 다시 or 실패하면 —
    // that is a real limit and it is unchanged. What changed is which word the
    // requirement is built from, and the user's own 시도 beats a class phrase
    // that names a different act.
    assert.deepEqual(texts("실패하면 다시 시도하게 해줘."), ["시도한다"]);
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

describe("의존명사와 부정칭은 대상이 아니다", () => {
  test("`걸`, `것`, `거` 는 목적어가 되지 않는다", () => {
    // "뭔가 좋은 걸 만들어줘" produced `좋은 걸을 추가한다` — a doubled particle
    // on a bound noun, describing nothing, and the design then reported itself
    // ready to run. This file's own header says "적당히 잘 좀 해줘" must yield
    // nothing; that sentence is the same one with a verb it happens to know.
    assert.deepEqual(texts("뭔가 좋은 걸 만들어줘."), []);
    assert.deepEqual(texts("좋은 것 좀 추가해줘."), []);
  });

  test("부정칭 대명사는 대상이 아니다", () => {
    // Separate from the bound-noun rule and checked on its own, because the two
    // overlap on "뭔가 좋은 걸 만들어줘" and either alone would look sufficient.
    // `뭔가` names nothing; a requirement to add it is a requirement to add
    // something unspecified, which is the invention this file exists against.
    assert.deepEqual(texts("뭔가를 추가해줘."), []);
    assert.deepEqual(texts("무언가를 만들어줘."), []);
  });

  test("의존명사가 빠지면 남은 관형어만으로 대상을 만들지 않는다", () => {
    // The modifier is left standing when its noun turns out to be grammar. One
    // token, and an adjective at that, is not something a run can be bound to.
    assert.deepEqual(texts("빠른 걸 만들어줘."), []);
  });

  test("명사가 살아 있으면 관형어는 그대로 남는다", () => {
    // `등` is not a bound noun in this sense — it attaches after a real one.
    assert.deepEqual(texts("파일 등을 추가해줘."), ["파일을 추가한다"]);
    // The other direction, and the reason the rule is one token wide: these
    // still have their noun, and the gold set pinned them.
    assert.deepEqual(texts("실패한 부분을 수정해줘."), ["실패한 부분을 수정한다"]);
    assert.deepEqual(texts("낡은 설정을 삭제해줘."), ["낡은 설정을 삭제한다"]);
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

/**
 * 하나의 하다를 나눠 쓰는 두 행위.
 *
 * "학습과 추론을 하고" 는 두 가지를 요청한 문장이고, 조사 간격을 넓혀 `추론을
 * 하-` 를 동사로 읽게 만든 순간 목적어 스캔이 앞 낱말을 집어 **학습과를
 * 추론한다** 를 내놓았다. 사용자가 부른 적 없는 대상에, 요청한 적 없는 행위가
 * 묶인 문장이다.
 *
 * 그래서 여기서 재는 것은 두 낱말이 살아남았는지가 아니라 **무엇이 대상이
 * 되었는지** 다. 첫 번째 테스트가 지어낸 대상을 직접 막고, 두 번째가 같은
 * 모양의 평범한 명사 나열은 건드리지 않는다는 것을 막는다 — 어휘 목록이 유일한
 * 판정 근거이므로, 그 목록을 보지 않게 되면 두 번째가 먼저 깨진다.
 */
describe("경동사 하나에 묶인 여러 행위", () => {
  test("`A와 B를 하다` 는 두 행위이고, A 는 B 의 목적어가 아니다", () => {
    const got = texts("학습과 추론을 하고, 결과를 비교해줘.");
    assert.deepEqual(got, ["학습한다", "추론한다", "결과를 비교한다"]);
    assert.ok(!got.some((t) => t.includes("학습과를")), got.join(", "));
  });

  test("동사가 아닌 명사 나열은 그대로 목적어다", () => {
    // 같은 `X와 Y를 …` 모양이지만 개 와 고양이 는 동사 어간이 아니다. 어휘를
    // 보지 않고 모양만 보면 이 문장이 먼저 부서진다.
    assert.deepEqual(texts("개와 고양이를 분류하는 프로젝트를 만들어줘."), [
      "개와 고양이를 분류하는 프로젝트를 만든다",
    ]);
  });

  test("이름을 댈 수 없는 것과 묶여 있어도 목적어로 삼지 않는다", () => {
    // 전처리 는 이 파일이 아는 동사가 아니다. 그렇다고 학습 의 대상은 아니므로,
    // 조사 간격만 넓혔을 때 나오던 "전처리와를 학습한다" 는 없는 대상을 지어낸
    // 문장이었다. 읽지 못한 것은 구멍이고, 지어낸 것은 그보다 나쁘다.
    const got = texts("전처리와 학습을 해줘.");
    assert.deepEqual(got, ["학습한다"]);
    assert.ok(!got.some((t) => t.includes("전처리와를")), got.join(", "));
  });

  test("과·와 로 끝나는 두 음절 낱말은 쪼개지 않는다", () => {
    // 결과, 성과, 효과 는 접속조사가 아니라 낱말의 끝 음절이다. 앞이 한 음절뿐일
    // 때는 접속으로 읽지 않는다 — 그러지 않으면 이 문장이 대상을 통째로 잃는다.
    assert.deepEqual(texts("결과 확인을 해줘."), ["결과를 확인한다"]);
    assert.deepEqual(texts("성과를 확인해줘."), ["성과를 확인한다"]);
  });

  test("시점을 말하는 구는 대상이 아니다", () => {
    // "전처리 후를 학습한다" — 시각 하나를, 학습할 대상이라고 내놓고 있었다.
    const got = texts("전처리 후 학습을 해줘.");
    assert.deepEqual(got, ["학습한다"]);
    assert.ok(!got.some((t) => t.includes("후")), got.join(", "));
  });

  test("`와` 가 붙은 비교 상대는 대상이 아니다", () => {
    // "이미지와를 비교한다" 는 조사 두 개가 겹친, 존재하지 않는 대상이었다.
    // 비교 상대를 문장에 되살리는 것은 아직 하지 못한다 — 그것은 구멍이고,
    // 여기서 막는 것은 지어내기다.
    const got = texts("기존 결과와 비교해줘.");
    assert.deepEqual(got, ["비교한다"]);
    assert.ok(!got.some((t) => t.includes("와를")), got.join(", "));
  });

  test("혼자 선 경동사도 사용자가 쓴 낱말로 읽는다", () => {
    // `execute` 의 부류 문구는 "요청한 명령을 실행한다" 라서, 목적어가 없다는
    // 이유로 학습 이라는 단 하나의 낱말이 사라지고 있었다.
    assert.deepEqual(texts("학습까지 해줘."), ["학습한다"]);
    assert.deepEqual(texts("배포를 해줘."), ["배포한다"]);
    // 부류 문구가 이미 그 낱말을 담고 있으면 그대로 둔다. "테스트를 실행해
    // 결과를 확인한다" 는 "테스트한다" 보다 많은 것을 말하고, 잃는 것은 없다.
    assert.deepEqual(texts("테스트를 해줘."), ["테스트를 실행해 결과를 확인한다"]);
    // 목적어 없는 `modify` 는 여전히 요구사항이 아니다. 무엇을 바꾸라는 것인지
    // 문장이 말하지 않았고, 정하는 것은 지어내는 것이다.
    assert.deepEqual(texts("번역을 해줘."), []);
  });
});

/**
 * 쉼표로 잘린 조각이 동사를 갖지 못했을 때.
 *
 * 쉼표는 대개 절을 끝내지만 언제나 그런 것은 아니다. "웹과 Hugging Face, HASA도
 * 참고하고" 는 목록 하나에 동사 하나이고, 쉼표에서 자르면 `웹과 Hugging Face` 가
 * 동사 없는 조각으로 남아 통째로 사라졌다 — 잘못 읽힌 것이 아니라 없어졌다.
 *
 * 접어 넣는 조건이 두 개인 이유는 그 조건 없이 깨진 문장이 각각 있기 때문이고,
 * 그중 하나는 이 파일이 일부러 읽지 않기로 한 동사를 우회하게 만들었다 —
 * `읽지 않기로 한 것들` 의 `쓰다` 테스트가 그것을 지킨다.
 */
/**
 * 무엇에 대한 요청인지 말했지만, 그 무엇이 사물이 아닐 때.
 *
 * "실제로 호출되는지도 알려줘" 는 "요청한 내용을 살펴본다" 가 되었다 — 사용자가
 * 고른 낱말이 하나도 남지 않았고, 그중에는 무엇을 볼 것인지 말하는 유일한 낱말도
 * 있었다. `-는지` 는 명사가 아니므로 목적어 스캔이 거부한 것은 옳고, 없던 것은
 * 절이 사물을 부르지 않고도 제 주제를 말할 수 있다는 사실이다.
 */
describe("`-는지` 로 물은 것은 대상이 아니지만 주제다", () => {
  test("사물을 부르지 않은 절도 무엇에 대한 것인지 말한다", () => {
    assert.deepEqual(texts("실제로 호출되는지도 알려줘."), ["실제로 호출되는지 살펴본다"]);
    assert.deepEqual(texts("무엇이 문제인지만 알려줘."), ["무엇이 문제인지 살펴본다"]);
  });

  test("절이 제 목적어를 부르면 그쪽이 이긴다", () => {
    // 여기서 물은 것은 결과가 어떻게 달라지는가이지만, 문장이 `를` 로 대상을
    // 이미 말했다.
    assert.deepEqual(texts("프롬프트를 바꾸면 결과가 어떻게 달라지는지 비교해줘."), [
      "결과를 비교한다",
    ]);
  });

  test("두 개의 물음은 두 개의 요청이다", () => {
    // 대상이 둘 다 비어 있으므로, 물음이 열쇠에 들어가지 않으면 하나로 합쳐졌다.
    assert.deepEqual(texts("어디가 느린지 알려주고, 왜 실패하는지도 알려줘."), [
      "어디가 느린지 살펴본다",
      "왜 실패하는지 살펴본다",
    ]);
  });
});

describe("동사 없는 조각은 뒤 절에 붙는다", () => {
  test("쉼표로 끊긴 목록은 하나의 목적어다", () => {
    assert.deepEqual(texts("웹과 Hugging Face, HASA도 참고하고, 결과를 비교해줘."), [
      "웹과 Hugging Face, HASA를 참고한다",
      "결과를 비교한다",
    ]);
  });

  test("붙여 넣은 부사는 목적어가 되지 않는다", () => {
    // 접어 넣기 전에는 `먼저,` 가 목적어 창에 들어올 일이 없었다. 쉼표가 붙어
    // 있다는 이유만으로 `먼저` 가 통과하던 검사를 모두 통과했다.
    assert.deepEqual(texts("먼저, 코드를 고쳐줘."), ["코드를 수정한다"]);
  });
});

/**
 * `-어서` 는 조건부 절 경계다.
 *
 * 무조건 자르면 "웹에서 찾아서 정리해줘" 가 요구사항 하나에서 영으로 떨어진다 —
 * 한국어는 뒤 절의 목적어를 생략하고, 목적어 없는 `modify` 절은 버려지기
 * 때문이다. 자르지 않으면 "확인해서 모델 목록을 알려줘" 의 뒤 절이 통째로
 * 사라진다. 두 문장을 가르는 것은 **뒤 절이 제 대상을 스스로 부르는가** 하나뿐이고,
 * 그것이 여기서 재는 것이다.
 */
describe("`-어서` 는 뒤 절이 제 대상을 부를 때만 경계다", () => {
  test("뒤 절이 목적어를 부르면 두 요청으로 읽는다", () => {
    assert.deepEqual(texts("모델 목록을 확인해서 후보를 비교해줘."), [
      "모델 목록을 확인한다",
      "후보를 비교한다",
    ]);
  });

  test("뒤 절이 목적어를 생략하면 자르지 않는다", () => {
    // 자르면 "정리해줘" 만 남고, 목적어 없는 `modify` 는 요구사항이 되지 못해
    // 문장 전체가 사라진다.
    assert.deepEqual(texts("최신 요약 모델을 웹에서 찾아서 정리해줘."), ["요약 모델을 정리한다"]);
  });

  test("`서` 로 끝나는 명사는 경계가 아니다", () => {
    assert.deepEqual(texts("명세서를 갱신해줘."), ["명세서를 갱신한다"]);
    assert.deepEqual(texts("src 폴더에서 로그를 추가해줘."), ["로그를 추가한다"]);
  });
});

/**
 * 조사를 걸친 의존명사와 시점명사.
 *
 * 세 가지 주제를 다시, 이번에는 사람이 실제로 쓸 문장 열 개로 물었더니 없는
 * 대상 네 개가 나왔다. 그중 둘은 뿌리가 같았다 — `걸`과 `중`은 둘 다 이미
 * 목록에 있었고, 통과한 것은 그 뒤에 붙은 `로`와 `에는`였다.
 *
 * 시점명사는 `grammar` 로는 부족하다. 아래 스캔은 목적어에 닿기 위해 부사를
 * 건너뛰는데, 그것이 부사에는 옳고 시점명사에는 틀리다: 건너뛰는 순간
 * "전처리 후 학습을 해줘" 가 전처리를 학습하라는 말이 된다.
 */
/**
 * 목적어 바로 앞에 선 부사.
 *
 * `NOT_AN_OBJECT` 는 이런 낱말을 하나씩, 잘못된 대상으로 나타날 때마다 담아
 * 왔다. 세 주제를 다시 물은 열 문장에서 여섯 개가 더 나왔고 모두 같은 모양이다:
 * 부사가 목적어에 용접된다. 그래서 생산적인 형태는 목록이 아니라 규칙으로 읽고,
 * 표지가 없는 것들만 목록으로 남는다.
 */
describe("부사는 목적어의 일부가 아니다", () => {
  test("생산적인 부사 형태는 규칙으로 읽는다", () => {
    // `-히` 는 거의 무엇에서든 부사를 만들고 명사는 만들지 않는다.
    assert.deepEqual(texts("특히 화질을 확인해줘."), ["화질을 확인한다"]);
    // `-게` 는 형용사 어간에 붙는 형태만 — 그래서 `가게`, `무게` 는 남는다.
    assert.deepEqual(texts("가급적 빠르게 영상을 만들어줘."), ["영상을 만든다"]);
    assert.deepEqual(texts("간단하게 프로토타입을 만들어줘."), ["프로토타입을 만든다"]);
    assert.equal(of("가게 페이지를 만들어줘.")[0]?.object, "가게 페이지");
  });

  test("표지가 없는 부사는 목록으로 남는다", () => {
    // `일단` 의 생김새에는 그것이 명사가 아니라는 표시가 없다.
    assert.deepEqual(texts("음악 없이 영상만 만들어줘."), ["영상을 만든다"]);
    assert.deepEqual(texts("일단 프로토타입을 만들어줘."), ["프로토타입을 만든다"]);
    assert.deepEqual(texts("대충 결과만 보여줘."), ["결과를 살펴본다"]);
    assert.deepEqual(texts("되도록 짧게 영상을 만들어줘."), ["영상을 만든다"]);
  });
});

describe("조사를 걸친 의존명사·시점명사", () => {
  test("의존명사에 조사가 붙어도 대상이 아니다", () => {
    assert.deepEqual(texts("이미지를 10장 뽑아서 그중 제일 나은 걸로 영상을 만들어줘."), [
      "영상을 만든다",
    ]);
  });

  test("시점명사 앞의 명사는 그 시점의 것이다", () => {
    assert.deepEqual(texts("전처리 후 학습을 해줘."), ["학습한다"]);
    assert.deepEqual(texts("생성 중에는 진행률을 보여줘."), ["진행률을 살펴본다"]);
    assert.deepEqual(texts("배포 이후에 로그를 확인해줘."), ["로그를 확인한다"]);
  });

  test("명사를 꾸미는 시점 낱말은 그 명사의 일부다", () => {
    // `전`, `다음`, `이전` 은 이 목록에 있었고 빠졌다. 이 낱말들은 명사 뒤에
    // 서기도 하고 앞에서 꾸미기도 하는데, 머리로만 읽으면 사용자가 쓴 수식어를
    // 지운다.
    assert.deepEqual(texts("이전 결과를 비교해줘."), ["이전 결과를 비교한다"]);
    assert.deepEqual(texts("다음 단계를 실행해줘."), ["다음 단계를 실행한다"]);
  });

  test("목록을 세는 수사는 대상이 아니다", () => {
    assert.deepEqual(texts("결과물은 mp4랑 gif 둘 다 저장해줘."), [
      "결과물은 mp4랑 gif를 저장한다",
    ]);
    // 관형형 수사는 뒤따르는 단위명사와 한 낱말이므로 그대로 남는다 — 세는
    // 말이 아니라 수량을 말하는 구이고, 사용자가 한 장이라고 했다.
    assert.equal(of("이미지 한 장을 영상으로 만들어줘.")[0]?.object, "이미지 한 장");
  });
});

describe("읽지 않기로 한 것들", () => {
  // Pinned so the gaps stay visible. Asserting that nothing is produced is the
  // only way a deliberate omission stays a decision instead of decaying into an
  // oversight nobody remembers making.
  test("`쓰다` 는 읽지 않는다 — 쓰기와 사용하기를 가릴 수 없다", () => {
    // The claim is about `쓰다`, and it used to be written as "the whole
    // sentence yields nothing" — which was true only because the rest of the
    // sentence was unread too. "학습까지 해줘" is a light verb and is now read,
    // so the assertion says what it always meant: the 쓰기 clause contributes
    // nothing, and nothing the extractor emits pretends to know what was 쓰였다.
    const used = texts("CNN과 Transformer를 쓰고 학습까지 해줘.");
    assert.deepEqual(used, ["학습한다"]);
    assert.deepEqual(texts("보고서를 쓰고 공유해줘."), []);
  });

  test("`-어서` 가 줄어든 형태는 절 경계로 읽지 못한다", () => {
    // "실패하면 해상도를 낮춰서 다시 시도해줘" 는 **해상도를 시도한다** 가
    // 된다 — 앞 절의 목적어가 뒤 절의 동사에 묶인다. `-아서/-어서` 는 어간에
    // 붙으면서 모음이 음절 안으로 줄어들고(`낮추어서` → `낮춰서`), 그 형태를
    // 안전하게 알아보려면 어간 목록이 필요하다. 열린 음절 앞의 `서` 로 판정하면
    // `명세서`·`순서` 가 절 경계가 되므로, 이 파일이 이미 거부한 방법이다.
    //
    // 이름을 붙여 놓는다: 지어내기이고, 한 줄로 고칠 수 없다.
    assert.deepEqual(texts("실패하면 해상도를 낮춰서 다시 시도해줘."), ["해상도를 시도한다"]);
  });

  test("`-지 않게 해줘` 로 말한 제약은 읽지 못한다", () => {
    // "영상 길이는 5초를 넘기지 않게 해줘" 는 제약이고 아무것도 나오지 않는다.
    // `넘기다` 가 어휘에 없고, 부정형 기능 요청은 `plainImperative` 의 재작성
    // 대상도 아니다. 지어내지는 않는다.
    assert.deepEqual(texts("영상 길이는 5초를 넘기지 않게 해줘."), []);
  });

  test("`-게 해줘` 가 하다를 거치지 않으면 읽지 못한다", () => {
    // `plainImperative` 는 `X하게 해줘`/`X할 수 있게 해줘` 를 되돌리는데,
    // "영상이 나오게 해줘" 의 `나오` 는 하다를 거치지 않는다. 한국어 기능
    // 요청의 흔한 모양이고, 여기서는 아무것도 읽지 못한다.
    assert.deepEqual(texts("사용자가 프롬프트를 입력하면 영상이 나오게 해줘."), []);
  });

  test("결과물에 대한 금지는 어디에도 남지 않는다", () => {
    // 거절은 옳게 읽힌다 — 워터마크를 넣으라는 요구사항은 생기지 않는다.
    // 그리고 사라진다. `statedProhibitions` 가 아는 세 부류는 모두 도구 관문
    // (실행·수정·웹)이고, "워터마크는 넣지 마" 는 그중 어느 것도 아니다 —
    // 결과물에 대한 제약이며, 이 설계기가 겨누는 세 가지 생성형 미디어 주제에서
    // 가장 흔한 제약이다.
    //
    // 여기서 고치지 않는 이유는 금지를 내는 모듈이 둘이 되면 둘이 같은 문장에
    // 대해 반드시 일치해야 하기 때문이다. 손해의 한계: 핸드오프는 사용자의
    // 문장을 그대로 넘기므로 에이전트는 그 말을 여전히 읽는다. 잃는 것은
    // 패널이 무엇을 이해했다고 말하는 내용이다.
    const got = texts("워터마크는 넣지 말고 영상을 만들어줘.");
    assert.deepEqual(got, ["영상을 만든다"]);
    assert.ok(!got.some((t) => t.includes("워터마크")), got.join(", "));
    assert.deepEqual([...prohibitionsIn("워터마크는 넣지 말고 영상을 만들어줘.")], []);
  });

  test("`마무리` 는 행위를 정하지 않는다", () => {
    // "프로젝트를 마무리하고" 는 남은 일을 하라는 말이고, 그 남은 일이 고치는
    // 것인지 돌리는 것인지 만드는 것인지 문장이 말하지 않는다. 행위 부류는
    // 어느 능력이 중요한지를 정하므로(`INTENT_DEMAND`), 하나를 고르는 것은
    // 문장이 하지 않은 주장을 하는 것이다. 이어감은 `relationOf` 의 일이다.
    assert.deepEqual(texts("프로젝트를 마무리하고 완료를 확인해줘."), ["완료를 확인한다"]);
  });

  test("명사를 잇는 `하고` 는 동사 어미와 구별되지 않는다", () => {
    // "좋은 오픈소스 모델하고 HASA 모델도" 의 `하고` 는 접속이고,
    // "전처리하고 학습해줘" 의 `하고` 는 동사 어미다. 둘을 가르려면 앞말이
    // 동사인지 알아야 하는데, 그것이 바로 이 파일이 갖지 못한 것이다. 접속으로
    // 읽으면 두 번째 문장이 `전처리하고를 학습한다` 가 된다.
    assert.deepEqual(texts("좋은 오픈소스 모델하고 HASA 모델도 추가해줘."), [
      "HASA 모델을 추가한다",
    ]);
    const got = texts("전처리하고 학습해줘.");
    assert.ok(!got.some((t) => t.includes("전처리하고")), got.join(", "));
  });

  test("`실제로` 는 목적어가 아니다", () => {
    // It became one: "실제를 살펴본다" named a target the sentence does not have.
    // 대상은 여전히 없다 — `-는지` 는 명사가 아니고, 여기서 재는 것은 `실제` 가
    // 대상이 되지 않는다는 것이다. 달라진 것은 요구사항이 무엇에 대한 것인지를
    // 말할 수 있게 된 것뿐이고, binding 은 그대로 미해결로 남는다.
    const got = texts("실제로 호출되는지도 알려줘.");
    assert.deepEqual(got, ["실제로 호출되는지 살펴본다"]);
    assert.ok(!got.some((t) => t.includes("실제를")), got.join(", "));
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

  test("관계절과 부사구는 영어 목적어의 일부가 아니다", () => {
    // `that`, `which` and the adjunct prepositions were all missing from the
    // stop list, so the target was the rest of the sentence: "a project that
    // turns an uploaded image into a video" instead of the project.
    assert.equal(of("Build a project that turns an image into a video.")[0]?.object, "project");
    assert.equal(of("Generate an image from text.")[0]?.object, "image");
    assert.equal(of("Export the result video as mp4.")[0]?.object, "result video");
  });

  test("간접 목적어와 보어 표지는 목적어에 남지 않는다", () => {
    // "show me the result as a preview" targeted `me the result as a preview`.
    assert.equal(of("Show me the result as a preview.")[0]?.object, "result");
    assert.equal(of("Check for errors in the log.")[0]?.object, "errors");
  });

  test("대상이 대명사뿐이거나 부사구뿐이면 대상은 없다", () => {
    // `it` names nothing this can resolve, and `on the GPU` is where rather than
    // what. Both used to become the target.
    assert.equal(of("Fix the login error and test it.")[1]?.object, "");
    assert.equal(of("Download the model and run it on the GPU.")[1]?.object, "");
  });

  test("영어 `and` 는 두 행위를 잇기도 하고 두 명사를 잇기도 한다", () => {
    // Korean has different connectives for the two; English does not, and what
    // separates them is whether a verb follows. Cutting at every `and` reported
    // half of what the user asked for.
    assert.equal(
      of("Support both image generation and video generation.")[0]?.object,
      "image generation and video generation",
    );
    assert.deepEqual(of("Fix the login error and test it.").map((c) => c.action), [
      "modify",
      "verify",
    ]);
  });

  test("아는 동사의 분사는 목적어의 일부가 아니다", () => {
    // The English half of the rule Korean applies to `생성된 영상`. Restricted to
    // the verbs this file knows, which is what leaves the rest alone.
    assert.equal(of("Save the generated video.")[0]?.object, "video");
    assert.equal(of("Review the refactored module.")[0]?.object, "module");
    assert.equal(of("Fix the broken pipeline.")[0]?.object, "broken pipeline");
    assert.equal(of("Check the advanced settings.")[0]?.object, "advanced settings");
  });

  test("영어 요청에는 영어 문장으로 답한다", () => {
    // An English sentence with no object came back as "테스트를 실행해 결과를
    // 확인한다" — the right reading, in a language the person who typed it may
    // not read.
    assert.deepEqual(texts("Run it."), ["run the requested command"]);
    assert.deepEqual(texts("Fix the login error and test it."), [
      "fix the login error",
      "run the tests and check the result",
    ]);
  });

  test("`let me` 도 요청을 여는 말이다", () => {
    // `let's` was stripped and `let me` was not, so "Let me set the frame count"
    // read as nothing at all.
    assert.equal(of("Let me set the frame count.")[0]?.object, "frame count");
  });

  test("`build a` 는 만드는 것이고 `build` 는 돌리는 것이다", () => {
    // The English `쓰다`: two verbs sharing a spelling, told apart by the
    // article, which is what a reader uses.
    assert.equal(of("Build a tool that generates images.")[0]?.action, "create");
    assert.equal(of("Build the project.")[0]?.action, "execute");
  });

  test("접속사 하나만 남았을 때 그것은 목적어가 아니다", () => {
    // "Train and evaluate the model" 은 **train and** 를 내놓았다 — 접속사
    // 그 자체가, 학습할 대상으로. 붙어 있던 제거 규칙은 앞에 공백이 있을 때만
    // 걸렸고, 목적어가 아예 없을 때는 접속사가 문두에 홀로 선다.
    const got = of("Train and evaluate the model.");
    assert.deepEqual(got.map((c) => c.text), ["train", "evaluate the model"]);
    assert.equal(got[0]?.object, "");
  });

  test("목적어가 없으면 사용자가 쓴 동사로 읽는다", () => {
    // 부류 문구가 그 낱말을 이미 담고 있으면 그대로 두고, 아니면 동사가 이긴다.
    // "Compare it with the previous result" 는 "look at what was asked about"
    // 이었다 — 비교는 살펴봄이 아니고, 문장이 고른 단 하나의 동사가 버려졌다.
    assert.deepEqual(texts("Compare it with the previous result."), ["compare"]);
    assert.deepEqual(texts("Don't run it, just explain."), ["explain"]);
    assert.deepEqual(texts("Run it."), ["run the requested command"]);
  });

  test("`tell` 도 동사이고, 물음은 목적어가 아니다", () => {
    // `tell` 이 목록에 없어서 접속사에서 절이 갈리지 않았고, 목적어는
    // `model list and tell me` 가 되었다.
    assert.deepEqual(texts("Check the model list and tell me which ones are usable."), [
      "check the model list",
      "tell me which ones are usable",
    ]);
    assert.deepEqual(texts("Tell me whether it is actually called."), [
      "tell me whether it is actually called",
    ]);
    assert.equal(of("Show me what changes if I change the prompt.")[0]?.object, "");
  });

  test("한 턴의 두 물음은 두 요청이다", () => {
    // 대상이 둘 다 비어 있으므로, 물음이 열쇠에 들어가지 않으면 하나로 합쳐진다.
    assert.deepEqual(texts("Tell me which model is fastest and tell me why it fails."), [
      "tell me which model is fastest",
      "tell me why it fails",
    ]);
  });

  test("`make it possible to` 는 기능 요청이다", () => {
    // 한국어 `-ㄹ 수 있게 해줘` 의 영어 짝이고, 같은 이유로 아무것도 읽지
    // 못했다: 요청이 말하는 동사가 명령문 자리에서 너무 뒤에 있다.
    assert.deepEqual(texts("Make it possible to set the frame rate and the resolution."), [
      "set the frame rate and the resolution",
    ]);
    // 틀은 `ability|option to` 를 요구하므로 평범한 `add` 요청은 건드리지 않는다.
    assert.deepEqual(texts("Add the login button."), ["add the login button"]);
  });

  test("쉼표로 이어진 목록은 하나의 목적어다", () => {
    // 사용자가 셋을 말했는데 하나만 읽고 있었다. 한국어 쪽에서 쉼표로 잘린
    // 조각을 접어 넣는 규칙의 영어판이고, 방향만 반대다 — 한국어는 목록 뒤에,
    // 영어는 목록 앞에 동사를 둔다.
    assert.deepEqual(texts("Download the dataset, the weights, and the config."), [
      "download the dataset, the weights, and the config",
    ]);
    assert.deepEqual(texts("Generate an image, a video, and a thumbnail."), [
      "generate an image, a video, and a thumbnail",
    ]);
  });

  test("쉼표 뒤에 온 것이 목록이 아니면 목적어가 아니다", () => {
    // 세 가지가 모두 성립해야 목록이다. 하나씩 빼면 아래 문장들이 각각
    // 없는 대상을 만들어낸다.
    //
    //   · 관사로 시작하는 명사구가 아님   → `button, and make it blue`
    //   · 그 안에 계사·조동사가 없음       → `bug, the tests are failing`
    //   · 뒤에 접속사가 아직 남아 있음     → 두 번째 생각을 목록으로 읽음
    assert.deepEqual(texts("Add a button, and make it blue."), ["add a button"]);
    assert.deepEqual(texts("Fix the bug, the tests are failing."), ["fix the bug"]);
    assert.deepEqual(texts("Fix the bug, the tests are failing and the build is red."), [
      "fix the bug",
    ]);
    // 계사도 조동사도 없고 관사로 시작하지만, 뒤에 접속사가 없다 — 목록이
    // 아니라 덧붙인 설명이다. 세 번째 조건이 없으면 이 문장이 대상을
    // `logs, the error appeared yesterday` 로 만든다.
    assert.deepEqual(texts("Check the logs, the error appeared yesterday."), [
      "check the logs",
    ]);
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

/**
 * 영어 목적어를 끊는 말들.
 *
 * 같은 세 주제를 영어로 다시 물었을 때 나온 여섯 문장. 모두 문장에 없는 대상을
 * 만들어내고 있었고, `without` 은 `with` 에서 닿을 수 없었다 — `within` 을 막는
 * 낱말 경계가 `without` 도 막는다.
 */
describe("영어 부가어는 목적어를 끊는다", () => {
  const CASES: ReadonlyArray<[string, string]> = [
    ["Show me the plan without editing anything.", "plan"],
    ["Run the tests unless they are slow.", "tests"],
    ["Fix the bug except for the test file.", "bug"],
    ["Generate an image if the prompt is valid.", "image"],
    ["Export the video only for the demo.", "video"],
    ["Add a button between the two panels.", "button"],
    ["Read the file within the folder.", "file"],
    ["Run the tests against the staging environment.", "tests"],
  ];
  for (const [text, object] of CASES) {
    test(text, () => {
      assert.equal(of(text)[0]?.object, object);
    });
  }

  test("동사의 보어를 여는 말은 여전히 목적어의 일부다", () => {
    // `for`, `of`, `about` 은 목록 밖에 있다 — "check for errors" 는 오류에
    // 대한 요청이다.
    assert.equal(of("Check for errors in the log.")[0]?.object, "errors");
  });

  test("`only` 는 관사 뒤에서는 목적어의 일부다", () => {
    // 앞에 공백을 요구하므로, 관사가 떨어져 나간 뒤 문두에 선 `only` 는
    // 아무것도 끊지 않는다.
    assert.equal(of("Fix the only file that fails.")[0]?.object, "only file");
  });
});
