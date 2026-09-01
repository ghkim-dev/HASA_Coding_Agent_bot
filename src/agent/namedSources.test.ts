import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { namedSourcesIn } from "./sourceProvenance.ts";
import { runtimeRequirements } from "../design/requirementSpec.ts";

/**
 * A service the user named without linking it.
 *
 * `sourceProvenance.ts` opens with the failure this closes, and quotes it:
 *
 *     User:  "Hugging Face와 open.hasa.re.kr에서 활용할 수 있는 모델도 찾아서 사용해줘."
 *     Agent: [search] → results from huggingface.co
 *            → "HASA에서 활용할 수 있는 모델은 다음과 같습니다: …"
 *
 * Two sources in one sentence, one written as a link and one as a name, and only
 * the link was ever held. The gate that catches the misattribution keys on a
 * hostname and never needed a URL, so the named half was missing for no reason
 * except that nobody had written it.
 *
 * ## Both conditions, and why
 *
 * A name is a source when the sentence **points at it** and **asks to look**.
 * Either alone reads a mention as an instruction — and the cost of that is not
 * symmetric with missing one. A missed name raises no requirement, which is the
 * state this replaced; an over-read name holds the agent to fetching a page for
 * a sentence that was only reminiscing.
 */

const names = (text: string): string[] => namedSourcesIn(text).map((s) => s.name ?? s.hostname);

describe("이름으로 부른 출처", () => {
  test("가리키면서 찾아달라고 하면 출처다", () => {
    assert.deepEqual(names("Hugging Face에서 모델을 찾아줘."), ["Hugging Face"]);
    assert.deepEqual(names("허깅페이스의 최신 모델을 확인해줘."), ["Hugging Face"]);
    assert.deepEqual(names("Hugging Face도 참고해줘."), ["Hugging Face"]);
    assert.deepEqual(names("Find a model on Hugging Face."), ["Hugging Face"]);
    assert.deepEqual(names("Download it from Kaggle."), ["Kaggle"]);
  });

  test("목록 안에 있어도 가리킨 것이다", () => {
    // "웹과 Hugging Face, HASA도 참고하고" — plainly asking to consult it, and
    // refused for a comma until the marker set and the verb requirement were
    // decided together.
    assert.deepEqual(
      names("웹과 Hugging Face, HASA도 참고하고, 결과를 비교해줘."),
      ["Hugging Face"],
    );
  });

  test("가리키기만 하고 찾아달라고 하지 않으면 출처가 아니다", () => {
    // A marker with no request. Both of these carry one of the markers the
    // pointing test accepts.
    assert.deepEqual(names("Hugging Face와 비슷한 걸 만들어줘."), []);
    assert.deepEqual(names("Hugging Face도 좋아."), []);
  });

  test("찾아달라고만 하고 가리키지 않으면 출처가 아니다", () => {
    // The verb is there and the name is not being pointed at.
    assert.deepEqual(names("이건 Hugging Face 방식이랑 비슷한지 확인해줘."), []);
    assert.deepEqual(names("GitHub Actions 설정을 찾아서 고쳐줘."), []);
  });

  test("요구사항은 사용자가 쓴 이름을 그대로 인용한다", () => {
    // `huggingface.co` is what the runtime resolved it to; `Hugging Face` is
    // what they typed, and the requirement is shown to them.
    const specs = runtimeRequirements({ turnId: "t1", text: "Hugging Face에서 모델을 찾아줘." });
    const source = specs.find((s) => s.derivedBy === "runtime_source");
    assert.ok(source !== undefined, JSON.stringify(specs.map((s) => s.text)));
    assert.match(source.text, /Hugging Face/);
    assert.doesNotMatch(source.text, /huggingface\.co/);
  });

  test("링크와 이름이 한 문장에 있으면 둘 다 잡는다", () => {
    // The sentence the whole mechanism was written for.
    const text = "Hugging Face와 https://open.hasa.re.kr/models 에서 각각 쓸 수 있는 모델을 찾아줘.";
    const sources = runtimeRequirements({ turnId: "t1", text }).filter(
      (s) => s.derivedBy === "runtime_source",
    );
    assert.equal(sources.length, 2, JSON.stringify(sources.map((s) => s.text)));
    assert.ok(sources.some((s) => s.text.includes("Hugging Face")));
    assert.ok(sources.some((s) => s.text.includes("open.hasa.re.kr")));
  });
});
