import type { Constraint, ConstraintKind, TaskContract, TurnIntent } from "./turnContract.ts";

/**
 * What this turn is allowed to do, given what was asked.
 *
 * A contract that only gets logged is a contract nobody keeps. This is where it
 * touches the loop: a user who says "코드는 수정하지 말고 분석만 해줘" gets a
 * runtime that refuses to write, not a model that remembers to.
 *
 * ## Two different strengths, deliberately
 *
 * **Constraints are enforced.** They are the user's words, classified by the
 * model into a small vocabulary, and "실행하지 마" means the command tool is not
 * available this turn. There is no reading of that instruction under which
 * running something is the helpful choice.
 *
 * **Intents are not enforced.** They are an interpretation, and interpretations
 * are wrong sometimes. A turn read as `present` that turns out to need a
 * `search_files` to find the file being asked about should do the search — a
 * hard denial there would produce an agent that cannot answer because it
 * decided in advance what answering would involve. The intent is passed to the
 * model as guidance, and its effect on behaviour comes from the prompt.
 *
 * The line between them is whether the user said it. That is also why the
 * `other` constraint kind exists and does nothing: a prohibition nobody could
 * classify is shown to the user and told to the model, but the runtime does not
 * invent an enforcement for it.
 */

/** Tools that change the workspace. */
const MUTATING: ReadonlySet<string> = new Set(["create_file", "write_file", "apply_patch", "delete_file"]);

/** Tools that run something. */
const EXECUTING: ReadonlySet<string> = new Set(["run_command"]);

/** Tools that leave the machine. */
const RESEARCHING: ReadonlySet<string> = new Set(["web_search", "web_fetch"]);

/**
 * Tools that exist to describe rather than to act.
 *
 * Never denied by a constraint. Recording the request, showing the plan and
 * reporting a blocker have to stay available precisely when the agent is being
 * restricted — otherwise a turn that cannot do what was asked also cannot say
 * so.
 */
const ALWAYS_ALLOWED: ReadonlySet<string> = new Set(["record_request", "update_plan", "report_blocked"]);

/**
 * Constraint kinds `deniesTool` can actually act on.
 *
 * Exported so nothing computes this twice. The panel used to keep its own copy
 * and the request tool implied a third, which is how a constraint could be
 * enforced in one place and described as enforced in another while the gate
 * ignored it. `other` and `must_execute` are absent on purpose — see
 * `deniesTool`.
 */
export const ENFORCEABLE_KINDS: ReadonlySet<ConstraintKind> = new Set<ConstraintKind>([
  "no_execute",
  "no_modify",
  "no_research",
  "present_only",
]);

export interface ToolVerdict {
  allowed: boolean;
  /** Shown to the user and given to the model. Quotes what is being honoured. */
  reason?: string;
}

/**
 * Whether a tool may run this turn.
 *
 * Called before approval, so a constraint the user stated in words is not
 * something they then have to decline in a modal.
 */
export function allowsTool(constraints: readonly Constraint[], toolName: string): ToolVerdict {
  if (ALWAYS_ALLOWED.has(toolName)) return { allowed: true };

  for (const constraint of constraints) {
    // A restriction the runtime established was the model's own invention,
    // recorded for the history and enforcing nothing. Never inferred here —
    // only `adoptResearchDecision` sets it, and only against the user's own
    // words. See `Constraint.quarantined`.
    if (constraint.quarantined === true) continue;
    const denial = deniesTool(constraint, toolName);
    if (denial !== null) {
      return {
        allowed: false,
        reason: `사용자가 "${constraint.text}"라고 하셔서 ${toolName}을(를) 쓰지 않았습니다.`,
      };
    }
  }
  return { allowed: true };
}

function deniesTool(constraint: Constraint, toolName: string): true | null {
  switch (constraint.kind) {
    case "no_execute":
      return EXECUTING.has(toolName) ? true : null;
    case "no_modify":
      return MUTATING.has(toolName) ? true : null;
    case "no_research":
      return RESEARCHING.has(toolName) ? true : null;
    case "present_only":
      // Show what is there and nothing else. Reading and searching stay open —
      // finding the thing to show is part of showing it.
      return MUTATING.has(toolName) || EXECUTING.has(toolName) ? true : null;
    case "must_execute":
    case "other":
      // `must_execute` is an obligation, not a prohibition; it belongs in the
      // prompt and in completion, not in a gate. `other` was not classified,
      // and inventing an enforcement for it would be guessing at what to forbid.
      return null;
  }
}

/** What each intent points the model at. Guidance, not a gate — see above. */
const INTENT_GUIDANCE: Readonly<Record<TurnIntent, string>> = {
  discuss: "이야기를 나누고 싶어 합니다. 필요한 만큼만 읽고, 도구 없이 답할 수 있으면 그렇게 하십시오.",
  inspect: "코드를 살펴보고 알려주기를 원합니다. read_file과 search_files로 충분합니다.",
  present:
    "결과물을 직접 보고 싶어 합니다. 해당 파일을 읽어 그 내용을 답변에 그대로 담으십시오. " +
    "내용을 보여주려고 명령을 실행할 필요는 없습니다.",
  modify: "파일을 고치기를 원합니다. 먼저 읽고, 고치고, 확인하십시오.",
  execute: "실행을 원합니다.",
  verify: "동작하는지 확인하기를 원합니다. 실제 테스트나 빌드를 돌리십시오 — 결과를 출력하는 명령이 아니라.",
  research: "밖에서 찾아보기를 원합니다. 사용자가 URL을 줬다면 그것을 먼저 여십시오.",
  continue: "하던 일을 이어가기를 원합니다. 새로 시작하지 말고, 남아 있는 것부터 하십시오.",
};

/**
 * What the model is told about this turn, before it chooses an action.
 *
 * Null when there is no contract — a turn nobody interpreted gets today's
 * behaviour rather than a guess dressed as policy.
 */
export function describeContract(contract: TaskContract): string | null {
  if (contract.lastTurnId.length === 0) return null;

  const lines: string[] = [];
  const active = contract.requirements.filter((r) => r.lifecycle === "active");

  lines.push(`이번 턴: ${contract.intents.join(" + ")} (${contract.relation})`);
  if (contract.goal.length > 0) lines.push(`목표: ${contract.goal}`);
  for (const intent of contract.intents) lines.push(INTENT_GUIDANCE[intent]);

  if (active.length > 0) {
    lines.push(
      "사용자가 요구한 것 (계획과 별개로 런타임이 보관합니다):\n" +
        active.map((r) => `- ${r.description}`).join("\n"),
    );
  }
  const deliverables = contract.deliverables.filter((d) => d.lifecycle === "active");
  if (deliverables.length > 0) {
    lines.push(`받아야 할 것: ${deliverables.map((d) => d.description).join(", ")}`);
  }
  if (contract.constraints.length > 0) {
    lines.push(
      "제약 (런타임이 강제합니다):\n" +
        contract.constraints.map((c) => `- ${c.text} [${c.kind}]`).join("\n"),
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Before anything is done: has the request been read?
// ---------------------------------------------------------------------------

/**
 * Actions that change something, cost something, or claim something.
 *
 * The line is not "dangerous". It is *substantive*: an action whose effect
 * outlives the turn, or which the user would be entitled to see justified by
 * what they asked for. Reading a file to work out what was meant is not on this
 * list, because that is how a request gets understood.
 */
const SUBSTANTIVE: ReadonlySet<string> = new Set([
  "create_file",
  "write_file",
  "apply_patch",
  "delete_file",
  "run_command",
  "web_search",
  "web_fetch",
  "generate_image",
  "generate_video",
]);

/**
 * Actions that need the request to have been read first.
 *
 * A superset of the one above, and the extra member is the plan. A plan is
 * persistent, task-affecting state — it is what the panel shows and what
 * coverage is measured against — so announcing a strategy before anything has
 * read the request is announcing one for a request nobody has stated.
 *
 * It is not in `SUBSTANTIVE` because that set answers a different question:
 * whether an action *acts on the world*, which is what `assessNecessity`
 * weighs. Planning during a turn that only asked to be shown some code is
 * perfectly sensible; running a command is the thing that needs asking about.
 */
const REQUIRES_CONTRACT: ReadonlySet<string> = new Set([...SUBSTANTIVE, "update_plan"]);

/** Machine-readable, so a caller can tell these apart from an ordinary refusal. */
export const TURN_CONTRACT_REQUIRED = "TURN_CONTRACT_REQUIRED";
/** The action was not run: it does not answer what this turn was asked for. */
export const ACTION_REQUIRES_JUSTIFICATION = "ACTION_REQUIRES_JUSTIFICATION";
/** The action was not run: the user forbade it in words. */
export const ACTION_DENIED_BY_CONSTRAINT = "ACTION_DENIED_BY_CONSTRAINT";

/**
 * Whether this turn may act yet.
 *
 * The gap this closes: everything the contract layer guarantees is guaranteed
 * only for turns that produced one. A model that skips `record_request` and
 * starts writing files gets the behaviour that existed before any of it — which
 * is not a fallback, it is the bug with extra steps.
 *
 * So substantive actions wait. Reading, searching, planning and reporting stay
 * open, because a model that cannot look at anything cannot work out what was
 * asked for either, and a gate that blocks understanding would force a guess.
 *
 * `null` means go ahead.
 */
export function requiresContract(
  contract: TaskContract,
  toolName: string,
  turnId: string,
): string | null {
  if (!REQUIRES_CONTRACT.has(toolName)) return null;
  // The contract has to be *this* turn's. One recorded three turns ago says
  // nothing about the message just received, and treating it as cover is how a
  // correction gets ignored.
  //
  // This one comparison is the canonical "has this turn's request been
  // recorded", and every other consumer derives from the same two values — see
  // `AgentSession.turnContractState`. It briefly had a `recordedThisTurn`
  // override beside it, so the session could answer for the gate; that was a
  // second way to compute one predicate, and the two agreeing was luck rather
  // than structure. The host now passes its turn id into `send`, so there is
  // one vocabulary and one comparison.
  if (contract.lastTurnId === turnId) return null;

  return (
    `${TURN_CONTRACT_REQUIRED}: 아직 이번 요청을 record_request로 정리하지 않았습니다. ` +
    `무엇을 요구받았는지 먼저 기록한 다음 ${toolName}을(를) 쓰십시오. ` +
    "읽기와 검색은 그 전에도 쓸 수 있습니다."
  );
}

// ---------------------------------------------------------------------------
// Whether an action is what this turn is for
// ---------------------------------------------------------------------------

/**
 * How well an action fits what was asked.
 *
 * Three levels rather than two, because the honest answer for most
 * intent/tool pairs is neither yes nor no. Running a command during a turn that
 * only asked to see some code is not forbidden — the file might be generated,
 * the user might have meant something the reading did not capture — but it is
 * not what was asked for either, and the model should be told so rather than
 * stopped.
 */
export type Necessity = "allow" | "requires_justification" | "deny";

export interface NecessityVerdict {
  necessity: Necessity;
  reason?: string;
}

/**
 * What the loop does with a proposed call.
 *
 * Three outcomes and only one of them runs anything. `requires_justification`
 * was a warning attached to a result, which meant the command had already run
 * by the time anyone objected — the failure it was written for happened anyway
 * and got a footnote. Deferring is the only version of it that is worth having.
 */
export interface ActionDecision {
  decision: Necessity;
  /** Machine-readable, first token. Present when the call did not run. */
  code?: string;
  reason?: string;
}

/**
 * Whether a proposed call runs, and why not when it does not.
 *
 * The one place the loop asks. Order is deliberate: a constraint the user
 * stated outranks everything, then a turn nobody has read may not act at all,
 * then an action that does not answer what was asked is held back.
 *
 * A model cannot argue past any of these. Asserting that a command is necessary
 * is not evidence that it is — the contract is what the user said, and only a
 * new contract changes what this turn is for. The way forward from a deferral
 * is a different action or `report_blocked`, not a better sentence.
 */
export function decideAction(
  contract: TaskContract,
  toolName: string,
  turnId: string,
): ActionDecision {
  const hard = allowsTool(contract.constraints, toolName);
  if (!hard.allowed) {
    return {
      decision: "deny",
      code: ACTION_DENIED_BY_CONSTRAINT,
      ...(hard.reason === undefined ? {} : { reason: hard.reason }),
    };
  }

  const missing = requiresContract(contract, toolName, turnId);
  if (missing !== null) {
    return { decision: "deny", code: TURN_CONTRACT_REQUIRED, reason: missing };
  }

  const necessity = assessNecessity(contract, toolName);
  if (necessity.necessity === "requires_justification") {
    return {
      decision: "requires_justification",
      code: ACTION_REQUIRES_JUSTIFICATION,
      ...(necessity.reason === undefined ? {} : { reason: necessity.reason }),
    };
  }
  return { decision: "allow" };
}

/** The sentence the model reads when a call is held back. */
export function describeDeferral(decision: ActionDecision, toolName: string, contract: TaskContract): string {
  const deliverables = contract.deliverables
    .filter((d) => d.lifecycle === "active")
    .map((d) => d.description);
  return [
    `${decision.code}: ${toolName}을(를) 실행하지 않았습니다.`,
    decision.reason ?? "",
    deliverables.length === 0
      ? ""
      : `이번 요청이 받아야 할 것: ${deliverables.join(", ")}.`,
    "필요하다고 주장하는 것만으로는 실행되지 않습니다 — 사용자가 요청한 것이 기준입니다. " +
      "요청을 만족시키는 다른 행동을 고르거나, 그것 없이는 불가능하면 report_blocked로 알리십시오.",
  ]
    .filter((line) => line.length > 0)
    .join(" ");
}

/** Intents for which acting on the workspace is beside the point. */
const PASSIVE_INTENTS: ReadonlySet<TurnIntent> = new Set(["present", "inspect", "discuss"]);

/**
 * Whether this tool is what the turn is for.
 *
 * `deny` comes only from a constraint the user stated — see `allowsTool`, which
 * this delegates to. Everything else is guidance with a volume knob.
 */
export function assessNecessity(contract: TaskContract, toolName: string): NecessityVerdict {
  const hard = allowsTool(contract.constraints, toolName);
  if (!hard.allowed) return { necessity: "deny", ...(hard.reason === undefined ? {} : { reason: hard.reason }) };

  if (contract.intents.length === 0) return { necessity: "allow" };

  const passiveOnly = contract.intents.every((intent) => PASSIVE_INTENTS.has(intent));
  const acts = SUBSTANTIVE.has(toolName);
  if (passiveOnly && acts) {
    return {
      necessity: "requires_justification",
      reason:
        `이번 요청은 ${contract.intents.join("+")}입니다. ${toolName}은(는) 요청을 만족시키는 데 ` +
        "필요하지 않을 수 있습니다 — 파일을 읽어 그 내용을 답변에 담는 것으로 충분한지 " +
        "먼저 확인하십시오.",
    };
  }
  return { necessity: "allow" };
}
