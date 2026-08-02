import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConversationStorePort } from "../../../src/agent/conversationStore.ts";

/**
 * The conversation store's filesystem.
 *
 * Everything that decides anything — how conversations are scoped, what is
 * stored, what is pruned — is in `src/agent/conversationStore.ts` under
 * `pnpm test`. This is the disk it writes to.
 *
 * Writes go through a temporary file and a rename because the failure this
 * store is shaped around is a machine losing power mid-write. A half-written
 * JSON file is a conversation the user cannot open; a rename either happened or
 * did not.
 */

let sequence = 0;

export function createConversationPort(): ConversationStorePort {
  return {
    async listFiles(dir) {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.filter((e) => e.isFile()).map((e) => e.name);
      } catch {
        return [];
      }
    },

    async readFile(path) {
      return readFile(path, "utf8");
    },

    async writeFile(path, contents) {
      await mkdir(dirname(path), { recursive: true });
      // A per-write sequence number, not a fixed suffix: two saves racing on
      // one path published a spliced file when the model cache did this with a
      // shared temp name, and that regression is not worth repeating here.
      sequence += 1;
      const temporary = `${path}.${process.pid}.${sequence}.tmp`;
      try {
        await writeFile(temporary, contents, "utf8");
        await rename(temporary, path);
      } finally {
        // Unconditional: a failed rename on Windows leaves the temp file
        // behind, and a directory of debris is its own bug.
        await rm(temporary, { force: true }).catch(() => {});
      }
    },

    async remove(path) {
      await rm(path, { force: true });
    },
  };
}

/** Where this machine keeps them. Extension storage, never the workspace. */
export function conversationHome(globalStorage: string): string {
  return join(globalStorage);
}
