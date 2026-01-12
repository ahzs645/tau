import { Injectable, Logger } from '@nestjs/common';
import { openai } from '@ai-sdk/openai';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import type { Observation, ObservationResult, RequirementResult, EvaluationCriteria } from '@taucad/chat';
import { createImageAnalysisSystemPrompt } from '#api/analysis/prompts/image-analysis-prompt.js';
import { AnalyzeObservationsResponseDto } from '#api/analysis/analysis.dto.js';

/**
 * Service for analyzing CAD model observations (screenshots from different views)
 */
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  /**
   * Analyze multiple observations in parallel and aggregate results.
   *
   * @param observations - Array of observations (each with id, side, src)
   * @param requirements - Array of requirement strings to verify
   * @returns Aggregated analysis results with per-observation details
   */
  public async analyzeObservations(
    observations: Observation[],
    requirements: string[],
  ): Promise<AnalyzeObservationsResponseDto> {
    this.logger.log(`Analyzing ${observations.length} observations against ${requirements.length} requirements`);
    this.logger.debug(
      'Observation IDs:',
      observations.map((observation) => observation.id),
    );
    this.logger.debug('Requirements:', requirements);

    // Run all analyses in parallel
    this.logger.log('Starting parallel analysis of all observations...');
    const observationResults = await Promise.all(
      observations.map(async (observation) => this.analyzeObservation(observation, requirements)),
    );
    this.logger.log('All observations analyzed successfully');

    // Aggregate results per requirement using failure-based logic:
    // - FAILED if ANY view returns 'failed', OR if ALL views return 'indeterminate'
    // - PASSED if at least one view returns 'passed' and no views return 'failed'
    const aggregatedResults: RequirementResult[] = await Promise.all(
      requirements.map(async (requirement, requirementIndex) => {
        // Collect ALL failed results for this requirement
        type ViewFailure = { side: string; reason: string; suggestion: string };
        const viewFailures: ViewFailure[] = [];

        for (const observationResult of observationResults) {
          const result = observationResult.results[requirementIndex];
          if (result?.status === 'failed') {
            viewFailures.push({
              side: observationResult.side,
              reason: result.reason,
              suggestion: result.suggestion,
            });
          }
        }

        if (viewFailures.length > 0) {
          // If only one failure, use it directly (no summarization needed)
          const firstFailure = viewFailures[0];
          if (viewFailures.length === 1 && firstFailure) {
            return {
              status: 'failed' as const,
              requirement,
              reason: firstFailure.reason,
              suggestion: firstFailure.suggestion,
            };
          }

          // Multiple failures: use LLM to summarize into coherent reason + suggestion
          const { reason, suggestion } = await this.summarizeFailures(requirement, viewFailures);
          return { status: 'failed' as const, requirement, reason, suggestion };
        }

        // Check if ALL views are indeterminate (no view could verify)
        const allIndeterminate = observationResults.every((observationResult) => {
          const result = observationResult.results[requirementIndex];
          return result?.status === 'indeterminate';
        });

        if (allIndeterminate) {
          return {
            status: 'failed' as const,
            requirement,
            reason: 'No view could verify this requirement',
            suggestion: 'Ensure the feature is visible from at least one orthographic view',
          };
        }

        // At least one view passed and none failed
        return { status: 'passed' as const, requirement };
      }),
    );

    const evaluationCriteria: EvaluationCriteria = {
      totalObservations: observations.length,
    };

    return {
      observationResults,
      aggregatedResults,
      evaluationCriteria,
    };
  }

  /**
   * Analyze a single observation against requirements
   */
  private async analyzeObservation(observation: Observation, requirements: string[]): Promise<ObservationResult> {
    this.logger.debug(`Analyzing observation ${observation.id} (${observation.side} view)`);

    const systemPrompt = createImageAnalysisSystemPrompt(observation.side);
    const userPrompt = this.formatRequirementsPrompt(requirements);

    try {
      // Use generateText with Output.object for structured output generation
      // This replaces the deprecated generateObject function and uses OpenAI's strict mode
      //
      // Note: We use a flattened schema instead of discriminatedUnion because OpenAI's
      // structured outputs don't support 'oneOf' (which is what Zod's discriminatedUnion compiles to).
      // The LLM will populate reason/suggestion based on the status value.
      // OpenAI structured outputs require ALL properties to be required (no optional fields).
      // We use .nullable() so fields are required but can be null when not applicable.
      const llmRequirementResultSchema = z.object({
        status: z.enum(['passed', 'failed', 'indeterminate']),
        requirement: z.string(),
        reason: z.string().nullable().describe('Required when status is "failed" or "indeterminate", null otherwise'),
        suggestion: z.string().nullable().describe('Required when status is "failed", null otherwise'),
      });

      const responseSchema = z.object({
        results: z.array(llmRequirementResultSchema),
      });

      const { output } = await generateText({
        model: openai('gpt-4o'),

        output: Output.object({
          schema: responseSchema,
        }),
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: userPrompt },
              { type: 'image', image: observation.src },
            ],
          },
        ],
      });

      // Transform the flat LLM output to the proper discriminated union type
      const results: RequirementResult[] = output.results.map((result) => {
        switch (result.status) {
          case 'passed': {
            return { status: 'passed' as const, requirement: result.requirement };
          }

          case 'failed': {
            return {
              status: 'failed' as const,
              requirement: result.requirement,
              reason: result.reason ?? 'No reason provided',
              suggestion: result.suggestion ?? 'Review the model',
            };
          }

          case 'indeterminate': {
            return {
              status: 'indeterminate' as const,
              requirement: result.requirement,
              reason: result.reason ?? 'Unable to determine from this view',
            };
          }

          default: {
            const _exhaustiveCheck: never = result.status;
            throw new Error(`Invalid status: ${String(_exhaustiveCheck)}`);
          }
        }
      });

      return {
        id: observation.id,
        side: observation.side,
        results,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to analyze observation ${observation.id}: ${errorMessage}`);
      if (error instanceof Error && error.stack) {
        this.logger.debug(`Stack trace: ${error.stack}`);
      }

      // Return failed results for all requirements on error
      return {
        id: observation.id,
        side: observation.side,
        results: requirements.map((requirement) => ({
          status: 'failed' as const,
          requirement,
          reason: `Analysis failed for ${observation.side} view: ${errorMessage}`,
          suggestion: 'Retry the analysis',
        })),
      };
    }
  }

  /**
   * Format requirements into a prompt for the image analyzer
   */
  private formatRequirementsPrompt(requirements: string[]): string {
    const requirementsList = requirements.map((requirement, index) => `${index + 1}. ${requirement}`).join('\n');
    return `Please analyze this CAD model screenshot and verify the following requirements:\n\n${requirementsList}`;
  }

  /**
   * Summarize multiple view failures into a single coherent reason and suggestion.
   * Uses a fast text model to synthesize all failures intelligently.
   */
  private async summarizeFailures(
    requirement: string,
    viewFailures: Array<{ side: string; reason: string; suggestion: string }>,
  ): Promise<{ reason: string; suggestion: string }> {
    this.logger.debug(`Summarizing ${viewFailures.length} failures for requirement: ${requirement}`);

    const failureDetails = viewFailures
      .map((failure) => `${failure.side.toUpperCase()}: ${failure.reason} → Suggestion: ${failure.suggestion}`)
      .join('\n');

    const responseSchema = z.object({
      reason: z.string(),
      suggestion: z.string(),
    });

    try {
      const { output } = await generateText({
        model: openai('gpt-4o-mini'),
        output: Output.object({
          schema: responseSchema,
        }),
        system: `You are a helpful assistant that summarizes CAD model verification failures. Given multiple view-specific failures for a single requirement, synthesize them into ONE clear reason and ONE actionable suggestion. Be concise but preserve all important details.`,
        messages: [
          {
            role: 'user',
            content: `Summarize these CAD model verification failures for requirement "${requirement}" into ONE clear reason and ONE actionable suggestion:

${failureDetails}`,
          },
        ],
      });

      return {
        reason: output.reason,
        suggestion: output.suggestion,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to summarize failures: ${errorMessage}`);

      // Fallback: use the first failure's details (viewFailures is guaranteed non-empty)
      const firstFailure = viewFailures[0] ?? { reason: 'Unknown failure', suggestion: 'Review the model' };
      return {
        reason: `Failed in ${viewFailures.length} views. ${firstFailure.reason}`,
        suggestion: firstFailure.suggestion,
      };
    }
  }
}
