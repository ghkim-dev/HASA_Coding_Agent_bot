import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Persisted model lists.
 *
 * Two rules govern this file, both borrowed from Zoo Code's `modelCache.ts`
 * after reading it (docs/hasa-coding-agent-architecture.md §4.2, Z-4/Z-5):
 *
 *   1. A cache entry is scoped by base URL *and* by an irreversible digest of
 *      the API key. Two keys on the same gateway see different model sets —
 *      HASA returns 19 models but a given key could only call 6 of them — so a
 *      shared cache would leak one user's permission surface to another.
 *   2. The key itself never enters the payload. `CachedModelList` has nowhere
 *      to put it, and a test asserts the serialised bytes do not contain it.
 */

export const MODEL_CACHE_VERSION = 1;

export interface CachedModelEntry {
  id: string;
  ownedBy: string | null;
}

export interface CachedModelList {
  version: typeof MODEL_CACHE_VERSION;
  /** `${baseUrl}::${keyFingerprint}`. Contains a digest, never a key. */
  scope: string;
  fetchedAt: string;
  models: CachedModelEntry[];
}

export interface ModelCacheStore {
  read(scope: string): Promise<CachedModelList | null>;
  write(entry: CachedModelList): Promise<void>;
  clear(scope: string): Promise<void>;
}

export function cacheScope(baseUrl: string, keyFingerprint: string): string {
  return `${baseUrl}::${keyFingerprint}`;
}

function isCachedModelList(value: unknown): value is CachedModelList {
  if (value === null || typeof value !== "object") return false;
  const v = value as Partial<CachedModelList>;
  if (v.version !== MODEL_CACHE_VERSION) return false;
  if (typeof v.scope !== "string" || typeof v.fetchedAt !== "string") return false;
  if (!Array.isArray(v.models)) return false;
  return v.models.every(
    (m) =>
      m !== null &&
      typeof m === "object" &&
      typeof (m as CachedModelEntry).id === "string" &&
      ((m as CachedModelEntry).ownedBy === null || typeof (m as CachedModelEntry).ownedBy === "string"),
  );
}

export class MemoryModelCache implements ModelCacheStore {
  private readonly entries = new Map<string, CachedModelList>();

  async read(scope: string): Promise<CachedModelList | null> {
    return this.entries.get(scope) ?? null;
  }

  async write(entry: CachedModelList): Promise<void> {
    this.entries.set(entry.scope, entry);
  }

  async clear(scope: string): Promise<void> {
    this.entries.delete(scope);
  }
}

/**
 * Distinguishes one in-flight write from another.
 *
 * The process id alone is not enough. Two writes to the same scope inside one
 * process — two panels refreshing, or a retry overlapping its own first attempt
 * — would share a temporary path, interleave their bytes into it, and rename
 * the splice into place. Measured on a 2 MB catalogue with 16 concurrent
 * writers: 16 of 40 rounds published a file assembled from several writers, and
 * one was not valid JSON at all. That file is the fallback a user depends on
 * precisely when the gateway is down.
 */
let writeSequence = 0;

/**
 * Disk cache under `.arena/model-cache/`.
 *
 * The filename is a digest of the scope rather than the scope itself: a base
 * URL is not a safe path component, and a readable filename would put the key
 * fingerprint in a directory listing for no benefit.
 *
 * Every failure path degrades to "no cache". A corrupt or unreadable cache must
 * never be the reason a user cannot list models — it exists to soften an outage,
 * not to become one.
 */
export class FileModelCache implements ModelCacheStore {
  private readonly dir: string;

  constructor(dir = join(".arena", "model-cache")) {
    this.dir = dir;
  }

  private pathFor(scope: string): string {
    const digest = createHash("sha256").update(scope).digest("hex").slice(0, 32);
    return join(this.dir, `${digest}.json`);
  }

  async read(scope: string): Promise<CachedModelList | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.pathFor(scope), "utf8"));
      if (!isCachedModelList(parsed)) return null;
      // A digest collision, or a file copied between machines, would otherwise
      // serve one gateway's models as another's.
      return parsed.scope === scope ? parsed : null;
    } catch {
      return null;
    }
  }

  async write(entry: CachedModelList): Promise<void> {
    const target = this.pathFor(entry.scope);
    writeSequence += 1;
    const tmp = `${target}.${process.pid}.${writeSequence}.tmp`;
    try {
      await mkdir(this.dir, { recursive: true });
      // Written 0600 and renamed into place: a half-written cache is never
      // observable, and the file is not world-readable even though it holds
      // only model ids.
      await writeFile(tmp, JSON.stringify(entry), { encoding: "utf8", mode: 0o600 });
      await rename(tmp, target);
    } catch {
      // Caching is an optimisation. Losing it is not worth failing a request —
      // and when two writers race, Windows fails one of the renames outright.
      // The loser's entry is simply dropped; the winner's is whole.
    } finally {
      // A rename that succeeded consumed the temporary file and this is a
      // no-op. A rename that failed did not, and without this the directory
      // fills with megabyte-sized debris — one file per lost race, forever.
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  async clear(scope: string): Promise<void> {
    await rm(this.pathFor(scope), { force: true }).catch(() => {});
  }
}
