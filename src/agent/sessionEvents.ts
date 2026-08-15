import type { ToolRisk } from "./types.ts";
import type { WebSourceProvenance } from "./sourceProvenance.ts";
import type { SourceFact } from "./sourceFacts.ts";
import type {
  ConversationBranch,
  ConversationCheckpoint,
  ConversationTurn,
} from "./conversationGraph.ts";

/**
 * What a conversation is made of, once the streaming is over.
 *
 * The runtime already had an `AgentEvent` union, and it was the right shape —
 * but it was transient. It drove the panel while a turn ran and then went
 * nowhere, while the thing actually written to disk was the *model's* message
 * array. So the two disagreed about what a conversation is: the model's array
 * has tool calls and results but no reasoning, no plan, no changed files and no
 * reason the run stopped, and the projection that read it back dropped even the
 * tool messages it did have.
 *
 * This is the persisted form, and the rule that shapes it is one line:
 *
 *   Anything the user could see and would want back is an event here.
 *   Anything that only mattered while it was moving is not.
 *
 * So a spinner, a token delta and a progress label are absent by design, and
 * assistant text, reasoning, the plan, tool calls and their results, file
 * changes, warnings and the termination are all present.
 *
 * These are semantic events, not view state. The panel is a projection of them
 * (`sessionView.ts`), which is what lets a live turn and a reopened conversation
 * be rendered by the same code instead of two that drift.
 */

/**
 * The on-disk generation.
 *
 * 2 stored a flat event log beside the model's messages. 3 groups both into
 * turns, because a branch needs to move the two together and a flat pair cannot
 * say where one turn ended — see `conversationGraph.ts`.
 */
export const SESSION_SCHEMA_VERSION = 3;

/** Kept so a v2 reader's expectations are named rather than implied by a number. */
export const SESSION_SCHEMA_V2 = 2;

/** Coarse phase of a reasoning summary, when the runtime can tell. */
export type ReasoningPhase = "analysis" | "planning" | "execution" | "verification";

/** How a file was touched. Reported by the tool that touched it. */
export type FileChangeKind = "created" | "modified" | "deleted" | "renamed";

/**
 * How a tool call ended.
 *
 * `denied` and `blocked` are separated from `failed` because they are not
 * failures of the tool: one is the user saying no and the other is a policy
 * ceiling. A user reading their own history should be able to tell those apart.
 */
export type ToolCallStatus = "success" | "failed" | "denied" | "blocked" | "cancelled";

/**
 * What became of a proposed action, as a field rather than as prose.
 *
 * `ToolCallStatus` cannot answer this and was never meant to. Three different
 * things arrive as `failed`: a command that ran and exited non-zero, one the
 * preflight held back for not answering the request, and one the user forbade.
 * They were told apart by reading a machine code out of the human-readable
 * `detail` string, which made every metric downstream depend on the wording of
 * a sentence — change the sentence and the numbers move.
 *
 * The distinctions that must survive:
 *
 *     proposed  ≠  executed
 *     deferred  ≠  executed_failure
 *     denied    ≠  executed_failure
 *
 * Optional, because conversations written before this existed do not have it.
 * A reader that meets one without falls back to the old reading and says so —
 * see `actionLedger.ts`.
 */
export type ActionDisposition =
  /** Held back before the tool was reached. Nothing ran. */
  | "deferred"
  /** Refused: the user forbade it, or declined the approval. */
  | "denied"
  /** Reached the tool, ran, and succeeded. */
  | "executed_success"
  /** Reached the tool, ran, and failed. A fact about the work, not the policy. */
  | "executed_failure"
  /** The turn ended before it resolved. */
  | "cancelled";

/**
 * Why a run stopped.
 *
 * Deliberately the same vocabulary as the runtime's `AgentStopReason` rather
 * than a parallel one: a second set of names would need a mapping, and a
 * mapping is a place for them to disagree. What is added is that this value is
 * persisted and is rendered through a table (`terminationView`), so no part of
 * the UI compares the string itself.
 */
export type RunTerminationReason =
  | "finished"
  | "denied"
  /** The agent reported that part of the request could not be done. */
  | "blocked"
  | "aborted"
  | "timeout"
  | "loop_detected"
  /** The run kept acting without getting anywhere, and stopped saying so. */
  | "no_progress"
  | "max_steps"
  | "max_model_calls"
  | "max_tool_calls"
  | "error";

/** Why a tool's output is not all of its output. */
export interface TruncationMeta {
  truncated: boolean;
  /** Characters (or bytes, for a fetch) the source actually had. */
  originalLength?: number;
  returnedLength?: number;
  reason?: "max_chars" | "max_lines" | "max_bytes" | "response_limit" | "file_too_large";
  /** How to get the rest, in words the model can act on. */
  hint?: string;
}

interface Base {
  /** Unique within the session. Stable across a reload — see `sessionLog.ts`. */
  id: string;
  /** The exchange this belongs to. One user message and its answer share a turn. */
  turnId: string;
  at: number;
}

export interface UserMessageEvent extends Base {
  type: "user_message";
  text: string;
  /** Names and kinds only. The bytes are not a conversation. */
  attachments?: Array<{ name: string; kind: string }>;
}

export interface AssistantTextEvent extends Base {
  type: "assistant_text";
  text: string;
}

/**
 * A summary of what the model is working through — never the raw chain itself.
 *
 * The distinction is the point. Providers can return a private reasoning stream;
 * storing it would put text the model was not writing for anyone into a file the
 * user can open, and showing it invites reading it as an answer. What is kept is
 * a summary the runtime is willing to stand behind.
 */
export interface ReasoningEvent extends Base {
  type: "reasoning";
  summary: string;
  phase?: ReasoningPhase;
}

export interface PlanEvent extends Base {
  type: "plan";
  /** Every step. What the panel chooses to show is the panel's business. */
  steps: string[];
  current: number;
}

/**
 * One thing a page the agent read was recorded as saying.
 *
 * Persisted rather than derived, because it cannot be derived: the page body is
 * never written to storage and the model's reading of it is not reproducible
 * from anything that is. Checked against the bytes before it was emitted — see
 * `sourceFacts.verifyFact` — so what is stored is a fact the runtime confirmed
 * was in the source, not a claim it accepted.
 */
export interface SourceFactEvent extends Base {
  type: "source_fact";
  fact: SourceFact;
}

export interface ToolStartedEvent extends Base {
  type: "tool_started";
  callId: string;
  toolName: string;
  risk: ToolRisk;
  /** The tool's own sentence, already written for a person. */
  summary: string;
}

export interface ToolCompletedEvent extends Base {
  type: "tool_completed";
  callId: string;
  toolName: string;
  status: ToolCallStatus;
  /**
   * Whether it ran, and if not, why not.
   *
   * The machine-readable half of the outcome. `detail` stays the sentence a
   * person reads and is no longer load-bearing: rewording it must not move a
   * metric. Absent on conversations written before this field existed.
   */
  disposition?: ActionDisposition;
  /** A status line. Short by contract. */
  detail: string;
  /** Verbatim output, when the tool asked for it to be shown. */
  output?: string;
  meta?: TruncationMeta;
  /**
   * Where this call read from, outside the workspace.
   *
   * Persisted rather than derived, because it cannot be derived: `detail` is a
   * 200-character status line and the host it came from is not reliably in it.
   * Optional, so a conversation written before this existed still reads — an
   * absent list means nothing was recorded, not that nothing was fetched, and
   * every reader treats it that way.
   */
  sources?: WebSourceProvenance[];
}

export interface FileChangedEvent extends Base {
  type: "file_changed";
  path: string;
  change: FileChangeKind;
  previousPath?: string;
}

export interface NoticeEvent extends Base {
  type: "notice";
  level: "info" | "warning" | "error";
  text: string;
}

/**
 * What the user asked for, as the model read it and the schema accepted it.
 *
 * The whole contract in one event, rather than a stream of `requirement_added`
 * and `requirement_superseded`. The reason is the same one that made a turn own
 * its `messageDelta`: store what was *observed*, derive the rest. A contract is
 * what one validated `record_request` produced, and supersession is what
 * `mergeContract` computes from a sequence of them — so folding the events
 * gives the same state live and on replay, with nothing to keep in step.
 *
 * It also means a branch is right for free. The events after a fork are not in
 * that branch's chain, so neither are the requirements they carried.
 */
export interface TurnContractEvent extends Base {
  type: "turn_contract";
  /** The validated contract. Shape owned by `turnContract.ts`. */
  contract: unknown;
}

/**
 * How this turn's worker came to be this turn's worker.
 *
 * Four ways, and they are not variants of one. A recommendation is a
 * computation; a manual pick is a person; a carried worker is the absence of a
 * decision; a restored one is a decision made before the process restarted.
 * Collapsing them would make "why is this model running" unanswerable in
 * exactly the cases where it is asked.
 */
export type WorkerSelectionOrigin =
  /** The requirement-aware router ranked and chose. */
  | "auto_recommendation"
  /** The user picked it. Nothing overrules that. */
  | "user_manual"
  /** The task did not change, so neither did the worker. */
  | "carried"
  /** Read back from a previous session's record. */
  | "restored"
  /** Bootstrap or routing failed; the turn ran on the older selection. */
  | "fallback";

/**
 * Which model is doing this turn, and how it was chosen.
 *
 * Named for *selection* rather than for recommendation, because recommending
 * is only one of the ways a worker is chosen and the other three are equally
 * real. When this event was `model_recommended`, a manually chosen model had to
 * be written down as a recommendation with an origin saying it was not one —
 * and anything reading the record had to know that to interpret it.
 *
 * This is the canonical record of who is working. `actionLedger` attributes
 * actions from it, whatever the origin, so a manual turn's actions are
 * attributed exactly as an auto turn's are. There is no second place a worker
 * id is stored.
 *
 * The decision is stored rather than recomputed. Replaying a past turn through
 * today's registry would answer a different question and quietly rewrite
 * history — a model that has since been re-evaluated would appear to have been
 * chosen for a turn it never ran.
 *
 * What is deliberately *not* here is the model profiles themselves. A snapshot
 * of the catalogue in every turn of every conversation is a copy that will
 * drift from the registry that owns it. The fingerprint says which profile was
 * answered; the registry keeps the profiles.
 */
export interface WorkerSelectedEvent extends Base {
  type: "worker_selected";
  selectionOrigin: WorkerSelectionOrigin;
  /** The worker for this turn. Null when nothing was eligible. */
  selectedModelId: string | null;
  /** The model that read the request into a contract, when one did. */
  bootstrapModelId?: string;
  /**
   * Model calls the bootstrap pass spent.
   *
   * Kept apart from the worker's own calls so a later cost or latency
   * evaluation cannot charge interpretation to the model that did the work.
   */
  bootstrapModelCalls?: number;
  /** Runners-up, in rank order, for a future fallback and for explaining. */
  alternatives?: Array<{ modelId: string; score: number }>;
  /** Who was ruled out before scoring, and under which code. */
  filteredOut?: Array<{ modelId: string; code: string }>;
  /** The four terms, so "why did B lose" has an answer later. */
  scoreBreakdown?: Record<string, number>;
  /** Machine-readable reason codes from the recommender. */
  reasons?: string[];
  /** Identifies the profile this answered without copying it. */
  taskProfileFingerprint?: string;
  /**
   * Which weighting produced the ranking.
   *
   * Separate from `routerVersion`, which says what the code did. This says what
   * the *policy* was, and the two move independently: tuning the weights is not
   * a code change, and a decision that cannot name its weights cannot answer
   * "why A then and B now" — the registry and the policy are both candidates
   * and only one of them is usually the cause.
   */
  routerPolicyId?: string;
  /**
   * What a semantic measurement said, when one was taken.
   *
   * Observation only. Nothing in the selection above was computed from it —
   * `shadow.ts` runs beside the recommendation rather than inside it — and it
   * is stored so a later calibration can be fitted against decisions that were
   * already made rather than against a fresh experiment.
   *
   * Scores and identity, never vectors. A conversation is not the place to keep
   * a thousand floats per model per turn.
   */
  shadow?: unknown;
  /** Set when no model could be chosen, so the absence has a cause. */
  unavailableReason?: string;
  routerVersion: string;
}

export interface RunCompletedEvent extends Base {
  type: "run_completed";
  reason: RunTerminationReason;
  /** The model's closing words, when it produced any. */
  summary: string;
  /** Why *this* run hit *this* reason — "read_file was called four times". */
  detail?: string;
}

export type SessionEvent =
  | UserMessageEvent
  | AssistantTextEvent
  | ReasoningEvent
  | PlanEvent
  | SourceFactEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | FileChangedEvent
  | NoticeEvent
  | TurnContractEvent
  | WorkerSelectedEvent
  | RunCompletedEvent;

export type SessionEventType = SessionEvent["type"];

/**
 * A conversation on disk.
 *
 * `version` is checked on read and drives migration rather than being decoration
 * — the same pattern `modelCache.ts` and the capability matrix already use, so
 * a reader that meets an unfamiliar number refuses it instead of guessing.
 *
 * `turnId` on every event is what makes a branching history possible later
 * without another migration: a checkpoint is a turn, and a fork is a turn whose
 * parent is not the one before it. Nothing here implements that, and nothing
 * here forecloses it.
 */
export interface PersistedSession {
  version: typeof SESSION_SCHEMA_VERSION;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;

  /**
   * The conversation itself, as a graph of turns.
   *
   * This is the only thing written to disk in v3. A turn owns both halves — the
   * events the user saw and the messages the model read — so the two cannot be
   * restored to different points, which is the failure the whole graph exists to
   * prevent.
   */
  turns: ConversationTurn[];
  branches: ConversationBranch[];
  checkpoints: ConversationCheckpoint[];
  /** Which branch the next turn extends. `MAIN_BRANCH_ID` unless forked. */
  activeBranchId: string;

  /**
   * The workspace this conversation belongs to.
   *
   * Optional because conversations written before workspaces existed have none,
   * and inventing one would attach them to whichever folder happened to be open
   * — the exact mis-binding recording this prevents.
   *
   * The directory already scopes conversations by workspace, so this is
   * defence in depth: a file moved, restored from a backup or copied between
   * machines still says where it came from, and a reader can refuse it rather
   * than show one project's history under another's name.
   */
  workspace?: PersistedWorkspace;

  /**
   * The active branch, flattened — derived on read, never stored.
   *
   * Both halves are here because neither reconstructs the other faithfully: a
   * tool result is summarised for a person and verbatim for a model, and an
   * event log replayed as a prompt would feed it a different conversation than
   * it had. v2 stored both side by side, which meant two arrays that could
   * disagree; v3 stores the turns and computes these from them, so they cannot.
   */
  events: SessionEvent[];
  messages: unknown[];
}

/** Where a conversation was had. Paths are for a person to read. */
export interface PersistedWorkspace {
  id: string;
  /** Canonical roots at the time of writing, for diagnosis rather than matching. */
  roots?: string[];
  /** The folder this conversation's relative paths were resolved against. */
  boundRoot?: string;
}

/**
 * What a writer must supply.
 *
 * The graph fields are optional so a caller holding only the flat pair — a v2
 * writer, a test — still writes a valid file: `writeSession` folds what it is
 * given into a single turn rather than refusing it.
 */
export type SessionFileInput = Omit<
  PersistedSession,
  "turns" | "branches" | "checkpoints" | "activeBranchId"
> &
  Partial<Pick<PersistedSession, "turns" | "branches" | "checkpoints" | "activeBranchId">>;
