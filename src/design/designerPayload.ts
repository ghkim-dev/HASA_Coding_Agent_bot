import type { HarnessDesign } from "./harnessDesign.ts";
import { describeDesign } from "./harnessDesign.ts";
import { handoffFor } from "./harnessHandoff.ts";

/**
 * What the designer panel is given, decided here and judged nowhere else.
 *
 * Lifted out of `designerHost.ts` for the reason `conversationAdoption.ts` was
 * lifted out of `agentHost.ts`: that module imports `vscode`, nothing in
 * `node --test` can load it, and every judgement inside it was therefore
 * unmeasured. Three corpora score what the runtime *reads*; nothing scored what
 * the user is *shown*, and those are not the same claim — a requirement can be
 * read correctly and then presented as the harness's own rule, or a filtered
 * model can be listed as an alternative, and no extraction test would notice.
 *
 * ## Flat on purpose
 *
 * The webview decides no policy. Every boolean here is a judgement — is this
 * grounded, is it the user's or the harness's, is it a prohibition — and each
 * one belongs where it can be tested rather than in a template. A view that
 * worked any of them out for itself would be a second opinion sitting next to
 * the first, and the two would drift.
 */
export interface DesignPayload {
  summary: string;
  requirements: Array<{
    text: string;
    grounded: boolean;
    baseline: boolean;
    forbidden: boolean;
  }>;
  confidence: HarnessDesign["confidence"];
  demands: Record<string, number>;
  intents: string[];
  prohibitions: string[];
  understood: boolean;
  recommendation: {
    selected: {
      modelId: string;
      score: number;
      /** The four terms, so a user can see which one carried the pick. */
      breakdown: Record<string, number>;
      /** How much of what this task needs was ever measured on this model. */
      confidence: { known: number; total: number; coldStart: boolean };
    } | null;
    alternatives: Array<{ modelId: string; score: number; coldStart: boolean }>;
    /** Kept with their codes: "good at what you need" and "bad at it" differ. */
    reasons: Array<{ code: string; detail: string }>;
    /** The human sentence, not only the enum. */
    filteredOut: Array<{ modelId: string; code: string; detail: string }>;
    /** How many were dropped in total, when the list above is truncated. */
    filteredOutTotal: number;
    /** Candidates the score cannot separate from the winner. */
    tiedWith: string[];
    unavailableReason?: string;
  } | null;
  questions: Array<{ about: string; options: string[] }>;
  /**
   * What handing this design to the agent would carry, decided here.
   *
   * The view shows it and judges nothing, like every other field. A webview
   * that worked out for itself which model to name would be a second ranker,
   * disagreeing with the first one on the same screen.
   */
  handoff: { modelId: string | null; why: string; blockerCount: number };
}

/** How many alternatives and rejects the panel shows before it truncates. */
const MAX_ALTERNATIVES = 4;
const MAX_FILTERED_OUT = 6;

export function toPayload(design: HarnessDesign, text: string): DesignPayload {
  const rec = design.recommendation;
  const handoff = handoffFor(design, text);
  return {
    summary: describeDesign(design),
    understood: design.understood,
    requirements: design.requirements.map((r) => ({
      text: r.text,
      // The runtime can point at the words this came from.
      grounded: r.span !== undefined,
      // The harness's own rule, not something the user said.
      baseline: r.status === "system_added",
      forbidden: r.polarity === "forbidden",
    })),
    confidence: design.confidence,
    demands: Object.fromEntries(
      Object.entries(design.profile.demands).filter(([, v]) => typeof v === "number"),
    ) as Record<string, number>,
    intents: design.intents,
    prohibitions: design.prohibitions.map((c) => c.kind),
    recommendation:
      rec === null
        ? null
        : {
            selected:
              rec.selected === null
                ? null
                : {
                    modelId: rec.selected.modelId,
                    score: rec.selected.score,
                    // The breakdown is the whole reason a score is trustworthy,
                    // and it was computed and then dropped here — leaving a
                    // number on screen with nothing behind it.
                    breakdown: { ...rec.selected.breakdown },
                    confidence: {
                      known: rec.selected.confidence.known,
                      total: rec.selected.confidence.total,
                      coldStart: rec.selected.confidence.coldStart,
                    },
                  },
            alternatives: rec.alternatives.slice(0, MAX_ALTERNATIVES).map((a) => ({
              modelId: a.modelId,
              score: a.score,
              coldStart: a.confidence.coldStart,
            })),
            // Code *and* sentence. Rendering only the detail lost the
            // difference between "strong at what you need" and "weak at it";
            // rendering only the code showed the user an enum.
            reasons: rec.reasons.map((r) => ({ code: r.code, detail: r.detail })),
            filteredOut: rec.filteredOut.slice(0, MAX_FILTERED_OUT).map((f) => ({
              modelId: f.modelId,
              code: f.code,
              detail: f.detail,
            })),
            // The real count, not the length of the truncated list. A panel that
            // showed six of nine and said nine were dropped is telling the
            // truth; one that said six is not.
            filteredOutTotal: rec.filteredOut.length,
            tiedWith: rec.tiedWith ?? [],
            ...(rec.unavailableReason === undefined
              ? {}
              : { unavailableReason: rec.unavailableReason }),
          },
    questions: design.questions.map((q) => ({ about: q.about, options: q.options })),
    handoff: {
      modelId: handoff.modelId,
      why: handoff.why,
      // The count rather than the list: the panel says how many, the modal that
      // opens on click says which. Showing both would put the same warning in
      // two places and let them drift.
      blockerCount: handoff.blockers.length,
    },
  };
}
