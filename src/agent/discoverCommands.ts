import type { CommandSpec } from "../protocol/index.ts";

/**
 * Which commands the agent may run in this project.
 *
 * The Arena's allowlist comes from a task specification written up front. A
 * person talking to an agent writes no such thing, so the list has to come from
 * somewhere else — and inventing it is not an option, because `execute_command`
 * is the sharpest thing the agent owns.
 *
 * So it is discovered: the project's own `package.json` scripts, and only the
 * ones whose names mean something. A script called `deploy` or `release` is not
 * offered however the project spells it, because "run the tests" and "publish
 * to production" are not the same request and the agent cannot tell which one a
 * user meant by "check it works".
 *
 * See docs/security-policy.md §2.1.
 */

/** Script names that mean "tell me whether this is correct". */
const VERIFICATION_GATES: ReadonlyArray<{ gate: CommandSpec["gate"]; names: readonly string[] }> = [
  { gate: "test", names: ["test", "tests", "test:unit", "unit"] },
  { gate: "typecheck", names: ["typecheck", "type-check", "tsc", "check-types"] },
  { gate: "lint", names: ["lint", "eslint", "lint:check"] },
  { gate: "build", names: ["build", "compile"] },
];

/**
 * Never offered, whatever a project calls them.
 *
 * A denylist is a second line of defence and would be useless alone — this
 * works because the allowlist above is a closed set of four gates. What it
 * catches is a project whose `build` script publishes.
 */
const FORBIDDEN_SCRIPT_BODY =
  /\b(publish|deploy|release|push|prune|rm\s+-rf|kubectl|terraform|docker\s+push|gh\s+release|npm\s+version)\b/i;

export interface DiscoverOptions {
  /** Reads a workspace file, or returns null. Injected so this stays testable. */
  readFile: (relativePath: string) => Promise<string | null>;
  /** The package manager to invoke. Detected by the caller from the lockfile. */
  packageManager?: "pnpm" | "npm" | "yarn";
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/**
 * Reads the project's scripts and returns the ones worth offering.
 *
 * Returns an empty list rather than a guess when there is no `package.json`.
 * An empty list means no command tool is registered at all, which is better
 * than one that refuses everything: an offered tool that never works costs a
 * turn every time the model tries it.
 */
export async function discoverCommands(opts: DiscoverOptions): Promise<CommandSpec[]> {
  const raw = await opts.readFile("package.json").catch(() => null);
  if (raw === null) return [];

  let scripts: Record<string, string>;
  try {
    const parsed: unknown = JSON.parse(raw);
    const value =
      parsed !== null && typeof parsed === "object"
        ? (parsed as { scripts?: unknown }).scripts
        : undefined;
    if (value === null || typeof value !== "object") return [];
    scripts = value as Record<string, string>;
  } catch {
    return [];
  }

  const manager = opts.packageManager ?? "pnpm";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const out: CommandSpec[] = [];

  for (const { gate, names } of VERIFICATION_GATES) {
    const name = names.find((candidate) => typeof scripts[candidate] === "string");
    if (name === undefined) continue;
    const body = scripts[name] ?? "";
    if (FORBIDDEN_SCRIPT_BODY.test(body)) continue;
    out.push({
      gate,
      kind: "acceptance",
      cmd: manager,
      // `run` explicitly: `pnpm test` works, but `pnpm run <name>` is what makes
      // the argument list an exact match for a script rather than for a pnpm
      // subcommand that happens to share its name.
      args: ["run", name],
      timeoutMs,
    });
  }
  return out;
}

/**
 * Running a plain script.
 *
 * A folder holding one `calculator.py` and nothing else declares no scripts, so
 * the code above finds nothing, no command tool is registered, and the agent
 * says the workspace contains nothing runnable. That is true of `package.json`
 * and false of the file the user is looking at — and the people it misleads are
 * exactly the ones who cannot work around it, because setting up a project is
 * the part they needed help with.
 *
 * The safety argument is not that this is harmless. It is that `python
 * calculator.py` is *narrower* than what the discovered scripts already allow:
 * `pnpm run build` executes an arbitrary shell string out of `package.json`,
 * while this is a fixed interpreter and one path, no shell, still exact-matched
 * by `assertRunnable` and still stopped at the approval gate like any other
 * `execute` tool. What it must never become is a way to name an arbitrary
 * program, which is why the interpreter comes from a closed table and the file
 * must already exist.
 */

interface Runtime {
  language: string;
  extensions: readonly string[];
  /** Tried in order; the first that answers `--version` wins. */
  interpreters: readonly string[];
  install: string;
}

/**
 * Python and JavaScript only.
 *
 * Not shell scripts: `bash deploy.sh` is arbitrary shell with an extra step,
 * and the whole point of the allowlist is that there isn't one. Not TypeScript
 * either — whether `node file.ts` works depends on the Node version, and a
 * command that fails for a reason the user cannot see is worse than one that
 * was never offered.
 */
const RUNTIMES: readonly Runtime[] = [
  {
    language: "Python",
    extensions: [".py"],
    // `python` first: on Windows `python3` is often a Store stub that exits
    // without running anything, which the `--version` check is there to catch.
    interpreters: ["python", "python3", "py"],
    install: "install Python from https://www.python.org/downloads/ (tick “Add python.exe to PATH”), then reopen the editor",
  },
  {
    language: "JavaScript",
    extensions: [".js", ".mjs", ".cjs"],
    interpreters: ["node"],
    install: "install Node.js from https://nodejs.org/ , then reopen the editor",
  },
];

/** Names that mean "this is the program", in the order they are preferred. */
const ENTRY_NAMES = ["main", "app", "__main__", "index", "run", "start", "program"];

/** Directories searched. Flat by design: a beginner's folder is flat, and a deep
 * walk finds `venv/.../setup.py`, which is nobody's program. */
const SEARCH_DIRS = ["", "src"];

/** Most a project may offer, so the model picks from a list it can read. */
const MAX_RUN_COMMANDS = 6;

export interface RuntimeGap {
  language: string;
  /** Examples, for a message the user can act on. */
  files: string[];
  install: string;
}

export interface RunnableDiscovery {
  commands: CommandSpec[];
  /** Languages present in the workspace with no interpreter installed. */
  gaps: RuntimeGap[];
}

export interface DiscoverRunnableOptions {
  /** File names in a workspace-relative directory. Not recursive. */
  listFiles: (relativeDir: string) => Promise<string[]>;
  /** Whether this executable exists and runs. Injected so this stays testable. */
  hasExecutable: (name: string) => Promise<boolean>;
  timeoutMs?: number;
}

/**
 * Finds the scripts in this workspace and the interpreter that runs them.
 *
 * Returns the gaps as well as the commands: a workspace full of `.py` with no
 * Python installed is the case worth reporting, not the case worth hiding.
 */
export async function discoverRunnableScripts(
  opts: DiscoverRunnableOptions,
): Promise<RunnableDiscovery> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const commands: CommandSpec[] = [];
  const gaps: RuntimeGap[] = [];

  for (const runtime of RUNTIMES) {
    const files = await filesFor(runtime, opts.listFiles);
    if (files.length === 0) continue;

    let interpreter: string | null = null;
    for (const candidate of runtime.interpreters) {
      if (await opts.hasExecutable(candidate).catch(() => false)) {
        interpreter = candidate;
        break;
      }
    }

    if (interpreter === null) {
      gaps.push({ language: runtime.language, files: files.slice(0, 3), install: runtime.install });
      continue;
    }

    for (const file of files.slice(0, MAX_RUN_COMMANDS)) {
      commands.push({ gate: "run", kind: "acceptance", cmd: interpreter, args: [file], timeoutMs });
    }
  }

  return { commands: commands.slice(0, MAX_RUN_COMMANDS), gaps };
}

/** The runtime's files, entry points first. */
async function filesFor(
  runtime: Runtime,
  listFiles: (dir: string) => Promise<string[]>,
): Promise<string[]> {
  const found: string[] = [];
  for (const dir of SEARCH_DIRS) {
    const names = await listFiles(dir).catch(() => []);
    for (const name of names) {
      if (!runtime.extensions.some((ext) => name.toLowerCase().endsWith(ext))) continue;
      found.push(dir === "" ? name : `${dir}/${name}`);
    }
  }

  return found.sort((a, b) => {
    const rank = (path: string): number => {
      const stem = (path.split("/").pop() ?? "").replace(/\.[^.]+$/, "").toLowerCase();
      const index = ENTRY_NAMES.indexOf(stem);
      return index === -1 ? ENTRY_NAMES.length : index;
    };
    return rank(a) - rank(b) || a.localeCompare(b);
  });
}

/** Which package manager this project uses, from its lockfile. */
export async function detectPackageManager(
  exists: (relativePath: string) => Promise<boolean>,
): Promise<"pnpm" | "npm" | "yarn"> {
  if (await exists("pnpm-lock.yaml")) return "pnpm";
  if (await exists("yarn.lock")) return "yarn";
  return "npm";
}
