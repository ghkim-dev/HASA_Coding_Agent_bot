import type { CommandSpec } from "../../protocol/index.ts";
import { realpath, stat } from "node:fs/promises";
import {
  displayCwd,
  resolveCwd,
  specFromLine,
  validateSpec,
  type AgentCommandSpec,
} from "../commandSpec.ts";
import {
  CommandRejected,
  candidateEnv,
  runApprovedCommand,
  type CommandOutcome,
} from "../../core/commands.ts";
import { GitRepo } from "../../core/git.ts";
import { parseCommandLine, UnparsableCommand, type ParsedCommandLine } from "../commandLine.ts";
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
  // Always offered. It used to appear only when the project declared scripts,
  // which meant a folder holding one Python file had no way to run it, no way
  // to install what it imports, and — because the prompt then said so — a model
  // that told the user, correctly and uselessly, that it could not help.
  tools.push(runCommandTool(opts));
  return tools;
}

/** How long a command may run before it is killed, and the ceiling on asking for more. */
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 900_000;

function suggestions(allowlist: readonly CommandSpec[]): string {
  const byLabel = commandLabels(allowlist);
  if (byLabel.size === 0) return "";
  const lines = [...byLabel.values()].map((c) => `\`${[c.cmd, ...c.args].join(" ")}\``);
  return ` This project declares: ${lines.join(", ")}.`;
}

/**
 * Running things, which is most of what makes an agent useful.
 *
 * The command arrives as one line and is split here, never by a shell — see
 * `commandLine.ts`. What keeps it safe is not a list of permitted commands but
 * the approval prompt: `risk: "execute"` means Safe and Balanced both stop and
 * ask, which is the behaviour README has always documented. The denylist in
 * `core/commands.ts` stays as the second layer it was designed to be.
 */
function runCommandTool(opts: ShellToolOptions): AgentTool {
  return {
    name: "run_command",
    risk: "execute",
    description:
      "Run a program in the workspace — install a dependency, run a script, run the tests. " +
      "Give the program and its arguments separately, and say where to run it with `cwd`. " +
      "There is no shell: nothing is re-parsed, so a path with a space in it is one argument " +
      "and needs no quoting, and the same call works the same on Windows and Linux. " +
      "`cd` is not a program — to run somewhere else, set `cwd`. " +
      "The user approves it before it runs. Use it to check your work: a change you have not " +
      "run is a change you are guessing about." +
      suggestions(opts.allowlist),
    parameters: {
      type: "object",
      properties: {
        executable: {
          type: "string",
          description: "The program to run, e.g. `python`, `pip`, `pytest`, `node`. Not a command line.",
        },
        args: {
          type: "string",
          description:
            "The arguments, one per line, exactly as the program should receive them. " +
            "Do not quote them — `my file.txt` on its own line is one argument.",
        },
        cwd: {
          type: "string",
          description:
            "Where to run it, relative to the workspace root, e.g. `image_classification_project/src`. " +
            "Leave it out for the workspace root. This replaces `cd`.",
        },
        command: {
          type: "string",
          description:
            "A whole command line, only when you genuinely need a shell — a pipeline or a " +
            "redirection. Prefer `executable` and `args`; this one is re-parsed by the platform " +
            "shell and behaves differently on Windows and Linux.",
        },
        timeout_seconds: {
          type: "number",
          description: `How long to allow. Default ${DEFAULT_TIMEOUT_MS / 1000}, maximum ${MAX_TIMEOUT_MS / 1000}. Raise it for a large install.`,
        },
      },
      required: [],
      additionalProperties: false,
    },
    summarize: (args) => `\`${describeArgs(args)}\` 을(를) 실행합니다`,
    async execute(args, ctx): Promise<ToolResult> {
      const seconds = typeof args["timeout_seconds"] === "number" ? args["timeout_seconds"] : 0;
      const timeoutMs = Math.min(
        MAX_TIMEOUT_MS,
        Math.max(1_000, seconds > 0 ? Math.round(seconds * 1000) : DEFAULT_TIMEOUT_MS),
      );

      // One place a call becomes a spec, whichever shape it arrived in. The
      // structured form and the legacy one-liner converge here, and there is
      // exactly one spawn below them — a second executor for the text protocol
      // would be two places for the argv boundary to be lost.
      let spec: AgentCommandSpec;
      try {
        spec = toSpec(args);
      } catch (err) {
        if (err instanceof UnparsableCommand) return { ok: false, content: err.guidance };
        throw err;
      }

      const problem = validateSpec(spec);
      if (problem !== null) {
        // Machine-readable and actionable: the model reads which field it
        // should have used and fixes the call, rather than trying a different
        // spelling of the same mistake three times.
        return { ok: false, content: `${problem.code}: ${problem.message}` };
      }

      const where = await resolveCwd(spec.cwd, opts.workspaceRoot, {
        realpath,
        isDirectory: async (path) => (await stat(path)).isDirectory(),
      });
      if (!where.ok) {
        return { ok: false, content: `${where.problem.code}: ${where.problem.message}` };
      }

      const parsed = asParsed(spec);
      const line = describeSpec(spec, where.path, opts.workspaceRoot);

      try {
        const outcome = await runApprovedCommand(
          { gate: gateFor(parsed), kind: "regression", cmd: parsed.cmd, args: parsed.args, timeoutMs },
          {
            cwd: where.path,
            signal: ctx.signal,
            // The user's own env wins over ours: a project that sets
            // PYTHONIOENCODING deliberately should keep it.
            env: { ...candidateEnv(), ...interpreterEnv(parsed.cmd), ...(spec.env ?? {}) },
          },
        );
        // A binary that does not exist comes back as a resolved outcome with
        // ENOENT on stderr, not as a thrown error, so it is read here. Left as
        // the raw spawn text it says "[spawn error] spawn foo ENOENT", which
        // tells a model nothing about what to do next.
        if (outcome.exitCode === null && /ENOENT/.test(outcome.stderr)) {
          const missing =
            `\`${parsed.cmd}\` is not installed, or is not on this machine's PATH. ` +
            "Check before assuming it is there; if it is genuinely missing, say so plainly " +
            "and tell the user how to install it rather than trying another spelling.";
          return { ok: false, content: missing, display: `$ ${line}\n${parsed.cmd}: 실행 파일을 찾을 수 없습니다.` };
        }
        const body = report(line, outcome);
        // Shown to the user verbatim, not only to the model. "I ran it and it
        // worked" is a claim; this is the thing that makes it checkable, and
        // checking it is the entire reason they asked for the command.
        return { ok: outcome.exitCode === 0, content: body, display: body };
      } catch (err) {
        // A refusal is a result, not an exception. The model learns the boundary
        // and tries something legal; throwing would end the turn and teach it
        // nothing.
        if (err instanceof CommandRejected) {
          return {
            ok: false,
            content:
              err.reason === "denylisted"
                ? `refused: \`${line}\` is on the blocked list — it deletes, publishes, or reaches the network. ` +
                  "Ask the user to run it themselves if it is really what they want."
                : `refused: ${err.message}`,
          };
        }
        if ((err as { code?: string }).code === "ENOENT") {
          return {
            ok: false,
            content:
              `\`${parsed.cmd}\` is not installed, or is not on this machine's PATH. ` +
              "Check what is available before assuming, and tell the user plainly if it is missing.",
          };
        }
        throw err;
      }
    },
  };
}

/**
 * Which gate this command belongs to, for the log and the transcript.
 *
 * Labelling only — nothing is permitted or refused on the strength of it. The
 * gates already included `install`, which is worth noticing: the vocabulary
 * anticipated an agent that installs things long before there was a tool that
 * could.
 */
function gateFor(parsed: ParsedCommandLine): CommandSpec["gate"] {
  const line = [parsed.cmd, ...parsed.args].join(" ").toLowerCase();
  if (/\b(install|add|sync|restore)\b/.test(line)) return "install";
  if (/\btest\b|pytest|vitest|jest/.test(line)) return "test";
  if (/\bbuild\b|\bcompile\b/.test(line)) return "build";
  if (/\blint\b|ruff|eslint|flake8/.test(line)) return "lint";
  if (/\btsc\b|typecheck|mypy/.test(line)) return "typecheck";
  return "run";
}

/**
 * What the model gets back.
 *
 * Both streams, tail-first, and the exit code stated rather than implied. A tool
 * result that shows only stdout hides the stack trace that explains the failure,
 * and a model reading "it did not work" without it will guess.
 */
/**
 * Keeps the beginning as well as the end.
 *
 * This kept only the last 60 lines, which is the wrong end for most of what an
 * agent runs. A compiler, a test runner and `pip` all put the thing that went
 * wrong near the top and progress noise underneath it, so tail-only threw away
 * the error and kept the scrollback — for the model as much as for the user.
 */
function clip(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= MAX_OUTPUT_LINES) return text.trim();
  const head = Math.ceil(MAX_OUTPUT_LINES / 2);
  const tail = MAX_OUTPUT_LINES - head;
  const omitted = lines.length - head - tail;
  return [
    ...lines.slice(0, head),
    `…[${omitted} more lines]…`,
    ...lines.slice(-tail),
  ]
    .join("\n")
    .trim();
}

function report(line: string, outcome: CommandOutcome): string {
  const tail = clip;
  const head = `$ ${line}\nexit ${outcome.exitCode ?? "null"}${outcome.timedOut ? " (timed out)" : ""} in ${outcome.durationMs}ms`;
  const parts = [
    head,
    tail(outcome.stdout) ? `stdout:\n${tail(outcome.stdout)}` : "",
    tail(outcome.stderr) ? `stderr:\n${tail(outcome.stderr)}` : "",
  ].filter(Boolean);
  if (outcome.exitCode !== 0 && !tail(outcome.stdout) && !tail(outcome.stderr)) {
    parts.push("(no output)");
  }
  return parts.join("\n");
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

/**
 * Everything a call may arrive as, reduced to one spec.
 *
 * Three shapes reach here: the structured form, the legacy one-liner, and the
 * text protocol's version of either — all parameters are strings there, so
 * `args` is newline-separated rather than an array. They converge before
 * anything is validated or spawned, which is what keeps the argv boundary in
 * one place instead of two.
 */
function toSpec(args: Record<string, unknown>): AgentCommandSpec {
  const cwd = str(args, "cwd").trim();
  const executable = str(args, "executable").trim();

  if (executable.length > 0) {
    return {
      mode: "exec",
      executable,
      args: argLines(args["args"]),
      ...(cwd.length === 0 ? {} : { cwd }),
    };
  }

  // Legacy: one line, no mode. Kept so calls already in flight do not all break
  // at once; it produces a spec like everything else and gets no second path.
  const line = str(args, "command").trim();
  return specFromLine(line, (text) => {
    const parsed = parseCommandLine(text);
    return { cmd: parsed.cmd, args: parsed.args };
  }, cwd.length === 0 ? undefined : cwd);
}

/**
 * Arguments, one per line.
 *
 * A line rather than a JSON array because the text tool protocol writes every
 * parameter as a tag body, where an array has no natural spelling — the same
 * reason `update_plan` takes its steps this way. An empty line is dropped; a
 * line with spaces in it is one argument, which is the whole point.
 */
function argLines(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((a) => String(a)).filter((a) => a.length > 0);
  if (typeof raw !== "string") return [];
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The spec as `core/commands.ts` wants it. */
function asParsed(spec: AgentCommandSpec): ParsedCommandLine {
  if (spec.mode === "exec") return { cmd: spec.executable, args: spec.args };
  // A shell spec runs through the platform's shell, named explicitly rather
  // than by turning `shell: true` on somewhere — the interpreter is an argument
  // like any other, so the argv boundary holds here too.
  return process.platform === "win32"
    ? { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", spec.command] }
    : { cmd: "/bin/sh", args: ["-c", spec.command] };
}

/** What the user sees, including where it ran. */
function describeSpec(spec: AgentCommandSpec, resolvedCwd: string, root: string): string {
  const where = displayCwd(resolvedCwd, root);
  const body =
    spec.mode === "shell" ? spec.command : [spec.executable, ...spec.args].join(" ");
  return where === "." ? body : `${where}$ ${body}`;
}

/** The same sentence for the approval prompt, before anything is resolved. */
function describeArgs(args: Record<string, unknown>): string {
  const executable = str(args, "executable").trim();
  const body =
    executable.length > 0 ? [executable, ...argLines(args["args"])].join(" ") : str(args, "command").trim();
  const cwd = str(args, "cwd").trim();
  return cwd.length === 0 ? body : `${cwd}$ ${body}`;
}

/**
 * What an interpreter needs to print Korean without mangling it.
 *
 * Python on Windows defaults its stdio to the console codepage, so a `print`
 * of Korean text arrives as mojibake however well the reader decodes it. This
 * is the writer's half; `core/commands.ts` already keeps the reader's, holding
 * a `StringDecoder` across chunks so a multi-byte character split down the
 * middle of a Buffer survives.
 *
 * Only for interpreters known to need it, and always beneath an explicit `env`
 * from the caller.
 */
export function interpreterEnv(executable: string): Record<string, string> {
  // Both separators. Windows is where this matters most — `C:\Python311\python.exe`
  // is exactly the case that produced mojibake — and a class missing the
  // backslash would leave the whole path as the name and match nothing.
  const bare = executable.toLowerCase().replace(/\.(exe|cmd|bat)$/, "").split(/[\\/]/).pop() ?? "";
  return bare.startsWith("python")
    ? { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }
    : {};
}
