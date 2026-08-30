import { previewDesign, type PreviewResult, type Proposer } from "./preview.ts";
import { questionsFrom, type Question } from "./previewReport.ts";
import type { RequirementSpec } from "./requirementSpec.ts";
import { projectTaskProfile } from "../router/taskProfile.ts";
import type { TaskProfile } from "../router/taskProfile.ts";
import { recommendModel, type ModelRecommendation } from "../router/recommend.ts";
import type { ModelProfile } from "../router/modelProfile.ts";
import { prohibitionsIn } from "../agent/statedProhibitions.ts";
import {
  emptyContract,
  mergeContract,
  statedResearchDemand,
  type Constraint,
  type Requirement,
  type TaskContract,
  type TurnIntent,
} from "../agent/turnContract.ts";

/**
 * One request in, one harness design out.
 *
 * The pieces this joins have existed for a while and never met in one place: the
 * design engine reads a request into requirements and says what is still
 * unresolved, and the router ranks models against a task profile. Between them
 * sat a gap nobody could see from either side — the design engine did not know
 * which model would run its plan, and the router was only ever asked *during* a
 * turn, by the runtime, about a request the user had already committed to.
 *
 * Answering both at once is a different product from either half:
 *
 *     requirements  →  what the runtime can and cannot pin down
 *                   →  which model this shape of work asks for, and why
 *                   →  what is still unanswered, offered as questions
 *
 * ## It designs; it does not run
 *
 * Nothing here writes a file, runs a command or starts a turn. The only
 * outbound request is the optional `propose` call the design preview already
 * makes, and omitting it leaves a complete offline answer — the deterministic
 * extractor is not a degraded mode, it is the half the runtime can stand
 * behind.
 *
 * ## The contract is synthesised, not interpreted
 *
 * `projectTaskProfile` wants a `TaskContract`, which normally comes from a
 * model reading the request. Asking a model here would make the recommendation
 * depend on a model call to decide which model to call, and would put the
 * designer behind a network round trip for a question the runtime can mostly
 * answer itself. So the contract is built from what the deterministic layer
 * already established: the acts it read out of the verbs, and the prohibitions
 * it read out of the user's own words.
 *
 * That is a weaker reading than the interpreter's and is treated as one —
 * `confidence` says which requirements the runtime could point at words for,
 * and the panel shows it rather than hiding it behind a single number.
 */

/** How far the runtime could get on its own, per requirement. */
export interface DesignConfidence {
  /** Requirements cut from the user's own words, with coordinates. */
  grounded: number;
  /** Requirements read from the user but with no coordinates to point at. */
  ungrounded: number;
  /** The harness's own rules, which the user did not ask for. */
  baseline: number;
  /** Requirements still carrying something unresolved. */
  unresolved: number;
}

export interface HarnessDesign {
  /** What the design engine made of the request. The full record. */
  preview: PreviewResult;
  /** The requirements a person should read, in the order they were stated. */
  requirements: RequirementSpec[];
  /**
   * Whether the runtime read anything at all out of the user's own words.
   *
   * False for a pleasantry, for a sentence in a language the extractor has no
   * pass for, and for any phrasing it does not recognise. It is the difference
   * between "you asked me to look at something" and "I could not read this",
   * which the design used to report identically — both arrived as
   * `intents: ["inspect"]` over two baseline requirements, and one of them was
   * a lie.
   */
  understood: boolean;
  /** What this shape of work demands of a model. */
  profile: TaskProfile;
  /**
   * Which model the router would pick, and why — or why none survived.
   *
   * Null when no model list was supplied, which is a different thing from
   * "nothing was eligible": the first is a question nobody asked, the second is
   * an answer. The panel says so.
   */
  recommendation: ModelRecommendation | null;
  /** What the runtime could not settle, offered rather than guessed. */
  questions: Question[];
  confidence: DesignConfidence;
  /** The intents the runtime read out of the request, for showing its working. */
  intents: TurnIntent[];
  /** Prohibitions read from the user's own words. Never from a model. */
  prohibitions: Constraint[];
}

/**
 * What each act the extractor recognises asks of a turn.
 *
 * The same vocabulary `INTENT_DEMAND` is keyed on, so a design and a live turn
 * project onto the same profile. `preserve` is deliberately absent: keeping
 * something as it is asks for nothing to be done, and mapping it to an intent
 * would raise a demand for work the user asked *not* to happen.
 */
const ACT_INTENT: Readonly<Record<string, TurnIntent>> = {
  modify: "modify",
  create: "modify",
  remove: "modify",
  execute: "execute",
  verify: "verify",
  inspect: "inspect",
};

/** Prohibition classes, as the constraint kinds the gate already understands. */
const PROHIBITION_KIND: Readonly<Record<string, Constraint["kind"]>> = {
  execute: "no_execute",
  modify: "no_modify",
  research: "no_research",
};

/**
 * A contract built from what the runtime established, not from a model.
 *
 * Every requirement here carries `origin: "inferred"` even when it was cut from
 * the user's own words, because the *reading* is the runtime's. Nothing
 * downstream should mistake this for the interpreter's contract: this one exists
 * to be projected into a profile, and a design is allowed to be provisional in
 * a way a running turn is not.
 */
function synthesiseContract(
  text: string,
  requirements: readonly RequirementSpec[],
): { contract: TaskContract; intents: TurnIntent[]; prohibitions: Constraint[] } {
  const turnId = "design";
  const intents = new Set<TurnIntent>();
  const items: Requirement[] = [];

  for (const [index, spec] of requirements.entries()) {
    if (spec.polarity === "forbidden") continue;
    // The harness's own baselines are not what the user asked for, and putting
    // them in the contract moved the complexity band on 53 of 76 corpus cases:
    // every request looked like it had two more requirements than it did, and
    // `projectTaskProfile` raises `recovery`/`multiTurnContinuity` once a
    // contract passes three. They are kept in `design.requirements` for the
    // panel to show, apart, and out of the profile that ranks models.
    if (spec.status === "system_added") continue;
    const intent = spec.act === undefined ? undefined : ACT_INTENT[spec.act];
    if (intent !== undefined) intents.add(intent);
    items.push({
      id: `${turnId}-r${index + 1}`,
      description: spec.text,
      required: spec.priority === "must",
      provenance: {
        sourceTurnId: turnId,
        origin: "inferred",
        ...(spec.sourceText.length === 0 ? {} : { sourceText: spec.sourceText }),
      },
      lifecycle: "active",
    });
  }

  const prohibitions: Constraint[] = [...prohibitionsIn(text)].map((klass) => ({
    kind: PROHIBITION_KIND[klass] ?? "other",
    text,
    sourceTurnId: turnId,
  }));
  const forbidden = new Set(prohibitions.map((c) => c.kind));

  // Going outside the workspace is named in a request rather than acted out by
  // it, so it is read from the words — with the runtime's own hardened reader,
  // not a second noun scan of this module's own. The local one matched domain
  // words: "로그인 오류를 수정하고 테스트해줘" asks for no web at all, and a bare
  // `검색해`/`최신` alternative made the design demand webResearch 0.9 of every
  // model for a pure coding chore. `statedResearchDemand` reads clause by
  // clause and never inside a prohibition.
  //
  // The `forbidden` guard stays beside it. The two catch different failures —
  // one is a structural clause guard, the other a class the pattern layer
  // recognised — and a request that forbids the web must not demand it under
  // either reading.
  if (statedResearchDemand(text) !== null && !forbidden.has("no_research")) intents.add("research");

  // Nothing is subtracted here.
  //
  // Two lines used to delete `execute` and `modify` when the request also
  // forbade them, and that produced a design contradicting its own requirement
  // list: "README를 고쳐줘. 다른 파일은 수정하지 마." kept "README를 수정한다"
  // among its requirements while the profile carried no coding demand at all,
  // so the router was asked to staff a modification with a model chosen for
  // reading. Both halves are true at once — the user wants one file changed and
  // the others left alone — and the way to honour that is the constraint, which
  // reaches the router as `constraints.noModify` and filters rather than scores.
  // The design phase runs nothing, so keeping the intent authorises nothing.

  // A request that names no act at all is still a request to look at something.
  if (intents.size === 0) intents.add("inspect");

  const contract = mergeContract(emptyContract(), {
    turnId,
    relation: "new_task",
    goal: text.slice(0, 200),
    intents: [...intents],
    requirements: items,
    deliverables: [],
    constraints: prohibitions,
  });
  return { contract, intents: [...intents], prohibitions };
}

export interface DesignHarnessInput {
  /** What the user typed. One request, in their own words. */
  text: string;
  /**
   * The models to rank. Omitted means no recommendation is attempted, and the
   * result says so rather than reporting that nothing was eligible.
   */
  models?: readonly ModelProfile[];
  /** The optional model pass the design preview already supports. */
  propose?: Proposer;
  signal?: AbortSignal;
}

/**
 * Designs a harness for one request.
 *
 * Offline unless `propose` is supplied. Never writes, never executes.
 */
export async function designHarness(input: DesignHarnessInput): Promise<HarnessDesign> {
  const preview = await previewDesign({
    turns: [input.text],
    ...(input.propose === undefined ? {} : { propose: input.propose }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  const standing = preview.requirements;
  // What the user actually asked for, as opposed to the rules the harness
  // brings to every request. The distinction decides almost everything below:
  // it is the profile's input, the requirement count the user is shown, and
  // whether there is anything here to recommend a model for.
  const stated = standing.filter((r) => r.status !== "system_added");
  const understood = stated.length > 0;

  const { contract, intents, prohibitions } = synthesiseContract(input.text, standing);
  const profile = projectTaskProfile(contract);

  // A recommendation is a claim about what the work needs. With nothing read
  // from the request there is no work to characterise, and ranking models
  // against the harness's own baselines produced a confident pick for
  // "고마워" and for every English sentence — the profile was the same one
  // every unread request gets, so the answer was the same too. Saying nothing
  // was read is the honest output, and the panel prints it.
  const recommendation =
    !understood || input.models === undefined || input.models.length === 0
      ? null
      : await recommendModel(profile, input.models);

  const questions = questionsFrom(preview);
  // Questions carry the requirement's *id* as their subject — see
  // `questionsFrom`, where every askable finding is stamped with `spec.id`.
  // Keying on the text instead meant the set never intersected and the field
  // was zero on all 76 corpus cases, including the 16 that raise a question.
  const unresolvedSubjects = new Set(questions.map((q) => q.subject));

  return {
    preview,
    requirements: standing,
    understood,
    profile,
    recommendation,
    questions,
    confidence: {
      grounded: stated.filter((r) => r.span !== undefined).length,
      // The harness's own rules, counted apart rather than as something the
      // user might have said.
      ungrounded: stated.filter((r) => r.span === undefined).length,
      baseline: standing.length - stated.length,
      unresolved: standing.filter((r) => unresolvedSubjects.has(r.id)).length,
    },
    intents,
    prohibitions,
  };
}

/**
 * The design in one line, for a caller that only has room for one.
 *
 * Says what was recommended *and* what is unresolved, because a recommendation
 * over an unsettled design is a suggestion rather than a decision and the
 * sentence should not read as the latter.
 */
export function describeDesign(design: HarnessDesign): string {
  const model = design.recommendation?.selected?.modelId ?? null;
  const parts: string[] = [];
  if (!design.understood) {
    // Said first and said plainly. Everything after this sentence would be an
    // answer about a request nobody read.
    return "이 요청에서 요구사항을 읽지 못했습니다";
  }
  // The user's own, not the harness's baselines — those are counted apart in
  // `confidence.baseline`, and reporting them here told someone whose request
  // produced nothing that it had produced two requirements.
  const stated = design.requirements.filter((r) => r.status !== "system_added").length;
  parts.push(`요구사항 ${stated}건`);
  if (model !== null) parts.push(`추천 ${model}`);
  else if (design.recommendation !== null) parts.push("추천 가능한 모델 없음");
  else parts.push("모델 목록 없음");
  if (design.questions.length > 0) parts.push(`확인 필요 ${design.questions.length}건`);
  return parts.join(" · ");
}
