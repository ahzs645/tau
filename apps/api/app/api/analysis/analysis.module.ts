import { Module } from '@nestjs/common';
import { AnalysisController } from '#api/analysis/analysis.controller.js';
import { AnalysisService } from '#api/analysis/analysis.service.js';

@Module({
  controllers: [AnalysisController],
  providers: [AnalysisService],
  exports: [AnalysisService],
})
export class AnalysisModule {}
