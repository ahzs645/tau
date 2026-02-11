import * as jscadModeling from '@jscad/modeling';
import type {
  CreateGeometryResult,
  ExportFormat,
  ExportGeometryResult,
  GetParametersResult,
  GeometryResponse,
  KernelRuntime,
  KernelLogger,
  InitializeInput,
  CanHandleInput,
  GetDependenciesInput,
  GetParametersInput,
  CreateGeometryInput,
  ExportGeometryInput,
} from '@taucad/types';
import { exposeWorker } from '#components/geometry/kernel/utils/comlink-worker.utils.js';
import { createKernelError, createKernelSuccess } from '#components/geometry/kernel/utils/kernel-helpers.js';
import { JavaScriptWorker } from '#components/geometry/kernel/utils/javascript-worker.js';
import { KernelWorker } from '#components/geometry/kernel/utils/kernel-worker.js';
import { jscadToGltf } from '#components/geometry/kernel/jscad/jscad-to-gltf.js';
import { jsonSchemaFromJson } from '#utils/schema.utils.js';
import { asBuffer } from '#utils/file.utils.js';
import type { JscadParameterDefinition } from '#components/geometry/kernel/jscad/jscad.schema.js';
import {
  convertParameterDefinitionsToDefaults,
  convertParameterDefinitionsToJsonSchema,
} from '#components/geometry/kernel/jscad/jscad.schema.js';
import { wrapForComlink } from '#components/geometry/kernel/utils/kernel-comlink-adapter.js';

type JscadModuleExports = {
  getParameterDefinitions?: () => JscadParameterDefinition[];
  defaultParams?: () => Record<string, unknown>;
};

/**
 * Type guard to check if a value is a plain object (Record<string, unknown>)
 */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Type guard to check if a module has parameter-related exports
 * (getParameterDefinitions function or defaultParams object)
 */
function isModuleWithParameters(module: unknown): module is JscadModuleExports {
  if (!isRecordObject(module)) {
    return false;
  }

  const hasGetParameterDefinitions =
    'getParameterDefinitions' in module && typeof module['getParameterDefinitions'] === 'function';
  const hasDefaultParameters = 'defaultParams' in module;

  return hasGetParameterDefinitions || hasDefaultParameters;
}

/**
 * JSCAD worker for executing @jscad/modeling scripts
 *
 * Features:
 * - Detects JSCAD files by checking for '@jscad/modeling' imports/requires
 * - Executes user code in a sandboxed VM with @jscad/modeling injected
 * - Converts JSCAD geometries to GLTF for rendering
 * - Supports parameter extraction from getParameterDefinitions()
 */
export class JscadWorker extends JavaScriptWorker {
  protected static override readonly supportedExportFormats: ExportFormat[] = ['glb', 'gltf'];
  protected override readonly name: string = 'JscadWorker';

  private shapesMemory: Record<string, unknown[]> = {};
  private geometryAccessOrder: string[] = [];
  private get maxStoredGeometries() {
    // Keep last 5 geometries to prevent unbounded memory growth
    return 5;
  }

  public constructor() {
    super();
  }

  /**
   * Register @jscad/modeling as a runtime module.
   */
  protected override async registerKernelModules(): Promise<void> {
    this.registerRuntimeModule('@jscad/modeling', '2.12.6', jscadModeling, {
      globalName: 'jscadModeling',
      submodules: [
        'booleans',
        'colors',
        'curves',
        'expansions',
        'extrusions',
        'geometries',
        'hulls',
        'maths',
        'measurements',
        'modifiers',
        'primitives',
        'text',
        'transforms',
        'utils',
      ],
    });
  }

  /**
   * Include JSCAD-specific `getParameterDefinitions` in auto-export names.
   */
  protected override getAutoExportNames(): string[] {
    return [...super.getAutoExportNames(), 'getParameterDefinitions'];
  }

  protected override async initialize(input: InitializeInput, runtime: KernelRuntime): Promise<void> {
    await super.initialize(input, runtime);
    runtime.logger.debug('Initialized JSCAD worker with @jscad/modeling');
  }

  protected override async cleanup(): Promise<void> {
    // Clear all stored shapes to free memory
    this.shapesMemory = {};
    this.geometryAccessOrder = [];
  }

  protected override async canHandle(
    { filePath, extension }: CanHandleInput,
    { filesystem }: KernelRuntime,
  ): Promise<boolean> {
    // JSX/TSX files are not supported as they require React transpilation
    if (!['ts', 'js'].includes(extension)) {
      return false;
    }

    const code = await filesystem.readFile(filePath, 'utf8');
    const hasEsmImport = /import\s+.*from\s+['"]@jscad\/modeling(\/[^'"]*)?['"]/.test(code);
    const hasRequire = /require\s*\(\s*['"]@jscad\/modeling(\/[^'"]*)?['"]\s*\)/.test(code);
    return hasEsmImport || hasRequire;
  }

  protected override async getDependencies({ filePath }: GetDependenciesInput): Promise<string[]> {
    // JSCAD currently only supports single-file operations
    // Return absolute path
    return [filePath];
  }

  /**
   * Extract parameter definitions from JSCAD code
   *
   * Analyzes JSCAD source code to extract user-configurable parameters. Supports both
   * ES Module and CommonJS formats. The function looks for either:
   * - getParameterDefinitions() export: Standard JSCAD pattern returning parameter array
   * - defaultParams export: Simplified pattern for basic parameter objects
   *
   * Parameter extraction flow:
   * 1. Detects code format (ES Module vs CommonJS)
   * 2. Executes code in sandboxed VM to access exports
   * 3. Extracts parameter definitions if present
   * 4. Converts to default values object and JSON Schema
   * 5. Returns both for UI generation and validation
   *
   * If no parameters are found, returns empty defaults with generated schema.
   * Errors during extraction are caught and returned as kernel issues.
   *
   * @param file - Geometry file containing JSCAD source code
   * @returns GetParametersResult containing:
   *          - defaultParameters: Object mapping parameter names to initial values
   *          - jsonSchema: JSON Schema object for validation and UI generation
   *          - Or kernel error if extraction fails
   *
   * @example
   * ```typescript
   * // ES Module format
   * export function getParameterDefinitions() {
   *   return [
   *     { name: 'width', caption: 'Width:', type: 'float', initial: 10 }
   *   ];
   * }
   *
   * // Or CommonJS format
   * module.exports.defaultParams = { width: 10 };
   * ```
   */
  protected override async getParameters(
    { filePath, basePath }: GetParametersInput,
    runtime: KernelRuntime,
  ): Promise<GetParametersResult> {
    const relativeFilePath = KernelWorker.resolveToRelative(filePath, basePath);

    try {
      // Bundle the entry file
      const bundleResult = await this.bundle(filePath, runtime, basePath);

      if (!bundleResult.success) {
        return createKernelError(bundleResult.issues);
      }

      // Execute the bundled code
      const executeResult = await this.execute(bundleResult.code);

      if (!executeResult.success) {
        return createKernelError(executeResult.issues);
      }

      const module = executeResult.value;
      let defaultParameters: Record<string, unknown> = {};
      let jsonSchema;

      // Check for getParameterDefinitions function (ES module export)
      if (isModuleWithParameters(module)) {
        if (typeof module.getParameterDefinitions === 'function') {
          const definitions = module.getParameterDefinitions();
          defaultParameters = convertParameterDefinitionsToDefaults(definitions);
          jsonSchema = convertParameterDefinitionsToJsonSchema(definitions);
        } else if (module.defaultParams && isRecordObject(module.defaultParams)) {
          defaultParameters = module.defaultParams;
          jsonSchema = await jsonSchemaFromJson(defaultParameters);
        } else {
          // Also check for the standard defaultParams export
          const baseParameters = this.extractDefaultParams(module);
          if (Object.keys(baseParameters).length > 0) {
            defaultParameters = baseParameters;
          }

          jsonSchema = await jsonSchemaFromJson(defaultParameters);
        }
      } else {
        // Fall back to extracting defaultParams from the module
        defaultParameters = this.extractDefaultParams(module);
        jsonSchema = await jsonSchemaFromJson(defaultParameters);
      }

      return createKernelSuccess({
        defaultParameters,
        jsonSchema,
      });
    } catch (error) {
      return this.createKernelIssueFromError(error, 'Failed to extract parameters', relativeFilePath);
    }
  }

  /**
   * Compute 3D geometry from JSCAD code
   *
   * Executes user-provided JSCAD code in a sandboxed VM with @jscad/modeling available,
   * then converts the resulting geometry to glTF format for 3D visualization.
   *
   * Execution flow:
   * 1. Detects code format (ES Module vs CommonJS)
   * 2. Executes code via runCode() with user parameters
   * 3. Stores raw JSCAD shapes in memory for potential export
   * 4. Converts each shape to glTF format via jscadToGltf()
   * 5. Returns geometries as an array of Geometry objects
   *
   * Performance is tracked at multiple levels:
   * - Code execution time (VM runtime)
   * - GLTF conversion time (mesh processing)
   * - Total operation time
   *
   * Shape failures are logged as warnings but don't stop the pipeline - only successfully
   * converted shapes are included in the result.
   *
   * @param file - Geometry file containing JSCAD source code
   * @param parameters - Object mapping parameter names to values for parametric designs
   * @param geometryId - Unique identifier to store computed shapes in memory (default: 'default')
   * @returns CreateGeometryResult containing:
   *          - Array of Geometry objects with glTF blobs ready for rendering
   *          - Or kernel error if code execution fails
   *
   * @example
   * ```typescript
   * const file = { filePath: 'box.js', content: '...' };
   * const params = { width: 10, height: 20 };
   * const result = await worker.createGeometry(file, params);
   * // result is array of { format: 'gltf', gltfData: Blob }
   * ```
   */
  protected override async createGeometry(
    { filePath, basePath, parameters }: CreateGeometryInput,
    runtime: KernelRuntime,
  ): Promise<CreateGeometryResult> {
    const { logger } = runtime;
    const geometryId = 'default';
    const relativeFilePath = KernelWorker.resolveToRelative(filePath, basePath);
    const startTime = performance.now();
    logger.log('Computing JSCAD geometry from code');

    try {
      // Bundle the entry file
      const bundleStartTime = performance.now();
      const bundleResult = await this.bundle(filePath, runtime, basePath);
      const bundleEndTime = performance.now();
      logger.log(`Bundling took ${bundleEndTime - bundleStartTime}ms`);

      if (!bundleResult.success) {
        return createKernelError(bundleResult.issues);
      }

      // Execute the bundled code
      const executeResult = await this.execute(bundleResult.code);

      if (!executeResult.success) {
        return createKernelError(executeResult.issues);
      }

      const module = executeResult.value;

      // Execute the user code with parameters
      let shapes: unknown;

      try {
        const runCodeStartTime = performance.now();
        const mainResult = await this.runMain<unknown>(module, parameters);

        if (!mainResult.success) {
          return createKernelError(mainResult.issues);
        }

        shapes = mainResult.value;
        const runCodeEndTime = performance.now();
        logger.log(`Kernel computation took ${runCodeEndTime - runCodeStartTime}ms`);

        if (shapes === undefined) {
          return createKernelSuccess(
            [],
            [
              {
                message: 'The main function did not return a value. Did you forget a return statement?',
                type: 'runtime',
                severity: 'warning',
              },
            ],
          );
        }
      } catch (error) {
        const endTime = performance.now();
        logger.error(`Error occurred after ${endTime - startTime}ms`, { data: error });
        return this.createKernelIssueFromError(error, 'Failed to execute JSCAD code', relativeFilePath);
      }

      // Store shapes in memory for export with LRU cleanup
      const shapesArray = Array.isArray(shapes) ? shapes : [shapes];
      this.storeShapesWithLruCleanup(geometryId, shapesArray.filter(Boolean), logger);

      // Convert JSCAD geometry to GLTF for rendering
      if (shapesArray.length === 0) {
        return createKernelSuccess([]);
      }

      const gltfStartTime = performance.now();
      const geometries: GeometryResponse[] = [];

      // Convert shapes sequentially
      const results = await Promise.allSettled(shapesArray.filter(Boolean).map(async (shape) => jscadToGltf(shape)));

      for (const result of results) {
        if (result.status === 'fulfilled') {
          geometries.push({
            format: 'gltf',
            content: result.value,
          });
        } else {
          logger.warn('Failed to convert shape to GLTF', { data: result.reason });
        }
      }

      const gltfEndTime = performance.now();
      logger.log(`GLTF conversion took ${gltfEndTime - gltfStartTime}ms`);

      const endTime = performance.now();
      logger.log(`Total createGeometry took ${endTime - startTime}ms`);

      return createKernelSuccess(geometries);
    } catch (error) {
      return this.createKernelIssueFromError(error, 'Failed to compute JSCAD geometry', relativeFilePath);
    }
  }

  protected override async exportGeometry({ fileType }: ExportGeometryInput): Promise<ExportGeometryResult> {
    const geometryId = 'default';
    try {
      // Check if geometry exists in memory
      const shapes = this.shapesMemory[geometryId];
      if (!shapes || shapes.length === 0) {
        // System error - no location needed
        return createKernelError([
          {
            message: `Geometry ${geometryId} not computed yet. Please compute geometry before exporting.`,
            type: 'runtime',
            severity: 'error',
          },
        ]);
      }

      // Handle GLTF/GLB export by converting shapes to GLTF
      if (fileType === 'glb' || fileType === 'gltf') {
        const gltfBlobs = await Promise.all(shapes.map(async (shape) => jscadToGltf(shape)));

        // Merge all GLTF blobs into one (for simplicity, just return the first one)
        // In a more sophisticated implementation, you could merge multiple geometries
        const blob = gltfBlobs[0];
        if (!blob) {
          // System error - no location needed
          return createKernelError([
            {
              message: 'Failed to generate GLTF from computed geometry',
              type: 'runtime',
              severity: 'error',
            },
          ]);
        }

        return createKernelSuccess([
          {
            blob: new Blob([asBuffer(blob.buffer)]),
            name: fileType === 'glb' ? 'model.glb' : 'model.gltf',
          },
        ]);
      }

      // STL and STL-binary formats are not yet implemented for JSCAD
      // This would require installing and using @jscad/stl-serializer
      // System error - no location needed
      return createKernelError([
        {
          message: `Export format '${fileType}' is not yet implemented for JSCAD. Only 'glb' and 'gltf' formats are currently supported.`,
          type: 'runtime',
          severity: 'error',
        },
      ]);
    } catch (error) {
      return this.createKernelIssueFromError(error, 'Failed to export JSCAD geometry');
    }
  }

  /**
   * Store shapes in memory with LRU-based cleanup to prevent unbounded memory growth
   *
   * Implements a Least Recently Used (LRU) cache strategy that:
   * - Tracks access order of geometry IDs
   * - Removes oldest geometries when maxStoredGeometries limit is exceeded
   * - Updates access order when existing geometry is recomputed
   *
   * This prevents memory leaks from accumulating shapes when multiple different
   * geometryId values are used over the worker's lifetime.
   *
   * @param geometryId - The unique identifier for this geometry
   * @param shapes - Array of JSCAD geometry objects to store
   * @param logger - Logger interface for debug output
   *
   * @internal This is a private method used internally by createGeometry().
   */
  private storeShapesWithLruCleanup(geometryId: string, shapes: unknown[], logger: KernelLogger): void {
    // Update access order - remove if exists and add to end (most recent)
    const existingIndex = this.geometryAccessOrder.indexOf(geometryId);
    if (existingIndex !== -1) {
      this.geometryAccessOrder.splice(existingIndex, 1);
    }

    this.geometryAccessOrder.push(geometryId);

    // Store the shapes
    this.shapesMemory[geometryId] = shapes;

    // Remove oldest geometries if we exceed the limit
    while (this.geometryAccessOrder.length > this.maxStoredGeometries) {
      const oldestGeometryId = this.geometryAccessOrder.shift();
      if (oldestGeometryId) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- LRU cache cleanup
        delete this.shapesMemory[oldestGeometryId];
        logger.debug(`Cleaned up old geometry from memory: ${oldestGeometryId}`);
      }
    }
  }
}

const worker = new JscadWorker();
const service = wrapForComlink(worker);
exposeWorker(service);

export type JscadWorkerInterface = typeof service;
