import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CommandSpec } from "../../../src/protocol/index.ts";
import {
  detectPackageManager,
  discoverCommands as discover,
  discoverRunnableScripts,
  type RuntimeGap,
} from "../../../src/agent/discoverCommands.ts";

/**
 * Binds command discovery to a real workspace.
 *
 * The policy — which script names count as verification, which bodies are
 * refused whatever they are called, which interpreters may run a plain file —
 * lives in `src/agent/discoverCommands.ts` where `pnpm test` can reach it. This
 * is the filesystem and the process spawn it needs.
 */

export interface WorkspaceCommands {
  commands: CommandSpec[];
  gaps: RuntimeGap[];
}

export async function discoverCommands(workspaceRoot: string): Promise<WorkspaceCommands> {
  const exists = async (relative: string): Promise<boolean> => {
    try {
      await stat(join(workspaceRoot, relative));
      return true;
    } catch {
      return false;
    }
  };

  const declared = await discover({
    readFile: async (relative) => {
      try {
        return await readFile(join(workspaceRoot, relative), "utf8");
      } catch {
        return null;
      }
    },
    packageManager: await detectPackageManager(exists),
  });

  const runnable = await discoverRunnableScripts({
    listFiles: async (relativeDir) => {
      try {
        const entries = await readdir(join(workspaceRoot, relativeDir), { withFileTypes: true });
        return entries.filter((e) => e.isFile()).map((e) => e.name);
      } catch {
        return [];
      }
    },
    hasExecutable,
  });

  // Declared scripts first: a project that says how to test itself has said
  // something the file listing only guesses at.
  return { commands: [...declared, ...runnable.commands], gaps: runnable.gaps };
}

const executableCache = new Map<string, Promise<boolean>>();

/**
 * Whether this interpreter is really there.
 *
 * `--version` rather than a PATH lookup, because Windows ships `python.exe` and
 * `python3.exe` stubs that exist on PATH, run, and open the Microsoft Store
 * instead of an interpreter. A stub fails this check; a real interpreter prints
 * a version and exits 0.
 *
 * Cached for the life of the extension host. The answer changes when the user
 * installs something, and that is what "reopen the editor" in the install
 * guidance is for.
 */
function hasExecutable(name: string): Promise<boolean> {
  const cached = executableCache.get(name);
  if (cached !== undefined) return cached;

  const probe = new Promise<boolean>((resolve) => {
    execFile(name, ["--version"], { timeout: 5_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err !== null) {
        resolve(false);
        return;
      }
      resolve(/\d+\.\d+/.test(`${stdout}${stderr}`));
    });
  }).catch(() => false);

  executableCache.set(name, probe);
  return probe;
}
