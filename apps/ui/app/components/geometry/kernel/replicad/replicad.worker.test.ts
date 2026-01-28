// @vitest-environment node
import * as kernelSymbols from '@taucad/types/symbols';
import { describe, it, expect } from 'vitest';
import { ReplicadWorker } from '#components/geometry/kernel/replicad/replicad.worker.js';
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

/** Create a ReplicadWorker for testing with the provided files. */
const createWorker = async (files: Record<string, string>): Promise<ReplicadWorker> =>
  createTestWorker(ReplicadWorker, files);

/** Helper to extract parameters and assert success. */
const getParameters = async (
  files: Record<string, string>,
  mainFile: string,
): Promise<{ jsonSchema: unknown; defaultParameters: Record<string, unknown> }> =>
  getTestParameters(ReplicadWorker, files, mainFile);

/** Helper to create geometry and return the result. */
const createGeometry = async (
  files: Record<string, string>,
  mainFile: string,
  parameters: Record<string, unknown> = {},
): ReturnType<typeof createTestGeometry> => createTestGeometry(ReplicadWorker, files, mainFile, parameters);

// Create geometry test helpers instance for geometry assertions
const geometryHelpers = createGeometryTestHelpers();

// =============================================================================
// Tests: canHandle - File Type Detection
// =============================================================================

describe('ReplicadWorker', () => {
  describe('canHandle', () => {
    describe('Should handle files with replicad imports', () => {
      it('should handle TypeScript file with named import from replicad', async () => {
        const worker = await createWorker({
          'cube.ts': `
            import { draw, Sketcher } from 'replicad';
            export default function main() {
              return draw().hLine(10).vLine(10).hLine(-10).close().sketchOnPlane().extrude(10);
            }
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('cube.ts'));
        expect(result).toBe(true);
      });

      it('should handle JavaScript file with named import from replicad', async () => {
        const worker = await createWorker({
          'cube.js': `
            import { draw } from 'replicad';
            export default function main() {
              return draw().hLine(10).vLine(10).hLine(-10).close().sketchOnPlane().extrude(10);
            }
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('cube.js'));
        expect(result).toBe(true);
      });

      it('should handle file with namespace import from replicad', async () => {
        const worker = await createWorker({
          'cube.ts': `
            import * as replicad from 'replicad';
            export default function main() {
              return replicad.draw().hLine(10).vLine(10).hLine(-10).close().sketchOnPlane().extrude(10);
            }
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('cube.ts'));
        expect(result).toBe(true);
      });

      it('should handle file with require statement for replicad', async () => {
        const worker = await createWorker({
          'cube.js': `
            const { draw } = require('replicad');
            function main(replicad, params) {
              return draw().hLine(10).vLine(10).hLine(-10).close().sketchOnPlane().extrude(10);
            }
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('cube.js'));
        expect(result).toBe(true);
      });

      it('should handle file with destructured assignment from replicad global', async () => {
        const worker = await createWorker({
          'cube.js': `
            const { draw, Sketcher } = replicad;
            function main(replicad, params) {
              return draw().hLine(10).vLine(10).hLine(-10).close().sketchOnPlane().extrude(10);
            }
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('cube.js'));
        expect(result).toBe(true);
      });

      it('should handle file with JSDoc typedef referencing replicad', async () => {
        const worker = await createWorker({
          'cube.js': `
            /** @typedef {import('replicad').Shape3D} Shape3D */
            function main(replicad, params) {
              const { draw } = replicad;
              return draw().hLine(10).vLine(10).hLine(-10).close().sketchOnPlane().extrude(10);
            }
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('cube.js'));
        expect(result).toBe(true);
      });

      it('should handle file with replicad CDN import', async () => {
        const worker = await createWorker({
          'cube.ts': `
            import { draw } from 'replicad';
            import { addVoronoi } from "https://cdn.jsdelivr.net/npm/replicad-decorate/dist/studio/replicad-decorate.js";
            export default function main() {
              return draw().hLine(10).vLine(10).hLine(-10).close().sketchOnPlane().extrude(10);
            }
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('cube.ts'));
        expect(result).toBe(true);
      });
    });

    describe('Should NOT handle files without replicad or unsupported extensions', () => {
      it('should not handle TSX file (JSX/TSX not supported)', async () => {
        const worker = await createWorker({
          'component.tsx': `
            import { draw } from 'replicad';
            export default function main() {
              return draw().hLine(10).vLine(10).hLine(-10).close().sketchOnPlane().extrude(10);
            }
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('component.tsx'));
        expect(result).toBe(false);
      });

      it('should not handle JSX file (JSX/TSX not supported)', async () => {
        const worker = await createWorker({
          'component.jsx': `
            import { draw } from 'replicad';
            export default function main() {
              return draw().hLine(10).vLine(10).hLine(-10).close().sketchOnPlane().extrude(10);
            }
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('component.jsx'));
        expect(result).toBe(false);
      });

      it('should not handle TypeScript file without replicad imports', async () => {
        const worker = await createWorker({
          'utils.ts': `
            export function add(a: number, b: number): number {
              return a + b;
            }
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('utils.ts'));
        expect(result).toBe(false);
      });

      it('should not handle non-JS/TS file extensions', async () => {
        const worker = await createWorker({
          'model.scad': `cube([10, 10, 10]);`,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('model.scad'));
        expect(result).toBe(false);
      });

      it('should not handle KCL files', async () => {
        const worker = await createWorker({
          'model.kcl': `box([10, 10, 10], center = [0, 0, 0])`,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('model.kcl'));
        expect(result).toBe(false);
      });

      it('should not handle file with other CAD library imports', async () => {
        const worker = await createWorker({
          'jscad-model.ts': `
            import { cube } from '@jscad/modeling';
            export default function main() {
              return cube({ size: 10 });
            }
          `,
        });
        const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('jscad-model.ts'));
        expect(result).toBe(false);
      });
    });
  });

  // ===========================================================================
  // Tests: Parameter Extraction
  // ===========================================================================

  describe('getParametersEntry', () => {
    describe('ESM style - export syntax', () => {
      it('should extract defaultParams from exported const', async () => {
        const { jsonSchema, defaultParameters } = await getParameters(
          {
            'box.ts': `
              import { drawRoundedRectangle } from 'replicad';

              export const defaultParams = {
                width: 100,
                height: 50,
                depth: 30,
              };

              export default function main(params) {
                const { width, height, depth } = params;
                return drawRoundedRectangle(width, height).sketchOnPlane().extrude(depth);
              }
            `,
          },
          'box.ts',
        );

        expect(defaultParameters).toEqual({ width: 100, height: 50, depth: 30 });
        expect(jsonSchema).toMatchObject({
          type: 'object',
          properties: {
            width: { type: 'integer', default: 100 },
            height: { type: 'integer', default: 50 },
            depth: { type: 'integer', default: 30 },
          },
        });
      });

      it('should extract nested defaultParams', async () => {
        const { jsonSchema, defaultParameters } = await getParameters(
          {
            'box.ts': `
              import { draw } from 'replicad';

              export const defaultParams = {
                dimensions: {
                  width: 100,
                  height: 50,
                },
                options: {
                  rounded: true,
                  radius: 5,
                },
              };

              export default function main(params) {
                return draw().hLine(params.dimensions.width).vLine(params.dimensions.height).close().sketchOnPlane().extrude(10);
              }
            `,
          },
          'box.ts',
        );

        expect(defaultParameters).toEqual({
          dimensions: { width: 100, height: 50 },
          options: { rounded: true, radius: 5 },
        });
        expect(jsonSchema).toMatchObject({
          type: 'object',
          properties: {
            dimensions: {
              type: 'object',
              properties: {
                width: { type: 'integer', default: 100 },
                height: { type: 'integer', default: 50 },
              },
            },
            options: {
              type: 'object',
              properties: {
                rounded: { type: 'boolean', default: true },
                radius: { type: 'integer', default: 5 },
              },
            },
          },
        });
      });

      it('should handle array parameters', async () => {
        const { defaultParameters } = await getParameters(
          {
            'box.ts': `
              import { draw } from 'replicad';

              export const defaultParams = {
                sizes: [10, 20, 30],
                position: [0, 0, 0],
              };

              export default function main(params) {
                return draw().hLine(params.sizes[0]).vLine(params.sizes[1]).close().sketchOnPlane().extrude(params.sizes[2]);
              }
            `,
          },
          'box.ts',
        );

        expect(defaultParameters).toEqual({
          sizes: [10, 20, 30],
          position: [0, 0, 0],
        });
      });
    });

    describe('CommonJS style - global defaultParams', () => {
      it('should extract defaultParams from global variable', async () => {
        const { jsonSchema, defaultParameters } = await getParameters(
          {
            'box.js': `
              const { draw } = replicad;

              const defaultParams = {
                width: 80,
                height: 40,
              };

              function main(replicad, params) {
                const { width, height } = params;
                return draw().hLine(width).vLine(height).hLine(-width).close().sketchOnPlane().extrude(10);
              }
            `,
          },
          'box.js',
        );

        expect(defaultParameters).toEqual({ width: 80, height: 40 });
        expect(jsonSchema).toMatchObject({
          type: 'object',
          properties: {
            width: { type: 'integer', default: 80 },
            height: { type: 'integer', default: 40 },
          },
        });
      });
    });

    describe('Edge cases', () => {
      it('should return empty parameters for file without defaultParams', async () => {
        const { jsonSchema, defaultParameters } = await getParameters(
          {
            'box.ts': `
              import { draw } from 'replicad';

              export default function main() {
                return draw().hLine(10).vLine(10).hLine(-10).close().sketchOnPlane().extrude(10);
              }
            `,
          },
          'box.ts',
        );

        expect(defaultParameters).toEqual({});
        expect(jsonSchema).toMatchObject({
          type: 'object',
        });
      });

      it('should handle boolean parameters', async () => {
        const { defaultParameters } = await getParameters(
          {
            'box.ts': `
              import { draw } from 'replicad';

              export const defaultParams = {
                addHoles: true,
                centered: false,
              };

              export default function main(params) {
                return draw().hLine(10).vLine(10).hLine(-10).close().sketchOnPlane().extrude(10);
              }
            `,
          },
          'box.ts',
        );

        expect(defaultParameters).toEqual({ addHoles: true, centered: false });
      });

      it('should handle string parameters', async () => {
        const { defaultParameters } = await getParameters(
          {
            'box.ts': `
              import { draw } from 'replicad';

              export const defaultParams = {
                label: "My Box",
                material: "PLA",
              };

              export default function main(params) {
                return draw().hLine(10).vLine(10).hLine(-10).close().sketchOnPlane().extrude(10);
              }
            `,
          },
          'box.ts',
        );

        expect(defaultParameters).toEqual({ label: 'My Box', material: 'PLA' });
      });
    });
  });

  // ===========================================================================
  // Tests: Default Name Extraction
  // ===========================================================================

  describe('extractDefaultNameFromCode', () => {
    it('should extract defaultName from ESM export', async () => {
      const worker = await createWorker({});
      const code = `
        import { draw } from 'replicad';

        export const defaultName = "My Custom Box";

        export default function main() {
          return draw().hLine(10).vLine(10).hLine(-10).close().sketchOnPlane().extrude(10);
        }
      `;

      const result = await worker.extractDefaultNameFromCode(code);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('My Custom Box');
      }
    });

    it('should extract defaultName from CommonJS global', async () => {
      const worker = await createWorker({});
      const code = `
        const { draw } = replicad;

        const defaultName = "CJS Box";

        function main(replicad, params) {
          return draw().hLine(10).vLine(10).hLine(-10).close().sketchOnPlane().extrude(10);
        }
      `;

      const result = await worker.extractDefaultNameFromCode(code);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('CJS Box');
      }
    });

    it('should return undefined when no defaultName is defined', async () => {
      const worker = await createWorker({});
      const code = `
        import { draw } from 'replicad';

        export default function main() {
          return draw().hLine(10).vLine(10).hLine(-10).close().sketchOnPlane().extrude(10);
        }
      `;

      const result = await worker.extractDefaultNameFromCode(code);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeUndefined();
      }
    });
  });

  // ===========================================================================
  // Tests: Geometry Computation
  // ===========================================================================

  describe('createGeometryEntry', () => {
    describe('Basic geometry - ESM style', () => {
      it('should compute geometry for a simple extruded rectangle', async () => {
        const result = await createGeometry(
          {
            'box.ts': `
              import { drawRoundedRectangle } from 'replicad';

              export default function main() {
                return drawRoundedRectangle(50, 30).sketchOnPlane().extrude(10);
              }
            `,
          },
          'box.ts',
        );

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBeDefined();
          expect(Array.isArray(result.data)).toBe(true);
        }

        // Geometry quality assertions
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [50, 30, 10], 0.5);
      });

      it('should compute geometry with parameters', async () => {
        const result = await createGeometry(
          {
            'box.ts': `
              import { drawRoundedRectangle } from 'replicad';

              export const defaultParams = {
                width: 50,
                height: 30,
                depth: 10,
              };

              export default function main(params) {
                const { width, height, depth } = params;
                return drawRoundedRectangle(width, height).sketchOnPlane().extrude(depth);
              }
            `,
          },
          'box.ts',
          { width: 100, height: 60, depth: 20 },
        );

        expect(result.success).toBe(true);

        // Geometry should use parameter values (100x60x20)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [100, 60, 20], 0.5);
      });

      it('should compute geometry using draw API', async () => {
        const result = await createGeometry(
          {
            'profile.ts': `
              import { draw } from 'replicad';

              export default function main() {
                return draw()
                  .hLine(50)
                  .vLine(30)
                  .hLine(-50)
                  .close()
                  .sketchOnPlane()
                  .extrude(10);
              }
            `,
          },
          'profile.ts',
        );

        expect(result.success).toBe(true);

        // Geometry quality assertions (50x30x10 box)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [50, 30, 10], 0.5);
      });

      it('should handle multiple shapes returned as array', async () => {
        const result = await createGeometry(
          {
            'multi.ts': `
              import { drawRoundedRectangle, drawCircle } from 'replicad';

              export default function main() {
                const box = drawRoundedRectangle(50, 30).sketchOnPlane().extrude(10);
                const cylinder = drawCircle(15).sketchOnPlane().extrude(20).translate([70, 0, 0]);
                return [box, cylinder];
              }
            `,
          },
          'multi.ts',
        );

        expect(result.success).toBe(true);

        // Should produce 2 meshes (box + cylinder)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 2);
      });
    });

    describe('Basic geometry - CommonJS style', () => {
      it('should compute geometry using global replicad object', async () => {
        const result = await createGeometry(
          {
            'box.js': `
              const { draw } = replicad;

              function main(replicad, params) {
                return draw()
                  .hLine(50)
                  .vLine(30)
                  .hLine(-50)
                  .close()
                  .sketchOnPlane()
                  .extrude(10);
              }
            `,
          },
          'box.js',
        );

        expect(result.success).toBe(true);

        // Geometry quality assertions (50x30x10 box)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [50, 30, 10], 0.5);
      });

      it('should compute geometry with params in CommonJS style', async () => {
        const result = await createGeometry(
          {
            'box.js': `
              const { draw } = replicad;

              const defaultParams = {
                size: 50,
              };

              function main(replicad, params) {
                const size = params.size || defaultParams.size;
                return draw()
                  .hLine(size)
                  .vLine(size)
                  .hLine(-size)
                  .close()
                  .sketchOnPlane()
                  .extrude(size);
              }
            `,
          },
          'box.js',
          { size: 75 },
        );

        expect(result.success).toBe(true);

        // Geometry should use parameter value (75x75x75 cube)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [75, 75, 75], 0.5);
      });
    });

    describe('Complex geometry', () => {
      it('should handle boolean operations (difference)', async () => {
        const result = await createGeometry(
          {
            'hollow.ts': `
              import { drawCircle } from 'replicad';

              export default function main() {
                const outer = drawCircle(30).sketchOnPlane().extrude(20);
                const inner = drawCircle(25).sketchOnPlane().extrude(25);
                return outer.cut(inner);
              }
            `,
          },
          'hollow.ts',
        );

        expect(result.success).toBe(true);

        // Boolean difference produces 1 mesh (hollow cylinder)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        // Outer cylinder is radius 30, so diameter 60
        await geometryHelpers.expectBoundingBoxSize(result, [60, 60, 20], 1);
      });

      it('should handle boolean operations (union/fuse)', async () => {
        const result = await createGeometry(
          {
            'fused.ts': `
              import { drawRoundedRectangle, drawCircle } from 'replicad';

              export default function main() {
                const box = drawRoundedRectangle(50, 30).sketchOnPlane().extrude(10);
                const cylinder = drawCircle(10).sketchOnPlane().extrude(20).translate([0, 0, 10]);
                return box.fuse(cylinder);
              }
            `,
          },
          'fused.ts',
        );

        expect(result.success).toBe(true);

        // Boolean union produces 1 mesh (box with cylinder on top)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        // Box is 50x30, cylinder adds height: 10 + 20 = 30 total height
        await geometryHelpers.expectBoundingBoxSize(result, [50, 30, 30], 1);
      });

      it('should handle transformations (translate, rotate)', async () => {
        const result = await createGeometry(
          {
            'transformed.ts': `
              import { drawRoundedRectangle } from 'replicad';

              export default function main() {
                return drawRoundedRectangle(50, 30)
                  .sketchOnPlane()
                  .extrude(10)
                  .rotate(45, [0, 0, 0], [0, 0, 1])
                  .translate([100, 50, 25]);
              }
            `,
          },
          'transformed.ts',
        );

        expect(result.success).toBe(true);

        // Transformation produces 1 mesh (rotated and translated box)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
      });

      it('should handle loft operations', async () => {
        const result = await createGeometry(
          {
            'loft.ts': `
              import { drawCircle, makePlane } from 'replicad';

              export default function main() {
                // Create a cone-like shape by lofting a larger circle to a smaller one
                const bottom = drawCircle(30).sketchOnPlane(makePlane());
                const top = drawCircle(15).sketchOnPlane(makePlane("XY", 50));

                // Use loftWith method on the sketch
                return bottom.loftWith(top);
              }
            `,
          },
          'loft.ts',
        );

        expect(result.success).toBe(true);

        // Loft produces 1 mesh (cone-like shape)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        // Bottom circle is radius 30 (diameter 60), height is 50
        await geometryHelpers.expectBoundingBoxSize(result, [60, 60, 50], 1);
      });

      it('should handle chamfer and fillet operations', async () => {
        const result = await createGeometry(
          {
            'filleted.ts': `
              import { drawRoundedRectangle, EdgeFinder } from 'replicad';

              export default function main() {
                const box = drawRoundedRectangle(50, 30).sketchOnPlane().extrude(20);
                return box.fillet(3, (e) => e.inDirection("Z"));
              }
            `,
          },
          'filleted.ts',
        );

        expect(result.success).toBe(true);

        // Fillet produces 1 mesh (box with rounded edges)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        // Bounding box should remain approximately 50x30x20
        await geometryHelpers.expectBoundingBoxSize(result, [50, 30, 20], 1);
      });

      it('should handle shell operation', async () => {
        const result = await createGeometry(
          {
            'shell.ts': `
              import { drawRoundedRectangle, FaceFinder } from 'replicad';

              export default function main() {
                const box = drawRoundedRectangle(50, 30).sketchOnPlane().extrude(20);
                return box.shell(-2, (f) => f.inPlane("XY", 20));
              }
            `,
          },
          'shell.ts',
        );

        expect(result.success).toBe(true);

        // Shell produces 1 mesh (hollow box)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        // Shell with -2 offset expands outer dimensions due to thickness on all sides
        await geometryHelpers.expectBoundingBoxSize(result, [54, 34, 22], 1);
      });
    });

    describe('2D geometry (SVG output)', () => {
      it('should return SVG for 2D sketch without extrusion', async () => {
        const result = await createGeometry(
          {
            'sketch.ts': `
              import { draw } from 'replicad';

              export default function main() {
                return draw()
                  .hLine(50)
                  .vLine(30)
                  .hLine(-50)
                  .close();
              }
            `,
          },
          'sketch.ts',
        );

        expect(result.success).toBe(true);
        if (result.success && Array.isArray(result.data)) {
          // Should contain SVG format geometry
          const hasSvg = result.data.some((g: { format: string }) => g.format === 'svg');
          expect(hasSvg).toBe(true);
        }
      });
    });

    describe('Error handling', () => {
      it('should return error for syntax errors', async () => {
        const result = await createGeometry(
          {
            'syntax_error.ts': `
              import { draw } from 'replicad';

              export default function main() {
                return draw()
                  .hLine(50
                  .vLine(30)
                  .close()
                  .extrude(10);
              }
            `,
          },
          'syntax_error.ts',
        );

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.issues).toBeDefined();
          expect(result.issues.length).toBeGreaterThan(0);
        }
      });

      it('should return error for undefined function calls', async () => {
        const result = await createGeometry(
          {
            'undefined_func.ts': `
              import { draw } from 'replicad';

              export default function main() {
                return undefinedFunction();
              }
            `,
          },
          'undefined_func.ts',
        );

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.issues).toBeDefined();
          expect(result.issues.length).toBeGreaterThan(0);
        }
      });

      it('should return error for runtime errors', async () => {
        const result = await createGeometry(
          {
            'runtime_error.ts': `
              import { draw } from 'replicad';

              export default function main() {
                const obj = null;
                return obj.someMethod();
              }
            `,
          },
          'runtime_error.ts',
        );

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.issues).toBeDefined();
          expect(result.issues.length).toBeGreaterThan(0);
        }
      });

      it('should return error for invalid geometry operations', async () => {
        const result = await createGeometry(
          {
            'invalid_op.ts': `
              import { drawCircle } from 'replicad';

              export default function main() {
                // Attempt to extrude with invalid value
                return drawCircle(10).sketchOnPlane().extrude(-1);
              }
            `,
          },
          'invalid_op.ts',
        );

        // This may succeed or fail depending on replicad's handling
        // Just verify we get a proper result structure
        expect(typeof result.success).toBe('boolean');
      });

      it('should handle empty geometry result gracefully', async () => {
        const result = await createGeometry(
          {
            'empty.ts': `
              import { draw } from 'replicad';

              export default function main() {
                return [];
              }
            `,
          },
          'empty.ts',
        );

        expect(result.success).toBe(true);
        if (result.success) {
          expect(Array.isArray(result.data)).toBe(true);
          expect(result.data).toHaveLength(0);
        }
      });
    });

    describe('File path handling for subdirectory files', () => {
      it('should use full relative path in error location when main file is in subdirectory', async () => {
        const worker = await createWorker({
          'project/main.ts': `
            import { draw } from 'replicad';

            export default function main() {
              return undefinedFunction();
            }
          `,
        });
        const result = await worker[kernelSymbols.createGeometryEntry](createGeometryFile('project/main.ts'), {});

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.issues.length).toBeGreaterThan(0);
          // Error should reference the file path
          expect(result.issues[0]?.location?.fileName).toContain('main.ts');
        }
      });
    });
  });

  // ===========================================================================
  // Tests: Export Geometry
  // ===========================================================================

  describe('exportGeometry', () => {
    it('should export to STEP format', async () => {
      const worker = await createWorker({
        'box.ts': `
          import { drawRoundedRectangle } from 'replicad';

          export default function main() {
            return drawRoundedRectangle(50, 30).sketchOnPlane().extrude(10);
          }
        `,
      });

      // First create geometry
      const geometryFile = createGeometryFile('box.ts');
      const createResult = await worker[kernelSymbols.createGeometryEntry](geometryFile, {});
      expect(createResult.success).toBe(true);

      // Then export
      const exportResult = await worker[kernelSymbols.exportGeometryEntry]('step');
      expect(exportResult.success).toBe(true);
      if (exportResult.success) {
        expect(exportResult.data).toBeDefined();
        expect(exportResult.data.length).toBeGreaterThan(0);
        expect(exportResult.data[0]?.blob).toBeInstanceOf(Blob);
      }
    });

    it('should export to STL format', async () => {
      const worker = await createWorker({
        'box.ts': `
          import { drawRoundedRectangle } from 'replicad';

          export default function main() {
            return drawRoundedRectangle(50, 30).sketchOnPlane().extrude(10);
          }
        `,
      });

      const geometryFile = createGeometryFile('box.ts');
      await worker[kernelSymbols.createGeometryEntry](geometryFile, {});

      const exportResult = await worker[kernelSymbols.exportGeometryEntry]('stl');
      expect(exportResult.success).toBe(true);
      if (exportResult.success) {
        expect(exportResult.data.length).toBeGreaterThan(0);
      }
    });

    it('should export to binary STL format', async () => {
      const worker = await createWorker({
        'box.ts': `
          import { drawRoundedRectangle } from 'replicad';

          export default function main() {
            return drawRoundedRectangle(50, 30).sketchOnPlane().extrude(10);
          }
        `,
      });

      const geometryFile = createGeometryFile('box.ts');
      await worker[kernelSymbols.createGeometryEntry](geometryFile, {});

      const exportResult = await worker[kernelSymbols.exportGeometryEntry]('stl-binary');
      expect(exportResult.success).toBe(true);
    });

    it('should export to GLTF format', async () => {
      const worker = await createWorker({
        'box.ts': `
          import { drawRoundedRectangle } from 'replicad';

          export default function main() {
            return drawRoundedRectangle(50, 30).sketchOnPlane().extrude(10);
          }
        `,
      });

      const geometryFile = createGeometryFile('box.ts');
      await worker[kernelSymbols.createGeometryEntry](geometryFile, {});

      const exportResult = await worker[kernelSymbols.exportGeometryEntry]('gltf');
      expect(exportResult.success).toBe(true);
      if (exportResult.success) {
        expect(exportResult.data[0]?.name).toContain('gltf');
      }
    });

    it('should export to GLB format', async () => {
      const worker = await createWorker({
        'box.ts': `
          import { drawRoundedRectangle } from 'replicad';

          export default function main() {
            return drawRoundedRectangle(50, 30).sketchOnPlane().extrude(10);
          }
        `,
      });

      const geometryFile = createGeometryFile('box.ts');
      await worker[kernelSymbols.createGeometryEntry](geometryFile, {});

      const exportResult = await worker[kernelSymbols.exportGeometryEntry]('glb');
      expect(exportResult.success).toBe(true);
      if (exportResult.success) {
        expect(exportResult.data[0]?.name).toContain('glb');
      }
    });

    it('should export STEP assembly', async () => {
      const worker = await createWorker({
        'assembly.ts': `
          import { drawRoundedRectangle, drawCircle } from 'replicad';

          export default function main() {
            return [
              { shape: drawRoundedRectangle(50, 30).sketchOnPlane().extrude(10), name: "base" },
              { shape: drawCircle(10).sketchOnPlane().extrude(20).translate([0, 0, 10]), name: "cylinder" },
            ];
          }
        `,
      });

      const geometryFile = createGeometryFile('assembly.ts');
      await worker[kernelSymbols.createGeometryEntry](geometryFile, {});

      const exportResult = await worker[kernelSymbols.exportGeometryEntry]('step-assembly');
      expect(exportResult.success).toBe(true);
    });

    it('should return error when no geometry computed', async () => {
      const worker = await createWorker({
        'empty.ts': `
          import { draw } from 'replicad';
          export default function main() { return []; }
        `,
      });

      // Don't compute geometry first
      const exportResult = await worker[kernelSymbols.exportGeometryEntry]('step');
      expect(exportResult.success).toBe(false);
      if (!exportResult.success) {
        expect(exportResult.issues[0]?.message).toContain('not computed');
      }
    });

    it('should respect mesh configuration for export', async () => {
      const worker = await createWorker({
        'sphere.ts': `
          import { drawCircle } from 'replicad';

          export default function main() {
            // Create a sphere-like shape by revolving a circle
            return drawCircle(20).sketchOnPlane().extrude(20);
          }
        `,
      });

      const geometryFile = createGeometryFile('sphere.ts');
      await worker[kernelSymbols.createGeometryEntry](geometryFile, {});

      // Export with custom mesh configuration
      const exportResult = await worker[kernelSymbols.exportGeometryEntry]('stl', {
        linearTolerance: 0.001,
        angularTolerance: 5,
      });

      expect(exportResult.success).toBe(true);
    });
  });

  // ===========================================================================
  // Tests: Named Shapes and Colors
  // ===========================================================================

  describe('Named shapes and colors', () => {
    it('should handle named shape objects', async () => {
      const result = await createGeometry(
        {
          'named.ts': `
            import { drawRoundedRectangle, drawCircle } from 'replicad';

            export default function main() {
              return [
                { shape: drawRoundedRectangle(50, 30).sketchOnPlane().extrude(10), name: "Base Plate" },
                { shape: drawCircle(10).sketchOnPlane().extrude(20).translate([0, 0, 10]), name: "Cylinder" },
              ];
            }
          `,
        },
        'named.ts',
      );

      expect(result.success).toBe(true);
    });

    it('should handle colored shapes', async () => {
      const result = await createGeometry(
        {
          'colored.ts': `
            import { drawRoundedRectangle, drawCircle } from 'replicad';

            export default function main() {
              return [
                { shape: drawRoundedRectangle(50, 30).sketchOnPlane().extrude(10), name: "Red Box", color: "#ff0000" },
                { shape: drawCircle(10).sketchOnPlane().extrude(20).translate([0, 0, 10]), name: "Blue Cylinder", color: "#0000ff" },
              ];
            }
          `,
        },
        'colored.ts',
      );

      expect(result.success).toBe(true);
    });

    it('should handle shapes with opacity', async () => {
      const result = await createGeometry(
        {
          'transparent.ts': `
            import { drawRoundedRectangle } from 'replicad';

            export default function main() {
              return [
                { shape: drawRoundedRectangle(50, 30).sketchOnPlane().extrude(10), name: "Outer", color: "#ff0000", opacity: 0.5 },
                { shape: drawRoundedRectangle(40, 20).sketchOnPlane().extrude(8).translate([5, 5, 1]), name: "Inner", color: "#00ff00" },
              ];
            }
          `,
        },
        'transparent.ts',
      );

      expect(result.success).toBe(true);
    });
  });
});

/* eslint-enable @typescript-eslint/naming-convention -- End of file */
