import { Injectable, Logger } from '@nestjs/common';
import { openai } from '@ai-sdk/openai';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import type { Observation, TestModelOutput, VisualTestRequirement, TestFailure, TestPass } from '@taucad/chat';
import { createMultiViewAnalysisPrompt } from '#api/analysis/prompts/multi-view-analysis-prompt.js';

const llmResultSchema = z.object({
  id: z.string(),
  status: z.enum(['passed', 'failed']),
  reason: z.string().nullable().describe('Required when status is "failed", null otherwise'),
  suggestion: z.string().nullable().describe('Required when status is "failed", null otherwise'),
});

const responseSchema = z.object({
  results: z.array(llmResultSchema),
});

const systemPrompt = createMultiViewAnalysisPrompt();

// Sort observations to ensure consistent order: front, back, right, left, top, bottom
const viewOrder = ['front', 'back', 'right', 'left', 'top', 'bottom'] as const;

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

    // Build sorted observations and check for missing views
    // We must fail fast if any view is missing - filtering shifts image order relative to the prompt,
    // which would cause the model to mislabel sides (e.g., thinking "right" is "left")
    const sortedObservations: Observation[] = [];
    const missingViews: string[] = [];

    for (const side of viewOrder) {
      const obs = observations.find((o) => o.side === side);
      if (obs) {
        sortedObservations.push(obs);
      } else {
        missingViews.push(side);
      }
    }

    if (missingViews.length > 0) {
      const missingViewsList = missingViews.join(', ');
      throw new Error(
        `Missing required views: ${missingViewsList}. All 6 orthographic views (front, back, right, left, top, bottom) are required for accurate analysis.`,
      );
    }

    const userPrompt = this.formatRequirementsPrompt(requirements);

    try {
      // Single LLM call with ALL views

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

      // Create a map of results by ID for efficient lookup
      const resultById = new Map(output.results.map((result) => [result.id, result]));

      // Process each requirement to ensure all are accounted for
      const failures: TestFailure[] = [];
      const passes: TestPass[] = [];

      for (const requirement of requirements) {
        const result = resultById.get(requirement.id);

        if (!result) {
          // Requirement was not returned by LLM - mark as failed
          failures.push({
            id: requirement.id,
            requirement: requirement.description,
            reason: 'No analysis result returned for this requirement',
            suggestion: 'This is a fatal error. The LLM failed to return a result for this requirement.',
          });
        } else if (result.status === 'failed') {
          failures.push({
            id: result.id,
            requirement: requirement.description,
            reason: result.reason ?? 'No reason provided',
            suggestion: result.suggestion ?? 'Review the model',
          });
        } else {
          // Status === 'passed'
          passes.push({
            id: result.id,
            requirement: requirement.description,
          });
        }
      }

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

      // On error, return all requirements as failed - this is a fatal infrastructure issue
      const failures: TestFailure[] = requirements.map((request) => ({
        id: request.id,
        requirement: request.description,
        reason: `Analysis error: ${errorMessage}`,
        suggestion: 'This is a fatal error. The API request failed.',
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
