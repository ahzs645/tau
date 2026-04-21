import { boundingBoxExpectedSchema } from '#schemas.js';
import type { MeasurementTestRequirement, BoundingBoxExpected } from '#schemas.js';
import type { GeometryStats, CheckResult } from '#geometry/types.js';

const defaultTolerance = 0.1;

/**
 * Default AABB-overlap tolerance (mm) for the `connectedComponents` check.
 * Mirrors the schema description so the prompt copy and the runtime stay in
 * lockstep when the default ever changes.
 * @public
 */
export const defaultConnectedToleranceMm = 0.1;

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

    case 'connectedComponents': {
      const expected = (requirement.expected as { count?: number } | undefined)?.count;
      if (expected === undefined) {
        return { passed: false, reason: 'Missing expected.count', suggestion: 'Add expected: { count: N }' };
      }

      const ccTolerance = requirement.tolerance ?? defaultConnectedToleranceMm;
      const actual = stats.connectedComponents(ccTolerance);
      if (actual !== expected) {
        const raisedTolerance = Math.max(ccTolerance * 10, 1);
        return {
          passed: false,
          reason: `Connected components: expected ${expected}, got ${actual} (tolerance: ${ccTolerance}mm)`,
          suggestion:
            actual > expected
              ? `Got ${actual} disjoint chunks at ${ccTolerance}mm tolerance. If parts visibly touch, ` +
                `raise tolerance (e.g. tolerance: ${raisedTolerance}). If parts are ` +
                `intentionally separate, raise expected.count to ${actual}. If you want them welded ` +
                `into one solid, fuse them in the kernel and assert watertight on the resulting CU.`
              : `Got ${actual} disjoint chunks (fewer than expected). Either lower expected.count to ` +
                `${actual} or split the model so it returns ${expected} top-level shapes.`,
        };
      }

      return { passed: true, reason: '', suggestion: '' };
    }

    case 'watertight': {
      if (!stats.watertight) {
        return {
          passed: false,
          reason: 'Mesh is not watertight (has boundary edges)',
          suggestion:
            'The surface has gaps. If you are asserting on an assembled main.ts that returns ' +
            'multiple ShapeConfigs, move this requirement into each lib/<part>.ts entry instead — ' +
            'multi-part assemblies are watertight per CU, not as one mesh. Otherwise check for ' +
            'failed boolean ops (use screenshot to inspect) or replace Compound with proper fuse.',
        };
      }
      return { passed: true, reason: '', suggestion: '' };
    }

    default: {
      const _exhaustive: never = requirement.check;
      return {
        passed: false,
        reason: `Unknown check type: ${String(_exhaustive)}`,
        suggestion: 'Use one of: boundingBox, connectedComponents, watertight',
      };
    }
  }
};
