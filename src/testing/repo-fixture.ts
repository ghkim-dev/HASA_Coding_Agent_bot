import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Throwaway git repository for tests.
 *
 * Real git rather than a fake: the whole point of Phase 2 is that worktree
 * isolation actually holds, and a stub would happily "isolate" nothing.
 */
export interface RepoFixture {
  root: string;
  headSha(): Promise<string>;
  write(path: string, contents: string): Promise<void>;
  read(path: string): Promise<string>;
  commit(message: string): Promise<string>;
  status(): Promise<string[]>;
  /** Raw git, for a test that needs to act as the user rather than the agent. */
  git(args: string[]): Promise<string>;
  dispose(): Promise<void>;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    shell: false,
    windowsHide: true,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      USERPROFILE: process.env["USERPROFILE"] ?? "",
      SYSTEMROOT: process.env["SYSTEMROOT"] ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Arena Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Arena Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      LC_ALL: "C",
    },
  });
  return stdout;
}

export async function createRepoFixture(
  files: Record<string, string> = { "README.md": "# fixture\n" },
): Promise<RepoFixture> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "arena-repo-")));
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.invalid"]);
  await git(dir, ["config", "user.name", "Arena Test"]);
  // Without this the machine's global core.autocrlf decides line endings, and
  // `git apply` rewrites LF to CRLF on Windows — making assertions about file
  // contents pass or fail depending on whose laptop runs the suite.
  await git(dir, ["config", "core.autocrlf", "false"]);
  await git(dir, ["config", "core.eol", "lf"]);
  // Keeps the fixture's own artefacts from dirtying the tree mid-run.
  await writeFile(join(dir, ".gitignore"), ".arena/\n", "utf8");

  const fixture: RepoFixture = {
    root: dir,
    headSha: async () => (await git(dir, ["rev-parse", "HEAD"])).trim(),
    write: async (path, contents) => {
      const full = join(dir, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents, "utf8");
    },
    read: async (path) => {
      const { readFile } = await import("node:fs/promises");
      return readFile(join(dir, path), "utf8");
    },
    commit: async (message) => {
      await git(dir, ["add", "-A"]);
      await git(dir, ["commit", "-m", message]);
      return (await git(dir, ["rev-parse", "HEAD"])).trim();
    },
    status: async () =>
      (await git(dir, ["status", "--porcelain"])).split("\n").map((l) => l.trim()).filter(Boolean),
    git: (args) => git(dir, args),
    dispose: async () => {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    },
  };

  for (const [path, contents] of Object.entries(files)) await fixture.write(path, contents);
  await fixture.commit("initial");
  return fixture;
}
