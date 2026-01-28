// @vitest-environment node
import { describe, it, expect } from 'vitest';
import * as kernelSymbols from '@taucad/types/symbols';
import { ZooWorker } from '#components/geometry/kernel/zoo/zoo.worker.js';
import {
  seedTestFilesystem,
  initializeWorkerForTesting,
  createGeometryFile,
} from '#components/geometry/kernel/utils/kernel-testing.utils.js';
import { joinPath } from '#utils/path.utils.js';

/* eslint-disable @typescript-eslint/naming-convention -- File names use extensions like 'main.kcl' */

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Initialize a ZooWorker for parameter extraction.
 * Seeds the filesystem with provided files before creating the worker.
 * Uses the real production code path via initializeWorkerForTesting.
 *
 * Note: createGeometry requires a cloud websocket connection and is not tested here.
 * These tests focus on getParameters which uses the local KCL WASM parser.
 */
async function createWorker(files: Record<string, string>): Promise<ZooWorker> {
  const basePath = '/builds/test';

  // Convert files to have full paths and seed the filesystem
  const absoluteFiles: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    absoluteFiles[joinPath(basePath, path)] = content;
  }

  // Seed filesystem with InMemory backend - this "wins" over fileManager's indexeddb request
  await seedTestFilesystem(absoluteFiles);

  // Create worker and initialize using production code path
  const worker = new ZooWorker();
  await initializeWorkerForTesting(worker, {});

  return worker;
}

/**
 * Helper to extract parameters and assert success.
 */
async function getParameters(
  files: Record<string, string>,
  mainFile: string,
): Promise<{ jsonSchema: unknown; defaultParameters: Record<string, unknown> }> {
  const worker = await createWorker(files);
  const result = await worker[kernelSymbols.getParametersEntry](createGeometryFile(mainFile));

  if (!result.success) {
    console.error('getParameters failed:', JSON.stringify(result.issues, null, 2));
  }

  expect(result.success).toBe(true);

  if (!result.success) {
    throw new Error('Extraction failed');
  }

  return result.data;
}

/**
 * Helper to get parameters with expected failure.
 */
async function getParametersWithError(
  files: Record<string, string>,
  mainFile: string,
): Promise<{ success: boolean; issues?: unknown[] }> {
  const worker = await createWorker(files);
  return worker[kernelSymbols.getParametersEntry](createGeometryFile(mainFile));
}

// =============================================================================
// Tests: canHandle - File Type Detection
// =============================================================================

describe('ZooWorker', () => {
  describe('canHandle', () => {
    it('should handle KCL files', async () => {
      const worker = await createWorker({
        'main.kcl': `
          width = 10
          box = startSketchOn(XY)
            |> startProfile(at = [0, 0])
            |> line(end = [width, 0])
            |> line(end = [0, 10])
            |> line(end = [-width, 0])
            |> close(%)
            |> extrude(length = 5)
        `,
      });
      const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('main.kcl'));
      expect(result).toBe(true);
    });

    it('should not handle JavaScript files', async () => {
      const worker = await createWorker({
        'main.js': `
          console.log('hello');
        `,
      });
      const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('main.js'));
      expect(result).toBe(false);
    });

    it('should not handle TypeScript files', async () => {
      const worker = await createWorker({
        'main.ts': `
          const x: number = 10;
        `,
      });
      const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('main.ts'));
      expect(result).toBe(false);
    });

    it('should not handle OpenSCAD files', async () => {
      const worker = await createWorker({
        'main.scad': `
          cube([10, 10, 10]);
        `,
      });
      const result = await worker[kernelSymbols.canHandleEntry](createGeometryFile('main.scad'));
      expect(result).toBe(false);
    });
  });

  // ===========================================================================
  // Tests: Parameter Extraction - Single File Projects
  // ===========================================================================

  describe('getParametersEntry', () => {
    describe('Single file projects', () => {
      it('should extract numeric parameters', async () => {
        const { jsonSchema, defaultParameters } = await getParameters(
          {
            'box.kcl': `
              width = 10
              height = 20
              depth = 5

              box = startSketchOn(XY)
                |> startProfile(at = [0, 0])
                |> line(end = [width, 0])
                |> line(end = [0, height])
                |> line(end = [-width, 0])
                |> close(%)
                |> extrude(length = depth)
            `,
          },
          'box.kcl',
        );

        expect(defaultParameters).toMatchObject({
          width: 10,
          height: 20,
          depth: 5,
        });

        expect(jsonSchema).toMatchObject({
          type: 'object',
          properties: {
            width: { type: 'number', default: 10 },
            height: { type: 'number', default: 20 },
            depth: { type: 'number', default: 5 },
          },
        });
      });

      it('should extract decimal parameters', async () => {
        const { defaultParameters } = await getParameters(
          {
            'cylinder.kcl': `
              radius = 5.5
              height = 12.75

              cylinder = startSketchOn(XY)
                |> circle(center = [0, 0], radius = radius)
                |> extrude(length = height)
            `,
          },
          'cylinder.kcl',
        );

        expect(defaultParameters).toMatchObject({
          radius: 5.5,
          height: 12.75,
        });
      });

      it('should extract computed parameters', async () => {
        // Parameters that are computed from other values
        const { defaultParameters } = await getParameters(
          {
            'bracket.kcl': `
              // Parametric shelf bracket from zoo-modeling-app
              sigmaAllow = 35000
              width = 9
              p = 150
              distance = 6
              FOS = 2

              leg1 = 5
              leg2 = 8
              thickness = sqrt(distance * p * FOS * 6 / sigmaAllow / width)

              bracket = startSketchOn(XY)
                |> startProfile(at = [0, 0])
                |> line(end = [0, leg1])
                |> line(end = [leg2, 0])
                |> line(end = [0, -thickness])
                |> line(end = [-leg2 + thickness, 0])
                |> line(end = [0, -leg1 + thickness])
                |> close(%)
                |> extrude(length = width)
            `,
          },
          'bracket.kcl',
        );

        // Check that computed values are resolved
        expect(defaultParameters['sigmaAllow']).toBe(35_000);
        expect(defaultParameters['width']).toBe(9);
        expect(defaultParameters['p']).toBe(150);
        expect(defaultParameters['distance']).toBe(6);
        expect(defaultParameters['FOS']).toBe(2);
        expect(defaultParameters['leg1']).toBe(5);
        expect(defaultParameters['leg2']).toBe(8);
        // Thickness is computed: sqrt(6 * 150 * 2 * 6 / 35000 / 9) ≈ 0.135
        expect(typeof defaultParameters['thickness']).toBe('number');
      });

      it('should extract string parameters', async () => {
        const { defaultParameters } = await getParameters(
          {
            'text.kcl': `
              label = "Hello World"
              mode = "normal"

              // Just define some parameters, geometry not needed for extraction
              box = startSketchOn(XY)
                |> startProfile(at = [0, 0])
                |> line(end = [10, 0])
                |> line(end = [0, 10])
                |> line(end = [-10, 0])
                |> close(%)
                |> extrude(length = 5)
            `,
          },
          'text.kcl',
        );

        expect(defaultParameters).toMatchObject({
          label: 'Hello World',
          mode: 'normal',
        });
      });

      it('should extract boolean parameters', async () => {
        const { defaultParameters } = await getParameters(
          {
            'options.kcl': `
              addHoles = true
              roundCorners = false

              box = startSketchOn(XY)
                |> startProfile(at = [0, 0])
                |> line(end = [10, 0])
                |> line(end = [0, 10])
                |> line(end = [-10, 0])
                |> close(%)
                |> extrude(length = 5)
            `,
          },
          'options.kcl',
        );

        expect(defaultParameters).toMatchObject({
          addHoles: true,
          roundCorners: false,
        });
      });

      it('should handle empty file', async () => {
        const { defaultParameters, jsonSchema } = await getParameters(
          {
            'empty.kcl': '',
          },
          'empty.kcl',
        );

        expect(defaultParameters).toEqual({});
        expect(jsonSchema).toMatchObject({
          type: 'object',
        });
      });

      it('should handle file with only comments', async () => {
        const { defaultParameters } = await getParameters(
          {
            'comments.kcl': `
              // This is a comment
              // Another comment
            `,
          },
          'comments.kcl',
        );

        expect(defaultParameters).toEqual({});
      });
    });

    // ===========================================================================
    // Tests: Parameter Extraction - Multi-file Projects
    // ===========================================================================

    describe('Multi-file projects', () => {
      it('should extract parameters from main file with simple import', async () => {
        // Based on pattern from zoo-modeling-app/rust/kcl-lib/tests/pattern_linear_in_module
        const { defaultParameters } = await getParameters(
          {
            'main.kcl': `
              import thing from "thing.kcl"

              width = 20
              height = 15

              thing()
            `,
            'thing.kcl': `
              export fn thing() {
                return startSketchOn(XZ)
                  |> circle(center = [0, 0], radius = 1)
                  |> extrude(length = 1)
              }

              thing()
            `,
          },
          'main.kcl',
        );

        // Parameters should come from main.kcl, not imported modules
        expect(defaultParameters).toMatchObject({
          width: 20,
          height: 15,
        });
      });

      it('should extract parameters with module import alias', async () => {
        // Based on pattern from zoo-modeling-app/rust/kcl-lib/tests/nested_main_kcl
        const { defaultParameters } = await getParameters(
          {
            'main.kcl': `
              import "component.kcl" as comp

              mainParam = 100

              comp
            `,
            'component.kcl': `
              // A simple component
              startSketchOn(XY)
                |> circle(center = [0, 0], radius = 5)
                |> extrude(length = 10)
            `,
          },
          'main.kcl',
        );

        // Only parameters from main.kcl should be extracted
        expect(defaultParameters).toMatchObject({
          mainParam: 100,
        });
      });

      it('should extract parameters with whole file import', async () => {
        // Based on pattern from zoo-modeling-app/rust/kcl-lib/tests/import_whole_transitive_import
        const { defaultParameters } = await getParameters(
          {
            'main.kcl': `
              import "part.kcl"

              assemblyWidth = 50

              part
            `,
            'part.kcl': `
              // Part component
              startSketchOn(XY)
                |> circle(center = [0, 0], radius = 10)
                |> extrude(length = 5)
            `,
          },
          'main.kcl',
        );

        expect(defaultParameters).toMatchObject({
          assemblyWidth: 50,
        });
      });

      it('should include exported variables from imported parameter files via glob import', async () => {
        // Based on pattern from zoo-modeling-app/public/kcl-samples/car-wheel-assembly
        // Main file uses `import * from "parameters.kcl"` to import all exported variables
        const { defaultParameters } = await getParameters(
          {
            'main.kcl': `
              // Car Wheel Assembly
              @settings(defaultLengthUnit = in, kclVersion = 1.0)

              // Import all parameters from the shared parameters file
              import * from "parameters.kcl"

              // Import component modules
              import "wheel.kcl" as wheel
              import "tire.kcl" as tire

              // Assembly-specific parameter
              assemblyOffset = 10

              // Use the imported components
              wheel
              tire
            `,
            'parameters.kcl': `
              // Shared parameters file with exported variables
              @settings(defaultLengthUnit = in, kclVersion = 1.0)

              // Wheel parameters
              export wheelDiameter = 19
              export wheelWidth = 9.5
              export spokeCount = 6

              // Tire parameters
              export tireInnerDiameter = 19
              export tireOuterDiameter = 24
              export tireDepth = 11.02
            `,
            'wheel.kcl': `
              // Wheel component that uses imported parameters
              @settings(defaultLengthUnit = in, kclVersion = 1.0)

              import wheelDiameter, wheelWidth, spokeCount from "parameters.kcl"

              // Simple wheel representation
              startSketchOn(XY)
                |> circle(center = [0, 0], radius = wheelDiameter / 2)
                |> extrude(length = wheelWidth)
            `,
            'tire.kcl': `
              // Tire component that uses imported parameters
              @settings(defaultLengthUnit = in, kclVersion = 1.0)

              import tireInnerDiameter, tireOuterDiameter, tireDepth from "parameters.kcl"

              // Simple tire representation
              startSketchOn(XY)
                |> circle(center = [0, 0], radius = tireOuterDiameter / 2)
                |> subtract2d(tool = circle(center = [0, 0], radius = tireInnerDiameter / 2))
                |> extrude(length = tireDepth)
            `,
          },
          'main.kcl',
        );

        // Should include parameters from main.kcl
        expect(defaultParameters['assemblyOffset']).toBe(10);

        // Should include all exported parameters from parameters.kcl via `import * from`
        expect(defaultParameters['wheelDiameter']).toBe(19);
        expect(defaultParameters['wheelWidth']).toBe(9.5);
        expect(defaultParameters['spokeCount']).toBe(6);
        expect(defaultParameters['tireInnerDiameter']).toBe(19);
        expect(defaultParameters['tireOuterDiameter']).toBe(24);
        expect(defaultParameters['tireDepth']).toBe(11.02);
      });

      it('should include exported variables from imported parameter files via named imports', async () => {
        // Tests named import syntax: `import foo, bar from "file.kcl"`
        const { defaultParameters } = await getParameters(
          {
            'main.kcl': `
              // Main file with named imports
              @settings(defaultLengthUnit = mm, kclVersion = 1.0)

              // Import specific parameters by name
              import width, height, depth from "dimensions.kcl"

              // Local parameter
              scale = 2

              // Use the dimensions
              box = startSketchOn(XY)
                |> startProfile(at = [0, 0])
                |> line(end = [width * scale, 0])
                |> line(end = [0, height * scale])
                |> line(end = [-width * scale, 0])
                |> close(%)
                |> extrude(length = depth * scale)
            `,
            'dimensions.kcl': `
              // Shared dimensions
              @settings(defaultLengthUnit = mm, kclVersion = 1.0)

              export width = 100
              export height = 50
              export depth = 25
              export unusedParam = 999
            `,
          },
          'main.kcl',
        );

        // Should include local parameter
        expect(defaultParameters['scale']).toBe(2);

        // Should include imported parameters
        expect(defaultParameters['width']).toBe(100);
        expect(defaultParameters['height']).toBe(50);
        expect(defaultParameters['depth']).toBe(25);

        // Should NOT include parameters that weren't imported
        expect(defaultParameters['unusedParam']).toBeUndefined();
      });
    });

    // ===========================================================================
    // Tests: Error Handling
    // ===========================================================================

    describe('Error handling', () => {
      it('should return error for undefined variable references', async () => {
        const result = await getParametersWithError(
          {
            'undefined_var.kcl': `
              width = undefinedVariable
              box = startSketchOn(XY)
                |> startProfile(at = [0, 0])
                |> line(end = [width, 0])
                |> close(%)
            `,
          },
          'undefined_var.kcl',
        );

        expect(result.success).toBe(false);
        expect(result.issues).toBeDefined();
      });

      it('should return error for syntax error with missing closing parenthesis', async () => {
        // This tests a syntax error: missing closing parenthesis on close(
        const result = await getParametersWithError(
          {
            'syntax_error.kcl': `@settings(defaultLengthUnit = mm, kclVersion = 1.0)

// Parametric Cone
// A cone created by revolving a triangular profile

// Parameters
coneHeight = 80       // mm - height of the cone
baseDiameter = 50     // mm - diameter of the base

// Create triangular profile and revolve to form cone
cone = startSketchOn(XZ)
  |> startProfile(at = [0, 0])
  |> xLine(length = baseDiameter / 2)
  |> line(endAbsolute = [0, coneHeight])
  |> line(endAbsolute = profileStart(%))
  |> close(
  |> revolve(axis = X)
`,
          },
          'syntax_error.kcl',
        );

        expect(result.success).toBe(false);
        expect(result.issues).toEqual([
          {
            message: 'There was an unexpected `|>`. Try removing it.',
            severity: 'error',
            type: 'compilation',
            location: {
              fileName: 'syntax_error.kcl',
              startLineNumber: 17,
              startColumn: 2,
            },
          },
        ]);
      });
    });
  });
});

/* eslint-enable @typescript-eslint/naming-convention -- End of file */
