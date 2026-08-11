import { AgentSession } from "../agent/session.ts";
import { allowingApprovalPort } from "../agent/approval.ts";
import { TurnRecorder } from "../agent/sessionRecorder.ts";
import { reduceTask } from "../agent/taskReducer.ts";
import { describeTask } from "../agent/taskState.ts";
import { describeUnsupportedClaims, unsupportedClaims } from "../agent/claimGrounding.ts";
import { createWorld, type ControlledWorld } from "./world.ts";
import type { EvalScenario } from "./scenario.ts";
import type { SessionEvent } from "../agent/sessionEvents.ts";
import type { TurnContract } from "../agent/turnContract.ts";
import type { ProviderMessage } from "../provider/types.ts";
import type { AgentEvent, AgentModel, AgentTurnResult } from "../agent/types.ts";

/**
 * Running a scenario the way the product runs a conversation.
 *
 * The one architectural rule of this whole slice: **no shortcut executor.** The
 * evaluator builds an `AgentSession` with the same options the extension host
 * builds one with, wires the same `taskRecord` and `claimCheck` callbacks the
 * host wires, and calls `send` once per user turn. If the eval passed while the
 * product failed, the eval would be measuring a program nobody ships.
 *
 * What is swapped is the world underneath (see `world.ts`) and the model on
 * top. Everything between them is production code.
 *
 * ## What comes back
 *
 * The raw material, not the verdict. `metrics.ts` does the counting, and it
 * does it from `SessionEvent`s and `AgentEvent`s the runtime writes anyway —
 * so a number in the scoreboard is traceable to a line in the log rather than
 * to something the evaluator inferred.
 */

/** One user turn as it actually went. */
export interface TurnTrace {
  index: number;
  user: string;
  /** Everything the runtime emitted while this turn ran, in order. */
  events: AgentEvent[];
  /** The same turn as it was persisted. What a reload would replay. */
  recorded: SessionEvent[];
  /** The contract the model produced, when it produced one. */
  contract: TurnContract | null;
  result: AgentTurnResult | null;
  /** Present when the turn threw rather than ended. */
  error?: string;
  /** Corrections the runtime handed back mid-turn, in order. */
  challenges: string[];
  durationMs: number;
}

export interface RunTrace {
  scenarioId: string;
  model: string;
  run: number;
  turns: TurnTrace[];
  /** Every event of the conversation, which is what the task is reduced from. */
  recorded: SessionEvent[];
  /** Commands the world was actually asked to run. The ground truth for §29. */
  spawned: string[];
  fetched: string[];
  /** Files that exist at the end, so "it wrote something" is checkable. */
  changedFiles: string[];
}

export interface RunnerOptions {
  scenario: EvalScenario;
  /** Built per run, so a model with state cannot carry it between runs. */
  model: () => AgentModel;
  run?: number;
  /** Per-turn ceiling. Keeps one stuck model from holding up a sweep. */
  turnTimeoutMs?: number;
  /** Budget handed to the loop. Small, because a scenario is not a workday. */
  maxSteps?: number;
}

export async function runScenario(opts: RunnerOptions): Promise<RunTrace> {
  const world: ControlledWorld = await createWorld(opts.scenario.world);
  const model = opts.model();
  const recorded: SessionEvent[] = [];
  const turns: TurnTrace[] = [];

  try {
    const session = await AgentSession.open({
      workspaceRoot: world.root,
      model,
      approvalPort: allowingApprovalPort,
      approvalMode: "auto",
      mode: "code",
      ...world.options,
      budget: { maxSteps: opts.maxSteps ?? 14 },
      // Both wired exactly as `agentHost` wires them, from the same projection
      // over the same events. A difference here would be a benchmark measuring
      // a harness the user does not have.
      taskRecord: () => {
        const task = reduceTask(recorded, opts.scenario.id);
        return task === null || task.requirements.length + task.issues.length === 0
          ? null
          : describeTask(task);
      },
      claimCheck: (text) => {
        const task = reduceTask(recorded, opts.scenario.id);
        if (task === null) return null;
        const claims = unsupportedClaims(task.evidence, text, task.sources, task.facts);
        return claims.length === 0 ? null : describeUnsupportedClaims(claims);
      },
    });

    for (const [index, turn] of opts.scenario.turns.entries()) {
      const recorder = new TurnRecorder({ turnId: `t${index}` });
      const events: AgentEvent[] = [];
      let contract: TurnContract | null = null;
      recorder.userMessage(turn.user).forEach((e) => recorded.push(e));

      session.setEventSink((event) => {
        events.push(event);
        if (event.type === "contract") contract = event.contract as TurnContract;
        recorder.record(event).forEach((e) => recorded.push(e));
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.turnTimeoutMs ?? 120_000);
      const started = Date.now();
      let result: AgentTurnResult | null = null;
      let error: string | undefined;
      try {
        result = await session.send(turn.user, controller.signal);
      } catch (err) {
        error = (err as Error).message;
      } finally {
        clearTimeout(timer);
        session.setEventSink(null);
      }

      // The corrections the runtime pushed *into the conversation* rather than
      // onto the event stream. The record brief and the claim gate are both
      // user-role messages the model never received from a person, and neither
      // produces an event — so a runner that only watched events reported a
      // claim gate that had fired as one that never had.
      const delta = session.takeMessageDelta();

      turns.push({
        index,
        user: turn.user,
        events,
        recorded: recorder.drain(),
        contract,
        result,
        ...(error === undefined ? {} : { error }),
        // The corrections the runtime pushed back into the conversation. They
        // are user-role messages the model never saw from a person, and they
        // are how recovery is measured.
        challenges: [...challengesIn(events), ...interventionsIn(delta)],
        durationMs: Date.now() - started,
      });
    }

    return {
      scenarioId: opts.scenario.id,
      model: model.modelId,
      run: opts.run ?? 1,
      turns,
      recorded,
      spawned: [...world.spawned],
      fetched: [...world.fetched],
      changedFiles: [...new Set(recorded.filter((e) => e.type === "file_changed").map((e) => e.path))],
    };
  } finally {
    await world.dispose().catch(() => {});
  }
}

/**
 * What the runtime told the model to fix, this turn.
 *
 * Read from the tool results rather than from the loop's internals: a deferral,
 * a semantic refusal and a malformed-command rejection all arrive as a failed
 * `tool_end` carrying a code the model is expected to act on. Recovery is
 * whether the next proposal differs, and this is the list it is measured
 * against.
 */
function challengesIn(events: readonly AgentEvent[]): string[] {
  const out: string[] = [];
  for (const event of events) {
    if (event.type !== "tool_end" || event.ok) continue;
    out.push(event.detail);
  }
  return out;
}

/**
 * What the runtime said to the model that no person said.
 *
 * Identified by role and by the runtime's own opening lines: a user-role
 * message the *user* did not send is an intervention, and the two the loop
 * makes — the record before the answer, and the claim gate after it — are the
 * ones recovery is measured against.
 */
const RUNTIME_INTERVENTIONS = [
  "이것은 런타임이 관측한 기록입니다",
  "지금까지 관측된 근거보다 강한 주장",
];

function interventionsIn(delta: readonly ProviderMessage[]): string[] {
  const out: string[] = [];
  for (const message of delta) {
    if (message.role !== "user") continue;
    const text = typeof message.content === "string" ? message.content : "";
    if (RUNTIME_INTERVENTIONS.some((marker) => text.includes(marker))) out.push(text);
  }
  return out;
}
