// @vitest-environment node
/* eslint-disable max-lines -- comprehensive kernel test suite */
import * as kernelSymbols from '@taucad/types/symbols';
import { describe, it, expect } from 'vitest';
import jscadKernel from '#kernels/jscad/jscad.kernel.js';
import { createGeometryTestHelpers } from '#testing/kernel-geometry-testing.utils.js';
import {
  createGeometryFile,
  createTestWorker,
  createTestGeometry,
  getTestParameters,
} from '#testing/kernel-testing.utils.js';

/* eslint-disable @typescript-eslint/naming-convention -- File names use extensions like 'box.ts' */

// =============================================================================
// Test Utilities
// =============================================================================

/** Create a runtime worker for testing with the provided files. */
const createWorker = async (files: Record<string, string>): ReturnType<typeof createTestWorker> =>
  createTestWorker(jscadKernel, files);

/** Helper to extract parameters and assert success. */
const getParameters = async (
  files: Record<string, string>,
  mainFile: string,
): Promise<{ jsonSchema: unknown; defaultParameters: Record<string, unknown> }> =>
  getTestParameters(jscadKernel, files, mainFile);

/** Helper to create geometry and return the result. */
const createGeometry = async (
  files: Record<string, string>,
  mainFile: string,
  parameters: Record<string, unknown> = {},
): ReturnType<typeof createTestGeometry> => createTestGeometry(jscadKernel, files, mainFile, parameters);

// Create geometry test helpers instance for geometry assertions
const geometryHelpers = createGeometryTestHelpers();

// =============================================================================
// Tests: canHandle - File Type Detection
// =============================================================================

describe('JscadWorker', () => {
  describe('canHandle', () => {
    describe('Should handle files with @jscad/modeling imports', () => {
      it('should handle TypeScript file with named import from @jscad/modeling', async () => {
        const worker = await createWorker({
          'cube.ts': `
            import { primitives } from '@jscad/modeling';
            export default function main() {
              return primitives.cube({ size: 10 });
            }
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('cube.ts'));
        expect(result).toBe(true);
      });

      it('should handle JavaScript file with named import from @jscad/modeling', async () => {
        const worker = await createWorker({
          'cube.js': `
            import { primitives } from '@jscad/modeling';
            export default function main() {
              return primitives.cube({ size: 10 });
            }
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('cube.js'));
        expect(result).toBe(true);
      });

      it('should handle file with namespace import from @jscad/modeling', async () => {
        const worker = await createWorker({
          'cube.ts': `
            import * as jscad from '@jscad/modeling';
            export default function main() {
              return jscad.primitives.cube({ size: 10 });
            }
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('cube.ts'));
        expect(result).toBe(true);
      });

      it('should handle file with require statement for @jscad/modeling', async () => {
        const worker = await createWorker({
          'cube.js': `
            const jscad = require('@jscad/modeling');
            const { cube } = jscad.primitives;
            function main() {
              return cube({ size: 10 });
            }
            module.exports = { main };
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('cube.js'));
        expect(result).toBe(true);
      });

      it('should handle file with destructured require from @jscad/modeling', async () => {
        const worker = await createWorker({
          'cube.js': `
            const { primitives } = require('@jscad/modeling');
            function main() {
              return primitives.cube({ size: 10 });
            }
            module.exports = { main };
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('cube.js'));
        expect(result).toBe(true);
      });
    });

    describe('Should handle files with @jscad/modeling submodule imports', () => {
      it('should handle TypeScript file with import from @jscad/modeling/primitives', async () => {
        const worker = await createWorker({
          'cube.ts': `
            import { cube } from '@jscad/modeling/primitives';

            export default function main() {
              return cube({ size: 10 });
            }
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('cube.ts'));
        expect(result).toBe(true);
      });

      it('should handle file with multiple submodule imports', async () => {
        const worker = await createWorker({
          'main.ts': `
            import { cylinder, polygon } from '@jscad/modeling/primitives';
            import { rotateZ } from '@jscad/modeling/transforms';
            import { extrudeLinear } from '@jscad/modeling/extrusions';
            import { union, subtract } from '@jscad/modeling/booleans';
            import { vec2 } from '@jscad/modeling/maths';
            import { degToRad } from '@jscad/modeling/utils';
            import type { Vec2 } from '@jscad/modeling/maths/vec2';
            import type { Geom3 } from '@jscad/modeling/geometries/geom3';

            export default function main() {
              return cylinder({ height: 10, radius: 5 });
            }
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('main.ts'));
        expect(result).toBe(true);
      });

      it('should handle file with type-only imports alongside submodule value imports', async () => {
        const worker = await createWorker({
          'cube.ts': `
            import { cube } from '@jscad/modeling/primitives';
            import type { Geom3 } from '@jscad/modeling';

            export const defaultParams = { size: 20 };

            export default function main(p = defaultParams): Geom3 {
              return cube({ size: p.size });
            }
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('cube.ts'));
        expect(result).toBe(true);
      });

      it('should handle JavaScript file with require from @jscad/modeling/primitives', async () => {
        const worker = await createWorker({
          'cube.js': `
            const { cube } = require('@jscad/modeling/primitives');

            function main() {
              return cube({ size: 10 });
            }

            module.exports = { main };
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('cube.js'));
        expect(result).toBe(true);
      });
    });

    describe('Should NOT handle files without @jscad/modeling or unsupported extensions', () => {
      it('should not handle TSX file (JSX/TSX not supported)', async () => {
        const worker = await createWorker({
          'component.tsx': `
            import { primitives } from '@jscad/modeling';
            export default function main() {
              return primitives.cube({ size: 10 });
            }
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('component.tsx'));
        expect(result).toBe(false);
      });

      it('should not handle JSX file (JSX/TSX not supported)', async () => {
        const worker = await createWorker({
          'component.jsx': `
            import { primitives } from '@jscad/modeling';
            export default function main() {
              return primitives.cube({ size: 10 });
            }
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('component.jsx'));
        expect(result).toBe(false);
      });

      it('should not handle TypeScript file without @jscad/modeling imports', async () => {
        const worker = await createWorker({
          'utils.ts': `
            export function add(a: number, b: number) { return a + b; }
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('utils.ts'));
        expect(result).toBe(false);
      });

      it('should not handle non-JS/TS file extensions', async () => {
        const worker = await createWorker({
          'model.scad': `
            cube([10, 10, 10]);
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('model.scad'));
        expect(result).toBe(false);
      });

      it('should not handle KCL files', async () => {
        const worker = await createWorker({
          'model.kcl': `
            box = cube([10, 10, 10])
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('model.kcl'));
        expect(result).toBe(false);
      });

      it('should not handle file with replicad imports', async () => {
        const worker = await createWorker({
          'box.ts': `
            import { drawRoundedRectangle } from 'replicad';
            export default function main() {
              return drawRoundedRectangle(50, 30).sketchOnPlane().extrude(10);
            }
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('box.ts'));
        expect(result).toBe(false);
      });
    });
  });

  // ===========================================================================
  // Tests: Parameter Extraction
  // ===========================================================================

  describe('getParametersEntry', () => {
    describe('ESM style - defaultParams export', () => {
      it('should extract defaultParams from exported const', async () => {
        const { jsonSchema, defaultParameters } = await getParameters(
          {
            'cube.ts': `
              import { primitives } from '@jscad/modeling';

              export const defaultParams = {
                size: 20,
              };

              export default function main(p = defaultParams) {
                return primitives.cube({ size: p.size });
              }
            `,
          },
          'cube.ts',
        );

        expect(defaultParameters).toEqual({ size: 20 });
        expect(jsonSchema).toMatchObject({
          type: 'object',
          properties: {
            size: { type: 'integer', default: 20 },
          },
        });
      });

      it('should extract multiple parameters', async () => {
        const { jsonSchema, defaultParameters } = await getParameters(
          {
            'cylinder.ts': `
              import { primitives } from '@jscad/modeling';

              export const defaultParams = {
                height: 20,
                radius: 8,
                segments: 48,
              };

              export default function main(p = defaultParams) {
                return primitives.cylinder({ height: p.height, radius: p.radius, segments: p.segments });
              }
            `,
          },
          'cylinder.ts',
        );

        expect(defaultParameters).toEqual({ height: 20, radius: 8, segments: 48 });
        expect(jsonSchema).toMatchObject({
          type: 'object',
          properties: {
            height: { type: 'integer', default: 20 },
            radius: { type: 'integer', default: 8 },
            segments: { type: 'integer', default: 48 },
          },
        });
      });
    });

    describe('CommonJS style - getParameterDefinitions', () => {
      it('should extract parameters from getParameterDefinitions function', async () => {
        const { jsonSchema, defaultParameters } = await getParameters(
          {
            'gear.js': `
              const jscad = require('@jscad/modeling');
              const { cube } = jscad.primitives;

              const getParameterDefinitions = () => [
                { name: 'numTeeth', caption: 'Number of teeth:', type: 'int', initial: 10, min: 5, max: 20 },
                { name: 'thickness', caption: 'Thickness:', type: 'float', initial: 5, min: 0 },
              ];

              const main = (params) => {
                return cube({ size: params.numTeeth });
              };

              module.exports = { main, getParameterDefinitions };
            `,
          },
          'gear.js',
        );

        expect(defaultParameters).toEqual({ numTeeth: 10, thickness: 5 });
        expect(jsonSchema).toMatchObject({
          type: 'object',
          properties: {
            numTeeth: { type: 'integer', default: 10, minimum: 5, maximum: 20 },
            thickness: { type: 'number', default: 5, minimum: 0 },
          },
        });
      });
    });

    describe('Edge cases', () => {
      it('should return empty parameters for file without defaultParams', async () => {
        const { jsonSchema, defaultParameters } = await getParameters(
          {
            'cube.ts': `
              import { primitives } from '@jscad/modeling';

              export default function main() {
                return primitives.cube({ size: 10 });
              }
            `,
          },
          'cube.ts',
        );

        expect(defaultParameters).toEqual({});
        expect(jsonSchema).toMatchObject({
          type: 'object',
        });
      });

      it('should handle boolean parameters', async () => {
        const { defaultParameters } = await getParameters(
          {
            'cube.ts': `
              import { primitives } from '@jscad/modeling';

              export const defaultParams = {
                centered: true,
              };

              export default function main(p = defaultParams) {
                return primitives.cube({ size: 10, center: [0, 0, 0] });
              }
            `,
          },
          'cube.ts',
        );

        expect(defaultParameters).toEqual({ centered: true });
      });

      it('should handle string parameters', async () => {
        const { defaultParameters } = await getParameters(
          {
            'cube.ts': `
              import { primitives } from '@jscad/modeling';

              export const defaultParams = {
                mode: 'normal',
              };

              export default function main(p = defaultParams) {
                return primitives.cube({ size: 10 });
              }
            `,
          },
          'cube.ts',
        );

        expect(defaultParameters).toEqual({ mode: 'normal' });
      });
    });
  });

  // ===========================================================================
  // Tests: Geometry Computation
  // ===========================================================================

  describe('createGeometryEntry', () => {
    describe('Basic geometry - ESM style', () => {
      it('should compute geometry for a simple cube', async () => {
        const result = await createGeometry(
          {
            'cube.ts': `
              import { primitives } from '@jscad/modeling';

              export default function main() {
                return primitives.cube({ size: 10 });
              }
            `,
          },
          'cube.ts',
        );

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBeDefined();
          expect(Array.isArray(result.data)).toBe(true);
        }

        // Geometry quality assertions (10x10x10 cube)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [0.01, 0.01, 0.01], 0.0005);
      });

      it('should compute geometry with parameters', async () => {
        const result = await createGeometry(
          {
            'cube.ts': `
              import { primitives } from '@jscad/modeling';

              export const defaultParams = { size: 20 };

              export default function main(p = defaultParams) {
                return primitives.cube({ size: p.size });
              }
            `,
          },
          'cube.ts',
          { size: 30 },
        );

        expect(result.success).toBe(true);

        // Geometry should use parameter value (30x30x30 cube)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [0.03, 0.03, 0.03], 0.0005);
      });

      it('should handle JSCAD minimal starter pattern with destructured primitives', async () => {
        // This is the JSCAD minimal starter pattern that uses destructured primitives
        // Note: In production, kernel.machine.ts merges defaultParams with passed parameters.
        // In tests, we pass the default parameters explicitly.
        const result = await createGeometry(
          {
            'main.ts': `
              // JSCAD minimal starter
              // This code requires the @jscad/modeling API at runtime.
              import { primitives } from '@jscad/modeling';
              const { cube } = primitives;

              export const defaultParams = { size: 20 };

              export default function main(p = defaultParams) {
                return cube({ size: p.size });
              }
            `,
          },
          'main.ts',
          { size: 20 }, // Pass default parameters explicitly for tests
        );

        expect(result.success).toBe(true);

        // Geometry should use default parameter value (20x20x20 cube)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [0.02, 0.02, 0.02], 0.0005);
      });

      it('should compute geometry for a cylinder', async () => {
        const result = await createGeometry(
          {
            'cylinder.ts': `
              import { primitives } from '@jscad/modeling';

              export default function main() {
                return primitives.cylinder({ height: 20, radius: 5 });
              }
            `,
          },
          'cylinder.ts',
        );

        expect(result.success).toBe(true);

        // Cylinder: radius 5 (diameter 10), height 20
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [0.01, 0.02, 0.01], 0.0005);
      });

      it('should compute geometry for a sphere', async () => {
        const result = await createGeometry(
          {
            'sphere.ts': `
              import { primitives } from '@jscad/modeling';

              export default function main() {
                return primitives.sphere({ radius: 10 });
              }
            `,
          },
          'sphere.ts',
        );

        expect(result.success).toBe(true);

        // Sphere: radius 10 (diameter 20)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [0.02, 0.02, 0.02], 0.0005);
      });

      it('should handle multiple shapes returned as array', async () => {
        const result = await createGeometry(
          {
            'multi.ts': `
              import { primitives, transforms } from '@jscad/modeling';

              export default function main() {
                const cube1 = primitives.cube({ size: 10 });
                const cube2 = transforms.translate([20, 0, 0], primitives.cube({ size: 10 }));
                return [cube1, cube2];
              }
            `,
          },
          'multi.ts',
        );

        expect(result.success).toBe(true);

        // JSCAD may merge multiple shapes - just verify valid GLTF is produced
        await geometryHelpers.expectValidGltf(result);
      });
    });

    describe('Basic geometry - CommonJS style', () => {
      it('should compute geometry using require syntax', async () => {
        const result = await createGeometry(
          {
            'cube.js': `
              const jscad = require('@jscad/modeling');
              const { cube } = jscad.primitives;

              function main() {
                return cube({ size: 10 });
              }

              module.exports = { main };
            `,
          },
          'cube.js',
        );

        expect(result.success).toBe(true);

        // Geometry quality assertions (10x10x10 cube)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [0.01, 0.01, 0.01], 0.0005);
      });

      it('should handle CommonJS with "use strict" and multiple destructured requires', async () => {
        const result = await createGeometry(
          {
            'gear.js': `
"use strict"

const jscad = require('@jscad/modeling')
const { cylinder, polygon } = jscad.primitives
const { rotateZ } = jscad.transforms
const { extrudeLinear } = jscad.extrusions
const { union, subtract } = jscad.booleans
const { vec2 } = jscad.maths
const { degToRad } = jscad.utils

const getParameterDefinitions = () => [
  { name: 'numTeeth', caption: 'Number of teeth:', type: 'int', initial: 10, min: 5, max: 20 },
  { name: 'circularPitch', caption: 'Circular pitch:', type: 'float', initial: 5 },
  { name: 'thickness', caption: 'Thickness:', type: 'float', initial: 5, min: 0 },
]

const main = (params) => {
  // Simplified gear for test - just a cylinder
  const gear = cylinder({
    height: params.thickness,
    radius: params.numTeeth * params.circularPitch / (2 * Math.PI),
    center: [0, 0, params.thickness / 2],
    segments: 32
  })
  return gear
}

module.exports = { main, getParameterDefinitions }
            `,
          },
          'gear.js',
          { numTeeth: 10, circularPitch: 5, thickness: 5 },
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
      });

      it('should compute geometry with params in CommonJS style', async () => {
        const result = await createGeometry(
          {
            'cube.js': `
              const jscad = require('@jscad/modeling');
              const { cube } = jscad.primitives;

              const getParameterDefinitions = () => [
                { name: 'size', type: 'float', initial: 10 },
              ];

              function main(params) {
                return cube({ size: params.size });
              }

              module.exports = { main, getParameterDefinitions };
            `,
          },
          'cube.js',
          { size: 20 },
        );

        expect(result.success).toBe(true);

        // Geometry should use parameter value (20x20x20 cube)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [0.02, 0.02, 0.02], 0.0005);
      });
    });

    describe('Submodule imports', () => {
      it('should support ESM import from @jscad/modeling/primitives', async () => {
        const result = await createGeometry(
          {
            'cube.ts': `
              import { cuboid } from '@jscad/modeling/primitives';

              export default function main() {
                return cuboid({ size: [10, 10, 10] });
              }
            `,
          },
          'cube.ts',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [0.01, 0.01, 0.01], 0.0005);
      });

      it('should support CJS require of @jscad/modeling/primitives submodule', async () => {
        const result = await createGeometry(
          {
            'cube.js': `
              const { cuboid } = require('@jscad/modeling/primitives');

              function main() {
                return cuboid({ size: [10, 10, 10] });
              }

              module.exports = { main };
            `,
          },
          'cube.js',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [0.01, 0.01, 0.01], 0.0005);
      });

      it('should support mixed root and submodule imports', async () => {
        const result = await createGeometry(
          {
            'mixed.ts': `
              import { primitives } from '@jscad/modeling';
              import { union } from '@jscad/modeling/booleans';

              export default function main() {
                const cube1 = primitives.cube({ size: 10 });
                const cube2 = primitives.cube({ size: 8 });
                return union(cube1, cube2);
              }
            `,
          },
          'mixed.ts',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
      });

      it('should support multiple submodule imports', async () => {
        const result = await createGeometry(
          {
            'multi-sub.ts': `
              import { cuboid } from '@jscad/modeling/primitives';
              import { translate } from '@jscad/modeling/transforms';

              export default function main() {
                const cube1 = cuboid({ size: [10, 10, 10] });
                const cube2 = translate([20, 0, 0], cuboid({ size: [10, 10, 10] }));
                return [cube1, cube2];
              }
            `,
          },
          'multi-sub.ts',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
      });
    });

    describe('Complex geometry', () => {
      it('should handle boolean operations (union)', async () => {
        const result = await createGeometry(
          {
            'union.ts': `
              import { primitives, booleans } from '@jscad/modeling';

              export default function main() {
                const cube1 = primitives.cube({ size: 10 });
                const cube2 = primitives.cube({ size: 8 });
                return booleans.union(cube1, cube2);
              }
            `,
          },
          'union.ts',
        );

        expect(result.success).toBe(true);

        // Boolean union produces 1 mesh (larger cube encompasses smaller)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        // Bounding box is determined by larger cube (10x10x10)
        await geometryHelpers.expectBoundingBoxSize(result, [0.01, 0.01, 0.01], 0.0005);
      });

      it('should handle boolean operations (subtract)', async () => {
        const result = await createGeometry(
          {
            'subtract.ts': `
              import { primitives, booleans } from '@jscad/modeling';

              export default function main() {
                const outer = primitives.cube({ size: 20 });
                const inner = primitives.cube({ size: 15 });
                return booleans.subtract(outer, inner);
              }
            `,
          },
          'subtract.ts',
        );

        expect(result.success).toBe(true);

        // Boolean subtract produces 1 mesh (hollow cube)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        // Outer dimensions remain 20x20x20
        await geometryHelpers.expectBoundingBoxSize(result, [0.02, 0.02, 0.02], 0.0005);
      });

      it('should handle boolean operations (intersect)', async () => {
        const result = await createGeometry(
          {
            'intersect.ts': `
              import { primitives, booleans, transforms } from '@jscad/modeling';

              export default function main() {
                const cube = primitives.cube({ size: 10 });
                const sphere = primitives.sphere({ radius: 7 });
                return booleans.intersect(cube, sphere);
              }
            `,
          },
          'intersect.ts',
        );

        expect(result.success).toBe(true);

        // Boolean intersect produces 1 mesh (cube/sphere intersection)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        // Bounding box is constrained by cube (10x10x10)
        await geometryHelpers.expectBoundingBoxSize(result, [0.01, 0.01, 0.01], 0.0005);
      });

      it('should handle transformations (translate, rotate, scale)', async () => {
        const result = await createGeometry(
          {
            'transformed.ts': `
              import { primitives, transforms } from '@jscad/modeling';

              export default function main() {
                const cube = primitives.cube({ size: 10 });
                const translated = transforms.translate([10, 5, 0], cube);
                const rotated = transforms.rotateZ(Math.PI / 4, translated);
                return transforms.scale([2, 2, 2], rotated);
              }
            `,
          },
          'transformed.ts',
        );

        expect(result.success).toBe(true);

        // Transformation produces 1 mesh (scaled, rotated, translated cube)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
      });

      it('should handle extrusion operations', async () => {
        const result = await createGeometry(
          {
            'extruded.ts': `
              import { primitives, extrusions } from '@jscad/modeling';

              export default function main() {
                const rectangle = primitives.rectangle({ size: [20, 10] });
                return extrusions.extrudeLinear({ height: 15 }, rectangle);
              }
            `,
          },
          'extruded.ts',
        );

        expect(result.success).toBe(true);

        // Extrusion produces 1 mesh (20x10x15 box)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [0.02, 0.015, 0.01], 0.0005);
      });

      it('should handle hull operations', async () => {
        const result = await createGeometry(
          {
            'hull.ts': `
              import { primitives, hulls, transforms } from '@jscad/modeling';

              export default function main() {
                const sphere1 = primitives.sphere({ radius: 5 });
                const sphere2 = transforms.translate([20, 0, 0], primitives.sphere({ radius: 5 }));
                return hulls.hull(sphere1, sphere2);
              }
            `,
          },
          'hull.ts',
        );

        expect(result.success).toBe(true);

        // Hull produces 1 mesh (capsule-like shape)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        // Two spheres at radius 5, 20 apart: total width ~30, height/depth ~10
        await geometryHelpers.expectBoundingBoxSize(result, [0.03, 0.01, 0.01], 0.001);
      });

      it('should handle torus geometry', async () => {
        const result = await createGeometry(
          {
            'torus.ts': `
              import { primitives } from '@jscad/modeling';

              export default function main() {
                return primitives.torus({ innerRadius: 5, outerRadius: 10 });
              }
            `,
          },
          'torus.ts',
        );

        expect(result.success).toBe(true);
      });

      it('should handle roundedCuboid geometry', async () => {
        const result = await createGeometry(
          {
            'rounded.ts': `
              import { primitives } from '@jscad/modeling';

              export default function main() {
                return primitives.roundedCuboid({ size: [20, 15, 10], roundRadius: 2 });
              }
            `,
          },
          'rounded.ts',
        );

        expect(result.success).toBe(true);
      });
    });

    describe('2D geometry', () => {
      it('should handle 2D rectangle', async () => {
        const result = await createGeometry(
          {
            'rect.ts': `
              import { primitives } from '@jscad/modeling';

              export default function main() {
                return primitives.rectangle({ size: [20, 10] });
              }
            `,
          },
          'rect.ts',
        );

        expect(result.success).toBe(true);
      });

      it('should handle 2D circle', async () => {
        const result = await createGeometry(
          {
            'circle.ts': `
              import { primitives } from '@jscad/modeling';

              export default function main() {
                return primitives.circle({ radius: 10 });
              }
            `,
          },
          'circle.ts',
        );

        expect(result.success).toBe(true);
      });
    });

    describe('Error handling', () => {
      it('should return error for syntax errors', async () => {
        const result = await createGeometry(
          {
            'syntax_error.ts': `
              import { primitives } from '@jscad/modeling';

              export default function main() {
                return primitives.cube({ size: 10
              }
            `,
          },
          'syntax_error.ts',
        );

        expect(result.success).toBe(false);
        expect(result.issues).toEqual([
          {
            message: 'Expected ")" but found end of file',
            type: 'compilation',
            severity: 'error',
            location: {
              fileName: 'syntax_error.ts',
              startLineNumber: 7,
              startColumn: 12,
            },
          },
        ]);
      });

      it('should return error for undefined function calls', async () => {
        const result = await createGeometry(
          {
            'undefined_func.ts': `
              import { primitives } from '@jscad/modeling';

              export default function main() {
                return primitives.nonExistentShape({ size: 10 });
              }
            `,
          },
          'undefined_func.ts',
        );

        expect(result.success).toBe(false);
        // Framework/runtime frames have machine-specific paths; filter to user frames only
        const issue = result.issues[0]!;
        const userFrames = issue.stackFrames?.filter((f) => f.context === 'user');
        expect({ ...issue, stackFrames: userFrames }).toEqual(
          expect.objectContaining({
            message: 'primitives.nonExistentShape is not a function',
            type: 'runtime',
            severity: 'error',
            stackFrames: [
              { functionName: 'main', fileName: 'undefined_func.ts', lineNumber: 5, columnNumber: 35, context: 'user' },
            ],
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining returns any
            location: expect.objectContaining({ fileName: 'undefined_func.ts', startLineNumber: 5 }),
          }),
        );
      });

      it('should return error for runtime errors', async () => {
        const result = await createGeometry(
          {
            'runtime_error.ts': `
              import { primitives } from '@jscad/modeling';

              export default function main() {
                throw new Error('Something went wrong');
              }
            `,
          },
          'runtime_error.ts',
        );

        expect(result.success).toBe(false);
        const issue = result.issues[0]!;
        const userFrames = issue.stackFrames?.filter((f) => f.context === 'user');
        expect({ ...issue, stackFrames: userFrames }).toEqual(
          expect.objectContaining({
            message: 'Something went wrong',
            type: 'runtime',
            severity: 'error',
            stackFrames: [
              { functionName: 'main', fileName: 'runtime_error.ts', lineNumber: 5, columnNumber: 23, context: 'user' },
            ],
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining returns any
            location: expect.objectContaining({ fileName: 'runtime_error.ts', startLineNumber: 5 }),
          }),
        );
      });

      it('should return warning when main returns undefined (no return statement)', async () => {
        const result = await createGeometry(
          {
            'no_return.ts': `
              import { primitives } from '@jscad/modeling';

              export default function main() {
                primitives.cube({ size: 10 });
                // Missing return statement
              }
            `,
          },
          'no_return.ts',
        );

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.issues.length).toBeGreaterThan(0);
          expect(result.issues.some((i) => i.severity === 'warning')).toBe(true);
          expect(result.issues.some((i) => i.message.includes('did not return'))).toBe(true);
          // Warning should point to line 1 of the file for navigation
          expect(result.issues[0]?.location).toEqual({ fileName: 'no_return.ts', startLineNumber: 1, startColumn: 1 });
        }
      });

      it('should return warning when main explicitly returns undefined', async () => {
        const result = await createGeometry(
          {
            'explicit_undefined.ts': `
              import { primitives } from '@jscad/modeling';

              export default function main() {
                return undefined;
              }
            `,
          },
          'explicit_undefined.ts',
        );

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.issues.length).toBeGreaterThan(0);
          expect(result.issues.some((i) => i.severity === 'warning')).toBe(true);
          expect(result.issues.some((i) => i.message.includes('did not return'))).toBe(true);
          // Warning should point to line 1 of the file for navigation
          expect(result.issues[0]?.location).toEqual({
            fileName: 'explicit_undefined.ts',
            startLineNumber: 1,
            startColumn: 1,
          });
        }
      });
    });
  });

  // ===========================================================================
  // Tests: Export Geometry
  // ===========================================================================

  describe('exportGeometry', () => {
    it('should export to GLTF format', async () => {
      const worker = await createWorker({
        'cube.ts': `
          import { primitives } from '@jscad/modeling';

          export default function main() {
            return primitives.cube({ size: 10 });
          }
        `,
      });

      // First create geometry
      const geometryFile = createGeometryFile('cube.ts');
      const createResult = await worker[kernelSymbols.createGeometryEntry](geometryFile, {});
      expect(createResult.success).toBe(true);

      // Then export
      const exportResult = await worker[kernelSymbols.exportGeometryEntry]('gltf');
      expect(exportResult.success).toBe(true);
      if (exportResult.success) {
        expect(exportResult.data).toBeDefined();
        expect(exportResult.data.length).toBeGreaterThan(0);
        expect(exportResult.data[0]?.blob).toBeInstanceOf(Blob);
      }
    });

    it('should export to GLB format', async () => {
      // Use a different filename to avoid potential test isolation issues
      const worker = await createWorker({
        'glb_cube.ts': `
          import { primitives } from '@jscad/modeling';

          export default function main() {
            return primitives.cube({ size: 10 });
          }
        `,
      });

      const geometryFile = createGeometryFile('glb_cube.ts');
      const createResult = await worker[kernelSymbols.createGeometryEntry](geometryFile, {});
      expect(createResult.success).toBe(true);

      const exportResult = await worker[kernelSymbols.exportGeometryEntry]('glb');
      expect(exportResult.success).toBe(true);
      if (exportResult.success) {
        expect(exportResult.data.length).toBeGreaterThan(0);
      }
    });

    it('should return error when no geometry computed', async () => {
      const worker = await createWorker({
        'empty.ts': `
          import { primitives } from '@jscad/modeling';

          export default function main() {
            return primitives.cube({ size: 10 });
          }
        `,
      });

      // Don't create geometry, just try to export
      const exportResult = await worker[kernelSymbols.exportGeometryEntry]('gltf');
      expect(exportResult.success).toBe(false);
    });

    it('should return error for unsupported export formats', async () => {
      const worker = await createWorker({
        'cube.ts': `
          import { primitives } from '@jscad/modeling';

          export default function main() {
            return primitives.cube({ size: 10 });
          }
        `,
      });

      const geometryFile = createGeometryFile('cube.ts');
      await worker[kernelSymbols.createGeometryEntry](geometryFile, {});

      // JSCAD only supports gltf/glb
      const exportResult = await worker[kernelSymbols.exportGeometryEntry]('step');
      expect(exportResult.success).toBe(false);
    });
  });

  // ===========================================================================
  // Tests: TypeScript Bundling Support
  // ===========================================================================

  describe('TypeScript bundling', () => {
    describe('Type annotations', () => {
      it('should bundle code with typed function parameters and return types', async () => {
        const result = await createGeometry(
          {
            'typed-cube.ts': `
              import { primitives, type Geom3 } from '@jscad/modeling';

              export const defaultParams = {
                size: 20,
                segments: 32,
              };

              type CubeParams = { size: number; segments: number };

              export default function main(p: CubeParams = defaultParams): Geom3 {
                return primitives.cube({ size: p.size });
              }
            `,
          },
          'typed-cube.ts',
          { size: 20, segments: 32 },
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [0.02, 0.02, 0.02], 0.0005);
      });

      it('should bundle code with type assertions (as)', async () => {
        const result = await createGeometry(
          {
            'assertions.ts': `
              import { primitives, transforms, type Vec3 } from '@jscad/modeling';

              export default function main() {
                const size = 10 as number;
                const offset: Vec3 = [20, 0, 0];
                const cube = primitives.cube({ size });
                return transforms.translate(offset, cube);
              }
            `,
          },
          'assertions.ts',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
      });

      it('should bundle code with const assertions (as const)', async () => {
        const result = await createGeometry(
          {
            'const-assertion.ts': `
              import { primitives } from '@jscad/modeling';

              const config = {
                size: 15,
                center: [0, 0, 0] as const,
              } as const;

              export default function main() {
                return primitives.cuboid({ size: [config.size, config.size, config.size] });
              }
            `,
          },
          'const-assertion.ts',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [0.015, 0.015, 0.015], 0.0005);
      });
    });

    describe('Type-only imports', () => {
      it('should strip import type declarations from @jscad/modeling', async () => {
        const result = await createGeometry(
          {
            'type-import.ts': `
              import { primitives } from '@jscad/modeling';
              import type { Geom3 } from '@jscad/modeling';

              export default function main() {
                const cube: Geom3 = primitives.cube({ size: 10 });
                return cube;
              }
            `,
          },
          'type-import.ts',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [0.01, 0.01, 0.01], 0.0005);
      });

      it('should strip inline type imports (import { type X })', async () => {
        const result = await createGeometry(
          {
            'inline-type.ts': `
              import { primitives, booleans, type Geom3, type Vec3 } from '@jscad/modeling';

              export default function main() {
                const cube1: Geom3 = primitives.cube({ size: 10 });
                const cube2: Geom3 = primitives.cube({ size: 8 });
                return booleans.union(cube1, cube2);
              }
            `,
          },
          'inline-type.ts',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
      });

      it('should strip type imports from submodules', async () => {
        const result = await createGeometry(
          {
            'submodule-type.ts': `
              import { cuboid } from '@jscad/modeling/primitives';
              import type { Geom3 } from '@jscad/modeling';

              export default function main() {
                const cube: Geom3 = cuboid({ size: [10, 10, 10] });
                return cube;
              }
            `,
          },
          'submodule-type.ts',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [0.01, 0.01, 0.01], 0.0005);
      });

      it('should handle Geom3 type import from root with submodule value imports', async () => {
        const result = await createGeometry(
          {
            'geom-type.ts': `
              import { cube } from '@jscad/modeling/primitives';
              import type { Geom3 } from '@jscad/modeling';

              export const defaultParams = { size: 20 };

              export default function main(p = defaultParams): Geom3 {
                return cube({ size: p.size });
              }
            `,
          },
          'geom-type.ts',
          { size: 20 },
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [0.02, 0.02, 0.02], 0.0005);
      });

      it('should handle Geom3 type with multiple submodule value imports', async () => {
        const result = await createGeometry(
          {
            'multi-type.ts': `
              import { cylinder } from '@jscad/modeling/primitives';
              import { subtract } from '@jscad/modeling/booleans';
              import type { Geom3 } from '@jscad/modeling';

              export const defaultParams = { radius: 10, height: 20, holeRadius: 3 };

              export default function main(p = defaultParams): Geom3 {
                const outer = cylinder({ radius: p.radius, height: p.height });
                const inner = cylinder({ radius: p.holeRadius, height: p.height + 2 });
                return subtract(outer, inner);
              }
            `,
          },
          'multi-type.ts',
          { radius: 10, height: 20, holeRadius: 3 },
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
      });

      it('should handle geom3.Geom3 namespace type from @jscad/modeling/geometries (non-standard)', async () => {
        const result = await createGeometry(
          {
            'ns-type.ts': `
              import { cube } from '@jscad/modeling/primitives';
              import type { geom3 } from '@jscad/modeling/geometries';

              export default function main(): geom3.Geom3 {
                return cube({ size: 10 });
              }
            `,
          },
          'ns-type.ts',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [0.01, 0.01, 0.01], 0.0005);
      });
    });

    describe('Interfaces and type aliases', () => {
      it('should bundle code with local interface definitions', async () => {
        const result = await createGeometry(
          {
            'interfaces.ts': `
              import { primitives, transforms, booleans, type Vec3 } from '@jscad/modeling';

              interface CubeConfig {
                size: number;
                offset: Vec3;
              }

              function createOffsetCube(config: CubeConfig) {
                const cube = primitives.cube({ size: config.size });
                return transforms.translate(config.offset, cube);
              }

              export default function main() {
                const cubes: CubeConfig[] = [
                  { size: 10, offset: [0, 0, 0] },
                  { size: 8, offset: [15, 0, 0] },
                ];

                return cubes.map((c) => createOffsetCube(c));
              }
            `,
          },
          'interfaces.ts',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
      });

      it('should bundle code with type aliases and union types', async () => {
        const result = await createGeometry(
          {
            'type-aliases.ts': `
              import { primitives } from '@jscad/modeling';

              type ShapeType = 'cube' | 'sphere' | 'cylinder';
              type Size3D = [number, number, number];

              function createShape(type: ShapeType, size: number) {
                switch (type) {
                  case 'cube':
                    return primitives.cube({ size });
                  case 'sphere':
                    return primitives.sphere({ radius: size / 2 });
                  case 'cylinder':
                    return primitives.cylinder({ height: size, radius: size / 2 });
                }
              }

              export default function main() {
                return createShape('cube', 10);
              }
            `,
          },
          'type-aliases.ts',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [0.01, 0.01, 0.01], 0.0005);
      });
    });

    describe('Generics and advanced TypeScript features', () => {
      it('should bundle code with generic utility functions', async () => {
        const result = await createGeometry(
          {
            'generics.ts': `
              import { primitives } from '@jscad/modeling';

              function withDefaults<T extends Record<string, number>>(
                defaults: T,
                overrides: Partial<T>,
              ): T {
                return { ...defaults, ...overrides };
              }

              const baseParams = { size: 10, segments: 32 };

              export default function main() {
                const p = withDefaults(baseParams, { size: 20 });
                return primitives.cube({ size: p.size });
              }
            `,
          },
          'generics.ts',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [0.02, 0.02, 0.02], 0.0005);
      });

      it('should bundle code with enums', async () => {
        const result = await createGeometry(
          {
            'enums.ts': `
              import { primitives } from '@jscad/modeling';

              enum ShapeKind {
                Cube = 'cube',
                Sphere = 'sphere',
              }

              export default function main() {
                const kind: ShapeKind = ShapeKind.Cube;
                if (kind === ShapeKind.Cube) {
                  return primitives.cube({ size: 10 });
                }
                return primitives.sphere({ radius: 5 });
              }
            `,
          },
          'enums.ts',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [0.01, 0.01, 0.01], 0.0005);
      });

      it('should bundle code with optional chaining and nullish coalescing', async () => {
        const result = await createGeometry(
          {
            'modern-ts.ts': `
              import { primitives } from '@jscad/modeling';

              type Config = {
                shape?: {
                  size?: number;
                  segments?: number;
                };
              };

              export default function main() {
                const config: Config = { shape: { size: 15 } };
                const size = config.shape?.size ?? 10;
                const segments = config.shape?.segments ?? 32;

                return primitives.cube({ size });
              }
            `,
          },
          'modern-ts.ts',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [0.015, 0.015, 0.015], 0.0005);
      });
    });

    describe('Multi-file TypeScript with shared types', () => {
      it('should bundle multi-file project with shared type definitions', async () => {
        const result = await createGeometry(
          {
            'main.ts': `
              import { primitives, booleans } from '@jscad/modeling';
              import type { BoxConfig, SphereConfig } from './types';
              import { createBox, createSphere } from './shapes';

              export default function main() {
                const boxConfig: BoxConfig = { size: [20, 15, 10] };
                const sphereConfig: SphereConfig = { radius: 8 };

                const box = createBox(boxConfig);
                const sphere = createSphere(sphereConfig);
                return booleans.union(box, sphere);
              }
            `,
            'types.ts': `
              export interface BoxConfig {
                size: [number, number, number];
              }

              export interface SphereConfig {
                radius: number;
                segments?: number;
              }

              export type Point3D = [number, number, number];
            `,
            'shapes.ts': `
              import { primitives } from '@jscad/modeling';
              import type { BoxConfig, SphereConfig } from './types';

              export function createBox(config: BoxConfig) {
                return primitives.cuboid({ size: config.size });
              }

              export function createSphere(config: SphereConfig) {
                return primitives.sphere({
                  radius: config.radius,
                  segments: config.segments ?? 32,
                });
              }
            `,
          },
          'main.ts',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
      });

      it('should bundle multi-file project with type-only re-exports', async () => {
        const result = await createGeometry(
          {
            'main.ts': `
              import { primitives, extrusions } from '@jscad/modeling';
              import type { AppParams } from './config';
              import { DEFAULT_PARAMS } from './config';

              export const defaultParams = DEFAULT_PARAMS;

              export default function main(p: AppParams = defaultParams) {
                const rect = primitives.rectangle({ size: [p.width, p.height] });
                return extrusions.extrudeLinear({ height: p.depth }, rect);
              }
            `,
            'config/index.ts': `
              export type { AppParams } from './params';
              export { DEFAULT_PARAMS } from './params';
            `,
            'config/params.ts': `
              export interface AppParams {
                width: number;
                height: number;
                depth: number;
              }

              export const DEFAULT_PARAMS: AppParams = {
                width: 30,
                height: 20,
                depth: 15,
              };
            `,
          },
          'main.ts',
          { width: 30, height: 20, depth: 15 },
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [0.03, 0.015, 0.02], 0.0005);
      });
    });

    describe('Real-world TypeScript CAD patterns', () => {
      it('should bundle a parametric model with full TypeScript features', async () => {
        const result = await createGeometry(
          {
            'main.ts': `
              import { primitives, transforms, booleans, type Geom3, type Vec3 } from '@jscad/modeling';

              interface BracketParams {
                baseWidth: number;
                baseHeight: number;
                baseDepth: number;
                holeRadius: number;
                holeOffset: number;
              }

              export const defaultParams: BracketParams = {
                baseWidth: 40,
                baseHeight: 30,
                baseDepth: 5,
                holeRadius: 3,
                holeOffset: 10,
              };

              function createHole(radius: number, depth: number): Geom3 {
                return primitives.cylinder({ radius, height: depth + 2 });
              }

              export default function main(p: BracketParams = defaultParams): Geom3 {
                // Create the base plate
                const base = primitives.cuboid({
                  size: [p.baseWidth, p.baseHeight, p.baseDepth],
                });

                // Create mounting holes
                const holePositions: Vec3[] = [
                  [-p.holeOffset, -p.holeOffset, 0],
                  [p.holeOffset, -p.holeOffset, 0],
                  [-p.holeOffset, p.holeOffset, 0],
                  [p.holeOffset, p.holeOffset, 0],
                ];

                let result: Geom3 = base;
                for (const pos of holePositions) {
                  const hole = transforms.translate(pos, createHole(p.holeRadius, p.baseDepth));
                  result = booleans.subtract(result, hole);
                }

                return result;
              }
            `,
          },
          'main.ts',
          {
            baseWidth: 40,
            baseHeight: 30,
            baseDepth: 5,
            holeRadius: 3,
            holeOffset: 10,
          },
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [0.04, 0.005, 0.03], 0.0005);
      });

      it('should bundle a multi-file parametric assembly with TypeScript', async () => {
        const result = await createGeometry(
          {
            'main.ts': `
              import { booleans } from '@jscad/modeling';
              import type { AssemblyConfig } from './types';
              import { createBase } from './parts/base';
              import { createPillar } from './parts/pillar';

              export const defaultParams: AssemblyConfig = {
                base: { width: 40, depth: 30, thickness: 5 },
                pillar: { radius: 4, height: 25 },
              };

              export default function main(p: AssemblyConfig = defaultParams) {
                const base = createBase(p.base);
                const pillar = createPillar(p.pillar, p.base.thickness);
                return booleans.union(base, pillar);
              }
            `,
            'types.ts': `
              export interface BaseConfig {
                width: number;
                depth: number;
                thickness: number;
              }

              export interface PillarConfig {
                radius: number;
                height: number;
              }

              export interface AssemblyConfig {
                base: BaseConfig;
                pillar: PillarConfig;
              }
            `,
            'parts/base.ts': `
              import { primitives } from '@jscad/modeling';
              import type { BaseConfig } from '../types';

              export function createBase(config: BaseConfig) {
                return primitives.cuboid({
                  size: [config.width, config.depth, config.thickness],
                });
              }
            `,
            'parts/pillar.ts': `
              import { primitives, transforms } from '@jscad/modeling';
              import type { PillarConfig } from '../types';

              export function createPillar(config: PillarConfig, baseThickness: number) {
                const pillar = primitives.cylinder({
                  radius: config.radius,
                  height: config.height,
                });
                // Position pillar on top of base
                return transforms.translate(
                  [0, 0, baseThickness / 2 + config.height / 2],
                  pillar,
                );
              }
            `,
          },
          'main.ts',
          {
            base: { width: 40, depth: 30, thickness: 5 },
            pillar: { radius: 4, height: 25 },
          },
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
      });
    });
  });
});

/* eslint-enable @typescript-eslint/naming-convention -- End of file */
