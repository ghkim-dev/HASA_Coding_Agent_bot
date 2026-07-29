import type { CapabilityMatrix, CapabilityName, CapabilityResult, ModelLimits } from "../protocol/index.ts";
import type { HasaClient } from "../hasa-client/client.ts";
import { HasaError } from "../hasa-client/errors.ts";
import { fingerprint } from "../hasa-client/redact.ts";
import type { Logger } from "../hasa-client/logger.ts";
import { PROBES, type ProbeContext, type ProbeDefinition } from "./probes.ts";
import { buildMatrix, buildModelReport, emptyLimits, type CapabilityMap } from "./matrix.ts";

export interface ProbeRunOptions {
  client: HasaClient;
  apiKey: string;
  log: Logger;
  models: string[];
  deep?: boolean;
  optIn?: CapabilityName[];
  /** Models probed in parallel. HASA shares GPU backends, so keep this low. */
  concurrency?: number;
  signal?: AbortSignal;
  now?: () => number;
  onModelDone?: (modelId: string, caps: CapabilityMap) => void;
}

function selectProbes(deep: boolean, optIn: CapabilityName[]): ProbeDefinition[] {
  return PROBES.filter((p) => {
    if (p.deep && !deep) return false;
    if (p.optIn && !optIn.includes(p.name)) return false;
    return true;
  });
}

async function probeModel(
  ctx: ProbeContext,
  modelId: string,
  probes: ProbeDefinition[],
): Promise<{ caps: CapabilityMap; limits: ModelLimits }> {
  const caps: CapabilityMap = {};
  const limits = emptyLimits();

  for (const probe of probes) {
    if (ctx.signal?.aborted) break;

    const unmet = probe.requires.filter((r) => caps[r]?.status !== "pass");
    if (unmet.length > 0) {
      caps[probe.name] = {
        status: "skipped",
        evidence: `skipped: ${unmet.join(", ")} did not pass`,
      };
      continue;
    }

    const started = performance.now();
    const outcome = await probe.run(ctx, modelId);
    const result: CapabilityResult = {
      status: outcome.status,
      durationMs: Math.round(performance.now() - started),
    };
    if (outcome.evidence !== undefined) result.evidence = outcome.evidence;
    if (outcome.httpStatus !== undefined) result.httpStatus = outcome.httpStatus;
    if (outcome.errorCode !== undefined) result.errorCode = outcome.errorCode;
    caps[probe.name] = result;

    if (outcome.limits?.observedMaxOutputTokens !== undefined) {
      limits.observedMaxOutputTokens = outcome.limits.observedMaxOutputTokens;
    }
    if (outcome.limits?.observedContextWindow !== undefined) {
      limits.observedContextWindow = outcome.limits.observedContextWindow;
    }
    if (outcome.limits?.latencyMs !== undefined) {
      limits.latencyMs = outcome.limits.latencyMs;
    }

    ctx.log.info("probe finished", {
      model: modelId,
      capability: probe.name,
      status: result.status,
      durationMs: result.durationMs,
    });

    // A model the key cannot touch will 403 on everything; stop burning
    // requests and let the remaining probes record why they were skipped.
    if (result.status === "denied") {
      for (const remaining of probes) {
        if (!caps[remaining.name]) {
          caps[remaining.name] = { status: "skipped", evidence: "skipped: model access denied (403)" };
        }
      }
      break;
    }
  }

  return { caps, limits };
}

/** Simple bounded fan-out. No dependency, no queue semantics beyond a cap. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runProbes(opts: ProbeRunOptions): Promise<CapabilityMatrix> {
  const now = opts.now ?? Date.now;
  const probes = selectProbes(opts.deep ?? false, opts.optIn ?? []);
  opts.log.info("probe plan", {
    models: opts.models.length,
    probes: probes.map((p) => p.name),
    concurrency: opts.concurrency ?? 2,
  });

  const reports = await mapWithConcurrency(opts.models, opts.concurrency ?? 2, async (modelId) => {
    const ctx: ProbeContext = {
      client: opts.client,
      log: opts.log.child(modelId),
      // Fresh per model: what one deployment accepts says nothing about another.
      state: new Map<string, unknown>(),
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    try {
      const { caps, limits } = await probeModel(ctx, modelId, probes);
      opts.onModelDone?.(modelId, caps);
      return buildModelReport(modelId, caps, limits);
    } catch (err) {
      // Only 401 reaches here (probes swallow everything else); it is fatal for
      // the whole run because no result gathered with a bad key is meaningful.
      if (err instanceof HasaError && err.kind === "auth") throw err;
      const caps: CapabilityMap = {
        chat: { status: "unknown", evidence: `probe aborted: ${String(err)}`.slice(0, 200) },
      };
      return buildModelReport(modelId, caps, emptyLimits());
    }
  });

  return buildMatrix({
    baseUrl: opts.client.baseUrl,
    keyFingerprint: fingerprint(opts.apiKey),
    probedAt: new Date(now()).toISOString(),
    models: reports,
  });
}
