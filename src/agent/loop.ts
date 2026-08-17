import { createHash } from "node:crypto";
import type { RuntimeSummary, SummarySource } from "./runtimeSummary.ts";
import { CommandRejected } from "../core/commands.ts";
import { SandboxViolation } from "../core/sandbox.ts";
import { nullLogger, type Logger } from "../hasa-client/logger.ts";
import type { NormalizedToolCall, ProviderMessage } from "../provider/types.ts";
import type { ApprovalManager } from "./approval.ts";
import type { CheckpointManager } from "./checkpoint.ts";
import type { ToolRegistry } from "./tools/registry.ts";
import { ACTION_DENIED_BY_CONSTRAINT } from "./actionPolicy.ts";
import {
  describeStall,
  describeStallReason,
  stallReason,
  newProgressState,
  observeAction,
  stallVerdict,
  type ProgressState,
} from "./progress.ts";
import {
  DEFAULT_BUDGET,
  type AgentBudget,
  type AgentEvent,
  type AgentModel,
  type AgentStopReason,
  type AgentTool,
  type AgentTurnResult,
  type ToolContext,
} from "./types.ts";

/**
 * The loop.
 *
 * ```
 *   model → tool request → policy → approval → execute → result → model
 * ```
 *
 * Every arrow is a place this can go wrong, and the ones that matter are not
 * the model's mistakes. They are ours: a loop that runs forever, a write that
 * happened before anything could be undone, a refusal reported as a crash.
 *
 * Three rules shape the code below.
 *
 *   1. **A refusal is a result, not an exception.** A model told "that path is
 *      outside the workspace" tries a legal one. A model whose turn just ended
 *      learns nothing, and neither does the user.
 *   2. **The checkpoint is taken before the first write, not after the last.**
 *      A crash between the two is exactly when someone needs it to exist.
 *   3. **Every budget is separate**, because they fail differently — see
 *      `AgentBudget`.
 */

export interface AgentLoopOptions {
  model: AgentModel;
  tools: ToolRegistry;
  approvals: ApprovalManager;
  checkpoints: CheckpointManager | null;
  workspaceRoot: string;
  systemPrompt: string;
  budget?: Partial<AgentBudget>;
  logger?: Logger;
  now?: () => number;
  onEvent?: (event: AgentEvent) => void;
  /**
   * The record, for the model to answer against.
   *
   * Consulted once, when the model is about to finish. What comes back is what
   * the runtime observed — which requirements the tools actually settled, which
   * failed, which were never run — and it is handed over *before* the answer is
   * written rather than checked afterwards.
   *
   * That ordering is the design. Correcting a finished claim means rewriting
   * someone's prose around a fact they did not have; giving them the fact first
   * means the sentence is never written. Null when there is nothing to say.
   */
  taskRecord?: () => string | null;
  /**
   * What the user forbade this turn, enforced before approval.
   *
   * A constraint the user stated in words is not something they should then
   * have to decline in a modal. Returns null when the tool may run.
   */
  toolGate?: (toolName: string) => string | null;
  /** Requirements still outstanding, named in a stall challenge. */
  outstandingWork?: () => string[];
  /** Whether the record already calls the required work finished. */
  taskComplete?: () => boolean;
  /**
   * The boundary between the model's answer and the user.
   *
   * `validate` is asked of every candidate — not once per turn — and returns
   * null when the answer may be sent. `fallback` is what gets sent instead when
   * the repair budget runs out, written by the runtime from its own record.
   *
   * Both together, because a gate without a fallback is not a gate: the
   * alternative to sending the runtime's summary is sending the unsafe
   * candidate, which is what the budget was supposed to prevent. See
   * `finalClaims.ts`.
   */
  finalClaims?: {
    validate: (text: string) => string | null;
    /**
     * What gets sent instead when the repair budget runs out.
     *
     * Returns a `RuntimeSummary` rather than a string so the loop cannot
     * mistake a model-authored answer for a runtime-authored one, and so no
     * caller can promote one by handing over text. See `runtimeSummary.ts`.
     */
    fallback: () => RuntimeSummary;
  };
}

/**
 * How much verbatim output an event may carry to the panel.
 *
 * `detail` stays at 200 characters and stays a status line. This is the other
 * budget — for the output a tool explicitly asked to have shown — and it is
 * sized for the case that motivated it: sixty lines of a failing test run,
 * which is the whole reason the user asked the agent to run anything.
 */
const MAX_DISPLAYED_OUTPUT = 8_000;

/**
 * How many times a final answer may be sent back before the runtime writes one.
 *
 * Two, and small on purpose. The correction names every violation at once and
 * quotes the sentences, so a model that is going to fix it fixes it on the
 * first pass; a third attempt is a model arguing, and the user is waiting
 * through every round of it. What follows exhaustion is not the last candidate
 * — see the fallback beside this — so the budget bounds the wait rather than
 * the guarantee.
 */
const MAX_FINAL_CLAIM_REPAIRS = 2;

/**
 * How many times a tool call the parser could not read is handed back.
 *
 * Two. A model that mistyped a tag fixes it when told which tag; one that
 * cannot is not going to on the fifth attempt, and every attempt is a round
 * trip the user waits through. What follows exhaustion is the model's prose
 * without the parser's complaint attached — never the complaint itself.
 */
const MAX_PROTOCOL_REPAIRS = 2;

/**
 * Cuts displayed output, and says that it did.
 *
 * A bare `slice` here would be the same mistake this whole change is about: the
 * user reads the block to find out what happened, and output that stops without
 * saying it was cut reads as output that ended.
 */
function clipDisplayed(text: string): string {
  if (text.length <= MAX_DISPLAYED_OUTPUT) return text;
  return `${text.slice(0, MAX_DISPLAYED_OUTPUT)}\n…[${text.length - MAX_DISPLAYED_OUTPUT}자 더 있습니다]`;
}

interface RunState {
  steps: number;
  modelCalls: number;
  toolCalls: number;
  /** Whether this turn has already been asked to act on what it announced. */
  nudged: boolean;
  inputTokens: number;
  outputTokens: number;
  changed: Set<string>;
  /** How often each distinct call has been made this turn. */
  callCounts: Map<string, number>;
  summary: string;
  denied: boolean;
  /** Set by `report_blocked`. The turn ends and does not read as success. */
  blocked: boolean;
  /** Whether the model has already been shown the record. Once per turn. */
  reconciled: boolean;
  /** How many times a malformed tool call has been handed back. */
  protocolRepairs: number;
  /** How many times the final answer has been sent back to be fixed. */
  claimRepairs: number;
  /** True when the runtime answered instead of the model. */
  safeFallback: boolean;
  /** Who wrote the final answer. Never derived from the text. */
  summarySource: SummarySource;
  /** Calls held back before running — denied or deferred. */
  deferred: number;
  /** Calls that actually ran. Distinct from `toolCalls`, which counts proposals. */
  executed: number;
  /** Whether the turn is getting anywhere. See `progress.ts`. */
  progress: ProgressState;
}

/** Identifies "the same request again" — the name plus the exact arguments. */
function fingerprintCall(call: NormalizedToolCall): string {
  return createHash("sha256").update(`${call.name}\u0000${call.rawArguments}`).digest("hex").slice(0, 16);
}

function argumentsOf(call: NormalizedToolCall): Record<string, unknown> {
  const value = call.arguments;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export class AgentLoop {
  private readonly opts: AgentLoopOptions;
  private readonly budget: AgentBudget;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(opts: AgentLoopOptions) {
    this.opts = opts;
    this.budget = { ...DEFAULT_BUDGET, ...opts.budget };
    this.log = opts.logger ?? nullLogger;
    this.now = opts.now ?? Date.now;
  }

  private emit(event: AgentEvent): void {
    this.opts.onEvent?.(event);
  }

  /**
   * Runs one turn to completion.
   *
   * `messages` is the conversation so far and is mutated as the turn proceeds,
   * so a session can hand the same array to the next turn and keep its history.
   */
  async run(messages: ProviderMessage[], signal: AbortSignal): Promise<AgentTurnResult> {
    const state: RunState = {
      steps: 0,
      modelCalls: 0,
      toolCalls: 0,
      nudged: false,
      inputTokens: 0,
      outputTokens: 0,
      changed: new Set(),
      callCounts: new Map(),
      summary: "",
      denied: false,
      blocked: false,
      reconciled: false,
      protocolRepairs: 0,
      claimRepairs: 0,
      safeFallback: false,
      // Runtime until a model candidate is accepted. A turn that produces no
      // answer at all falls through to `defaultSummary`, which the runtime
      // writes — so the default is the honest one and the model has to earn
      // the other by getting a candidate past the gate.
      summarySource: "runtime",
      deferred: 0,
      executed: 0,
      progress: newProgressState(),
    };

    const deadline = this.now() + this.budget.timeoutMs;
    // One signal for the whole turn: the caller's cancellation and our own
    // deadline are the same thing to everything downstream.
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal.reason);
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });

    let reason: AgentStopReason = "finished";
    try {
      reason = await this.iterate(messages, state, controller, deadline);
    } catch (err) {
      if (controller.signal.aborted) {
        reason = signal.aborted ? "aborted" : "timeout";
      } else {
        this.log.error("agent turn failed", { error: err });
        this.emit({
          type: "error",
          code: "internal",
          message: err instanceof Error ? err.message : String(err),
        });
        reason = "error";
        state.summary = state.summary || "작업 중 오류가 발생했습니다.";
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }

    const changedFiles = [...state.changed].sort();
    if (changedFiles.length > 0) this.emit({ type: "changed", files: changedFiles });
    // When nothing survived, the runtime writes the answer — so the source is
    // the runtime's, whatever an earlier candidate might have set it to.
    const summary = state.summary || defaultSummary(reason, changedFiles.length);
    const summarySource: SummarySource = state.summary.length === 0 ? "runtime" : state.summarySource;
    // Why *this* run hit *this* reason. The reason is a category and the panel
    // has a label for it; the detail is the part a user can act on — which call
    // repeated, which budget ran out — and without it "반복 행동 감지" is a
    // verdict with no evidence.
    const detail = terminationDetail(reason, state);
    this.emit({ type: "done", reason, summary, ...(detail === null ? {} : { detail }) });

    return {
      reason,
      summary,
      changedFiles,
      checkpointRef: this.opts.checkpoints?.current?.ref ?? null,
      steps: state.steps,
      modelCalls: state.modelCalls,
      toolCalls: state.toolCalls,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      claimRepairs: state.claimRepairs,
      summarySource,
      ...(state.safeFallback ? { safeFallback: true as const } : {}),
    };
  }

  private async iterate(
    messages: ProviderMessage[],
    state: RunState,
    controller: AbortController,
    deadline: number,
  ): Promise<AgentStopReason> {
    const providerTools = this.opts.tools.toProviderTools();

    for (;;) {
      if (controller.signal.aborted) return "aborted";
      if (this.now() >= deadline) {
        controller.abort(new Error("agent turn timed out"));
        return "timeout";
      }
      if (state.steps >= this.budget.maxSteps) return "max_steps";
      if (state.modelCalls >= this.budget.maxModelCalls) return "max_model_calls";

      state.steps += 1;
      this.emit({ type: "step", step: state.steps });

      state.modelCalls += 1;
      // The turn's deadline was checked at the top of the loop and then not
      // enforced during the one thing that actually takes time. A model call
      // that never returns outlived the budget indefinitely — the loop was
      // waiting inside `await`, and nothing was left to notice. Now the
      // deadline is a signal the call is subject to, not a check it passes on
      // the way in.
      const remaining = deadline - this.now();
      const timer = setTimeout(() => controller.abort(new Error("agent turn timed out")), remaining);
      let completion;
      try {
        completion = await this.opts.model.complete(
          {
            messages,
            ...(providerTools.length > 0 ? { tools: providerTools, toolChoice: "auto" as const } : {}),
          },
          controller.signal,
        );
      } finally {
        clearTimeout(timer);
      }
      if (this.now() >= deadline) return "timeout";
      state.inputTokens += completion.inputTokens;
      state.outputTokens += completion.outputTokens;

      if (completion.reasoning.length > 0) {
        this.emit({ type: "reasoning", delta: completion.reasoning });
      }
      if (completion.text.length > 0) {
        this.emit({ type: "text", delta: completion.text });
      }

      // No tool calls usually means the model has said its piece. Usually.
      //
      // The exception is the one users kept hitting: it writes "이제 실행해
      // 보겠습니다", stops, and the loop reads an announcement as an answer. The
      // user is left with a turn that promised work and did none — repeatedly,
      // because asking again produces the same promise. Narrating intent before
      // acting makes this *more* likely, not less, so the prompt that asks for
      // narration has to be matched by a loop that does not mistake it for a
      // conclusion.
      // A call the model meant to make and the parser could not read.
      //
      // Handed straight back, before anything treats the reply as an answer. A
      // model that mistyped a call has not finished; it has failed to act, and
      // in a live run that difference cost a whole turn — the parser's
      // complaint became the user's answer and the turn ended `finished` after
      // two steps.
      if (completion.protocolProblem !== undefined && completion.toolCalls.length === 0) {
        if (state.protocolRepairs < MAX_PROTOCOL_REPAIRS) {
          state.protocolRepairs += 1;
          this.log.info("tool call could not be read; asking again", { problem: completion.protocolProblem });
          messages.push({ role: "assistant", content: completion.text, toolCalls: [] });
          messages.push({
            role: "user",
            content:
              `${completion.protocolProblem}

` +
              "위에 설명된 형식으로 호출을 다시 작성하십시오. 필수 항목을 빠뜨리지 마십시오.",
          });
          continue;
        }
        // Out of attempts. The prose is what the model actually said to the
        // user; the parser's message is not, and it is not shown.
        this.log.warn("tool call still unreadable after repairs", { problem: completion.protocolProblem });
      }

      if (completion.toolCalls.length === 0) {
        // Three conditions, and the structural one carries most of the weight:
        // a turn that has already used a tool and now promises more is a turn in
        // progress, whatever it says. Only a turn where *nothing ran at all* can
        // be the failure this guards against.
        if (state.nudged || state.toolCalls > 0 || !announcesAction(completion.text)) {
          // One chance to answer against the record before the turn closes.
          //
          // The failure this exists for: a run whose model load failed, whose
          // only "test" was a command printing a sentence it had written
          // itself, and whose answer was "모든 코드가 정상적으로 작동합니다".
          // Every part of that was known here as fact and none of it reached
          // the model at the moment it mattered.
          //
          // Once per turn, and only when a tool actually ran — a turn that
          // answered a question without touching the workspace has no record to
          // disagree with.
          if (!state.reconciled && state.toolCalls > 0) {
            const record = this.opts.taskRecord?.() ?? null;
            if (record !== null) {
              state.reconciled = true;
              messages.push({ role: "assistant", content: completion.text, toolCalls: [] });
              messages.push({
                role: "user",
                content: [
                  "이것은 런타임이 관측한 기록입니다. 도구가 실제로 보고한 것이며 " +
                    "당신이 쓴 문장에서 온 것이 아닙니다.",
                  record,
                  "이 기록과 어긋나지 않게 사용자에게 답하십시오. 실행하지 않은 것을 " +
                    "실행했다고, 실패한 것을 성공했다고 쓰지 마십시오. 남은 것이 있으면 " +
                    "무엇이 남았는지 함께 적으십시오.",
                ].join("\n\n"),
              });
              continue;
            }
          }
          // The boundary. Asked of *this candidate*, and of every candidate
          // after it.
          //
          // It used to be asked once per turn, and C4.7 measured what that
          // cost: a model that repeated the sentence got it through on the
          // second attempt. A gate that stops checking after the first refusal
          // is a gate with a second door — so the question here is "may this
          // answer be sent", never "have we already asked this turn".
          const unsafe = this.opts.finalClaims?.validate(completion.text) ?? null;
          if (unsafe !== null) {
            if (state.claimRepairs < MAX_FINAL_CLAIM_REPAIRS) {
              state.claimRepairs += 1;
              messages.push({ role: "assistant", content: completion.text, toolCalls: [] });
              messages.push({ role: "user", content: unsafe });
              continue;
            }
            // Fail closed. The repairs are spent and the candidate is still
            // wrong, so it is not the thing that gets sent — the runtime's own
            // summary is. Anything else would make "escaped = 0" a statement
            // about how patient the model was.
            state.safeFallback = true;
            const written = this.opts.finalClaims?.fallback();
            state.summary = written?.text ?? "";
            state.summarySource = "runtime";
            this.log.warn("final claim repairs exhausted; sending the runtime's summary", {
              repairs: state.claimRepairs,
            });
            if (state.summary.length > 0) {
              messages.push({ role: "assistant", content: state.summary, toolCalls: [] });
            }
            return "finished";
          }

          state.summary = completion.text.trim();
          // The model wrote this one. Recorded here, at the branch that knows,
          // rather than inferred later from what the text says.
          state.summarySource = "model";
          // The answer goes into the history like every other assistant turn.
          //
          // It did not, and the consequence was not subtle: `messages` is what
          // gets persisted, and the final reply of every turn is produced on
          // exactly this path — so a saved conversation held the user's
          // questions and none of the answers, and the next turn's context was
          // missing everything the model had ever concluded. A turn that called
          // a tool pushed its assistant message at the branch below; a turn
          // that simply answered pushed nothing.
          if (state.summary.length > 0) {
            messages.push({ role: "assistant", content: completion.text, toolCalls: [] });
          }
          return "finished";
        }
        // Once per turn. A second one against a model that genuinely meant to
        // stop would be an argument, and the message below lets it say so.
        state.nudged = true;
        this.log.info("model announced work without doing it; asking once", {
          text: completion.text.slice(0, 120),
        });
        messages.push({ role: "assistant", content: completion.text, toolCalls: [] });
        messages.push({
          role: "user",
          content:
            "You described what you were about to do but did not do it — no tool was called, " +
            "so nothing happened and I cannot see any result. Do it now, using the tools. " +
            "If you cannot, say plainly what is stopping you. If you were actually finished, " +
            "say so in one sentence and stop.",
        });
        continue;
      }

      messages.push({
        role: "assistant",
        content: completion.text.length > 0 ? completion.text : null,
        toolCalls: completion.toolCalls,
      });

      for (const call of completion.toolCalls) {
        if (controller.signal.aborted) return "aborted";
        if (state.toolCalls >= this.budget.maxToolCalls) return "max_tool_calls";

        const repeated = this.trackRepeat(state, call);
        if (repeated) {
          // The model is asking for the same thing again and getting the same
          // answer. Another round would be another identical answer.
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content:
              "You have already made this exact request several times this turn. " +
              "Repeating it will not produce a different answer. Do something else, " +
              "or tell the user what is blocking you and stop.",
          });
          return "loop_detected";
        }

        state.toolCalls += 1;
        const outcome = await this.invoke(call, state, controller);
        messages.push({ role: "tool", toolCallId: call.id, content: outcome });
        if (state.denied) return "denied";
        // Beside `denied` because it is the same kind of thing: an outcome the
        // turn reached deliberately, not a failure of the loop. Ending here is
        // what stops the model looking for something to substitute instead.
        if (state.blocked) return "blocked";

        // Whether any of this is getting anywhere. Asked here rather than at
        // `maxSteps`, which was catching it forty actions later.
        const verdict = stallVerdict(state.progress);
        if (verdict === "stop") {
          this.log.info("no progress; ending the run", { streak: state.progress.streak });
          return "no_progress";
        }
        if (verdict === "warn") {
          state.progress.challenged = true;
          // What to say depends on whether there is anything left to do.
          //
          // "다른 방법을 시도하십시오" is right for a model that is stuck and
          // wrong for one that has finished — and a model with nothing left
          // reaches for another tool because that is what it was just told to
          // do. Seen in a live run: two files written, `pytest` exit 0, every
          // requirement passed, and then five more tool calls until the step
          // budget ran out, with the user shown "한 번에 처리할 수 있는 분량을
          // 넘어 중단했습니다" for work sitting finished on disk.
          const done = this.opts.taskComplete?.() === true;
          const challenge = done
            ? "기록상 요구사항이 모두 확인되었습니다. 도구를 더 호출하지 말고, 무엇을 했고 " +
              "무엇을 확인했는지 지금 사용자에게 답하십시오."
            : describeStall(state.progress, this.opts.outstandingWork?.() ?? []);
          this.log.info("no progress; challenging once", { streak: state.progress.streak, done });
          messages.push({ role: "user", content: challenge });
          this.emit({ type: "phase", label: done ? "결과를 정리하는 중" : "다른 방법을 찾는 중" });
        }
      }
    }
  }

  /**
   * True when this exact request has been made too many times this turn.
   *
   * Counted across the whole turn rather than consecutively, because the loops
   * that actually happen are cycles rather than repeats. Observed in use:
   * `create_file` → `get_git_diff` → `create_file` → `get_git_diff`, each one
   * different from the one before it, running until the step budget ran out. A
   * consecutive counter resets on every alternation and never fires.
   *
   * Three of the same call is still allowed: reading a file again after editing
   * it is ordinary work, and the result differs even though the request does
   * not.
   */
  private trackRepeat(state: RunState, call: NormalizedToolCall): boolean {
    const print = fingerprintCall(call);
    const seen = (state.callCounts.get(print) ?? 0) + 1;
    state.callCounts.set(print, seen);
    return seen > this.budget.maxRepeatedCalls;
  }

  /**
   * Policy, approval, execution — and a string for the model whatever happens.
   *
   * Nothing in here throws for an ordinary refusal. A sandbox violation, a
   * rejected command, an unknown tool and a user's "no" are all answers, and a
   * model that receives one can act on it.
   */
  private async invoke(
    call: NormalizedToolCall,
    state: RunState,
    controller: AbortController,
  ): Promise<string> {
    // Both refusals below used to return before any event was emitted, so a
    // model reaching for a tool its mode does not have burned a round trip that
    // the panel showed no trace of — the user saw a turn take longer and end,
    // with nothing to say why. The refusal is the useful part; it belongs on
    // screen as much as in the model's history.
    // Preflight: before the registry, before approval, before anything runs.
    //
    // This used to let a call through and attach a note to its result, which
    // meant the command had already run by the time anything objected — the
    // failure the note was written for happened anyway and got a footnote. A
    // policy that only comments is not a policy.
    const held = this.opts.toolGate?.(call.name) ?? null;
    if (held !== null) {
      state.deferred += 1;
      // Decided once, here, where the reason is actually known. It used to be
      // recovered downstream by looking for this code inside the sentence sent
      // to the model, which made every count of deferrals depend on the wording
      // of that sentence.
      const disposition = held.startsWith(ACTION_DENIED_BY_CONSTRAINT) ? "denied" : "deferred";
      // A call that never ran moved nothing, and a model that keeps proposing
      // the same held-back action is the loop f4b4a30 created: each proposal
      // gets a challenge and the run would otherwise reach `maxSteps`.
      observeAction(state.progress, {
        toolName: call.name,
        args: argumentsOf(call),
        outcome: disposition,
        detail: held,
        changedFiles: [],
      });
      this.emit({
        type: "tool_end",
        callId: call.id,
        name: call.name,
        ok: false,
        detail: held,
        disposition,
      });
      return held;
    }

    const tool = this.opts.tools.get(call.name);
    if (tool === null) {
      // Naming the tools it does have, because the usual cause is a model
      // reaching for one from a mode it is not in.
      const available = this.opts.tools.list().map((t) => t.name).join(", ");
      const refusal = `refused: there is no tool called "${call.name}". Available tools: ${available}`;
      this.emit({ type: "tool_start", callId: call.id, name: call.name, risk: "read", summary: `${call.name} — 없는 도구입니다` });
      this.emit({ type: "tool_end", callId: call.id, name: call.name, ok: false, detail: refusal.slice(0, 200) });
      return refusal;
    }

    if (!call.argumentsValid) {
      const refusal = `refused: the arguments for ${call.name} were not a JSON object. Received: ${call.rawArguments.slice(0, 200)}`;
      this.emit({ type: "tool_start", callId: call.id, name: tool.name, risk: tool.risk, summary: `${tool.name} — 인자를 읽지 못했습니다` });
      this.emit({ type: "tool_end", callId: call.id, name: tool.name, ok: false, detail: refusal.slice(0, 200) });
      return refusal;
    }

    const args = argumentsOf(call);
    const summary = safeSummarize(tool, args);
    this.emit({ type: "tool_start", callId: call.id, name: tool.name, risk: tool.risk, summary });

    const ctx: ToolContext = { workspaceRoot: this.opts.workspaceRoot, signal: controller.signal };

    // The preview is built before approval because it is what the user is
    // approving. Failing to build one is not a reason to skip the question.
    let preview: string | null = null;
    if (!this.opts.approvals.isAutomatic(tool.risk) && tool.preview !== undefined) {
      preview = await tool.preview(args, ctx).catch(() => null);
    }

    const outcome = await this.opts.approvals.decide({
      toolName: tool.name,
      risk: tool.risk,
      summary,
      preview,
    });
    this.emit({ type: "tool_approval", callId: call.id, name: tool.name, outcome });

    // Not the `blocked` termination reason. This one is the approval policy
    // refusing a tool outright; that one is the agent saying it cannot do what
    // was asked. Different unions, and TypeScript keeps them apart.
    if (outcome === "blocked") {
      const detail = `refused: ${tool.name} is not permitted.`;
      this.emit({ type: "tool_end", callId: call.id, name: tool.name, ok: false, detail });
      return detail;
    }
    if (outcome === "denied") {
      // The user's "no" ends the turn. Continuing would mean working around a
      // decision they just made.
      state.denied = true;
      state.summary = "요청하신 작업을 중단했습니다.";
      const detail = "the user declined this action.";
      this.emit({ type: "tool_end", callId: call.id, name: tool.name, ok: false, detail });
      return detail;
    }

    // Anything that writes gets the workspace protected first.
    if (tool.risk !== "read" && this.opts.checkpoints !== null) {
      const checkpoint = await this.opts.checkpoints.ensure();
      if (checkpoint !== null && checkpoint.ref !== null) {
        this.emit({ type: "checkpoint", ref: checkpoint.ref, detail: checkpoint.detail });
      }
    }

    try {
      const result = await tool.execute(args, ctx);
      // Read from the result, not from the tool's name. The turn ends after this
      // call returns, at the check beside `denied`.
      if (result.blocked === true) state.blocked = true;
      for (const file of result.changedFiles ?? []) state.changed.add(file);
      for (const change of result.changes ?? []) state.changed.add(change.path);
      this.emit({
        type: "tool_end",
        callId: call.id,
        name: tool.name,
        ok: result.ok,
        detail: result.content.slice(0, 200),
        // Only when the tool asked. The cap is generous because the thing being
        // carried is evidence the user requested — 60 lines of test output is
        // the answer, not noise — and still a cap, because a webview should
        // never be handed something unbounded.
        ...(result.display === undefined ? {} : { output: clipDisplayed(result.display) }),
        // Carried rather than summarised. What changed and how much was left
        // out are both facts about this call, and the only place that knows
        // them is the call.
        ...(result.changes === undefined ? {} : { changedFiles: result.changes }),
        ...(result.meta === undefined ? {} : { meta: result.meta }),
        // Where it read from. Carried rather than summarised for the same
        // reason as `changes`: `detail` is 200 characters and the host is not
        // reliably among them.
        ...(result.sources === undefined ? {} : { sources: result.sources }),
      });
      state.executed += 1;
      observeAction(state.progress, {
        toolName: call.name,
        args: argumentsOf(call),
        outcome: result.ok ? "executed" : "failed",
        detail: result.content,
        changedFiles: [...(result.changedFiles ?? []), ...(result.changes ?? []).map((c) => c.path)],
        ...(result.sources === undefined ? {} : { sources: result.sources }),
      });
      return result.content;
    } catch (err) {
      if (controller.signal.aborted) throw err;
      const detail = describeToolFailure(err);
      this.log.warn("tool call failed", { tool: tool.name, detail });
      this.emit({ type: "tool_end", callId: call.id, name: tool.name, ok: false, detail });
      return detail;
    }
  }
}

/** A tool whose summariser throws must not take the turn down with it. */
function safeSummarize(tool: AgentTool, args: Record<string, unknown>): string {
  try {
    return tool.summarize(args);
  } catch {
    return `${tool.name} 을(를) 실행합니다`;
  }
}

function describeToolFailure(err: unknown): string {
  if (err instanceof SandboxViolation) return `refused: ${err.message}`;
  if (err instanceof CommandRejected) return `refused: ${err.message}`;
  if (err instanceof Error) return `error: ${err.message}`;
  return "error: the tool failed for an unknown reason";
}

/**
 * Whether a reply promises an action rather than reporting one.
 *
 * Observed, repeatedly: "이제 코드를 실행해보겠습니다." followed by nothing. The
 * loop read it as the answer, the user asked again, and the model made the same
 * promise — three times in one transcript.
 *
 * Matching on phrasing is a heuristic and is treated as one. It is deliberately
 * narrow: only the first person and only the future, so "파일을 읽었습니다" and
 * "실행하면 됩니다" do not fire. And the cost of being wrong is one extra model
 * call whose prompt explicitly says "if you were actually finished, say so" —
 * which is why a heuristic is acceptable here and would not be if it decided
 * anything irreversible.
 *
 * Past tense wins over future, so "설치했고 이제 실행하겠습니다" — work that was
 * done — is not treated as an empty promise.
 */
export function announcesAction(text: string): boolean {
  const body = text.trim();
  if (body.length === 0) return false;
  // Only the tail matters. A reply that narrates three finished steps and ends
  // with a conclusion is finished, whatever it said in the middle.
  const tail = body.slice(-400);

  const FUTURE = [
    // Korean: -겠습니다 / -할게요 / -하려고 합니다, with the verbs that act.
    /(실행|설치|수정|작성|생성|확인|시도|진행|추가|삭제|검색|조회)(해\s*)?(보겠|하겠|할\s*게|하려고|해\s*볼게|해\s*보겠)/,
    /(다시|이제|먼저|우선)\s*[^.!?\n]{0,40}(겠습니다|할게요|하겠음)/,
    // English.
    /\b(i'?ll|i will|let me|i'?m going to|now i(?:'| a)?m?)\s+(run|install|create|write|check|try|fix|update|search|look|read|execute)/i,
  ];
  const PAST = [
    // The connective endings matter as much as the terminal ones: "설치했고,
    // 이제 실행하겠습니다" is a report of work followed by the next step.
    /(실행|설치|수정|작성|생성|확인|추가|삭제)(했|하였)(습니다|어요|음|다|고|으며|는데|지만)/,
    /\b(i )?(ran|installed|created|wrote|checked|fixed|updated|added)\b/i,
  ];

  if (!FUTURE.some((p) => p.test(tail))) return false;
  // A promise that follows evidence of work is a report, not a stall.
  return !PAST.some((p) => p.test(tail));
}

/**
 * The evidence behind a stop reason.
 *
 * Built from what the run actually counted rather than from a table, because
 * "같은 시도를 반복했습니다" without naming the call is a claim the user has to
 * take on trust — and the one thing they would do with it is look at which
 * tool. Null when the reason speaks for itself.
 */
function terminationDetail(reason: AgentStopReason, state: RunState): string | null {
  switch (reason) {
    case "loop_detected": {
      // The call that tripped it is the one seen most often.
      const worst = [...state.callCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (worst === undefined) return null;
      const name = worst[0].split(":")[0] ?? worst[0];
      return `${name} 을(를) ${worst[1]}번 같은 인자로 호출했습니다.`;
    }
    case "no_progress": {
      // The specific reason, so the panel does not have to guess and the user
      // is not told their request was vague when it was not.
      const reason = stallReason(state.progress);
      return `${describeStallReason(reason)} (${state.progress.streak}개 행동, ${reason})`;
    }
    case "max_tool_calls":
      return `도구를 ${state.toolCalls}번 호출했습니다.`;
    case "max_model_calls":
      return `모델을 ${state.modelCalls}번 호출했습니다.`;
    case "max_steps":
      return `${state.steps}단계까지 진행했습니다.`;
    case "timeout":
      return `${state.steps}단계, 도구 ${state.toolCalls}회까지 진행한 뒤 시간이 초과됐습니다.`;
    default:
      return null;
  }
}

export function defaultSummary(reason: AgentStopReason, changed: number): string {
  switch (reason) {
    case "finished":
      // Not "완료했습니다".
      //
      // This line was the source of every false completion claim the first live
      // sweep found. It is written *after* the completion gate, from a reason
      // code and a file count, with no access to the task record — so it was
      // the one completion claim in the system that nothing could refuse, and
      // seventeen of them were counted against the models that provoked them.
      // The models had said nothing of the kind; several had said nothing at
      // all, which is exactly the condition that reaches here.
      //
      //     run ended  ≠  task complete
      //
      // A file count is an observation and stays. "완료했습니다" is a verdict,
      // and the runtime does not have the facts to reach it here.
      return changed > 0
        ? `${changed}개 파일을 수정했습니다.`
        : "이번 차례에는 기록된 작업이 없습니다. 무엇을 해야 할지 조금 더 알려 주세요.";
    case "denied":
      return "요청하신 작업을 중단했습니다.";
    case "aborted":
      return "작업을 취소했습니다.";
    case "timeout":
      return "시간이 초과되어 중단했습니다. 작업을 더 작게 나누어 다시 요청해 주세요.";
    case "loop_detected":
      return "같은 시도를 반복하고 있어 중단했습니다. 요청을 조금 더 구체적으로 알려 주세요.";
    case "max_steps":
    case "max_model_calls":
    case "max_tool_calls":
      return "한 번에 처리할 수 있는 분량을 넘어 중단했습니다. 작업을 나누어 다시 요청해 주세요.";
    default:
      return "작업을 완료하지 못했습니다.";
  }
}
