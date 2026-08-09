import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";

/**
 * Which workspace this is.
 *
 * Written after the conversation graph, and because of it. Once conversations
 * have branches and checkpoints, attaching the wrong ones to a folder is not a
 * cosmetic error — it is the user reading someone else's history, or their own
 * from a different project, with the model's context to match.
 *
 * The rule the whole file is shaped by:
 *
 *   The same workspace is reliably the same workspace, and two different
 *   workspaces are never the same one.
 *
 * ## What identity is made of, and what it is not
 *
 * It is the *location* of the work: canonical root paths, and nothing else.
 *
 * It is **not** the credential. Conversations used to be filed under
 * `fingerprint(apiKey)`, which meant rotating a key silently emptied the
 * history — the user's own past work, gone because they changed an
 * authentication detail. A key says who is calling; it says nothing about which
 * project this is.
 *
 * It is **not** the provider or the model. Those are choices made inside a
 * conversation and recorded there.
 *
 * It is **not** the git root. A workspace need not be a repository at all, and
 * one that is may contain several — `/project` opened with a repo at
 * `/project/packages/foo` is one workspace, not two. Git is a tool used inside
 * the workspace, not a name for it.
 *
 * ## Path identity, and its limits
 *
 * Identity is derived from paths, which is a deliberate simplification with a
 * consequence worth stating plainly: **moving a project changes its identity.**
 * `C:\work\foo` and `D:\projects\foo` are different workspaces here, and the
 * conversations from the first do not follow to the second.
 *
 * The alternative — identifying a project by its contents — means deciding what
 * counts as the same project across edits, which is a hard problem with its own
 * wrong answers. A path is something a user can see and reason about, and when
 * it is wrong they can tell immediately.
 */

/** How many hex characters of the digest are kept. */
const ID_LENGTH = 16;

export interface WorkspaceRoot {
  /** The path as the editor reported it, for showing to a person. */
  path: string;
  /** Resolved, case-folded where the platform folds. The identity input. */
  canonical: string;
}

export interface WorkspaceIdentity {
  /** Stable, opaque, safe as a directory name. */
  id: string;
  /** Every root, in canonical order. */
  roots: WorkspaceRoot[];
  /**
   * The `.code-workspace` file, when the workspace came from one.
   *
   * Recorded but not used as the identity. Two users can open the same
   * `.code-workspace` from different checkout locations, and a file the user
   * moves would change identity for a reason they did not act on. The folders
   * are what the work is in.
   */
  configPath?: string;
}

/**
 * Whether this platform treats `A:\Foo` and `a:\foo` as the same place.
 *
 * Asked of the platform rather than of the path. Case folding on Linux would
 * merge two directories that genuinely differ, and not folding on Windows would
 * split one that does not.
 */
export function foldsCase(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" || platform === "darwin";
}

/**
 * One path, reduced to the form two spellings of it share.
 *
 * Handles what actually differs between two spellings of the same folder: a
 * trailing separator, `\` against `/`, a relative segment, a lower-case drive
 * letter. `realpath` is what resolves a symlink, and it is attempted first —
 * the same basis `Sandbox` uses for its boundary, so a path that is inside the
 * workspace for one is inside it for the other.
 *
 * A path that cannot be resolved — a root that was deleted, a drive that is not
 * mounted — still gets an identity, from the lexical form. Refusing would mean
 * a user who unplugs an external disk cannot open the conversation that
 * describes what is on it.
 */
export async function canonicalizeRoot(
  path: string,
  opts: { realpath?: (p: string) => Promise<string>; platform?: NodeJS.Platform } = {},
): Promise<WorkspaceRoot> {
  const resolvePath = opts.realpath ?? realpath;
  const platform = opts.platform ?? process.platform;

  let resolved: string;
  try {
    resolved = await resolvePath(path);
  } catch {
    resolved = path;
  }
  return { path, canonical: canonicalizeSync(resolved, platform) };
}

/**
 * The lexical half, separated so it can be tested without a filesystem.
 *
 * `resolve` does the work — it absolutises, collapses `.` and `..`, and
 * normalises separators to the platform's. What is added is dropping a trailing
 * separator (except on a bare root, where it is part of the path) and folding
 * case where the platform does.
 */
export function canonicalizeSync(path: string, platform: NodeJS.Platform = process.platform): string {
  // The platform's own rules, chosen explicitly rather than inherited from
  // whatever host this happens to run on. `node:path`'s default binding treats
  // `/projects/foo` as `C:\projects\foo` on Windows, which would make the same
  // stored path canonicalize differently depending on where it was read.
  const rules = platform === "win32" ? win32 : posix;
  const separator = rules.sep;

  let out = rules.resolve(path);
  // `resolve` leaves `C:\` and `/` as they are, and those are the one place a
  // trailing separator carries meaning.
  while (out.length > 1 && out.endsWith(separator) && !out.endsWith(`:${separator}`)) {
    out = out.slice(0, -1);
  }
  return foldsCase(platform) ? out.toLowerCase() : out;
}

/**
 * The identity of a set of roots.
 *
 * Sorted before digesting, so reordering the folders in a multi-root workspace
 * does not produce a different workspace. The user dragging one above another
 * in the sidebar is a change of view, not of project — and a history that
 * vanished when they did it would be indistinguishable from a bug.
 *
 * Duplicates collapse for the same reason: the same folder added twice is one
 * folder.
 *
 * Empty is a real answer, not an error. A window with no folder open is a
 * workspace the agent cannot work in, and saying so with an identity of its own
 * is better than throwing at the call site.
 */
export function identityOf(
  roots: readonly WorkspaceRoot[],
  configPath?: string,
): WorkspaceIdentity {
  const unique = [...new Map(roots.map((r) => [r.canonical, r])).values()].sort((a, b) =>
    a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0,
  );

  // The separator cannot occur in a path on any platform this runs on, so two
  // different root sets cannot digest the same string by concatenation.
  const material = unique.map((r) => r.canonical).join("\u0000");
  const digest = createHash("sha256").update(material).digest("hex").slice(0, ID_LENGTH);

  return {
    // Prefixed so it is distinguishable on sight from the key fingerprints the
    // old storage layout used — see `conversationStore.ts`, which has to tell
    // the two apart in the same directory.
    id: unique.length === 0 ? EMPTY_WORKSPACE_ID : `ws${digest}`,
    roots: unique,
    ...(configPath === undefined ? {} : { configPath }),
  };
}

/** A window with no folder open. Named so callers can test for it. */
export const EMPTY_WORKSPACE_ID = "ws-none";

/** Resolves and identifies in one step. */
export async function workspaceIdentityOf(
  paths: readonly string[],
  opts: { realpath?: (p: string) => Promise<string>; platform?: NodeJS.Platform; configPath?: string } = {},
): Promise<WorkspaceIdentity> {
  const roots = await Promise.all(paths.map((p) => canonicalizeRoot(p, opts)));
  return identityOf(roots, opts.configPath);
}

/** Ids are used as directory names, so they are checked before they are trusted. */
export function isValidWorkspaceId(id: string): boolean {
  return /^ws[a-z0-9-]{1,62}$/.test(id);
}
