import { measure, type Measure } from "../router/modelProfile.ts";
import { MIN_SAMPLES_FOR_EVIDENCE } from "../router/modelRegistry.ts";
import type { CapabilityDemand } from "../router/taskProfile.ts";
import { verdictFor, type MemoryVerdict, type Neighbour } from "./requirementMemory.ts";

/**
 * What the memory of similar requests says about a model, as router evidence.
 *
 * `proposerEvidence` turns a sweep into evidence: somebody runs a corpus, and
 * the numbers are about that corpus on that day. This turns the pile that
 * accumulates on its own into evidence about *this* request — the neighbours of
 * the sentence in front of us, and what became of them.
 *
 * ## Why `observed` and not `harness_eval`
 *
 * The ladder already has the right rung. `harness_eval` means "measured against
 * this harness's own scenarios"; these outcomes were not measured against
 * anything, they *happened* — a user corrected a requirement, or the runtime
 * refused a span. That is what `observed` means, and it outranks `harness_eval`
 * for the reason the ladder gives: a stronger origin is more believable, not
 * more favourable.
 *
 * ## Which capability, and why only one
 *
 * `sourceGrounding`. Both outcomes the memory records are a proposer failing to
 * read the request: `superseded` is the user saying "that is not what I asked",
 * `rejected` is the runtime saying "those coordinates are not in the text".
 * Neither says anything about coding, recovery or tool use, and filling those
 * in would launder one signal into many — the same line `proposerEvidence`
 * draws, for the same reason.
 *
 * ## What it refuses to say
 *
 * Anything, on too few neighbours. One corrected requirement out of one is not
 * "this model is wrong every time"; it is one requirement. The threshold is the
 * registry's own `MIN_SAMPLES_FOR_EVIDENCE`, so the memory and the sweep agree
 * on where an anecdote becomes a measurement.
 *
 * And anything about a model at a budget it was never seen at. A model is fast
 * at 6000 tokens and silent at 800 — the same fact `proposerEvidence` had to
 * carry — so a verdict is about the pair, never the model alone.
 */

export interface MemoryEvidence {
  modelId: string;
  /** The output budget these neighbours ran under. Null for runtime-read rows. */
  budget: number | null;
  /** Sparse: only what the neighbours actually evidence. */
  capabilities: Partial<Record<keyof CapabilityDemand, Measure>>;
  /** The count and the outcomes behind the number, so a caller can show its work. */
  basis: MemoryVerdict;
}

/**
 * Every (model, budget) pair the neighbours mention.
 *
 * Pairs rather than models, because that is what a row records and what a
 * verdict is about. A caller ranking models has to decide which budget it will
 * actually run at; this does not decide that for it.
 */
function pairsIn(neighbours: readonly Neighbour[]): { modelId: string; budget: number | null }[] {
  const seen = new Map<string, { modelId: string; budget: number | null }>();
  for (const n of neighbours) {
    // Rows the deterministic layer produced name no model. They are real rows
    // and they are not evidence about any model, so they are skipped here
    // rather than collected under a null id.
    if (n.row.proposedBy === null) continue;
    // 구분자는 NUL — 모델 id 에 나올 수 없는 바이트라 `a`+`1` 과 `a1`+`` 이 같은
    // 열쇠가 되는 일이 없다. 날것의 0x00 이 아니라 이스케이프로 적는 이유는,
    // 소스에 제어문자가 박히면 grep 이 그 파일을 바이너리로 보고 통째로
    // 건너뛰기 때문이다. 이 저장소에서 이미 세 파일이 그 이유로 비밀정보
    // 감사에서 빠졌었고, 이 줄도 처음에는 같은 실수로 쓰였다.
    const key = `${n.row.proposedBy}\0${String(n.row.budget)}`;
    if (!seen.has(key)) seen.set(key, { modelId: n.row.proposedBy, budget: n.row.budget });
  }
  return [...seen.values()];
}

export function evidenceFromMemory(input: {
  neighbours: readonly Neighbour[];
  /** Below this, a rate is an anecdote. Defaults to the registry's threshold. */
  minNeighbours?: number;
  /** Epoch millis, from the caller. Recorded so a stale opinion can be seen as one. */
  now: number;
}): readonly MemoryEvidence[] {
  const floor = input.minNeighbours ?? MIN_SAMPLES_FOR_EVIDENCE;
  const at = new Date(input.now).toISOString();
  const out: MemoryEvidence[] = [];

  for (const { modelId, budget } of pairsIn(input.neighbours)) {
    const verdict = verdictFor(input.neighbours, modelId, budget);
    const capabilities: Partial<Record<keyof CapabilityDemand, Measure>> = {};

    // `rate` is null when nothing has settled yet — see `verdictFor`. Together
    // with the floor these are the two ways the memory declines to speak, and
    // they are different: one is "not enough neighbours", the other is
    // "neighbours, but nothing has happened to any of them".
    if (verdict.rate !== null && verdict.seen >= floor) {
      capabilities.sourceGrounding = measure(round(1 - verdict.rate), "observed", verdict.seen, at);
    }

    out.push({ modelId, budget, capabilities, basis: verdict });
  }
  return out;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * The pairs the memory has an opinion about, worst first.
 *
 * Sorted so a caller showing a few sees the ones worth avoiding. Pairs the
 * memory declines to score are left out entirely rather than sorted to the
 * bottom — "no opinion" is not "the weakest opinion", and a list that mixes
 * them invites reading silence as a low score.
 */
export function ranked(evidence: readonly MemoryEvidence[]): readonly MemoryEvidence[] {
  return evidence
    .filter((e) => e.capabilities.sourceGrounding !== undefined)
    .sort(
      (a, b) =>
        (a.capabilities.sourceGrounding?.value ?? 0) - (b.capabilities.sourceGrounding?.value ?? 0) ||
        a.modelId.localeCompare(b.modelId),
    );
}
