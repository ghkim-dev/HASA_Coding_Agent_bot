import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { Sandbox } from "../../core/sandbox.ts";
import type { AgentTool, ToolContext, ToolResult } from "../types.ts";

/**
 * The file tools.
 *
 * Every path goes through `core/sandbox.ts`, which resolves symlinks before
 * checking containment and refuses `.env`, keys and `.git` outright. That code
 * is the Arena's and is already tested against traversal, absolute paths and
 * symlink escape; nothing here re-checks what it checks.
 *
 * What is added is the shape a *person* has to approve. A tool that reports
 * "wrote 41 lines to src/auth.ts" can be approved; one that reports a JSON blob
 * cannot, and a user who cannot read a request quickly will approve everything.
 */

const MAX_LIST_ENTRIES = 400;
const MAX_SEARCH_HITS = 200;
const MAX_READ_BYTES = 256 * 1024;

const IGNORED_DIRS = new Set([".git", ".arena", "node_modules", "dist", "out", ".next", "target"]);

function str(args: Record<string, unknown>, key: string, fallback = ""): string {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Same slashes on every platform, so a model sees one convention. */
function posix(path: string): string {
  return path.split(sep).join("/");
}

export function createFileTools(sandbox: Sandbox): AgentTool[] {
  return [listFiles(sandbox), readFileTool(sandbox), searchFiles(sandbox), createFile(sandbox), applyPatch(sandbox)];
}

function listFiles(sandbox: Sandbox): AgentTool {
  return {
    name: "list_files",
    risk: "read",
    description:
      "List files and directories inside the workspace. Use it to orient yourself before reading. " +
      "Paths are relative to the workspace root; '.' is the root.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative directory. '.' for the workspace root." },
        recursive: { type: "boolean", description: "Descend into subdirectories." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    summarize: (args) => `${str(args, "path", ".")} 디렉터리를 확인합니다`,
    async execute(args, ctx): Promise<ToolResult> {
      const path = str(args, "path", ".") || ".";
      const recursive = args["recursive"] === true;
      const root = await sandbox.resolvePath(path);
      const found: string[] = [];

      const walk = async (dir: string, depth: number): Promise<void> => {
        if (found.length >= MAX_LIST_ENTRIES || ctx.signal.aborted) return;
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (found.length >= MAX_LIST_ENTRIES) return;
          if (IGNORED_DIRS.has(entry.name)) continue;
          const full = join(dir, entry.name);
          const rel = posix(relative(sandbox.root, full));
          if (entry.isDirectory()) {
            found.push(`${rel}/`);
            if (recursive && depth < 8) await walk(full, depth + 1);
          } else {
            found.push(rel);
          }
        }
      };

      await walk(root, 0);
      const truncated = found.length >= MAX_LIST_ENTRIES;
      return {
        ok: true,
        content:
          found.length === 0
            ? `${path} is empty.`
            : found.join("\n") + (truncated ? `\n…listing stopped at ${MAX_LIST_ENTRIES} entries` : ""),
      };
    },
  };
}

// Named `readFileTool`, not `readFile`: a bare `readFile` in this file would
// shadow the unsafe `node:fs` one and make the safety rule unenforceable.
function readFileTool(sandbox: Sandbox): AgentTool {
  return {
    name: "read_file",
    risk: "read",
    description:
      "Read a UTF-8 text file from the workspace. Read a file before changing it — editing from memory " +
      "is how a patch stops applying.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path." },
        startLine: { type: "number", description: "1-based first line. Omit to read from the start." },
        endLine: { type: "number", description: "1-based last line, inclusive." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    summarize: (args) => `${str(args, "path")} 파일을 읽습니다`,
    async execute(args): Promise<ToolResult> {
      const path = str(args, "path");
      const text = await sandbox.readFile(path, MAX_READ_BYTES);
      const lines = text.split("\n");
      const start = Math.max(1, num(args, "startLine", 1));
      const end = Math.min(lines.length, num(args, "endLine", lines.length));
      const slice = lines.slice(start - 1, end);
      // Numbered, because the next thing the model does is describe an edit by
      // line and an unnumbered listing makes it guess.
      const body = slice.map((line, i) => `${start + i}\t${line}`).join("\n");
      return {
        ok: true,
        content: `${path} (lines ${start}-${start + slice.length - 1} of ${lines.length})\n${body}`,
      };
    },
  };
}

function searchFiles(sandbox: Sandbox): AgentTool {
  return {
    name: "search_files",
    risk: "read",
    description:
      "Search the workspace for a regular expression and return matching lines with their paths. " +
      "Faster than reading files one by one when you do not know where something lives.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression." },
        path: { type: "string", description: "Relative directory to search. Defaults to the root." },
        glob: { type: "string", description: "Only search files whose path contains this substring." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    summarize: (args) => `"${str(args, "pattern")}" 를 검색합니다`,
    async execute(args, ctx): Promise<ToolResult> {
      const pattern = str(args, "pattern");
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, "g");
      } catch (err) {
        // Handed back rather than thrown: an invalid pattern is a mistake the
        // model can correct, and a thrown error ends the turn instead.
        return { ok: false, content: `invalid regular expression: ${(err as Error).message}` };
      }
      const filter = str(args, "glob");
      const root = await sandbox.resolvePath(str(args, "path", ".") || ".");
      const hits: string[] = [];

      const walk = async (dir: string, depth: number): Promise<void> => {
        if (hits.length >= MAX_SEARCH_HITS || ctx.signal.aborted || depth > 10) return;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (hits.length >= MAX_SEARCH_HITS) return;
          if (IGNORED_DIRS.has(entry.name)) continue;
          const full = join(dir, entry.name);
          const rel = posix(relative(sandbox.root, full));
          if (entry.isDirectory()) {
            await walk(full, depth + 1);
            continue;
          }
          if (filter.length > 0 && !rel.includes(filter)) continue;
          let text: string;
          try {
            const info = await stat(full);
            if (info.size > MAX_READ_BYTES) continue;
            text = await sandbox.readFile(rel, MAX_READ_BYTES);
          } catch {
            // Unreadable, binary or forbidden by the sandbox. Skipping is
            // right: a search must not become a way to probe what exists.
            continue;
          }
          text.split("\n").forEach((line, i) => {
            if (hits.length >= MAX_SEARCH_HITS) return;
            regex.lastIndex = 0;
            if (regex.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
          });
        }
      };

      await walk(root, 0);
      return {
        ok: true,
        content:
          hits.length === 0
            ? `No match for ${pattern}.`
            : hits.join("\n") + (hits.length >= MAX_SEARCH_HITS ? `\n…stopped at ${MAX_SEARCH_HITS} matches` : ""),
      };
    },
  };
}

function createFile(sandbox: Sandbox): AgentTool {
  return {
    name: "create_file",
    risk: "write",
    description:
      "Create a file, or replace one entirely, with the complete new contents. " +
      "For a small change to a large file prefer apply_patch — rewriting a file to change one line " +
      "loses anything you did not remember to include.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path." },
        contents: { type: "string", description: "The complete file contents." },
      },
      required: ["path", "contents"],
      additionalProperties: false,
    },
    summarize: (args) => {
      const lines = str(args, "contents").split("\n").length;
      return `${str(args, "path")} 파일을 작성합니다 (${lines}줄)`;
    },
    async preview(args): Promise<string | null> {
      const path = str(args, "path");
      const next = str(args, "contents");
      const existed = await sandbox.exists(path);
      if (!existed) return `+++ ${path} (새 파일, ${next.split("\n").length}줄)\n${excerpt(next)}`;
      const previous = await sandbox.readFile(path, MAX_READ_BYTES).catch(() => "");
      return unifiedish(path, previous, next);
    },
    async execute(args): Promise<ToolResult> {
      const path = str(args, "path");
      const contents = str(args, "contents");
      await sandbox.writeFile(path, contents);
      return { ok: true, content: `wrote ${path} (${contents.split("\n").length} lines)`, changedFiles: [path] };
    },
  };
}

function applyPatch(sandbox: Sandbox): AgentTool {
  return {
    name: "apply_patch",
    risk: "write",
    description:
      "Replace an exact block of text in a file. `find` must match the file's current contents " +
      "exactly once, including indentation. Read the file first. " +
      "read_file prefixes each line with its number and a tab for reference — those prefixes are " +
      "not part of the file, so do not copy them into `find`.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path." },
        find: { type: "string", description: "The exact text to replace. Must occur exactly once." },
        replace: { type: "string", description: "The replacement text." },
      },
      required: ["path", "find", "replace"],
      additionalProperties: false,
    },
    summarize: (args) => `${str(args, "path")} 파일의 일부를 수정합니다`,
    async preview(args): Promise<string | null> {
      const path = str(args, "path");
      const previous = await sandbox.readFile(path, MAX_READ_BYTES).catch(() => null);
      if (previous === null) return null;
      const next = replaceOnce(previous, str(args, "find"), str(args, "replace"));
      return next === null ? null : unifiedish(path, previous, next);
    },
    async execute(args): Promise<ToolResult> {
      const path = str(args, "path");
      const previous = await sandbox.readFile(path, MAX_READ_BYTES);
      // Measured against the live gateway: a model reads a file, sees
      // `2\t  return x;`, and puts that in `find`. The prefix is ours, added by
      // read_file, so the mismatch is our doing and stripping it back off is
      // not guessing — it is undoing something we did.
      const find = withoutLineNumbers(str(args, "find"), previous);
      const occurrences = countOccurrences(previous, find);

      // Both failures are handed back as results, not thrown: the model can fix
      // either one, and it needs to know which it is. "Not found" means read the
      // file again; "found twice" means include more context.
      if (occurrences === 0) {
        return {
          ok: false,
          content:
            `the text to replace was not found in ${path}. Read the file again and copy the lines exactly. ` +
            "Do not include the line numbers read_file adds, and keep the original indentation.",
        };
      }
      if (occurrences > 1) {
        return {
          ok: false,
          content: `the text to replace occurs ${occurrences} times in ${path}. Include more surrounding lines so it is unique.`,
        };
      }

      const next = replaceOnce(previous, find, str(args, "replace"));
      if (next === null) return { ok: false, content: `could not apply the change to ${path}.` };
      await sandbox.writeFile(path, next);
      return { ok: true, content: `updated ${path}`, changedFiles: [path] };
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * Removes the `12\t` prefixes `read_file` adds, when that is what they are.
 *
 * Guarded twice, because stripping a real leading number would corrupt an edit
 * to a data file. It only applies when *every* non-empty line carries the
 * prefix, when the text does not already match the file, and when the stripped
 * version does. Anything less certain is left alone and reported as a miss.
 */
function withoutLineNumbers(find: string, contents: string): string {
  if (find.length === 0 || contents.includes(find)) return find;

  const lines = find.split("\n");
  const meaningful = lines.filter((line) => line.trim().length > 0);
  if (meaningful.length === 0) return find;
  if (!meaningful.every((line) => /^\d+\t/.test(line))) return find;

  const stripped = lines.map((line) => line.replace(/^\d+\t/, "")).join("\n");
  return contents.includes(stripped) ? stripped : find;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function replaceOnce(haystack: string, needle: string, replacement: string): string | null {
  const index = haystack.indexOf(needle);
  if (index === -1) return null;
  return haystack.slice(0, index) + replacement + haystack.slice(index + needle.length);
}

function excerpt(text: string, lines = 20): string {
  const split = text.split("\n");
  return split.length <= lines ? text : `${split.slice(0, lines).join("\n")}\n…${split.length - lines}줄 더`;
}

/**
 * A diff a person can read, without a diff library.
 *
 * Not unified diff — it is a summary with the changed region shown. The user is
 * approving an intention, and the editor shows them the real diff afterwards.
 */
function unifiedish(path: string, previous: string, next: string): string {
  const before = previous.split("\n");
  const after = next.split("\n");
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  const removed = before.slice(head, before.length - tail);
  const added = after.slice(head, after.length - tail);
  const body = [
    ...removed.slice(0, 20).map((l) => `- ${l}`),
    ...added.slice(0, 20).map((l) => `+ ${l}`),
  ].join("\n");
  return `${path}  (-${removed.length} +${added.length}, line ${head + 1})\n${body}`;
}
