import { Injectable, Logger } from '@nestjs/common';
import type { TestModelOutput, TestFailure, TestPass, MeasurementTestRequirement } from '@taucad/testing';
import { analyzeGlb, evaluateRequirement } from '@taucad/testing/geometry';

/**
 * NestJS wrapper around `@taucad/testing/geometry` pure functions.
 * Adds logging and maps results to the `TestModelOutput` shape.
 */
@Injectable()
export class GeometryAnalysisService {
  private readonly logger = new Logger(GeometryAnalysisService.name);

  public async runMeasurementTests(
    glb: Uint8Array<ArrayBuffer>,
    requirements: MeasurementTestRequirement[],
  ): Promise<TestModelOutput> {
    this.logger.log(`Running ${requirements.length} measurement tests`);

    let stats;
    try {
      stats = await analyzeGlb(glb);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`GLB analysis failed: ${message}`);
      return {
        failures: requirements.map((r) => ({
          id: r.id,
          requirement: r.description,
          reason: `GLB analysis failed: ${message}`,
          suggestion: 'Ensure the model compiles and produces valid geometry.',
        })),
        passes: [],
        passed: 0,
        total: requirements.length,
      };
    }

    const failures: TestFailure[] = [];
    const passes: TestPass[] = [];

    for (const requirement of requirements) {
      const result = evaluateRequirement(requirement, stats);
      if (result.passed) {
        passes.push({ id: requirement.id, requirement: requirement.description });
      } else {
        failures.push({
          id: requirement.id,
          requirement: requirement.description,
          reason: result.reason,
          suggestion: result.suggestion,
        });
      }
    }

    this.logger.log(`Measurement results: ${passes.length} passed, ${failures.length} failed`);

    return {
      failures,
      passes,
      passed: passes.length,
      total: requirements.length,
    };
  }
}
