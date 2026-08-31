import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { forEachSeed, type Rng } from "../testing/fuzz.ts";
import { prohibitionsIn } from "./statedProhibitions.ts";
import { functionalCandidates } from "../design/functionalExtract.ts";

/**
 * Prohibitions the generator built, read back by the runtime.
 *
 * The generator is the answer key. Every sentence here is a prohibition by
 * construction — it was assembled out of a forbidden act and a negation — so
 * "did the runtime read it" needs no annotation and no judgement, which is what
 * lets it cover a hundred forms instead of the dozen anybody thought to write
 * down.
 *
 * ## What this found on its first run
 *
 * Sixteen. Korean marks contrast and addition on the negated verb — 수정하지**는**
 * 마세요, 실행하지**도** 마, 수정하지**를** 마 — and `statedProhibitions` read
 * none of them, because its stem was `하[지진]` with only whitespace allowed
 * before the negation. `functionalExtract` read all of them, because its
 * `NEGATED` allows the particle.
 *
 * That asymmetry is the worst possible direction. The extractor suppressed the
 * request, so nothing appeared to be wrong: no invented requirement, no visible
 * defect. And the tool gate asks *this* module, so a user who wrote
 * "수정하지는 마세요" — the politest form available — had their ban recorded
 * nowhere and the model was free to write files.
 *
 * ## Why the two modules are checked against each other
 *
 * They read the same words for different purposes: one decides what was asked,
 * the other decides what is refused. Whenever they disagree the runtime is
 * incoherent, and the disagreement that matters is exactly the one above — the
 * request suppressed while the prohibition goes unrecorded. A hand-written test
 * catches that only for the form somebody happened to type.
 */

const TARGETS = ["설정 파일", "main.py", "로그인 오류", "auth 폴더", "테스트", "결제 모듈"];
const CASE = ["을 ", "를 ", "은 ", "는 ", "도 ", "만 ", " "];

/** The two classes the tool gate acts on, with the stems that name each. */
const ACTS = [
  { klass: "execute", stems: ["실행", "구동"] },
  { klass: "modify", stems: ["수정", "변경"] },
] as const;

/**
 * Negation forms, as a Korean speaker writes them.
 *
 * The particle slot between `하지` and the negation is the point: it is where
 * contrast and addition are marked, it is where the sixteen missed forms lived,
 * and it is the part a hand-written list is least likely to enumerate.
 */
const PARTICLE = ["", "는", "도", "를", "은"];
const CLOSER = ["마", "마세요", "마요", "말아줘", "말아 주세요", "말고", "말 것"];

function prohibition(rng: Rng): { text: string; klass: "execute" | "modify" } {
  const act = rng.pick(ACTS);
  const stem = rng.pick(act.stems);
  const object = `${rng.pick(TARGETS)}${rng.pick(CASE)}`;
  const body =
    rng.bool(0.2)
      ? // The other shape: the negation lands after the verb ending.
        `${stem}하${rng.pick(["면", "서는"])} 안 ${rng.pick(["돼", "된다", "됩니다"])}`
      : `${stem}하${rng.bool(0.15) ? "진" : "지"}${rng.pick(PARTICLE)} ${rng.pick(CLOSER)}`;
  return { text: `${object}${body}.`, klass: act.klass };
}

describe("금지, 생성된 문장에 대해", () => {
  test("생성된 금지는 모두 읽힌다", () => {
    // The generator knows what it built, so this needs no answer key. A form the
    // runtime cannot read is a ban the tool gate never hears about.
    forEachSeed((rng, seed) => {
      const { text, klass } = prohibition(rng);
      const got = new Set<string>([...prohibitionsIn(text)]);
      assert.ok(
        got.has(klass),
        `seed ${seed}: "${text}" 는 ${klass} 금지인데 읽힌 것은 [${[...got].join(",")}]`,
      );
    });
  });

  test("금지문에서 그 동작을 요구사항으로 만들지 않는다", () => {
    // The other module, on the same sentence. Both must refuse it.
    forEachSeed((rng, seed) => {
      const { text, klass } = prohibition(rng);
      for (const candidate of functionalCandidates({ turnId: "t1", text })) {
        const clashes =
          (klass === "execute" && candidate.action === "execute") ||
          (klass === "modify" &&
            (candidate.action === "modify" ||
              candidate.action === "create" ||
              candidate.action === "remove"));
        assert.ok(!clashes, `seed ${seed}: "${text}" 에서 ${candidate.text}`);
      }
    });
  });

  test("두 모듈이 같은 문장에 대해 어긋나지 않는다", () => {
    // The invariant the sixteen missed forms broke, stated directly: a sentence
    // whose act the extractor refuses to read must be a sentence whose
    // prohibition the gate can see. Silence on both sides is the failure — it
    // looks like nothing happened, and it means the ban went unrecorded.
    forEachSeed((rng, seed) => {
      const { text, klass } = prohibition(rng);
      const readByGate = new Set<string>([...prohibitionsIn(text)]).has(klass);
      const positive = functionalCandidates({ turnId: "t1", text }).length > 0;
      assert.ok(
        readByGate || positive,
        `seed ${seed}: "${text}" 를 두 모듈 다 읽지 못했습니다 — 요청도 아니고 금지도 아닌 문장이 되었습니다`,
      );
    });
  });

  test("의문형은 금지가 아니다", () => {
    // The direction that must not fail. This module can only hurt by a false
    // positive, and "실행하면 안 돼?" is a person asking permission.
    forEachSeed((rng, seed) => {
      const { text } = prohibition(rng);
      const asked = `${text.replace(/\.$/, "")}?`;
      // Only the `면 안 돼` family carries the interrogative guard; the `마` forms
      // are imperative and stay prohibitions however they are punctuated.
      if (!/(?:면|서는)\s*안/.test(asked)) return;
      assert.deepEqual([...prohibitionsIn(asked)], [], `seed ${seed}: ${asked}`);
    });
  });
});
