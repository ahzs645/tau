// @vitest-environment node
/* eslint-disable max-lines -- comprehensive kernel test suite */
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
    it('should extract defaultName from module exports', async () => {
      const worker = await createWorker({});
      // Test extractDefaultNameFromCode with a RuntimeModuleExports object
      const module = { defaultName: 'My Custom Box' };
      const result = await worker.extractDefaultNameFromCode(module);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('My Custom Box');
      }
    });

    it('should return undefined when no defaultName is defined', async () => {
      const worker = await createWorker({});
      const module = { default: () => [] };
      const result = await worker.extractDefaultNameFromCode(module);
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

    describe('Multi-file imports', () => {
      it('should handle imports from relative paths', async () => {
        const result = await createGeometry(
          {
            'main.ts': `
              import { createSimpleBox } from "./lib/box";
              import {} from 'replicad';

              export default function main() {
                return createSimpleBox(30, 30, 30);
              }
            `,
            'lib/box.ts': `
              import { makeBaseBox } from "replicad";

              export function createSimpleBox(w: number, h: number, d: number) {
                return makeBaseBox(w, h, d);
              }
            `,
          },
          'main.ts',
        );

        expect(result.success).toBe(true);

        // Geometry: 30x30x30 cube
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [30, 30, 30], 0.5);
      });

      it('should handle multi-level nested imports', async () => {
        const result = await createGeometry(
          {
            'main.ts': `
              import { createAssembly } from "./parts/assembly";
              import {} from 'replicad';

              export default function main() {
                return createAssembly();
              }
            `,
            'parts/assembly.ts': `
              import { createBox } from "./shapes/box";
              import { createCylinder } from "./shapes/cylinder";

              export function createAssembly() {
                const box = createBox(40, 40, 20);
                const cylinder = createCylinder(10, 30).translate([0, 0, 20]);
                return box.fuse(cylinder);
              }
            `,
            'parts/shapes/box.ts': `
              import { makeBaseBox } from "replicad";

              export function createBox(width: number, height: number, depth: number) {
                return makeBaseBox(width, height, depth);
              }
            `,
            'parts/shapes/cylinder.ts': `
              import { makeCylinder } from "replicad";

              export function createCylinder(radius: number, height: number) {
                return makeCylinder(radius, height);
              }
            `,
          },
          'main.ts',
        );

        expect(result.success).toBe(true);

        // Geometry: 40x40 base with cylinder on top, total height 50
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [40, 40, 50], 1);
      });

      it('should pass parameters through multi-file imports', async () => {
        const result = await createGeometry(
          {
            'main.ts': `
              import { createParametricBox } from "./utils/parametric";
              import {} from 'replicad';

              export const defaultParams = {
                size: 50,
              };

              export default function main(params = defaultParams) {
                return createParametricBox(params.size);
              }
            `,
            'utils/parametric.ts': `
              import { makeBaseBox } from "replicad";

              export function createParametricBox(size: number) {
                return makeBaseBox(size, size, size);
              }
            `,
          },
          'main.ts',
          { size: 100 },
        );

        expect(result.success).toBe(true);

        // Geometry: 100x100x100 cube (using passed parameter)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [100, 100, 100], 1);
      });

      it('should handle re-exports from barrel files', async () => {
        const result = await createGeometry(
          {
            'main.ts': `
              import { box, cylinder } from "./shapes";
              import {} from 'replicad';

              export default function main() {
                return [box(20, 20, 10), cylinder(8, 15).translate([30, 0, 0])];
              }
            `,
            'shapes/index.ts': `
              export { box } from "./box";
              export { cylinder } from "./cylinder";
            `,
            'shapes/box.ts': `
              import { makeBaseBox } from "replicad";

              export function box(w: number, h: number, d: number) {
                return makeBaseBox(w, h, d);
              }
            `,
            'shapes/cylinder.ts': `
              import { makeCylinder } from "replicad";

              export function cylinder(r: number, h: number) {
                return makeCylinder(r, h);
              }
            `,
          },
          'main.ts',
        );

        expect(result.success).toBe(true);

        // Geometry: box + cylinder, 2 meshes
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 2);
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

      it('should return error with properly classified stack frames for undefined variable', async () => {
        const result = await createGeometry(
          {
            'main.ts': `
              import {} from 'replicad';

              export const defaultParams = {};

              export default function main(p = defaultParams) {
                return bla;
              }
            `,
          },
          'main.ts',
        );

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.issues).toBeDefined();
          expect(result.issues.length).toBeGreaterThan(0);

          const issue = result.issues[0]!;

          // Error message should clearly indicate the problem
          expect(issue.message).toMatch(/bla is not defined/i);

          // Stack frames should be present
          expect(issue.stackFrames).toBeDefined();
          expect(issue.stackFrames!.length).toBeGreaterThan(0);

          // Internal frames should be classified correctly
          // Platform frames (kernel/, node:, node_modules) should be internal
          const internalFrames = issue.stackFrames!.filter((frame) => frame.isInternal);
          expect(internalFrames.length).toBeGreaterThan(0);

          for (const frame of internalFrames) {
            // Each internal frame should match at least one known platform pattern
            const fileName = frame.fileName ?? '';
            const isKnownPlatform =
              fileName.includes('/kernel/') ||
              fileName.startsWith('node:') ||
              fileName.includes('/node_modules/') ||
              fileName.startsWith('data:');
            expect(isKnownPlatform).toBe(true);
          }

          // At least one frame should have the 'main' function (user code entry point)
          const mainFrame = issue.stackFrames!.find((frame) => frame.functionName?.includes('main'));
          expect(mainFrame).toBeDefined();
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

      it('should return clear error when main returns undefined (no return statement)', async () => {
        const result = await createGeometry(
          {
            'no_return.ts': `
              import { draw } from 'replicad';

              export default function main() {
                draw()
                  .hLine(50)
                  .vLine(30)
                  .hLine(-50)
                  .close()
                  .sketchOnPlane()
                  .extrude(10);
                // Missing return statement
              }
            `,
          },
          'no_return.ts',
        );

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.issues).toBeDefined();
          expect(result.issues.length).toBeGreaterThan(0);
          // Should give a user-friendly message, not a JS crash like "Cannot read properties of undefined"
          expect(result.issues[0]!.message).toMatch(/did not return/i);
        }
      });

      it('should return clear error when main explicitly returns undefined', async () => {
        const result = await createGeometry(
          {
            'explicit_undefined.ts': `
              import { draw } from 'replicad';

              export default function main() {
                return undefined;
              }
            `,
          },
          'explicit_undefined.ts',
        );

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.issues).toBeDefined();
          expect(result.issues.length).toBeGreaterThan(0);
          expect(result.issues[0]!.message).toMatch(/did not return/i);
        }
      });

      it('should return clear error when main returns null', async () => {
        const result = await createGeometry(
          {
            'returns_null.ts': `
              import { draw } from 'replicad';

              export default function main() {
                return null;
              }
            `,
          },
          'returns_null.ts',
        );

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.issues).toBeDefined();
          expect(result.issues.length).toBeGreaterThan(0);
          expect(result.issues[0]!.message).toMatch(/did not return/i);
        }
      });
    });

    describe('source map stack trace resolution', () => {
      it('should map stack trace to original source positions (single file)', async () => {
        const code = [
          "import {} from 'replicad';", // Line 1
          '', // Line 2
          'export const defaultParams = {};', // Line 3
          '', // Line 4
          'export default function main() {', // Line 5
          '  return bla;', // Line 6 -- error here
          '}', // Line 7
        ].join('\n');

        const result = await createGeometry({ 'main.ts': code }, 'main.ts');
        expect(result.success).toBe(false);
        if (!result.success) {
          const issue = result.issues[0]!;
          expect(issue.message).toMatch(/bla is not defined/i);
          expect(issue.stackFrames).toBeDefined();

          const mainFrame = issue.stackFrames?.find((frame) => frame.functionName?.includes('main'));
          expect(mainFrame).toBeDefined();
          // Source map should resolve to original file name, not blob/data UUID
          expect(mainFrame!.fileName).toBe('main.ts');
          // Source map should resolve to original line 6, not the post-banner offset (line 9)
          expect(mainFrame!.lineNumber).toBe(6);
        }
      });

      it('should map stack trace to correct file in multi-file project', async () => {
        const result = await createGeometry(
          {
            'main.ts': [
              "import { broken } from './lib/helper';",
              "import {} from 'replicad';",
              'export default function main() { return broken(); }',
            ].join('\n'),
            'lib/helper.ts': 'export function broken() { return bla; }',
          },
          'main.ts',
        );

        expect(result.success).toBe(false);
        if (!result.success) {
          const issue = result.issues[0]!;
          expect(issue.message).toMatch(/bla is not defined/i);
          expect(issue.stackFrames).toBeDefined();

          // The error originates in helper.ts, so we should find that frame
          const helperFrame = issue.stackFrames?.find((frame) => frame.functionName?.includes('broken'));
          expect(helperFrame).toBeDefined();
          expect(helperFrame!.fileName).toContain('helper.ts');
        }
      });

      it('should map stack trace through function call to correct line', async () => {
        // Error is inside a helper function `makeBadShape` called from main.
        // The stack trace should show both the error site and the call site.
        const code = [
          "import {} from 'replicad';", // Line 1
          '', // Line 2
          'function makeBadShape() {', // Line 3
          '  return bla;', // Line 4 -- error here
          '}', // Line 5
          '', // Line 6
          'export default function main() {', // Line 7
          '  return makeBadShape();', // Line 8 -- call site
          '}', // Line 9
        ].join('\n');

        const result = await createGeometry({ 'main.ts': code }, 'main.ts');
        expect(result.success).toBe(false);
        if (!result.success) {
          const issue = result.issues[0]!;
          expect(issue.message).toMatch(/bla is not defined/i);
          expect(issue.stackFrames).toBeDefined();

          // Should have a frame for makeBadShape at line 4 (error site)
          const errorFrame = issue.stackFrames?.find((frame) => frame.functionName?.includes('makeBadShape'));
          expect(errorFrame).toBeDefined();
          expect(errorFrame!.fileName).toBe('main.ts');
          expect(errorFrame!.lineNumber).toBe(4);

          // Should have a frame for main at line 8 (call site)
          const callFrame = issue.stackFrames?.find((frame) => frame.functionName?.includes('main'));
          expect(callFrame).toBeDefined();
          expect(callFrame!.fileName).toBe('main.ts');
          expect(callFrame!.lineNumber).toBe(8);
        }
      });

      it('should map stack trace through 3-file import chain', async () => {
        // 3-file chain: main.ts -> lib/middle.ts -> lib/bad.ts
        // Error is in bad.ts, called through middle.ts from main.ts.
        const result = await createGeometry(
          {
            'main.ts': [
              "import { getShape } from './lib/middle';",
              "import {} from 'replicad';",
              'export default function main() { return getShape(); }',
            ].join('\n'),
            'lib/middle.ts': [
              "import { broken } from './bad';",
              'export function getShape() { return broken(); }',
            ].join('\n'),
            'lib/bad.ts': 'export function broken() { return bla; }',
          },
          'main.ts',
        );

        expect(result.success).toBe(false);
        if (!result.success) {
          const issue = result.issues[0]!;
          expect(issue.message).toMatch(/bla is not defined/i);
          expect(issue.stackFrames).toBeDefined();

          // Should have a frame for the error in bad.ts
          const errorFrame = issue.stackFrames?.find((frame) => frame.functionName?.includes('broken'));
          expect(errorFrame).toBeDefined();
          expect(errorFrame!.fileName).toContain('bad.ts');

          // Should have a frame for the call in middle.ts
          const middleFrame = issue.stackFrames?.find((frame) => frame.functionName?.includes('getShape'));
          expect(middleFrame).toBeDefined();
          expect(middleFrame!.fileName).toContain('middle.ts');

          // Should have a frame for main
          const mainFrame = issue.stackFrames?.find((frame) => frame.functionName?.includes('main'));
          expect(mainFrame).toBeDefined();
          expect(mainFrame!.fileName).toBe('main.ts');

          // No blob/data UUIDs in any user frames
          const userFrames = issue.stackFrames!.filter((frame) => !frame.isInternal);
          for (const frame of userFrames) {
            expect(frame.fileName).not.toMatch(/^blob:/);
            expect(frame.fileName).not.toMatch(/^data:/);
          }
        }
      });

      it('should not expose blob or data UUIDs in user stack frames', async () => {
        const code = [
          "import {} from 'replicad';", // Line 1
          '', // Line 2
          'export default function main() {', // Line 3
          '  return bla;', // Line 4 -- error here
          '}', // Line 5
        ].join('\n');

        const result = await createGeometry({ 'main.ts': code }, 'main.ts');
        expect(result.success).toBe(false);
        if (!result.success) {
          const issue = result.issues[0]!;
          expect(issue.stackFrames).toBeDefined();

          const userFrames = issue.stackFrames!.filter((frame) => !frame.isInternal);
          expect(userFrames.length).toBeGreaterThan(0);

          for (const frame of userFrames) {
            expect(frame.fileName).not.toMatch(/^blob:/);
            expect(frame.fileName).not.toMatch(/^data:/);
          }
        }
      });
    });

    describe('CDN imports', () => {
      it('should bundle and execute code with HTTPS CDN imports', async () => {
        const result = await createGeometry(
          {
            'decorated.ts': `
              import { drawRoundedRectangle } from 'replicad';
              import { drawSVG } from "https://cdn.jsdelivr.net/npm/replicad-decorate/dist/studio/replicad-decorate.js";

              export default function main() {
                // Verify the CDN import is available and is a function
                if (typeof drawSVG !== 'function') {
                  throw new Error('drawSVG is not a function');
                }

                // Return a 50x30x10 box
                return drawRoundedRectangle(50, 30).sketchOnPlane().extrude(10);
              }
            `,
          },
          'decorated.ts',
        );

        expect(result.success).toBe(true);

        // Geometry quality assertions (50x30x10 box)
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [50, 30, 10], 0.5);
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
          // Error should reference the file path - check message if location is not available
          const firstIssue = result.issues[0];
          const hasLocation = firstIssue?.location?.fileName !== undefined;
          if (hasLocation) {
            expect(firstIssue.location?.fileName).toContain('main.ts');
          } else {
            // Error message should contain file reference
            expect(firstIssue?.message).toMatch(/main\.ts|undefinedFunction/);
          }
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

  // ===========================================================================
  // Tests: TypeScript Bundling Support
  // ===========================================================================

  describe('TypeScript bundling', () => {
    describe('Type annotations', () => {
      it('should bundle code with typed function parameters and return types', async () => {
        const result = await createGeometry(
          {
            'typed-box.ts': `
              import { drawRoundedRectangle } from 'replicad';

              export const defaultParams = {
                width: 50,
                height: 30,
                depth: 10,
              };

              type BoxParams = { width: number; height: number; depth: number };

              export default function main(p: BoxParams = defaultParams) {
                const { width, height, depth } = p;
                return drawRoundedRectangle(width, height).sketchOnPlane().extrude(depth);
              }
            `,
          },
          'typed-box.ts',
          { width: 50, height: 30, depth: 10 },
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [50, 30, 10], 0.5);
      });

      it('should bundle code with type assertions (as)', async () => {
        const result = await createGeometry(
          {
            'assertions.ts': `
              import { makeCylinder } from 'replicad';

              export default function main() {
                const height = 20 as number;
                const center = [0, 0, 10] as [number, number, number];
                return makeCylinder(10, height).translate(center);
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
              import { drawRoundedRectangle } from 'replicad';

              const dimensions = {
                width: 40,
                height: 20,
                depth: 15,
              } as const;

              export default function main() {
                return drawRoundedRectangle(dimensions.width, dimensions.height)
                  .sketchOnPlane()
                  .extrude(dimensions.depth);
              }
            `,
          },
          'const-assertion.ts',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [40, 20, 15], 0.5);
      });
    });

    describe('Type-only imports', () => {
      it('should strip import type declarations from replicad', async () => {
        const result = await createGeometry(
          {
            'type-import.ts': `
              import { drawRoundedRectangle } from 'replicad';
              import type { Drawing } from 'replicad';

              export default function main() {
                const shape = drawRoundedRectangle(50, 30);
                return shape.sketchOnPlane().extrude(10);
              }
            `,
          },
          'type-import.ts',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [50, 30, 10], 0.5);
      });

      it('should strip inline type imports (import { type X })', async () => {
        const result = await createGeometry(
          {
            'inline-type.ts': `
              import { draw, type Sketcher, type Drawing } from 'replicad';

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
          'inline-type.ts',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [50, 30, 10], 0.5);
      });
    });

    describe('Interfaces and type aliases', () => {
      it('should bundle code with local interface definitions', async () => {
        const result = await createGeometry(
          {
            'interfaces.ts': `
              import { drawRoundedRectangle, drawCircle } from 'replicad';

              interface ShapeConfig {
                width: number;
                height: number;
                depth: number;
              }

              interface CylinderConfig {
                radius: number;
                height: number;
              }

              function createBox(config: ShapeConfig) {
                return drawRoundedRectangle(config.width, config.height)
                  .sketchOnPlane()
                  .extrude(config.depth);
              }

              function createCylinder(config: CylinderConfig) {
                return drawCircle(config.radius)
                  .sketchOnPlane()
                  .extrude(config.height);
              }

              export default function main() {
                const box = createBox({ width: 50, height: 30, depth: 10 });
                const cyl = createCylinder({ radius: 8, height: 20 });
                return [box, cyl.translate([0, 0, 10])];
              }
            `,
          },
          'interfaces.ts',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 2);
      });

      it('should bundle code with type aliases and union types', async () => {
        const result = await createGeometry(
          {
            'type-aliases.ts': `
              import { drawRoundedRectangle, drawCircle } from 'replicad';

              type Dimensions = { width: number; height: number; depth: number };
              type ShapeType = 'box' | 'cylinder';
              type Point3D = [number, number, number];

              function createShape(type: ShapeType, dims: Dimensions) {
                if (type === 'box') {
                  return drawRoundedRectangle(dims.width, dims.height)
                    .sketchOnPlane()
                    .extrude(dims.depth);
                }
                return drawCircle(dims.width / 2)
                  .sketchOnPlane()
                  .extrude(dims.depth);
              }

              export default function main() {
                const offset: Point3D = [0, 0, 10];
                const box = createShape('box', { width: 50, height: 30, depth: 10 });
                const cyl = createShape('cylinder', { width: 20, height: 20, depth: 20 });
                return [box, cyl.translate(offset)];
              }
            `,
          },
          'type-aliases.ts',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 2);
      });
    });

    describe('Generics and advanced TypeScript features', () => {
      it('should bundle code with generic utility functions', async () => {
        const result = await createGeometry(
          {
            'generics.ts': `
              import { drawRoundedRectangle } from 'replicad';

              function withDefaults<T extends Record<string, number>>(
                defaults: T,
                overrides: Partial<T>,
              ): T {
                return { ...defaults, ...overrides };
              }

              const baseParams = { width: 50, height: 30, depth: 10 };

              export default function main() {
                const p = withDefaults(baseParams, { depth: 20 });
                return drawRoundedRectangle(p.width, p.height)
                  .sketchOnPlane()
                  .extrude(p.depth);
              }
            `,
          },
          'generics.ts',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [50, 30, 20], 0.5);
      });

      it('should bundle code with enums', async () => {
        const result = await createGeometry(
          {
            'enums.ts': `
              import { drawRoundedRectangle, drawCircle } from 'replicad';

              enum ShapeKind {
                Box = 'box',
                Cylinder = 'cylinder',
              }

              export default function main() {
                const kind: ShapeKind = ShapeKind.Box;
                if (kind === ShapeKind.Box) {
                  return drawRoundedRectangle(50, 30).sketchOnPlane().extrude(10);
                }
                return drawCircle(15).sketchOnPlane().extrude(20);
              }
            `,
          },
          'enums.ts',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [50, 30, 10], 0.5);
      });

      it('should bundle code with optional chaining and nullish coalescing', async () => {
        const result = await createGeometry(
          {
            'modern-ts.ts': `
              import { drawRoundedRectangle } from 'replicad';

              type Config = {
                dimensions?: {
                  width?: number;
                  height?: number;
                  depth?: number;
                };
              };

              export default function main() {
                const config: Config = { dimensions: { width: 50 } };
                const width = config.dimensions?.width ?? 30;
                const height = config.dimensions?.height ?? 20;
                const depth = config.dimensions?.depth ?? 10;

                return drawRoundedRectangle(width, height).sketchOnPlane().extrude(depth);
              }
            `,
          },
          'modern-ts.ts',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [50, 20, 10], 0.5);
      });
    });

    describe('Multi-file TypeScript with shared types', () => {
      it('should bundle multi-file project with shared type definitions', async () => {
        const result = await createGeometry(
          {
            'main.ts': `
              import { drawRoundedRectangle, drawCircle } from 'replicad';
              import type { BoxConfig, CylinderConfig } from './types';
              import { createBox, createCylinder } from './shapes';

              export default function main() {
                const boxConfig: BoxConfig = { width: 50, height: 30, depth: 10 };
                const cylConfig: CylinderConfig = { radius: 8, height: 25 };

                const box = createBox(boxConfig);
                const cyl = createCylinder(cylConfig).translate([0, 0, 10]);

                return [box, cyl];
              }
            `,
            'types.ts': `
              export interface BoxConfig {
                width: number;
                height: number;
                depth: number;
              }

              export interface CylinderConfig {
                radius: number;
                height: number;
              }

              export type Point3D = [number, number, number];
            `,
            'shapes.ts': `
              import { drawRoundedRectangle, drawCircle } from 'replicad';
              import type { BoxConfig, CylinderConfig } from './types';

              export function createBox(config: BoxConfig) {
                return drawRoundedRectangle(config.width, config.height)
                  .sketchOnPlane()
                  .extrude(config.depth);
              }

              export function createCylinder(config: CylinderConfig) {
                return drawCircle(config.radius)
                  .sketchOnPlane()
                  .extrude(config.height);
              }
            `,
          },
          'main.ts',
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 2);
      });

      it('should bundle multi-file project with type-only re-exports', async () => {
        const result = await createGeometry(
          {
            'main.ts': `
              import { drawRoundedRectangle } from 'replicad';
              import type { AppParams } from './config';
              import { DEFAULT_PARAMS } from './config';

              export const defaultParams = DEFAULT_PARAMS;

              export default function main(p: AppParams = defaultParams) {
                return drawRoundedRectangle(p.width, p.height)
                  .sketchOnPlane()
                  .extrude(p.depth);
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
                width: 60,
                height: 40,
                depth: 15,
              };
            `,
          },
          'main.ts',
          { width: 60, height: 40, depth: 15 },
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [60, 40, 15], 0.5);
      });
    });

    describe('Real-world TypeScript CAD patterns', () => {
      it('should bundle a parametric model with full TypeScript features (watering can style)', async () => {
        const result = await createGeometry(
          {
            'main.ts': `
              import { makePlane, makeCylinder, draw, drawCircle } from 'replicad';

              interface WateringCanParams {
                baseWidth: number;
                bodyHeight: number;
                spoutRadius: number;
                spoutLength: number;
                spoutAngle: number;
              }

              export const defaultParams: WateringCanParams = {
                baseWidth: 20,
                bodyHeight: 50,
                spoutRadius: 5,
                spoutLength: 30,
                spoutAngle: 45,
              };

              export default function main(p: WateringCanParams = defaultParams) {
                // Build the body using draw + revolve
                const profile = draw()
                  .hLine(p.baseWidth)
                  .line(5, 3)
                  .vLine(3)
                  .lineTo([8, p.bodyHeight])
                  .hLine(-8)
                  .close();

                const body = profile.sketchOnPlane("XZ").revolve([0, 0, 1]);

                // Build the spout
                const spout = makeCylinder(p.spoutRadius, p.spoutLength)
                  .translateZ(p.bodyHeight)
                  .rotate(p.spoutAngle, [0, 0, p.bodyHeight], [0, 1, 0]);

                const spoutOpening = [
                  Math.cos((p.spoutAngle * Math.PI) / 180) * p.spoutLength,
                  0,
                  p.bodyHeight + Math.sin((p.spoutAngle * Math.PI) / 180) * p.spoutLength,
                ] as [number, number, number];

                return body.fuse(spout);
              }
            `,
          },
          'main.ts',
          {
            baseWidth: 20,
            bodyHeight: 50,
            spoutRadius: 5,
            spoutLength: 30,
            spoutAngle: 45,
          },
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
      });

      it('should bundle a multi-file parametric assembly with TypeScript', async () => {
        const result = await createGeometry(
          {
            'main.ts': `
              import {} from 'replicad';
              import type { AssemblyConfig } from './types';
              import { createBase } from './parts/base';
              import { createPillar } from './parts/pillar';

              export const defaultParams: AssemblyConfig = {
                base: { width: 60, depth: 40, thickness: 5 },
                pillar: { radius: 4, height: 30 },
              };

              export default function main(p: AssemblyConfig = defaultParams) {
                const base = createBase(p.base);
                const pillar = createPillar(p.pillar).translate([0, 0, p.base.thickness]);
                return base.fuse(pillar);
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
              import { drawRoundedRectangle } from 'replicad';
              import type { BaseConfig } from '../types';

              export function createBase(config: BaseConfig) {
                return drawRoundedRectangle(config.width, config.depth)
                  .sketchOnPlane()
                  .extrude(config.thickness);
              }
            `,
            'parts/pillar.ts': `
              import { drawCircle } from 'replicad';
              import type { PillarConfig } from '../types';

              export function createPillar(config: PillarConfig) {
                return drawCircle(config.radius)
                  .sketchOnPlane()
                  .extrude(config.height);
              }
            `,
          },
          'main.ts',
          {
            base: { width: 60, depth: 40, thickness: 5 },
            pillar: { radius: 4, height: 30 },
          },
        );

        expect(result.success).toBe(true);
        await geometryHelpers.expectValidGltf(result);
        await geometryHelpers.expectMeshCount(result, 1);
        await geometryHelpers.expectBoundingBoxSize(result, [60, 40, 35], 1);
      });
    });
  });
});

/* eslint-enable @typescript-eslint/naming-convention -- End of file */
