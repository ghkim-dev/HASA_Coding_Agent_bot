import type { ToolRisk } from "./types.ts";
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
  /** A status line. Short by contract. */
  detail: string;
  /** Verbatim output, when the tool asked for it to be shown. */
  output?: string;
  meta?: TruncationMeta;
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
  | ToolStartedEvent
  | ToolCompletedEvent
  | FileChangedEvent
  | NoticeEvent
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
