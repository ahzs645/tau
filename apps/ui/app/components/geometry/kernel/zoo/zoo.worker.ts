import { expose } from 'comlink';
import type {
  ComputeGeometryResult,
  ExportFormat,
  ExportGeometryResult,
  ExtractParametersResult,
  GeometryGltf,
  KernelError,
  KernelErrorResult,
} from '@taucad/types';
import type { CompilationError } from '@taucad/kcl-wasm-lib/bindings/CompilationError';
import {
  createKernelError,
  createKernelErrors,
  createKernelSuccess,
} from '#components/geometry/kernel/utils/kernel-helpers.js';
import { KclUtils } from '#components/geometry/kernel/zoo/kcl-utils.js';
import { isKclError } from '#components/geometry/kernel/zoo/kcl-errors.js';
import { convertKclErrorToKernelError, mapErrorToKclError } from '#components/geometry/kernel/zoo/error-mappers.js';
import { getErrorPosition } from '#components/geometry/kernel/zoo/source-range-utils.js';
import { KernelWorker } from '#components/geometry/kernel/utils/kernel-worker.js';
import { FileSystemManager } from '#components/geometry/kernel/zoo/filesystem-manager.js';

type ZooOptions = {
  /** Base URL for the Zoo API proxy (e.g., wss://api.tau.new/v1/kernels/zoo) */
  baseUrl: string;
};

class ZooWorker extends KernelWorker<ZooOptions> {
  protected static override readonly supportedExportFormats: ExportFormat[] = [
    'stl',
    'stl-binary',
    'step',
    'gltf',
    'glb',
  ];

  protected override readonly name: string = 'ZooWorker';
  private gltfDataMemory: Record<string, Uint8Array> = {};
  private kclUtils: KclUtils | undefined;
  private fileSystemManager!: FileSystemManager;

  protected override async initialize(): Promise<void> {
    this.fileSystemManager = new FileSystemManager(this.fileReader);
  }

  protected override async cleanup(): Promise<void> {
    await this.kclUtils?.cleanup();
    this.kclUtils = undefined;
    this.gltfDataMemory = {};
  }

  protected override async canHandle(_filename: string, extension: string): Promise<boolean> {
    return extension === 'kcl';
  }

  protected override async extractParameters(filename: string): Promise<ExtractParametersResult> {
    const code = await this.readFile(filename, 'utf8');
    try {
      const utils = await this.getKclUtils();
      const parseResult = await utils.parseKcl(code);
      const criticalErrors = this.filterNonWarningErrors(parseResult.errors);
      if (criticalErrors.length > 0) {
        this.warn('KCL parsing errors during parameter extraction', { data: criticalErrors });
        // Return ALL errors, not just the first one
        const errors = this.mapCompilationErrorsToKernelErrors(criticalErrors, code, filename);
        return createKernelErrors(errors);
      }

      // Log warnings separately for diagnostics
      const warnings = parseResult.errors.filter((error) => error.severity === 'Warning');
      if (warnings.length > 0) {
        this.warn('KCL parsing warnings during parameter extraction', { data: warnings });
      }

      const executionResult = await utils.executeMockKcl(parseResult.program, 'main.kcl');
      const criticalExecutionErrors = this.filterNonWarningErrors(executionResult.errors);
      if (criticalExecutionErrors.length > 0) {
        this.warn('KCL execution errors during parameter extraction', { data: criticalExecutionErrors });
        // Return ALL execution errors
        const errors = this.mapCompilationErrorsToKernelErrors(criticalExecutionErrors, code, filename);
        return createKernelErrors(errors);
      }

      // Log warnings separately for diagnostics
      const executionWarnings = executionResult.errors.filter((error) => error.severity === 'Warning');
      if (executionWarnings.length > 0) {
        this.warn('KCL execution warnings during parameter extraction', { data: executionWarnings });
      }

      const { defaultParameters, jsonSchema } = KclUtils.convertKclVariablesToJsonSchema(executionResult.variables);
      return createKernelSuccess({
        defaultParameters,
        jsonSchema,
      });
    } catch (error) {
      const kclErrorResult = this.handleError(error, code, filename);
      this.logKernelErrors(kclErrorResult.errors, 'extractParameters');
      return kclErrorResult;
    }
  }

  protected override async computeGeometry(
    filename: string,
    parameters?: Record<string, unknown>,
    geometryId = 'defaultGeometry',
  ): Promise<ComputeGeometryResult> {
    const code = await this.readFile(filename, 'utf8');
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
          this.warn('KCL parsing errors', { data: criticalParseErrors });
          // Return ALL parse errors
          const errors = this.mapCompilationErrorsToKernelErrors(criticalParseErrors, trimmedCode, filename);
          return createKernelErrors(errors);
        }

        // Log warnings separately for diagnostics
        const parseWarnings = parseResult.errors.filter((error) => error.severity === 'Warning');
        if (parseWarnings.length > 0) {
          this.warn('KCL parsing warnings', { data: parseWarnings });
        }

        const modifiedProgram = KclUtils.injectParametersIntoProgram(parseResult.program, parameters ?? {});
        const executionResult = await utils.executeProgram(modifiedProgram, 'main.kcl');
        const criticalExecutionErrors = this.filterNonWarningErrors(executionResult.errors);
        if (criticalExecutionErrors.length > 0) {
          this.warn('KCL execution errors', { data: criticalExecutionErrors });
          // Return ALL execution errors
          const errors = this.mapCompilationErrorsToKernelErrors(criticalExecutionErrors, trimmedCode, filename);
          return createKernelErrors(errors);
        }

        // Log warnings separately for diagnostics
        const executionWarnings = executionResult.errors.filter((error) => error.severity === 'Warning');
        if (executionWarnings.length > 0) {
          this.warn('KCL execution warnings', { data: executionWarnings });
        }

        const exportResult = await utils.exportFromMemory({
          type: 'gltf',
          storage: 'embedded',
          presentation: 'pretty',
        });
        if (exportResult.length === 0) {
          return createKernelSuccess([]);
        }

        const gltf = exportResult[0];
        if (!gltf) {
          // System error - no location
          return createKernelError({
            message: 'No GLTF file in export result',
          });
        }

        this.gltfDataMemory[geometryId] = gltf.contents;
        const geometry: GeometryGltf = {
          format: 'gltf',
          content: gltf.contents,
        };
        return createKernelSuccess([geometry]);
      } catch (error) {
        const kclErrorResult = this.handleError(error, code, filename);
        this.logKernelErrors(kclErrorResult.errors, 'computeGeometry');
        return kclErrorResult;
      }
    } catch (error) {
      const kclErrorResult = this.handleError(error, code, filename);
      this.logKernelErrors(kclErrorResult.errors, 'computeGeometry');
      return kclErrorResult;
    }
  }

  // eslint-disable-next-line complexity -- refactor to remove common boilerplate.
  protected override async exportGeometry(
    fileType: ExportFormat,
    geometryId = 'defaultGeometry',
  ): Promise<ExportGeometryResult> {
    try {
      const gltfData = this.gltfDataMemory[geometryId];
      if (!gltfData) {
        // System error - no location needed
        return createKernelError({
          message: `Geometry ${geometryId} not computed yet. Please build geometries before exporting.`,
        });
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
              return createKernelError({ message: 'No STL data received from KCL export' });
            }

            const stlFile = stlResult[0];
            if (!stlFile) {
              return createKernelError({ message: 'No STL file in export result' });
            }

            const blob = new Blob([stlFile.contents], {
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
            this.logKernelErrors(kclErrorResult.errors, 'exportGeometry');
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
              return createKernelError({ message: 'No STEP data received from KCL export' });
            }

            const stepFile = stepResult[0];
            if (!stepFile) {
              return createKernelError({ message: 'No STEP file in export result' });
            }

            const blob = new Blob([stepFile.contents], {
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
            this.logKernelErrors(kclErrorResult.errors, 'exportGeometry');
            return kclErrorResult;
          }
        }

        case 'glb': {
          try {
            const utils = await this.getKclUtilsWithEngine();
            const glbResult = await utils.exportFromMemory({
              type: 'gltf',
              storage: 'embedded',
              presentation: 'pretty',
            });
            if (glbResult.length === 0) {
              return createKernelError({ message: 'No GLB data received from KCL export' });
            }

            const glbFile = glbResult[0];
            if (!glbFile) {
              return createKernelError({ message: 'No GLB file in export result' });
            }

            const blob = new Blob([glbFile.contents], {
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
            this.logKernelErrors(kclErrorResult.errors, 'exportGeometry');
            return kclErrorResult;
          }
        }

        case 'gltf': {
          try {
            const blob = new Blob([gltfData], {
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
            this.logKernelErrors(kclErrorResult.errors, 'exportGeometry');
            return kclErrorResult;
          }
        }

        default: {
          return createKernelError({ message: `Unsupported export format: ${fileType}` });
        }
      }
    } catch (error) {
      const kclErrorResult = this.handleError(error);
      this.logKernelErrors(kclErrorResult.errors, 'exportGeometry');
      return kclErrorResult;
    }
  }

  /**
   * Logs all kernel errors for debugging
   */
  private logKernelErrors(errors: KernelError[], operation: string): void {
    for (const kernelError of errors) {
      this.error(kernelError.message, { operation });
    }
  }

  /**
   * Filters errors to only include Error and Fatal severities, excluding Warnings
   */
  private filterNonWarningErrors(errors: CompilationError[]): CompilationError[] {
    return errors.filter((error) => error.severity === 'Error' || error.severity === 'Fatal');
  }

  /**
   * Maps an array of CompilationError to KernelError with location info
   */
  private mapCompilationErrorsToKernelErrors(
    errors: CompilationError[],
    code: string,
    fileName: string,
  ): KernelError[] {
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
      };
    });
  }

  private handleError(error: unknown, code?: string, fileName?: string): KernelErrorResult {
    if (isKclError(error)) {
      return convertKclErrorToKernelError(error, code, fileName);
    }

    const mappedError = mapErrorToKclError(error);
    return convertKclErrorToKernelError(mappedError, code, fileName);
  }

  private async getKclUtilsInstance(): Promise<KclUtils> {
    this.kclUtils ??= new KclUtils({
      apiKey: '', // API key is injected by the server-side proxy
      baseUrl: this.options.baseUrl,
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

const service = new ZooWorker();
expose(service);
export type ZooBuilderInterface = typeof service;
