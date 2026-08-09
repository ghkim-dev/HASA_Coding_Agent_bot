import { canonicalizeSync, identityOf, type WorkspaceIdentity, type WorkspaceRoot } from "./workspaceIdentity.ts";

/**
 * Which folder the agent is working in, and how that was decided.
 *
 * A multi-root workspace has no single root, and the code that came before this
 * pretended otherwise: `workspaceFolders?.[0]`, in five places, with nothing
 * saying why the first one. In a one-folder window that is right by accident. In
 * a two-folder window it is a coin toss that the user does not see being
 * flipped, and every file the agent reads, every command it runs and every
 * conversation it files is on the wrong side of it half the time.
 *
 * So the choice is made once, here, and it says which rule it used. When no rule
 * applies the answer is `ambiguous` — not a folder. A caller that gets
 * `ambiguous` has to ask; it must not pick.
 *
 * The identity is separate from the root and does not depend on it. Which folder
 * the agent is working in can change within a session; which workspace this is
 * cannot.
 */

/** Why this root, and not another. Carried so the panel can say. */
export type RootReason =
  /** The conversation was already working here. */
  | "bound"
  /** The file the user is looking at is in it. */
  | "active-editor"
  /** The user picked it. */
  | "chosen"
  /** There is only one. */
  | "only-root";

export interface WorkspaceContext {
  identity: WorkspaceIdentity;
  /** Every folder in the window, canonical order. */
  roots: WorkspaceRoot[];
  /** Where the agent works, once that is settled. */
  activeRoot: WorkspaceRoot | null;
  reason: RootReason | null;
  /**
   * True when there are several roots and nothing chose between them.
   *
   * Distinct from "no folder is open": one of them is answered by opening a
   * folder and the other by picking one, and a caller that cannot tell them
   * apart gives the wrong instruction.
   */
  ambiguous: boolean;
}

export interface ResolveInput {
  /** Folder paths as the editor reports them, in the editor's order. */
  folders: readonly WorkspaceRoot[];
  /** `.code-workspace`, when there is one. Recorded, never the identity. */
  configPath?: string;
  /** The root this conversation has already been working in. */
  boundRoot?: string | null;
  /** The file in the active editor, if any. */
  activeFile?: string | null;
  /** A root the user picked explicitly. Beats everything but a binding. */
  chosenRoot?: string | null;
  platform?: NodeJS.Platform;
}

/**
 * Picks the root, in a stated order of preference.
 *
 * 1. What this conversation was already using. A turn that reads `src/a.ts` and
 *    a later turn in the same conversation that reads `src/a.ts` must get the
 *    same file, whatever the user has clicked on since.
 * 2. What the user explicitly chose.
 * 3. The folder holding the file they are looking at. The best available guess
 *    at "here", and a guess only when nothing above it applied.
 * 4. The only folder, when there is one.
 * 5. Nothing. Several folders and no reason to prefer any — the caller asks.
 *
 * Binding beats the active editor deliberately. The alternative is a
 * conversation whose root moves when the user opens a file to look at it, which
 * would make the same relative path mean different files in one conversation.
 */
export function resolveWorkspaceContext(input: ResolveInput): WorkspaceContext {
  const platform = input.platform ?? process.platform;
  const identity = identityOf(input.folders, input.configPath);
  const roots = identity.roots;

  const empty: WorkspaceContext = {
    identity,
    roots,
    activeRoot: null,
    reason: null,
    ambiguous: false,
  };
  if (roots.length === 0) return empty;

  const find = (path: string | null | undefined): WorkspaceRoot | null => {
    if (path === null || path === undefined || path.length === 0) return null;
    const canonical = canonicalizeSync(path, platform);
    return roots.find((r) => r.canonical === canonical) ?? null;
  };

  const bound = find(input.boundRoot);
  if (bound !== null) return { ...empty, activeRoot: bound, reason: "bound" };

  const chosen = find(input.chosenRoot);
  if (chosen !== null) return { ...empty, activeRoot: chosen, reason: "chosen" };

  const holding = rootContaining(roots, input.activeFile ?? null, platform);
  if (holding !== null) return { ...empty, activeRoot: holding, reason: "active-editor" };

  if (roots.length === 1) return { ...empty, activeRoot: roots[0]!, reason: "only-root" };

  // Several folders and nothing to choose between them. Reported rather than
  // guessed: this is the case the old `workspaceFolders[0]` answered wrongly and
  // silently.
  return { ...empty, ambiguous: true };
}

/**
 * The root a file is inside, or null.
 *
 * The longest match wins, which is what makes nesting work: with roots
 * `/project` and `/project/packages/foo`, a file in the latter belongs to the
 * latter. Shortest-match would put it in `/project` and the user's own nesting
 * would be ignored.
 *
 * The comparison is on canonical paths with a separator appended, so
 * `/project/foobar` is not counted as inside `/project/foo`.
 */
export function rootContaining(
  roots: readonly WorkspaceRoot[],
  file: string | null,
  platform: NodeJS.Platform = process.platform,
): WorkspaceRoot | null {
  if (file === null || file.length === 0) return null;
  const target = canonicalizeSync(file, platform);
  const boundary = platform === "win32" ? "\\" : "/";

  let best: WorkspaceRoot | null = null;
  for (const root of roots) {
    const prefix = root.canonical.endsWith(boundary) ? root.canonical : `${root.canonical}${boundary}`;
    if (target === root.canonical || target.startsWith(prefix)) {
      if (best === null || root.canonical.length > best.canonical.length) best = root;
    }
  }
  return best;
}

/** What to tell the user when nothing could be chosen. */
export function describeAmbiguity(context: WorkspaceContext): string | null {
  if (context.roots.length === 0) return "폴더를 연 다음 다시 시도해 주세요.";
  if (!context.ambiguous) return null;
  const names = context.roots.map((r) => r.path).join(", ");
  return `이 창에는 폴더가 여러 개 있습니다 (${names}). 어느 폴더에서 작업할지 골라 주세요.`;
}
