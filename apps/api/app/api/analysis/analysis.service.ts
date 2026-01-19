import { Injectable, Logger } from '@nestjs/common';
import { openai } from '@ai-sdk/openai';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import type { Observation, TestModelOutput, VisualTestRequirement, TestFailure, TestPass } from '@taucad/chat';
import { createMultiViewAnalysisPrompt } from '#api/analysis/prompts/multi-view-analysis-prompt.js';

/**
 * Service for running visual tests on CAD models.
 * Uses a single multi-view LLM call for fast, holistic analysis.
 */
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  /**
   * Run visual tests against captured observations.
   * Makes a SINGLE LLM call with ALL views for holistic evaluation.
   *
   * @param observations - Array of captured screenshots (6 orthographic views)
   * @param requirements - Array of visual test requirements from test.json
   * @returns TestModelOutput with only failures (passed tests are implicit)
   */
  public async runVisualTests(
    observations: Observation[],
    requirements: VisualTestRequirement[],
  ): Promise<TestModelOutput> {
    this.logger.log(`Running ${requirements.length} visual tests against ${observations.length} views`);

    // Sort observations to ensure consistent order: front, back, right, left, top, bottom
    const viewOrder = ['front', 'back', 'right', 'left', 'top', 'bottom'] as const;
    const sortedObservations = viewOrder
      .map((side) => observations.find((obs) => obs.side === side))
      .filter((obs): obs is Observation => obs !== undefined);

    if (sortedObservations.length !== 6) {
      this.logger.warn(`Expected 6 views, got ${sortedObservations.length}`);
    }

    const systemPrompt = createMultiViewAnalysisPrompt();
    const userPrompt = this.formatRequirementsPrompt(requirements);

    try {
      // Single LLM call with ALL views
      const llmResultSchema = z.object({
        id: z.string(),
        status: z.enum(['passed', 'failed']),
        reason: z.string().nullable().describe('Required when status is "failed", null otherwise'),
        suggestion: z.string().nullable().describe('Required when status is "failed", null otherwise'),
      });

      const responseSchema = z.object({
        results: z.array(llmResultSchema),
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
              // Include all views in order
              ...sortedObservations.map((obs) => ({
                type: 'image' as const,
                image: obs.src,
              })),
            ],
          },
        ],
      });

      // Extract failures with detailed feedback
      const failures: TestFailure[] = output.results
        .filter((result) => result.status === 'failed')
        .map((result) => {
          // Find the original requirement to get its description
          const requirement = requirements.find((request) => request.id === result.id);

          return {
            id: result.id,
            requirement: requirement?.description ?? result.id,
            reason: result.reason ?? 'No reason provided',
            suggestion: result.suggestion ?? 'Review the model',
          };
        });

      // Extract passes (simpler, just id and description)
      const passes: TestPass[] = output.results
        .filter((result) => result.status === 'passed')
        .map((result) => {
          const requirement = requirements.find((request) => request.id === result.id);

          return {
            id: result.id,
            requirement: requirement?.description ?? result.id,
          };
        });

      this.logger.log(`Test results: ${passes.length} passed, ${failures.length} failed`);

      return {
        failures,
        passes,
        passed: passes.length,
        total: requirements.length,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Visual test analysis failed: ${errorMessage}`);

      if (error instanceof Error && error.stack) {
        this.logger.debug(`Stack trace: ${error.stack}`);
      }

      // On error, return all requirements as failed with actionable message
      const failures: TestFailure[] = requirements.map((request) => ({
        id: request.id,
        requirement: request.description,
        reason: `Analysis error: ${errorMessage}`,
        suggestion: 'Check API connectivity and retry. If the problem persists, simplify requirements.',
      }));

      return {
        failures,
        passes: [],
        passed: 0,
        total: requirements.length,
      };
    }
  }

  /**
   * Format requirements into a user prompt for the multi-view analyzer.
   */
  private formatRequirementsPrompt(requirements: VisualTestRequirement[]): string {
    const requirementsList = requirements
      .map((request) => `- ID: ${request.id}\n  Requirement: ${request.description}`)
      .join('\n');

    return `Verify the following requirements against the 6 orthographic views provided:

${requirementsList}

The views are provided in order: FRONT, BACK, RIGHT, LEFT, TOP, BOTTOM.`;
  }
}
