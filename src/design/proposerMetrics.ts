import { acceptProposals, type RequirementProposal } from "./requirementSpec.ts";
import { parseProposals, type ParseOutcome } from "./proposalParse.ts";

/**
 * What a proposer-specific measurement has to contain.
 *
 * `modelProposer.ts` names this file in the comment that explains why it no
 * longer ranks models by `requirementRecall`, and for a long time the file did
 * not exist — the comment promised a definition and pointed at nothing. So the
 * argument for not ranking was written down and the thing that would let us
 * rank was not, which reads as a decision but was a gap.
 *
 * ## Why the old number could not be reused
 *
 * `requirementRecall` scores a whole agent loop over a long task: many turns,
 * tools, a contract file written and rewritten. A proposer does one call and
 * emits a short JSON array of character offsets. A model can be good at the
 * first and bad at the second — the second is mostly *counting characters in
 * someone else's sentence*, which is not what the first rewards. Nothing
 * establishes that one predicts the other, so a ranking built on it was
 * authority the number had not earned.
 *
 * ## The five axes, and why these five
 *
 * Each names a distinct failure with a distinct fix, which is the only reason
 * to keep them apart:
 *
 *     shape        the answer was not a usable JSON array      → prompt
 *     accepted     coordinates the runtime refused             → prompt
 *     named        it did not find the requirement at all      → model
 *     pointed      it found it, and the coordinates miss it    → prompt
 *     invented     a requirement the sentence does not state   → model
 *     transcribed  it copied the span into `text`              → prompt
 *
 * A single "accuracy" would average these into a number that cannot be acted
 * on: `shape` and `transcribed` are answered by changing the instructions,
 * `named` and `invented` are answered by changing the model. Reporting one
 * figure would hide which of the two you are looking at.
 *
 * ## Why `named` had to be split off from `pointed`
 *
 * The first sweep scored every model near zero on `pointed`, which reads as
 * "no model can do this" and is wrong. The models were finding the
 * requirements and writing them down correctly; what they could not do was
 * count UTF-16 code units in someone else's Korean sentence. Those are a model
 * problem and a prompt problem, and a metric that reports them as one number
 * sends you to replace the model when the instructions are what is unfeasible.
 *
 * The instructions make it unfeasible on purpose: they ask for offsets and, in
 * the same breath, forbid transcribing the span — which rules out the `quote`
 * field that `checkSpan` exists to verify offsets against. So the one signal
 * that would let the runtime *locate* a correctly-named requirement is the one
 * the prompt refuses to collect. `named` is what makes that visible; it is not
 * a consolation score.
 *
 * ## What this does not establish
 *
 * That a model scoring well here is a good proposer *for a user's real
 * request*. The corpus is written sentences with known answers; a real request
 * arrives with context, history, and no gold. It also says nothing about cost,
 * latency, or whether the model stays this way — a measurement is of the
 * models on the day it ran, and `ProposerMeasurement.takenAt` exists so a
 * reader can see how old the claim is before ranking anything by it.
 *
 * And it measures one prompt. Change `modelProposer.SYSTEM` and every number
 * here is about a prompt that no longer exists.
 */

/** One thing the sentence states, and the words that state it. */
export interface ProposerWant {
  /**
   * The words the requirement is grounded in — a substring of the case text.
   *
   * A quote rather than a span, so a corpus author writes what the sentence
   * says instead of counting UTF-16 offsets by hand. `buildProposerCase`
   * refuses a quote that is not in the text, because a want nothing can satisfy
   * would score every model identically and look like agreement.
   */
  quote: string;
}

export interface ProposerCase {
  turnId: string;
  text: string;
  wants: readonly ProposerWant[];
}

/**
 * Builds a case, refusing one that cannot be scored.
 *
 * The two refusals are the ones that produce a silently meaningless number: a
 * quote absent from the text can never be pointed at, and a quote appearing
 * twice makes "did it point at the quote" ambiguous between two places.
 */
export function buildProposerCase(input: {
  turnId: string;
  text: string;
  wants: readonly ProposerWant[];
}): ProposerCase {
  for (const want of input.wants) {
    const first = input.text.indexOf(want.quote);
    if (first < 0) {
      throw new Error(`${input.turnId}: 인용 «${want.quote}» 이(가) 원문에 없습니다.`);
    }
    if (input.text.indexOf(want.quote, first + 1) >= 0) {
      throw new Error(`${input.turnId}: 인용 «${want.quote}» 이(가) 원문에 두 번 나옵니다.`);
    }
  }
  return { turnId: input.turnId, text: input.text, wants: input.wants };
}

export interface Ratio {
  hit: number;
  of: number;
  /** Null rather than zero when the denominator is empty. */
  value: number | null;
}

const ratio = (hit: number, of: number): Ratio => ({
  hit,
  of,
  value: of === 0 ? null : Math.round((hit / of) * 1000) / 1000,
});

/** What one answer to one case turned out to be. */
export interface CaseOutcome {
  turnId: string;
  /** How the answer parsed, before any judgement about its content. */
  parse: ParseOutcome;
  /** Proposals whose coordinates the runtime accepted. */
  accepted: number;
  /** Proposals the runtime refused — bad span, or forged provenance. */
  rejected: number;
  /** Wants some proposal's own sentence names, span or no span. */
  named: number;
  /** Wants an accepted proposal's cut words actually cover. */
  pointed: number;
  /** Proposals naming no want — measured on the model's sentence, not its span. */
  invented: number;
  /** Accepted proposals whose `text` merely repeats the words they point at. */
  transcribed: number;
}

/**
 * How much of a passage a sentence covers, by character bigram.
 *
 * Containment cannot be used: a proposer is asked to *name* the requirement,
 * so "…분석해" comes back as "…분석해야 함" and every correct answer would
 * score zero. Bigrams over the want's own characters ask the useful question —
 * how much of what the passage says does this sentence say — and are not fooled
 * by re-ordering the way a bag of characters would be.
 *
 * Whitespace is dropped, because the model is rewriting rather than copying and
 * where it breaks the phrase is not a difference worth counting.
 */
function bigramCoverage(want: string, said: string): number {
  const chars = (s: string): string => s.replace(/\s+/gu, "");
  const w = chars(want);
  const s = chars(said);
  if (w.length < 2) return s.includes(w) ? 1 : 0;
  let hit = 0;
  for (let i = 0; i + 2 <= w.length; i += 1) {
    if (s.includes(w.slice(i, i + 2))) hit += 1;
  }
  return hit / (w.length - 1);
}

/**
 * How much of a want a sentence has to cover to count as naming it.
 *
 * 0.6 rather than a rounder number: at 0.5 the two requirements of
 * `p-govern-policy` — which share "정책을" and most of their grammar — each
 * matched the other, and one sentence scored both. Set from a corpus the
 * threshold has to separate, and it belongs next to that corpus, not in it.
 */
export const NAMED_COVERAGE = 0.6;

/**
 * Whether the model wrote its own sentence or copied the one it was given.
 *
 * The instructions say to name the requirement, not to transcribe the span, and
 * a copy is easy to produce and useless downstream — the runtime already has
 * `sourceText`. Whitespace is normalised first so that re-wrapping a copy is
 * still a copy; containment either way counts, because "시스템 아키텍처를
 * 분석해줘" padded to "시스템 아키텍처를 분석해줘." is not a different answer.
 */
function isTranscription(text: string, cut: string): boolean {
  const a = text.replace(/\s+/gu, " ").trim();
  const b = cut.replace(/\s+/gu, " ").trim();
  if (a.length === 0 || b.length === 0) return false;
  return a.includes(b) || b.includes(a);
}

/**
 * Scores one model's raw answer to one case.
 *
 * The raw string, not a parsed object: parsing is itself one of the axes, and a
 * caller who parsed first would have to decide what to do with a failure before
 * the measurement got to see it.
 */
export function scoreProposerCase(input: {
  testCase: ProposerCase;
  raw: string;
}): CaseOutcome {
  const { testCase, raw } = input;
  const parse = parseProposals(raw, testCase.turnId);

  // Coordinates are checked by the runtime that owns them. Re-deciding here
  // what a valid span is would be a second definition, free to drift from the
  // one that actually gates a request.
  const proposals: readonly RequirementProposal[] = parse.proposals;
  const { accepted, rejected } = acceptProposals({
    turnId: testCase.turnId,
    userText: testCase.text,
    proposals,
  });

  // `sourceText` is the runtime's own cut, never the model's string — so a
  // model cannot satisfy `pointed` by asserting the quote in prose.
  const cuts = accepted.map((spec) => spec.sourceText);
  const pointed = new Set<number>();
  testCase.wants.forEach((want, index) => {
    if (cuts.some((cut) => cut.includes(want.quote))) pointed.add(index);
  });

  // `named` reads every proposal `parseProposals` handed over, including ones
  // `acceptProposals` then rejected for a bad span. A requirement correctly
  // found and mis-located is found; counting only the accepted ones would fold
  // the coordinate failure back into the axis this one was split off to keep
  // clear of it.
  //
  // Items carrying a forged field arrive here too. `parseProposals` emits them
  // on purpose so that the refusal is recorded by the checker rather than
  // vanishing at the parser, and this metric must not undo that by pretending
  // they were never said. Overstepping and mis-reading are two things: the
  // first is what `parse === "forbidden_field"` records, and folding it into
  // `named` as well would charge one answer twice.
  const said = proposals.map((p) => p.text);
  const named = new Set<number>();
  testCase.wants.forEach((want, index) => {
    if (said.some((text) => bigramCoverage(want.quote, text) >= NAMED_COVERAGE)) named.add(index);
  });

  const invented = said.filter(
    (text) => !testCase.wants.some((want) => bigramCoverage(want.quote, text) >= NAMED_COVERAGE),
  ).length;

  const transcribed = accepted.filter((spec) =>
    isTranscription(spec.text, spec.sourceText),
  ).length;

  return {
    turnId: testCase.turnId,
    parse: parse.outcome,
    accepted: accepted.length,
    rejected: rejected.length,
    named: named.size,
    pointed: pointed.size,
    invented,
    transcribed,
  };
}

export interface ProposerScore {
  modelId: string;
  /** Cases where the answer parsed into candidates at all. */
  shape: Ratio;
  /** Proposals the runtime accepted, over proposals parsed. */
  accepted: Ratio;
  /** Wants the model found and named, over wants stated. Recall of the reading. */
  named: Ratio;
  /** Wants whose coordinates landed, over wants stated. Recall of the locating. */
  pointed: Ratio;
  /** Proposals naming no want, over proposals parsed. */
  invented: Ratio;
  /** Accepted proposals that copied their span, over accepted proposals. */
  transcribed: Ratio;
  /** Cases the sweep could not get an answer for at all — a 403, a timeout. */
  unanswered: number;
  /**
   * Cases where the model ran out of output budget mid-answer.
   *
   * Separate from every other axis because it is not about the model. A
   * reasoning model spends the budget thinking and then has nothing left to
   * write with, so it returns an empty string — which parses as "wrote
   * nothing" and scores identically to a model that cannot do the task at all.
   * The first sweep reported four models at 0/16 for exactly this reason; at a
   * larger budget all four produced well-formed arrays, and one of them placed
   * its coordinates correctly.
   */
  truncated: number;
  outcomes: readonly CaseOutcome[];
}

/**
 * Rolls per-case outcomes into one model's score.
 *
 * `unanswered` is carried separately rather than folded into `shape`, because
 * "the gateway refused the call" and "the model wrote prose" are not the same
 * finding and only the second is about the model.
 */
export function scoreProposer(input: {
  modelId: string;
  outcomes: readonly CaseOutcome[];
  wantsTotal: number;
  unanswered: number;
  truncated?: number;
}): ProposerScore {
  const { outcomes } = input;
  const parsedOk = outcomes.filter((o) => o.parse === "parsed_candidate").length;
  const proposed = outcomes.reduce((n, o) => n + o.accepted + o.rejected, 0);
  const acceptedTotal = outcomes.reduce((n, o) => n + o.accepted, 0);
  return {
    modelId: input.modelId,
    shape: ratio(parsedOk, outcomes.length + input.unanswered),
    accepted: ratio(acceptedTotal, proposed),
    named: ratio(
      outcomes.reduce((n, o) => n + o.named, 0),
      input.wantsTotal,
    ),
    pointed: ratio(
      outcomes.reduce((n, o) => n + o.pointed, 0),
      input.wantsTotal,
    ),
    invented: ratio(
      outcomes.reduce((n, o) => n + o.invented, 0),
      proposed,
    ),
    transcribed: ratio(
      outcomes.reduce((n, o) => n + o.transcribed, 0),
      acceptedTotal,
    ),
    unanswered: input.unanswered,
    truncated: input.truncated ?? 0,
    outcomes,
  };
}

/**
 * A whole sweep, with the facts a reader needs before believing its order.
 *
 * `prompt` and `takenAt` are required, not optional. A ranking whose prompt and
 * date are unrecorded is the shape of claim that outlives its evidence — which
 * is the failure `modelProposer` describes and refuses to repeat.
 */
export interface ProposerMeasurement {
  /** Identifies the instructions the numbers are about. */
  prompt: string;
  /** Epoch millis, from the caller's clock. */
  takenAt: number;
  baseUrl: string;
  cases: number;
  wants: number;
  /**
   * The output budget every model was given.
   *
   * Required, and load-bearing. A model that thinks before it answers spends
   * this on thinking, and below some threshold it returns an empty string no
   * matter how capable it is — so a score without its budget beside it is not
   * a claim about a model. `modelProposer` ships 800, which is below that
   * threshold for every reasoning model in this catalogue.
   */
  maxTokens: number;
  scores: readonly ProposerScore[];
}

/**
 * Orders models by measured fitness for the proposer task.
 *
 * `named` first — a proposer that does not find the requirement is useless
 * however clean its JSON. Then invention, ascending, because a confidently
 * wrong requirement costs the user more than a missing one they can restate.
 * Then `pointed`, then `shape`, to break ties.
 *
 * ## Why `pointed` is not the primary key, given that it is the task
 *
 * Because on the shipped prompt it is mostly noise. In the first full sweep —
 * 18 chat models, 10 cases, 16 requirements — eleven models scored 0/16 and the
 * best scored 7/16, and that best model reached it by transcribing the span
 * into `text` in 86% of its proposals. So the models that "aim well" are
 * largely the models that copy, which is the behaviour the instructions
 * forbid: ranking on `pointed` would put a rule-breaker first.
 *
 * `pointed` stays in the sort, below the axes that discriminate honestly, so
 * that a prompt which makes locating feasible starts deciding ranks without
 * this function having to be rewritten.
 *
 * Returns models in order; it does not pick one. Choosing is
 * `chooseProposerModel`'s job and it has a permission check to apply that this
 * module knows nothing about — a measurement that selected would be a second
 * place where a model gets called without evidence it may be.
 */
export function rankByMeasurement(measurement: ProposerMeasurement): readonly string[] {
  const key = (s: ProposerScore): [number, number, number, number] => [
    s.named.value ?? 0,
    -(s.invented.value ?? 1),
    s.pointed.value ?? 0,
    s.shape.value ?? 0,
  ];
  return [...measurement.scores]
    .sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      for (let i = 0; i < ka.length; i += 1) {
        const diff = (kb[i] ?? 0) - (ka[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return a.modelId.localeCompare(b.modelId);
    })
    .map((s) => s.modelId);
}
