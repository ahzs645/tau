import * as replicad from 'replicad';
import ErrorStackParser from 'error-stack-parser';
import type { OpenCascadeInstance as OpenCascadeInstanceWithExceptions } from 'replicad-opencascadejs/src/replicad_with_exceptions.js';
import type { OpenCascadeInstance } from 'replicad-opencascadejs';
import type {
  CreateGeometryResult,
  KernelStackFrame,
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
  GetDependenciesInput,
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
import { runInCjsContext, buildEsModule, registerKernelModules } from '#components/geometry/kernel/replicad/vm.js';
import { renderOutput } from '#components/geometry/kernel/replicad/utils/render-output.js';
import { convertReplicadGeometriesToGltf } from '#components/geometry/kernel/replicad/utils/replicad-to-gltf.js';
import { jsonSchemaFromJson } from '#utils/schema.utils.js';
import { asBuffer } from '#utils/file.utils.js';
import type { InputShape, MainResultShapes } from '#components/geometry/kernel/replicad/utils/render-output.js';
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

export class ReplicadWorker extends KernelWorker<ReplicadOptions> {
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

  public constructor() {
    super();
    registerKernelModules();
  }

  public async extractDefaultNameFromCode(code: string): Promise<ExtractNameResult> {
    if (/^\s*export\s+/m.test(code)) {
      const module = await buildEsModule(code);
      return createKernelSuccess(module.defaultName ?? undefined);
    }

    const editedText = `
${code}
try {
  return defaultName;
} catch (e) {
  return;
}
  `;

    try {
      const result = await runInCjsContext(editedText, {});
      return createKernelSuccess((result ?? {}) as string | undefined);
    } catch {
      // System error - no location needed
      return createKernelError([
        {
          message: 'Failed to extract default name from code',
          type: 'runtime',
          severity: 'error',
        },
      ]);
    }
  }

  protected override async initialize(
    { options }: InitializeInput<ReplicadOptions>,
    { logger }: KernelRuntime,
  ): Promise<void> {
    const { withExceptions } = options;
    const startTime = performance.now();
    const oc = await this.initializeOpenCascadeInstance(withExceptions, logger);
    const ocEndTime = performance.now();
    logger.debug(`OpenCascade initialization took ${ocEndTime - startTime}ms`);

    if (!this.replicadHasOc) {
      logger.debug('Setting OC in replicad');
      replicad.setOC(oc);
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

  protected override async getDependencies({ filePath }: GetDependenciesInput): Promise<string[]> {
    // Replicad currently only supports single-file operations
    // Return absolute path
    return [filePath];
  }

  protected override getAssetUrls(): string[] {
    return [geistRegularUrl, opencascadeWasmUrl, opencascadeWithExceptionsWasmUrl];
  }

  protected override async getParameters(
    { filePath, basePath }: GetParametersInput,
    { filesystem, logger }: KernelRuntime,
  ): Promise<GetParametersResult> {
    const relativeFilePath = KernelWorker.resolveToRelative(filePath, basePath);
    try {
      const code = await filesystem.readFile(filePath, 'utf8');
      let defaultParameters: Record<string, unknown> = {};

      if (/^\s*export\s+/m.test(code)) {
        const module = await buildEsModule(code);
        defaultParameters = module.defaultParams ?? {};
      } else {
        const editedText = `
${code}
try {
  return defaultParams;
} catch (e) {
  return undefined;
}
      `;

        try {
          const result = await runInCjsContext(editedText, {});
          defaultParameters = (result ?? {}) as Record<string, unknown>;
        } catch {
          defaultParameters = {};
        }
      }

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
    { filesystem, logger }: KernelRuntime,
  ): Promise<CreateGeometryResult> {
    const relativeFilePath = KernelWorker.resolveToRelative(filePath, basePath);
    const startTime = performance.now();
    logger.log('Computing geometry from code');

    try {
      // Read code from file
      const code = await filesystem.readFile(filePath, 'utf8');

      let shapes: MainResultShapes;
      let defaultName: string | undefined;

      try {
        const runCodeStartTime = performance.now();
        shapes = ((await this.runCode(code, parameters, logger)) ?? []) as MainResultShapes;
        const runCodeEndTime = performance.now();
        logger.log(`Kernel computation took ${runCodeEndTime - runCodeStartTime}ms`);

        const defaultNameResult = await this.extractDefaultNameFromCode(code);
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

  private runInContextAsOc(code: string, context: Record<string, unknown> = {}): unknown {
    const editedText = `
${code}
let dp = {}
try {
  dp = defaultParams;
} catch (e) {}
return main(replicad, __inputParams || dp)
  `;

    return runInCjsContext(editedText, context);
  }

  private async runAsFunction(code: string, parameters: Record<string, unknown>): Promise<unknown> {
    const contextCode = `
    ${code}
    return main(replicad, __inputParams || {});
  `;

    return this.runInContextAsOc(contextCode, { __inputParams: parameters });
  }

  private async runAsModule(code: string, parameters: Record<string, unknown>, logger: KernelLogger): Promise<unknown> {
    const startTime = performance.now();
    const module = await buildEsModule(code);
    const buildTime = performance.now();
    logger.log(`Module building took ${buildTime - startTime}ms`);

    const execStartTime = performance.now();
    const result = module.default ? module.default(parameters) : module.main?.(replicad, parameters);
    const execEndTime = performance.now();
    logger.log(`Module execution took ${execEndTime - execStartTime}ms`);

    return result;
  }

  private async runCode(code: string, parameters: Record<string, unknown>, logger: KernelLogger): Promise<unknown> {
    logger.log('Starting runCode evaluation');
    const startTime = performance.now();

    let result;
    if (/^\s*export\s+/m.test(code)) {
      logger.log('Starting runAsModule');
      result = await this.runAsModule(code, parameters, logger);
    } else {
      logger.log('Starting runAsFunction');
      result = await this.runAsFunction(code, parameters);
    }

    const endTime = performance.now();
    logger.log(`Total runCode execution took ${endTime - startTime}ms`);
    return result;
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

  private formatException(
    oc: OpenCascadeInstanceWithExceptions,
    error: unknown,
    logger: KernelLogger,
  ): { error: boolean; message: string; stack?: string } {
    let message = 'error';

    if (typeof error === 'number') {
      const errorData = oc.OCJS.getStandard_FailureData(error);
      // eslint-disable-next-line new-cap -- this is a C++ method
      message = errorData.GetMessageString();
    } else {
      message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error in formatException', { data: error });
    }

    return {
      error: true,
      message,
      stack: error instanceof Error ? error.stack : undefined,
    };
  }

  private async formatKernelIssue(error: unknown, logger: KernelLogger, fileName?: string): Promise<KernelIssue> {
    logger.debug('Formatting kernel error', { data: error });
    let message = 'Unknown error occurred';
    let stack: string | undefined;
    let kernelStackFrames: KernelStackFrame[] = [];
    let startLineNumber = 0;
    let startColumn = 0;
    let type: 'compilation' | 'runtime' | 'kernel' | 'unknown' = 'unknown';

    if (typeof error === 'number') {
      try {
        const ocInstance = await this.oc;
        if (ocInstance) {
          const exceptionResult = this.formatException(ocInstance as OpenCascadeInstanceWithExceptions, error, logger);
          message = exceptionResult.message;
          type = 'kernel';
        } else {
          message = `Kernel error ${error}`;
          type = 'kernel';
        }
      } catch (ocError) {
        logger.warn('Failed to format OpenCascade exception', { data: ocError });
        message = `Kernel error ${error}`;
        type = 'kernel';
      }
    } else if (error instanceof Error) {
      message = error.message;
      stack = error.stack;
      type = 'runtime';

      try {
        const stackFrames = ErrorStackParser.parse(error);

        kernelStackFrames = stackFrames.map((frame) => ({
          fileName: frame.fileName,
          functionName: frame.functionName,
          lineNumber: frame.lineNumber,
          columnNumber: frame.columnNumber,
          source: frame.source,
        }));

        const userFrame = stackFrames.find((frame) => frame.functionName === 'Module.main') ?? stackFrames[0];

        startLineNumber = userFrame?.lineNumber ?? 0;
        startColumn = userFrame?.columnNumber ?? 0;
      } catch (parseError) {
        logger.warn('Failed to parse error stack', { data: parseError });
      }
    } else if (typeof error === 'string') {
      message = error;
      type = 'runtime';
    }

    // Only include location if we have a fileName and meaningful position data
    const hasLocation = fileName && (startLineNumber > 0 || startColumn > 0);

    return {
      message,
      location: hasLocation ? { fileName, startLineNumber, startColumn } : undefined,
      stack,
      stackFrames: kernelStackFrames.length > 0 ? kernelStackFrames : undefined,
      type,
      severity: 'error' as const,
    };
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
