// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { createRuntimeClient } from '@taucad/runtime';
import { createInProcessTransport } from '@taucad/runtime/transport';
import { replicad } from '@taucad/runtime/kernels';
import { esbuild } from '@taucad/runtime/bundler';
import type { MeasurementTestRequirement } from '#schemas.js';
import { analyzeGlb } from '#geometry/analyze-glb.js';
import { evaluateRequirement } from '#geometry/evaluate-requirement.js';
import type { GeometryStats } from '#geometry/types.js';

async function renderGlb(filename: string, code: string): Promise<Uint8Array<ArrayBuffer>> {
  const client = createRuntimeClient({
    kernels: [replicad()],
    bundlers: [esbuild()],
    transport: createInProcessTransport(),
  });

  try {
    const result = await client.render({ code: { [filename]: code }, file: filename });
    if (!result.success) {
      throw new Error(`Render failed: ${result.issues.map((i) => i.message).join('; ')}`);
    }
    const gltf = result.data.find((g) => g.format === 'gltf');
    if (!gltf) {
      throw new Error('No GLTF geometry in render result');
    }
    return gltf.content;
  } finally {
    client.terminate();
  }
}

const boxCode = `
  import { makeBaseBox } from 'replicad';
  export default function main() {
    return makeBaseBox(10, 20, 30);
  }
`;

describe('evaluateRequirement', () => {
  let boxStats: GeometryStats;

  beforeAll(async () => {
    const glb = await renderGlb('box.ts', boxCode);
    boxStats = await analyzeGlb(glb);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Bounding box checks
  // ---------------------------------------------------------------------------

  describe('boundingBox', () => {
    it('should pass for correct dimensions', () => {
      const requirement: MeasurementTestRequirement = {
        id: 'bb1',
        description: 'box size',
        type: 'measurement',
        check: 'boundingBox',
        expected: { size: { x: 0.01, y: 0.03, z: 0.02 } },
      };

      const result = evaluateRequirement(requirement, boxStats);
      expect(result.passed).toBe(true);
    });

    it('should fail for wrong dimensions', () => {
      const requirement: MeasurementTestRequirement = {
        id: 'bb1',
        description: 'wrong size',
        type: 'measurement',
        check: 'boundingBox',
        expected: { size: { x: 99, y: 99, z: 99 } },
      };

      const result = evaluateRequirement(requirement, boxStats);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Bounding box mismatch');
    });

    it('should accept a single axis (partial check)', () => {
      const requirement: MeasurementTestRequirement = {
        id: 'bb_x',
        description: 'x only',
        type: 'measurement',
        check: 'boundingBox',
        expected: { size: { x: 0.01 } },
      };

      const result = evaluateRequirement(requirement, boxStats);
      expect(result.passed).toBe(true);
    });

    it('should respect custom tolerance', () => {
      const requirement: MeasurementTestRequirement = {
        id: 'bb1',
        description: 'loose tolerance',
        type: 'measurement',
        check: 'boundingBox',
        expected: { size: { x: 0.011, y: 0.031, z: 0.021 } },
        tolerance: 0.01,
      };

      const result = evaluateRequirement(requirement, boxStats);
      expect(result.passed).toBe(true);
    });

    it('should fail when expected has no size or center', () => {
      const requirement: MeasurementTestRequirement = {
        id: 'bb1',
        description: 'empty',
        type: 'measurement',
        check: 'boundingBox',
        expected: {},
      };

      const result = evaluateRequirement(requirement, boxStats);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('requires at least size or center');
    });

    it('should fail when no bounding box in stats', () => {
      const noBboxStats: GeometryStats = {
        ...boxStats,
        boundingBox: undefined,
      };
      const requirement: MeasurementTestRequirement = {
        id: 'bb1',
        description: 'no bbox',
        type: 'measurement',
        check: 'boundingBox',
        expected: { size: { x: 1 } },
      };

      const result = evaluateRequirement(requirement, noBboxStats);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('No bounding box available');
    });
  });

  // ---------------------------------------------------------------------------
  // Connected components
  // ---------------------------------------------------------------------------

  describe('connectedComponents', () => {
    it('should pass for correct count using the default tolerance', () => {
      const requirement: MeasurementTestRequirement = {
        id: 'cc1',
        description: 'single solid',
        type: 'measurement',
        check: 'connectedComponents',
        expected: { count: 1 },
      };

      expect(evaluateRequirement(requirement, boxStats).passed).toBe(true);
    });

    it('should call the connectedComponents getter with the default tolerance (0.1mm) when omitted', () => {
      const calls: number[] = [];
      const stubStats: GeometryStats = {
        ...boxStats,
        connectedComponents: (toleranceMm) => {
          calls.push(toleranceMm);
          return 1;
        },
      };
      const requirement: MeasurementTestRequirement = {
        id: 'cc_default',
        description: 'default tolerance',
        type: 'measurement',
        check: 'connectedComponents',
        expected: { count: 1 },
      };

      evaluateRequirement(requirement, stubStats);
      expect(calls).toEqual([0.1]);
    });

    it('should forward a custom tolerance through to the connectedComponents getter', () => {
      const calls: number[] = [];
      const stubStats: GeometryStats = {
        ...boxStats,
        connectedComponents: (toleranceMm) => {
          calls.push(toleranceMm);
          return 1;
        },
      };
      const requirement: MeasurementTestRequirement = {
        id: 'cc_custom',
        description: 'custom tolerance',
        type: 'measurement',
        check: 'connectedComponents',
        expected: { count: 1 },
        tolerance: 50,
      };

      evaluateRequirement(requirement, stubStats);
      expect(calls).toEqual([50]);
    });

    it('should produce the rich failure suggestion when actual exceeds expected', () => {
      const stubStats: GeometryStats = {
        ...boxStats,
        connectedComponents: () => 3,
      };
      const requirement: MeasurementTestRequirement = {
        id: 'cc_fail',
        description: 'should be fused',
        type: 'measurement',
        check: 'connectedComponents',
        expected: { count: 1 },
      };

      const result = evaluateRequirement(requirement, stubStats);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('expected 1, got 3 (tolerance: 0.1mm)');
      expect(result.suggestion).toContain('disjoint chunks at 0.1mm tolerance');
      expect(result.suggestion).toContain('raise tolerance');
      expect(result.suggestion).toContain('raise expected.count to 3');
      expect(result.suggestion).toContain('fuse them in the kernel and assert watertight');
    });

    it('should produce the lower-than-expected failure suggestion when actual is below expected', () => {
      const stubStats: GeometryStats = {
        ...boxStats,
        connectedComponents: () => 1,
      };
      const requirement: MeasurementTestRequirement = {
        id: 'cc_low',
        description: 'expected too many parts',
        type: 'measurement',
        check: 'connectedComponents',
        expected: { count: 4 },
      };

      const result = evaluateRequirement(requirement, stubStats);
      expect(result.passed).toBe(false);
      expect(result.suggestion).toContain('lower expected.count to 1');
      expect(result.suggestion).toContain('split the model so it returns 4 top-level shapes');
    });

    it('should fail when expected.count is missing', () => {
      const requirement: MeasurementTestRequirement = {
        id: 'cc1',
        description: 'missing count',
        type: 'measurement',
        check: 'connectedComponents',
        expected: {},
      };

      const result = evaluateRequirement(requirement, boxStats);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Missing expected.count');
    });
  });

  // ---------------------------------------------------------------------------
  // Watertight
  // ---------------------------------------------------------------------------

  describe('watertight', () => {
    it('should pass for watertight mesh', () => {
      const requirement: MeasurementTestRequirement = {
        id: 'wt1',
        description: 'is watertight',
        type: 'measurement',
        check: 'watertight',
      };

      expect(evaluateRequirement(requirement, boxStats).passed).toBe(true);
    });

    it('should fail for non-watertight mesh and surface the per-CU lib/<part>.ts hint', () => {
      const openStats: GeometryStats = { ...boxStats, watertight: false };
      const requirement: MeasurementTestRequirement = {
        id: 'wt1',
        description: 'is watertight',
        type: 'measurement',
        check: 'watertight',
      };

      const result = evaluateRequirement(requirement, openStats);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('not watertight');
      expect(result.suggestion).toContain('lib/<part>.ts');
      expect(result.suggestion).toContain('multi-part assemblies are watertight per CU');
      expect(result.suggestion).toContain('failed boolean ops');
    });
  });

  // ---------------------------------------------------------------------------
  // Unknown check type
  // ---------------------------------------------------------------------------

  describe('unknown check type', () => {
    it('should report failure for unrecognised check and list only the surviving 3-check vocabulary', () => {
      const requirement = {
        id: 'u1',
        description: 'unknown',
        type: 'measurement',
        check: 'nonExistent' as 'boundingBox',
      } as const;

      const result = evaluateRequirement(requirement, boxStats);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Unknown check type');
      expect(result.suggestion).toBe('Use one of: boundingBox, connectedComponents, watertight');
    });
  });
});
