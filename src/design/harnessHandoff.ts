import type { HarnessDesign } from "./harnessDesign.ts";

/**
 * What the coding agent is started with, once a design has been read.
 *
 * The README says the agent takes over when the design is done. It did not:
 * the designer produced a report and the two halves of the product were two
 * commands with nothing between them, so a person who had just watched the
 * runtime read their request had to go and type it again somewhere else.
 *
 * ## The words, not the conclusions
 *
 * This carries the user's own text and one decision — which model — and
 * deliberately nothing else. Prohibitions, requirements and intents are all
 * re-derived by the agent from the same sentence with the same code, so
 * transferring them would create a second copy that can disagree with the text
 * it came from. A constraint that says "실행하지 마" is only trustworthy because
 * `statedProhibitions` reads it out of what the user wrote; a constraint handed
 * over as a conclusion is a claim about a sentence, and the one thing this
 * codebase refuses to do is let a claim outrank the sentence.
 *
 * The model is the exception because it is not in the sentence. It is the
 * design's own answer to a question the text does not contain, and without it
 * the agent falls back to `✨ Auto` and the recommendation the user just read
 * has no effect on anything.
 *
 * ## Nothing runs
 *
 * A handoff fills the composer and selects a model. It does not send. The
 * designer's promise is that nothing is executed while designing, and a button
 * that silently starts a run the moment a design finishes would break it at the
 * exact moment a person is least expecting it.
 */
export interface Handoff {
  /** The request, exactly as it was typed. */
  prompt: string;
  /** The recommended model, or null to leave the agent on its own chooser. */
  modelId: string | null;
  /** One line for the log and the confirmation, in the user's language. */
  why: string;
  /**
   * Reasons to decide something before starting, in the order they matter.
   *
   * Not a refusal. A person may hand off anyway — these are what the button
   * shows them first, because every one of them is something the agent will
   * otherwise have to guess at on their behalf.
   */
  blockers: string[];
}

/**
 * The handoff a finished design produces.
 *
 * `text` is passed in rather than read back out of the design: the design holds
 * what was *understood*, and what should reach the agent is what was *said*.
 * They are the same string today and the distinction is the point — a future
 * design that normalised or truncated its input would otherwise hand the agent
 * a request the user never made.
 */
export function handoffFor(design: HarnessDesign, text: string): Handoff {
  const blockers: string[] = [];

  if (!design.understood) {
    blockers.push("요구사항을 읽어내지 못했습니다. 그대로 넘기면 에이전트가 처음부터 다시 읽습니다.");
  }

  // Only what a person has to settle. A question the runtime could answer
  // itself would not have been asked.
  for (const question of design.questions) {
    blockers.push(`아직 정해지지 않았습니다: ${question.about}`);
  }

  const selected = design.recommendation?.selected ?? null;
  const tied = design.recommendation?.tiedWith ?? [];
  if (tied.length > 0) {
    // The ranker says so itself, and a caller that starts a run on the strength
    // of a tie is presenting an arbitrary pick as a decision.
    blockers.push(
      `점수가 같은 후보가 ${tied.length}개 있습니다 (${tied.join(", ")}). 추천은 이 중 하나일 뿐입니다.`,
    );
  }

  const why =
    selected === null
      ? design.recommendation === null
        ? "모델 목록이 없어 추천을 하지 않았습니다. 에이전트의 기본 선택을 씁니다."
        : "쓸 수 있는 모델이 없어 추천을 하지 않았습니다. 에이전트의 기본 선택을 씁니다."
      : `${selected.modelId} 를 추천합니다.`;

  return {
    prompt: text,
    modelId: selected?.modelId ?? null,
    why,
    blockers,
  };
}
