import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Git operations.
 *
 * Every call goes through `execFile` with an argument array and no shell, so a
 * branch name or path can never be interpreted as a command. `git` is the only
 * binary this module is allowed to invoke.
 *
 * See docs/architecture.md §7 and docs/security-policy.md §2.1.
 */

export class GitError extends Error {
  readonly stderr: string;
  readonly code: number | null;

  constructor(message: string, stderr: string, code: number | null) {
    super(message);
    this.name = "GitError";
    this.stderr = stderr;
    this.code = code;
  }
}

interface GitResult {
  stdout: string;
  stderr: string;
}

async function git(cwd: string, args: string[], opts: { maxBuffer?: number } = {}): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run("git", args, {
      cwd,
      shell: false,
      windowsHide: true,
      maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
      // Deliberately minimal: git must not inherit HASA_API_KEY or anything
      // else the orchestrator holds. See docs/security-policy.md §1.3.
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        USERPROFILE: process.env["USERPROFILE"] ?? "",
        SYSTEMROOT: process.env["SYSTEMROOT"] ?? "",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        LC_ALL: "C",
      },
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; code?: number; message?: string };
    throw new GitError(
      `git ${args[0] ?? ""} failed: ${e.message ?? "unknown"}`,
      String(e.stderr ?? ""),
      typeof e.code === "number" ? e.code : null,
    );
  }
}

export interface WorktreeHandle {
  label: string;
  path: string;
  baseCommit: string;
}

/**
 * A git repository the arena is allowed to operate on.
 *
 * Constructed only through `open`, which refuses anything that is not the root
 * of a real repository — a subdirectory would make every worktree path relative
 * to the wrong tree.
 */
export class GitRepo {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async open(dir: string): Promise<GitRepo> {
    if (!isAbsolute(dir)) throw new GitError("repository path must be absolute", "", null);
    let resolved: string;
    try {
      resolved = await realpath(dir);
    } catch {
      throw new GitError(`not a directory: ${dir}`, "", null);
    }
    const { stdout } = await git(resolved, ["rev-parse", "--show-toplevel"]);
    const top = await realpath(stdout.trim());
    if (top !== resolved) {
      throw new GitError(
        `${dir} is inside a repository rooted at ${top}, not the root itself. ` +
          "Worktree isolation requires the repository root.",
        "",
        null,
      );
    }
    return new GitRepo(top);
  }

  static async isRepoRoot(dir: string): Promise<boolean> {
    try {
      await GitRepo.open(dir);
      return true;
    } catch {
      return false;
    }
  }

  async headSha(): Promise<string> {
    const { stdout } = await git(this.root, ["rev-parse", "HEAD"]);
    return stdout.trim();
  }

  /** Empty output means a clean tree, including untracked files. */
  async status(): Promise<string[]> {
    const { stdout } = await git(this.root, ["status", "--porcelain"]);
    return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  async isClean(): Promise<boolean> {
    return (await this.status()).length === 0;
  }

  /**
   * Detached worktree at a fixed commit.
   *
   * Detached on purpose: candidates must not create or move branches in the
   * user's repository, and every candidate starts from the identical tree.
   */
  async addWorktree(path: string, baseCommit: string, label: string): Promise<WorktreeHandle> {
    await git(this.root, ["worktree", "add", "--detach", path, baseCommit]);
    return { label, path: await realpath(path), baseCommit };
  }

  async removeWorktree(path: string, force = true): Promise<void> {
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(path);
    await git(this.root, args);
  }

  async pruneWorktrees(): Promise<void> {
    await git(this.root, ["worktree", "prune"]);
  }

  async listWorktrees(): Promise<string[]> {
    const { stdout } = await git(this.root, ["worktree", "list", "--porcelain"]);
    return stdout
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length).trim());
  }

  /**
   * Diff of a worktree against the run's base commit.
   *
   * Untracked files are staged with `add -N` first: an agent that creates a new
   * file has done real work, and a diff that silently omits it would let a
   * candidate look like it changed nothing.
   */
  async diffWorktree(worktreePath: string, baseCommit: string): Promise<string> {
    await git(worktreePath, ["add", "-A", "-N"]);
    const { stdout } = await git(worktreePath, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--binary",
      baseCommit,
    ]);
    return stdout;
  }

  async changedFiles(worktreePath: string, baseCommit: string): Promise<string[]> {
    await git(worktreePath, ["add", "-A", "-N"]);
    const { stdout } = await git(worktreePath, ["diff", "--name-only", baseCommit]);
    return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  /** Dry run — reports whether a patch would apply without touching the tree. */
  async canApply(patch: string, cwd = this.root): Promise<boolean> {
    if (patch.trim().length === 0) return false;
    try {
      await this.applyPatchInternal(cwd, patch, true);
      return true;
    } catch {
      return false;
    }
  }

  async applyPatch(patch: string, cwd = this.root): Promise<void> {
    await this.applyPatchInternal(cwd, patch, false);
  }

  private async applyPatchInternal(cwd: string, patch: string, check: boolean): Promise<void> {
    const args = ["apply", "--whitespace=nowarn"];
    if (check) args.push("--check");
    args.push("-");
    await new Promise<void>((resolvePromise, reject) => {
      const child = execFile(
        "git",
        args,
        { cwd, shell: false, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
        (err, _stdout, stderr) => {
          if (err) reject(new GitError(`git apply failed`, String(stderr ?? ""), null));
          else resolvePromise();
        },
      );
      child.stdin?.end(patch.endsWith("\n") ? patch : `${patch}\n`);
    });
  }

  /**
   * Snapshot the current working tree so an apply can be undone.
   *
   * Returns a stash ref, or null when the tree was already clean (nothing to
   * restore). Callers surface this to the user so "apply" is never a one-way
   * door — see docs/security-policy.md §3.
   */
  async snapshot(message: string): Promise<string | null> {
    if (await this.isClean()) return null;
    await git(this.root, ["stash", "push", "--include-untracked", "-m", message]);
    const { stdout } = await git(this.root, ["rev-parse", "stash@{0}"]);
    return stdout.trim();
  }

  async revision(ref: string): Promise<string> {
    const { stdout } = await git(this.root, ["rev-parse", ref]);
    return stdout.trim();
  }
}

/** Path of a candidate's worktree. Kept short — Windows has a 260-char limit. */
export function worktreePathFor(repoRoot: string, runId: string, label: string): string {
  return join(repoRoot, ".arena", "wt", `${runId.slice(0, 8)}-${label}`);
}

/** True when `child` is inside `parent` (both already realpath-resolved). */
export function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}
