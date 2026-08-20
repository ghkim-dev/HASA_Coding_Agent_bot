import type { SessionEvent } from "./sessionEvents.ts";
import {
  significantWords,
  type Requirement,
  type TaskContract,
  type TurnContract,
  type TurnRelation,
} from "./turnContract.ts";
import type { TaskState } from "./taskState.ts";

/**
 * The runtime's own reading of how a follow-up message relates to the task.
 *
 * The failure this exists for, from a real transcript: the user asked for a
 * cat/dog classification project, then wrote "작업 진행해줘" — and the
 * interpreter, shown only that sentence, recorded a *new task* with a fresh
 * paraphrase of the requirements. `mergeContract` did exactly what a new task
 * asks: it replaced everything. Ten requirements became one, the plan started
 * over at step 1, and every later follow-up repeated the cycle. The user was
 * re-explaining their request every turn without knowing it.
 *
 * The relation is the one field of the contract where the model's mistake is
 * not contained: a wrong requirement adds noise, a wrong `new_task` erases the
 * task. So the runtime reads the user's own words too — the same precedent as
 * `statedProhibitions.ts`, and the same rule:
 *
 *   a boundary whose inputs come only from the thing it guards against
 *   is not a boundary.
 *
 * ## What this deliberately is not
 *
 * It is not an interpreter. It recognises a handful of unmistakable shapes —
 * "진행해줘", "다시 실행해봐", "진행된 게 없는데" — and only ever *downgrades*
 * a relation away from `new_task`. A message it does not recognise keeps the
 * model's reading. A genuinely new task stated mid-conversation is left alone,
 * because its sentence does not look like any of these.
 */

// ---------------------------------------------------------------------------
// The shapes the runtime can read for itself
// ---------------------------------------------------------------------------

/**
 * A bare "carry on" — a message that adds no new requirement by construction.
 *
 * Anchored to the whole message, not searched within it: "현재 디렉토리에서
 * 진행해줘" carries a workspace refinement and must not match, while "작업
 * 진행해줘" carries nothing but the instruction to keep going. The length guard
 * is the second lock on the same door — a sentence long enough to say something
 * new is long enough to be left to the model.
 */
const CONTINUATION_SHAPES: readonly RegExp[] = [
  /^(?:그럼\s*)?(?:작업|계속|마저)?\s*(?:진행|계속)\s*(?:해|하|합시다|하자)?\s*(?:줘|주세요|봐|바|요)?$/,
  /^이어서\s*(?:진행|계속|작업)?\s*(?:해\s*줘|해\s*주세요|해|하자)?$/,
  /^(?:다시|재)\s*(?:실행|시도|돌려|해)\s*(?:해\s*)?(?:봐|줘|보세요|주세요)?$/,
  /^알아서\s*(?:해|진행해|실행해|계속해)\s*(?:줘|주세요)?$/,
  /^(?:continue|proceed|go\s*ahead|keep\s*going|resume)$/i,
];

/** Punctuation and filler that do not change what a short message says. */
function bareText(text: string): string {
  return text.trim().replace(/[.!?~…]+$/u, "").trim();
}

export function isBareContinuation(text: string): boolean {
  const body = bareText(text);
  if (body.length === 0 || body.length > 30) return false;
  return CONTINUATION_SHAPES.some((shape) => shape.test(body));
}

/**
 * A question about where the work stands, not an instruction to do more of it.
 *
 * Two locks, both required. The message must match a status shape — asking what
 * happened, whether anything happened, or whether work is underway — and it
 * must not contain a verb that commissions new work. "진행된 게 없는데 다시
 * 확인해줘" is a status question; "진행된 게 없는데 CNN부터 구현해줘" is not,
 * and the second lock is what keeps it out.
 */
const STATUS_SHAPES: readonly RegExp[] = [
  /진행\s*(?:된|한)\s*(?:게|것|거)?\s*없/,
  /(?:어디까지|얼마나)\s*(?:했|됐|진행)/,
  /(?:하고|되고)\s*있는\s*(?:게|것|거)?\s*맞(?:지|아|나요|습니까)?/,
  /(?:현재|지금)\s*(?:상태|상황|진행)\s*(?:이\s*)?(?:어때|어떻게|알려|보여|확인)/,
  /진행\s*(?:상황|상태)\s*(?:좀)?\s*(?:알려|확인|보여)/,
  /(?:what(?:'s|\s+is)\s+the\s+)?(?:status|progress)\s*\?/i,
];

/** Verbs that commission work. A message carrying one is a request, not a question. */
const COMMISSIONS_WORK =
  /구현|수정(?!된)|추가|삭제|설치|만들|작성|생성|학습(?:해|시켜|을\s*시작)|다운로드(?:해|받)|실행해|돌려\s*줘|고쳐/;

export function isStatusQuestion(text: string): boolean {
  const body = text.trim();
  if (body.length === 0 || body.length > 120) return false;
  if (COMMISSIONS_WORK.test(body)) return false;
  return STATUS_SHAPES.some((shape) => shape.test(body));
}

/**
 * The user telling the agent it is repeating itself instead of working.
 *
 * "알아서 실행해달라니까 왜 반복하는 거야" is a correction — of the agent's
 * behaviour, not of the request — and reading it as a new task is precisely the
 * repetition being complained about, done once more.
 */
const REPETITION_COMPLAINT =
  /왜\s*(?:반복|또|자꾸|계속\s*(?:같은|묻|물어))|(?:라니까|라고\s*했(?:잖아|는데))|(?:same|again)\s*\?|why\s+(?:do\s+you\s+)?(?:keep|repeat)/i;

export function isRepetitionComplaint(text: string): boolean {
  const body = text.trim();
  return body.length > 0 && body.length <= 120 && REPETITION_COMPLAINT.test(body);
}

// ---------------------------------------------------------------------------
// The relation guard
// ---------------------------------------------------------------------------

/** Why the runtime overrode the model's relation, for the record. */
export interface RelationOverride {
  from: TurnRelation;
  to: TurnRelation;
  reason: "bare_continuation" | "status_question" | "repetition_complaint" | "same_task_restated";
  /** Requirement descriptions dropped because the user's message did not state them. */
  droppedRequirements: string[];
}

/**
 * Whether a "new" task is the standing task said again.
 *
 * The transcript's signature move: a follow-up misread as `new_task` arrives
 * carrying a paraphrase of the requirements the task already has, and accepting
 * it replaces the originals with the paraphrase — same words, fresh statuses,
 * lost history. Matching is by word overlap, the same vocabulary
 * `planCoverage` uses, and it is deliberately demanding: *most* of the incoming
 * requirements must each mostly re-state an existing one. A genuinely new task
 * shares a couple of words with the old one; a restatement shares most of them.
 */
export function looksLikeSameTask(
  existing: readonly Requirement[],
  incoming: readonly Requirement[],
): boolean {
  const active = existing.filter((r) => r.lifecycle === "active");
  if (active.length === 0 || incoming.length === 0) return false;

  const existingWords = active.map((r) => new Set(significantWords(r.description)));
  let restated = 0;
  for (const requirement of incoming) {
    const words = significantWords(requirement.description);
    if (words.length === 0) continue;
    const overlap = existingWords.some((set) => {
      const hits = words.filter(
        (word) => set.has(word) || [...set].some((w) => w.startsWith(word) || word.startsWith(w)),
      ).length;
      return hits / words.length >= 0.6;
    });
    if (overlap) restated += 1;
  }
  return restated / incoming.length >= 0.6;
}

/**
 * Reads the user's own words beside the model's relation, and keeps the safer one.
 *
 * Only ever downgrades away from a task reset — `new_task` to `continue`,
 * `question` or `correct`, or a status question read as work back to
 * `question`. It never invents `new_task` and never adds a requirement, so the
 * worst it can do wrongly is make one turn accumulate instead of replace —
 * recoverable by saying "새 작업이야" — while the mistake it prevents silently
 * erases every requirement the task has.
 *
 * The corrected contract is what gets recorded, so a replay folds exactly what
 * the live run folded. The override rides beside it for the record.
 */
export function guardRelation(
  contract: TurnContract,
  opts: { userText: string; priorTask: TaskContract },
): { contract: TurnContract; override: RelationOverride | null } {
  const hasPriorTask = opts.priorTask.lastTurnId.length > 0;
  if (!hasPriorTask) return { contract, override: null };

  const dropped = contract.requirements.map((r) => r.description);
  const demote = (
    to: TurnRelation,
    reason: RelationOverride["reason"],
  ): { contract: TurnContract; override: RelationOverride } => ({
    contract: {
      ...contract,
      relation: to,
      // The standing goal, not the model's restatement of it. A `correct` merge
      // takes the incoming goal, and "요청 처리" replacing the user's own
      // sentence is a small version of the reset being prevented. Never empty:
      // `readTurnContract` refuses a goalless contract on replay, and a
      // contract that folds live but not replayed breaks the one invariant
      // `reduceContract` exists for.
      goal: opts.priorTask.goal.length > 0 ? opts.priorTask.goal : contract.goal,
      // The user's message stated no requirement — these are the model's
      // paraphrase of a task that already exists, and merging them would
      // duplicate or, under `new_task`, replace the originals.
      requirements: [],
      deliverables: [],
    },
    override: { from: contract.relation, to, reason, droppedRequirements: dropped },
  });

  // A status question is answered from the record whatever the model called
  // it. Checked first because it also matches some continuation shapes.
  if (isStatusQuestion(opts.userText) && contract.relation !== "question") {
    return demote("question", "status_question");
  }

  if (contract.relation !== "new_task") return { contract, override: null };

  if (isBareContinuation(opts.userText)) return demote("continue", "bare_continuation");
  if (isRepetitionComplaint(opts.userText)) return demote("correct", "repetition_complaint");

  if (looksLikeSameTask(opts.priorTask.requirements, contract.requirements)) {
    // Restated, not new. `refine` keeps every standing requirement and lets
    // `addNew` drop the duplicates by description.
    return {
      contract: { ...contract, relation: "refine" },
      override: {
        from: "new_task",
        to: "refine",
        reason: "same_task_restated",
        droppedRequirements: [],
      },
    };
  }

  return { contract, override: null };
}

// ---------------------------------------------------------------------------
// History for the interpreter
// ---------------------------------------------------------------------------

/** How much of the conversation the interpreter is shown. Enough to see the task. */
const HISTORY_TURN_LIMIT = 6;
const HISTORY_TEXT_LIMIT = 600;

/**
 * The prior conversation, in the shape `interpretRequest` accepts.
 *
 * The whole reason relation classification failed: the interpreter was handed
 * "작업 진행해줘" and nothing else, so "how does this relate to what came
 * before" was a question about an invisible referent. The option to pass
 * history existed from the start — this builds it from the events that were
 * already being recorded.
 *
 * User messages verbatim (clipped); assistant turns as their final summary. No
 * tool output and no reasoning — the interpreter classifies the conversation's
 * shape, and sixty lines of test output is not shape.
 */
export function bootstrapHistoryFrom(
  events: readonly SessionEvent[],
): Array<{ role: "user" | "assistant"; content: string }> {
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const event of events) {
    if (event.type === "user_message") {
      history.push({ role: "user", content: clip(event.text) });
    } else if (event.type === "run_completed" && event.summary.trim().length > 0) {
      history.push({ role: "assistant", content: clip(event.summary) });
    }
  }
  // The most recent turns carry the live task; older ones age out.
  return history.slice(-HISTORY_TURN_LIMIT * 2);
}

function clip(text: string): string {
  const body = text.trim();
  return body.length > HISTORY_TEXT_LIMIT ? `${body.slice(0, HISTORY_TEXT_LIMIT)}…` : body;
}

// ---------------------------------------------------------------------------
// Status questions answered from the record
// ---------------------------------------------------------------------------

/**
 * What actually ran, counted from the events rather than from anyone's prose.
 *
 * `record_request`, `update_plan` and `report_blocked` say things; they do not
 * do things. Counting them as executed work is how "진행된 게 없는데" gets
 * answered with a list of three actions none of which touched the world.
 */
const DECLARATIVE_TOOLS: ReadonlySet<string> = new Set([
  "record_request",
  "update_plan",
  "report_blocked",
]);

export interface ExecutionCounts {
  /** Tool calls that reached a tool and ran, substantive tools only. */
  executed: number;
  /** Of those, how many failed. */
  failed: number;
  filesChanged: number;
}

export function executionCounts(events: readonly SessionEvent[]): ExecutionCounts {
  let executed = 0;
  let failed = 0;
  const files = new Set<string>();
  for (const event of events) {
    if (event.type === "file_changed") files.add(event.path);
    if (event.type !== "tool_completed" || DECLARATIVE_TOOLS.has(event.toolName)) continue;
    const ran =
      event.disposition === "executed_success" || event.disposition === "executed_failure"
        ? true
        : event.disposition === undefined && (event.status === "success" || event.status === "failed");
    if (!ran) continue;
    executed += 1;
    if (event.disposition === "executed_failure" || event.status === "failed") failed += 1;
  }
  return { executed, failed, filesChanged: files.size };
}

/**
 * The answer to "어디까지 했어", written by the runtime from its own record.
 *
 * The failing transcript answered this question by running the worker again,
 * which re-recorded the request and re-printed the plan — the user asked
 * whether anything had happened and the answer was to make more of the nothing
 * they were asking about. This is the other path: no model, no new plan, the
 * record read out loud. Between turns nothing the runtime started is still
 * running — commands run inside a turn — so that fact is stated rather than
 * left for the user to infer from silence.
 */
export function statusAnswerFrom(events: readonly SessionEvent[], task: TaskState | null): string {
  const counts = executionCounts(events);
  const lines: string[] = [];

  if (counts.executed === 0 && counts.filesChanged === 0) {
    lines.push(
      "아직 실행된 작업이 없습니다. 지금까지는 요청 해석과 계획만 기록되어 있습니다.",
    );
  } else {
    lines.push(
      `지금까지 도구를 ${counts.executed}회 실행했고` +
        `${counts.failed > 0 ? ` (그중 ${counts.failed}회 실패)` : ""}, ` +
        `파일 ${counts.filesChanged}개가 변경되었습니다.`,
    );
  }
  lines.push("실행 중인 프로세스는 없습니다 — 명령은 턴 안에서만 실행됩니다.");

  if (task !== null && task.requirements.length > 0) {
    const by = (status: string): string[] =>
      task.requirements.filter((r) => r.status === status).map((r) => r.description);
    const section = (label: string, items: string[]): void => {
      if (items.length > 0) lines.push(`${label}: ${items.join(", ")}`);
    };
    section("확인됨", by("passed"));
    section("실패", by("failed"));
    section("막힘", by("blocked"));
    section("아직 실행 안 함", [...by("pending"), ...by("in_progress")]);
    const open = task.issues.filter((i) => i.status === "open");
    if (open.length > 0) {
      lines.push(`미해결 오류: ${open.map((i) => `${i.summary} — ${i.detail}`).join("; ")}`);
    }
  }

  lines.push("이 요약은 런타임 기록에서 작성되었습니다. 계속하려면 어떤 작업부터 할지 알려 주세요.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Progress across turns
// ---------------------------------------------------------------------------

/** How many barren turns in a row earn the worker a challenge at turn start. */
export const BARREN_TURN_CHALLENGE_AT = 2;

interface TurnSlice {
  events: SessionEvent[];
  completed: boolean;
}

function turnsOf(events: readonly SessionEvent[]): TurnSlice[] {
  const turns: TurnSlice[] = [];
  let current: TurnSlice | null = null;
  for (const event of events) {
    if (event.type === "user_message") {
      current = { events: [], completed: false };
      turns.push(current);
    }
    if (current === null) continue;
    current.events.push(event);
    if (event.type === "run_completed") current.completed = true;
  }
  return turns;
}

/** Whether this turn was asked to act rather than to answer. */
function turnWasWork(slice: TurnSlice): boolean {
  for (const event of slice.events) {
    if (event.type !== "turn_contract") continue;
    const contract = event.contract as { intents?: unknown } | null;
    const intents = Array.isArray(contract?.intents) ? (contract.intents as string[]) : [];
    return intents.some((i) => i === "modify" || i === "execute" || i === "verify");
  }
  // No contract on record: judged by whether anything at all was proposed.
  return slice.events.some((e) => e.type === "tool_started");
}

/**
 * Turns that were asked to act and acted on nothing, counted from the tail.
 *
 * The in-turn stall detector cannot see this pattern: each of these turns ended
 * `finished` with a plan and no action, its `ProgressState` reset with the run,
 * and the loop began again only because the user typed "진행해줘" once more.
 * Progress across turns is a fact about the conversation, so it is counted
 * where the conversation lives.
 */
export function barrenWorkTurns(events: readonly SessionEvent[]): number {
  const turns = turnsOf(events).filter((t) => t.completed);
  let barren = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const slice = turns[i]!;
    if (!turnWasWork(slice)) break;
    const counts = executionCounts(slice.events);
    if (counts.executed > 0 || counts.filesChanged > 0) break;
    barren += 1;
  }
  return barren;
}

/**
 * What the worker is told when the last turns produced words and no work.
 *
 * Injected at turn start rather than after three more empty actions, because
 * the pattern is already established — the challenge names it and names the
 * ways out, the same three `describeStall` offers.
 */
export function barrenTurnChallenge(events: readonly SessionEvent[]): string | null {
  const barren = barrenWorkTurns(events);
  if (barren < BARREN_TURN_CHALLENGE_AT) return null;
  return (
    `직전 ${barren}개 턴에서 실행된 도구가 없습니다. 계획을 다시 쓰거나 진행 상황을 ` +
    "요약하는 것은 진전이 아닙니다. 이번 턴에는 실제 도구를 호출해 작업을 진행하거나, " +
    "막힌 이유를 report_blocked로 알리거나, 할 수 없는 이유를 사용자에게 그대로 답하십시오."
  );
}

// ---------------------------------------------------------------------------
// Contradictions between what was said, turn to turn
// ---------------------------------------------------------------------------

/** A claim about the task's state that a later claim reversed without evidence. */
export interface StateContradiction {
  /** The words the two claims share — which piece of work they disagree about. */
  subject: string;
  claimedDoneAt: string;
  reversedAt: string;
}

const CLAIMED_DONE =
  /(완료|완성|끝났|끝냈|마쳤|성공적으로|다운로드했|설치했|구현했|학습(?:이|을)?\s*(?:완료|마쳤)|completed?|finished|downloaded|installed|implemented)/i;
const CLAIMED_NOT_STARTED =
  /(아직|시작\s*(?:전|하지)|되지\s*않|안\s*됐|없습니다|못했|not\s+yet|has\s+not|hasn'?t|didn'?t)/i;

/**
 * Words worth comparing across sentences, with their particles removed.
 *
 * "다운로드를" and "다운로드가" are one word wearing two case markers, and the
 * whole point of the comparison is that the two sentences talk about the same
 * thing. The same stripping `finalClaims.tokens` does, for the same reason.
 */
function subjectWords(text: string): Set<string> {
  return new Set(
    significantWords(text)
      .map((word) => word.replace(/[을를이가은는의에서도]$/u, ""))
      .filter((word) => word.length >= 2),
  );
}

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?다요])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Where the model's account of the task flipped with nothing in between.
 *
 * "다운로드 완료" in one turn and "아직 다운로드 전" in the next is not the
 * state flipping — the state never moved, because prose cannot move it. It is
 * the *story* flipping, and the record keeps which turn told which half. A
 * contradiction needs the two sentences to be about the same thing, which is
 * asked the same way `planCoverage` asks it: shared significant words.
 *
 * Evidence between the two claims clears the pair: a download that really
 * failed after really succeeding has an observation in the middle.
 */
export function stateContradictions(events: readonly SessionEvent[]): StateContradiction[] {
  interface Claim {
    turnId: string;
    at: number;
    words: Set<string>;
    sentence: string;
  }
  const doneClaims: Claim[] = [];
  const found: StateContradiction[] = [];
  const evidenceTimes: number[] = [];

  for (const event of events) {
    if (event.type === "tool_completed" && !DECLARATIVE_TOOLS.has(event.toolName)) {
      evidenceTimes.push(event.at);
    }
    if (event.type !== "assistant_text") continue;

    for (const sentence of sentencesOf(event.text)) {
      const done = CLAIMED_DONE.test(sentence) && !CLAIMED_NOT_STARTED.test(sentence);
      const notStarted = CLAIMED_NOT_STARTED.test(sentence) && !done;
      const words = subjectWords(sentence);
      if (words.size === 0) continue;

      if (notStarted) {
        for (const claim of doneClaims) {
          if (claim.turnId === event.turnId) continue;
          const shared = [...words].filter((w) => claim.words.has(w));
          if (shared.length < 2) continue;
          // An observation between the two claims is a reason the story
          // changed. Without one, the reversal is the model alone.
          const observedBetween = evidenceTimes.some((t) => t > claim.at && t <= event.at);
          if (observedBetween) continue;
          found.push({
            subject: shared.join(" "),
            claimedDoneAt: claim.turnId,
            reversedAt: event.turnId,
          });
          break;
        }
      }
      if (done) doneClaims.push({ turnId: event.turnId, at: event.at, words, sentence });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// What the message asked for, clause by clause
// ---------------------------------------------------------------------------

/**
 * The request clauses of a message — each imperative the user actually wrote.
 *
 * The live run this serves recorded *one* requirement out of a message that
 * ended three separate clauses with 해줘: segmentation training, web-checked
 * model selection, and a final report. The runtime cannot read Korean well
 * enough to write the requirements itself — that stays the interpreter's job —
 * but it can count where the user said "do this", and three do-this clauses
 * against one recorded requirement is a gap worth challenging.
 */
const IMPERATIVE_CLAUSE =
  /[^.!?\n]*?(?:해\s*줘|해\s*주세요|해주세요|하십시오|해\s*봐|해라|해\s*달라|해\s*다오|부탁해|부탁드립니다|바랍니다|주세요)[.!?]?/gu;

export function requestClauses(text: string): string[] {
  const clauses: string[] = [];
  for (const match of text.matchAll(IMPERATIVE_CLAUSE)) {
    const clause = match[0].trim().replace(/[.!?]+$/u, "");
    if (clause.length >= 6) clauses.push(clause);
  }
  return clauses;
}

/** A request clause no recorded requirement appears to answer. */
export interface CoverageGap {
  clause: string;
}

/**
 * Clauses the contract does not cover.
 *
 * Matching is the same loose word-overlap `planCoverage` uses, and errs the
 * same way on purpose: a false gap costs one correction round in which the
 * model re-affirms what it recorded; a false "covered" is a requirement lost
 * without anyone being asked. Two shared stems are required rather than one,
 * because one Korean stem in common — 학습 — is how "리포트로 정리해줘" read as
 * covered by a training requirement.
 */
export function contractCoverageGaps(
  contract: { requirements: readonly { description: string; lifecycle: string }[] },
  userText: string,
): CoverageGap[] {
  const clauses = requestClauses(userText);
  if (clauses.length <= 1) return [];

  const requirementWords = contract.requirements
    .filter((r) => r.lifecycle === "active")
    .map((r) => significantWords(r.description));

  const gaps: CoverageGap[] = [];
  for (const clause of clauses) {
    const words = significantWords(clause);
    if (words.length === 0) continue;
    const covered = requirementWords.some((set) => {
      const hits = words.filter((word) =>
        set.some((w) => w === word || w.startsWith(word) || word.startsWith(w)),
      ).length;
      return hits >= 2;
    });
    if (!covered) gaps.push({ clause });
  }
  return gaps;
}

/** Proposed actions the gate held back this turn — deferred or denied, substantive only. */
export function substantiveHolds(events: readonly SessionEvent[]): number {
  let held = 0;
  for (const event of events) {
    if (event.type !== "tool_completed" || DECLARATIVE_TOOLS.has(event.toolName)) continue;
    if (event.disposition === "deferred" || event.disposition === "denied") held += 1;
  }
  return held;
}
