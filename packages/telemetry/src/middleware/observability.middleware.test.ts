/* oxlint-disable typescript-eslint/no-unsafe-assignment -- vitest asymmetric matchers return `any` */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockRuntime, createMockInput, createMockCreateGeometryHandler } from '@taucad/runtime/testing';
import type { ExportGeometryInput, ExportGeometryResult } from '@taucad/runtime/types';
import { IngestEntryName } from '#ingest.js';
import { observabilityMiddleware } from '#middleware/observability.middleware.js';

vi.mock('#middleware/utils/report-to-api.js', () => ({
  reportToApi: vi.fn(),
}));

const getReportToApiMock = async () => {
  const reportModule = await import('#middleware/utils/report-to-api.js');
  return vi.mocked(reportModule.reportToApi);
};

const createMockExportInput = (fileType = 'step'): ExportGeometryInput => ({
  fileType: fileType as ExportGeometryInput['fileType'],
  nativeHandle: {},
});

const createMockExportHandler = (result?: ExportGeometryResult) =>
  vi.fn<(input: ExportGeometryInput) => Promise<ExportGeometryResult>>().mockResolvedValue(
    result ?? {
      success: true,
      data: [{ name: 'output.stl', bytes: new Uint8Array([1, 2, 3]), mimeType: 'model/stl' }],
      issues: [],
    },
  );

describe('observabilityMiddleware', () => {
  let measureSpy: ReturnType<typeof vi.spyOn>;
  let reportToApiMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    measureSpy = vi.spyOn(performance, 'measure').mockReturnValue({
      name: '',
      entryType: 'measure',
      startTime: 0,
      duration: 0,
      detail: null,
      // eslint-disable-next-line @typescript-eslint/naming-convention -- PerformanceMeasure interface method
      toJSON: () => ({}),
    } satisfies PerformanceMeasure);
    reportToApiMock = await getReportToApiMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('wrapCreateGeometry', () => {
    it('should call handler and return its result on success', async () => {
      const handler = createMockCreateGeometryHandler();
      const input = createMockInput();
      const runtime = createMockRuntime({ options: { reportUrl: '' } });

      const result = await observabilityMiddleware.wrapCreateGeometry!(input, handler, runtime);

      expect(handler).toHaveBeenCalledWith(input);
      expect(result.success).toBe(true);
    });

    it('should emit performance.measure with correct name and success detail on success', async () => {
      const handler = createMockCreateGeometryHandler();
      const input = createMockInput();
      const runtime = createMockRuntime({ options: { reportUrl: '' } });

      await observabilityMiddleware.wrapCreateGeometry!(input, handler, runtime);

      expect(measureSpy).toHaveBeenCalledWith(
        IngestEntryName.KERNEL_CREATE_GEOMETRY,
        expect.objectContaining({ detail: { status: 'success' } }),
      );
    });

    it('should emit performance.measure with error detail on failure', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('kernel crash'));
      const input = createMockInput();
      const runtime = createMockRuntime({ options: { reportUrl: '' } });

      await expect(observabilityMiddleware.wrapCreateGeometry!(input, handler, runtime)).rejects.toThrow(
        'kernel crash',
      );

      expect(measureSpy).toHaveBeenCalledWith(
        IngestEntryName.KERNEL_CREATE_GEOMETRY,
        expect.objectContaining({ detail: { status: 'error', error: 'kernel crash' } }),
      );
    });

    it('should re-throw the original error after measuring', async () => {
      const originalError = new Error('original');
      const handler = vi.fn().mockRejectedValue(originalError);
      const input = createMockInput();
      const runtime = createMockRuntime({ options: { reportUrl: '' } });

      await expect(observabilityMiddleware.wrapCreateGeometry!(input, handler, runtime)).rejects.toBe(originalError);
    });

    it('should call reportToApi when reportUrl option is set on success', async () => {
      const handler = createMockCreateGeometryHandler();
      const input = createMockInput();
      const runtime = createMockRuntime({ options: { reportUrl: 'https://api.test/ingest' } });

      await observabilityMiddleware.wrapCreateGeometry!(input, handler, runtime);

      expect(reportToApiMock).toHaveBeenCalledWith({
        reportUrl: 'https://api.test/ingest',
        name: IngestEntryName.KERNEL_CREATE_GEOMETRY,
        durationMs: expect.any(Number),
        detail: { status: 'success' },
      });
    });

    it('should call reportToApi when reportUrl option is set on failure', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('fail'));
      const input = createMockInput();
      const runtime = createMockRuntime({ options: { reportUrl: 'https://api.test/ingest' } });

      await expect(observabilityMiddleware.wrapCreateGeometry!(input, handler, runtime)).rejects.toThrow('fail');

      expect(reportToApiMock).toHaveBeenCalledWith({
        reportUrl: 'https://api.test/ingest',
        name: IngestEntryName.KERNEL_CREATE_GEOMETRY,
        durationMs: expect.any(Number),
        detail: { status: 'error' },
      });
    });

    it('should not call reportToApi when reportUrl is empty', async () => {
      const handler = createMockCreateGeometryHandler();
      const input = createMockInput();
      const runtime = createMockRuntime({ options: { reportUrl: '' } });

      await observabilityMiddleware.wrapCreateGeometry!(input, handler, runtime);

      expect(reportToApiMock).not.toHaveBeenCalled();
    });

    it('should log error message on failure', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('bad geometry'));
      const input = createMockInput();
      const runtime = createMockRuntime({ options: { reportUrl: '' } });

      await expect(observabilityMiddleware.wrapCreateGeometry!(input, handler, runtime)).rejects.toThrow();

      expect(runtime.logger.error).toHaveBeenCalledWith('Geometry creation failed: bad geometry');
    });

    it('should measure correct duration (positive elapsed time)', async () => {
      const handler = createMockCreateGeometryHandler();
      const input = createMockInput();
      const runtime = createMockRuntime({ options: { reportUrl: '' } });

      await observabilityMiddleware.wrapCreateGeometry!(input, handler, runtime);

      expect(measureSpy).toHaveBeenCalledWith(
        IngestEntryName.KERNEL_CREATE_GEOMETRY,
        expect.objectContaining({
          duration: expect.any(Number),
          start: expect.any(Number),
        }),
      );
    });
  });

  describe('wrapExportGeometry', () => {
    it('should call handler and return its result on success', async () => {
      const handler = createMockExportHandler();
      const input = createMockExportInput('stl');
      const runtime = createMockRuntime({ options: { reportUrl: '' } });

      const result = await observabilityMiddleware.wrapExportGeometry!(input, handler, runtime);

      expect(handler).toHaveBeenCalledWith(input);
      expect(result.success).toBe(true);
    });

    it('should emit performance.measure with correct name and success detail on success', async () => {
      const handler = createMockExportHandler();
      const input = createMockExportInput('step');
      const runtime = createMockRuntime({ options: { reportUrl: '' } });

      await observabilityMiddleware.wrapExportGeometry!(input, handler, runtime);

      expect(measureSpy).toHaveBeenCalledWith(
        IngestEntryName.KERNEL_EXPORT_GEOMETRY,
        expect.objectContaining({ detail: { status: 'success', exportFormat: 'step' } }),
      );
    });

    it('should emit performance.measure with export format in detail on success', async () => {
      const handler = createMockExportHandler();
      const input = createMockExportInput('3mf');
      const runtime = createMockRuntime({ options: { reportUrl: '' } });

      await observabilityMiddleware.wrapExportGeometry!(input, handler, runtime);

      expect(measureSpy).toHaveBeenCalledWith(
        IngestEntryName.KERNEL_EXPORT_GEOMETRY,
        expect.objectContaining({
          detail: expect.objectContaining({ exportFormat: '3mf' }),
        }),
      );
    });

    it('should emit performance.measure with correct name on failure (bug fix)', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('export failed'));
      const input = createMockExportInput('stl');
      const runtime = createMockRuntime({ options: { reportUrl: '' } });

      await expect(observabilityMiddleware.wrapExportGeometry!(input, handler, runtime)).rejects.toThrow(
        'export failed',
      );

      expect(measureSpy).toHaveBeenCalledWith(
        IngestEntryName.KERNEL_EXPORT_GEOMETRY,
        expect.objectContaining({
          detail: expect.objectContaining({ status: 'error', exportFormat: 'stl' }),
        }),
      );
    });

    it('should call reportToApi when reportUrl is set on success', async () => {
      const handler = createMockExportHandler();
      const input = createMockExportInput('step');
      const runtime = createMockRuntime({ options: { reportUrl: 'https://api.test/ingest' } });

      await observabilityMiddleware.wrapExportGeometry!(input, handler, runtime);

      expect(reportToApiMock).toHaveBeenCalledWith({
        reportUrl: 'https://api.test/ingest',
        name: IngestEntryName.KERNEL_EXPORT_GEOMETRY,
        durationMs: expect.any(Number),
        detail: { status: 'success', exportFormat: 'step' },
      });
    });

    it('should call reportToApi when reportUrl is set on failure', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('fail'));
      const input = createMockExportInput('stl');
      const runtime = createMockRuntime({ options: { reportUrl: 'https://api.test/ingest' } });

      await expect(observabilityMiddleware.wrapExportGeometry!(input, handler, runtime)).rejects.toThrow();

      expect(reportToApiMock).toHaveBeenCalledWith({
        reportUrl: 'https://api.test/ingest',
        name: IngestEntryName.KERNEL_EXPORT_GEOMETRY,
        durationMs: expect.any(Number),
        detail: { status: 'error', exportFormat: 'stl' },
      });
    });

    it('should not call reportToApi when reportUrl is empty', async () => {
      const handler = createMockExportHandler();
      const input = createMockExportInput('stl');
      const runtime = createMockRuntime({ options: { reportUrl: '' } });

      await observabilityMiddleware.wrapExportGeometry!(input, handler, runtime);

      expect(reportToApiMock).not.toHaveBeenCalled();
    });

    it('should log error message on failure', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('export crash'));
      const input = createMockExportInput('stl');
      const runtime = createMockRuntime({ options: { reportUrl: '' } });

      await expect(observabilityMiddleware.wrapExportGeometry!(input, handler, runtime)).rejects.toThrow();

      expect(runtime.logger.error).toHaveBeenCalledWith('Geometry export failed: export crash');
    });
  });
});
