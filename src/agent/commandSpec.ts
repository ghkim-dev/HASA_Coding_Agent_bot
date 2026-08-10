import { isAbsolute, join, normalize, posix, sep } from "node:path";

/**
 * What to run, said in a way no shell has to interpret.
 *
 * The failure this is for happened on Windows, three times in a row. The model
 * tried `mkdir -p …` and it failed; it worked out the platform and tried
 * `mkdir …` as though `mkdir` were a program, and that failed; it tried
 * `cd image_classification_project/src` as a standalone process, and that
 * failed too. It then spent the rest of the session working around its own
 * working directory with `python -c "import sys; sys.path.append(...)"`.
 *
 * None of that is a prompt problem. The model was asked to express "run this
 * program, over there" in a language that has no way to say "over there" —
 * a single command line — so it reached for the only thing that shell syntax
 * offers, and shell syntax differs per platform.
 *
 *   The working directory is not part of the command. It is a field.
 *
 * ## Two modes, and why the boundary is explicit
 *
 * `exec` is the ordinary case: an executable and an argument vector, spawned
 * with `shell: false`, so a path with a space in it is one argument rather than
 * a quoting problem. This is what a model should reach for and what it gets by
 * default.
 *
 * `shell` exists because pipelines and redirection are real, and pretending
 * otherwise would send models back to encoding them by hand. It is asked for
 * deliberately: nothing falls back to it, because a silent fallback would mean
 * an `exec` payload with a `|` in it quietly becoming a shell invocation, which
 * is the argv boundary disappearing exactly where it matters.
 */

/** Where a spec came from, when a caller needs to say. */
export type CommandMode = "exec" | "shell";

export interface ExecCommandSpec {
  mode: "exec";
  /** The program. Never a shell built-in, never a command line. */
  executable: string;
  /** One element per argument. Reaches the process verbatim. */
  args: string[];
  /** Workspace-relative, or absent for the workspace root. */
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ShellCommandSpec {
  mode: "shell";
  /** The whole line, for the platform's shell to parse. */
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export type AgentCommandSpec = ExecCommandSpec | ShellCommandSpec;

/** Machine-readable, so a model can act on the refusal rather than reword it. */
export const INVALID_COMMAND_USE_CWD = "INVALID_COMMAND_USE_CWD";
export const COMMAND_CWD_NOT_FOUND = "COMMAND_CWD_NOT_FOUND";
export const COMMAND_CWD_OUTSIDE_WORKSPACE = "COMMAND_CWD_OUTSIDE_WORKSPACE";
export const INVALID_COMMAND_SHELL_SYNTAX = "INVALID_COMMAND_SHELL_SYNTAX";

export interface SpecProblem {
  code: string;
  message: string;
}

/**
 * Programs that are not programs.
 *
 * `cd` is the one that actually happened. It is a shell built-in on every
 * platform — there is no `cd` to spawn — and a model reaching for it is a model
 * trying to say "over there" with the only vocabulary it was given. The refusal
 * names the field it should have used instead.
 */
const NOT_EXECUTABLES: Readonly<Record<string, string>> = {
  cd: "작업 디렉터리는 cwd 필드로 지정하십시오. cd는 실행할 수 있는 프로그램이 아닙니다.",
  chdir: "작업 디렉터리는 cwd 필드로 지정하십시오.",
  pushd: "작업 디렉터리는 cwd 필드로 지정하십시오.",
  popd: "작업 디렉터리는 cwd 필드로 지정하십시오.",
  export: "환경 변수는 env 필드로 지정하십시오.",
  set: "환경 변수는 env 필드로 지정하십시오.",
  source: "셸 스크립트를 읽어야 하면 mode: \"shell\"을 명시하십시오.",
};

/**
 * What an executable may not contain.
 *
 * An executable is one token — a program name or a path to one. Anything with
 * whitespace or punctuation in it is a command line that arrived in the wrong
 * field, and spawning it literally produces an ENOENT naming a program nobody
 * meant to run.
 */
const NOT_AN_EXECUTABLE = /[\s|&;<>(){}$`"']/;

/**
 * Metacharacters that genuinely require a shell, outside quotes.
 *
 * Narrower than "characters a shell treats specially", and the difference is
 * the whole point: `node -e "console.log(1)"` contains parentheses and needs no
 * shell at all. Reading it as one turned a working legacy call into a
 * PowerShell invocation that failed — the regression this file exists to
 * prevent, caused by checking for too much.
 */
function needsShell(line: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "|" || ch === ">" || ch === "<" || ch === ";") return true;
    if (ch === "&" && line[i + 1] === "&") return true;
  }
  return false;
}

/**
 * Checks a spec before anything is spawned.
 *
 * Two things it refuses, and both were seen. A shell built-in dressed as an
 * executable, and shell syntax inside an `exec` payload — the second because
 * accepting it would mean either running it literally (a program named
 * `python a.py | python b.py` does not exist, so a confusing ENOENT) or
 * quietly turning on a shell, which is the argv boundary vanishing without
 * anyone asking.
 */
export function validateSpec(spec: AgentCommandSpec): SpecProblem | null {
  if (spec.mode === "shell") {
    return spec.command.trim().length === 0
      ? { code: INVALID_COMMAND_SHELL_SYNTAX, message: "실행할 명령이 비어 있습니다." }
      : null;
  }

  const executable = spec.executable.trim();
  if (executable.length === 0) {
    return { code: INVALID_COMMAND_SHELL_SYNTAX, message: "실행할 프로그램이 비어 있습니다." };
  }

  const bare = executable.toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
  const builtin = NOT_EXECUTABLES[bare];
  if (builtin !== undefined) {
    return { code: INVALID_COMMAND_USE_CWD, message: builtin };
  }

  if (NOT_AN_EXECUTABLE.test(executable)) {
    return {
      code: INVALID_COMMAND_SHELL_SYNTAX,
      message:
        "executable에는 프로그램 이름 하나만 넣으십시오. 인자는 args에 한 줄씩 나누고, " +
        '파이프나 리다이렉션이 필요하면 mode: "shell"을 명시하십시오 — ' +
        "자동으로 셸을 쓰지는 않습니다.",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Where it runs
// ---------------------------------------------------------------------------

export interface CwdResolution {
  /** Absolute, inside the workspace. */
  path: string;
}

/**
 * Turns a requested working directory into an absolute one inside the
 * workspace, or says why it cannot.
 *
 * The boundary is the same one `Sandbox` keeps and for the same reason: a
 * `realpath` comparison, so a symlink pointing out of the workspace is caught
 * rather than followed. A structured `cwd` field must not become the way around
 * a check that a path argument could not get around.
 *
 * `exists` is injected so the rule can be tested without a filesystem; the
 * caller passes the real one.
 */
export async function resolveCwd(
  requested: string | undefined,
  workspaceRoot: string,
  probe: {
    realpath: (path: string) => Promise<string>;
    isDirectory: (path: string) => Promise<boolean>;
  },
): Promise<{ ok: true; path: string } | { ok: false; problem: SpecProblem }> {
  if (requested === undefined || requested.trim().length === 0) {
    return { ok: true, path: workspaceRoot };
  }

  const asked = requested.trim();
  // An absolute path is not refused out of hand — it may name somewhere inside
  // the workspace — but it is resolved and checked like everything else.
  const candidate = isAbsolute(asked) ? normalize(asked) : join(workspaceRoot, asked);

  let real: string;
  let rootReal: string;
  try {
    rootReal = await probe.realpath(workspaceRoot);
  } catch {
    rootReal = workspaceRoot;
  }
  try {
    real = await probe.realpath(candidate);
  } catch {
    return {
      ok: false,
      problem: {
        code: COMMAND_CWD_NOT_FOUND,
        message: `작업 디렉터리 ${asked} 이(가) 없습니다. 먼저 만들거나 경로를 확인하십시오.`,
      },
    };
  }

  if (!within(real, rootReal)) {
    return {
      ok: false,
      problem: {
        code: COMMAND_CWD_OUTSIDE_WORKSPACE,
        message: `작업 디렉터리 ${asked} 은(는) 작업 폴더 밖입니다.`,
      },
    };
  }
  if (!(await probe.isDirectory(real))) {
    return {
      ok: false,
      problem: { code: COMMAND_CWD_NOT_FOUND, message: `${asked} 은(는) 디렉터리가 아닙니다.` },
    };
  }
  return { ok: true, path: real };
}

/** Whether a resolved path is the root or beneath it. */
function within(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}

// ---------------------------------------------------------------------------
// What a legacy caller sends
// ---------------------------------------------------------------------------

/**
 * Turns an old one-line call into a spec.
 *
 * Kept because models in the wild — and the text tool protocol, which writes
 * parameters as tag bodies — still produce `{ command: "python main.py" }`, and
 * breaking every one of them at once would trade this bug for a worse one. What
 * it does *not* do is keep a second execution path: everything arrives at one
 * `AgentCommandSpec` and one spawn.
 *
 * A line containing shell syntax becomes a `shell` spec rather than a broken
 * `exec` one. That is not a silent fallback — it is a reading of a legacy input
 * that never had a mode to state, and the structured form has no such path.
 */
export function specFromLine(
  line: string,
  parse: (line: string) => { cmd: string; args: string[] },
  cwd?: string,
): AgentCommandSpec {
  const text = line.trim();
  if (needsShell(text)) {
    return { mode: "shell", command: text, ...(cwd === undefined ? {} : { cwd }) };
  }
  const parsed = parse(text);
  return {
    mode: "exec",
    executable: parsed.cmd,
    args: parsed.args,
    ...(cwd === undefined ? {} : { cwd }),
  };
}

// ---------------------------------------------------------------------------
// What it is, for the loop detector
// ---------------------------------------------------------------------------

/**
 * Whether this command only prints what it was told to print.
 *
 * Read from the structure now rather than from a string. `python -c "print(…)"`
 * arrives as an executable and an argument vector, so recognising it is looking
 * at two fields instead of parsing a command line — and the same three
 * celebratory one-liners are still one shape to `progress.ts`.
 */
export function isPrintOnlySpec(spec: AgentCommandSpec): boolean {
  if (spec.mode === "shell") return /^\s*echo\b/.test(spec.command);

  const bare = spec.executable.toLowerCase().replace(/\.(exe|cmd|bat)$/, "").split(/[\\/]/).pop() ?? "";
  if (bare === "echo") return true;

  const flag = spec.args[0];
  if (flag !== "-c" && flag !== "-e" && flag !== "--eval") return false;
  const body = spec.args[1] ?? "";
  return /^\s*(print|console\.log|puts)\s*\(/.test(body) && !/\bimport\b|\brequire\b/.test(body);
}

/** A stable description of what a spec runs, for repetition detection. */
export function specShape(spec: AgentCommandSpec): string {
  if (spec.mode === "shell") return `shell:${isPrintOnlySpec(spec) ? "print_only" : "compound"}`;
  if (isPrintOnlySpec(spec)) return "exec:print_only";
  const target = spec.args.find((a) => !a.startsWith("-")) ?? "";
  return `exec:${spec.executable}:${target}`;
}

/** Workspace-relative, for showing a person where something ran. */
export function displayCwd(resolved: string, workspaceRoot: string): string {
  if (resolved === workspaceRoot) return ".";
  const prefix = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`;
  return resolved.startsWith(prefix) ? resolved.slice(prefix.length).split(sep).join(posix.sep) : resolved;
}
