import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CommandSpec } from "../../../src/protocol/index.ts";
import {
  detectPackageManager,
  discoverCommands as discover,
} from "../../../src/agent/discoverCommands.ts";

/**
 * Binds command discovery to a real workspace.
 *
 * The policy — which script names count as verification, which bodies are
 * refused whatever they are called — lives in `src/agent/discoverCommands.ts`
 * where `pnpm test` can reach it. This is the four lines of filesystem it needs.
 */
export async function discoverCommands(workspaceRoot: string): Promise<CommandSpec[]> {
  const exists = async (relative: string): Promise<boolean> => {
    try {
      await stat(join(workspaceRoot, relative));
      return true;
    } catch {
      return false;
    }
  };
  return discover({
    readFile: async (relative) => {
      try {
        return await readFile(join(workspaceRoot, relative), "utf8");
      } catch {
        return null;
      }
    },
    packageManager: await detectPackageManager(exists),
  });
}
