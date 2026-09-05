import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fingerprint } from "../router/conversability.ts";
import { revise, type RememberedRequirement, type RequirementOutcome } from "./requirementMemory.ts";

/**
 * Where the requirement memory lives between turns.
 *
 * `requirementMemory` defines what a row is and refuses to compare across
 * vector spaces. This is the part that makes the pile survive the process, and
 * it is the reason the memory can be a memory at all — a table rebuilt from
 * nothing every run is a cache.
 *
 * ## Refusing is not resetting
 *
 * A file that will not parse is refused, loudly, and left on disk. The
 * tempting alternative — start empty and carry on — silently destroys the only
 * copy of evidence that took months of turns to collect, and does it at exactly
 * the moment something is already wrong. `evaluationStore` makes the same call
 * for the same reason.
 *
 * A file that is *missing* is different and is not an error: that is the first
 * run.
 *
 * ## Why there is a cap, and why it is not just "oldest first"
 *
 * Vectors are the bulk of this file — 1024 floats per row for `bge-m3` — so the
 * pile cannot be unbounded on disk. But evicting purely by age throws away the
 * scarce thing: `superseded` and `rejected` rows are the ones that carry a
 * signal, and they are rare. `accepted` and `unconfirmed` rows are what most
 * turns produce and what most neighbours will be.
 *
 * So eviction takes the least informative first and only breaks ties by age. A
 * memory that forgets its corrections keeps its size and loses its point.
 */

/** Runtime artifact, beside the evaluation evidence. Gitignored. */
export const DEFAULT_MEMORY_PATH = ".arena/requirement-memory.json";

export const MEMORY_FORMAT = "requirement-memory-v1";

/**
 * How many rows to keep.
 *
 * 2000 rather than a rounder number for a reason that can be checked: at 1024
 * dimensions and six decimals a row costs roughly 9KB of JSON, so this is a
 * file of about 18MB — large enough to be worth knowing about, small enough to
 * read and scan in one go. Raise it when a measurement says the scan is the
 * cost; `embedding.ts` argues, correctly, that it is not yet.
 */
export const DEFAULT_MAX_ROWS = 2000;

/**
 * Digits kept per vector component.
 *
 * Lossy, and deliberately so: full float64 roughly triples the file for a
 * difference that lands around 1e-6 in a cosine, which is four orders of
 * magnitude below the resolution `proposerEvidence` says this corpus can even
 * claim. Recorded here rather than left implicit, because someone comparing a
 * stored vector to a freshly computed one will otherwise find a mismatch and
 * look for a bug.
 */
export const VECTOR_DECIMALS = 6;

/** Least informative first. Ties break by age, oldest evicted first. */
const KEEP_RANK: Readonly<Record<RequirementOutcome, number>> = {
  superseded: 3,
  rejected: 2,
  accepted: 1,
  unconfirmed: 0,
};

export interface MemoryFile {
  format: string;
  /** Which gateway these rows were collected against. Fingerprint, never a URL. */
  baseUrlFingerprint: string;
  /** When this file was last written. */
  savedAt: string;
  rows: readonly RememberedRequirement[];
}

export type LoadOutcome =
  /** No file yet. Not an error — this is the first run. */
  | { kind: "empty"; rows: readonly RememberedRequirement[] }
  | { kind: "loaded"; rows: readonly RememberedRequirement[]; savedAt: string }
  /** The file exists and cannot be trusted. It is left on disk. */
  | { kind: "refused"; reason: string };

function isRow(value: unknown): value is RememberedRequirement {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length === 0) return false;
  if (typeof row.turnId !== "string") return false;
  if (typeof row.sourceText !== "string") return false;
  if (typeof row.at !== "number" || !Number.isFinite(row.at)) return false;
  if (row.proposedBy !== null && typeof row.proposedBy !== "string") return false;
  if (row.budget !== null && typeof row.budget !== "number") return false;
  if (!(row.outcome as string in KEEP_RANK)) return false;
  // A vector without its space cannot be compared with anything, and a space
  // without a vector points at nothing. Either both or neither.
  const hasVector = row.vector !== undefined;
  const hasSpace = row.space !== undefined;
  if (hasVector !== hasSpace) return false;
  if (hasVector) {
    if (!Array.isArray(row.vector) || row.vector.length === 0) return false;
    if (!row.vector.every((n) => typeof n === "number" && Number.isFinite(n))) return false;
    if (typeof row.space !== "string") return false;
  }
  return true;
}

/**
 * Reads the memory, or says why it will not.
 *
 * `baseUrl` is fingerprinted and compared. Rows collected against one gateway
 * describe models that another gateway may not serve, and the outcome of a
 * requirement is about the model that produced it — so a mismatch refuses
 * rather than mixing two catalogues into one pile.
 */
export async function loadMemory(input: {
  path?: string;
  baseUrl: string;
}): Promise<LoadOutcome> {
  const path = input.path ?? DEFAULT_MEMORY_PATH;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "empty", rows: [] };
    return { kind: "refused", reason: `읽지 못했습니다: ${String(err).slice(0, 120)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "refused", reason: "JSON 이 아닙니다 — 파일은 지우지 않고 그대로 둡니다." };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "refused", reason: "최상위가 객체가 아닙니다." };
  }
  const file = parsed as Partial<MemoryFile>;
  if (file.format !== MEMORY_FORMAT) {
    return { kind: "refused", reason: `형식이 «${String(file.format)}» 입니다. «${MEMORY_FORMAT}» 이어야 합니다.` };
  }
  const want = fingerprint(input.baseUrl);
  if (file.baseUrlFingerprint !== want) {
    return {
      kind: "refused",
      reason: "다른 게이트웨이에서 모은 기억입니다 — 두 카탈로그를 한 더미로 섞지 않습니다.",
    };
  }
  if (!Array.isArray(file.rows)) return { kind: "refused", reason: "rows 가 배열이 아닙니다." };

  const rows = file.rows.filter(isRow);
  if (rows.length !== file.rows.length) {
    // 일부만 걸러 내고 조용히 쓰면, 남은 것이 온전하다는 잘못된 인상을 준다.
    return {
      kind: "refused",
      reason: `${file.rows.length - rows.length}개 행이 형식에 맞지 않습니다.`,
    };
  }
  return { kind: "loaded", rows, savedAt: String(file.savedAt ?? "") };
}

const round = (value: number): number => {
  const scale = 10 ** VECTOR_DECIMALS;
  return Math.round(value * scale) / scale;
};

/**
 * Folds new rows into old ones.
 *
 * Same id means the same requirement seen again, and the outcome is merged
 * through `revise` — which only ever moves toward the worse of the two. A
 * second sighting cannot launder a correction into an acceptance.
 */
export function mergeRows(
  existing: readonly RememberedRequirement[],
  incoming: readonly RememberedRequirement[],
): RememberedRequirement[] {
  const byId = new Map(existing.map((row) => [row.id, row]));
  for (const row of incoming) {
    const previous = byId.get(row.id);
    byId.set(row.id, previous === undefined ? row : revise({ ...row, at: previous.at }, previous.outcome));
  }
  return [...byId.values()];
}

/**
 * Which rows survive the cap.
 *
 * Least informative first, oldest first within a rank. Returns them in the
 * order given rather than in eviction order — a caller writing the file should
 * not have to know how eviction sorted.
 */
export function capRows(
  rows: readonly RememberedRequirement[],
  maxRows: number,
): RememberedRequirement[] {
  if (rows.length <= maxRows) return [...rows];
  const keep = new Set(
    [...rows]
      .sort((a, b) => KEEP_RANK[b.outcome] - KEEP_RANK[a.outcome] || b.at - a.at || a.id.localeCompare(b.id))
      .slice(0, Math.max(0, maxRows))
      .map((row) => row.id),
  );
  return rows.filter((row) => keep.has(row.id));
}

/**
 * Writes the memory, merging with whatever is already there.
 *
 * Refuses to write over a file it could not read. Overwriting a corrupt file
 * with a fresh one is the silent reset this module exists to avoid — the caller
 * is told, and decides.
 */
export async function saveMemory(input: {
  path?: string;
  baseUrl: string;
  rows: readonly RememberedRequirement[];
  now: () => number;
  maxRows?: number;
}): Promise<{ written: number; dropped: number } | { refused: string }> {
  const path = input.path ?? DEFAULT_MEMORY_PATH;
  const loaded = await loadMemory({ path, baseUrl: input.baseUrl });
  if (loaded.kind === "refused") return { refused: loaded.reason };

  const merged = mergeRows(loaded.rows, input.rows);
  const kept = capRows(merged, input.maxRows ?? DEFAULT_MAX_ROWS);
  const file: MemoryFile = {
    format: MEMORY_FORMAT,
    baseUrlFingerprint: fingerprint(input.baseUrl),
    savedAt: new Date(input.now()).toISOString(),
    rows: kept.map((row) =>
      row.vector === undefined ? row : { ...row, vector: row.vector.map(round) },
    ),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 1)}\n`, "utf8");
  return { written: kept.length, dropped: merged.length - kept.length };
}
