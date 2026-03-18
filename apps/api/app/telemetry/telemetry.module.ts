/* oxlint-disable new-cap -- NestJS decorators use PascalCase */
import { Global, Module, Logger } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { TracerService } from '#telemetry/tracer.service.js';
import { MetricsService } from '#telemetry/metrics.js';

const shutdownTimeoutMs = 5000;

@Global()
@Module({
  providers: [TracerService, MetricsService],
  exports: [TracerService, MetricsService],
})
export class TelemetryModule implements OnApplicationShutdown {
  private readonly logger = new Logger(TelemetryModule.name);

  public async onApplicationShutdown(): Promise<void> {
    this.logger.log('Shutting down OTEL SDK...');

    try {
      const { sdk } = await import('#telemetry/otel.js');
      const timeout = new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('OTEL shutdown timeout'));
        }, shutdownTimeoutMs);
        timer.unref();
      });
      await Promise.race([sdk.shutdown(), timeout]);
      this.logger.log('OTEL SDK shut down successfully');
    } catch (error) {
      this.logger.warn(`OTEL SDK shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
