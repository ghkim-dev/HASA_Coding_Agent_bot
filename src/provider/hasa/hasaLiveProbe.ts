import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CapabilityMatrixSchema, type CapabilityMatrix } from "../../protocol/index.ts";
import { PROBE_VERSION } from "../../protocol/capability.ts";
import type { HasaClient } from "../../hasa-client/client.ts";
import { nullLogger, type Logger } from "../../hasa-client/logger.ts";
import { runProbes } from "../../probe/runner.ts";
import { HasaCapabilityProbe, type CapabilityProbeFn } from "./hasaCapabilityProbe.ts";

/**
 * Wires the lazy capability cache to the thing that actually measures.
 *
 * Until this file existed, `HasaCapabilityProbe.ensure` had an injection point
 * and nothing injected into it: every capability was `unknown` forever unless
 * someone ran `pnpm probe` by hand first. That is a reasonable state for a
 * provider that only reads a stored matrix, and a useless one for an agent that
 * has to pick a model.
 *
 * The measuring itself is `src/probe/` — the same code that produced the
 * recorded matrix. Nothing here re-implements a probe; it binds one.
 */

export const DEFAULT_MATRIX_PATH = join(".arena", "capability-matrix.json");

/**
 * Concurrency for a live probe.
 *
 * One, not the CLI's two or three. This runs behind a user action — opening a
 * model picker, starting a task — against GPUs shared with everything else on
 * the gateway, and the recorded run saw `503`s at three.
 */
export const LIVE_PROBE_CONCURRENCY = 1;

export interface LiveProbeOptions {
  client: HasaClient;
  /** Used only to fingerprint the matrix. Never stored. */
  apiKey: string;
  logger?: Logger;
  concurrency?: number;
  /** Long-context and max-output ladders. Expensive; off by default. */
  deep?: boolean;
}

/**
 * A `CapabilityProbeFn` backed by the real probe suite.
 *
 * Deliberately not given the whole catalogue: `ensure` calls it with one model
 * at a time, which is what makes the probe lazy in the sense §12 asks for.
 */
export function createLiveCapabilityProbe(opts: LiveProbeOptions): CapabilityProbeFn {
  const log = opts.logger ?? nullLogger;
  return async (modelIds, signal) => {
    log.info("probing capabilities", { models: modelIds.length });
    return runProbes({
      client: opts.client,
      apiKey: opts.apiKey,
      log: log.child("probe"),
      models: modelIds,
      concurrency: opts.concurrency ?? LIVE_PROBE_CONCURRENCY,
      deep: opts.deep ?? false,
      ...(signal ? { signal } : {}),
    });
  };
}

export interface MatrixStoreOptions {
  path?: string;
  /** The matrix is rejected unless it was produced with this key. */
  keyFingerprint: string;
  baseUrl: string;
  logger?: Logger;
}

/**
 * Reads a stored matrix, or nothing.
 *
 * Three guards, all from docs/compatibility-matrix.md §6, and all of the form
 * "measurements taken under different conditions are not measurements of this":
 *
 *   - a different key has different permissions, so its `denied` results say
 *     nothing about ours;
 *   - a different gateway is a different deployment;
 *   - an older probe version measured different things.
 *
 * Every failure is a miss rather than an error. A matrix is an optimisation
 * over probing; being unable to read one must not stop anything.
 */
export async function readCapabilityMatrix(
  opts: MatrixStoreOptions,
): Promise<CapabilityMatrix | null> {
  const path = opts.path ?? DEFAULT_MATRIX_PATH;
  const log = opts.logger ?? nullLogger;
  let parsed: CapabilityMatrix;
  try {
    const result = CapabilityMatrixSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    if (!result.success) {
      log.warn("stored capability matrix has an unexpected shape", { path });
      return null;
    }
    parsed = result.data;
  } catch {
    return null;
  }

  if (parsed.keyFingerprint !== opts.keyFingerprint) {
    log.info("ignoring a capability matrix measured with another key", { path });
    return null;
  }
  if (parsed.baseUrl !== opts.baseUrl) {
    log.info("ignoring a capability matrix measured against another gateway", { path });
    return null;
  }
  if (parsed.probeVersion !== PROBE_VERSION) {
    log.info("ignoring a capability matrix from an older probe", {
      path,
      stored: parsed.probeVersion,
      current: PROBE_VERSION,
    });
    return null;
  }
  return parsed;
}

/** Sequence number for temporary files. See modelCache.ts for why. */
let writeSequence = 0;

/**
 * Writes a matrix atomically, and never at the cost of the caller.
 *
 * Same shape as the model cache: a unique temporary path per write, renamed
 * into place, and cleaned up unconditionally so a lost race leaves no debris.
 */
export async function writeCapabilityMatrix(
  matrix: CapabilityMatrix,
  path = DEFAULT_MATRIX_PATH,
): Promise<void> {
  writeSequence += 1;
  const tmp = `${path}.${process.pid}.${writeSequence}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    // 0600: the matrix holds a key fingerprint and measured permissions. Not a
    // secret, but not a thing to leave world-readable either.
    await writeFile(tmp, JSON.stringify(matrix, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
  } catch {
    /* persisting is a convenience */
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

export interface HasaLiveCapabilityProbeOptions extends LiveProbeOptions, MatrixStoreOptions {}

/**
 * A capability probe that reads a stored matrix and can measure what is missing.
 *
 * This is the assembly the product actually uses: lazy on startup, live on
 * demand, and persistent afterwards so the next session pays nothing.
 */
export function createLiveHasaCapabilityProbe(
  opts: HasaLiveCapabilityProbeOptions,
): HasaCapabilityProbe {
  const path = opts.path ?? DEFAULT_MATRIX_PATH;
  return new HasaCapabilityProbe({
    load: () =>
      readCapabilityMatrix({
        path,
        keyFingerprint: opts.keyFingerprint,
        baseUrl: opts.baseUrl,
        ...(opts.logger ? { logger: opts.logger } : {}),
      }),
    probe: createLiveCapabilityProbe(opts),
    save: (matrix) => writeCapabilityMatrix(matrix, path),
  });
}
