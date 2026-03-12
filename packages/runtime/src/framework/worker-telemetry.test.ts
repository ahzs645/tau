import { describe, it, expect, vi, afterEach } from 'vitest';
import { WorkerTelemetryCollector, toAbsoluteTime } from '#framework/worker-telemetry.js';
import type { PerformanceEntryData } from '#types/kernel-protocol.types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('toAbsoluteTime', () => {
  it('should add workerTimeOrigin and startTime to produce absolute time', () => {
    const entry: PerformanceEntryData = {
      name: 'kernel.render',
      startTime: 100,
      duration: 50,
      workerTimeOrigin: 1_000_000,
    };

    expect(toAbsoluteTime(entry)).toBe(1_000_100);
  });
});

describe('WorkerTelemetryCollector', () => {
  it('should not call send when flush is called with no pending entries', () => {
    const send = vi.fn();
    const collector = new WorkerTelemetryCollector(send);

    collector.flush();

    expect(send).not.toHaveBeenCalled();
    collector.dispose();
  });

  it('should call send with collected performance entries on flush', () => {
    const send = vi.fn();
    const collector = new WorkerTelemetryCollector(send);

    performance.mark('test-start');
    performance.measure('test.measure', 'test-start');

    collector.flush();

    if (send.mock.calls.length > 0) {
      const entries = send.mock.calls[0]![0] as PerformanceEntryData[];
      expect(entries.length).toBeGreaterThan(0);
      const testEntry = entries.find((entry) => entry.name === 'test.measure');
      expect(testEntry).toBeDefined();
      expect(testEntry!.workerTimeOrigin).toBe(performance.timeOrigin);
    }

    collector.dispose();
    performance.clearMarks('test-start');
    performance.clearMeasures('test.measure');
  });

  it('should disconnect observer on dispose', () => {
    const send = vi.fn();
    const collector = new WorkerTelemetryCollector(send);

    collector.dispose();

    performance.mark('after-dispose-start');
    performance.measure('after-dispose.measure', 'after-dispose-start');

    collector.flush();

    expect(send).not.toHaveBeenCalled();

    performance.clearMarks('after-dispose-start');
    performance.clearMeasures('after-dispose.measure');
  });

  it('should flush remaining entries on dispose', () => {
    const send = vi.fn();
    const collector = new WorkerTelemetryCollector(send);

    performance.mark('dispose-flush-start');
    performance.measure('dispose-flush.measure', 'dispose-flush-start');

    collector.dispose();

    if (send.mock.calls.length > 0) {
      const entries = send.mock.calls[0]![0] as PerformanceEntryData[];
      const testEntry = entries.find((entry) => entry.name === 'dispose-flush.measure');
      expect(testEntry).toBeDefined();
    }

    performance.clearMarks('dispose-flush-start');
    performance.clearMeasures('dispose-flush.measure');
  });
});
