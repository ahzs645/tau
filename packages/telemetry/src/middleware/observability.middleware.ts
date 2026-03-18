import { defineMiddleware } from '@taucad/runtime/middleware/runtime-middleware';
import { z } from 'zod';
import { IngestEntryName } from '#ingest.js';
import { reportToApi } from '#middleware/utils/report-to-api.js';

/**
 * Runtime middleware that collects kernel execution metrics.
 *
 * Hooks into createGeometry and exportGeometry to measure:
 * - Execution duration
 * - Success/failure status
 * - Export format (from exportGeometry input)
 *
 * When `reportUrl` is set, metrics are sent directly from the worker
 * to the API via fire-and-forget `fetch()`, bypassing the main thread.
 *
 * @public
 */
export const observabilityMiddleware = defineMiddleware({
  name: 'Observability',
  version: '2',
  optionsSchema: z.object({ reportUrl: z.string().optional().default('') }),

  async wrapCreateGeometry(input, handler, { logger, options }) {
    const start = performance.now();

    try {
      const result = await handler(input);
      const duration = performance.now() - start;

      performance.measure(IngestEntryName.KERNEL_CREATE_GEOMETRY, {
        start,
        duration,
        detail: { status: 'success' },
      });

      if (options.reportUrl) {
        reportToApi({
          reportUrl: options.reportUrl,
          name: IngestEntryName.KERNEL_CREATE_GEOMETRY,
          durationMs: duration,
          detail: { status: 'success' },
        });
      }

      return result;
    } catch (error) {
      const duration = performance.now() - start;
      const message = error instanceof Error ? error.message : String(error);

      performance.measure(IngestEntryName.KERNEL_CREATE_GEOMETRY, {
        start,
        duration,
        detail: { status: 'error', error: message },
      });

      if (options.reportUrl) {
        reportToApi({
          reportUrl: options.reportUrl,
          name: IngestEntryName.KERNEL_CREATE_GEOMETRY,
          durationMs: duration,
          detail: { status: 'error' },
        });
      }

      logger.error(`Geometry creation failed: ${message}`);
      throw error;
    }
  },

  async wrapExportGeometry(input, handler, { logger, options }) {
    const start = performance.now();

    try {
      const result = await handler(input);
      const duration = performance.now() - start;

      performance.measure(IngestEntryName.KERNEL_EXPORT_GEOMETRY, {
        start,
        duration,
        detail: { status: 'success', exportFormat: input.fileType },
      });

      if (options.reportUrl) {
        reportToApi({
          reportUrl: options.reportUrl,
          name: IngestEntryName.KERNEL_EXPORT_GEOMETRY,
          durationMs: duration,
          detail: { status: 'success', exportFormat: input.fileType },
        });
      }

      return result;
    } catch (error) {
      const duration = performance.now() - start;
      const message = error instanceof Error ? error.message : String(error);

      performance.measure(IngestEntryName.KERNEL_EXPORT_GEOMETRY, {
        start,
        duration,
        detail: {
          status: 'error',
          exportFormat: input.fileType,
          error: message,
        },
      });

      if (options.reportUrl) {
        reportToApi({
          reportUrl: options.reportUrl,
          name: IngestEntryName.KERNEL_EXPORT_GEOMETRY,
          durationMs: duration,
          detail: { status: 'error', exportFormat: input.fileType },
        });
      }

      logger.error(`Geometry export failed: ${message}`);
      throw error;
    }
  },
});
