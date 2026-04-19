import { boundingBoxExpectedSchema } from '#schemas.js';
import type { MeasurementTestRequirement, BoundingBoxExpected } from '#schemas.js';
import type { GeometryStats, CheckResult } from '#geometry/types.js';

const defaultTolerance = 0.1;

const checkBoundingBox = (
  requirement: MeasurementTestRequirement,
  stats: GeometryStats,
  tolerance: number,
): CheckResult => {
  if (!stats.boundingBox) {
    return {
      passed: false,
      reason: 'No bounding box available (model may have no geometry)',
      suggestion: 'Ensure the model produces visible geometry.',
    };
  }

  const parseResult = boundingBoxExpectedSchema.safeParse(requirement.expected);
  if (!parseResult.success) {
    const zodErrors = parseResult.error.issues.map((issue) => issue.message).join('; ');
    return {
      passed: false,
      reason: `Invalid expected value for boundingBox check: ${zodErrors}`,
      suggestion:
        'Use expected: { size: { x, y, z }, center: { x, y, z } }. ' +
        'Each axis is optional — specify only the axes you want to check.',
    };
  }

  const expected: BoundingBoxExpected = parseResult.data;

  // oxlint-disable-next-line unicorn/explicit-length-check -- false positive, oxlint matched on Set.prototype.size
  if (!expected.size && !expected.center) {
    return {
      passed: false,
      reason: 'Bounding box check requires at least size or center',
      suggestion: 'Provide size and/or center constraints in the expected parameter.',
    };
  }

  const reasons: string[] = [];

  // oxlint-disable-next-line unicorn/explicit-length-check -- false positive check against Set.prototype.entries
  if (expected.size) {
    const axes = ['x', 'y', 'z'] as const;
    for (const [i, axis] of axes.entries()) {
      const exp = expected.size[axis];
      if (exp === undefined) {
        continue;
      }

      const actual = stats.boundingBox.size[i]!;
      if (Math.abs(actual - exp) > tolerance) {
        reasons.push(`size.${axis}: expected ${exp} (±${tolerance}), got ${actual.toFixed(3)}`);
      }
    }
  }

  if (expected.center) {
    const axes = ['x', 'y', 'z'] as const;
    for (const [i, axis] of axes.entries()) {
      const exp = expected.center[axis];
      if (exp === undefined) {
        continue;
      }

      const actual = stats.boundingBox.center[i]!;
      if (Math.abs(actual - exp) > tolerance) {
        reasons.push(`center.${axis}: expected ${exp} (±${tolerance}), got ${actual.toFixed(3)}`);
      }
    }
  }

  if (reasons.length > 0) {
    return {
      passed: false,
      reason: `Bounding box mismatch: ${reasons.join('; ')}`,
      suggestion: 'Adjust model dimensions or parameters to match expected bounding box.',
    };
  }

  return { passed: true, reason: '', suggestion: '' };
};

/**
 * Evaluates a single measurement requirement against geometry stats.
 *
 * @param requirement - The measurement test requirement to evaluate
 * @param stats - The geometry statistics to check against
 * @returns A check result indicating pass/fail with reason and suggestion
 * @public
 */
export const evaluateRequirement = (requirement: MeasurementTestRequirement, stats: GeometryStats): CheckResult => {
  const tolerance = requirement.tolerance ?? defaultTolerance;

  switch (requirement.check) {
    case 'boundingBox': {
      return checkBoundingBox(requirement, stats, tolerance);
    }

    case 'meshCount': {
      const expected = (requirement.expected as { count?: number } | undefined)?.count;
      if (expected === undefined) {
        return { passed: false, reason: 'Missing expected.count', suggestion: 'Add expected: { count: N }' };
      }

      if (stats.meshCount !== expected) {
        return {
          passed: false,
          reason: `Mesh count: expected ${expected}, got ${stats.meshCount}`,
          suggestion: `Adjust the model to produce ${expected} mesh(es).`,
        };
      }

      return { passed: true, reason: '', suggestion: '' };
    }

    case 'connectedComponents': {
      const expected = (requirement.expected as { count?: number } | undefined)?.count;
      if (expected === undefined) {
        return { passed: false, reason: 'Missing expected.count', suggestion: 'Add expected: { count: N }' };
      }

      if (stats.connectedComponents !== expected) {
        return {
          passed: false,
          reason: `Connected components: expected ${expected}, got ${stats.connectedComponents}`,
          suggestion:
            stats.connectedComponents > expected
              ? `Model has ${stats.connectedComponents} disconnected pieces — ensure all parts are fused into ${expected} solid(s).`
              : `Model has fewer connected pieces than expected.`,
        };
      }

      return { passed: true, reason: '', suggestion: '' };
    }

    case 'vertexCount': {
      const expected = (requirement.expected as { count?: number } | undefined)?.count;
      if (expected === undefined) {
        return { passed: false, reason: 'Missing expected.count', suggestion: 'Add expected: { count: N }' };
      }

      if (Math.abs(stats.vertexCount - expected) > tolerance) {
        return {
          passed: false,
          reason: `Vertex count: expected ${expected} (±${tolerance}), got ${stats.vertexCount}`,
          suggestion: `Model has ${stats.vertexCount} vertices, expected ~${expected}.`,
        };
      }

      return { passed: true, reason: '', suggestion: '' };
    }

    case 'watertight': {
      if (!stats.watertight) {
        return {
          passed: false,
          reason: 'Mesh is not watertight (has boundary edges)',
          suggestion: 'Ensure all faces form a closed manifold with no gaps or holes.',
        };
      }
      return { passed: true, reason: '', suggestion: '' };
    }

    default: {
      const _exhaustive: never = requirement.check;
      return {
        passed: false,
        reason: `Unknown check type: ${String(_exhaustive)}`,
        suggestion: 'Use one of: boundingBox, meshCount, connectedComponents, vertexCount, watertight',
      };
    }
  }
};
