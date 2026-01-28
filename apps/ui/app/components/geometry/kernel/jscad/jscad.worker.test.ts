import * as kernelSymbols from '@taucad/types/symbols';
import { describe, it, expect } from 'vitest';
import { JscadWorker } from '#components/geometry/kernel/jscad/jscad.worker.js';
import { createGeometryTestHelpers } from '#components/geometry/kernel/utils/kernel-geometry-testing.utils.js';
import {
  createGeometryFile,
  createTestWorker,
  createTestGeometry,
  getTestParameters,
} from '#components/geometry/kernel/utils/kernel-testing.utils.js';

/* eslint-disable @typescript-eslint/naming-convention -- File names use extensions like 'box.ts' */

// =============================================================================
// Test Utilities
// =============================================================================

/** Create a JscadWorker for testing with the provided files. */
const createWorker = async (files: Record<string, string>): Promise<JscadWorker> =>
  createTestWorker(JscadWorker, files);

/** Helper to extract parameters and assert success. */
const getParameters = async (
  files: Record<string, string>,
  mainFile: string,
): Promise<{ jsonSchema: unknown; defaultParameters: Record<string, unknown> }> =>
  getTestParameters(JscadWorker, files, mainFile);

/** Helper to create geometry and return the result. */
const createGeometry = async (
  files: Record<string, string>,
  mainFile: string,
  parameters: Record<string, unknown> = {},
): ReturnType<typeof createTestGeometry> => createTestGeometry(JscadWorker, files, mainFile, parameters);

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
        await geometryHelpers.expectBoundingBoxSize(result, [10, 10, 10], 0.5);
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
        await geometryHelpers.expectBoundingBoxSize(result, [30, 30, 30], 0.5);
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
        await geometryHelpers.expectBoundingBoxSize(result, [10, 10, 20], 0.5);
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
        await geometryHelpers.expectBoundingBoxSize(result, [20, 20, 20], 0.5);
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
        await geometryHelpers.expectBoundingBoxSize(result, [10, 10, 10], 0.5);
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
        await geometryHelpers.expectBoundingBoxSize(result, [20, 20, 20], 0.5);
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
        await geometryHelpers.expectBoundingBoxSize(result, [10, 10, 10], 0.5);
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
        await geometryHelpers.expectBoundingBoxSize(result, [20, 20, 20], 0.5);
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
        await geometryHelpers.expectBoundingBoxSize(result, [10, 10, 10], 0.5);
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
        await geometryHelpers.expectBoundingBoxSize(result, [20, 10, 15], 0.5);
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
        await geometryHelpers.expectBoundingBoxSize(result, [30, 10, 10], 1);
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
});

/* eslint-enable @typescript-eslint/naming-convention -- End of file */
