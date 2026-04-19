import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZodValidationPipe } from 'nestjs-zod';
import type { MetricsService } from '#telemetry/metrics.js';
import { TelemetryController } from '#api/telemetry/telemetry.controller.js';
import { IngestPayloadDto } from '#api/telemetry/telemetry.dto.js';
import { IngestEntryName, AttributeKey } from '@taucad/telemetry';

function createMockMetrics() {
  return {
    kernelExecutionDuration: { record: vi.fn() },
    kernelExecutions: { add: vi.fn() },
    kernelExportDuration: { record: vi.fn() },
  };
}

describe('TelemetryController', () => {
  let controller: TelemetryController;
  let mockMetrics: ReturnType<typeof createMockMetrics>;

  beforeEach(() => {
    mockMetrics = createMockMetrics();
    controller = new TelemetryController(mockMetrics as unknown as MetricsService);
  });

  describe('POST /v1/telemetry/ingest', () => {
    it('should record kernel execution duration and count for createGeometry entries', () => {
      controller.ingest({
        entries: [{ name: IngestEntryName.KERNEL_CREATE_GEOMETRY, duration: 1500, detail: { status: 'ok' } }],
      });

      expect(mockMetrics.kernelExecutionDuration.record).toHaveBeenCalledWith(1.5, {
        [AttributeKey.KERNEL_STATUS]: 'ok',
      });
      expect(mockMetrics.kernelExecutions.add).toHaveBeenCalledWith(1, { [AttributeKey.KERNEL_STATUS]: 'ok' });
    });

    it('should record export duration for exportGeometry entries', () => {
      controller.ingest({
        entries: [
          {
            name: IngestEntryName.KERNEL_EXPORT_GEOMETRY,
            duration: 800,
            detail: { status: 'ok', exportFormat: 'glb' },
          },
        ],
      });

      expect(mockMetrics.kernelExportDuration.record).toHaveBeenCalledWith(0.8, {
        [AttributeKey.KERNEL_STATUS]: 'ok',
        [AttributeKey.EXPORT_FORMAT]: 'glb',
      });
    });

    it('should default status to "unknown" when detail is missing', () => {
      controller.ingest({
        entries: [{ name: IngestEntryName.KERNEL_CREATE_GEOMETRY, duration: 500 }],
      });

      expect(mockMetrics.kernelExecutionDuration.record).toHaveBeenCalledWith(0.5, {
        [AttributeKey.KERNEL_STATUS]: 'unknown',
      });
    });

    it('should default export format to "unknown" when not provided', () => {
      controller.ingest({
        entries: [{ name: IngestEntryName.KERNEL_EXPORT_GEOMETRY, duration: 300, detail: { status: 'ok' } }],
      });

      expect(mockMetrics.kernelExportDuration.record).toHaveBeenCalledWith(0.3, {
        [AttributeKey.KERNEL_STATUS]: 'ok',
        [AttributeKey.EXPORT_FORMAT]: 'unknown',
      });
    });

    it('should process multiple entries in a single batch', () => {
      controller.ingest({
        entries: [
          { name: IngestEntryName.KERNEL_CREATE_GEOMETRY, duration: 1000, detail: { status: 'ok' } },
          {
            name: IngestEntryName.KERNEL_EXPORT_GEOMETRY,
            duration: 2000,
            detail: { status: 'ok', exportFormat: 'step' },
          },
          { name: IngestEntryName.KERNEL_CREATE_GEOMETRY, duration: 500, detail: { status: 'error' } },
        ],
      });

      expect(mockMetrics.kernelExecutionDuration.record).toHaveBeenCalledTimes(2);
      expect(mockMetrics.kernelExecutions.add).toHaveBeenCalledTimes(2);
      expect(mockMetrics.kernelExportDuration.record).toHaveBeenCalledTimes(1);
    });
  });

  describe('IngestPayloadDto validation (via ZodValidationPipe)', () => {
    const pipe = new ZodValidationPipe();

    it('should reject entries with unknown names', () => {
      expect(() =>
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-return -- pipe.transform return type is any from NestJS ValidationPipe
        pipe.transform(
          { entries: [{ name: 'unknown.metric', duration: 100 }] },
          { type: 'body', metatype: IngestPayloadDto },
        ),
      ).toThrow();
    });

    it('should reject empty entries array', () => {
      expect(() =>
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-return -- pipe.transform return type is any from NestJS ValidationPipe
        pipe.transform({ entries: [] }, { type: 'body', metatype: IngestPayloadDto }),
      ).toThrow();
    });
  });
});
