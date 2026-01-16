import { Body, Controller, Logger, Post, UseGuards } from '@nestjs/common';
import { AnalysisService } from '#api/analysis/analysis.service.js';
import { AuthGuard } from '#auth/auth.guard.js';
import { RunVisualTestsDto, RunVisualTestsResponseDto } from '#api/analysis/analysis.dto.js';

@UseGuards(AuthGuard)
@Controller({ path: 'analysis', version: '1' })
export class AnalysisController {
  private readonly logger = new Logger(AnalysisController.name);

  public constructor(private readonly analysisService: AnalysisService) {}

  @Post('visual-tests')
  public async runVisualTests(@Body() body: RunVisualTestsDto): Promise<RunVisualTestsResponseDto> {
    this.logger.log(
      `[run-visual-tests] Received request: ${body.observations.length} observations, ${body.requirements.length} requirements`,
    );

    try {
      const result = await this.analysisService.runVisualTests(body.observations, body.requirements);
      this.logger.log(`[run-visual-tests] Complete: ${result.passed} passed, ${result.failures.length} failed`);

      return result;
    } catch (error) {
      this.logger.error('[run-visual-tests] Failed:', error);
      throw error;
    }
  }
}
