import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { CommandSpec } from "../protocol/index.ts";

/**
 * Command execution for candidate workspaces.
 *
 * The rule is allowlist-first: only commands the task specification declared
 * may run, matched exactly. A denylist of dangerous patterns exists as a second
 * layer, but it is explicitly *not* the primary defence — there are unbounded
 * ways to spell `rm -rf`, and a blocklist that has to enumerate them has
 * already lost.
 *
 * See docs/security-policy.md §2.
 */

export class CommandRejected extends Error {
  readonly reason: "not_allowlisted" | "metacharacter" | "denylisted" | "budget";

  constructor(reason: CommandRejected["reason"], detail: string) {
    super(`command rejected (${reason}): ${detail}`);
    this.name = "CommandRejected";
    this.reason = reason;
  }
}

/**
 * Shell metacharacters in the *executable name*.
 *
 * Args are deliberately not screened for these. Commands run with
 * `shell: false`, so an argument reaches the process as one literal string and
 * cannot become a second command — screening it would only reject legitimate
 * inputs like `-e "process.exit(0)"` or a glob passed to a test runner. The
 * executable itself is a different matter: anything but a plain program name
 * there means the caller expected a shell to be involved.
 */
const SHELL_METACHARACTERS = /[;&|`$><\n\r]/;

/** Control characters that would corrupt logs or split a record. */
const ARG_CONTROL_CHARS = /[\n\r\0]/;

const DENYLIST = [
  /\brm\b[\s\S]*-[a-z]*r/i,
  /\bdel\b[\s\S]*\/s/i,
  /remove-item[\s\S]*-recurse/i,
  /\bformat\b|\bmkfs\b/i,
  /\b(deploy|publish)\b/i,
  /npm\s+publish|docker\s+push|kubectl\s+apply|terraform\s+apply|gh\s+release/i,
  /\bsudo\b|\brunas\b/i,
  /\bcurl\b|\bwget\b|invoke-webrequest|\bnc\b|\bssh\b|\bscp\b/i,
  /git\s+(push|remote|config\s+--global|clean|reset\s+--hard)/i,
  /crontab|schtasks|systemctl/i,
  /\.env\b|\.ssh\b|\.aws\b|\.npmrc\b|gh\s+auth\s+token/i,
];

export interface CommandOutcome {
  gate: string;
  cmd: string;
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Truncated. Full logs live in the run's artifact directory. */
  stdout: string;
  stderr: string;
}

const MAX_CAPTURE = 64 * 1024;

/**
 * Keeps both ends of very long output.
 *
 * It used to keep the first 64 KiB, which reads sensibly until you notice what
 * consumes it: `shellTools.report` then takes the *last* 60 lines. Head-clip
 * followed by tail-select means that for anything over 64 KiB the exit line is
 * gone and the "last 60 lines" are 60 lines from the middle of the run — a
 * report that looks like a verdict and is not.
 *
 * Both ends now survive, with the loss stated between them. A compiler puts the
 * first error at the top and the summary at the bottom, and those are the two
 * places worth keeping.
 */
function truncate(text: string): string {
  if (text.length <= MAX_CAPTURE) return text;
  const half = Math.floor(MAX_CAPTURE / 2);
  const dropped = text.length - half * 2;
  return `${text.slice(0, half)}\n…[${dropped} characters omitted]…\n${text.slice(-half)}`;
}

/**
 * The checks that hold whether or not a command was declared in advance.
 *
 * Split out because the interactive agent has no task specification to declare
 * anything: what stands between it and the machine is the user's approval, not
 * a list written before the conversation started. These checks are the part
 * that still applies — a plain executable name, arguments that cannot corrupt a
 * log, and nothing on the denylist.
 */
export function assertSafeCommand(spec: CommandSpec): void {
  if (SHELL_METACHARACTERS.test(spec.cmd)) {
    throw new CommandRejected(
      "metacharacter",
      `${JSON.stringify(spec.cmd)} is not a plain executable name`,
    );
  }
  for (const arg of spec.args) {
    if (ARG_CONTROL_CHARS.test(arg)) {
      throw new CommandRejected("metacharacter", "arguments must not contain control characters");
    }
  }
  const line = `${spec.cmd} ${spec.args.join(" ")}`;
  for (const pattern of DENYLIST) {
    if (pattern.test(line)) {
      throw new CommandRejected("denylisted", line);
    }
  }
}

/** Rejects a command that could not have come from the task specification. */
export function assertRunnable(spec: CommandSpec, allowlist: CommandSpec[]): void {
  assertSafeCommand(spec);
  const line = `${spec.cmd} ${spec.args.join(" ")}`;
  const matched = allowlist.some(
    (a) =>
      a.cmd === spec.cmd &&
      a.args.length === spec.args.length &&
      a.args.every((arg, i) => arg === spec.args[i]),
  );
  if (!matched) {
    throw new CommandRejected(
      "not_allowlisted",
      `${line} was not declared in the task specification's acceptanceCommands`,
    );
  }
}

/**
 * Environment handed to a candidate's commands.
 *
 * Built by allowlist rather than by deleting keys from `process.env`, so the
 * HASA key cannot reach a build script no matter how the orchestrator was
 * launched. See docs/security-policy.md §1.3.
 */
export function candidateEnv(extra: Record<string, string> = {}): Record<string, string> {
  const passthrough = ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TEMP", "TMP", "LANG", "TZ", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "COMSPEC"];
  const env: Record<string, string> = {
    CI: "1",
    NO_COLOR: "1",
    // Output is read as UTF-8, so it has to be written as UTF-8.
    //
    // On Windows a child writing to a pipe defaults to the console codepage —
    // CP949 on a Korean install — and decoding that as UTF-8 produces
    // replacement characters. Measured: a Python script printing Korean came
    // back as U+FFFD, in the output a user reads to find out whether their
    // program worked. `PYTHONUTF8` is the modern switch and `PYTHONIOENCODING`
    // covers interpreters that predate it; both are ignored by everything else.
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    ...extra,
  };
  for (const key of passthrough) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export interface RunCommandOptions {
  cwd: string;
  signal?: AbortSignal;
  env?: Record<string, string>;
}

/**
 * Runs one allowlisted command with a hard timeout.
 *
 * `shell: false` throughout — arguments reach the process as an array and are
 * never re-parsed. On timeout the whole process tree is killed, because a build
 * that spawned a watcher would otherwise outlive the run.
 */
export async function runCommand(
  spec: CommandSpec,
  allowlist: CommandSpec[],
  opts: RunCommandOptions,
): Promise<CommandOutcome> {
  assertRunnable(spec, allowlist);
  return spawnChecked(spec, opts);
}

/**
 * Runs a command the user approved rather than one a specification declared.
 *
 * The same execution path, the same `shell: false`, the same denylist, and the
 * same environment built by allowlist so the HASA key cannot reach it. What is
 * absent is the allowlist match, and it is absent on purpose: an interactive
 * agent is asked to install a package and run the file it just wrote, and
 * neither was in a list written before the conversation began. The gate that
 * replaces it is the approval prompt — which is what README's
 * "명령 실행 — 확인" has described all along.
 *
 * The Arena keeps `runCommand`. An unattended run *has* a specification, and a
 * candidate free to run anything is not a candidate that can be compared.
 */
export async function runApprovedCommand(
  spec: CommandSpec,
  opts: RunCommandOptions,
): Promise<CommandOutcome> {
  assertSafeCommand(spec);
  return spawnChecked(spec, opts);
}

async function spawnChecked(spec: CommandSpec, opts: RunCommandOptions): Promise<CommandOutcome> {
  const started = Date.now();
  return new Promise<CommandOutcome>((resolvePromise) => {
    const child = spawn(spec.cmd, spec.args, {
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
      env: opts.env ?? candidateEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const kill = (): void => {
      if (child.pid === undefined) return;
      try {
        // Negative pid kills the group on POSIX; Windows falls back to the
        // process itself, which spawn already detaches per-child.
        process.kill(child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, spec.timeoutMs);

    const onAbort = (): void => {
      kill();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    // Decoded across chunks, not per chunk.
    //
    // `chunk.toString("utf8")` decodes each Buffer in isolation, and a stream
    // splits wherever the pipe happens to flush — which lands mid-character
    // often enough to matter the moment output is not ASCII. Reproduced against
    // a real child process printing Korean: the character straddling the
    // boundary came back as replacement characters, in the output a user reads
    // to find out whether their program worked.
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE * 2) stdout += outDecoder.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE * 2) stderr += errDecoder.write(chunk);
    });

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolvePromise({
        gate: spec.gate,
        cmd: spec.cmd,
        args: spec.args,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
      });
    };

    child.on("error", (err) => {
      stderr += `\n[spawn error] ${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}
