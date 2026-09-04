import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { designHarness } from "./harnessDesign.ts";
import type { DerivedBy } from "./requirementSpec.ts";
import { SCENARIOS } from "../eval/scenarios.ts";

/**
 * The designer, scored on project-scale requests.
 *
 * The corpora it had until now — `goldCases` and `holdoutCases` — are short
 * coding chores, because they were written for the coding agent. The designer
 * invites a different kind of sentence: "CNN부터 Transformer까지 쓰고, 학습과
 * 추론을 하고, 결과를 비교해줘". Measured only on the short ones, it looked
 * finished; measured on these, it read nothing at all from five of twenty-four
 * turns and named less than a third of what the user named.
 *
 * The answers here are not new. `src/eval/scenarios.ts` has carried a
 * hand-written keyword list per turn since the evaluator was built, and nothing
 * in the extractor was ever fitted to them — which makes them a holdout in
 * every sense that matters, without a line of new annotation.
 *
 * ## What each number means
 *
 * `turnsRead` is coverage: did the design produce any requirement of the user's
 * own. `keywordHit` is fidelity: of the things the user *named*, how many
 * survive into the requirement text a person reads. The second is the harder
 * one and the one that matters for this product — a design that says
 * "분류기를 추가한다" for a request naming CNN, ViT, 학습, 추론 and 비교 has
 * read the sentence and lost the request.
 *
 * The numbers are pinned rather than bounded. A drop is a regression and a rise
 * is a result; both should be a decision someone makes, not a threshold that
 * absorbs either quietly.
 *
 * ## Why the same run is scored twice
 *
 * A pinned aggregate can only say that a number moved. `43/47` names neither
 * the turn that dropped a word nor the word, and it cannot see a trade: one
 * keyword starting to survive while another quietly stops leaves 43 standing.
 * So the same precomputed run is also asserted turn by turn, and each word that
 * does not survive is asserted under its own name. The aggregates stay above
 * the split, because they are what fails when the *corpus* loses a case — the
 * one thing no per-case test can notice.
 *
 * ## Why the corpus is built without throwing
 *
 * `node --test` treats a `before()` that throws as a cancellation of everything
 * under it: the tests are reported **cancelled**, and the summary line prints
 * `fail 0`. That is measured, not feared — one broken hook in a sibling file
 * took 148 tests out of the run while the summary said nothing had failed. The
 * whole point of splitting this corpus case by case is that a loss arrives with
 * a name on it, and a hook that throws takes every name away at once and calls
 * the result green.
 *
 * So the build records its failure instead of raising it, the first test below
 * asserts that it did not fail, and every per-case test then reads an empty map
 * and fails under its own name. Cancelled 0, failed N — N failures that each
 * say which sentence, rather than a summary that lies about a run that never
 * happened.
 */

interface Score {
  turnsWithAnswers: number;
  turnsRead: number;
  keywordHit: number;
  keywordTotal: number;
  unread: string[];
}

/** One annotated turn's result, kept whole so no test measures it a second time. */
interface TurnOutcome {
  id: string;
  user: string;
  /** Requirements the design stated of the user's own, not the ones it added. */
  statedCount: number;
  /** Their text, joined and lowercased — the only thing a keyword is scored against. */
  shown: string;
  /**
   * The same requirements as separate lines, each with the layer that wrote it.
   *
   * `shown` is these joined, which is how a keyword can be credited to a line
   * nobody reads as the request: the source-hygiene sentence the runtime emits
   * for every named source is `stated` too, so its words are scored like any
   * other. Kept apart so a test can say *which* line carried the word — see
   * "what the numbers cannot see" at the bottom of this file.
   */
  stated: Array<{ text: string; derivedBy: DerivedBy }>;
  /** The scenario's own keyword list for this turn, in its order. `hit` and `missed` partition it. */
  wanted: string[];
  hit: string[];
  missed: string[];
}

/** Zeroed rather than undefined, so a build that fails reports 0 ≠ 24 and not a TypeError. */
let score: Score = { turnsWithAnswers: 0, turnsRead: 0, keywordHit: 0, keywordTotal: 0, unread: [] };
const outcomes = new Map<string, TurnOutcome>();
/** Whatever building the corpus threw, held for the first test to name. See the header. */
let buildError: unknown = null;

before(async () => {
  try {
    await buildCorpus();
  } catch (err) {
    // Recorded, never rethrown: a `before()` that throws cancels every test
    // under it and still prints `fail 0`.
    buildError = err;
  }
});

async function buildCorpus(): Promise<void> {
  let turnsWithAnswers = 0;
  let turnsRead = 0;
  let keywordHit = 0;
  let keywordTotal = 0;
  const unread: string[] = [];

  for (const scenario of SCENARIOS) {
    for (const [index, turn] of scenario.turns.entries()) {
      const wanted = turn.requirements ?? [];
      if (wanted.length === 0) continue;
      turnsWithAnswers += 1;
      const id = `${scenario.id}#${index + 1}`;

      const design = await designHarness({ text: turn.user });
      const stated = design.requirements.filter((r) => r.status !== "system_added");
      if (stated.length > 0) turnsRead += 1;
      else unread.push(id);

      // What the design has to show for the request, in the words a person
      // reads. A keyword counts when it survives into that text — not when it
      // merely appeared in the input.
      const shown = stated.map((r) => r.text).join(" ").toLowerCase();
      const hit: string[] = [];
      const missed: string[] = [];
      for (const keyword of wanted) {
        keywordTotal += 1;
        if (shown.includes(keyword.toLowerCase())) {
          keywordHit += 1;
          hit.push(keyword);
        } else {
          missed.push(keyword);
        }
      }

      // The corpus is designed once, here. Every per-turn test below reads this
      // map; designing a turn again inside a test would be a second run, and
      // two runs of the same input cannot disagree without one being unexplained.
      outcomes.set(id, {
        id,
        user: turn.user,
        statedCount: stated.length,
        shown,
        stated: stated.map((r) => ({ text: r.text, derivedBy: r.derivedBy })),
        wanted,
        hit,
        missed,
      });
    }
  }

  score = { turnsWithAnswers, turnsRead, keywordHit, keywordTotal, unread };
}

/** The precomputed outcome, or a failure that names the turn that went missing. */
function outcome(id: string): TurnOutcome {
  const found = outcomes.get(id);
  if (!found) throw new Error(`${id} is not in the corpus — the turn moved or lost its answers`);
  return found;
}

describe("the designer on project-scale requests", () => {
  test("the corpus was built at all", () => {
    // First, and the only test that can tell "the designer changed" from "the
    // corpus never ran". Everything else here reads the map the build fills;
    // without this line a build failure arrives as a pile of unrelated
    // failures with nothing saying why — and before the build stopped
    // throwing, as no failures at all.
    assert.equal(
      buildError,
      null,
      `말뭉치를 만들지 못했습니다: ${buildError instanceof Error ? buildError.stack : String(buildError)}`,
    );
    assert.ok(outcomes.size > 0, "말뭉치가 비어 있다 — 주석된 턴을 하나도 만들지 못했다");
  });

  test("the corpus is the evaluator's, and it is not small", () => {
    // Guards the denominator itself. A scenario file that loses its answers
    // would make every number below improve for the wrong reason.
    assert.equal(score.turnsWithAnswers, 24);
    assert.equal(score.keywordTotal, 47);
  });

  test("every annotated turn produces at least one requirement", () => {
    // Was 19/24. The five it read nothing from were "CNN과 ViT로 분류기를
    // 만들고 각각 학습해줘", "torch와 torchvision을 설치해줘" and their kin —
    // ordinary project requests built from verbs the list had never needed
    // while it grew around editing a repository.
    assert.deepEqual(score.unread, []);
    assert.equal(score.turnsRead, 24);
  });

  test("keyword fidelity 43/47", () => {
    // 14 → 22 → 35 → 37 → 40 → 41 → 42 → 43. The 22 was target extraction: an enumeration lost every
    // member but the last ("CNN과 ViT로 분류기를 만들고" → "ViT로 분류기"), a
    // range lost both ends, and the renderer replaced the user's verb with a
    // representative of its class, so 번역 came back as 수정 and 비교 as 살펴봄.
    //
    // Two of the gaps this number used to carry have since closed, and the way
    // the second closed is worth keeping, because the first attempt at it
    // *raised this number while making the output worse*. Widening the particle
    // gap alone let "학습과 추론을 하고" match, and the object scan then took the
    // word in front: the design said **학습과를 추론한다**, a target nobody named.
    // Both keywords counted. A substring metric cannot tell that from reading
    // the sentence, so the number is not the check — `siblingActsBefore` is, and
    // it only fires on words that are already verb stems.
    //
    // Those two gaps are a source named without a URL and the light verb.
    // Neither is among the four still open, which are pinned word by word in
    // "the four keywords that do not survive" at the bottom of this file.
    // `namedSourcesIn` took the first from 35 to 37; the light verb from 37 to 40.
    assert.deepEqual(
      { hit: score.keywordHit, of: score.keywordTotal },
      { hit: 43, of: 47 },
      "keyword fidelity moved — a rise is a result worth recording, a drop is a regression",
    );
  });
});

/**
 * The same 47 keywords, split by the turn that had to carry them.
 *
 * One row per annotated turn, in corpus order; `hit` and `missed` list the
 * words in the order the scenario names them. A row is the aggregate made
 * addressable: a word that stops surviving fails the turn it belongs to, under
 * a name that says which sentence and which word, without anyone rerunning the
 * corpus by hand to find out which.
 */
const PER_TURN: Array<{ id: string; hit: string[]; missed: string[] }> = [
  {
    id: "S01-complex-request#1",
    hit: ["개와 고양이", "CNN", "Transformer", "학습", "추론", "웹", "Hugging Face", "HASA", "비교"],
    missed: [],
  },
  { id: "S02-continue-after-reload#1", hit: ["CNN", "ViT", "학습"], missed: [] },
  { id: "S03-refine#1", hit: ["CNN", "Transformer"], missed: [] },
  { id: "S03-refine#2", hit: ["HASA"], missed: ["오픈소스"] },
  { id: "S04-correct-to-present#1", hit: ["실행"], missed: [] },
  { id: "S04-correct-to-present#2", hit: ["코드"], missed: [] },
  { id: "S05-no-execute#1", hit: ["분석"], missed: [] },
  { id: "S06-present-and-execute#1", hit: ["코드", "실행"], missed: [] },
  { id: "S07-invalid-invocation#1", hit: ["torch", "torchvision"], missed: [] },
  { id: "S08-false-blocker#1", hit: ["torch", "학습"], missed: [] },
  { id: "S09-no-progress#1", hit: [], missed: ["마무리"] },
  { id: "S10-legitimate-retry#1", hit: ["테스트"], missed: [] },
  { id: "S11-exact-url#1", hit: ["모델"], missed: [] },
  // 알려진 어긋남: both words are credited to the source-hygiene lines
  // ("hugging face 을(를) 실제로 읽고 …"), not to the requirement, which reads
  // only "모델을 살펴본다". `stated` keeps those lines because they are not
  // `system_added`, so fidelity here is 2/2 while the sentence a person reads
  // names neither source. Pinned as it behaves, in "what the numbers cannot
  // see" below; the aggregate cannot see it.
  { id: "S12-source-isolation#1", hit: ["Hugging Face", "HASA"], missed: [] },
  { id: "S13-catalog-vs-invocation#1", hit: ["Model B", "호출"], missed: [] },
  { id: "S14-source-fact-omission#1", hit: ["모델"], missed: [] },
  { id: "S15-question-mid-task#1", hit: ["CNN", "ViT"], missed: [] },
  { id: "S16-new-task#1", hit: ["CNN"], missed: [] },
  { id: "S16-new-task#2", hit: ["README", "번역"], missed: [] },
  // 알려진 어긋남: 2/2, and the rendered requirement is "안의 main.py를
  // 실행한다" — the folder "8_09" is dropped and its bound noun 안 is left
  // dangling. Both keywords survive, so no number moves; only reading the
  // turn's own output shows it, which is what "what the numbers cannot see"
  // below now does.
  { id: "S17-workspace-cwd#1", hit: ["main.py", "실행"], missed: [] },
  { id: "S18-exact-fetch-failure#1", hit: ["모델 목록"], missed: [] },
  { id: "S19-truncated-source#1", hit: ["Model X"], missed: [] },
  { id: "S20-mixed-stress#1", hit: ["개와 고양이", "학습"], missed: ["CNN", "Transformer"] },
  // 알려진 어긋남: HASA is credited to "open.hasa.re.kr" in the source line,
  // and the requirement itself renders as "모델 후보에를 넣는다" — 후보에 and
  // 를 stacked, a target the user did not phrase. 1/1 either way, and pinned
  // as it behaves in "what the numbers cannot see" below.
  { id: "S20-mixed-stress#3", hit: ["HASA"], missed: [] },
];

describe("turn by turn", () => {
  test("the annotated turns are exactly these twenty-four, in this order", () => {
    // The count above says twenty-four; this says *which* twenty-four. A
    // scenario that trades one annotated turn for another, or reorders them,
    // leaves both aggregates untouched and every row below pointing elsewhere.
    assert.deepEqual([...outcomes.keys()], PER_TURN.map((row) => row.id));
  });

  for (const row of PER_TURN) {
    const asked = row.hit.length + row.missed.length;

    test(`${row.id} · 물어본 낱말 ${asked}개`, () => {
      // The row is a hand transcription of the scenario's keyword list, and
      // nothing used to compare it *to* that list — `wanted` was recorded and
      // never read. The fidelity test below cannot stand in for this: it checks
      // the row against a partition of `wanted`, so a word added to or dropped
      // from `scenarios.ts` fails it as though the design had lost one. Two
      // different events, and this is the one that says the corpus asked a
      // different question.
      const found = outcome(row.id);
      assert.deepEqual(
        [...row.hit, ...row.missed].sort(),
        [...found.wanted].sort(),
        `${row.id} 의 낱말 목록이 시나리오의 것과 다르다: ${found.wanted.join(", ")}`,
      );
    });

    test(`${row.id} · 읽음`, () => {
      // Coverage, per turn. The aggregate reports five silent turns as one
      // failed assertion; this reports the sentence that went unread.
      const found = outcome(row.id);
      assert.ok(found.statedCount > 0, `${found.user} — 사용자 자신의 요구를 하나도 세우지 못했다`);
    });

    test(`${row.id} · 키워드 ${row.hit.length}/${asked}`, () => {
      // Fidelity, per turn, listing the words on both sides — so the failure
      // reads "이 사례에서 Transformer 가 빠졌다", not "43 이 42 가 되었다".
      const found = outcome(row.id);
      assert.deepEqual(
        { hit: found.hit, missed: found.missed },
        { hit: row.hit, missed: row.missed },
        `${found.user}\n  → ${found.shown}`,
      );
    });
  }
});

/**
 * Three turns where the numbers are right and the output is not.
 *
 * Each of these is a `알려진 어긋남` note on a row above: fidelity is full, the
 * aggregate is unmoved, and the sentence a person would read is still wrong.
 * Until now the notes described the defect and no assertion held it, which
 * makes a comment a claim nobody checks — the same thing this file exists to
 * stop happening to a number.
 *
 * So each is pinned exactly as it behaves today, wrong parts included. That is
 * deliberate and the tests say so: the day one of these is fixed, the test goes
 * red under the name of the defect it was holding, and someone decides that the
 * fix is a result rather than letting it land as silence.
 */
describe("what the numbers cannot see", () => {
  /** The lines a person reads as the request, as opposed to the ones about sourcing. */
  const acts = (found: TurnOutcome) => found.stated.filter((l) => l.derivedBy === "runtime_action");
  /** The source-hygiene lines the runtime emits once per source it recognised. */
  const hygiene = (found: TurnOutcome) => found.stated.filter((l) => l.derivedBy === "runtime_source");
  /** Which of the turn's own keywords survive into a given set of lines. */
  const surviving = (found: TurnOutcome, lines: Array<{ text: string }>) => {
    const text = lines.map((l) => l.text).join(" ").toLowerCase();
    return found.wanted.filter((keyword) => text.includes(keyword.toLowerCase()));
  };

  test("S12-source-isolation#1 · 2/2 는 출처위생 줄이 낸 점수다", () => {
    // What the aggregate is counting, made visible. Fidelity for this turn is
    // 2/2 and the requirement a person reads names neither source: both words
    // are matched against the "…을(를) 실제로 읽고" lines, which are `stated`
    // because they are not `system_added`.
    const found = outcome("S12-source-isolation#1");
    assert.deepEqual(acts(found).map((l) => l.text), ["모델을 살펴본다"], found.shown);
    assert.deepEqual(surviving(found, acts(found)), [], "요구사항 줄이 출처를 말하기 시작했다");
    assert.deepEqual(hygiene(found).map((l) => l.text), [
      // `을(를)` 였다. 행위 줄은 진짜 조사를 쓰는데 출처 줄만 두 개를 괄호로
      // 나란히 적고 있었고, 같은 패널이 두 표기를 동시에 보여 주었다.
      "open.hasa.re.kr를 실제로 읽고, 거기서 확인한 것만 그 출처로 보고한다",
      "Hugging Face를 실제로 읽고, 거기서 확인한 것만 그 출처로 보고한다",
    ], found.shown);
    assert.deepEqual(surviving(found, hygiene(found)), ["Hugging Face", "HASA"], found.shown);
    // And the second of those two is scored on a hostname. The user never typed
    // "HASA"; "hasa" is a substring of open.hasa.re.kr, which is the runtime's
    // rendering of their URL. A keyword that only ever matches inside a
    // hostname is measuring the link, not the sentence.
    assert.ok(!found.user.includes("HASA"), found.user);
    assert.ok(hygiene(found)[0]?.text.includes("open.hasa.re.kr"), found.shown);
  });

  test("S17-workspace-cwd#1 · 폴더 이름은 여전히 사라지지만 안의 는 더 이상 대상이 아니다", () => {
    // 이 테스트가 지금 동작을 못 박은 바로 다음에 그 동작이 고쳐졌다 — 못 박기가
    // 하려던 일이 그것이다. 못 박기 전에는 "안의 main.py를 실행한다" 였다:
    // 대상이 의존명사로 시작하고 폴더를 하나도 부르지 않는데 키워드는 2/2 였다.
    // `[안밖위속앞뒤옆]의` 가 처소 표지 목록에 들어가면서 `안의` 는 문법어가
    // 되었고, 대상은 사용자가 실제로 말한 것만 남는다.
    //
    // 폴더 이름 `8_09` 는 여전히 사라진다. 그것은 지어내기가 아니라 구멍이고,
    // 이 파일이 이름을 붙여 두는 쪽이다 — `8_09 폴더 안의` 전체가 처소구인데
    // 대상 스캔은 처소구를 통째로 버리기 때문이다.
    const found = outcome("S17-workspace-cwd#1");
    assert.deepEqual(found.stated.map((l) => l.text), ["main.py를 실행한다"], found.shown);
    assert.ok(!found.shown.includes("안의"), "의존명사가 다시 대상에 붙었다");
    assert.ok(!found.shown.includes("8_09"), "폴더 이름이 살아남기 시작했다 — 좋은 소식이니 이 못을 갱신하라");
  });

  test("S20-mixed-stress#3 · 조사 겹침은 사라졌고, HASA 는 여전히 호스트명에서 나온다", () => {
    // 두 결함이 한 턴에 있었다. 하나는 고쳐졌다 — `후보에` 가 이미 조사를 달고
    // 있는데 렌더러가 `를` 을 하나 더 붙여 **모델 후보에를 넣는다** 를 만들고
    // 있었다. 네 말뭉치의 요구사항 187개를 훑어 이 문장 하나뿐임을 확인했고,
    // `objectParticle` 이 이제 조사를 이미 단 구에는 아무것도 붙이지 않는다.
    //
    // 다른 하나는 그대로다: HASA 라는 키워드는 요청 줄이 아니라 출처 줄의
    // 호스트명 안에서 잡힌다. 그것이 아래 두 단언이 계속 지키는 것이다.
    const found = outcome("S20-mixed-stress#3");
    assert.deepEqual(acts(found).map((l) => l.text), ["모델 후보에 넣는다"], found.shown);
    assert.deepEqual(surviving(found, acts(found)), [], "요구사항 줄이 출처를 말하기 시작했다");
    assert.deepEqual(surviving(found, hygiene(found)), ["HASA"], found.shown);
    assert.ok(!found.user.includes("HASA"), found.user);
  });
});

/**
 * The four keywords the design still does not say, and the verb that takes two
 * of them down with it — five tests, one per name.
 *
 * Four is the whole of 47 − 43: 오픈소스, 마무리, and the pair CNN/Transformer.
 * The fifth test names no keyword. It pins `쓰다` itself as an absence, which is
 * what keeps the pair evidence about the verb rather than about enumerations.
 * Two bullets below, three causes:
 *
 *   · `쓰다` is still not read at all, on purpose — "보고서를 쓰고" is
 *     writing and "CNN을 쓰고" is using, and the object cannot tell them
 *     apart. A missed request is a gap; a request turned into the wrong act
 *     is an invention.
 *   · 마무리 and 오픈소스 are a verb and a noun the lexicon does not carry.
 *     "모델 목록" was a third until `-어서` became a boundary for the halves
 *     that name their own target; 웹 a fourth until a comma-cut piece with
 *     no verb was folded into the clause it belongs to; 호출 a fifth until a
 *     clause could say it is about a question rather than about a thing.
 *
 * Each is pinned as an absence, with the half of the same sentence that *does*
 * survive pinned beside it — that pairing is what separates "the lexicon has no
 * entry for this word" from "the clause was lost". When one of them starts
 * surviving, the test fails under the word's own name, and someone records
 * which one; that is the whole difference between a result and a number that
 * went up.
 */
describe("the four keywords that do not survive", () => {
  test("S03-refine#2 · 오픈소스 — a noun the lexicon does not carry", () => {
    const found = outcome("S03-refine#2");
    assert.deepEqual(found.missed, ["오픈소스"], found.shown);
    // "좋은 오픈소스 모델하고 HASA 모델도 추가해줘" — the clause is read and
    // the act is right; it is the modifier that has no entry to survive as.
    assert.ok(found.shown.includes("hasa"), found.shown);
  });

  test("S09-no-progress#1 · 마무리 — a verb the lexicon does not carry", () => {
    const found = outcome("S09-no-progress#1");
    assert.deepEqual(found.missed, ["마무리"], found.shown);
    // "프로젝트를 마무리하고 완료를 확인해줘" — the second half lands whole, so
    // the sentence was split correctly; only the first verb is unknown.
    assert.ok(found.shown.includes("완료"), found.shown);
  });

  test("S20-mixed-stress#1 · CNN — carried by 쓰고, and 쓰다 is not read", () => {
    const found = outcome("S20-mixed-stress#1");
    assert.ok(found.missed.includes("CNN"), found.shown);
  });

  test("S20-mixed-stress#1 · Transformer — carried by 쓰고, and 쓰다 is not read", () => {
    // Both members of the enumeration go down with the clause. S01 names the
    // same two words and keeps both, because there the verb is 사용하고 —
    // which is what makes this pair evidence about `쓰다` and not about
    // enumerations losing their members again.
    const found = outcome("S20-mixed-stress#1");
    assert.ok(found.missed.includes("Transformer"), found.shown);
  });

  test("S20-mixed-stress#1 · 쓰다 — dropped whole, never turned into 쓰기", () => {
    // The refusal itself, stated as an absence: the clause is dropped rather
    // than rendered as a writing act nobody asked for. This is the assertion
    // that would fail if `쓰다` were ever "fixed" by guessing — and the two
    // keywords above would go green in that same edit.
    const found = outcome("S20-mixed-stress#1");
    assert.ok(!/쓴다|작성/.test(found.shown), found.shown);
    // What the same sentence does deliver, so the loss stays a clause and not
    // a turn: "개와 고양이 분류 프로젝트를 만들어줘 … 학습까지 해줘".
    assert.deepEqual(found.hit, ["개와 고양이", "학습"], found.shown);
  });
});
