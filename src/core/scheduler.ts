import { createLogger, type Logger } from "../hasa-client/logger.ts";

/**
 * Global request scheduler.
 *
 * The bug this exists to prevent: creating a semaphore inside a request handler
 * gives every incoming request its own limiter, so N concurrent callers produce
 * N × limit in-flight requests and the GPU-side cap is never enforced. The
 * scheduler is therefore a process-wide singleton, and `submit` is the only way
 * to reach HASA.
 *
 * Two caps apply simultaneously: total in-flight, and in-flight per model.
 * The per-model cap is the one that actually protects a shared backend.
 *
 * See docs/architecture.md §5.
 */

export interface SchedulerOptions {
  globalLimit: number;
  perModelLimit: number;
  logger?: Logger;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
}

export interface SchedulerJob<T> {
  modelId: string;
  /** Higher runs first among eligible jobs. Judge work outranks candidates. */
  priority?: number;
  signal?: AbortSignal;
  run: (signal?: AbortSignal) => Promise<T>;
}

export interface SchedulerStats {
  inFlight: number;
  waiting: number;
  perModel: Record<string, number>;
  pausedModels: string[];
  peakInFlight: number;
  peakPerModel: number;
}

interface Waiter {
  modelId: string;
  priority: number;
  seq: number;
  start: () => void;
  cancel: (reason: unknown) => void;
}

export class Scheduler {
  private readonly globalLimit: number;
  private readonly perModelLimit: number;
  private readonly log: Logger;
  private readonly setTimeoutImpl: (fn: () => void, ms: number) => unknown;

  private readonly waiting: Waiter[] = [];
  private readonly perModel = new Map<string, number>();
  private readonly pausedUntil = new Map<string, number>();
  private inFlight = 0;
  private seq = 0;
  private peakInFlight = 0;
  private peakPerModel = 0;

  constructor(opts: SchedulerOptions) {
    this.globalLimit = Math.max(1, opts.globalLimit);
    this.perModelLimit = Math.max(1, opts.perModelLimit);
    this.log = opts.logger ?? createLogger("scheduler");
    this.setTimeoutImpl = opts.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
  }

  submit<T>(job: SchedulerJob<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (job.signal?.aborted) {
        reject(job.signal.reason ?? new Error("aborted"));
        return;
      }
      const waiter: Waiter = {
        modelId: job.modelId,
        priority: job.priority ?? 0,
        seq: this.seq,
        start: () => {
          this.acquire(job.modelId);
          void (async () => {
            try {
              resolve(await job.run(job.signal));
            } catch (err) {
              reject(err);
            } finally {
              this.release(job.modelId);
              this.pump();
            }
          })();
        },
        cancel: reject,
      };
      this.seq += 1;
      this.waiting.push(waiter);

      job.signal?.addEventListener(
        "abort",
        () => {
          const index = this.waiting.indexOf(waiter);
          // Only a job still queued can be dropped; one already running has to
          // observe the signal itself.
          if (index !== -1) {
            this.waiting.splice(index, 1);
            waiter.cancel(job.signal?.reason ?? new Error("aborted"));
          }
        },
        { once: true },
      );

      this.pump();
    });
  }

  /**
   * Stops dispatching for one model without touching the rest of the run.
   * Called on 429 so a rate-limited model does not starve the whole scheduler.
   */
  pauseModel(modelId: string, ms: number): void {
    if (ms <= 0) return;
    const until = Date.now() + ms;
    const current = this.pausedUntil.get(modelId) ?? 0;
    if (until <= current) return;
    this.pausedUntil.set(modelId, until);
    this.log.warn("model paused", { modelId, ms });
    this.setTimeoutImpl(() => {
      this.pausedUntil.delete(modelId);
      this.pump();
    }, ms);
  }

  stats(): SchedulerStats {
    return {
      inFlight: this.inFlight,
      waiting: this.waiting.length,
      perModel: Object.fromEntries(this.perModel),
      pausedModels: [...this.pausedUntil.keys()],
      peakInFlight: this.peakInFlight,
      peakPerModel: this.peakPerModel,
    };
  }

  private acquire(modelId: string): void {
    this.inFlight += 1;
    const next = (this.perModel.get(modelId) ?? 0) + 1;
    this.perModel.set(modelId, next);
    if (this.inFlight > this.peakInFlight) this.peakInFlight = this.inFlight;
    if (next > this.peakPerModel) this.peakPerModel = next;
  }

  private release(modelId: string): void {
    this.inFlight -= 1;
    const next = (this.perModel.get(modelId) ?? 1) - 1;
    if (next <= 0) this.perModel.delete(modelId);
    else this.perModel.set(modelId, next);
  }

  private pickNext(): number {
    const now = Date.now();
    let best = -1;
    for (let i = 0; i < this.waiting.length; i += 1) {
      const w = this.waiting[i];
      if (!w) continue;
      const pausedTo = this.pausedUntil.get(w.modelId);
      if (pausedTo !== undefined && pausedTo > now) continue;
      if ((this.perModel.get(w.modelId) ?? 0) >= this.perModelLimit) continue;
      const current = best === -1 ? undefined : this.waiting[best];
      if (
        current === undefined ||
        w.priority > current.priority ||
        (w.priority === current.priority && w.seq < current.seq)
      ) {
        best = i;
      }
    }
    return best;
  }

  private pump(): void {
    while (this.inFlight < this.globalLimit) {
      const index = this.pickNext();
      if (index === -1) return;
      const [waiter] = this.waiting.splice(index, 1);
      waiter?.start();
    }
  }
}

let defaultScheduler: Scheduler | null = null;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Process-wide instance. Request handlers must call this rather than
 * constructing a Scheduler — see the note at the top of this file.
 */
export function getScheduler(): Scheduler {
  if (defaultScheduler === null) {
    defaultScheduler = new Scheduler({
      globalLimit: envInt("ARENA_GLOBAL_CONCURRENCY", 4),
      perModelLimit: envInt("ARENA_MODEL_CONCURRENCY", 1),
    });
  }
  return defaultScheduler;
}

/** Test hook only. */
export function resetScheduler(): void {
  defaultScheduler = null;
}
