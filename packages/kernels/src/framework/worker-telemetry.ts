/**
 * Worker Telemetry System
 *
 * Collects performance.mark()/measure() entries from within a worker using
 * PerformanceObserver, batches them, and flushes periodically via a callback.
 * The main thread aggregates data from all workers with timestamp correlation.
 *
 * See docs/kernel-telemetry-policy.md for the full telemetry policy.
 *
 * Naming convention: {subsystem}.{operation} (OTel-inspired)
 *
 * Root spans:          kernel.bootstrap, kernel.render, kernel.export
 * Framework lifecycle: kernel.init, kernel.select, kernel.detect-import, kernel.compute, kernel.extract-params
 * Framework infra:     kernel.bundle, kernel.execute, kernel.bundler-init, kernel.resolve-deps, kernel.load-middleware
 * Dependency pipeline: deps.discover, deps.read, deps.hash, deps.content-hash
 * Filesystem:          fs.read, fs.readBatch, fs.exists, fs.readdir
 * WASM:                wasm.compile
 * Middleware:           middleware.wrap({name})
 * Kernel-authored:     {kernelName}.{operation} (e.g., replicad.wasm-init, replicad.run-main, openscad.call-main)
 */

import type { PerformanceEntryData } from '@taucad/types';

const defaultFlushIntervalMs = 100;

/**
 * Collects performance measure entries in a worker and flushes them in batches.
 * Zero overhead when no measures are recorded (observer is passive).
 */
export class WorkerTelemetryCollector {
  // eslint-disable-next-line @typescript-eslint/parameter-properties -- erasableSyntaxOnly forbids parameter properties
  private readonly send: (entries: PerformanceEntryData[]) => void;
  private readonly pending: PerformanceEntryData[] = [];
  private readonly observer: PerformanceObserver;
  private flushTimer: ReturnType<typeof setInterval> | undefined;

  public constructor(
    send: (entries: PerformanceEntryData[]) => void,
    flushIntervalMs: number = defaultFlushIntervalMs,
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
    this.flushTimer = setInterval(() => {
      this.flush();
    }, flushIntervalMs);
  }

  public flush(): void {
    if (this.pending.length === 0) {
      return;
    }

    const batch = this.pending.splice(0);
    this.send(batch);
  }

  public dispose(): void {
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
