import * as replicad from 'replicad';
import type { OpenCascadeInstance as OpenCascadeInstanceWithExceptions } from 'replicad-opencascadejs/src/replicad_with_exceptions.js';
import type { OpenCascadeInstance } from 'replicad-opencascadejs';
import type {
  CreateGeometryResult,
  ExportGeometryResult,
  GetParametersResult,
  KernelIssue,
  ExtractNameResult,
  ExportFormat,
  GeometryGltf,
  GeometrySvg,
  KernelRuntime,
  KernelLogger,
  InitializeInput,
  CanHandleInput,
  GetParametersInput,
  CreateGeometryInput,
  ExportGeometryInput,
} from '@taucad/types';
import { isKernelError } from '@taucad/types/guards';
import { exposeWorker } from '#components/geometry/kernel/utils/comlink-worker.utils.js';
import { createKernelError, createKernelSuccess } from '#components/geometry/kernel/utils/kernel-helpers.js';
import {
  initOpenCascade,
  initOpenCascadeWithExceptions,
  opencascadeWasmUrl,
  opencascadeWithExceptionsWasmUrl,
} from '#components/geometry/kernel/replicad/init-open-cascade.js';
import { renderOutput } from '#components/geometry/kernel/replicad/utils/render-output.js';
import { convertReplicadGeometriesToGltf } from '#components/geometry/kernel/replicad/utils/replicad-to-gltf.js';
import { jsonSchemaFromJson } from '#utils/schema.utils.js';
import { asBuffer } from '#utils/file.utils.js';
import type { InputShape, MainResultShapes } from '#components/geometry/kernel/replicad/utils/render-output.js';
import type { RuntimeModuleExports } from '#components/geometry/kernel/utils/javascript-worker.js';
import { JavaScriptWorker } from '#components/geometry/kernel/utils/javascript-worker.js';
import { KernelWorker } from '#components/geometry/kernel/utils/kernel-worker.js';
import type { GeometryReplicad } from '#components/geometry/kernel/replicad/replicad.types.js';
// Font file for Replicad textBlueprints() rendering (Vite ?url import)
import geistRegularUrl from '#components/geometry/kernel/replicad/fonts/Geist-Regular.ttf?url';
import { wrapForComlink } from '#components/geometry/kernel/utils/kernel-comlink-adapter.js';

type ReplicadOptions = {
  /**
   * Whether to use OpenCascade with exceptions. Enabling this will set the OpenCascade
   * instance to use the OpenCascadeWithExceptions class, which has an error extraction
   * API for detailed error information.
   *
   * Enabling this will increase the initialization time of the OpenCascade instance,
   * and will also increase rendering time.
   *
   * This should only be enabled if you need to debug OpenCascade errors, usually
   * when designing CAD parts.
   *
   * @default false
   */
  withExceptions: boolean;
  /**
   * Mesh configuration for geometry tessellation.
   * Controls the quality of the mesh output.
   */
  meshConfiguration?: {
    /** The mesh tolerance in millimeters for linear distances. */
    linearTolerance: number;
    /** The mesh tolerance in degrees for angular distances. */
    angularTolerance: number;
  };
};

/**
 * Custom error class for OpenCASCADE numeric exceptions.
 * When Emscripten throws a C++ exception, it `throw`s a bare `number` (pointer).
 * This class wraps that number in a proper Error so the JS stack trace is preserved
 * from the call site closest to the WASM boundary.
 */
class OcExceptionError extends Error {
  public readonly ocExceptionPointer: number;

  public constructor(pointer: number) {
    super(`OpenCASCADE exception (ptr: ${pointer})`);
    this.name = 'OcExceptionError';
    this.ocExceptionPointer = pointer;
  }
}

/**
 * Rethrow a numeric exception as an OcExceptionError.
 * This preserves the JS call stack at the point of the WASM call.
 */
function rethrowIfNumeric(error: unknown): never {
  if (typeof error === 'number') {
    throw new OcExceptionError(error);
  }

  throw error;
}

// =============================================================================
// OpenCASCADE Exception -> Human-Readable Message Mapping
// =============================================================================

/**
 * Map from OC exception type name (from DynamicType().Name()) to a human-readable description.
 * The C++ type name is preserved in parentheses for advanced users / bug reports.
 *
 * Keys are matched via `startsWith` to handle both exact and prefixed names.
 * Order matters: more specific prefixes should appear before generic ones.
 */
const ocExceptionDescriptions: ReadonlyMap<string, string> = new Map([
  // Sweep / extrusion failures
  ['BRepSweep_Translation', 'Sweep/extrusion failed — the sweep distance may be zero or the profile is invalid'],
  ['BRepSweep', 'Sweep operation failed — check the profile and sweep parameters'],

  // Boolean operation failures
  ['BOPAlgo_AlertBOPNotAllowed', 'Boolean operation is not allowed for the given shapes'],
  ['BOPAlgo', 'Boolean operation failed — shapes may be invalid or non-intersecting'],

  // Builder / shape construction failures
  ['BRepBuilderAPI', 'Shape construction failed — check dimensions, points, or parameters'],

  // Fillet / chamfer failures
  ['BRepFilletAPI', 'Fillet/chamfer operation failed — radius may be too large for the edge'],
  ['ChFiDS', 'Fillet/chamfer data error — the edge geometry may be incompatible'],

  // Standard exception hierarchy
  ['Standard_ConstructionError', 'Construction failed — input geometry is degenerate or invalid'],
  ['Standard_NullObject', 'Operation received an empty or null shape'],
  ['Standard_NullValue', 'A required value is zero or null'],
  ['Standard_DimensionMismatch', 'Dimension mismatch between inputs'],
  ['Standard_DimensionError', 'Dimension error in the operation'],
  ['Standard_OutOfRange', 'A parameter is outside the valid range'],
  ['Standard_RangeError', 'A value is outside its valid range'],
  ['Standard_TypeMismatch', 'Wrong shape type for this operation'],
  ['Standard_DomainError', 'Mathematical domain error — input is outside the valid domain'],
  ['Standard_DivideByZero', 'Division by zero'],
  ['Standard_Overflow', 'Numeric overflow — value is too large'],
  ['Standard_Underflow', 'Numeric underflow — value is too small'],
  ['Standard_NumericError', 'Numeric error in computation'],
  ['Standard_ImmutableObject', 'Cannot modify an immutable object'],
  ['Standard_NoSuchObject', 'The requested object does not exist'],
  ['Standard_NotImplemented', 'This operation is not implemented'],
  ['Standard_ProgramError', 'Internal program error in the geometry kernel'],
  ['Standard_OutOfMemory', 'Out of memory — the operation requires too many resources'],

  // StdFail hierarchy
  ['StdFail_NotDone', 'Operation did not complete — the algorithm failed to produce a result'],
  ['StdFail_InfiniteSolutions', 'Infinite solutions — the problem is under-constrained'],
  ['StdFail_Undefined', 'Result is undefined for the given input'],

  // Geometry-specific
  ['Geom_UndefinedDerivative', 'Curve/surface derivative is undefined at this point'],
  ['Geom_UndefinedValue', 'Curve/surface value is undefined at this point'],

  // Generic fallback for Standard_Failure (base class)
  ['Standard_Failure', 'The geometry kernel encountered an error'],
]);

/**
 * Format an OpenCASCADE exception into a human-readable KernelError message.
 *
 * @param typeName - The C++ exception type name from DynamicType().Name()
 * @param rawMessage - The raw message from GetMessageString()
 * @returns Formatted message: `KernelError: <description> (<type>)`
 */
function formatOcExceptionMessage(typeName: string, rawMessage: string): string {
  // Try to match against known exception types.
  // Check typeName first (from DynamicType().Name()), then rawMessage
  // (OpenCASCADE often puts the type info in the message as "TypeName::Method").
  const candidates = [typeName, rawMessage].filter(Boolean);
  for (const candidate of candidates) {
    for (const [prefix, description] of ocExceptionDescriptions) {
      if (candidate.startsWith(prefix)) {
        // Include the raw identifier in parentheses for advanced users
        const identifier = typeName || rawMessage;
        return `KernelError: ${description} (${identifier})`;
      }
    }
  }

  // No mapping found: format with whatever info we have
  if (typeName && rawMessage) {
    return `KernelError: ${typeName}: ${rawMessage}`;
  }

  if (typeName || rawMessage) {
    return `KernelError: ${typeName || rawMessage}`;
  }

  return 'KernelError: Unknown kernel error';
}

/**
 * Wrap an OpenCASCADE WASM instance with a deep Proxy that intercepts all
 * function/constructor calls. When a call throws a numeric exception (Emscripten's
 * representation of a C++ exception), the Proxy catches it and re-throws an
 * OcExceptionError with the JS stack trace preserved from the call site.
 *
 * This enables source-map resolution to point back to the user's code that
 * triggered the failing OC operation (e.g., `.extrude(0)`).
 *
 * Uses a WeakMap cache to avoid re-wrapping the same object multiple times.
 */
/**
 * Check whether an object looks like an Emscripten-generated C++ wrapper instance.
 * These objects always have a `delete()` method for freeing WASM memory.
 * Non-wrapper objects (enum values, plain numbers, etc.) should NOT be proxied
 * because wrapping them breaks identity/equality comparisons that replicad relies on.
 */
function isEmscriptenObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'delete' in value &&
    typeof (value as Record<string, unknown>)['delete'] === 'function'
  );
}

function wrapOcInstance<T extends Record<string, unknown>>(instance: T): T {
  const proxyCache = new WeakMap<Record<string, unknown>, Record<string, unknown>>();

  function wrapObject(target: Record<string, unknown>): Record<string, unknown> {
    const cached = proxyCache.get(target);
    if (cached) {
      return cached;
    }

    const proxy: Record<string, unknown> = new Proxy(target, {
      get(proxyTarget, property, receiver) {
        // Fast path: skip wrapping for common non-throwing properties
        if (property === 'delete' || property === Symbol.toPrimitive || property === Symbol.toStringTag) {
          return Reflect.get(proxyTarget, property, receiver) as unknown;
        }

        const value: unknown = Reflect.get(proxyTarget, property, receiver);
        if (typeof value === 'function') {
          return wrapFunction(value as (...arguments_: unknown[]) => unknown);
        }

        return value;
      },
    });
    proxyCache.set(target, proxy);
    return proxy;
  }

  function maybeWrapResult(result: unknown): unknown {
    // Only wrap Emscripten C++ wrapper objects (those with delete()).
    // Do NOT wrap enum values, plain objects, or other non-OC objects
    // because wrapping them breaks identity/equality comparisons.
    if (isEmscriptenObject(result)) {
      return wrapObject(result);
    }

    return result;
  }

  function wrapFunction(function_: (...arguments_: unknown[]) => unknown): (...arguments_: unknown[]) => unknown {
    // Return a proxy that intercepts both `new fn()` (construct) and `fn()` (apply)
    return new Proxy(function_, {
      construct(target, arguments_: unknown[], newTarget: (...arguments_: unknown[]) => unknown) {
        try {
          const result: unknown = Reflect.construct(target, arguments_, newTarget);
          return maybeWrapResult(result) as Record<string, unknown>;
        } catch (error) {
          rethrowIfNumeric(error);
        }
      },
      apply(target, thisArgument: unknown, arguments_: unknown[]) {
        try {
          const result: unknown = Reflect.apply(target, thisArgument, arguments_);
          return maybeWrapResult(result);
        } catch (error) {
          rethrowIfNumeric(error);
        }
      },
    });
  }

  return wrapObject(instance) as T;
}

export class ReplicadWorker extends JavaScriptWorker<ReplicadOptions> {
  protected static override readonly supportedExportFormats: ExportFormat[] = [
    'stl',
    'stl-binary',
    'step',
    'step-assembly',
    'glb',
    'gltf',
  ];

  protected override readonly name: string = 'ReplicadWorker';

  private replicadHasOc = false;
  private shapesMemory: Record<string, InputShape[]> = {};
  private readonly ocVersions: {
    withExceptions: Promise<OpenCascadeInstanceWithExceptions> | undefined;
    single: Promise<OpenCascadeInstance> | undefined;
    current: 'single' | 'withExceptions';
  } = {
    withExceptions: undefined,
    single: undefined,
    current: 'single',
  };

  private oc: Promise<OpenCascadeInstance | OpenCascadeInstanceWithExceptions> | undefined;
  private isInitializing = false;
  private kernelLogger: KernelLogger | undefined;

  public constructor() {
    super();
  }

  /**
   * Extract default name from a CAD module.
   */
  public async extractDefaultNameFromCode(module: RuntimeModuleExports): Promise<ExtractNameResult> {
    return createKernelSuccess(this.extractDefaultName(module));
  }

  /**
   * Identify replicad as a known library for frame classification.
   */
  protected override getLibraryPathPatterns(): Array<{ pattern: string; moduleName: string }> {
    return [{ pattern: 'node_modules/replicad/', moduleName: 'replicad' }];
  }

  /**
   * Register replicad as a runtime module.
   * This is called during initialization after WASM is loaded.
   */
  protected override async registerKernelModules(): Promise<void> {
    // Register replicad with its loaded exports
    this.registerRuntimeModule('replicad', '0.19.1', replicad as unknown as Record<string, unknown>, {
      globalName: 'replicad',
    });
  }

  /**
   * Format OpenCASCADE exceptions into structured KernelIssue objects.
   *
   * Handles two exception shapes:
   * - `OcExceptionError` (from the OC proxy): has the original pointer AND a proper
   *   JS stack trace with user-code frames (e.g., the `.extrude(0)` call site).
   * - Bare `number` (direct Emscripten throw, fallback): the JS stack is already
   *   unwound, so only a synthetic catch-site stack is available.
   */
  protected override async formatRuntimeError(error: unknown): Promise<KernelIssue> {
    // OcExceptionError: thrown by the OC proxy wrapper.
    // It carries both the exception pointer AND a JS stack with user-code frames.
    if (error instanceof OcExceptionError) {
      const { message, cppStack } = await this.decodeOcException(error.ocExceptionPointer);
      // Use the OcExceptionError's own stack (captured at the WASM boundary)
      // which includes user-code frames that the source map resolver can map.
      const stackFrames = await this.applyLibrarySourceMaps(this.parseStackTrace(error));
      const location = this.deriveLocationFromFrames(stackFrames);
      return { message, location, type: 'kernel', severity: 'error', stack: cppStack, stackFrames };
    }

    // Bare numeric exception (Emscripten throw without proxy interception).
    // User-code frames are lost; synthesize a stack from the catch site.
    if (typeof error === 'number') {
      const { message, cppStack } = await this.decodeOcException(error);
      const syntheticError = new Error(message);
      const stackFrames = await this.applyLibrarySourceMaps(this.parseStackTrace(syntheticError));
      const location = this.deriveLocationFromFrames(stackFrames);
      return { message, location, type: 'kernel', severity: 'error', stack: cppStack, stackFrames };
    }

    return super.formatRuntimeError(error);
  }

  protected override async initialize(input: InitializeInput<ReplicadOptions>, runtime: KernelRuntime): Promise<void> {
    const { options } = input;
    const { logger } = runtime;
    this.kernelLogger = logger;
    const { withExceptions } = options;
    const startTime = performance.now();
    const oc = await this.initializeOpenCascadeInstance(withExceptions, logger);
    const ocEndTime = performance.now();
    logger.debug(`OpenCascade initialization took ${ocEndTime - startTime}ms`);

    if (!this.replicadHasOc) {
      logger.debug('Setting OC in replicad');
      // When withExceptions is enabled, wrap the OC instance with a Proxy that converts
      // numeric C++ exceptions into OcExceptionError with proper JS stack traces.
      // This allows source maps to trace errors back to the user's code.
      const ocForReplicad = withExceptions ? wrapOcInstance(oc) : oc;
      replicad.setOC(ocForReplicad);
      this.replicadHasOc = true;
    }

    // Load default font for textBlueprints() and sketchText()
    // Font loading is non-critical - text functions will warn if font is unavailable
    // replicad.loadFont() is idempotent and skips if font already loaded
    try {
      logger.debug('Loading default font for text rendering');
      await replicad.loadFont(geistRegularUrl, 'default');
    } catch (error) {
      logger.warn('Failed to load default font for text rendering - text functions may not work', {
        data: error,
      });
    }

    // Call super to register built-in modules
    await super.initialize(input, runtime);
  }

  protected override async canHandle(
    { filePath, extension }: CanHandleInput,
    { filesystem }: KernelRuntime,
  ): Promise<boolean> {
    // Check if the file format is a JavaScript/TypeScript file
    // JSX/TSX files are not supported as they require React transpilation
    if (!['ts', 'js'].includes(extension)) {
      return false;
    }

    // Extract code and check for replicad imports/usage
    const code = await filesystem.readFile(filePath, 'utf8');

    // Check for direct replicad imports
    // Use 's' flag to make '.' match newlines for multiline imports
    const hasImportStatement = (() => /import.*from\s+['"]replicad['"]/s.test(code))();
    const hasRequireStatement = (() => /require\s*\(['"]replicad['"]\)/.test(code))();
    const hasDestructuredAssignment = (() => /\bconst\s*{\s*[\w\s,]*}\s*=\s*replicad\s*;/.test(code))();

    // Check for JSDoc typedef referencing replicad
    const hasReplicadTypedef = (() => /@typedef.*import\s*\(\s*['"]replicad['"]\s*\)/.test(code))();

    // Check for replicad-related CDN imports (replicad-decorate, etc.)
    const hasReplicadCdnImport = (() => /import.*from\s+['"]https?:\/\/[^'"]*replicad[^'"]*['"]/s.test(code))();

    return (
      hasImportStatement ||
      hasRequireStatement ||
      hasDestructuredAssignment ||
      hasReplicadTypedef ||
      hasReplicadCdnImport
    );
  }

  protected override getAssetUrls(): string[] {
    return [geistRegularUrl, opencascadeWasmUrl, opencascadeWithExceptionsWasmUrl];
  }

  protected override async getParameters(
    { filePath, basePath }: GetParametersInput,
    runtime: KernelRuntime,
  ): Promise<GetParametersResult> {
    const { logger } = runtime;
    const relativeFilePath = KernelWorker.resolveToRelative(filePath, basePath);

    try {
      // Bundle the entry file
      const bundleResult = await this.bundle(filePath, runtime, basePath);

      if (!bundleResult.success) {
        return createKernelError(this.enrichIssuesWithFallbackLocation(bundleResult.issues, relativeFilePath));
      }

      // Execute the bundled code
      const executeResult = await this.execute(bundleResult.code);

      if (!executeResult.success) {
        return createKernelError(this.enrichIssuesWithFallbackLocation(executeResult.issues, relativeFilePath));
      }

      // Extract default parameters from the module
      const defaultParameters = this.extractDefaultParams(executeResult.value);
      const jsonSchema = await jsonSchemaFromJson(defaultParameters);

      return createKernelSuccess({
        defaultParameters,
        jsonSchema,
      });
    } catch (error) {
      const kernelIssue = await this.formatKernelIssue(error, logger, relativeFilePath);
      return createKernelError([kernelIssue]);
    }
  }

  protected override async createGeometry(
    { filePath, basePath, parameters }: CreateGeometryInput,
    runtime: KernelRuntime,
  ): Promise<CreateGeometryResult> {
    const { logger } = runtime;
    const relativeFilePath = KernelWorker.resolveToRelative(filePath, basePath);
    const startTime = performance.now();
    logger.log('Computing geometry from code');

    try {
      // Bundle the entry file
      const bundleStartTime = performance.now();
      const bundleResult = await this.bundle(filePath, runtime, basePath);
      const bundleEndTime = performance.now();
      logger.log(`Bundling took ${bundleEndTime - bundleStartTime}ms`);

      if (!bundleResult.success) {
        return createKernelError(this.enrichIssuesWithFallbackLocation(bundleResult.issues, relativeFilePath));
      }

      // Execute the bundled code
      const executeResult = await this.execute(bundleResult.code);

      if (!executeResult.success) {
        return createKernelError(this.enrichIssuesWithFallbackLocation(executeResult.issues, relativeFilePath));
      }

      const module = executeResult.value;

      let shapes: MainResultShapes;
      let defaultName: string | undefined;

      try {
        const runCodeStartTime = performance.now();
        const mainResult = await this.runMain<MainResultShapes>(module, parameters);

        if (!mainResult.success) {
          return createKernelError(this.enrichIssuesWithFallbackLocation(mainResult.issues, relativeFilePath));
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
                location: { fileName: relativeFilePath, startLineNumber: 1, startColumn: 0 },
                type: 'runtime',
                severity: 'warning',
              },
            ],
          );
        }

        const defaultNameResult = await this.extractDefaultNameFromCode(module);
        defaultName = isKernelError(defaultNameResult) ? undefined : defaultNameResult.data;
      } catch (error) {
        const endTime = performance.now();
        logger.error(`Error occurred after ${endTime - startTime}ms`, { data: error });
        const kernelIssue = await this.formatKernelIssue(error, logger, relativeFilePath);
        return createKernelError([kernelIssue]);
      }

      const renderStartTime = performance.now();
      const renderedShapes = renderOutput(
        shapes,
        (shapesArray) => {
          this.shapesMemory['default'] = shapesArray;
          return shapesArray;
        },
        defaultName,
      );
      const renderEndTime = performance.now();
      logger.log(`Tessellation took ${renderEndTime - renderStartTime}ms`);

      const gltfStartTime = performance.now();
      const shapes3d = renderedShapes.filter((shape): shape is GeometryReplicad => shape.format === 'replicad');
      const shapes2d = renderedShapes.filter((shape): shape is GeometrySvg => shape.format === 'svg');

      if (shapes3d.length === 0 && shapes2d.length === 0) {
        return createKernelSuccess([]);
      }

      const gltfShapes = [];
      if (shapes3d.length > 0) {
        const gltfBlob = await convertReplicadGeometriesToGltf(shapes3d, 'glb');
        const gltfEndTime = performance.now();
        logger.log(`GLTF conversion took ${gltfEndTime - gltfStartTime}ms`);

        const shapeGltf: GeometryGltf = {
          format: 'gltf',
          content: gltfBlob,
        };
        gltfShapes.push(shapeGltf);
      }

      const totalTime = performance.now() - startTime;
      logger.log(`Total createGeometry time: ${totalTime}ms`);

      return createKernelSuccess([...gltfShapes, ...shapes2d]);
    } catch (error) {
      logger.error('Error in createGeometry', { data: error });
      const kernelIssue = await this.formatKernelIssue(error, logger, relativeFilePath);
      return createKernelError([kernelIssue]);
    }
  }

  protected override async exportGeometry(
    { fileType, meshConfig }: ExportGeometryInput,
    { logger }: KernelRuntime,
  ): Promise<ExportGeometryResult> {
    const geometryId = 'default';
    const config = meshConfig ?? { linearTolerance: 0.01, angularTolerance: 30 };
    try {
      if (!this.shapesMemory[geometryId]) {
        // System error - no location needed
        return createKernelError([
          {
            message: `Geometry ${geometryId} not computed yet`,
            type: 'runtime',
            severity: 'error',
          },
        ]);
      }

      if (fileType === 'glb' || fileType === 'gltf') {
        const temporaryShapes = this.shapesMemory[geometryId].map((shapeConfig) => {
          const { shape } = shapeConfig;
          const faces = shape.mesh({
            tolerance: config.linearTolerance,
            angularTolerance: config.angularTolerance,
          });

          return {
            format: 'replicad',
            name: shapeConfig.name ?? 'Geometry',
            color: (shapeConfig as { color?: string }).color,
            opacity: (shapeConfig as { opacity?: number }).opacity,
            faces,
            edges: {
              lines: [],
              edgeGroups: [],
            },
          } satisfies GeometryReplicad;
        });

        const gltfBlob = await convertReplicadGeometriesToGltf(temporaryShapes, fileType);
        return createKernelSuccess([
          {
            blob: new Blob([asBuffer(gltfBlob.buffer)]),
            name: fileType === 'glb' ? 'model.glb' : 'model.gltf',
          },
        ]);
      }

      if (fileType === 'step-assembly') {
        const result = [
          {
            blob: replicad.exportSTEP(this.shapesMemory[geometryId]),
            name: geometryId,
          },
        ];
        return createKernelSuccess(result);
      }

      const result = this.shapesMemory[geometryId].map(({ shape, name }) => ({
        blob: this.buildBlob(shape, fileType, {
          tolerance: config.linearTolerance,
          angularTolerance: config.angularTolerance,
        }),
        name: name ?? 'Geometry',
      }));
      return createKernelSuccess(result);
    } catch (error) {
      // Export errors don't have file context, so omit location
      const kernelIssue = await this.formatKernelIssue(error, logger);
      return createKernelError([
        {
          message: kernelIssue.message,
          stack: kernelIssue.stack,
          stackFrames: kernelIssue.stackFrames,
          type: kernelIssue.type,
          severity: 'error',
        },
      ]);
    }
  }

  /**
   * Decode OpenCASCADE exception pointer into a human-readable KernelError message.
   * Returns the enriched message and optional C++ stack, or falls back to a generic message.
   *
   * Message format: `KernelError: <human-readable explanation> (<C++ type>)`
   * Falls back to: `KernelError: <C++ type>: <raw message>` if no mapping exists.
   */
  private async decodeOcException(pointer: number): Promise<{ message: string; cppStack?: string }> {
    let message = `KernelError: Unknown kernel error (code ${pointer})`;
    let cppStack: string | undefined;

    try {
      const ocInstance = await this.oc;
      if (ocInstance && this.ocVersions.current === 'withExceptions') {
        const failureData = this.extractStandardFailureData(ocInstance as OpenCascadeInstanceWithExceptions, pointer);
        message = formatOcExceptionMessage(failureData.typeName, failureData.message);
        cppStack = failureData.cppStack || undefined;

        this.kernelLogger?.debug('OpenCASCADE exception', {
          data: { message, typeName: failureData.typeName, cppStack: failureData.cppStack },
        });
      }
    } catch {
      // Fall through to generic message
    }

    return { message, cppStack };
  }

  /**
   * Extract the exception type name from an OpenCASCADE Standard_Failure object.
   * DynamicType() returns Handle_Standard_Type which has .Name() at runtime
   * but is not exposed in the TypeScript type definitions.
   */
  private extractExceptionTypeName(
    errorData: ReturnType<OpenCascadeInstanceWithExceptions['OCJS']['getStandard_FailureData']>,
  ): string {
    try {
      // DynamicType() returns Handle_Standard_Type which has Name() at runtime
      // but is not exposed in the TypeScript type definitions.
      // Cast through unknown to safely access the untyped C++ API.
      // eslint-disable-next-line new-cap, @typescript-eslint/naming-convention -- C++ method with PascalCase convention
      const dynType = errorData.DynamicType() as unknown as { Name(): string; delete(): void };
      try {
        // eslint-disable-next-line new-cap -- C++ method Name() is PascalCase in OpenCASCADE
        return dynType.Name();
      } finally {
        dynType.delete();
      }
    } catch {
      return '';
    }
  }

  /**
   * Extract message, type name, and C++ stack from an OpenCASCADE Standard_Failure.
   * Frees WASM memory for the error data when done.
   */
  private extractStandardFailureData(
    ocInstance: OpenCascadeInstanceWithExceptions,
    errorPointer: number,
  ): { message: string; typeName: string; cppStack: string } {
    const errorData = ocInstance.OCJS.getStandard_FailureData(errorPointer);
    try {
      // eslint-disable-next-line new-cap -- C++ method
      const errorMessage = errorData.GetMessageString();
      // eslint-disable-next-line new-cap -- C++ method
      const cppStack = errorData.GetStackString();
      const typeName = this.extractExceptionTypeName(errorData);
      return { message: errorMessage, typeName, cppStack };
    } finally {
      errorData.delete();
    }
  }

  private async initializeOpenCascadeInstance(
    withExceptions: boolean,
    logger: KernelLogger,
  ): Promise<OpenCascadeInstance> {
    if (this.isInitializing) {
      logger.debug('Already initializing OpenCascade, returning existing promise');
      if (!this.oc) {
        throw new Error('OpenCascade initialization in progress but oc is undefined');
      }

      return this.oc;
    }

    this.isInitializing = true;
    const startTime = performance.now();

    try {
      this.ocVersions.current = withExceptions ? 'withExceptions' : 'single';

      if (withExceptions) {
        if (!this.ocVersions.withExceptions) {
          logger.debug('Initializing OpenCascade with exceptions');
          this.ocVersions.withExceptions = initOpenCascadeWithExceptions();
        }

        this.oc = this.ocVersions.withExceptions;
      } else {
        if (!this.ocVersions.single) {
          logger.debug('Initializing OpenCascade without exceptions');
          this.ocVersions.single = initOpenCascade();
        }

        this.oc = this.ocVersions.single;
      }

      const result = await this.oc;
      const endTime = performance.now();
      logger.debug(`OpenCascade initialized successfully in ${endTime - startTime}ms`);
      return result;
    } catch (error) {
      logger.error('Failed to initialize OpenCascade', { data: error });
      throw error;
    } finally {
      this.isInitializing = false;
    }
  }

  private async formatKernelIssue(error: unknown, logger: KernelLogger, fileName?: string): Promise<KernelIssue> {
    logger.debug('Formatting kernel error', { data: error });

    // Numeric errors (OpenCascade): delegate to formatRuntimeError which decodes via getStandard_FailureData
    if (typeof error === 'number') {
      return this.formatRuntimeError(error);
    }

    // Error instances and strings: delegate to base class method for location/stack parsing
    const result = this.createKernelIssueFromError(error, 'Unknown error occurred', fileName);
    return result.issues[0]!;
  }

  private buildBlob(
    shape: replicad.AnyShape,
    fileType: string,
    meshConfig: { tolerance: number; angularTolerance: number },
  ): Blob {
    if (fileType === 'stl') {
      return shape.blobSTL(meshConfig);
    }

    if (fileType === 'stl-binary') {
      return shape.blobSTL({ ...meshConfig, binary: true });
    }

    if (fileType === 'step') {
      return shape.blobSTEP();
    }

    throw new Error(`Filetype "${fileType}" unknown for export.`);
  }
}

const worker = new ReplicadWorker();
const service = wrapForComlink(worker);
exposeWorker(service);

export type ReplicadWorkerInterface = typeof service;
