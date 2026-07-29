import type {
  ChatMessage,
  CommandSpec,
  ToolDefinition,
} from "../protocol/index.ts";
import { CommandRejected } from "../core/commands.ts";
import { SandboxViolation } from "../core/sandbox.ts";
import type { CommandOutcome } from "../core/commands.ts";
import { RunnerAborted, type AgentRunner, type RunnerInput, type RunnerResult } from "./types.ts";

/**
 * Tool-calling agent loop.
 *
 * Written in-house rather than delegated to ClineCore for one reason: the
 * sandbox guarantees in docs/security-policy.md (§2.3 worktree confinement by
 * realpath, §2.1 allowlisted commands, §1.3 no key inheritance) have to be
 * *enforced and testable here*, not merely requested of another runtime through
 * an approval callback. The `AgentRunner` interface keeps ClineCore swappable —
 * its `CoreModelConfig` accepts `providerId`/`baseUrl`/`apiKey` directly, which
 * was verified against @cline/sdk 0.0.66.
 */

const SYSTEM_PROMPT = `You are a software engineer working inside an isolated git worktree.

Rules:
- You can only read and write files inside the worktree. Paths are relative to it.
- You may only run commands that were declared for this task. Anything else is refused.
- Make the smallest change that satisfies the request. Do not reformat unrelated code.
- Match the surrounding code's style, naming and comment density.
- When you are done, call the "finish" tool with a short summary of what you changed.
- If you cannot complete the task, call "finish" and say why. Do not invent success.`;

function tools(commandGates: string[]): ToolDefinition[] {
  const defs: ToolDefinition[] = [
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List files in a directory inside the worktree.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Relative directory, '.' for the root" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a UTF-8 text file inside the worktree.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Relative file path" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Create or overwrite a file inside the worktree with the full new contents.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative file path" },
            contents: { type: "string", description: "Complete file contents" },
          },
          required: ["path", "contents"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "finish",
        description: "Declare the task complete and summarise the change.",
        parameters: {
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
          additionalProperties: false,
        },
      },
    },
  ];

  if (commandGates.length > 0) {
    defs.splice(3, 0, {
      type: "function",
      function: {
        name: "run_command",
        description: `Run one of the task's declared commands: ${commandGates.join(", ")}.`,
        parameters: {
          type: "object",
          properties: {
            gate: { type: "string", enum: commandGates, description: "Which declared command to run" },
          },
          required: ["gate"],
          additionalProperties: false,
        },
      },
    });
  }
  return defs;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text?: unknown }).text ?? "") : ""))
      .join("");
  }
  return "";
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function summariseCommand(outcome: CommandOutcome): string {
  const tail = (text: string): string => text.split("\n").slice(-25).join("\n");
  return [
    `exit=${outcome.exitCode ?? "null"}${outcome.timedOut ? " (timed out)" : ""} in ${outcome.durationMs}ms`,
    outcome.stdout.trim() ? `stdout:\n${tail(outcome.stdout)}` : "",
    outcome.stderr.trim() ? `stderr:\n${tail(outcome.stderr)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export class ToolCallingRunner implements AgentRunner {
  readonly id = "agent" as const;

  async run(input: RunnerInput): Promise<RunnerResult> {
    const { spec, taskSpec, sandbox, client, log, signal, onEvent, dispatch } = input;

    const commandsByGate = new Map<string, CommandSpec>();
    for (const c of taskSpec.acceptanceCommands) commandsByGate.set(c.gate, c);
    const toolDefs = tools([...commandsByGate.keys()]);

    const messages: ChatMessage[] = [
      { role: "system", content: taskSpec.systemPrompt ?? SYSTEM_PROMPT },
      { role: "user", content: taskSpec.prompt },
    ];

    const commands: CommandOutcome[] = [];
    let toolCalls = 0;
    let commandRuns = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let summary = "";

    for (let step = 0; step < taskSpec.maxToolCalls; step += 1) {
      if (signal.aborted) throw new RunnerAborted("cancelled");
      onEvent({ phase: "thinking", detail: `step ${step + 1}`, step });

      const response = await dispatch(spec.modelId, () =>
        client.chat(
          {
            model: spec.modelId,
            messages,
            temperature: spec.temperature,
            top_p: spec.topP,
            max_tokens: spec.maxOutputTokens,
            tools: toolDefs,
            tool_choice: "auto",
          },
          { signal },
        ),
      );
      tokensIn += response.usage?.prompt_tokens ?? 0;
      tokensOut += response.usage?.completion_tokens ?? 0;

      const message = response.choices[0]?.message;
      const calls = message?.tool_calls ?? [];

      if (calls.length === 0) {
        // No tool call and no finish: treat the prose as the summary and stop,
        // rather than looping until the budget runs out.
        summary = textOf(message?.content);
        onEvent({ phase: "done", detail: "model stopped without calling finish", step });
        break;
      }

      messages.push({ role: "assistant", content: message?.content ?? null, tool_calls: calls });

      let finished = false;
      for (const call of calls) {
        toolCalls += 1;
        const name = call.function.name;
        const args = parseArgs(call.function.arguments);
        onEvent({ phase: "tool", detail: name, step });

        let result: string;
        try {
          if (name === "finish") {
            summary = String(args["summary"] ?? "");
            finished = true;
            result = "acknowledged";
          } else if (name === "list_files") {
            result = await this.listFiles(input, String(args["path"] ?? "."));
          } else if (name === "read_file") {
            result = await sandbox.readFile(String(args["path"] ?? ""));
          } else if (name === "write_file") {
            await sandbox.writeFile(String(args["path"] ?? ""), String(args["contents"] ?? ""));
            result = `written: ${String(args["path"])}`;
          } else if (name === "run_command") {
            if (commandRuns >= taskSpec.maxCommandRuns) {
              result = `refused: command budget of ${taskSpec.maxCommandRuns} exhausted`;
            } else {
              const gate = String(args["gate"] ?? "");
              const command = commandsByGate.get(gate);
              if (!command) {
                result = `refused: "${gate}" is not a declared command for this task`;
              } else {
                commandRuns += 1;
                onEvent({ phase: "command", detail: gate, step });
                const outcome = await input.runCommand(command);
                commands.push(outcome);
                result = summariseCommand(outcome);
              }
            }
          } else {
            result = `refused: unknown tool "${name}"`;
          }
        } catch (err) {
          // A refusal is fed back as a tool result rather than thrown: the
          // model should learn the boundary and try something legal, and a
          // candidate that keeps probing simply burns its own budget.
          if (err instanceof SandboxViolation || err instanceof CommandRejected) {
            log.warn("candidate tool call refused", { tool: name, reason: err.message });
            result = `refused: ${err.message}`;
          } else if (err instanceof RunnerAborted) {
            throw err;
          } else {
            result = `error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }

      if (finished) {
        onEvent({ phase: "done", detail: "finish called", step });
        break;
      }
    }

    return { toolCalls, commands, summary, tokensIn, tokensOut };
  }

  private async listFiles(input: RunnerInput, relativePath: string): Promise<string> {
    const { readdir } = await import("node:fs/promises");
    const dir = await input.sandbox.resolvePath(relativePath === "" ? "." : relativePath);
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.name !== ".git" && e.name !== ".arena" && e.name !== "node_modules")
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join("\n");
  }
}
