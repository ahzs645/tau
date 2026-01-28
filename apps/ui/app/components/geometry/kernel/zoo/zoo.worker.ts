import type {
  CreateGeometryResult,
  ExportFormat,
  ExportGeometryResult,
  GetParametersResult,
  GeometryGltf,
  KernelIssue,
  KernelErrorResult,
  KernelRuntime,
  KernelFilesystem,
  KernelLogger,
  InitializeInput,
  CanHandleInput,
  GetDependenciesInput,
  GetParametersInput,
  CreateGeometryInput,
  ExportGeometryInput,
} from '@taucad/types';
import type { CompilationError } from '@taucad/kcl-wasm-lib/bindings/CompilationError';
import { exposeWorker } from '#components/geometry/kernel/utils/comlink-worker.utils.js';
import { createKernelError, createKernelSuccess } from '#components/geometry/kernel/utils/kernel-helpers.js';
import { KclUtils, kclWasmUrl } from '#components/geometry/kernel/zoo/kcl-utils.js';
import { isKclError } from '#components/geometry/kernel/zoo/kcl-errors.js';
import { convertKclErrorToKernelIssue, mapErrorToKclError } from '#components/geometry/kernel/zoo/error-mappers.js';
import { getErrorPosition } from '#components/geometry/kernel/zoo/source-range-utils.js';
import { asBuffer } from '#utils/file.utils.js';
import { KernelWorker } from '#components/geometry/kernel/utils/kernel-worker.js';
import { FileSystemManager } from '#components/geometry/kernel/zoo/filesystem-manager.js';
import { discoverKclDependencies } from '#components/geometry/kernel/zoo/kcl-import-resolver.js';
import { wrapForComlink } from '#components/geometry/kernel/utils/kernel-comlink-adapter.js';

type ZooOptions = {
  /** Base URL for the Zoo API proxy (e.g., wss://api.tau.new/v1/kernels/zoo) */
  baseUrl: string;
};

export class ZooWorker extends KernelWorker<ZooOptions> {
  protected static override readonly supportedExportFormats: ExportFormat[] = [
    'stl',
    'stl-binary',
    'step',
    'gltf',
    'glb',
  ];

  protected override readonly name: string = 'ZooWorker';
  private gltfDataMemory: Record<string, Uint8Array<ArrayBuffer>> = {};
  private kclUtils: KclUtils | undefined;
  private fileSystemManager!: FileSystemManager;
  private baseUrl = '';

  protected override async cleanup(): Promise<void> {
    await this.kclUtils?.cleanup();
    this.kclUtils = undefined;
    this.gltfDataMemory = {};
  }

  protected override async initialize(
    { options }: InitializeInput<ZooOptions>,
    _runtime: KernelRuntime,
  ): Promise<void> {
    this.baseUrl = options.baseUrl;
  }

  protected override async canHandle({ extension }: CanHandleInput, _runtime: KernelRuntime): Promise<boolean> {
    return extension === 'kcl';
  }

  protected override async getDependencies(
    { filePath, basePath }: GetDependenciesInput,
    { filesystem }: KernelRuntime,
  ): Promise<string[]> {
    this.initializeFileSystemManager(basePath, filesystem);
    const utils = await this.getKclUtils();
    // Get relative path for dependency resolution
    const relativeFilePath = KernelWorker.resolveToRelative(filePath, basePath);
    const relativePaths = await discoverKclDependencies(
      relativeFilePath,
      async (path) => filesystem.readFile(KernelWorker.resolveFromRoot(path, basePath), 'utf8'),
      async (code) => utils.parseKcl(code),
    );
    // Convert relative paths to absolute paths
    return relativePaths.map((relativePath) => KernelWorker.resolveFromRoot(relativePath, basePath));
  }

  protected override getAssetUrls(): string[] {
    return [kclWasmUrl];
  }

  protected override async getParameters(
    { filePath, basePath }: GetParametersInput,
    { filesystem, logger }: KernelRuntime,
  ): Promise<GetParametersResult> {
    this.initializeFileSystemManager(basePath, filesystem);
    const relativeFilePath = KernelWorker.resolveToRelative(filePath, basePath);
    const code = await filesystem.readFile(filePath, 'utf8');
    try {
      const utils = await this.getKclUtils();
      const parseResult = await utils.parseKcl(code);
      const criticalErrors = this.filterNonWarningErrors(parseResult.errors);
      if (criticalErrors.length > 0) {
        logger.warn('KCL parsing errors during parameter extraction', { data: criticalErrors });
        // Return ALL errors, not just the first one
        const errors = this.mapCompilationErrorsToKernelIssues(criticalErrors, code, relativeFilePath);
        return createKernelError(errors);
      }

      // Log warnings separately for diagnostics
      const warnings = parseResult.errors.filter((error) => error.severity === 'Warning');
      if (warnings.length > 0) {
        logger.warn('KCL parsing warnings during parameter extraction', { data: warnings });
      }

      const executionResult = await utils.executeMockKcl(parseResult.program, 'main.kcl');
      const criticalExecutionErrors = this.filterNonWarningErrors(executionResult.errors);
      if (criticalExecutionErrors.length > 0) {
        logger.warn('KCL execution errors during parameter extraction', { data: criticalExecutionErrors });
        // Return ALL execution errors
        const errors = this.mapCompilationErrorsToKernelIssues(criticalExecutionErrors, code, relativeFilePath);
        return createKernelError(errors);
      }

      // Log warnings separately for diagnostics
      const executionWarnings = executionResult.errors.filter((error) => error.severity === 'Warning');
      if (executionWarnings.length > 0) {
        logger.warn('KCL execution warnings during parameter extraction', { data: executionWarnings });
      }

      const { defaultParameters, jsonSchema } = KclUtils.convertKclVariablesToJsonSchema(executionResult.variables);
      return createKernelSuccess({
        defaultParameters,
        jsonSchema,
      });
    } catch (error) {
      const kclErrorResult = this.handleError(error, code, relativeFilePath);
      this.logKernelIssues(kclErrorResult.issues, logger);
      return kclErrorResult;
    }
  }

  protected override async createGeometry(
    { filePath, basePath, parameters }: CreateGeometryInput,
    { filesystem, logger }: KernelRuntime,
  ): Promise<CreateGeometryResult> {
    const geometryId = 'default';
    this.initializeFileSystemManager(basePath, filesystem);
    const relativeFilePath = KernelWorker.resolveToRelative(filePath, basePath);
    const code = await filesystem.readFile(filePath, 'utf8');
    try {
      const trimmedCode = code.trim();
      if (trimmedCode === '') {
        return createKernelSuccess([]);
      }

      try {
        const utils = await this.getKclUtilsWithEngine();
        await utils.clearProgram();
        const parseResult = await utils.parseKcl(trimmedCode);
        const criticalParseErrors = this.filterNonWarningErrors(parseResult.errors);
        if (criticalParseErrors.length > 0) {
          logger.warn('KCL parsing errors', { data: criticalParseErrors });
          // Return ALL parse errors
          const errors = this.mapCompilationErrorsToKernelIssues(criticalParseErrors, trimmedCode, relativeFilePath);
          return createKernelError(errors);
        }

        // Log warnings separately for diagnostics
        const parseWarnings = parseResult.errors.filter((error) => error.severity === 'Warning');
        if (parseWarnings.length > 0) {
          logger.warn('KCL parsing warnings', { data: parseWarnings });
        }

        const modifiedProgram = KclUtils.injectParametersIntoProgram(parseResult.program, parameters);
        const executionResult = await utils.executeProgram(modifiedProgram, 'main.kcl');
        const criticalExecutionErrors = this.filterNonWarningErrors(executionResult.errors);
        if (criticalExecutionErrors.length > 0) {
          logger.warn('KCL execution errors', { data: criticalExecutionErrors });
          // Return ALL execution errors
          const errors = this.mapCompilationErrorsToKernelIssues(
            criticalExecutionErrors,
            trimmedCode,
            relativeFilePath,
          );
          return createKernelError(errors);
        }

        // Log warnings separately for diagnostics
        const executionWarnings = executionResult.errors.filter((error) => error.severity === 'Warning');
        if (executionWarnings.length > 0) {
          logger.warn('KCL execution warnings', { data: executionWarnings });
        }

        const exportResult = await utils.exportFromMemory({
          type: 'gltf',
          storage: 'binary',
        });
        if (exportResult.length === 0) {
          return createKernelSuccess([]);
        }

        const gltf = exportResult[0];
        if (!gltf) {
          // System error - no location
          return createKernelError([
            {
              message: 'No GLTF file in export result',
              severity: 'error',
            },
          ]);
        }

        this.gltfDataMemory[geometryId] = gltf.contents;
        const geometry: GeometryGltf = {
          format: 'gltf',
          content: gltf.contents,
        };
        return createKernelSuccess([geometry]);
      } catch (error) {
        const kclErrorResult = this.handleError(error, code, relativeFilePath);
        this.logKernelIssues(kclErrorResult.issues, logger);
        return kclErrorResult;
      }
    } catch (error) {
      const kclErrorResult = this.handleError(error, code, relativeFilePath);
      this.logKernelIssues(kclErrorResult.issues, logger);
      return kclErrorResult;
    }
  }

  // eslint-disable-next-line complexity -- refactor to remove common boilerplate.
  protected override async exportGeometry(
    { fileType }: ExportGeometryInput,
    { logger }: KernelRuntime,
  ): Promise<ExportGeometryResult> {
    const geometryId = 'default';
    try {
      const gltfData = this.gltfDataMemory[geometryId];
      if (!gltfData) {
        // System error - no location needed
        return createKernelError([
          {
            message: `Geometry ${geometryId} not computed yet. Please build geometries before exporting.`,
            severity: 'error',
          },
        ]);
      }

      switch (fileType) {
        case 'stl':
        case 'stl-binary': {
          try {
            const utils = await this.getKclUtilsWithEngine();
            const stlResult = await utils.exportFromMemory({
              type: 'stl',
              storage: fileType === 'stl-binary' ? 'binary' : 'ascii',
              units: 'mm',
            });
            if (stlResult.length === 0) {
              return createKernelError([{ message: 'No STL data received from KCL export', severity: 'error' }]);
            }

            const stlFile = stlResult[0];
            if (!stlFile) {
              return createKernelError([{ message: 'No STL file in export result', severity: 'error' }]);
            }

            const blob = new Blob([asBuffer(stlFile.contents.buffer)], {
              type: fileType === 'stl-binary' ? 'application/octet-stream' : 'text/plain',
            });
            return createKernelSuccess([
              {
                blob,
                name: 'model.stl',
              },
            ]);
          } catch (error) {
            const kclErrorResult = this.handleError(error);
            this.logKernelIssues(kclErrorResult.issues, logger);
            return kclErrorResult;
          }
        }

        case 'step': {
          try {
            const utils = await this.getKclUtilsWithEngine();
            const stepResult = await utils.exportFromMemory({
              type: 'step',
            });
            if (stepResult.length === 0) {
              return createKernelError([{ message: 'No STEP data received from KCL export', severity: 'error' }]);
            }

            const stepFile = stepResult[0];
            if (!stepFile) {
              return createKernelError([{ message: 'No STEP file in export result', severity: 'error' }]);
            }

            const blob = new Blob([asBuffer(stepFile.contents.buffer)], {
              type: 'application/step',
            });
            return createKernelSuccess([
              {
                blob,
                name: 'model.step',
              },
            ]);
          } catch (error) {
            const kclErrorResult = this.handleError(error);
            this.logKernelIssues(kclErrorResult.issues, logger);
            return kclErrorResult;
          }
        }

        case 'glb': {
          try {
            const utils = await this.getKclUtilsWithEngine();
            const glbResult = await utils.exportFromMemory({
              type: 'gltf',
              storage: 'binary',
            });
            if (glbResult.length === 0) {
              return createKernelError([{ message: 'No GLB data received from KCL export', severity: 'error' }]);
            }

            const glbFile = glbResult[0];
            if (!glbFile) {
              return createKernelError([{ message: 'No GLB file in export result', severity: 'error' }]);
            }

            const blob = new Blob([asBuffer(glbFile.contents.buffer)], {
              type: 'model/gltf-binary',
            });
            return createKernelSuccess([
              {
                blob,
                name: 'model.glb',
              },
            ]);
          } catch (error) {
            const kclErrorResult = this.handleError(error);
            this.logKernelIssues(kclErrorResult.issues, logger);
            return kclErrorResult;
          }
        }

        case 'gltf': {
          try {
            const utils = await this.getKclUtilsWithEngine();
            const gltfResult = await utils.exportFromMemory({
              type: 'gltf',
              storage: 'embedded',
              presentation: 'pretty',
            });
            if (gltfResult.length === 0) {
              return createKernelError([{ message: 'No GLTF data received from KCL export', severity: 'error' }]);
            }

            const gltfFile = gltfResult[0];
            if (!gltfFile) {
              return createKernelError([{ message: 'No GLTF file in export result', severity: 'error' }]);
            }

            const blob = new Blob([asBuffer(gltfFile.contents.buffer)], {
              type: 'model/gltf-json',
            });
            return createKernelSuccess([
              {
                blob,
                name: 'model.gltf',
              },
            ]);
          } catch (error) {
            const kclErrorResult = this.handleError(error);
            this.logKernelIssues(kclErrorResult.issues, logger);
            return kclErrorResult;
          }
        }

        default: {
          return createKernelError([{ message: `Unsupported export format: ${fileType}`, severity: 'error' }]);
        }
      }
    } catch (error) {
      const kclErrorResult = this.handleError(error);
      this.logKernelIssues(kclErrorResult.issues, logger);
      return kclErrorResult;
    }
  }

  /**
   * Logs all kernel issues for debugging
   */
  private logKernelIssues(errors: KernelIssue[], logger: KernelLogger): void {
    for (const kernelIssue of errors) {
      logger.error(kernelIssue.message);
    }
  }

  /**
   * Filters errors to only include Error and Fatal severities, excluding Warnings
   */
  private filterNonWarningErrors(errors: CompilationError[]): CompilationError[] {
    return errors.filter((error) => error.severity === 'Error' || error.severity === 'Fatal');
  }

  /**
   * Maps an array of CompilationError to KernelIssue with location info
   */
  private mapCompilationErrorsToKernelIssues(
    errors: CompilationError[],
    code: string,
    fileName: string,
  ): KernelIssue[] {
    return errors.map((error) => {
      const errorPosition = getErrorPosition(error, code);
      return {
        message: error.message,
        location: {
          fileName,
          startLineNumber: errorPosition.line,
          startColumn: errorPosition.column,
        },
        type: 'compilation' as const,
        severity: error.severity === 'Warning' ? ('warning' as const) : ('error' as const),
      };
    });
  }

  private handleError(error: unknown, code?: string, fileName?: string): KernelErrorResult {
    if (isKclError(error)) {
      return convertKclErrorToKernelIssue(error, code, fileName);
    }

    const mappedError = mapErrorToKclError(error);
    return convertKclErrorToKernelIssue(mappedError, code, fileName);
  }

  /**
   * Initialize the FileSystemManager with the given project root.
   * Called before operations that need filesystem access.
   *
   * @param basePath - The project root path.
   * @param filesystem - Filesystem interface for reading files.
   */
  private initializeFileSystemManager(basePath: string, filesystem: KernelFilesystem): void {
    this.fileSystemManager = new FileSystemManager(filesystem, basePath);
  }

  private async getKclUtilsInstance(): Promise<KclUtils> {
    this.kclUtils ??= new KclUtils({
      apiKey: '', // API key is injected by the server-side proxy
      baseUrl: this.baseUrl,
      fileSystemManager: this.fileSystemManager,
    });
    return this.kclUtils;
  }

  private async getKclUtils(): Promise<KclUtils> {
    const utils = await this.getKclUtilsInstance();
    await utils.initializeWasm();
    return utils;
  }

  private async getKclUtilsWithEngine(): Promise<KclUtils> {
    const utils = await this.getKclUtilsInstance();
    await utils.initializeEngine();
    return utils;
  }
}

const worker = new ZooWorker();
const service = wrapForComlink(worker);
exposeWorker(service);

export type ZooBuilderInterface = typeof service;
