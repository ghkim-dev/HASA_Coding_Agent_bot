import { mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { isInside } from "./git.ts";

/**
 * Filesystem sandbox for candidate agents.
 *
 * A candidate may only see and change files inside its own worktree. The check
 * is done on the *resolved real path*, not the requested string, because
 * `..` traversal is the easy case — a symlink pointing outside the worktree
 * passes every string-level check ever written.
 *
 * See docs/security-policy.md §2.3 and §2.4.
 */

export class SandboxViolation extends Error {
  readonly kind: "escape" | "forbidden" | "absolute" | "traversal";
  readonly requested: string;

  constructor(kind: SandboxViolation["kind"], requested: string, detail: string) {
    super(`sandbox violation (${kind}): ${detail}`);
    this.name = "SandboxViolation";
    this.kind = kind;
    this.requested = requested;
  }
}

/**
 * Never readable by a candidate, even inside its own worktree. Reading these is
 * how a compromised or merely over-eager agent turns file access into
 * credential access.
 */
const FORBIDDEN_BASENAMES = [
  ".env",
  ".npmrc",
  ".netrc",
  ".git-credentials",
  "id_rsa",
  "id_ed25519",
  "credentials",
  "credentials.json",
];

const FORBIDDEN_PATTERNS = [
  /^\.env($|\.)/i,
  /\.(pem|key|pfx|p12|keystore)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^credentials/i,
];

/** Directories a candidate must never touch, relative to its worktree. */
const FORBIDDEN_DIRS = [".git", ".arena", ".ssh", ".aws", ".gnupg"];

export function isForbiddenFile(relativePath: string): boolean {
  const normalized = normalize(relativePath).replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((s) => FORBIDDEN_DIRS.includes(s.toLowerCase()))) return true;
  const name = basename(normalized);
  if (FORBIDDEN_BASENAMES.includes(name.toLowerCase())) return true;
  return FORBIDDEN_PATTERNS.some((re) => re.test(name));
}

export interface SandboxOptions {
  /** Worktree root. Must already be a realpath. */
  root: string;
  /**
   * When set, writes are further restricted to these path prefixes — the task
   * spec's declared scope. Reads stay worktree-wide so the agent can orient.
   */
  writeScope?: string[];
}

export class Sandbox {
  readonly root: string;
  private readonly writeScope: string[];

  constructor(opts: SandboxOptions) {
    this.root = resolve(opts.root);
    this.writeScope = (opts.writeScope ?? []).map((p) => normalize(p).replace(/\\/g, "/"));
  }

  /**
   * Resolves a candidate-supplied relative path to an absolute one, or throws.
   *
   * `mustExist` controls whether the symlink check runs against the target
   * itself or its parent directory — a file being created does not exist yet,
   * but its parent must still be inside the sandbox.
   */
  async resolvePath(relativePath: string, opts: { forWrite?: boolean } = {}): Promise<string> {
    if (typeof relativePath !== "string" || relativePath.length === 0) {
      throw new SandboxViolation("traversal", relativePath, "empty path");
    }
    if (isAbsolute(relativePath)) {
      throw new SandboxViolation("absolute", relativePath, "absolute paths are not allowed");
    }
    if (normalize(relativePath).replace(/\\/g, "/").split("/").includes("..")) {
      throw new SandboxViolation("traversal", relativePath, "'..' is not allowed");
    }
    if (isForbiddenFile(relativePath)) {
      throw new SandboxViolation("forbidden", relativePath, `${relativePath} is not readable by candidates`);
    }
    if (opts.forWrite === true && this.writeScope.length > 0) {
      const normalized = normalize(relativePath).replace(/\\/g, "/");
      const allowed = this.writeScope.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
      if (!allowed) {
        throw new SandboxViolation(
          "escape",
          relativePath,
          `${relativePath} is outside the task's declared write scope`,
        );
      }
    }

    const candidate = resolve(this.root, relativePath);
    // Resolve symlinks on whichever of the path/parent exists, then confirm the
    // real location is still inside the worktree.
    let probe = candidate;
    let real: string | null = null;
    for (let i = 0; i < 40 && probe.length > 0; i += 1) {
      try {
        real = await realpath(probe);
        break;
      } catch {
        const parent = dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    if (real === null) {
      throw new SandboxViolation("escape", relativePath, "path could not be resolved");
    }
    // `real` may be an ancestor when the file does not exist yet; re-attach the
    // unresolved tail before checking containment.
    const tail = candidate.slice(probe.length);
    const resolvedFull = tail.length > 0 ? join(real, tail) : real;
    if (!isInside(this.root, resolvedFull)) {
      throw new SandboxViolation(
        "escape",
        relativePath,
        `resolves to ${resolvedFull}, outside ${this.root}`,
      );
    }
    return resolvedFull;
  }

  /**
   * Part of a file, for one that is too large to read whole.
   *
   * Every containment check `readFile` makes still applies — the path goes
   * through the same `resolvePath`, so a range read cannot reach anywhere a
   * whole read could not. What is different is only that the size ceiling is
   * the caller's business rather than a refusal.
   */
  async readFileRange(relativePath: string, offset: number, length: number): Promise<string> {
    const full = await this.resolvePath(relativePath);
    const info = await stat(full);
    if (!info.isFile()) throw new SandboxViolation("forbidden", relativePath, "not a regular file");

    const handle = await open(full, "r");
    try {
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, info.size - offset)));
      if (buffer.length === 0) return "";
      await handle.read(buffer, 0, buffer.length, offset);
      // Decoded as a whole rather than per read: a chunk boundary that lands
      // mid-character would otherwise produce replacement characters, the same
      // fault that made command output unreadable.
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  }

  async readFile(relativePath: string, maxBytes = 512 * 1024): Promise<string> {
    const full = await this.resolvePath(relativePath);
    const info = await stat(full);
    if (!info.isFile()) throw new SandboxViolation("forbidden", relativePath, "not a regular file");
    if (info.size > maxBytes) {
      throw new SandboxViolation("forbidden", relativePath, `file is ${info.size} bytes (limit ${maxBytes})`);
    }
    return readFile(full, "utf8");
  }

  /**
   * Writes a file, creating every directory on the way.
   *
   * The recursive `mkdir` is load-bearing rather than a convenience, and it is
   * what closes half of a real failure: on Windows the agent tried `mkdir -p`,
   * then `mkdir` as though it were a program, and neither worked. Nothing needs
   * to be created first — the path is the instruction, and it is followed with
   * a filesystem call rather than a command whose spelling differs per
   * platform.
   *
   * `resolvePath(forWrite)` runs first, so the directories are only ever made
   * inside the workspace.
   */
  async writeFile(relativePath: string, contents: string): Promise<void> {
    const full = await this.resolvePath(relativePath, { forWrite: true });
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents, "utf8");
  }

  /**
   * Writes bytes rather than text.
   *
   * Generated images and video are binary, and routing them through
   * `writeFile` would encode them as UTF-8 and corrupt every byte above 0x7f.
   * The path goes through the same `resolvePath(forWrite)` check, so the
   * sandbox boundary is identical — only the encoding differs.
   */
  async writeBytes(relativePath: string, contents: Uint8Array): Promise<void> {
    const full = await this.resolvePath(relativePath, { forWrite: true });
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents);
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      const full = await this.resolvePath(relativePath);
      await stat(full);
      return true;
    } catch {
      return false;
    }
  }
}
