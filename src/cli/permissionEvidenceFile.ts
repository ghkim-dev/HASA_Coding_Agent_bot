import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  PermissionEvidence,
  PermissionEvidenceStore,
  PermissionFact,
} from "../design/modelPermission.ts";

/**
 * The CLI's permission store: one small JSON file beside the repository.
 *
 * This is the composition root's half of `PermissionEvidenceStore`. The design
 * layer never sees a path, and the VS Code extension will implement the same
 * interface over extension storage — which is the reason the interface exists
 * rather than a `path` option threaded down through the proposer.
 *
 * ## What is written, and what is refused
 *
 * A credential fingerprint, a gateway URL, model ids, statuses and timestamps.
 * Nothing else can be written, because nothing else is passed in: there is no
 * parameter for an API key, an `Authorization` header or a response body. The
 * write path also refuses anything that *looks* like key material as a second
 * guard, because "the caller would never" is how secrets end up in files.
 *
 * ## Atomic, because the thing it protects is a refusal
 *
 * `recordForbidden` writes a temporary file and renames it over the target.
 * `rename` within a directory is atomic on both platforms this runs on, so a
 * reader sees either the old record or the new one. A half-written file would be
 * the worst outcome available: the record whose whole purpose is to stop a
 * forbidden model being called again would be the record that fails to parse.
 *
 * ## Separate from the probe's matrix, on purpose
 *
 * `.arena/capability-matrix.json` is the probe's output and is overwritten
 * wholesale by the next probe run. A live 403 is an observation the probe did not
 * make, so it lives in its own file and is merged over the matrix at load time —
 * otherwise the next probe would erase it, and the model would be called again.
 */

const DEFAULT_DIR = ".arena";
const FILE = "permission-evidence.json";

/** The shape on disk. Versioned so a future change can be read rather than guessed. */
interface StoredEvidence {
  schemaVersion: 1;
  keyFingerprint: string;
  baseUrl: string;
  measuredAt: string;
  models: PermissionFact[];
}

/** Anything that must never reach the disk, checked on the way out. */
const SECRET_SHAPED = /sk-[A-Za-z0-9_-]{8,}|bearer\s|authorization/i;

export interface FileStoreOptions {
  /** Where the file lives. The CLI's choice, not the design layer's. */
  dir?: string;
  /**
   * The probe's matrix, already read and already checked against this credential.
   *
   * Supplied as a value rather than a path so this store does not become a second
   * place that knows how to read a matrix. Live refusals are merged over it.
   */
  base?: PermissionEvidence | null;
}

export function createFilePermissionStore(options: FileStoreOptions = {}): PermissionEvidenceStore {
  const path = join(options.dir ?? DEFAULT_DIR, FILE);

  const read = async (): Promise<StoredEvidence | null> => {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as StoredEvidence;
      if (parsed.schemaVersion !== 1) return null;
      if (typeof parsed.keyFingerprint !== "string" || typeof parsed.baseUrl !== "string") return null;
      if (!Array.isArray(parsed.models)) return null;
      return parsed;
    } catch {
      // Absent or unreadable. Both mean "nothing recorded here", and neither is
      // worth failing a user's request over.
      return null;
    }
  };

  const write = async (next: StoredEvidence): Promise<void> => {
    const body = JSON.stringify(next, null, 2);
    if (SECRET_SHAPED.test(body)) {
      throw new Error("권한 기록에 자격 증명처럼 보이는 값이 포함돼 저장을 중단했습니다.");
    }
    await mkdir(dirname(path), { recursive: true });
    // Named by fingerprint prefix rather than by pid or a random suffix: the
    // former keeps two credentials from colliding, and this module has no clock
    // and no randomness by design.
    const temporary = `${path}.${next.keyFingerprint.replace(/[^A-Za-z0-9]/g, "").slice(0, 16)}.tmp`;
    await writeFile(temporary, body, "utf8");
    await rename(temporary, path);
  };

  return {
    async load(input) {
      const stored = await read();
      const base = options.base ?? null;
      // A record for another credential or another gateway is evidence about
      // somebody else. Checked here as well as in `evidenceFromMatrix`, because
      // this file is written by us and read by us and a mismatch means something
      // is wrong rather than merely unusable.
      const mine =
        stored !== null &&
        stored.keyFingerprint === input.keyFingerprint &&
        stored.baseUrl === input.baseUrl
          ? stored
          : null;

      if (mine === null) return base;
      if (base === null) {
        return {
          keyFingerprint: mine.keyFingerprint,
          baseUrl: mine.baseUrl,
          measuredAt: mine.measuredAt,
          models: mine.models,
        };
      }

      // Live refusals win over the probe's matrix. The matrix says what a probe
      // saw at some earlier point; a 403 says what the server did when this key
      // actually called. The second is never overwritten by the first.
      const merged = new Map(base.models.map((fact) => [fact.modelId, fact]));
      for (const fact of mine.models) merged.set(fact.modelId, fact);
      return { ...base, models: [...merged.values()] };
    },

    async recordForbidden(input) {
      const stored = await read();
      const mine =
        stored !== null &&
        stored.keyFingerprint === input.keyFingerprint &&
        stored.baseUrl === input.baseUrl
          ? stored
          : null;
      const observedAt = new Date(input.at).toISOString();
      const fact: PermissionFact = {
        modelId: input.modelId,
        chat: "denied",
        observedAt,
        source: "live",
      };
      const models = new Map((mine?.models ?? []).map((m) => [m.modelId, m]));
      models.set(input.modelId, fact);
      await write({
        schemaVersion: 1,
        keyFingerprint: input.keyFingerprint,
        baseUrl: input.baseUrl,
        measuredAt: mine?.measuredAt ?? observedAt,
        models: [...models.values()],
      });
    },

    async invalidate(input) {
      const stored = await read();
      if (stored === null) return;
      if (stored.keyFingerprint !== input.keyFingerprint || stored.baseUrl !== input.baseUrl) return;
      // The user asked for a fresh measurement. Nothing calls this on a timer —
      // see the note on `PermissionEvidenceStore.invalidate`.
      await rm(path, { force: true });
    },
  };
}
