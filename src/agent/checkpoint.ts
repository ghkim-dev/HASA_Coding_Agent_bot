import { GitError, GitRepo } from "../core/git.ts";
import { nullLogger, type Logger } from "../hasa-client/logger.ts";

/**
 * A way back.
 *
 * The Arena never needed this: candidates work in throwaway worktrees, so
 * "undo" is `rm -rf`. This agent edits the repository the user is sitting in,
 * and the only acceptable version of that is one where every turn can be
 * undone.
 *
 * The mechanism is `git stash --include-untracked`, which `core/git.ts` already
 * implements and the Arena already uses for `apply`. Nothing new is invented
 * here; what is added is *when* — before the first write of a turn rather than
 * after the last, because a crash between the two is exactly when a user needs
 * the snapshot to exist.
 *
 * See §17 of the product brief and docs/security-policy.md §3.
 */

export interface CheckpointOptions {
  repoRoot: string;
  logger?: Logger;
  /** Injected in tests. */
  openRepo?: (dir: string) => Promise<GitRepo>;
  now?: () => number;
}

export interface Checkpoint {
  /** A stash ref, or null when the tree was already clean. */
  ref: string | null;
  /** The commit the workspace was on. */
  baseCommit: string;
  takenAt: string;
  /** Human sentence for the transcript. */
  detail: string;
}

export class CheckpointManager {
  private readonly repoRoot: string;
  private readonly log: Logger;
  private readonly openRepo: (dir: string) => Promise<GitRepo>;
  private readonly now: () => number;
  private repo: GitRepo | null = null;
  private taken: Checkpoint | null = null;

  constructor(opts: CheckpointOptions) {
    this.repoRoot = opts.repoRoot;
    this.log = opts.logger ?? nullLogger;
    this.openRepo = opts.openRepo ?? ((dir) => GitRepo.open(dir));
    this.now = opts.now ?? Date.now;
  }

  /** The checkpoint taken this turn, if any. */
  get current(): Checkpoint | null {
    return this.taken;
  }

  /**
   * True when this workspace can be protected at all.
   *
   * A non-git directory is not refused outright — the user may genuinely want
   * the agent in a scratch folder — but they have to be told that undo will not
   * be available, which is a decision, not a detail.
   */
  async available(): Promise<boolean> {
    try {
      this.repo = await this.openRepo(this.repoRoot);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Snapshots the workspace, once per turn.
   *
   * Idempotent on purpose: it is called before *every* write, and the second
   * write of a turn must not stash away the first one's work.
   */
  async ensure(label = "hasa-agent"): Promise<Checkpoint | null> {
    if (this.taken !== null) return this.taken;
    if (this.repo === null && !(await this.available())) {
      this.log.warn("workspace is not a git repository; no checkpoint will be taken");
      return null;
    }
    const repo = this.repo;
    if (repo === null) return null;

    try {
      const baseCommit = await repo.headSha();
      const takenAt = new Date(this.now()).toISOString();
      // `snapshot` returns null for an already-clean tree — there is nothing to
      // restore, and the base commit alone is enough to describe the state.
      const ref = await repo.snapshot(`${label} ${takenAt}`);
      this.taken = {
        ref,
        baseCommit,
        takenAt,
        detail:
          ref === null
            ? "작업 시작 시점의 상태를 기록했습니다. (변경사항 없음)"
            : "작업 전 변경사항을 보관했습니다. 되돌리기를 누르면 복원됩니다.",
      };
      this.log.info("checkpoint taken", { ref, baseCommit });
      return this.taken;
    } catch (err) {
      // A checkpoint that cannot be taken must not silently become "no undo".
      // The caller decides whether to proceed; it may not decide blindly.
      throw new CheckpointFailed(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Restores the workspace to the checkpoint.
   *
   * `git stash pop` rather than `apply`: leaving the entry behind would make a
   * second revert restore the same state twice and leave a growing stash list
   * that looks like the user's own work.
   */
  async revert(): Promise<boolean> {
    const checkpoint = this.taken;
    const repo = this.repo;
    if (checkpoint === null || repo === null) return false;
    if (checkpoint.ref === null) {
      // Nothing was stashed, so anything present now is this turn's work.
      await repo.discardTo(checkpoint.baseCommit);
      this.taken = null;
      return true;
    }
    await repo.restore(checkpoint.ref, checkpoint.baseCommit);
    this.taken = null;
    return true;
  }

  /** Forgets the checkpoint without touching the tree. Ends the turn. */
  release(): void {
    this.taken = null;
  }

  /**
   * Files that differ from HEAD right now.
   *
   * `changedPaths` rather than `changedFiles`: the latter stages intent-to-add
   * first, which is fine in a throwaway worktree and an unasked-for change to
   * the index of a repository the user is sitting in.
   */
  async changedFiles(): Promise<string[]> {
    const repo = this.repo;
    if (repo === null) return [];
    try {
      return await repo.changedPaths();
    } catch (err) {
      if (err instanceof GitError) return [];
      throw err;
    }
  }
}

export class CheckpointFailed extends Error {
  constructor(detail: string) {
    super(`could not protect the workspace: ${detail}`);
    this.name = "CheckpointFailed";
  }
}
