import type { NormalizedToolCall, ProviderChatRequest } from "../provider/types.ts";

/**
 * The Coding Agent's contract.
 *
 * The Arena already runs a tool-calling loop (`src/runtime/agentRunner.ts`), and
 * this is not a rewrite of it. The difference is one thing, and it changes
 * everything downstream: an Arena candidate works inside a throwaway worktree
 * nobody is watching, so it may act freely. This agent works in the user's own
 * repository, so every action that writes or executes has to be something the
 * user agreed to.
 *
 * That is why `ToolRisk` exists, why `ApprovalPort` is a required dependency
 * rather than an option, and why the loop takes a checkpoint before the first
 * write instead of after the last one.
 */

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/**
 * What the user asked for, expressed as what the agent is allowed to do.
 *
 * A mode is not a prompt preset. It decides which tools exist at all, which is
 * the only form of restriction a model cannot talk its way past: ARCHITECT
 * cannot accidentally edit a file because no writing tool was ever offered to
 * it. Cline's Plan/Act split works the same way, and for the same reason.
 */
export type AgentMode = "code" | "architect" | "debug" | "ask";

export const AGENT_MODES: readonly AgentMode[] = ["code", "architect", "debug", "ask"];

export interface ModeDefinition {
  mode: AgentMode;
  /** Shown in the mode picker. */
  label: string;
  /** One line, in the user's language. */
  description: string;
  /** Highest risk this mode may reach. Tools above it are not registered. */
  maxRisk: ToolRisk;
  systemPrompt: string;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * How much trust a call needs.
 *
 * Ordered, and the order is load-bearing: a mode's ceiling and an approval
 * policy are both expressed as "up to this level".
 */
export type ToolRisk = "read" | "write" | "execute" | "dangerous";

export const RISK_ORDER: Record<ToolRisk, number> = {
  read: 0,
  write: 1,
  execute: 2,
  dangerous: 3,
};

export function atMost(risk: ToolRisk, ceiling: ToolRisk): boolean {
  return RISK_ORDER[risk] <= RISK_ORDER[ceiling];
}

export interface ToolResult {
  /** False means the call was refused or failed; the agent sees why and retries. */
  ok: boolean;
  /** What the model is told. Truncated by the tool, not by the loop. */
  content: string;
  /**
   * Workspace-relative paths this call changed.
   *
   * Kept as bare paths for every existing caller. `changes` is the richer form
   * — what kind of change, and what a rename came from — and a tool that sets
   * it does not need to set this as well.
   */
  changedFiles?: string[];
  /**
   * What this call did to the workspace, said by the thing that did it.
   *
   * The source of truth for the changed-file list. It used to be `git status`,
   * which is empty in a folder that is not a repository — so an agent could
   * write four files and the panel would show none of them.
   */
  changes?: FileChange[];
  /**
   * What was left out of `content`, when anything was.
   *
   * Silent truncation is the failure this exists to prevent: a model handed the
   * first half of a page has no way to know it was a half, and will answer as
   * though it read the whole thing. The tool that cut it says so, here, and the
   * text the model sees says so too.
   */
  meta?: TruncationMeta;
  /**
   * Output the *user* should see, verbatim, not just the model.
   *
   * Opt-in, and almost nothing opts in. The panel deliberately shows a progress
   * line per tool rather than a transcript, and a whole file dumped under
   * `read_file` is a payload nobody asked to render — that reasoning still
   * holds and is why this is not simply `content`.
   *
   * Where it does not hold is a command. "I ran it and it worked" is a claim,
   * and a user who cannot see what it printed has to take the model's word for
   * the one thing they asked it to find out. Reported as exactly that: a user
   * looking at three ticks and a paragraph, unable to check any of it.
   *
   * So a tool sets this when its output *is* the answer. Everything else leaves
   * it undefined and keeps the status line it had.
   */
  display?: string;
}

export interface ToolContext {
  /** Absolute, realpath-resolved workspace root. */
  workspaceRoot: string;
  signal: AbortSignal;
}

export interface AgentTool {
  name: string;
  /** Given to the model. Says what the tool does and when to reach for it. */
  description: string;
  risk: ToolRisk;
  /** JSON Schema for the arguments. Passed to the provider untouched. */
  parameters: Record<string, unknown>;
  /**
   * One sentence a person can approve or refuse, in their language.
   *
   * Not the raw arguments. "Run `pnpm test`" is a decision; a JSON blob is a
   * puzzle, and a user who cannot read the request quickly will either approve
   * everything or stop using the agent.
   */
  summarize(args: Record<string, unknown>): string;
  /** A diff or excerpt shown before approving a write. Absent when there is nothing to show. */
  preview?(args: Record<string, unknown>, ctx: ToolContext): Promise<string | null>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

/**
 * How much the user wants to be asked.
 *
 * `safe` is the default and stays the default. The product is aimed at people
 * whose repository this actually is, and the failure modes are asymmetric: an
 * agent that asks too often is annoying, and one that asks too rarely is the
 * reason they stop trusting it.
 */
export type ApprovalMode = "safe" | "balanced" | "auto";

export type ApprovalOutcome =
  /** The policy allowed it without asking. */
  | "auto"
  /** The user said yes. */
  | "granted"
  /** The user had already said "always" to this tool, so nobody was asked. */
  | "standing"
  /** The user said no. */
  | "denied"
  /** No policy permits this, so nobody was asked. */
  | "blocked";

export interface ApprovalRequest {
  toolName: string;
  risk: ToolRisk;
  /** The tool's own one-sentence summary. */
  summary: string;
  /** A diff or excerpt, when the tool can produce one. */
  preview: string | null;
}

/**
 * Whoever answers approval requests.
 *
 * A port rather than a class: in the extension it is a modal, in the CLI a
 * prompt, in a test a function. The loop must not know which.
 */
/**
 * What the user answered.
 *
 * `"always"` is the one that matters for how the product feels. A boolean means
 * the same dialog for the fourth `pip install` of a turn, and a user asked the
 * same question four times stops reading it — which is the opposite of what an
 * approval prompt is for. Saying "yes, and stop asking about this" is a decision
 * they made once and meant.
 *
 * Scoped to the tool, not to the exact command: "let it run commands" is the
 * thing a person decides. Whether *this* command is `dangerous` was settled
 * before anyone was asked, and no answer here reaches past that.
 */
export type ApprovalAnswer = boolean | "always";

export interface ApprovalPort {
  request(req: ApprovalRequest): Promise<ApprovalAnswer>;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type AgentStopReason =
  /** The model produced an answer and stopped. */
  | "finished"
  | "max_steps"
  | "max_model_calls"
  | "max_tool_calls"
  | "timeout"
  | "aborted"
  /** The user refused something the agent needed. */
  | "denied"
  /** The model asked for the same thing repeatedly and was getting nowhere. */
  | "loop_detected"
  | "error";

/**
 * A change a tool made, and the truncation it applied.
 *
 * Both re-exported from the persisted vocabulary rather than declared twice.
 * A second definition would be a second place for them to drift, and these are
 * carried straight through from a tool result to a stored event without being
 * reshaped on the way.
 */
import type { FileChangeKind, TruncationMeta } from "./sessionEvents.ts";
export type { FileChangeKind, TruncationMeta };

export interface FileChange {
  path: string;
  change: FileChangeKind;
  /** Where a rename came from. */
  previousPath?: string;
}

export type AgentEvent =
  | { type: "step"; step: number }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_start"; callId: string; name: string; risk: ToolRisk; summary: string }
  | { type: "tool_approval"; callId: string; name: string; outcome: ApprovalOutcome }
  /**
   * `detail` is a status line, capped small on purpose. `output` is what the
   * tool asked to have shown verbatim, and only some tools ask.
   *
   * `changedFiles` is reported by the tool that did the changing, which is the
   * only place that knows for certain — asking git afterwards answers nothing
   * in a workspace that is not a repository. `meta` says when what is here is
   * not all there was.
   */
  | {
      type: "tool_end";
      callId: string;
      name: string;
      ok: boolean;
      detail: string;
      output?: string;
      changedFiles?: FileChange[];
      meta?: TruncationMeta;
    }
  /**
   * The agent's plan and where it is in it.
   *
   * Sent whole each time it changes, so the panel renders state rather than
   * accumulating a log. See `tools/planTool.ts` for why this is a tool call and
   * not something inferred from the model's prose.
   */
  /**
   * What the agent is busy with right now, in the user's language.
   *
   * Emitted for the work that happens *before* the loop — choosing a model,
   * measuring one, assembling the tools. That work was invisible and unbounded,
   * and a turn that spent twenty-four minutes there reported "생각하는 중" the
   * whole time because nothing else had anything to say.
   */
  | { type: "phase"; label: string }
  | { type: "plan"; steps: string[]; current: number }
  | { type: "checkpoint"; ref: string | null; detail: string }
  | { type: "changed"; files: string[] }
  /**
   * `detail` says why *this* run hit *this* reason — which four calls repeated,
   * which budget ran out. The reason alone is a category; the detail is the
   * thing a user can act on.
   */
  | { type: "done"; reason: AgentStopReason; summary: string; detail?: string }
  | { type: "error"; code: string; message: string };

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * Everything that stops the loop running forever.
 *
 * Four separate limits because they fail differently. A model that calls tools
 * productively for 200 steps has not misbehaved but has stopped being
 * affordable; one that calls the same tool with the same arguments five times
 * has. `timeoutMs` catches a gateway that never answers, and `signal` is the
 * user changing their mind — the only one of the four that is not a failure.
 */
export interface AgentBudget {
  maxSteps: number;
  maxModelCalls: number;
  maxToolCalls: number;
  timeoutMs: number;
  /** Identical tool + identical arguments this many times in a row ends the run. */
  maxRepeatedCalls: number;
}

export const DEFAULT_BUDGET: AgentBudget = {
  maxSteps: 40,
  maxModelCalls: 40,
  maxToolCalls: 120,
  timeoutMs: 10 * 60_000,
  maxRepeatedCalls: 3,
};

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface AgentTurnResult {
  reason: AgentStopReason;
  /** What the agent says it did, in the user's language. */
  summary: string;
  changedFiles: string[];
  /** Restores the workspace to its state before this turn, when one was taken. */
  checkpointRef: string | null;
  steps: number;
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * What the loop needs from a model.
 *
 * Narrower than `LlmProvider` on purpose. The loop needs one thing — turn a
 * conversation into either text or tool calls — and depending on the whole
 * provider would let a gateway concern leak into it.
 */
export interface AgentModel {
  readonly modelId: string;
  complete(
    request: Omit<ProviderChatRequest, "modelId">,
    signal: AbortSignal,
  ): Promise<AgentCompletion>;
}

export interface AgentCompletion {
  text: string;
  reasoning: string;
  toolCalls: NormalizedToolCall[];
  inputTokens: number;
  outputTokens: number;
}
