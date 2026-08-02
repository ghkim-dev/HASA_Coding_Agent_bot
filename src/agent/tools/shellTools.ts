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
  /** Whether the workspace is a git repository. Decided once, by the caller. */
  isGitRepo?: boolean;
  openRepo?: (dir: string) => Promise<GitRepo>;
}

/**
 * Only the tools that can actually work here.
 *
 * A tool that always fails is worse than an absent one: the model tries it,
 * reads the refusal, and tries again. Observed in use — `get_git_diff` was
 * offered in a folder that is not a repository, and the turn became
 * `create_file` → `get_git_diff` → `create_file` → … until the budget ran out.
 */
export function createShellTools(opts: ShellToolOptions): AgentTool[] {
  const tools: AgentTool[] = [];
  if (opts.isGitRepo !== false) tools.push(gitDiff(opts));
  if (opts.allowlist.length > 0) tools.push(executeCommand(opts));
  return tools;
}

/**
 * What the model calls each command.
 *
 * The gate alone was enough while every command came from `package.json`, where
 * there is one `test` and one `build`. A workspace can hold several runnable
 * scripts, and keying by gate silently dropped all but the last of them.
 *
 * Returned as a map rather than a per-spec function because uniqueness is the
 * whole point and a function cannot promise it: `python src/main.py` and
 * `node src/main.py` both shorten to `run src/main.py`, and the map that keys
 * on the result would drop one of them exactly as keying on the gate did. So
 * the labels are built together, and each step is tried only for the entries
 * that are still ambiguous.
 */
export function commandLabels(allowlist: readonly CommandSpec[]): Map<string, CommandSpec> {
  const namings: Array<(spec: CommandSpec, index: number) => string> = [
    (spec) => spec.gate,
    // The last argument is the file for a run command, which is the part the
    // user and the model both think in.
    (spec) => `${spec.gate} ${spec.args[spec.args.length - 1] ?? ""}`.trim(),
    (spec) => [spec.cmd, ...spec.args].join(" "),
    // Nothing about a command distinguishes it, so its position does. Reached
    // only by two byte-identical entries, which is a caller bug rather than a
    // reason to lose one.
    (spec, index) => `${spec.gate} #${index + 1}`,
  ];

  const out = new Map<string, CommandSpec>();
  const pending = allowlist.map((spec, index) => ({ spec, index }));

  for (const name of namings) {
    if (pending.length === 0) break;
    const counts = new Map<string, number>();
    for (const { spec, index } of pending) {
      const label = name(spec, index);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    // Ambiguous within this round, or already claimed by an earlier one.
    const stillPending: typeof pending = [];
    for (const entry of pending) {
      const label = name(entry.spec, entry.index);
      if (counts.get(label) === 1 && !out.has(label)) out.set(label, entry.spec);
      else stillPending.push(entry);
    }
    pending.length = 0;
    pending.push(...stillPending);
  }

  return out;
}

function describeAllowlist(byLabel: Map<string, CommandSpec>): string {
  return [...byLabel]
    .map(([label, c]) => `"${label}" (${[c.cmd, ...c.args].join(" ")})`)
    .join(", ");
}

function executeCommand(opts: ShellToolOptions): AgentTool {
  // Keyed by plain string: the model sends whatever it likes, and narrowing the
  // key type would only move the check from runtime to a cast.
  const byGate = commandLabels(opts.allowlist);
  return {
    name: "execute_command",
    risk: "execute",
    description:
      `Run one of this workspace's commands: ${describeAllowlist(byGate)}. ` +
      "Nothing else can be run. Use it to check your work — a change that has not been built, tested " +
      "or run is a change you are guessing about.",
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
