import type { ProviderMessage } from "../provider/types.ts";
import { fingerprint } from "../hasa-client/redact.ts";
import { SESSION_SCHEMA_VERSION, type SessionEvent } from "./sessionEvents.ts";
import { readSession, writeSession } from "./sessionLog.ts";

/**
 * Conversations, remembered between sessions and kept apart per key.
 *
 * Two constraints shape this and neither is negotiable.
 *
 * **The key is never written down.** §9 of the brief: the API key lives in
 * `SecretStorage` and nowhere else — not in settings, not in workspace state,
 * not in a file, not in a log. So conversations cannot be filed under the key.
 * They are filed under `fingerprint(key)`, a truncated SHA-256 that cannot be
 * turned back into the key, and the key itself never reaches this module.
 *
 * **It scopes a key, not an account.** The honest limitation: the gateway
 * exposes no account identity to an API key — `/v1/me/entitlements` refuses one
 * and charges a strike for asking — so two keys belonging to the same person
 * get separate histories, and rotating a key starts a fresh one. Calling this
 * per-account would be a claim the code cannot keep.
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
   */
  events?: SessionEvent[];
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
  /** The API key. Digested immediately; never stored and never returned. */
  apiKey: string;
  /** Oldest conversations beyond this are dropped. */
  maxConversations?: number;
}

const DEFAULT_MAX = 100;
const TITLE_LENGTH = 60;

/** A stable, irreversible directory name for this key. */
export function scopeFor(apiKey: string): string {
  // `fingerprint` returns `sha256:<12 hex>`; the colon is not a path character
  // on Windows, so it is dropped rather than escaped.
  return fingerprint(apiKey).replace(/[^a-z0-9]/gi, "");
}

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
  };
}

export class ConversationStore {
  private readonly port: ConversationStorePort;
  private readonly dir: string;
  private readonly max: number;

  constructor(opts: ConversationStoreOptions) {
    this.port = opts.port;
    // The digest is taken here and the key is not kept. Nothing else in this
    // class can leak what it never held.
    this.dir = `${opts.home}/conversations/${scopeFor(opts.apiKey)}`;
    this.max = opts.maxConversations ?? DEFAULT_MAX;
  }

  /** Where this key's conversations live. Exposed for tests, not for callers. */
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

  async load(id: string): Promise<StoredConversation | null> {
    if (!isValidId(id)) return null;
    return this.readOne(`${id}.json`);
  }

  /**
   * Writes a conversation, and drops the oldest beyond the cap.
   *
   * The system message is stripped before storing: it is re-seeded from the
   * current mode on every turn, so keeping it would restore a stale prompt into
   * a session whose mode had since changed.
   */
  async save(conversation: StoredConversation): Promise<void> {
    if (!isValidId(conversation.id)) throw new Error(`refusing to write id ${JSON.stringify(conversation.id)}`);
    const messages = conversation.messages.filter((m) => m.role !== "system");
    if (messages.length === 0) return;

    await this.port.writeFile(
      `${this.dir}/${conversation.id}.json`,
      writeSession({
        version: SESSION_SCHEMA_VERSION,
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        events: conversation.events ?? [],
        messages,
      }),
    );
    await this.prune();
  }

  async remove(id: string): Promise<void> {
    if (!isValidId(id)) return;
    await this.port.remove(`${this.dir}/${id}.json`).catch(() => {});
  }

  private async readOne(file: string): Promise<StoredConversation | null> {
    try {
      return parse(await this.port.readFile(`${this.dir}/${file}`));
    } catch {
      return null;
    }
  }

  private async prune(): Promise<void> {
    const summaries = await this.list();
    for (const stale of summaries.slice(this.max)) await this.remove(stale.id);
  }
}
