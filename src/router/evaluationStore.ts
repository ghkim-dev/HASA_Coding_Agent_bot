import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fingerprint } from "./conversability.ts";
import type { EvaluationSummary } from "./modelRegistry.ts";

/**
 * Where evaluation evidence lives between a sweep and a recommendation.
 *
 * The two have been running in different processes with nothing on disk between
 * them, which is the whole reason `buildRegistry(models, [])` is the call at
 * every site: there was no second argument to pass. This is the file that makes
 * one.
 *
 * ## The staleness rule is the same one conversability uses
 *
 * Evidence is about the deployment that produced it. A number measured against
 * one gateway is not a number about another, and a sweep run before the
 * catalogue turned over is describing models that may no longer be there. Both
 * are recorded as fingerprints and a date, and a load against a different
 * endpoint returns nothing rather than the wrong thing — an empty registry
 * ranks on eligibility, which is honest, where stale evidence ranks confidently
 * on fiction.
 *
 * Nothing here writes a key, a base URL or any model output. The file holds
 * model ids, numbers, sample counts and two fingerprints.
 */

/** Runtime artifacts, beside the capability matrix. Gitignored. */
export const DEFAULT_EVIDENCE_PATH = ".arena/evaluation-evidence.json";

/** Evidence older than this describes a catalogue that has since moved twice. */
export const EVIDENCE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export const EVIDENCE_FORMAT = "evaluation-evidence-v1";

export interface EvidenceFile {
  format: string;
  /** When the sweep ran, not when it was written. */
  measuredAt: string;
  /** Which gateway. Fingerprint, never the URL. */
  baseUrlFingerprint: string;
  /** Which scenarios were asked. Evidence is only about what was tested. */
  scenarioIds: readonly string[];
  /** Runs per model per scenario. */
  runsPerCell: number;
  summaries: readonly EvaluationSummary[];
}

export interface LoadResult {
  summaries: EvaluationSummary[];
  /** Why there is nothing here, when there is nothing. Printed, not swallowed. */
  unusable: string | null;
  file: EvidenceFile | null;
}

/**
 * Models whose numbers were dropped before they were written, and why.
 *
 * Reported rather than silently filtered. A sweep that scored a model it should
 * not have has a bug upstream, and a store that quietly swallowed the result
 * would hide it.
 */
export interface RefusedEvidence {
  modelId: string;
  reason: string;
}

export function buildEvidenceFile(input: {
  measuredAt: string;
  baseUrl: string;
  scenarioIds: readonly string[];
  runsPerCell: number;
  summaries: readonly EvaluationSummary[];
  /**
   * What is known about whether each model converses. Anything explicitly
   * `false` is refused.
   *
   * This is a second line, not the first one. The first is the sweep declining
   * to run such a model at all — and the first line failed: a filter reading a
   * field that does not exist on `ProviderModel` passed every model through it,
   * and a sweep scored four image-and-video models across twenty coding
   * scenarios. Zeroes measured that way are not a measurement, and this is the
   * last point at which they are still only in memory.
   */
  conversability?: ReadonlyMap<string, boolean>;
}): { file: EvidenceFile; refused: RefusedEvidence[] } {
  const refused: RefusedEvidence[] = [];
  const kept: EvaluationSummary[] = [];
  for (const summary of input.summaries) {
    if (input.conversability?.get(summary.modelId) === false) {
      refused.push({
        modelId: summary.modelId,
        reason: "verified not to serve chat — its scores measure the harness asking the wrong question",
      });
      continue;
    }
    kept.push(summary);
  }

  return {
    file: {
      format: EVIDENCE_FORMAT,
      measuredAt: input.measuredAt,
      baseUrlFingerprint: fingerprint(input.baseUrl),
      scenarioIds: [...input.scenarioIds],
      runsPerCell: input.runsPerCell,
      summaries: kept,
    },
    refused,
  };
}

export async function saveEvidence(file: EvidenceFile, path = DEFAULT_EVIDENCE_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

/**
 * Evidence for the gateway in use, or an explained nothing.
 *
 * Every rejection path returns `unusable` rather than throwing or returning an
 * empty list quietly. A recommendation that silently lost its evidence looks
 * exactly like one that never had any, and the difference matters when the
 * question is why a model was chosen.
 */
export async function loadEvidence(options: {
  baseUrl: string;
  now: number;
  path?: string;
}): Promise<LoadResult> {
  const path = options.path ?? DEFAULT_EVIDENCE_PATH;
  const none = (reason: string): LoadResult => ({ summaries: [], unusable: reason, file: null });

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return none(`No evaluation evidence at ${path}. Ranking will use eligibility only.`);
  }

  let file: EvidenceFile;
  try {
    file = JSON.parse(raw) as EvidenceFile;
  } catch {
    return none(`Evidence at ${path} is not readable JSON.`);
  }

  if (file.format !== EVIDENCE_FORMAT) {
    return none(`Evidence is format ${String(file.format)}, expected ${EVIDENCE_FORMAT}.`);
  }
  if (file.baseUrlFingerprint !== fingerprint(options.baseUrl)) {
    return none("Evidence was measured against a different gateway. Not applied.");
  }
  const measured = Date.parse(file.measuredAt);
  if (Number.isNaN(measured)) return none("Evidence has no readable measurement date.");
  if (options.now - measured > EVIDENCE_TTL_MS) {
    const days = Math.floor((options.now - measured) / (24 * 60 * 60 * 1000));
    return none(`Evidence is ${days} days old, past the ${EVIDENCE_TTL_MS / 86_400_000}-day limit. Not applied.`);
  }
  if (!Array.isArray(file.summaries) || file.summaries.length === 0) {
    return none("Evidence file holds no model summaries.");
  }

  return { summaries: [...file.summaries], unusable: null, file };
}
