/* oxlint-disable new-cap -- NestJS decorators use PascalCase */
/* eslint-disable @typescript-eslint/naming-convention -- OTEL attribute names use dot-notation */
import { Body, Controller, Post, HttpCode, UseGuards } from '@nestjs/common';
import { IngestEntryName, AttributeKey } from '@taucad/telemetry';
import { AuthGuard } from '#auth/auth.guard.js';
import { MetricsService } from '#telemetry/metrics.js';
import { IngestPayloadDto } from '#api/telemetry/telemetry.dto.js';

/**
 * Receives batched telemetry from the client runtime (web workers).
 * Metrics are reported directly from the observability middleware via fetch().
 */
@UseGuards(AuthGuard)
@Controller({ path: 'telemetry', version: '1' })
export class TelemetryController {
  public constructor(private readonly metrics: MetricsService) {}

  @Post('ingest')
  @HttpCode(204)
  public ingest(@Body() body: IngestPayloadDto): void {
    for (const entry of body.entries) {
      const durationSeconds = entry.duration / 1000;
      const status = entry.detail?.status ?? 'unknown';

      switch (entry.name) {
        case IngestEntryName.KERNEL_CREATE_GEOMETRY: {
          this.metrics.kernelExecutionDuration.record(durationSeconds, { [AttributeKey.KERNEL_STATUS]: status });
          this.metrics.kernelExecutions.add(1, { [AttributeKey.KERNEL_STATUS]: status });
          break;
        }
        case IngestEntryName.KERNEL_EXPORT_GEOMETRY: {
          const format = entry.detail?.exportFormat ?? 'unknown';
          this.metrics.kernelExportDuration.record(durationSeconds, {
            [AttributeKey.KERNEL_STATUS]: status,
            [AttributeKey.EXPORT_FORMAT]: format,
          });
          break;
        }
        default: {
          const _exhaustive: never = entry;
          throw new Error(`Unhandled ingest entry: ${(_exhaustive as { name: string }).name}`);
        }
      }
    }
  }
}
