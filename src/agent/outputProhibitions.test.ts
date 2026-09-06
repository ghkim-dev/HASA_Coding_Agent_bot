import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  outputProhibitionText,
  outputProhibitionsIn,
  topicParticle,
} from "./outputProhibitions.ts";
import { prohibitionsIn } from "./statedProhibitions.ts";

/**
 * 이 모듈이 존재하는 이유를 그대로 재는 테스트.
 *
 * 두 방향이 다 필요하다. 읽어야 할 것을 읽는지, 그리고 **읽지 말아야 할 것을
 * 읽지 않는지**. 두 번째가 없으면 "모든 문장에서 금지를 하나씩 만들어 내는"
 * 판독기도 첫 번째를 전부 통과한다 — 실제로 첫 판이 그랬고, 골드 말뭉치의
 * holdout 6건과 precision 스위트가 그것을 잡았다.
 */

const SUBJECTS = (text: string): string[] => outputProhibitionsIn(text).map((p) => p.subject);

describe("결과물에 대한 금지를 읽는다", () => {
  test("주격 조사 뒤에 처소격이 오는 형태 — 이 모듈이 쓰인 문장", () => {
    const text = "후보 솔루션을 비교해 주세요. 다만 특정 벤더의 제품명은 결론에 넣지 말아 주세요.";
    const found = outputProhibitionsIn(text);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.subject, "특정 벤더의 제품명");
    assert.equal(found[0]?.place, "결론");
  });

  test("처소격이 없으면 없는 대로 읽는다", () => {
    const found = outputProhibitionsIn("가격 정보는 포함하지 마세요.");
    assert.equal(found.length, 1);
    assert.equal(found[0]?.subject, "가격 정보");
    assert.equal(found[0]?.place, null);
  });

  test("처소격이 주어 앞에 오는 형태", () => {
    const found = outputProhibitionsIn("결론에 벤더 제품명 넣지 마세요.");
    assert.equal(found[0]?.subject, "벤더 제품명");
    assert.equal(found[0]?.place, "결론");
  });

  test("부정어 없는 제거형은 산출물을 가리킬 때만 읽는다", () => {
    const found = outputProhibitionsIn("경쟁사 이름은 결론에서 빼 주세요.");
    assert.equal(found[0]?.subject, "경쟁사 이름");
    assert.equal(found[0]?.place, "결론");
  });

  /**
   * `-고` 로 이어붙인 제거형. 산출물이 동사 **뒤쪽**에 있다.
   *
   * 처음에는 포기했던 형태다. 스무 글자를 훑어 명사를 찾는 방식이었고, 그런
   * 창은 다른 뜻의 문장에서도 결국 명사를 찾아낸다. `-고` 가 잇는 나머지
   * 문장으로 경계를 바꾸면서 되살렸다.
   */
  test("빼고 뒤에 산출물이 오면 읽는다", () => {
    const found = outputProhibitionsIn("벤더 이름은 빼고 보고서를 정리해 주세요.");
    assert.equal(found.length, 1);
    assert.equal(found[0]?.subject, "벤더 이름");
    assert.equal(found[0]?.place, "보고서");
  });

  test("빼고 뒤에 산출물이 없으면 읽지 않는다", () => {
    // 이 조건이 없으면 "테스트는 빼고 빌드만 해줘" 가 결과물 금지가 된다.
    assert.deepEqual(SUBJECTS("테스트는 빼고 빌드만 해줘."), []);
    assert.deepEqual(SUBJECTS("이 파일은 빼고 커밋해줘."), []);
  });

  test("다음 문장의 산출물은 세지 않는다", () => {
    // 경계가 절이 아니라 문장인 이유. 마침표 뒤의 보고서는 다른 생각이다.
    assert.deepEqual(SUBJECTS("테스트는 빼고 빌드해줘. 보고서는 나중에."), []);
  });

  test("근거는 문단이 아니라 그 절이다", () => {
    const text = "후보 솔루션을 비교해 주세요. 다만 특정 벤더의 제품명은 결론에 넣지 말아 주세요.";
    const found = outputProhibitionsIn(text);
    const quoted = text.slice(found[0]?.start ?? 0, found[0]?.end ?? 0).trim();
    assert.equal(quoted, "특정 벤더의 제품명은 결론에 넣지 말아 주세요.");
  });

  /**
   * 처소격 자체가 조사를 달고 있는 형태.
   *
   * "결론에**는**" 의 `는` 은 주격 조사 패턴에 그대로 걸린다. 절 끝에서
   * 처소격을 먼저 떼어내지 않으면 그것이 마지막 조사가 되어 주어가
   * "특정 벤더의 제품명은 결론에" 까지 늘어난다. 처소격을 안 떼는 변이가
   * 물지 않아서 추가했다 — `에` 로 끝나는 사례만으로는 구별이 안 된다.
   */
  test("처소격이 조사를 달고 있어도 주어를 침범하지 않는다", () => {
    const found = outputProhibitionsIn("특정 벤더의 제품명은 결론에는 넣지 마세요.");
    assert.equal(found[0]?.subject, "특정 벤더의 제품명");
    assert.equal(found[0]?.place, "결론");
  });

  /**
   * 한 절에 조사가 둘일 때 금지가 붙는 쪽은 마지막이다.
   *
   * 첫 조사를 쓰는 변이가 물지 않아서 추가했다. 조사가 하나뿐인 사례만으로는
   * 첫째와 마지막이 같은 것이라 구별할 수 없다.
   */
  test("조사가 둘이면 뒤엣것에 금지가 붙는다", () => {
    const found = outputProhibitionsIn("분량은 짧게 하고 벤더 이름은 결론에 넣지 마세요.");
    assert.equal(found[0]?.subject, "분량은 짧게 하고 벤더 이름");
    assert.ok(!found[0]!.subject.startsWith("분량은 짧게 하고 벤더 이름은"));
  });

  test("영어는 동사 뒤를 읽고 전치사구는 뗀다", () => {
    const found = outputProhibitionsIn("Compare the vendors but don't include pricing in the summary.");
    assert.equal(found.length, 1);
    assert.equal(found[0]?.subject, "pricing");
  });

  test("한 문장에 두 개면 두 개다", () => {
    const found = SUBJECTS("가격 정보는 포함하지 마세요. 그리고 추측은 쓰지 말아 주세요.");
    assert.deepEqual(found, ["가격 정보", "추측"]);
  });
});

describe("읽지 말아야 할 것을 읽지 않는다", () => {
  /**
   * 첫 판이 물었던 문장. `삭제해`를 제거 동사로 넣었더니 평범한 작업 요청이
   * 결과물 금지가 됐고, holdout `h-parallel-three-targets` 를 비롯해 6건이
   * 깨졌다. 여기 남겨 두는 이유는 그 회귀가 다시 들어오면 이 줄이 먼저 울기
   * 때문이다.
   */
  test("삭제 요청은 결과물 금지가 아니다", () => {
    assert.deepEqual(SUBJECTS("라우터를 수정하고 미들웨어를 추가하고 낡은 핸들러를 삭제해줘."), []);
  });

  test("장소를 말했는데 산출물이 아니면 읽지 않는다", () => {
    // 파일에 쓰지 말라는 것은 도구 관문이 결정할 일이고, 답변에 대한 제약이
    // 아니다. 이것을 읽으면 `secret-storage` fixture 가 없는 금지를 갖게 된다.
    assert.deepEqual(SUBJECTS("API Key는 SecretStorage에만 저장하고 설정 파일에는 쓰지 마."), []);
    assert.deepEqual(SUBJECTS("이 값은 DB에 넣지 마세요."), []);
  });

  test("장소를 말하지 않은 것은 파일로 치지 않는다", () => {
    // 위 규칙의 반대쪽. 침묵을 "파일"로 읽으면 이 모듈이 노리는 가장 흔한
    // 형태가 통째로 사라진다.
    assert.deepEqual(SUBJECTS("추측은 쓰지 말아 주세요."), ["추측"]);
  });

  test("금지가 아닌 문장에서는 아무것도 나오지 않는다", () => {
    for (const text of [
      "로그인 오류를 고쳐줘",
      "빼먹지 말고 전부 확인해줘",
      "테스트를 실행하지 말고 코드만 보여줘",
      "파일을 수정하지 마세요",
      "",
    ]) {
      assert.deepEqual(SUBJECTS(text), [], text);
    }
  });

  test("행위 금지가 이미 가져간 문장은 다시 읽지 않는다", () => {
    const text = "웹 검색은 쓰지 마세요.";
    // 이 문장은 research 금지다. 두 판독기가 다 읽으면 계획에 같은 금지가
    // 두 번 선다.
    assert.deepEqual([...prohibitionsIn(text)], ["research"]);
    assert.deepEqual(SUBJECTS(text), ["웹 검색"], "관문이 안 가져가면 이쪽이 읽는다");
    assert.deepEqual(
      SUBJECTS(text).length > 0 ? outputProhibitionsIn(text, [{ start: 0, end: text.length }]) : [],
      [],
      "관문이 가져간 범위는 건너뛴다",
    );
  });
});

describe("사용자의 말로 문장을 만든다", () => {
  test("조사는 받침으로 고른다", () => {
    assert.equal(topicParticle("제품명"), "은");
    assert.equal(topicParticle("정보"), "는");
    assert.equal(topicParticle("이름"), "은");
    assert.equal(topicParticle("pricing"), "은");
  });

  test("말하지 않은 장소를 지어내지 않는다", () => {
    assert.equal(outputProhibitionText("가격 정보", null), "가격 정보는 넣지 않는다");
    assert.equal(
      outputProhibitionText("특정 벤더의 제품명", "결론"),
      "특정 벤더의 제품명은 결론에 넣지 않는다",
    );
  });
});
