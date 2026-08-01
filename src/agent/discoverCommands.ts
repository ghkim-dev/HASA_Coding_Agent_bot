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

/** Which package manager this project uses, from its lockfile. */
export async function detectPackageManager(
  exists: (relativePath: string) => Promise<boolean>,
): Promise<"pnpm" | "npm" | "yarn"> {
  if (await exists("pnpm-lock.yaml")) return "pnpm";
  if (await exists("yarn.lock")) return "yarn";
  return "npm";
}
