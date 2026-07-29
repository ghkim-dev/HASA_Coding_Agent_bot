import { spawn } from "node:child_process";
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

function truncate(text: string): string {
  return text.length > MAX_CAPTURE ? `${text.slice(0, MAX_CAPTURE)}\n…[truncated]` : text;
}

/** Rejects a command that could not have come from the task specification. */
export function assertRunnable(spec: CommandSpec, allowlist: CommandSpec[]): void {
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
  const env: Record<string, string> = { CI: "1", NO_COLOR: "1", ...extra };
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

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE * 2) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE * 2) stderr += chunk.toString("utf8");
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
