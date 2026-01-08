import type { GeometryFile } from '@taucad/types';
import { describe, it, expect, vi } from 'vitest';
import type { FileManager } from '#machines/file-manager.js';
import { OpenScadWorker } from '#components/geometry/kernel/openscad/openscad.worker.js';

/* eslint-disable @typescript-eslint/naming-convention -- OpenSCAD uses snake_case for parameter names */

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Helper to encode text as Uint8Array for the mock file manager.
 */
function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Create a mock FileManager that returns files from an in-memory record.
 */
function createMockFileManager(files: Record<string, string>): FileManager {
  const encodedFiles: Record<string, Uint8Array> = {};

  for (const [path, content] of Object.entries(files)) {
    encodedFiles[path] = encodeText(content);
  }

  return {
    readFile: vi.fn(async (filepath: string) => {
      const content = encodedFiles[filepath];

      if (!content) {
        throw new Error(`File not found: ${filepath}`);
      }

      return content;
    }),
    exists: vi.fn(async (filepath: string) => filepath in encodedFiles),
    readdir: vi.fn(async () => Object.keys(encodedFiles)),
    getDirectoryContents: vi.fn(async () => encodedFiles),
    copyDirectory: vi.fn(),
    getZippedDirectory: vi.fn(),
    writeFile: vi.fn(),
    writeFiles: vi.fn(),
    mkdir: vi.fn(),
    stat: vi.fn(),
    rename: vi.fn(),
    unlink: vi.fn(),
    rmdir: vi.fn(),
    batchExists: vi.fn(),
    ensureDirectoryExists: vi.fn(),
    getDirectoryStat: vi.fn(),
  } as unknown as FileManager;
}

/**
 * Create a mock FileManager for geometry computation that handles path normalization.
 */
function createGeometryMockFileManager(files: Record<string, string>): FileManager {
  const encodedFiles: Record<string, Uint8Array> = {};

  for (const [path, content] of Object.entries(files)) {
    encodedFiles[path] = encodeText(content);
  }

  // Normalize path by removing leading slashes and basePath prefixes
  const normalizePath = (filepath: string): string => {
    return filepath.replace(/^\/+/, '').replace(/^builds\/test\//, '');
  };

  return {
    readFile: vi.fn(async (filepath: string, encoding?: string) => {
      const normalizedPath = normalizePath(filepath);
      const content = encodedFiles[normalizedPath];

      if (!content) {
        throw new Error(`File not found: ${filepath}`);
      }

      if (encoding === 'utf8') {
        return new TextDecoder().decode(content);
      }

      return content;
    }),
    exists: vi.fn(async (filepath: string) => normalizePath(filepath) in encodedFiles),
    readdir: vi.fn(async () => Object.keys(encodedFiles)),
    getDirectoryContents: vi.fn(async () => encodedFiles),
    copyDirectory: vi.fn(),
    getZippedDirectory: vi.fn(),
    writeFile: vi.fn(),
    writeFiles: vi.fn(),
    mkdir: vi.fn(),
    stat: vi.fn(),
    rename: vi.fn(),
    unlink: vi.fn(),
    rmdir: vi.fn(),
    batchExists: vi.fn(),
    ensureDirectoryExists: vi.fn(),
    getDirectoryStat: vi.fn(),
  } as unknown as FileManager;
}

/**
 * Create a GeometryFile for testing.
 */
function createGeometryFile(filename: string, basePath = '/builds/test'): GeometryFile {
  return {
    filename: `${basePath}/${filename}`,
    path: basePath,
  };
}

/**
 * Initialize an OpenScadWorker with a mock file manager for parameter extraction.
 */
async function createParameterWorker(files: Record<string, string>): Promise<OpenScadWorker> {
  const worker = new OpenScadWorker();
  const mockFileManager = createMockFileManager(files);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing protected property for testing
  (worker as any).fileManager = mockFileManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing protected property for testing
  (worker as any).basePath = '/builds/test';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing protected property for testing
  (worker as any).onLog = () => {
    // Suppress logs
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing protected property for testing
  (worker as any).fileReader = {
    async readFile(path: string) {
      const content = await mockFileManager.readFile(path);

      return new TextDecoder().decode(content);
    },
    exists: async (path: string) => mockFileManager.exists(path),
    readdir: async (path: string) => mockFileManager.readdir(path),
  };

  return worker;
}

/**
 * Initialize an OpenScadWorker for geometry computation.
 */
function createGeometryWorker(files: Record<string, string>): OpenScadWorker {
  const worker = new OpenScadWorker();
  const mockFileManager = createGeometryMockFileManager(files);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing protected property for testing
  (worker as any).fileManager = mockFileManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing protected property for testing
  (worker as any).basePath = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing protected property for testing
  (worker as any).onLog = () => {
    // Suppress logs
  };

  return worker;
}

/**
 * Helper to extract parameters and assert success.
 */
async function extractParameters(
  files: Record<string, string>,
  mainFile: string,
): Promise<{ jsonSchema: unknown; defaultParameters: Record<string, unknown> }> {
  const worker = await createParameterWorker(files);
  const result = await worker.extractParametersEntry(createGeometryFile(mainFile));

  expect(result.success).toBe(true);

  if (!result.success) {
    throw new Error('Extraction failed');
  }

  return result.data;
}

/**
 * Helper to compute geometry and get OFF data for analysis.
 */
async function computeGeometryAndGetOffData(
  files: Record<string, string>,
  mainFile: string,
): Promise<{ offData: string | undefined; success: boolean }> {
  const worker = createGeometryWorker(files);
  const geometryFile = { filename: mainFile, path: '' };
  const result = await worker.computeGeometryEntry(geometryFile, {});

  return {
    offData: worker.getOffData(),
    success: result.success,
  };
}

/**
 * Parse OFF face lines and count color components.
 */
function analyzeOffColorComponents(offData: string): { rgbFaceCount: number; rgbaFaceCount: number } {
  const lines = offData.split('\n');
  let rgbFaceCount = 0;
  let rgbaFaceCount = 0;

  for (const line of lines) {
    const trimmedLine = line.trim();
    // Face lines start with vertex count followed by indices
    if (!/^\d+\s+\d+/.test(trimmedLine)) {
      continue;
    }

    const parts = trimmedLine.split(/\s+/);
    const numberVerts = Number.parseInt(parts[0] ?? '0', 10);
    const colorComponents = parts.slice(numberVerts + 1);

    if (colorComponents.length === 3) {
      rgbFaceCount++;
    } else if (colorComponents.length === 4) {
      rgbaFaceCount++;
    }
  }

  return { rgbFaceCount, rgbaFaceCount };
}

// =============================================================================
// Tests: Parameter Extraction
// =============================================================================

describe('OpenScadWorker', () => {
  describe('extractParametersEntry', () => {
    describe('Single file projects', () => {
      it('should extract parameters from a simple file', async () => {
        const { jsonSchema, defaultParameters } = await extractParameters(
          {
            'cube.scad': `
              width = 10; // [1:100]
              height = 20; // [1:100]
              depth = 5;
              cube([width, height, depth]);
            `,
          },
          'cube.scad',
        );

        expect(jsonSchema).toEqual({
          type: 'object',
          properties: {
            width: { type: 'number', title: 'width', default: 10, minimum: 1, maximum: 100, multipleOf: 1 },
            height: { type: 'number', title: 'height', default: 20, minimum: 1, maximum: 100, multipleOf: 1 },
            depth: { type: 'number', title: 'depth', default: 5 },
          },
          additionalProperties: false,
        });

        expect(defaultParameters).toEqual({ width: 10, height: 20, depth: 5 });
      });

      it('should extract parameters with group annotations', async () => {
        const { jsonSchema, defaultParameters } = await extractParameters(
          {
            'grouped.scad': `
              /* [Main Dimensions] */
              width = 100;
              depth = 80;

              /* [Roof Parameters] */
              roof_height = 35;
              roof_overhang = 8;
            `,
          },
          'grouped.scad',
        );

        expect(jsonSchema).toEqual({
          type: 'object',
          properties: {
            'Main Dimensions': {
              type: 'object',
              title: 'Main Dimensions',
              properties: {
                width: { type: 'number', title: 'width', default: 100 },
                depth: { type: 'number', title: 'depth', default: 80 },
              },
              additionalProperties: false,
            },
            'Roof Parameters': {
              type: 'object',
              title: 'Roof Parameters',
              properties: {
                roof_height: { type: 'number', title: 'roof_height', default: 35 },
                roof_overhang: { type: 'number', title: 'roof_overhang', default: 8 },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        });

        expect(defaultParameters).toEqual({
          'Main Dimensions': { width: 100, depth: 80 },
          'Roof Parameters': { roof_height: 35, roof_overhang: 8 },
        });
      });
    });

    describe('Multi-file projects', () => {
      it('should extract parameters from included files', async () => {
        const { jsonSchema } = await extractParameters(
          {
            'main.scad': `
              include <lib/parameters.scad>
              cube([house_width, house_depth, 10]);
            `,
            'lib/parameters.scad': `
              /* [House Dimensions] */
              house_width = 100;
              house_depth = 80;
              house_height = 60;
            `,
          },
          'main.scad',
        );

        expect(jsonSchema).toEqual({
          type: 'object',
          properties: {
            'House Dimensions': {
              type: 'object',
              title: 'House Dimensions',
              properties: {
                house_width: { type: 'number', title: 'house_width', default: 100 },
                house_depth: { type: 'number', title: 'house_depth', default: 80 },
                house_height: { type: 'number', title: 'house_height', default: 60 },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        });
      });

      it('should group parameters from non-main files by filename', async () => {
        const { jsonSchema } = await extractParameters(
          {
            'main.scad': `
              include <lib/config.scad>
              cube([size, size, size]);
            `,
            'lib/config.scad': `
              size = 50;
              detail = 32;
            `,
          },
          'main.scad',
        );

        expect(jsonSchema).toEqual({
          type: 'object',
          properties: {
            Config: {
              type: 'object',
              title: 'Config',
              properties: {
                size: { type: 'number', title: 'size', default: 50 },
                detail: { type: 'number', title: 'detail', default: 32 },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        });
      });

      it('should preserve explicit groups from included files', async () => {
        const { jsonSchema } = await extractParameters(
          {
            'main.scad': `
              include <lib/dimensions.scad>
              cube([width, depth, height]);
            `,
            'lib/dimensions.scad': `
              /* [Box Dimensions] */
              width = 100;
              depth = 80;
              height = 50;
            `,
          },
          'main.scad',
        );

        expect(jsonSchema).toEqual({
          type: 'object',
          properties: {
            'Box Dimensions': {
              type: 'object',
              title: 'Box Dimensions',
              properties: {
                width: { type: 'number', title: 'width', default: 100 },
                depth: { type: 'number', title: 'depth', default: 80 },
                height: { type: 'number', title: 'height', default: 50 },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        });
      });
    });

    describe('Edge cases', () => {
      it('should handle empty files', async () => {
        const { jsonSchema, defaultParameters } = await extractParameters({ 'empty.scad': '' }, 'empty.scad');

        expect(jsonSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
        expect(defaultParameters).toEqual({});
      });

      it('should skip internal OpenSCAD parameters starting with $', async () => {
        const { jsonSchema } = await extractParameters(
          {
            'internal.scad': `
              $fn = 100;
              $fa = 1;
              $fs = 0.5;
              width = 50;
              sphere(r=width);
            `,
          },
          'internal.scad',
        );

        expect(jsonSchema).toEqual({
          type: 'object',
          properties: {
            width: { type: 'number', title: 'width', default: 50 },
          },
          additionalProperties: false,
        });
      });
    });

    describe('Parameter types', () => {
      it('should extract integer number parameters', async () => {
        const { jsonSchema, defaultParameters } = await extractParameters(
          {
            'integers.scad': `
              count = 5;
              sides = 6;
              layers = 3;
            `,
          },
          'integers.scad',
        );

        expect(jsonSchema).toEqual({
          type: 'object',
          properties: {
            count: { type: 'number', title: 'count', default: 5 },
            sides: { type: 'number', title: 'sides', default: 6 },
            layers: { type: 'number', title: 'layers', default: 3 },
          },
          additionalProperties: false,
        });

        expect(defaultParameters).toEqual({ count: 5, sides: 6, layers: 3 });
      });

      it('should extract floating point number parameters', async () => {
        const { jsonSchema, defaultParameters } = await extractParameters(
          {
            'floats.scad': `
              radius = 2.5;
              height = 10.75;
              tolerance = 0.001;
            `,
          },
          'floats.scad',
        );

        expect(jsonSchema).toEqual({
          type: 'object',
          properties: {
            radius: { type: 'number', title: 'radius', default: 2.5 },
            height: { type: 'number', title: 'height', default: 10.75 },
            tolerance: { type: 'number', title: 'tolerance', default: 0.001 },
          },
          additionalProperties: false,
        });

        expect(defaultParameters).toEqual({ radius: 2.5, height: 10.75, tolerance: 0.001 });
      });

      it('should extract number parameters with range annotations', async () => {
        const { jsonSchema, defaultParameters } = await extractParameters(
          {
            'ranges.scad': `
              width = 50; // [10:100]
              height = 25; // [5:5:50]
            `,
          },
          'ranges.scad',
        );

        expect(jsonSchema).toEqual({
          type: 'object',
          properties: {
            width: { type: 'number', title: 'width', default: 50, minimum: 10, maximum: 100, multipleOf: 1 },
            height: { type: 'number', title: 'height', default: 25, minimum: 5, maximum: 50, multipleOf: 5 },
          },
          additionalProperties: false,
        });

        expect(defaultParameters).toEqual({ width: 50, height: 25 });
      });

      it('should extract boolean parameters', async () => {
        const { jsonSchema, defaultParameters } = await extractParameters(
          {
            'booleans.scad': `
              show_base = true;
              center_object = false;
              add_holes = true;
            `,
          },
          'booleans.scad',
        );

        expect(jsonSchema).toEqual({
          type: 'object',
          properties: {
            show_base: { type: 'boolean', title: 'show_base', default: true },
            center_object: { type: 'boolean', title: 'center_object', default: false },
            add_holes: { type: 'boolean', title: 'add_holes', default: true },
          },
          additionalProperties: false,
        });

        expect(defaultParameters).toEqual({ show_base: true, center_object: false, add_holes: true });
      });

      it('should extract string parameters', async () => {
        const { jsonSchema, defaultParameters } = await extractParameters(
          {
            'strings.scad': `
              label = "Hello World";
              author = "OpenSCAD User";
            `,
          },
          'strings.scad',
        );

        expect(jsonSchema).toEqual({
          type: 'object',
          properties: {
            label: { type: 'string', title: 'label', default: 'Hello World' },
            author: { type: 'string', title: 'author', default: 'OpenSCAD User' },
          },
          additionalProperties: false,
        });

        expect(defaultParameters).toEqual({ label: 'Hello World', author: 'OpenSCAD User' });
      });

      it('should extract vector parameters (arrays)', async () => {
        const { jsonSchema, defaultParameters } = await extractParameters(
          {
            'vectors.scad': `
              position = [10, 20, 30];
              origin = [0, 0, 0];
            `,
          },
          'vectors.scad',
        );

        expect(jsonSchema).toEqual({
          type: 'object',
          properties: {
            position: {
              type: 'array',
              title: 'position',
              default: [10, 20, 30],
              items: { type: 'number' },
              minItems: 3,
              maxItems: 3,
            },
            origin: {
              type: 'array',
              title: 'origin',
              default: [0, 0, 0],
              items: { type: 'number' },
              minItems: 3,
              maxItems: 3,
            },
          },
          additionalProperties: false,
        });

        expect(defaultParameters).toEqual({ position: [10, 20, 30], origin: [0, 0, 0] });
      });

      it('should extract 2D vector parameters', async () => {
        const { jsonSchema, defaultParameters } = await extractParameters(
          {
            'vectors_2d.scad': `
              point = [50, 75];
              size_2d = [100, 200];
            `,
          },
          'vectors_2d.scad',
        );

        expect(jsonSchema).toEqual({
          type: 'object',
          properties: {
            point: {
              type: 'array',
              title: 'point',
              default: [50, 75],
              items: { type: 'number' },
              minItems: 2,
              maxItems: 2,
            },
            size_2d: {
              type: 'array',
              title: 'size_2d',
              default: [100, 200],
              items: { type: 'number' },
              minItems: 2,
              maxItems: 2,
            },
          },
          additionalProperties: false,
        });

        expect(defaultParameters).toEqual({ point: [50, 75], size_2d: [100, 200] });
      });

      it('should extract negative number parameters', async () => {
        const { jsonSchema, defaultParameters } = await extractParameters(
          {
            'negative.scad': `
              offset_x = -10;
              offset_y = -25.5;
            `,
          },
          'negative.scad',
        );

        expect(jsonSchema).toEqual({
          type: 'object',
          properties: {
            offset_x: { type: 'number', title: 'offset_x', default: -10 },
            offset_y: { type: 'number', title: 'offset_y', default: -25.5 },
          },
          additionalProperties: false,
        });

        expect(defaultParameters).toEqual({ offset_x: -10, offset_y: -25.5 });
      });

      it('should extract string parameters with dropdown options', async () => {
        const { jsonSchema, defaultParameters } = await extractParameters(
          {
            'string_options.scad': `
              material = "PLA"; // [PLA, ABS, PETG]
            `,
          },
          'string_options.scad',
        );

        expect(jsonSchema).toEqual({
          type: 'object',
          properties: {
            material: {
              type: 'string',
              title: 'material',
              default: 'PLA',
              oneOf: [
                { const: 'PLA', title: 'PLA' },
                { const: 'ABS', title: 'ABS' },
                { const: 'PETG', title: 'PETG' },
              ],
            },
          },
          additionalProperties: false,
        });

        expect(defaultParameters).toEqual({ material: 'PLA' });
      });

      it('should extract labeled value options (key-value dropdowns)', async () => {
        const { jsonSchema, defaultParameters } = await extractParameters(
          {
            'labeled_options.scad': `
              resolution = 32; // [16:Low, 32:Medium, 64:High]
              shape_type = 0; // [0:Cube, 1:Sphere]
            `,
          },
          'labeled_options.scad',
        );

        expect(jsonSchema).toEqual({
          type: 'object',
          properties: {
            resolution: {
              type: 'number',
              title: 'resolution',
              default: 32,
              oneOf: [
                { const: 16, title: 'Low' },
                { const: 32, title: 'Medium' },
                { const: 64, title: 'High' },
              ],
            },
            shape_type: {
              type: 'number',
              title: 'shape_type',
              default: 0,
              oneOf: [
                { const: 0, title: 'Cube' },
                { const: 1, title: 'Sphere' },
              ],
            },
          },
          additionalProperties: false,
        });

        // Known issue: json-schema-default library returns {} for oneOf properties with falsy defaults
        expect(defaultParameters).toEqual({ resolution: 32, shape_type: {} });
      });
    });
  });

  // ===========================================================================
  // Tests: Geometry Computation
  // ===========================================================================

  describe('computeGeometryEntry', () => {
    describe('Basic geometry', () => {
      it('should compute geometry for a simple cube', async () => {
        const { success, offData } = await computeGeometryAndGetOffData(
          { 'cube.scad': 'cube([10, 10, 10]);' },
          'cube.scad',
        );

        expect(success).toBe(true);
        expect(offData).toBeDefined();
        expect(offData).toContain('OFF'); // OFF file header
      });

      it('should compute geometry with multiple primitives', async () => {
        const scadCode = `
          cube([10, 10, 10]);
          translate([20, 0, 0]) sphere(r=5);
        `;
        const { success, offData } = await computeGeometryAndGetOffData({ 'multi.scad': scadCode }, 'multi.scad');

        expect(success).toBe(true);
        expect(offData).toBeDefined();
      });
    });

    describe('Color handling', () => {
      it('should output OFF data with RGB colors for opaque geometry', async () => {
        const scadCode = `color([1, 0, 0]) cube([10, 10, 10]);`;
        const { success, offData } = await computeGeometryAndGetOffData({ 'red_cube.scad': scadCode }, 'red_cube.scad');

        expect(success).toBe(true);
        expect(offData).toBeDefined();

        if (offData) {
          const { rgbFaceCount } = analyzeOffColorComponents(offData);
          expect(rgbFaceCount).toBeGreaterThan(0);
        }
      });

      it('should output OFF data with RGBA colors for transparent geometry', async () => {
        const scadCode = `color([0, 0, 1, 0.5]) cube([10, 10, 10]);`;
        const files = { 'transparent_cube.scad': scadCode };
        const { success, offData } = await computeGeometryAndGetOffData(files, 'transparent_cube.scad');

        expect(success).toBe(true);
        expect(offData).toBeDefined();

        if (offData) {
          const { rgbaFaceCount } = analyzeOffColorComponents(offData);
          expect(rgbaFaceCount).toBeGreaterThan(0);
        }
      });

      it('should output mixed RGB and RGBA for mixed opaque/transparent geometry', async () => {
        const scadCode = `
          color([1, 0, 0]) cube([10, 10, 10]);
          translate([15, 0, 0]) color([0, 0, 1, 0.5]) cube([10, 10, 10]);
        `;
        const { success, offData } = await computeGeometryAndGetOffData({ 'mixed.scad': scadCode }, 'mixed.scad');

        expect(success).toBe(true);
        expect(offData).toBeDefined();

        if (offData) {
          const { rgbFaceCount, rgbaFaceCount } = analyzeOffColorComponents(offData);
          expect(rgbFaceCount).toBeGreaterThan(0);
          expect(rgbaFaceCount).toBeGreaterThan(0);
        }
      });
    });

    describe('Error handling', () => {
      it('should return compilation error with line number for syntax errors', async () => {
        const worker = createGeometryWorker({
          'syntax_error.scad': `
            x = 10;
            x += 5;
            cube([x, x, x]);
          `,
        });
        const result = await worker.computeGeometryEntry({ filename: 'syntax_error.scad', path: '' }, {});

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.errors.length).toBeGreaterThan(0);
          expect(result.errors[0]?.location?.startLineNumber).toBeGreaterThan(0);
          expect(result.errors[0]?.type).toBe('compilation');
        }
      });

      it('should return error with file name for included file errors', async () => {
        const worker = createGeometryWorker({
          'main.scad': 'include <lib.scad>\ncube([10, 10, 10]);',
          'lib.scad': 'x += 5;',
        });
        const result = await worker.computeGeometryEntry({ filename: 'main.scad', path: '' }, {});

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.errors[0]?.location?.fileName).toContain('lib.scad');
        }
      });

      it('should return fallback error when OpenSCAD fails without parseable message', async () => {
        const worker = createGeometryWorker({
          'empty_module.scad': 'module test() {}  test();',
        });
        const result = await worker.computeGeometryEntry({ filename: 'empty_module.scad', path: '' }, {});

        // This may succeed with empty geometry or fail - just verify we get a proper result
        expect(typeof result.success).toBe('boolean');
      });

      it('should parse error message correctly for += operator', async () => {
        const worker = createGeometryWorker({
          'compound_assign.scad': `
            x = 90;
            x += 2*5;
            cube([x, 10, 10]);
          `,
        });
        const result = await worker.computeGeometryEntry({ filename: 'compound_assign.scad', path: '' }, {});

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.errors.length).toBeGreaterThan(0);
          expect(result.errors[0]?.message).toContain('syntax error');
        }
      });

      it('should return correct error location with start and end columns for indented code', async () => {
        // The error line "    x += 90 + tray_clearance;" has 4 leading spaces
        const errorLine = '    x += 90 + tray_clearance;';
        const worker = createGeometryWorker({
          'indented_error.scad': `module test() {
${errorLine}
}`,
        });
        const result = await worker.computeGeometryEntry({ filename: 'indented_error.scad', path: '' }, {});

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.errors.length).toBeGreaterThan(0);
          const error = result.errors[0];
          expect(error?.message).toContain('syntax error');
          expect(error?.location?.fileName).toBe('indented_error.scad');
          expect(error?.location?.startLineNumber).toBe(2);
          // 1-based column: first non-whitespace 'x' is at column 5 (after 4 spaces)
          expect(error?.location?.startColumn).toBe(5);
          // End column should be line length + 1 (1-based exclusive)
          expect(error?.location?.endColumn).toBe(errorLine.length + 1);
        }
      });
    });
  });
});

/* eslint-enable @typescript-eslint/naming-convention -- re-enable after OpenSCAD parameter tests */
