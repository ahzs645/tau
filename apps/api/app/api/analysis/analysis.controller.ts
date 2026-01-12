import { Body, Controller, Logger, Post, UseGuards } from '@nestjs/common';
import { AnalysisService } from '#api/analysis/analysis.service.js';
import { AuthGuard } from '#auth/auth.guard.js';
import { AnalyzeObservationsDto, AnalyzeObservationsResponseDto } from '#api/analysis/analysis.dto.js';

@UseGuards(AuthGuard)
@Controller({ path: 'analysis', version: '1' })
export class AnalysisController {
  private readonly logger = new Logger(AnalysisController.name);

  public constructor(private readonly analysisService: AnalysisService) {}

  @Post('observations')
  public async analyzeObservations(@Body() body: AnalyzeObservationsDto): Promise<AnalyzeObservationsResponseDto> {
    this.logger.log(
      `[analyze-observations] Received request: ${body.observations.length} observations, ${body.requirements.length} requirements`,
    );

    try {
      const result = await this.analysisService.analyzeObservations(body.observations, body.requirements);
      this.logger.log('[analyze-observations] Analysis complete, returning results');
      return result;
    } catch (error) {
      this.logger.error('[analyze-observations] Analysis failed:', error);
      throw error;
    }
  }
}
