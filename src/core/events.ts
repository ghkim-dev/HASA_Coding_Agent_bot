import type { ArenaEvent } from "../protocol/index.ts";

export type EventListener = (event: ArenaEvent, id: number) => void;

/**
 * Per-run event log with replay.
 *
 * SSE clients reconnect; without a replay buffer a UI that blinks loses the
 * completion event and hangs on "running" forever. History is bounded because
 * a run's event count is bounded by its candidate count.
 */
export class RunEventLog {
  private readonly events: ArenaEvent[] = [];
  private readonly listeners = new Set<EventListener>();
  private closed = false;

  publish(event: ArenaEvent): void {
    if (this.closed) return;
    this.events.push(event);
    const id = this.events.length;
    for (const listener of [...this.listeners]) {
      try {
        listener(event, id);
      } catch {
        // A misbehaving subscriber must not break the run.
      }
    }
  }

  /** Replays everything after `lastEventId`, then streams. Returns unsubscribe. */
  subscribe(listener: EventListener, lastEventId = 0): () => void {
    for (let i = lastEventId; i < this.events.length; i += 1) {
      const event = this.events[i];
      if (event) listener(event, i + 1);
    }
    if (this.closed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  history(): ArenaEvent[] {
    return [...this.events];
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }
}

export class EventHub {
  private readonly logs = new Map<string, RunEventLog>();

  forRun(runId: string): RunEventLog {
    let log = this.logs.get(runId);
    if (!log) {
      log = new RunEventLog();
      this.logs.set(runId, log);
    }
    return log;
  }

  has(runId: string): boolean {
    return this.logs.has(runId);
  }

  close(runId: string): void {
    this.logs.get(runId)?.close();
  }

  closeAll(): void {
    for (const log of this.logs.values()) log.close();
    this.logs.clear();
  }
}
