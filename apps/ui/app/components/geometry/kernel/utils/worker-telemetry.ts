/**
 * Worker Telemetry System
 *
 * Collects performance.mark()/measure() entries from within a worker using
 * PerformanceObserver, batches them, and flushes periodically via a callback.
 * The main thread aggregates data from all workers with timestamp correlation.
 *
 * Naming convention: tau:<subsystem>:<operation>
 * - tau:fs:read, tau:fs:readBatch, tau:fs:exists, tau:fs:readdir
 * - tau:kernel:bundle, tau:kernel:compute, tau:kernel:deps, tau:kernel:params
 * - tau:hash:file, tau:hash:dep
 * - tau:middleware:wrap
 * - tau:wasm:init, tau:wasm:compile
 */

import type { PerformanceEntryData } from '@taucad/types';

const DEFAULT_FLUSH_INTERVAL_MS = 2000;

/**
 * Collects performance measure entries in a worker and flushes them in batches.
 * Zero overhead when no measures are recorded (observer is passive).
 */
export class WorkerTelemetryCollector {
  private readonly send: (entries: PerformanceEntryData[]) => void;
  private pending: PerformanceEntryData[] = [];
  private observer: PerformanceObserver;
  private flushTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    send: (entries: PerformanceEntryData[]) => void,
    flushIntervalMs: number = DEFAULT_FLUSH_INTERVAL_MS,
  ) {
    this.send = send;
    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        this.pending.push({
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
          detail: (entry as PerformanceMeasure).detail as Record<string, unknown> | undefined,
          workerTimeOrigin: performance.timeOrigin,
        });
      }
    });
    this.observer.observe({ type: 'measure', buffered: true });
    this.flushTimer = setInterval(() => { this.flush(); }, flushIntervalMs);
  }

  flush(): void {
    if (this.pending.length === 0) {
      return;
    }

    const batch = this.pending.splice(0);
    this.send(batch);
  }

  dispose(): void {
    this.observer.disconnect();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }

    this.flush();
  }
}

/**
 * Convert a worker-relative timestamp to an absolute timestamp
 * for cross-worker correlation.
 */
export function toAbsoluteTime(entry: PerformanceEntryData): number {
  return entry.workerTimeOrigin + entry.startTime;
}
