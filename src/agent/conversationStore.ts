import type { ProviderMessage } from "../provider/types.ts";
import { isValidWorkspaceId } from "./workspaceIdentity.ts";
import {
  SESSION_SCHEMA_VERSION,
  type PersistedWorkspace,
  type SessionEvent,
} from "./sessionEvents.ts";
import { readSession, writeSession } from "./sessionLog.ts";
import {
  MAIN_BRANCH_ID,
  createCheckpoint,
  forkBranch,
  newBranch,
  removeBranch,
  type ConversationBranch,
  type ConversationCheckpoint,
  type ConversationTurn,
} from "./conversationGraph.ts";

/**
 * Conversations, remembered between sessions and kept apart per workspace.
 *
 * **They used to be kept apart per key**, filed under `fingerprint(apiKey)`,
 * and that was wrong in a way that only became visible once conversations had
 * branches worth keeping. A credential says who is calling. It says nothing
 * about which project this is, and a user who rotated a key watched their own
 * history disappear — every conversation still on disk, under a directory
 * nothing would look in again.
 *
 * So the scope is the workspace: same folder, same conversations, whatever key
 * is in use. See `workspaceIdentity.ts` for what that means and what it costs.
 *
 * **The key is still never written down**, and now it is not passed here at
 * all. §9 of the brief: the API key lives in `SecretStorage` and nowhere else.
 * The strongest form of that is a module with no parameter to put it in.
 *
 * Legacy directories are still readable — see `LEGACY_SCOPE` — but a
 * conversation written before workspaces existed records no workspace, and
 * attaching it to whichever folder happens to be open would be exactly the
 * silent mis-binding this file now exists to prevent. They are listed, marked,
 * and attached only when the user opens one.
 *
 * Storage is a directory of one file per conversation rather than a single
 * index. A corrupt file then costs one conversation instead of all of them,
 * which is the failure mode that actually happens — a machine losing power
 * mid-write.
 */

export interface StoredConversation {
  id: string;
  /** First line of the first user message, for the list. */
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ProviderMessage[];
  /**
   * What the user saw, as opposed to what the model was told.
   *
   * Added in v2. `messages` is the model's conversation and stays exactly as it
   * was — it is what the next turn is built from, and rebuilding it out of
   * events would feed the model a different conversation than it had. The
   * events are the other half: the plan, the reasoning summaries, the tool
   * steps as a person saw them, the files that changed and why the run stopped.
   * None of those fit in a `ProviderMessage`, which is why reopening a
   * conversation used to lose all of them.
   *
   * From v3 this is a projection of `turns` rather than a stored array, so it
   * cannot drift from the messages beside it.
   */
  events?: SessionEvent[];

  /** The graph the two arrays above are projected from. Absent only pre-v3. */
  turns?: ConversationTurn[];
  branches?: ConversationBranch[];
  checkpoints?: ConversationCheckpoint[];
  activeBranchId?: string;
  /** Which workspace this was had in. Absent for pre-workspace conversations. */
  workspace?: PersistedWorkspace;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

/** The filesystem, injected so the policy is testable without one. */
export interface ConversationStorePort {
  listFiles(dir: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  /** Must be atomic: write elsewhere, then rename into place. */
  writeFile(path: string, contents: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface ConversationStoreOptions {
  port: ConversationStorePort;
  /** Extension storage root. Never the workspace — this is per-machine state. */
  home: string;
  /**
   * Which workspace these conversations belong to.
   *
   * There is deliberately no `apiKey` beside it. A credential cannot reach this
   * module, so it cannot end up in a path, a filename or a log line from here.
   */
  workspaceId: string;
  /** Oldest conversations beyond this are dropped. */
  maxConversations?: number;
}

const DEFAULT_MAX = 100;
const TITLE_LENGTH = 60;

/**
 * Where a workspace's conversations live.
 *
 * Checked rather than trusted: the id becomes a path segment, and an id that
 * arrived from somewhere unexpected must not be able to name a directory
 * elsewhere.
 */
export function scopeFor(workspaceId: string): string {
  if (!isValidWorkspaceId(workspaceId)) {
    throw new Error(`refusing to scope conversations by ${JSON.stringify(workspaceId)}`);
  }
  return workspaceId;
}

/**
 * Directories written before conversations knew about workspaces.
 *
 * The old layout filed them under a key fingerprint — `sha256` followed by
 * twelve hex characters. Workspace ids start with `ws`, so the two are
 * distinguishable on sight and a reader can tell which era a directory is from
 * without a manifest.
 */
export const LEGACY_SCOPE = /^sha256[0-9a-f]{6,}$/i;

/** A title from the first thing the user said. */
export function titleFrom(messages: readonly ProviderMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  if (first === undefined) return "새 대화";
  const text =
    typeof first.content === "string"
      ? first.content
      : first.content
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join(" ");

  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (line.length === 0) return "새 대화";
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH)}…` : line;
}

/** Ids are ours, so they are checked rather than trusted as path segments. */
function isValidId(id: string): boolean {
  return /^[a-z0-9-]{1,64}$/.test(id);
}

export function newConversationId(now: number, random: () => number): string {
  const suffix = Math.floor(random() * 0xffffff).toString(36).padStart(4, "0");
  return `${now.toString(36)}-${suffix}`;
}

/**
 * Reads a conversation of either generation.
 *
 * The version check and the v1 migration live in `sessionLog.ts`, so this class
 * stays about files and directories and that one stays about formats. A v1 file
 * — the ones already on disk — comes back with events derived from its
 * messages: its text and its tool calls, and honestly nothing else, because
 * nothing else was ever written down.
 */
function parse(raw: string): StoredConversation | null {
  const loaded = readSession(raw);
  if (loaded === null || !isValidId(loaded.session.id)) return null;
  const { session } = loaded;
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: session.messages as ProviderMessage[],
    events: session.events,
    ...(session.workspace === undefined ? {} : { workspace: session.workspace }),
    turns: session.turns,
    branches: session.branches,
    checkpoints: session.checkpoints,
    activeBranchId: session.activeBranchId,
  };
}

/** What a conversation is created with. `createdAt` is set here and only here. */
export interface NewConversation {
  id: string;
  title: string;
  createdAt: number;
  turn: Omit<ConversationTurn, "parentTurnId">;
  /** The folder this conversation resolves relative paths against. */
  boundRoot?: string;
}

/** What may change after creation. `createdAt` is deliberately not in it. */
export interface ConversationPatch {
  title?: string;
  updatedAt?: number;
  /** The folder this conversation's relative paths are resolved against. */
  boundRoot?: string;
  activeBranchId?: string;
  checkpoints?: ConversationCheckpoint[];
  branches?: ConversationBranch[];
}

export class ConversationStore {
  private readonly port: ConversationStorePort;
  private readonly home: string;
  private readonly workspaceId: string;
  private readonly dir: string;
  private readonly max: number;
  /** The tail of each conversation's write queue. See `serialize`. */
  private readonly writing = new Map<string, Promise<void>>();

  constructor(opts: ConversationStoreOptions) {
    this.port = opts.port;
    this.home = opts.home;
    this.workspaceId = opts.workspaceId;
    this.dir = `${opts.home}/conversations/${scopeFor(opts.workspaceId)}`;
    this.max = opts.maxConversations ?? DEFAULT_MAX;
  }

  /** Where this workspace's conversations live. Exposed for tests, not callers. */
  get directory(): string {
    return this.dir;
  }

  /**
   * Conversations for this key, newest first.
   *
   * A file that will not parse is skipped rather than thrown. The alternative
   * is a panel that shows nothing because one write was interrupted.
   */
  async list(): Promise<ConversationSummary[]> {
    const files = await this.port.listFiles(this.dir).catch(() => []);
    const out: ConversationSummary[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const conversation = await this.readOne(file);
      if (conversation === null) continue;
      // The same refusal `load` applies. Without it a conversation belonging to
      // another workspace appeared in the list and then failed to open — worse
      // than either being visible or being absent, because it looks like a bug
      // in opening rather than a file that does not belong here.
      if (conversation.workspace !== undefined && conversation.workspace.id !== this.workspaceId) continue;
      out.push({
        id: conversation.id,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
        // System messages are ours, not the conversation's, so they are not
        // counted — a fresh chat should read as empty, not as one message.
        messageCount: conversation.messages.filter((m) => m.role !== "system").length,
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Reads one conversation, and refuses one that belongs somewhere else.
   *
   * The directory already scopes by workspace, so a mismatch here means the file
   * arrived by another route — restored from a backup, copied between machines,
   * moved by hand. Showing it would put one project's history under another's
   * name, with the model's context to match, and that is worse than not showing
   * it. A conversation with no recorded workspace is from before workspaces
   * existed and is not refused; see `listLegacy`.
   */
  async load(id: string): Promise<StoredConversation | null> {
    if (!isValidId(id)) return null;
    const found = await this.readOne(`${id}.json`);
    if (found === null) return null;
    if (found.workspace !== undefined && found.workspace.id !== this.workspaceId) return null;
    return found;
  }

  /**
   * Conversations written before conversations knew about workspaces.
   *
   * Listed rather than adopted. They record no workspace, so attaching them to
   * whichever folder happens to be open is a guess presented as a fact — and the
   * one this whole file exists to prevent. They are offered, and opening one is
   * the explicit act that binds it.
   */
  async listLegacy(): Promise<Array<ConversationSummary & { scope: string }>> {
    const scopes = await this.port.listFiles(`${this.home}/conversations`).catch(() => []);
    const out: Array<ConversationSummary & { scope: string }> = [];
    for (const scope of scopes) {
      if (!LEGACY_SCOPE.test(scope)) continue;
      const files = await this.port.listFiles(`${this.home}/conversations/${scope}`).catch(() => []);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const conversation = await this.readAt(`${this.home}/conversations/${scope}/${file}`);
        if (conversation === null) continue;
        out.push({
          id: conversation.id,
          title: conversation.title,
          updatedAt: conversation.updatedAt,
          messageCount: conversation.messages.filter((m) => m.role !== "system").length,
          scope,
        });
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Adopts a legacy conversation into this workspace.
   *
   * The explicit act §14 asks for. The user opened it here, so here is where it
   * belongs; the file is rewritten under this workspace with its workspace
   * recorded, and the legacy copy is left alone rather than deleted — a move
   * that cannot be undone is not one to make on the user's behalf.
   */
  async adoptLegacy(scope: string, id: string): Promise<StoredConversation | null> {
    if (!LEGACY_SCOPE.test(scope) || !isValidId(id)) return null;
    const legacy = await this.readAt(`${this.home}/conversations/${scope}/${id}.json`);
    if (legacy === null) return null;
    if ((await this.readOne(`${id}.json`)) !== null) return this.load(id);

    await this.serialize(id, () => this.write({ ...legacy, workspace: { id: this.workspaceId } }));
    return this.load(id);
  }

  /**
   * Writes a conversation, and drops the oldest beyond the cap.
   *
   * `createdAt` is honoured only when the file does not yet exist. A caller
   * passing `Date.now()` on every save — which is exactly what the host did, and
   * why every conversation claimed to have been started seconds ago — cannot
   * move the date of one that is already there.
   *
   * Prefer `createConversation` / `appendTurn` / `updateConversation`: they say
   * which of the three things is happening, and none of them takes a `createdAt`
   * for a conversation that has one. This stays for callers that hold a whole
   * conversation and simply want it written.
   *
   * The system message is stripped before storing: it is re-seeded from the
   * current mode on every turn, so keeping it would restore a stale prompt into
   * a session whose mode had since changed.
   */
  async save(conversation: StoredConversation): Promise<void> {
    if (!isValidId(conversation.id)) throw new Error(`refusing to write id ${JSON.stringify(conversation.id)}`);
    const messages = conversation.messages.filter((m) => m.role !== "system");
    if (messages.length === 0) return;

    return this.serialize(conversation.id, async () => {
      const existing = await this.load(conversation.id);
      await this.write({
        ...conversation,
        messages,
        createdAt: existing?.createdAt ?? conversation.createdAt,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Branches and checkpoints
  //
  // Every one of these changes the conversation and nothing else. None of them
  // touches the working tree: no `git checkout`, no `reset`, no `restore`, and
  // nothing automatic. Switching between two lines of a conversation changes
  // what the model has read; the files on disk are the user's, and there is no
  // undo for taking them away.
  // -------------------------------------------------------------------------

  /** Forks a new branch at a turn. Fails rather than guessing at a bad request. */
  async createBranch(
    id: string,
    input: { branchId: string; name: string; fromTurnId: string; at: number; activate?: boolean },
  ): Promise<{ ok: true; branch: ConversationBranch } | { ok: false; reason: string }> {
    if (!isValidId(id)) return { ok: false, reason: "없는 대화입니다." };
    return this.serialize(id, async () => {
      const existing = await this.load(id);
      if (existing === null) return { ok: false as const, reason: "없는 대화입니다." };

      const branches = existing.branches ?? [];
      const result = forkBranch(existing.turns ?? [], branches, {
        id: input.branchId,
        name: input.name,
        fromTurnId: input.fromTurnId,
        at: input.at,
      });
      if (!result.ok) return result;

      await this.write({
        ...existing,
        updatedAt: input.at,
        branches: [...branches, result.branch],
        ...(input.activate === false ? {} : { activeBranchId: result.branch.id }),
      });
      return result;
    });
  }

  /** Moves the conversation onto another branch. The transcript changes; files do not. */
  async switchBranch(id: string, branchId: string, at: number): Promise<boolean> {
    if (!isValidId(id)) return false;
    return this.serialize(id, async () => {
      const existing = await this.load(id);
      if (existing === null) return false;
      if (!(existing.branches ?? []).some((b) => b.id === branchId)) return false;
      await this.write({ ...existing, updatedAt: at, activeBranchId: branchId });
      return true;
    });
  }

  /**
   * Removes a branch.
   *
   * Its turns stay. They are still things that happened, this graph is tens of
   * turns rather than millions, and a user who deletes a branch by mistake has
   * lost only a name.
   */
  async deleteBranch(id: string, branchId: string, at: number): Promise<{ ok: boolean; reason?: string }> {
    if (!isValidId(id)) return { ok: false, reason: "없는 대화입니다." };
    return this.serialize(id, async () => {
      const existing = await this.load(id);
      if (existing === null) return { ok: false, reason: "없는 대화입니다." };

      const result = removeBranch(existing.branches ?? [], branchId);
      if (!result.ok) return { ok: false, reason: result.reason };

      const active = existing.activeBranchId === branchId ? MAIN_BRANCH_ID : existing.activeBranchId;
      await this.write({
        ...existing,
        updatedAt: at,
        branches: result.branches,
        // Standing on a branch that was just removed is not a place to be.
        activeBranchId: active ?? MAIN_BRANCH_ID,
      });
      return { ok: true };
    });
  }

  /** Bookmarks a turn. A note about the workspace, never a handle on it. */
  async addCheckpoint(
    id: string,
    input: {
      checkpointId: string;
      turnId: string;
      branchId: string;
      message: string;
      at: number;
      metadata?: ConversationCheckpoint["metadata"];
    },
  ): Promise<{ ok: true; checkpoint: ConversationCheckpoint } | { ok: false; reason: string }> {
    if (!isValidId(id)) return { ok: false, reason: "없는 대화입니다." };
    return this.serialize(id, async () => {
      const existing = await this.load(id);
      if (existing === null) return { ok: false as const, reason: "없는 대화입니다." };

      const checkpoints = existing.checkpoints ?? [];
      if (checkpoints.some((c) => c.id === input.checkpointId)) {
        return { ok: false as const, reason: "이미 있는 저장 지점입니다." };
      }

      const result = createCheckpoint(existing.turns ?? [], {
        id: input.checkpointId,
        turnId: input.turnId,
        branchId: input.branchId,
        message: input.message,
        at: input.at,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      });
      if (!result.ok) return result;

      await this.write({ ...existing, updatedAt: input.at, checkpoints: [...checkpoints, result.checkpoint] });
      return result;
    });
  }

  async deleteCheckpoint(id: string, checkpointId: string, at: number): Promise<boolean> {
    if (!isValidId(id)) return false;
    return this.serialize(id, async () => {
      const existing = await this.load(id);
      if (existing === null) return false;
      const checkpoints = (existing.checkpoints ?? []).filter((c) => c.id !== checkpointId);
      if (checkpoints.length === (existing.checkpoints ?? []).length) return false;
      await this.write({ ...existing, updatedAt: at, checkpoints });
      return true;
    });
  }

  /**
   * Starts a conversation.
   *
   * Refuses to touch one that exists: creating twice is a bug in the caller, and
   * silently overwriting is how the first turn's date and events get lost.
   */
  async createConversation(input: NewConversation): Promise<void> {
    if (!isValidId(input.id)) throw new Error(`refusing to write id ${JSON.stringify(input.id)}`);
    return this.serialize(input.id, () => this.createUnserialized(input));
  }

  /** The create itself. Called from inside the queue, so it does not re-enter it. */
  private async createUnserialized(input: NewConversation): Promise<void> {
    if ((await this.load(input.id)) !== null) {
      throw new Error(`conversation ${input.id} already exists`);
    }
    const turn: ConversationTurn = { ...input.turn, parentTurnId: null };
    await this.write({
      id: input.id,
      title: input.title,
      createdAt: input.createdAt,
      updatedAt: turn.completedAt ?? turn.createdAt,
      messages: [],
      turns: [turn],
      branches: [newBranch(MAIN_BRANCH_ID, "main", turn.id, input.createdAt)],
      checkpoints: [],
      activeBranchId: MAIN_BRANCH_ID,
      workspace: {
        id: this.workspaceId,
        ...(input.boundRoot === undefined ? {} : { boundRoot: input.boundRoot }),
      },
    });
  }

  /**
   * Adds a turn to the end of the active branch.
   *
   * The parent is taken from the branch head here rather than from the caller.
   * The store is the one place that knows where the branch actually is, so a
   * host that lost track of it — reopened a conversation, restarted — cannot
   * write a turn whose parent is wrong, and a wrong parent is a restore into a
   * history that never happened.
   *
   * Creates the conversation when it is not there yet, so a first turn needs no
   * separate call and `createdAt` is still set exactly once.
   */
  async appendTurn(
    id: string,
    turn: Omit<ConversationTurn, "parentTurnId">,
    patch: ConversationPatch = {},
  ): Promise<void> {
    if (!isValidId(id)) throw new Error(`refusing to write id ${JSON.stringify(id)}`);
    // Serialised per conversation. A turn finishing while the user creates a
    // branch is two read-modify-writes over one file, and interleaved they lose
    // whichever finished first.
    return this.serialize(id, async () => {
      const existing = await this.load(id);
      if (existing === null) {
        await this.createUnserialized({
          id,
          title: patch.title ?? "새 대화",
          createdAt: turn.createdAt,
          turn,
          // Carried through the create path too. The first turn is the one that
          // settles the binding, and it is the one that went through here.
          ...(patch.boundRoot === undefined ? {} : { boundRoot: patch.boundRoot }),
        });
        return;
      }
      await this.appendOnto(existing, turn, patch);
    });
  }

  /**
   * One writer at a time, per conversation.
   *
   * Every write here is read-modify-write over a whole file, so two of them
   * overlapping means the later read misses the earlier write and then
   * overwrites it. Within a window that is the real case — a turn being
   * persisted while the user creates a branch — and a queue removes it
   * completely.
   *
   * Two VS Code windows are two processes and a queue cannot reach across them.
   * `write` re-reads immediately before writing and retries when the file moved
   * under it, which does not close that window but shrinks it from the length of
   * a turn to the length of a write. Honest about it rather than silent: a lock
   * file would close it and would also survive a crash, leaving a conversation
   * permanently unwritable, which is the worse failure.
   */
  private serialize<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.writing.get(id) ?? Promise.resolve();
    // `catch` first: one failed write must not wedge every later one behind a
    // rejected promise.
    const result = previous.catch(() => {}).then(work);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.writing.set(id, tail);
    void tail.then(() => {
      // Only when nothing queued behind this one, so the map does not grow by
      // one entry for every conversation ever written to.
      if (this.writing.get(id) === tail) this.writing.delete(id);
    });
    return result;
  }

  /**
   * The append itself, against a conversation already read.
   *
   * Separated so the concurrency retry can re-run it against a freshly read
   * conversation without repeating the create-if-absent decision.
   */
  private async appendOnto(
    existing: StoredConversation,
    turn: Omit<ConversationTurn, "parentTurnId">,
    patch: ConversationPatch,
  ): Promise<void> {
    const id = existing.id;
    const turns = existing.turns ?? [];
    const branches =
      existing.branches !== undefined && existing.branches.length > 0
        ? existing.branches
        : [newBranch(MAIN_BRANCH_ID, "main", turns.at(-1)?.id ?? null, existing.createdAt)];
    const activeId = existing.activeBranchId ?? MAIN_BRANCH_ID;
    const active = branches.find((b) => b.id === activeId) ?? branches[0]!;

    // Re-appending the same id replaces it rather than duplicating: a turn
    // written twice — a retried save, a crash between write and rename — should
    // leave one turn, and its parent should not shift under it.
    const previous = turns.find((t) => t.id === turn.id);
    const parentTurnId = previous?.parentTurnId ?? active.headTurnId;
    const complete: ConversationTurn = { ...turn, parentTurnId };
    const nextTurns = previous === undefined ? [...turns, complete] : turns.map((t) => (t.id === turn.id ? complete : t));

    const at = turn.completedAt ?? turn.createdAt;
    await this.write({
      id,
      title: patch.title ?? existing.title,
      // Read from disk, not from the caller. There is no argument to this method
      // that can move it.
      createdAt: existing.createdAt,
      updatedAt: patch.updatedAt ?? at,
      messages: [],
      turns: nextTurns,
      branches: branches.map((b) => (b.id === active.id ? { ...b, headTurnId: complete.id, updatedAt: at } : b)),
      checkpoints: patch.checkpoints ?? existing.checkpoints ?? [],
      activeBranchId: active.id,
      workspace: {
        id: this.workspaceId,
        ...(patch.boundRoot === undefined
          ? existing.workspace?.boundRoot === undefined
            ? {}
            : { boundRoot: existing.workspace.boundRoot }
          : { boundRoot: patch.boundRoot }),
      },
    });
  }

  /** Changes what is not the conversation itself — its title, its branches. */
  async updateConversation(id: string, patch: ConversationPatch): Promise<void> {
    if (!isValidId(id)) return;
    return this.serialize(id, async () => {
      const existing = await this.load(id);
      if (existing === null) return;
      await this.write({
        ...existing,
        title: patch.title ?? existing.title,
        createdAt: existing.createdAt,
        updatedAt: patch.updatedAt ?? existing.updatedAt,
        ...(patch.branches === undefined ? {} : { branches: patch.branches }),
        ...(patch.checkpoints === undefined ? {} : { checkpoints: patch.checkpoints }),
        ...(patch.activeBranchId === undefined ? {} : { activeBranchId: patch.activeBranchId }),
      });
    });
  }

  /** The single place a conversation file is written. */
  private async write(conversation: StoredConversation): Promise<void> {
    await this.port.writeFile(
      `${this.dir}/${conversation.id}.json`,
      writeSession({
        version: SESSION_SCHEMA_VERSION,
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        events: conversation.events ?? [],
        messages: conversation.messages,
        ...(conversation.turns === undefined ? {} : { turns: conversation.turns }),
        ...(conversation.branches === undefined ? {} : { branches: conversation.branches }),
        ...(conversation.checkpoints === undefined ? {} : { checkpoints: conversation.checkpoints }),
        ...(conversation.activeBranchId === undefined ? {} : { activeBranchId: conversation.activeBranchId }),
        // Stamped on every write rather than only at creation, so a conversation
        // that predates the field gains one the next time it is touched.
        workspace: conversation.workspace ?? { id: this.workspaceId },
      }),
    );
    await this.prune();
  }

  async remove(id: string): Promise<void> {
    if (!isValidId(id)) return;
    await this.port.remove(`${this.dir}/${id}.json`).catch(() => {});
  }

  private async readOne(file: string): Promise<StoredConversation | null> {
    return this.readAt(`${this.dir}/${file}`);
  }

  private async readAt(path: string): Promise<StoredConversation | null> {
    try {
      return parse(await this.port.readFile(path));
    } catch {
      return null;
    }
  }

  private async prune(): Promise<void> {
    const summaries = await this.list();
    for (const stale of summaries.slice(this.max)) await this.remove(stale.id);
  }
}
