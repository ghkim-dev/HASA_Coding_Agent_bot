import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { forEachSeed, type Rng } from "../testing/fuzz.ts";
import { functionalCandidates } from "./functionalExtract.ts";
import { prohibitionsIn } from "../agent/statedProhibitions.ts";

/**
 * The extractor, over generated requests.
 *
 * `extractInvariants.test.ts` checks the same promises against 117 real turns.
 * That is the stronger evidence about sentences people actually write and the
 * weaker evidence about the space of sentences: every one of those turns was
 * written by somebody who had a request in mind, so none of them is a
 * prohibition glued to its own positive form, a noun that happens to end in a
 * connective sitting in front of a verb, or a clause chain seven long. Those are
 * the shapes where a rule about particles meets a rule about boundaries, and the
 * two rules were written years apart in different sentences.
 *
 * What is generated is Korean the extractor might actually see: the verbs it
 * knows, plausible targets, the particles and connectives that bind them, and
 * the prohibition forms it must never turn into requests. Random bytes are in
 * the noise pass only — a parser that survives line noise has proved nothing
 * about the sentence that breaks it.
 *
 * ## What this adds over the corpus, measured rather than assumed
 *
 * Less than it looks, and the honest account is worth having. Five deliberate
 * breaks were applied to `functionalExtract.ts` and scored against both files:
 * the corpus caught every one, and caught two — a truncated source span, a
 * dropped final clause — that this file did not. Generated Korean is regular in
 * ways real requests are not, and regularity is what hides a bug.
 *
 * What it does add is threefold and none of it is coverage of Korean:
 *
 *   · Input the corpus cannot contain. 4000 characters, lone surrogates, a
 *     request that is one question mark. Only the "does not throw" property.
 *   · Determinism, over inputs nobody chose.
 *   · The collision shape — a prohibition and a positive clause of the same
 *     class in one turn. That is what showed the *corpus* was asserting
 *     something too strong: it forbade the pair outright, which is wrong, since
 *     "수정하지 말고 추가해줘" is an ordinary sentence. Both files now check the
 *     narrower thing, and the fix came from the generator.
 *
 * The last property leans on `statedProhibitions` to tell a forbidding clause
 * from an ordinary one, so it goes quiet on a form *both* modules miss. That
 * blind spot is why `statedProhibitions.fuzz.test.ts` exists and generates its
 * own answer key instead of borrowing one — and it found sixteen such forms.
 */

const TARGETS = [
  "로그인 오류", "main.py 코드", "auth 폴더", "결제 모듈", "응답 형식",
  "CNN", "Transformer", "ViT", "분류기", "학습 결과", "설정 파일",
  "통합 테스트", "API 호환성", "의존성", "문서", "명세서", "순서", "속도",
];

/** Noun-verb stems, one per class the negation guard has to cover. */
const VERBS = ["수정", "삭제", "추가", "실행", "학습", "테스트", "확인", "분석", "비교", "유지"];

/**
 * How a clause ends, which is also how it joins the next one.
 *
 * Built as endings rather than as a stem plus a separate connective, because
 * gluing "하고" onto "해줘" produces "해줘하고" — not Korean, and a corpus of
 * non-Korean measures the extractor against sentences nobody types. Every form
 * here is one a person writes.
 */
const ENDING = ["해줘. ", "해주세요. ", "하고 ", "해주고 ", "하면서 ", "해줘, "];
const ADVERB = ["다시 ", "먼저 ", "반드시 ", "이번에 ", "제대로 ", ""];
/** Case marking, or a locative/range. Never both — "안에서만는" is not a word. */
const CASE = ["를 ", "을 ", "도 ", "만 ", "는 "];
const PLACE = [" 안에서만 ", "에서 ", "까지 ", "부터 "];

/** `와` after a vowel, `과` after a consonant. The same rule as 을/를. */
function joiner(word: string): string {
  const last = word.codePointAt(word.length - 1) ?? 0;
  if (last >= 0xac00 && last <= 0xd7a3) return (last - 0xac00) % 28 === 0 ? "와 " : "과 ";
  return /[lmn]/i.test(word.slice(-1)) ? "과 " : "와 ";
}

function target(rng: Rng): string {
  const head = rng.pick(TARGETS);
  // A coordinated list a third of the time, because that is the shape the
  // two-token window used to cut in half.
  if (rng.bool(0.33)) {
    const first = rng.pick(TARGETS);
    return `${first}${rng.bool(0.2) ? "랑 " : joiner(first)}${head}`;
  }
  return head;
}

function clause(rng: Rng): string {
  const stem = rng.pick(VERBS);
  const object = `${target(rng)}${rng.bool(0.75) ? rng.pick(CASE) : rng.pick(PLACE)}`;
  const adverb = rng.pick(ADVERB);
  // One clause in four is a prohibition, in one of the forms the runtime reads.
  if (rng.bool(0.25)) {
    const form = rng.pick(["지 마. ", "지 말고 ", "지 말아줘. ", "면 안 돼. ", "지는 마세요. "]);
    return `${object}${adverb}${stem}하${form}`;
  }
  return `${object}${adverb}${stem}${rng.pick(ENDING)}`;
}

function request(rng: Rng): string {
  let out = "";
  for (let i = 0; i < rng.int(1, 4); i += 1) out += clause(rng);
  return out.trim();
}

/** Anything at all, for the "does not throw" property only. */
function noise(rng: Rng): string {
  return rng.string(rng.int(0, 200));
}

describe("추출기, 생성된 요청에 대해", () => {
  test("어떤 입력에도 던지지 않는다", () => {
    forEachSeed((rng, seed) => {
      for (const text of [request(rng), noise(rng), rng.string(4000)]) {
        assert.doesNotThrow(() => functionalCandidates({ turnId: "t1", text }), `seed ${seed}`);
      }
    });
  });

  test("목적어의 모든 낱말은 입력에 있던 낱말이다", () => {
    // The promise the module's header makes, over a space no corpus covers.
    forEachSeed((rng, seed) => {
      const text = request(rng);
      for (const candidate of functionalCandidates({ turnId: "t1", text })) {
        for (const word of candidate.object.split(/\s+/)) {
          if (word.length === 0) continue;
          assert.ok(
            text.includes(word),
            `seed ${seed}: "${word}" 는 입력에 없습니다\n  입력: ${text}\n  결과: ${candidate.text}`,
          );
        }
      }
    });
  });

  test("근거 구간은 목적어를 담고 있다", () => {
    forEachSeed((rng, seed) => {
      const text = request(rng);
      for (const candidate of functionalCandidates({ turnId: "t1", text })) {
        if (candidate.object.length === 0) continue;
        const quoted = text.slice(candidate.span.start, candidate.span.end);
        for (const word of candidate.object.split(/\s+/)) {
          assert.ok(
            quoted.includes(word),
            `seed ${seed}: 근거 "${quoted}" 에 "${word}" 가 없습니다\n  입력: ${text}`,
          );
        }
      }
    });
  });

  test("두 번 읽어도 같은 것을 읽는다", () => {
    forEachSeed((rng, seed) => {
      const text = request(rng);
      assert.deepEqual(
        functionalCandidates({ turnId: "t1", text }),
        functionalCandidates({ turnId: "t1", text }),
        `seed ${seed}: ${text}`,
      );
    });
  });

  test("금지하는 절에서 그 동작을 요구사항으로 만들지 않는다", () => {
    // The one worth the generator, and it is narrower than it first looked.
    //
    // The obvious property — "if the turn forbids modifying, no modify
    // requirement anywhere in it" — is wrong, and the generator is what proved
    // it. "수정하지 말고 추가해줘" forbids one thing and asks for another, and
    // both are what the user said; a turn that contains a prohibition and a
    // positive clause about a different target is not a contradiction the
    // extractor invented. The corpus version of this check asserted the wrong
    // thing too and passed for four commits, because real sentences that forbid
    // something rarely ask for the same class in the same breath.
    //
    // What must never happen is narrower and is entirely the extractor's doing:
    // the clause a requirement is drawn from must not be the clause that forbids
    // it. That is checked through the span rather than through the turn, so it
    // exercises the clause splitter and `NEGATED` together — which is where the
    // real regression lived, the one where 수정하진 마 produced 수정한다.
    forEachSeed((rng, seed) => {
      const text = request(rng);
      for (const candidate of functionalCandidates({ turnId: "t1", text })) {
        const clause = text.slice(candidate.span.start, candidate.span.end);
        const forbidden = new Set<string>([...prohibitionsIn(clause)]);
        const clashes =
          (forbidden.has("execute") && candidate.action === "execute") ||
          (forbidden.has("modify") &&
            (candidate.action === "modify" ||
              candidate.action === "create" ||
              candidate.action === "remove"));
        assert.ok(
          !clashes,
          `seed ${seed}: 금지하는 절에서 ${candidate.action} 를 읽었습니다\n` +
            `  입력: ${text}\n  절: ${clause}\n  결과: ${candidate.text}`,
        );
      }
    });
  });
});
