/**
 * Replicad Kernel Module
 *
 * Full defineKernel implementation for the Replicad kernel.
 * Uses runtime.bundler for JS/TS bundling and runtime.execute for evaluation.
 * Registers replicad as a built-in module and loads OpenCASCADE WASM for geometry.
 *
 * Supports withExceptions mode: wraps the OC instance with a deep Proxy
 * that converts numeric C++ exceptions into OcExceptionError with proper
 * JS stack traces, enabling source-map resolution back to user code.
 */

import * as replicad from 'replicad';
import type { OpenCascadeInstance } from 'replicad-opencascadejs';
import type { OpenCascadeInstance as OpenCascadeInstanceWithExceptions } from 'replicad-opencascadejs/src/replicad_with_exceptions.js';
import type {
  CreateGeometryInput,
  ExportGeometryInput,
  ExportGeometryResult,
  GetDependenciesInput,
  GetParametersInput,
  GetParametersResult,
  GeometryGltf,
  GeometrySvg,
  KernelIssue,
  KernelRuntime,
  KernelStackFrame,
  ErrorLocation,
} from '@taucad/types';
import { defineKernel } from '@taucad/types';
import type { SourceMapConsumer } from 'source-map-js';
import { asBuffer } from '@taucad/utils/file';
import { jsonSchemaFromJson } from '@taucad/utils/schema';
import { createKernelError, createKernelSuccess } from '#framework/kernel-helpers.js';
import { initOpenCascade, initOpenCascadeWithExceptions } from '#kernels/replicad/init-open-cascade.js';
import { wrapOcInstance, formatRuntimeErrorWithOc } from '#kernels/replicad/oc-exceptions.js';
import {
  parseStackTrace,
  createFrameClassifier,
  deriveLocationFromFrames,
  applyLibrarySourceMaps,
  resolveSourcePath,
} from '#framework/error-enrichment.js';
import { renderOutput } from '#kernels/replicad/utils/render-output.js';
import { convertReplicadGeometriesToGltf } from '#kernels/replicad/utils/replicad-to-gltf.js';
import type { InputShape, MainResultShapes } from '#kernels/replicad/utils/render-output.js';
import type { GeometryReplicad } from '#kernels/replicad/replicad.types.js';

const geistRegularUrl = new URL('fonts/Geist-Regular.ttf', import.meta.url).href;

// =============================================================================
// Types
// =============================================================================

type ReplicadContext = {
  oc: OpenCascadeInstance;
  ocWithExceptions: OpenCascadeInstanceWithExceptions | undefined;
  withExceptions: boolean;
  replicadInitialised: boolean;
  librarySourceMapCache: Map<string, SourceMapConsumer | undefined>;
};

type RuntimeModuleExports = {
  default?: (...args: unknown[]) => unknown;
  main?: (...args: unknown[]) => unknown;
  defaultParams?: Record<string, unknown>;
  defaultParameters?: Record<string, unknown>;
  defaultName?: string;
};

// eslint-disable-next-line @typescript-eslint/naming-convention -- module-level constant
const KERNEL_MODULES_KEY = '__KERNEL_MODULES__';

// eslint-disable-next-line @typescript-eslint/naming-convention -- module-level constant
const LIBRARY_PATTERNS = [{ pattern: 'node_modules/replicad/', moduleName: 'replicad' }];
const frameClassifier = createFrameClassifier(LIBRARY_PATTERNS);

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

// =============================================================================
// Error enrichment helpers
// =============================================================================

function parseError(error: unknown, sourceMapJson?: string, projectPath?: string): KernelStackFrame[] {
  return parseStackTrace(error, {
    classifyFrame: frameClassifier,
    sourceMap: sourceMapJson,
    resolveSourcePath: (s) => resolveSourcePath(s, projectPath),
  });
}

function resolveLibraryFrames(frames: KernelStackFrame[], ctx: ReplicadContext): KernelStackFrame[] {
  return applyLibrarySourceMaps(frames, LIBRARY_PATTERNS, (moduleName) => {
    if (ctx.librarySourceMapCache.has(moduleName)) {
      return ctx.librarySourceMapCache.get(moduleName);
    }

    // Library source maps are loaded lazily on first error
    // For now, return undefined — the cache is populated synchronously if available
    return undefined;
  });
}

function deriveLocation(
  frames: KernelStackFrame[],
  sourceMapJson?: string,
  projectPath?: string,
): ErrorLocation | undefined {
  return deriveLocationFromFrames(frames, sourceMapJson, (s) => resolveSourcePath(s, projectPath));
}

// =============================================================================
// Module registration helpers
// =============================================================================

function getModuleRegistry(): Map<string, Record<string, unknown>> {
  let registry = (globalThis as Record<string, unknown>)[KERNEL_MODULES_KEY] as
    | Map<string, Record<string, unknown>>
    | undefined;
  if (!registry) {
    registry = new Map();
    (globalThis as Record<string, unknown>)[KERNEL_MODULES_KEY] = registry;
  }

  return registry;
}

function registerReplicadModule(runtime: KernelRuntime): void {
  const exports = replicad as unknown as Record<string, unknown>;
  const registry = getModuleRegistry();
  registry.set('replicad', exports);

  const exportNames = Object.keys(exports).filter((key) => /^[a-z_$][\w$]*$/i.test(key));
  const namedExports = exportNames.map((key) => `export const ${key} = __mod.${key};`).join('\n');
  const code = `const __mod = globalThis.${KERNEL_MODULES_KEY}.get('replicad');\n${namedExports}\nexport default __mod;\n`;

  runtime.bundler.registerModule('replicad', {
    code,
    version: '0.19.1',
    globalName: 'replicad',
  });
}

// =============================================================================
// Module execution helpers
// =============================================================================

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractDefaultParameters(module: unknown): Record<string, unknown> {
  if (!isRecordObject(module)) {
    return {};
  }

  /* eslint-disable @typescript-eslint/no-unnecessary-condition -- runtime guard for untyped module */
  return (
    (module['defaultParams'] as Record<string, unknown>) ??
    (module['defaultParameters'] as Record<string, unknown>) ??
    {}
  );
  /* eslint-enable @typescript-eslint/no-unnecessary-condition -- end of runtime guard */
}

function extractDefaultName(module: unknown): string | undefined {
  if (!isRecordObject(module)) {
    return undefined;
  }

  return typeof module['defaultName'] === 'string' ? module['defaultName'] : undefined;
}

type RunMainResult<T> = { success: true; value: T } | { success: false; issues: KernelIssue[] };

async function runMainRaw(module: RuntimeModuleExports, parameters: Record<string, unknown>): Promise<unknown> {
  const mainFunction = module.default ?? module.main;
  if (!mainFunction || typeof mainFunction !== 'function') {
    return undefined;
  }

  if (mainFunction.length >= 2) {
    const registry = getModuleRegistry();
    const first = registry.values().next();
    return mainFunction(first.done ? undefined : first.value, parameters);
  }

  return mainFunction(parameters);
}

async function runMain<T>(
  module: RuntimeModuleExports,
  parameters: Record<string, unknown>,
  ctx: ReplicadContext,
  sourceMapJson?: string,
  projectPath?: string,
): Promise<RunMainResult<T>> {
  try {
    const value = await runMainRaw(module, parameters);
    return { success: true, value: value as T };
  } catch (error) {
    const issue = formatRuntimeErrorWithOc(
      error,
      ctx.ocWithExceptions,
      (errorToFormat) => parseError(errorToFormat, sourceMapJson, projectPath),
      (frames) => resolveLibraryFrames(frames, ctx),
      (frames) => deriveLocation(frames, sourceMapJson, projectPath),
      sourceMapJson,
    );
    return { success: false, issues: [issue] };
  }
}

function enrichIssueLocation(
  issues: Array<{ message: string; severity: string; location?: unknown }>,
  fallbackFileName: string,
): KernelIssue[] {
  return issues.map((issue) => ({
    ...issue,
    message: issue.message,
    type: 'runtime' as const,
    severity: issue.severity === 'warning' ? ('warning' as const) : ('error' as const),
    location: (issue.location as KernelIssue['location']) ?? {
      fileName: fallbackFileName,
      startLineNumber: 1,
      startColumn: 1,
    },
  }));
}

// =============================================================================
// Kernel module definition
// =============================================================================

export default defineKernel<ReplicadContext, InputShape[]>({
  name: 'ReplicadKernel',
  version: '1.0.0',

  async initialize(options, runtime) {
    const { logger, tracer } = runtime;
    const withExceptions = (options as { withExceptions?: boolean }).withExceptions === true;

    logger.debug(`Initializing OpenCASCADE WASM (withExceptions: ${withExceptions})`);

    let oc: OpenCascadeInstance;
    let ocWithExceptions: OpenCascadeInstanceWithExceptions | undefined;

    const wasmSpan = tracer.startSpan('replicad.wasm-init', { withExceptions });
    if (withExceptions) {
      const ocWe = await initOpenCascadeWithExceptions({ tracer });
      ocWithExceptions = ocWe;
      oc = ocWe as unknown as OpenCascadeInstance;
      const wrappedOc = wrapOcInstance(ocWe);
      replicad.setOC(wrappedOc as unknown as OpenCascadeInstance);
    } else {
      oc = await initOpenCascade({ tracer });
      replicad.setOC(oc);
    }

    wasmSpan.end();

    try {
      const fontSpan = tracer.startSpan('replicad.font-load');
      logger.debug('Loading default font for text rendering');
      await replicad.loadFont(geistRegularUrl, 'default');
      fontSpan.end();
    } catch (error) {
      logger.warn('Failed to load default font', { data: error });
    }

    registerReplicadModule(runtime);
    logger.debug('Replicad kernel initialized');

    return {
      oc,
      ocWithExceptions,
      withExceptions,
      replicadInitialised: true,
      librarySourceMapCache: new Map(),
    };
  },

  async canHandle({ filePath, extension }, { filesystem }) {
    if (!['ts', 'js'].includes(extension)) {
      return false;
    }

    const code = await filesystem.readFile(filePath, 'utf8');

    const hasImport = /import.*from\s+['"]replicad['"]/s.test(code);
    const hasRequire = /require\s*\(['"]replicad['"]\)/.test(code);
    const hasDestructure = /\bconst\s*{\s*[\w\s,]*}\s*=\s*replicad\s*;/.test(code);
    const hasTypedef = /@typedef.*import\s*\(\s*['"]replicad['"]\s*\)/.test(code);
    const hasCdnImport = /import.*from\s+['"]https?:\/\/[^'"]*replicad[^'"]*['"]/s.test(code);

    return hasImport || hasRequire || hasDestructure || hasTypedef || hasCdnImport;
  },

  async getDependencies({ filePath }: GetDependenciesInput, runtime: KernelRuntime): Promise<string[]> {
    return runtime.bundler.resolveDependencies(filePath);
  },

  async getParameters(
    { filePath, basePath }: GetParametersInput,
    runtime: KernelRuntime,
    ctx: ReplicadContext,
  ): Promise<GetParametersResult> {
    const relativeFilePath = resolveToRelative(filePath, basePath);
    try {
      const bundleResult = await runtime.bundler.bundle(filePath);
      if (!bundleResult.success) {
        return createKernelError(enrichIssueLocation(bundleResult.issues, relativeFilePath));
      }

      const executeResult = await runtime.execute(bundleResult.code);
      if (!executeResult.success) {
        return createKernelError(enrichIssueLocation(executeResult.issues, relativeFilePath));
      }

      const defaultParameters = extractDefaultParameters(executeResult.value);
      const jsonSchema = await jsonSchemaFromJson(defaultParameters);

      return createKernelSuccess({ defaultParameters, jsonSchema });
    } catch (error) {
      const issue = formatRuntimeErrorWithOc(
        error,
        ctx.ocWithExceptions,
        (errorToFormat) => parseError(errorToFormat, undefined, basePath),
        (frames) => resolveLibraryFrames(frames, ctx),
        (frames) => deriveLocation(frames, undefined, basePath),
      );
      return createKernelError([issue]);
    }
  },

  async createGeometry(
    { filePath, basePath, parameters }: CreateGeometryInput,
    runtime: KernelRuntime,
    ctx: ReplicadContext,
  ) {
    const { tracer } = runtime;
    const relativeFilePath = resolveToRelative(filePath, basePath);

    const bundleResult = await runtime.bundler.bundle(filePath);
    if (!bundleResult.success) {
      throw new ReplicadBuildError(enrichIssueLocation(bundleResult.issues, relativeFilePath));
    }

    const executeResult = await runtime.execute(bundleResult.code);
    if (!executeResult.success) {
      throw new ReplicadBuildError(enrichIssueLocation(executeResult.issues, relativeFilePath));
    }

    const module = executeResult.value as RuntimeModuleExports;
    const mainSpan = tracer.startSpan('replicad.run-main', { phase: 'computingGeometry' });
    const mainResult = await runMain<MainResultShapes>(module, parameters, ctx, bundleResult.sourceMap, basePath);
    mainSpan.end();

    if (!mainResult.success) {
      throw new ReplicadBuildError(mainResult.issues);
    }

    const shapes = mainResult.value;

    if (shapes === undefined) {
      return {
        geometry: [],
        nativeHandle: [],
        issues: [
          {
            message: 'main() did not return any shapes. Did you forget to add a return statement?',
            location: { fileName: relativeFilePath, startLineNumber: 1, startColumn: 1 },
            type: 'runtime' as const,
            severity: 'warning' as const,
          },
        ],
      };
    }

    const defaultName = extractDefaultName(module);

    let nativeHandle: InputShape[] = [];
    const renderedShapes = renderOutput(
      shapes,
      (shapesArray) => {
        nativeHandle = shapesArray;
        return shapesArray;
      },
      defaultName,
    );

    const shapes3d = renderedShapes.filter((shape): shape is GeometryReplicad => shape.format === 'replicad');
    const shapes2d = renderedShapes.filter((shape): shape is GeometrySvg => shape.format === 'svg');

    if (shapes3d.length === 0 && shapes2d.length === 0) {
      return { geometry: [], nativeHandle: [] };
    }

    const gltfShapes: GeometryGltf[] = [];
    if (shapes3d.length > 0) {
      const gltfSpan = tracer.startSpan('replicad.mesh-to-gltf', {
        shapeCount: shapes3d.length,
        phase: 'computingGeometry',
      });
      const gltfBlob = await convertReplicadGeometriesToGltf(shapes3d, 'glb');
      gltfSpan.end();
      gltfShapes.push({ format: 'gltf', content: gltfBlob });
    }

    return { geometry: [...gltfShapes, ...shapes2d], nativeHandle };
  },

  async exportGeometry(
    { fileType, meshConfig }: ExportGeometryInput,
    _runtime: KernelRuntime,
    _ctx: ReplicadContext,
    nativeHandle: InputShape[],
  ): Promise<ExportGeometryResult> {
    const config = meshConfig ?? { linearTolerance: 0.01, angularTolerance: 30 };

    if (nativeHandle.length === 0) {
      return createKernelError([{ message: 'No geometry available for export', type: 'runtime', severity: 'error' }]);
    }

    if (fileType === 'glb' || fileType === 'gltf') {
      const temporaryShapes = nativeHandle.map((shapeConfig) => {
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
          edges: { lines: [], edgeGroups: [] },
        } satisfies GeometryReplicad;
      });

      const gltfBlob = await convertReplicadGeometriesToGltf(temporaryShapes, fileType);
      return createKernelSuccess([
        { blob: new Blob([asBuffer(gltfBlob.buffer)]), name: fileType === 'glb' ? 'model.glb' : 'model.gltf' },
      ]);
    }

    if (fileType === 'step-assembly') {
      return createKernelSuccess([{ blob: replicad.exportSTEP(nativeHandle), name: 'assembly' }]);
    }

    const result = nativeHandle.map(({ shape, name }) => ({
      blob: buildBlob(shape, fileType, {
        tolerance: config.linearTolerance,
        angularTolerance: config.angularTolerance,
      }),
      name: name ?? 'Geometry',
    }));

    return createKernelSuccess(result);
  },
});

function buildBlob(
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

  throw new Error(`Unsupported export format: ${fileType}`);
}

class ReplicadBuildError extends Error {
  public readonly issues: KernelIssue[];
  public constructor(issues: KernelIssue[]) {
    super(issues.map((i) => i.message).join('; '));
    this.issues = issues;
  }
}
