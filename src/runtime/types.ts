import type { CandidateSpec, CodeTaskSpec, CommandSpec, RuntimeAdapter } from "../protocol/index.ts";
import type { HasaClient } from "../hasa-client/client.ts";
import type { Logger } from "../hasa-client/logger.ts";
import type { CommandOutcome } from "../core/commands.ts";
import type { Sandbox } from "../core/sandbox.ts";

/**
 * Agent runtime abstraction.
 *
 * The point of this interface is that the choice of runtime is reversible.
 * Phase 0 measured that only two HASA models can call tools at all, and one
 * gateway blocks tool calling entirely for models that could — so the code mode
 * has to be able to run either an agent loop or a patch generator without the
 * orchestrator knowing which.
 *
 * See docs/architecture.md §6.
 */

export interface RunnerEvent {
  phase: "thinking" | "tool" | "command" | "done";
  detail: string;
  step: number;
}

export interface RunnerInput {
  spec: CandidateSpec;
  taskSpec: CodeTaskSpec;
  /** Confined to the candidate's own worktree. */
  sandbox: Sandbox;
  /** Runs an allowlisted command inside the worktree. */
  runCommand: (spec: CommandSpec) => Promise<CommandOutcome>;
  /** Applies a unified diff to the worktree. Throws if it does not apply. */
  applyPatch: (patch: string) => Promise<void>;
  client: HasaClient;
  log: Logger;
  signal: AbortSignal;
  onEvent: (event: RunnerEvent) => void;
  /** Wraps every model call so scheduler caps apply to candidates too. */
  dispatch: <T>(modelId: string, fn: () => Promise<T>) => Promise<T>;
}

export interface RunnerResult {
  toolCalls: number;
  commands: CommandOutcome[];
  /** Free-text summary the agent produced when finishing. */
  summary: string;
  tokensIn: number;
  tokensOut: number;
}

export interface AgentRunner {
  readonly id: RuntimeAdapter;
  run(input: RunnerInput): Promise<RunnerResult>;
}

export class RunnerAborted extends Error {
  constructor(reason: string) {
    super(`runner aborted: ${reason}`);
    this.name = "RunnerAborted";
  }
}
