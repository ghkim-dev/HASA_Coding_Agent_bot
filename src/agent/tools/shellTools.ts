import type { CommandSpec } from "../../protocol/index.ts";
import { CommandRejected, candidateEnv, runCommand } from "../../core/commands.ts";
import { GitRepo } from "../../core/git.ts";
import type { AgentTool, ToolResult } from "../types.ts";

/**
 * The tools that reach outside the file system.
 *
 * `execute_command` is the sharpest thing the agent owns, so it is the one that
 * changes least: it runs `core/commands.ts`, allowlist-first, `shell: false`,
 * with an environment built by allowlist so the HASA key cannot reach a build
 * script. All of that is the Arena's and is already tested.
 *
 * The one difference is where the allowlist comes from. An Arena task declares
 * its commands up front; a person talking to an agent does not. So the list is
 * the project's own scripts, discovered rather than invented, and anything else
 * is refused — which the model is told, so it can ask for one that exists.
 */

const MAX_OUTPUT_LINES = 60;

function str(args: Record<string, unknown>, key: string, fallback = ""): string {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

export interface ShellToolOptions {
  workspaceRoot: string;
  /** Commands this workspace permits, keyed by the name the model uses. */
  allowlist: CommandSpec[];
  openRepo?: (dir: string) => Promise<GitRepo>;
}

export function createShellTools(opts: ShellToolOptions): AgentTool[] {
  const tools: AgentTool[] = [gitDiff(opts)];
  // A workspace with no declared commands gets no command tool at all, rather
  // than one that refuses everything. An offered tool that never works costs a
  // turn every time the model tries it.
  if (opts.allowlist.length > 0) tools.push(executeCommand(opts));
  return tools;
}

function describeAllowlist(allowlist: CommandSpec[]): string {
  return allowlist.map((c) => `${c.gate} (${c.cmd} ${c.args.join(" ")})`.trim()).join(", ");
}

function executeCommand(opts: ShellToolOptions): AgentTool {
  // Keyed by plain string: the model sends whatever it likes, and narrowing the
  // key type would only move the check from runtime to a cast.
  const byGate = new Map<string, CommandSpec>(opts.allowlist.map((c) => [c.gate, c]));
  return {
    name: "execute_command",
    risk: "execute",
    description:
      `Run one of this project's declared commands: ${describeAllowlist(opts.allowlist)}. ` +
      "Nothing else can be run. Use it to check your work — a change that has not been built or tested " +
      "is a change you are guessing about.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: [...byGate.keys()],
          description: "Which declared command to run.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    summarize: (args) => {
      const spec = byGate.get(str(args, "command"));
      if (spec === undefined) return `${str(args, "command")} 명령을 실행합니다`;
      return `\`${[spec.cmd, ...spec.args].join(" ")}\` 을(를) 실행합니다`;
    },
    async execute(args, ctx): Promise<ToolResult> {
      const gate = str(args, "command");
      const spec = byGate.get(gate);
      if (spec === undefined) {
        return {
          ok: false,
          content: `"${gate}" is not one of this project's commands. Available: ${[...byGate.keys()].join(", ")}`,
        };
      }
      try {
        const outcome = await runCommand(spec, opts.allowlist, {
          cwd: opts.workspaceRoot,
          signal: ctx.signal,
          env: candidateEnv(),
        });
        const tail = (text: string): string =>
          text.split("\n").slice(-MAX_OUTPUT_LINES).join("\n").trim();
        const parts = [
          `exit ${outcome.exitCode ?? "null"}${outcome.timedOut ? " (timed out)" : ""} in ${outcome.durationMs}ms`,
          tail(outcome.stdout) ? `stdout:\n${tail(outcome.stdout)}` : "",
          tail(outcome.stderr) ? `stderr:\n${tail(outcome.stderr)}` : "",
        ].filter(Boolean);
        return { ok: outcome.exitCode === 0, content: parts.join("\n") };
      } catch (err) {
        // A refusal is a result, not an exception. The model learns the
        // boundary and tries something legal; throwing would end the turn and
        // teach it nothing.
        if (err instanceof CommandRejected) return { ok: false, content: `refused: ${err.message}` };
        throw err;
      }
    },
  };
}

function gitDiff(opts: ShellToolOptions): AgentTool {
  const open = opts.openRepo ?? ((dir: string) => GitRepo.open(dir));
  return {
    name: "get_git_diff",
    risk: "read",
    description:
      "Show what has changed in the workspace so far, as a unified diff. " +
      "Use it to check your own work before saying you are done.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    summarize: () => "현재 변경 내용을 확인합니다",
    async execute(): Promise<ToolResult> {
      let repo: GitRepo;
      try {
        repo = await open(opts.workspaceRoot);
      } catch {
        return { ok: false, content: "this workspace is not a git repository, so there is no diff to show." };
      }
      const changed = await repo.changedPaths();
      if (changed.length === 0) return { ok: true, content: "No changes yet." };
      // Read-only: showing a diff must not stage anything in the user's index,
      // which is why this is not `diffWorktree`. New files are absent from the
      // patch and present in the list above it.
      const patch = await repo.diffAgainst("HEAD");
      const lines = patch.split("\n");
      const body = lines.length > 400 ? `${lines.slice(0, 400).join("\n")}\n…diff truncated` : patch;
      return { ok: true, content: `${changed.length} file(s) changed:\n${changed.join("\n")}\n\n${body}` };
    },
  };
}
