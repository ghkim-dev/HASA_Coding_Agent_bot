import { realpath } from "node:fs/promises";
import type { CommandSpec } from "../protocol/index.ts";
import { Sandbox } from "../core/sandbox.ts";
import { nullLogger, type Logger } from "../hasa-client/logger.ts";
import type { ProviderMessage, Tristate } from "../provider/types.ts";
import { composeUserMessage, describeAttachmentProblems, type Attachment } from "./attachments.ts";
import { ApprovalManager } from "./approval.ts";
import type { RuntimeGap } from "./discoverCommands.ts";
import { createMediaTools } from "./tools/mediaTools.ts";
import type { MediaToolOptions } from "./tools/mediaTools.ts";
import { CheckpointManager } from "./checkpoint.ts";
import { AgentLoop } from "./loop.ts";
import { modeCanWrite, modeDefinition, workspaceNote } from "./modes.ts";
import { createFileTools } from "./tools/fileTools.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { createShellTools } from "./tools/shellTools.ts";
import type {
  AgentBudget,
  AgentEvent,
  AgentMode,
  AgentModel,
  AgentTurnResult,
  ApprovalMode,
  ApprovalPort,
} from "./types.ts";

/**
 * A conversation with the agent.
 *
 * The session owns the two things a single turn cannot: the history, and the
 * checkpoint. Both outlive a turn for the same reason — the user's next message
 * is usually "no, the other file" or "undo that", and neither is answerable by
 * something that forgot.
 *
 * Everything expensive is assembled once, at construction, and switching mode
 * rebuilds only the tool registry. That is the whole of what a mode is.
 */

export interface AgentSessionOptions {
  workspaceRoot: string;
  model: AgentModel;
  approvalPort: ApprovalPort;
  mode?: AgentMode;
  approvalMode?: ApprovalMode;
  /** Commands this project declares. Empty means no command tool is offered. */
  commands?: CommandSpec[];
  /**
   * Languages present here with no interpreter installed. Told to the model so
   * "I cannot run it" can become "Python is not installed, here is where to get
   * it" — the difference between a dead end and a next step.
   */
  runtimeGaps?: RuntimeGap[];
  /**
   * Image and video generation, when the gateway offers those models.
   *
   * Absent means the tools are not registered at all, which is the same rule
   * the shell tools follow: a tool that cannot work should not be offered.
   */
  media?: Omit<MediaToolOptions, "sandbox">;
  /**
   * Whether the chosen model was *measured* to read images. Decides whether an
   * attached screenshot is sent or refused; `unknown` is not `false`, so an
   * unprobed model is given the benefit of the doubt.
   */
  vision?: Tristate;
  /** Restricts writes to these path prefixes. Reads stay workspace-wide. */
  writeScope?: string[];
  budget?: Partial<AgentBudget>;
  logger?: Logger;
  onEvent?: (event: AgentEvent) => void;
}

export class AgentSession {
  readonly workspaceRoot: string;
  private readonly opts: AgentSessionOptions;
  private readonly log: Logger;
  private readonly approvals: ApprovalManager;
  private readonly checkpoints: CheckpointManager;
  private readonly sandbox: Sandbox;
  private mode: AgentMode;
  private messages: ProviderMessage[] = [];
  /** Decided once at open: whether undo and diffs are possible at all. */
  private isGitRepo = false;
  private lastAttachmentProblem: string | null = null;

  private constructor(root: string, opts: AgentSessionOptions) {
    this.workspaceRoot = root;
    this.opts = opts;
    this.log = opts.logger ?? nullLogger;
    this.mode = opts.mode ?? "code";
    this.approvals = new ApprovalManager({
      mode: opts.approvalMode ?? "safe",
      port: opts.approvalPort,
    });
    this.checkpoints = new CheckpointManager({
      repoRoot: root,
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
    this.sandbox = new Sandbox({
      root,
      ...(opts.writeScope ? { writeScope: opts.writeScope } : {}),
    });
  }

  /**
   * Opens a session on a workspace.
   *
   * The root is resolved through `realpath` here, once, because the sandbox
   * compares real paths and a root that is itself a symlink would make every
   * legitimate path look like an escape.
   */
  static async open(opts: AgentSessionOptions): Promise<AgentSession> {
    const root = await realpath(opts.workspaceRoot);
    const session = new AgentSession(root, opts);
    // Asked once rather than per turn: it decides which tools exist and what
    // the prompt says is impossible, and both have to be settled before the
    // model is shown anything.
    session.isGitRepo = await session.checkpoints.available();
    return session;
  }

  get currentMode(): AgentMode {
    return this.mode;
  }

  get approvalMode(): ApprovalMode {
    return this.approvals.currentMode;
  }

  setMode(mode: AgentMode): void {
    this.mode = mode;
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.approvals.setMode(mode);
  }

  /** True when this workspace can be rolled back. */
  async canUndo(): Promise<boolean> {
    return this.checkpoints.available();
  }

  /**
   * The tools this mode offers.
   *
   * Filtered by the mode's ceiling rather than checked at approval time: a tool
   * ARCHITECT must not use is a tool ARCHITECT is never shown.
   */
  private registryForMode(): ToolRegistry {
    const definition = modeDefinition(this.mode);
    const all = new ToolRegistry([
      ...createFileTools(this.sandbox),
      ...createShellTools({
        workspaceRoot: this.workspaceRoot,
        allowlist: this.opts.commands ?? [],
        isGitRepo: this.isGitRepo,
      }),
      ...(this.opts.media === undefined
        ? []
        : createMediaTools({ ...this.opts.media, sandbox: this.sandbox })),
    ]);
    return all.withCeiling(definition.maxRisk);
  }

  /**
   * Runs one turn.
   *
   * The system prompt is re-seeded each turn from the current mode, so
   * switching mode mid-conversation takes effect immediately instead of on the
   * next session.
   */
  async send(
    prompt: string,
    signal: AbortSignal = new AbortController().signal,
    attachments: readonly Attachment[] = [],
  ): Promise<AgentTurnResult> {
    const definition = modeDefinition(this.mode);
    const system: ProviderMessage = {
      role: "system",
      content:
        definition.systemPrompt +
        workspaceNote({
          canRunCommands: (this.opts.commands ?? []).length > 0,
          isGitRepo: this.isGitRepo,
          runtimeGaps: this.opts.runtimeGaps,
        }),
    };
    this.messages = [system, ...this.messages.filter((m) => m.role !== "system")];

    // Attachments become part of the user's message rather than a separate
    // one, so a model that only reads the last message still sees the file the
    // question is about. What could not be sent is returned rather than
    // dropped — see `attachments.ts`.
    const composed = composeUserMessage(prompt, attachments, {
      ...(this.opts.vision === undefined ? {} : { vision: this.opts.vision }),
    });
    this.lastAttachmentProblem = describeAttachmentProblems(composed);
    this.messages.push(composed.message);

    const loop = new AgentLoop({
      model: this.opts.model,
      tools: this.registryForMode(),
      approvals: this.approvals,
      // A read-only mode has nothing to protect against, and taking a stash it
      // will never use would touch a repository the user asked us only to read.
      checkpoints: modeCanWrite(this.mode) ? this.checkpoints : null,
      workspaceRoot: this.workspaceRoot,
      systemPrompt: definition.systemPrompt,
      ...(this.opts.budget ? { budget: this.opts.budget } : {}),
      ...(this.opts.logger ? { logger: this.opts.logger } : {}),
      ...(this.opts.onEvent ? { onEvent: this.opts.onEvent } : {}),
    });

    this.log.info("agent turn", { mode: this.mode, approval: this.approvals.currentMode });
    return loop.run(this.messages, signal);
  }

  /** Restores the workspace to the state it was in before this session wrote. */
  async undo(): Promise<boolean> {
    return this.checkpoints.revert();
  }

  /** Accepts this session's changes: the checkpoint is no longer offered. */
  keep(): void {
    this.checkpoints.release();
  }

  async changedFiles(): Promise<string[]> {
    return this.checkpoints.changedFiles();
  }

  /** Forgets the conversation. The workspace and the checkpoint are untouched. */
  clearHistory(): void {
    this.messages = [];
  }

  /** Whatever could not be attached to the last message, once. */
  takeAttachmentProblem(): string | null {
    const problem = this.lastAttachmentProblem;
    this.lastAttachmentProblem = null;
    return problem;
  }

  /**
   * Replaces the conversation with a stored one.
   *
   * The system message is not restored: it is re-seeded from the current mode
   * on every turn, and a stored one would carry a prompt from whatever mode the
   * conversation was in when it was saved.
   */
  restore(messages: readonly ProviderMessage[]): void {
    this.messages = messages.filter((m) => m.role !== "system");
  }

  /** Read-only view, for a transcript or a test. */
  history(): readonly ProviderMessage[] {
    return this.messages;
  }
}
