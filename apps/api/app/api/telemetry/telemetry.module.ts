import { Module } from '@nestjs/common';
import { TelemetryController } from '#api/telemetry/telemetry.controller.js';

@Module({
  controllers: [TelemetryController],
})
export class TelemetryIngestModule {}
