/* oxlint-disable new-cap -- NestJS decorators use PascalCase */
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

      switch (entry.name) {
        case IngestEntryName.KERNEL_CREATE_GEOMETRY: {
          const status = entry.detail?.status ?? 'unknown';
          this.metrics.kernelExecutionDuration.record(durationSeconds, { [AttributeKey.KERNEL_STATUS]: status });
          this.metrics.kernelExecutions.add(1, { [AttributeKey.KERNEL_STATUS]: status });
          break;
        }
        case IngestEntryName.KERNEL_EXPORT_GEOMETRY: {
          const status = entry.detail?.status ?? 'unknown';
          const format = entry.detail?.exportFormat ?? 'unknown';
          this.metrics.kernelExportDuration.record(durationSeconds, {
            [AttributeKey.KERNEL_STATUS]: status,
            [AttributeKey.EXPORT_FORMAT]: format,
          });
          break;
        }
        case IngestEntryName.WEBSOCKET_RECONNECTION: {
          this.metrics.wsReconnectionDuration.record(durationSeconds, {
            [AttributeKey.WS_RECONNECTION_ATTEMPT]: entry.detail?.attempt ?? 0,
          });
          break;
        }
        case IngestEntryName.EDITOR_LOAD: {
          this.metrics.editorLoadDuration.record(durationSeconds, {
            [AttributeKey.EDITOR_KERNEL]: entry.detail?.kernel ?? 'unknown',
          });
          break;
        }
        case IngestEntryName.WASM_MODULE_LOAD: {
          this.metrics.wasmModuleLoadDuration.record(durationSeconds, {
            [AttributeKey.WASM_MODULE]: entry.detail?.module ?? 'unknown',
          });
          break;
        }
        case IngestEntryName.INDEXEDDB_OPERATION: {
          this.metrics.indexeddbOperationDuration.record(durationSeconds, {
            [AttributeKey.INDEXEDDB_OPERATION]: entry.detail?.operation ?? 'unknown',
            [AttributeKey.INDEXEDDB_STORE]: entry.detail?.store ?? 'unknown',
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
