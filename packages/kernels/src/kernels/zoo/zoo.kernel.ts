/**
 * Zoo (KCL) Kernel Module
 *
 * Full defineKernel implementation for the Zoo/KCL kernel.
 * Handles KCL WASM initialisation, AST parsing, parameter extraction,
 * geometry execution via the Zoo engine, and export in multiple formats.
 *
 * The kernel uses two initialisation phases:
 * - WASM-only (for parsing and mock execution, no WebSocket)
 * - Full engine (for geometry computation and export, requires WebSocket)
 */

import type {
  CreateGeometryInput,
  ExportGeometryInput,
  ExportGeometryResult,
  GetDependenciesInput,
  GetParametersInput,
  GetParametersResult,
  GeometryGltf,
  KernelErrorResult,
  KernelFilesystem,
  KernelIssue,
  KernelLogger,
  KernelRuntime,
  KernelSpanTracer,
} from '@taucad/types';
import { defineKernel } from '@taucad/types';
import type { CompilationError } from '@taucad/kcl-wasm-lib/bindings/CompilationError';
import { asBuffer } from '@taucad/utils/file';
import { joinPath } from '@taucad/utils/path';
import { createKernelError, createKernelSuccess } from '#framework/kernel-helpers.js';
import { KclUtils } from '#kernels/zoo/kcl-utils.js';
import { isKclError } from '#kernels/zoo/kcl-errors.js';
import { convertKclErrorToKernelIssue, mapErrorToKclError } from '#kernels/zoo/error-mappers.js';
import { getErrorPosition } from '#kernels/zoo/source-range-utils.js';
import { FileSystemManager } from '#kernels/zoo/filesystem-manager.js';
import { discoverKclDependencies } from '#kernels/zoo/kcl-import-resolver.js';

// =============================================================================
// Types
// =============================================================================

type ZooContext = {
  baseUrl: string;
  kclUtils: KclUtils | undefined;
  fileSystemManager: FileSystemManager | undefined;
};

// =============================================================================
// Path helpers
// =============================================================================

function resolveToRelative(absolutePath: string, basePath: string): string {
  const normalizedBase = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  if (absolutePath.startsWith(`${normalizedBase}/`)) {
    return absolutePath.slice(normalizedBase.length + 1);
  }

  return absolutePath;
}

function resolveFromRoot(relativePath: string, basePath: string): string {
  return joinPath(basePath, relativePath);
}

// =============================================================================
// Error helpers
// =============================================================================

function filterNonWarningErrors(errors: CompilationError[]): CompilationError[] {
  return errors.filter((error) => error.severity === 'Error' || error.severity === 'Fatal');
}

function mapCompilationErrorsToKernelIssues(errors: CompilationError[], code: string, fileName: string): KernelIssue[] {
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

function handleError(error: unknown, code?: string, fileName?: string): KernelErrorResult {
  if (isKclError(error)) {
    return convertKclErrorToKernelIssue(error, code, fileName);
  }

  const mappedError = mapErrorToKclError(error);
  return convertKclErrorToKernelIssue(mappedError, code, fileName);
}

function logKernelIssues(errors: KernelIssue[], logger: KernelLogger): void {
  for (const kernelIssue of errors) {
    logger.error(kernelIssue.message);
  }
}

// =============================================================================
// KCL Utils management
// =============================================================================

function ensureFileSystemManager(ctx: ZooContext, basePath: string, filesystem: KernelFilesystem): FileSystemManager {
  ctx.fileSystemManager = new FileSystemManager(filesystem, basePath);
  return ctx.fileSystemManager;
}

function getKclUtilsInstance(ctx: ZooContext): KclUtils {
  if (!ctx.kclUtils) {
    if (!ctx.fileSystemManager) {
      throw new Error('FileSystemManager not initialised');
    }

    ctx.kclUtils = new KclUtils({
      apiKey: '',
      baseUrl: ctx.baseUrl,
      fileSystemManager: ctx.fileSystemManager,
    });
  }

  return ctx.kclUtils;
}

async function getKclUtils(ctx: ZooContext, tracer?: KernelSpanTracer): Promise<KclUtils> {
  const utils = getKclUtilsInstance(ctx);
  await utils.initializeWasm(tracer);
  return utils;
}

async function getKclUtilsWithEngine(ctx: ZooContext): Promise<KclUtils> {
  const utils = getKclUtilsInstance(ctx);
  await utils.initializeEngine();
  return utils;
}

// =============================================================================
// Kernel module definition
// =============================================================================

export default defineKernel<ZooContext, Uint8Array<ArrayBuffer>>({
  name: 'ZooKernel',
  version: '1.0.0',

  async initialize(options) {
    return {
      baseUrl: (options['baseUrl'] as string | undefined) ?? '',
      kclUtils: undefined,
      fileSystemManager: undefined,
    };
  },

  async canHandle({ extension }) {
    return extension === 'kcl';
  },

  async getDependencies(
    { filePath, basePath }: GetDependenciesInput,
    { filesystem }: KernelRuntime,
    ctx: ZooContext,
  ): Promise<string[]> {
    ensureFileSystemManager(ctx, basePath, filesystem);
    const utils = await getKclUtils(ctx);
    const relativeFilePath = resolveToRelative(filePath, basePath);
    const relativePaths = await discoverKclDependencies(
      relativeFilePath,
      async (path) => filesystem.readFile(resolveFromRoot(path, basePath), 'utf8'),
      async (code) => utils.parseKcl(code),
    );
    return relativePaths.map((relativePath) => resolveFromRoot(relativePath, basePath));
  },

  async getParameters(
    { filePath, basePath }: GetParametersInput,
    { filesystem, logger }: KernelRuntime,
    ctx: ZooContext,
  ): Promise<GetParametersResult> {
    ensureFileSystemManager(ctx, basePath, filesystem);
    const relativeFilePath = resolveToRelative(filePath, basePath);
    const code = await filesystem.readFile(filePath, 'utf8');
    try {
      const utils = await getKclUtils(ctx);
      const parseResult = await utils.parseKcl(code);
      const criticalErrors = filterNonWarningErrors(parseResult.errors);
      if (criticalErrors.length > 0) {
        logger.warn('KCL parsing errors during parameter extraction', { data: criticalErrors });
        return createKernelError(mapCompilationErrorsToKernelIssues(criticalErrors, code, relativeFilePath));
      }

      const executionResult = await utils.executeMockKcl(parseResult.program, 'main.kcl');
      const criticalExecutionErrors = filterNonWarningErrors(executionResult.errors);
      if (criticalExecutionErrors.length > 0) {
        logger.warn('KCL execution errors during parameter extraction', { data: criticalExecutionErrors });
        return createKernelError(mapCompilationErrorsToKernelIssues(criticalExecutionErrors, code, relativeFilePath));
      }

      const { defaultParameters, jsonSchema } = KclUtils.convertKclVariablesToJsonSchema(executionResult.variables);
      return createKernelSuccess({ defaultParameters, jsonSchema });
    } catch (error) {
      const kclErrorResult = handleError(error, code, relativeFilePath);
      logKernelIssues(kclErrorResult.issues, logger);
      return kclErrorResult;
    }
  },

  async createGeometry(
    { filePath, basePath, parameters }: CreateGeometryInput,
    { filesystem, logger }: KernelRuntime,
    ctx: ZooContext,
  ) {
    ensureFileSystemManager(ctx, basePath, filesystem);
    const relativeFilePath = resolveToRelative(filePath, basePath);
    const code = await filesystem.readFile(filePath, 'utf8');
    try {
      const trimmedCode = code.trim();
      if (trimmedCode === '') {
        return { geometry: [], nativeHandle: new Uint8Array(0) };
      }

      const utils = await getKclUtilsWithEngine(ctx);
      await utils.clearProgram();
      const parseResult = await utils.parseKcl(trimmedCode);
      const criticalParseErrors = filterNonWarningErrors(parseResult.errors);
      if (criticalParseErrors.length > 0) {
        logger.warn('KCL parsing errors', { data: criticalParseErrors });
        throw new KclBuildError(mapCompilationErrorsToKernelIssues(criticalParseErrors, trimmedCode, relativeFilePath));
      }

      const modifiedProgram = KclUtils.injectParametersIntoProgram(parseResult.program, parameters);
      const executionResult = await utils.executeProgram(modifiedProgram, 'main.kcl');
      const criticalExecutionErrors = filterNonWarningErrors(executionResult.errors);
      if (criticalExecutionErrors.length > 0) {
        logger.warn('KCL execution errors', { data: criticalExecutionErrors });
        throw new KclBuildError(
          mapCompilationErrorsToKernelIssues(criticalExecutionErrors, trimmedCode, relativeFilePath),
        );
      }

      const exportResult = await utils.exportFromMemory({ type: 'gltf', storage: 'binary' });
      if (exportResult.length === 0) {
        return { geometry: [], nativeHandle: new Uint8Array(0) };
      }

      const gltf = exportResult[0];
      if (!gltf) {
        throw new KclBuildError([{ message: 'No GLTF file in export result', severity: 'error' }]);
      }

      const geometry: GeometryGltf = { format: 'gltf', content: gltf.contents };
      return { geometry: [geometry], nativeHandle: gltf.contents };
    } catch (error) {
      if (error instanceof KclBuildError) {
        throw error;
      }

      const kclErrorResult = handleError(error, code, relativeFilePath);
      logKernelIssues(kclErrorResult.issues, logger);
      throw new KclBuildError(kclErrorResult.issues);
    }
  },

  async exportGeometry(
    { fileType }: ExportGeometryInput,
    { logger }: KernelRuntime,
    ctx: ZooContext,
    nativeHandle: Uint8Array<ArrayBuffer>,
  ): Promise<ExportGeometryResult> {
    if (nativeHandle.length === 0) {
      return createKernelError([
        { message: 'No geometry available for export. Please build geometries before exporting.', severity: 'error' },
      ]);
    }

    try {
      const utils = await getKclUtilsWithEngine(ctx);

      switch (fileType) {
        case 'stl':
        case 'stl-binary': {
          const stlResult = await utils.exportFromMemory({
            type: 'stl',
            storage: fileType === 'stl-binary' ? 'binary' : 'ascii',
            units: 'mm',
          });
          if (stlResult.length === 0 || !stlResult[0]) {
            return createKernelError([{ message: 'No STL data received from KCL export', severity: 'error' }]);
          }

          const blob = new Blob([asBuffer(stlResult[0].contents.buffer)], {
            type: fileType === 'stl-binary' ? 'application/octet-stream' : 'text/plain',
          });
          return createKernelSuccess([{ blob, name: 'model.stl' }]);
        }

        case 'step': {
          const stepResult = await utils.exportFromMemory({ type: 'step' });
          if (stepResult.length === 0 || !stepResult[0]) {
            return createKernelError([{ message: 'No STEP data received from KCL export', severity: 'error' }]);
          }

          const blob = new Blob([asBuffer(stepResult[0].contents.buffer)], { type: 'application/step' });
          return createKernelSuccess([{ blob, name: 'model.step' }]);
        }

        case 'glb': {
          const glbResult = await utils.exportFromMemory({ type: 'gltf', storage: 'binary' });
          if (glbResult.length === 0 || !glbResult[0]) {
            return createKernelError([{ message: 'No GLB data received from KCL export', severity: 'error' }]);
          }

          const blob = new Blob([asBuffer(glbResult[0].contents.buffer)], { type: 'model/gltf-binary' });
          return createKernelSuccess([{ blob, name: 'model.glb' }]);
        }

        case 'gltf': {
          const gltfResult = await utils.exportFromMemory({
            type: 'gltf',
            storage: 'embedded',
            presentation: 'pretty',
          });
          if (gltfResult.length === 0 || !gltfResult[0]) {
            return createKernelError([{ message: 'No GLTF data received from KCL export', severity: 'error' }]);
          }

          const blob = new Blob([asBuffer(gltfResult[0].contents.buffer)], { type: 'model/gltf-json' });
          return createKernelSuccess([{ blob, name: 'model.gltf' }]);
        }

        default: {
          return createKernelError([{ message: `Unsupported export format: ${fileType}`, severity: 'error' }]);
        }
      }
    } catch (error) {
      const kclErrorResult = handleError(error);
      logKernelIssues(kclErrorResult.issues, logger);
      return kclErrorResult;
    }
  },

  async cleanup(ctx: ZooContext) {
    await ctx.kclUtils?.cleanup();
    ctx.kclUtils = undefined;
  },
});

class KclBuildError extends Error {
  public readonly issues: KernelIssue[];
  public constructor(issues: KernelIssue[]) {
    super(issues.map((i) => i.message).join('; '));
    this.issues = issues;
  }
}
