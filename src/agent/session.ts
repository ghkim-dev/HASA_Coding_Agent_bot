import { realpath } from "node:fs/promises";
import type { CommandSpec } from "../protocol/index.ts";
import { Sandbox } from "../core/sandbox.ts";
import { nullLogger, type Logger } from "../hasa-client/logger.ts";
import type { ProviderMessage, Tristate } from "../provider/types.ts";
import { composeUserMessage, describeAttachmentProblems, type Attachment } from "./attachments.ts";
import { ApprovalManager, type ApprovalManagerOptions } from "./approval.ts";
import type { RuntimeGap } from "./discoverCommands.ts";
import { createMediaTools } from "./tools/mediaTools.ts";
import type { MediaToolOptions } from "./tools/mediaTools.ts";
import { CheckpointManager, type Checkpoint } from "./checkpoint.ts";
import { AgentLoop, type AgentLoopOptions } from "./loop.ts";
import { modeCanWrite, modeDefinition, workspaceNote } from "./modes.ts";
import { createFileTools } from "./tools/fileTools.ts";
import { createWebTools, type WebToolOptions } from "./tools/webTools.ts";
import { createPlanTool } from "./tools/planTool.ts";
import { createRequestTool } from "./tools/requestTool.ts";
import { ACTION_DENIED_BY_CONSTRAINT, decideAction, describeContract, describeDeferral } from "./actionPolicy.ts";
import {
  classForbidding,
  describeProhibition,
  prohibitionsIn,
  type ProhibitedClass,
} from "./statedProhibitions.ts";
import {
  emptyContract,
  mergeContract,
  reduceContract,
  type TaskContract,
  type TurnContract,
} from "./turnContract.ts";
import { createBlockedTool, type BlockedReport } from "./tools/blockedTool.ts";
import { exactSourcesIn, type SourceRequirement } from "./sourceProvenance.ts";
import { SourceLedger } from "./sourceFacts.ts";
import { createSourceFactTool } from "./tools/sourceFactTool.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { createShellTools, type ShellToolOptions } from "./tools/shellTools.ts";
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
  /**
   * Whether "항상 허용" is honoured, and for how long. See `ApprovalManager`.
   * Omitted means never, which is the right default for a headless caller.
   */
  rememberGrants?: ApprovalManagerOptions["rememberGrants"];
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
  /**
   * Reading the web. On unless explicitly disabled.
   *
   * Nothing here sends the HASA key or reaches a private address — see
   * `web/address.ts` — and a fetched page arrives marked as untrusted. The
   * switch exists because a workspace may be somewhere the network is not
   * wanted at all, and that is the user's call rather than this file's.
   */
  web?: WebToolOptions & { enabled?: boolean };
  /** Restricts writes to these path prefixes. Reads stay workspace-wide. */
  writeScope?: string[];
  /**
   * A snapshot taken by a session this one replaces.
   *
   * Only the extension host passes this, and only when it rebuilds a session to
   * change model mid-conversation. Without it the new session reports "nothing
   * to undo" while the previous one's stash is still in the repository with
   * nobody holding its ref.
   */
  checkpoint?: Checkpoint | null;
  budget?: Partial<AgentBudget>;
  logger?: Logger;
  onEvent?: (event: AgentEvent) => void;
  /**
   * The record of what has actually happened, for the final answer to agree
   * with. See `AgentLoopOptions.taskRecord`.
   */
  taskRecord?: () => string | null;
  /**
   * The final response boundary. See `AgentLoopOptions.finalClaims`.
   *
   * Supplied by the host rather than built here, for the same reason
   * `taskRecord` is: the projection it reads spans the whole conversation, and
   * a session sees only the turn it is running.
   */
  finalClaims?: AgentLoopOptions["finalClaims"];
  /** Whether the record already calls the required work finished. */
  taskComplete?: () => boolean;
  /**
   * What runs commands. The real spawn unless a caller injects one.
   *
   * Used by the evaluator so two models meet the same world — see
   * `src/eval/world.ts`. Production never sets it.
   */
  runCommand?: ShellToolOptions["run"];
  /** Told what the user asked for, once the model has recorded it. */
  onContract?: (contract: TurnContract) => void;
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
  /**
   * Where events go. Replaceable, because a sink belongs to a turn.
   *
   * Seeded from the options so an existing caller that passes `onEvent` once
   * keeps working, and overridden per turn by anything that has somewhere
   * better to send them.
   */
  private eventSink: ((event: AgentEvent) => void) | null = null;
  /**
   * What the last turn added to the model's history.
   *
   * Observed across the turn rather than derived from anything: `SessionEvent`
   * and `ProviderMessage` are not interconvertible, and a reconstruction would
   * be a guess written into a record the model is later asked to trust.
   */
  private lastDelta: ProviderMessage[] = [];
  /** What the last turn said it could not do, when it said so. */
  private lastBlocked: BlockedReport | null = null;
  /**
   * What the user has asked for, across the conversation.
   *
   * Held by the session rather than rebuilt per turn because a refinement adds
   * to it and a correction supersedes part of it — both need what came before.
   * Restored with the conversation; see `restoreContract`.
   */
  private contract: TaskContract = emptyContract();
  /**
   * What failed while this turn ran.
   *
   * Collected from the events the loop emits rather than kept by whatever
   * noticed: a blocked report is judged on what the runtime observed, and the
   * runtime observes through its own event stream.
   */
  private turnFailures: string[] = [];
  /**
   * URLs the user has named, across the conversation.
   *
   * Accumulated, because a page named two turns ago is still the page they
   * pointed at — "이어서 해줘" does not retract it. The list marks who chose a
   * URL and nothing more; whether a site is official is not something a
   * hostname can be asked.
   */
  private namedSources: SourceRequirement[] = [];
  /**
   * What this turn's own words forbid, as the runtime read them.
   *
   * Per turn, not accumulated: a prohibition stated once governs the request it
   * was stated in. Carrying it forward would refuse the next turn's work on the
   * strength of the last one's sentence.
   */
  private statedProhibitions: ReadonlySet<ProhibitedClass> = new Set();
  /**
   * The pages this session has read, so a fact about one can be checked.
   *
   * Session-scoped rather than turn-scoped: "그 페이지에서 뭘 봤는지 정리해줘"
   * arrives as a new turn, and refusing to let the model record what it read a
   * moment ago would make the mechanism useless exactly when it is asked for.
   * Bounded, and never written to disk — see `SourceLedger`.
   */
  private readonly ledger = new SourceLedger();
  /** Facts recorded this session, for ids the model cannot choose. */
  private factOrdinal = 0;
  /** The turn being run, so the request tool can stamp what it records. */
  private turnId = "t0";
  private turnOrdinal = 0;

  /**
   * Puts back the contract a conversation had, from its events.
   *
   * The same fold the live path uses, over the events that were persisted — so
   * a reload, a resumption after a timeout and a branch switch all produce the
   * contract that chain actually had. Called by the host beside `restore`,
   * which does the same thing for the model's messages.
   */
  restoreContract(events: readonly { type: string; contract?: unknown }[]): void {
    this.contract = reduceContract(events);
    // Continues past the turns that have been recorded, so a new turn's id does
    // not collide with one already in the contract's history.
    this.turnOrdinal = events.filter((e) => e.type === "turn_contract").length;
  }

  /** What the user has asked for, for a caller that needs to show or check it. */
  get taskContract(): TaskContract {
    return this.contract;
  }

  private constructor(root: string, opts: AgentSessionOptions) {
    this.workspaceRoot = root;
    this.opts = opts;
    this.log = opts.logger ?? nullLogger;
    this.mode = opts.mode ?? "code";
    this.approvals = new ApprovalManager({
      mode: opts.approvalMode ?? "safe",
      port: opts.approvalPort,
      ...(opts.rememberGrants === undefined ? {} : { rememberGrants: opts.rememberGrants }),
    });
    this.checkpoints = new CheckpointManager({
      repoRoot: root,
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
    this.sandbox = new Sandbox({
      root,
      ...(opts.writeScope ? { writeScope: opts.writeScope } : {}),
    });
    this.eventSink = opts.onEvent ?? null;
  }

  private emit(event: AgentEvent): void {
    // Every failed call, kept for the length of the turn. `report_blocked`
    // is judged against these.
    if (event.type === "tool_end" && !event.ok) this.turnFailures.push(event.detail);
    this.eventSink?.(event);
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
    // Adopted after `available()`, which opens the repository. Before it, there
    // is nothing to revert *with*, and the adopted checkpoint would be held by a
    // manager that cannot use it.
    if (opts.checkpoint != null) session.checkpoints.adopt(opts.checkpoint);
    return session;
  }

  /**
   * The snapshot this session is holding, so a replacement can take it over.
   *
   * Exposed for one caller: rebuilding the session to change model. See
   * `checkpoints.adopt` for why handing this across matters.
   */
  get checkpoint(): Checkpoint | null {
    return this.checkpoints.current;
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

  /**
   * Where this session's events go, from now on.
   *
   * The sink used to be fixed at construction, and `openConversation` built its
   * session with `() => {}` because it had no turn to report into yet. That sink
   * then stayed for the life of the session — so reopening a past conversation
   * left the panel permanently silent: every later turn ran, wrote files and
   * finished, and the user watched nothing happen.
   *
   * A sink belongs to a turn, not to a session, which is what this makes true.
   */
  setEventSink(onEvent: ((event: AgentEvent) => void) | null): void {
    this.eventSink = onEvent;
  }

  /** Tools the user has said "always" to, for showing what is standing. */
  grantedTools(): string[] {
    return this.approvals.grantedTools();
  }

  /** Takes back every standing grant, without changing the mode. */
  revokeGrants(): void {
    this.approvals.revokeGrants();
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
        ...(this.opts.runCommand === undefined ? {} : { run: this.opts.runCommand }),
      }),
      ...(this.opts.media === undefined
        ? []
        : createMediaTools({ ...this.opts.media, sandbox: this.sandbox })),
      // Every mode gets these, including the read-only ones: looking something
      // up is reading, and ARCHITECT planning against a library it half
      // remembers is the failure this exists to prevent.
      ...(this.opts.web?.enabled === false
        ? []
        : createWebTools({
            ...this.opts.web,
            // Read at call time, so a URL the user gave in this turn is theirs
            // by the time the model fetches it. Origin only — see
            // `WebToolOptions.userSources`.
            userSources: () => this.namedSources,
            ledger: this.ledger,
          })),
      // Beside the web tools, and only when they exist: recording what a page
      // said is meaningless without something that reads pages.
      ...(this.opts.web?.enabled === false
        ? []
        : [
            createSourceFactTool({
              ledger: this.ledger,
              nextId: () => `sf-${this.turnId}-${++this.factOrdinal}`,
              onFact: (fact) => this.emit({ type: "source_fact", fact }),
            }),
          ]),
      // Also every mode. ARCHITECT plans for a living, and a user watching ASK
      // read six files deserves the same answer to "what is it doing".
      createPlanTool({ onPlan: (event) => this.emit(event) }),
      // Every mode, including the read-only ones. ARCHITECT asked to plan
      // against a file it cannot find is blocked in exactly the same way, and
      // the alternative to saying so is inventing a plan for a file it imagined.
      createBlockedTool({
        onBlocked: (report) => {
          this.lastBlocked = report;
        },
        // What actually failed this turn, so a blocked report has to rest on
        // something the runtime saw rather than on the model's reading of it.
        observedFailures: () => this.turnFailures,
        // Being blocked and being finished are mutually exclusive, and only the
        // caller holding the conversation's events can say which this is.
        ...(this.opts.taskComplete === undefined ? {} : { workIsDone: this.opts.taskComplete }),
      }),
      // First in intent if not in order: what the user asked for, fixed into
      // something the runtime keeps. Every mode — a question misread is a
      // question misanswered whether or not files are involved.
      createRequestTool({
        turnId: () => this.turnId,
        onContract: (contract) => {
          // Folded in now so the rest of this turn is governed by it, and
          // emitted so the fold can be repeated from the events alone. The two
          // must agree, which they do because they are the same function over
          // the same input — see `reduceContract`.
          this.contract = mergeContract(this.contract, contract);
          this.emit({ type: "contract", contract });
          this.opts.onContract?.(contract);
        },
      }),
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
    // Named before the tools are built, so `record_request` stamps what it
    // records with the turn it belongs to rather than with whatever the model
    // supplies. Provenance the model can write is provenance it can get wrong.
    this.turnId = `t${this.turnOrdinal++}`;
    this.turnFailures = [];

    // Before the tools are built, so this turn's own URLs are already the
    // user's when the model reaches for one.
    // Read from the user's words, not from what the model records about them.
    // The same precedent as `exactSourcesIn` directly below: a fact the runtime
    // needs and cannot afford to have transcribed for it. Scoped to this turn —
    // a prohibition stated once does not silently govern the next request.
    this.statedProhibitions = prohibitionsIn(prompt);

    for (const source of exactSourcesIn(prompt)) {
      if (!this.namedSources.some((s) => s.url === source.url)) this.namedSources.push(source);
    }

    // What the user has asked for so far, carried into the prompt. This is the
    // point of the contract: a requirement recorded three turns ago is in front
    // of the model now, whether or not the current plan mentions it.
    const standing = describeContract(this.contract);

    const system: ProviderMessage = {
      role: "system",
      content:
        definition.systemPrompt +
        workspaceNote({
          canRunCommands: (this.opts.commands ?? []).length > 0,
          isGitRepo: this.isGitRepo,
          runtimeGaps: this.opts.runtimeGaps,
        }) +
        (standing === null ? "" : `\n\n지금까지 확인된 요청:\n${standing}\n`),
    };
    this.messages = [system, ...this.messages.filter((m) => m.role !== "system")];

    // The turn's boundary, taken here and not inferred later.
    //
    // Here specifically: after the system message has been re-seeded, so the
    // delta never contains one. A system prompt belongs to the mode a turn ran
    // in, and restoring an old one into a branch would hand the model a prompt
    // for a mode the user has since left.
    //
    // Indexing is sound because the array is append-only from this point: every
    // mutation `AgentLoop` makes is a `push` — six of them, no splice, no
    // assignment, no reordering — and nothing else touches `this.messages`
    // during a turn. `session.test.ts` asserts that prefix rather than assuming
    // it, because the moment it stops being true this arithmetic starts
    // producing histories that never existed.
    const deltaStart = this.messages.length;

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
      // Bound late, so a sink installed after the session was built is the one
      // that receives this turn.
      onEvent: (event) => this.emit(event),
      // What the runtime observed, for the model to answer against. Supplied by
      // the host, which holds the conversation's events; a session on its own
      // sees only the turn it is running.
      ...(this.opts.taskRecord === undefined ? {} : { taskRecord: this.opts.taskRecord }),
      ...(this.opts.finalClaims === undefined ? {} : { finalClaims: this.opts.finalClaims }),
      ...(this.opts.taskComplete === undefined ? {} : { taskComplete: this.opts.taskComplete }),
      // The contract is read at call time, so a constraint recorded partway
      // through a turn governs the rest of it.
      // Named in a stall challenge, so "다른 방법을 시도하십시오" points
      // somewhere rather than being a scolding.
      outstandingWork: () =>
        this.contract.requirements
          .filter((r) => r.lifecycle === "active" && r.required)
          .map((r) => r.description),
      // One question, asked before anything runs. `allow` is the only answer
      // that lets a call through; the other two hold it back and say why in a
      // form the model can act on.
      toolGate: (toolName) => {
        const decision = decideAction(this.contract, toolName, this.turnId);
        if (decision.decision !== "allow") {
          return describeDeferral(decision, toolName, this.contract);
        }
        // The last line, and the only one that does not depend on the model.
        //
        // `decideAction` is sound — six repeated runs of the correction fixture
        // produced three forbidden executions and the gate had allowed none of
        // them; in every case `contract.constraints` was empty, twice with the
        // turn filed correctly. The boundary was enforced exactly right against
        // facts the model was responsible for supplying and did not.
        //
        //     a boundary whose inputs come from the thing it guards against
        //     is not a boundary
        //
        // So the user's own sentence is read here too. It may only ever deny:
        // if it says nothing, the contract still governs and behaviour is
        // unchanged. See `statedProhibitions.ts` for why the patterns require
        // the negation to attach to the verb.
        const stated = classForbidding(this.statedProhibitions, toolName);
        if (stated !== null) {
          // Worth recording as well as refusing. The runtime saw a prohibition
          // the contract does not carry, which is a transcription failure by
          // the model and invisible from the contract alone.
          this.log.warn("stated prohibition refused a call the contract allowed", {
            tool: toolName,
            class: stated,
            constraintsRecorded: this.contract.constraints.length,
          });
          return `${ACTION_DENIED_BY_CONSTRAINT}\n${describeProhibition(stated, toolName)}`;
        }
        return null;
      },
    });

    this.log.info("agent turn", { mode: this.mode, approval: this.approvals.currentMode });
    try {
      return await loop.run(this.messages, signal);
    } finally {
      // Taken in `finally` so an aborted or failed turn still records what the
      // model actually read. A turn that timed out mid-tool-call is a turn that
      // happened, and dropping its history would leave the graph claiming the
      // conversation went somewhere it did not.
      //
      // Copied, not referenced: the loop keeps pushing into this same array on
      // the next turn, and a stored delta that grows afterwards is a record
      // that rewrites itself.
      this.lastDelta = structuredClone(this.messages.slice(deltaStart));
      // Grants scoped to a turn expire here. A session-scoped one does not, and
      // that difference is the whole point of "항상 허용" — a fresh turn is not a
      // fresh conversation.
      this.approvals.endTurn();
    }
  }

  /** Restores the workspace to the state it was in before this session wrote. */
  async undo(): Promise<boolean> {
    return this.checkpoints.revert();
  }

  /** Accepts this session's changes: the checkpoint is no longer offered. */
  keep(): void {
    this.checkpoints.release();
  }

  /** The commit the workspace is on, for a checkpoint's note. Never acted on. */
  async headSha(): Promise<string | null> {
    return this.checkpoints.headSha();
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

  /**
   * What the last turn added to the model's history, and only that turn.
   *
   * Taken rather than read: a delta belongs to the turn that produced it, and
   * leaving it available would let a second reader attribute it to a turn that
   * did not.
   */
  /** What the last turn reported it could not do. Cleared when read. */
  takeBlockedReport(): BlockedReport | null {
    const report = this.lastBlocked;
    this.lastBlocked = null;
    return report;
  }

  takeMessageDelta(): ProviderMessage[] {
    const delta = this.lastDelta;
    this.lastDelta = [];
    return delta;
  }
}
