/**
 * JSCAD Kernel Module
 *
 * Full defineKernel implementation for the JSCAD kernel.
 * Uses runtime.bundler for JS/TS bundling and runtime.execute for evaluation.
 * Registers @jscad/modeling as a built-in module so user code can import it.
 */

import * as jscadModeling from '@jscad/modeling';
import type {
  CreateGeometryInput,
  ExportGeometryInput,
  ExportGeometryResult,
  GetDependenciesInput,
  GetParametersInput,
  GetParametersResult,
  GeometryResponse,
  KernelIssue,
  KernelRuntime,
} from '@taucad/types';
import { defineKernel } from '@taucad/types';
import { asBuffer } from '@taucad/utils/file';
import { jsonSchemaFromJson } from '@taucad/utils/schema';
import { createKernelError, createKernelSuccess } from '#framework/kernel-helpers.js';
import { parseStackTrace, resolveSourcePath, deriveLocationFromFrames } from '#framework/error-enrichment.js';
import { jscadToGltf } from '#kernels/jscad/jscad-to-gltf.js';
import type { JscadParameterDefinition } from '#kernels/jscad/jscad.schema.js';
import {
  convertParameterDefinitionsToDefaults,
  convertParameterDefinitionsToJsonSchema,
} from '#kernels/jscad/jscad.schema.js';

// =============================================================================
// Types
// =============================================================================

type JscadContext = {
  modulesRegistered: boolean;
};

type JscadModuleExports = {
  getParameterDefinitions?: () => JscadParameterDefinition[];
  defaultParams?: Record<string, unknown>;
  default?: (...args: unknown[]) => unknown;
  main?: (...args: unknown[]) => unknown;
};

const kernelModulesKey = '__KERNEL_MODULES__';

// =============================================================================
// JSCAD submodule list
// =============================================================================

const jscadSubmodules = [
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
] as const;

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
// Module registration helpers
// =============================================================================

function getModuleRegistry(): Map<string, Record<string, unknown>> {
  let registry = (globalThis as Record<string, unknown>)[kernelModulesKey] as
    | Map<string, Record<string, unknown>>
    | undefined;
  if (!registry) {
    registry = new Map();
    (globalThis as Record<string, unknown>)[kernelModulesKey] = registry;
  }

  return registry;
}

function generateModuleShim(name: string, exports: Record<string, unknown>): string {
  const registry = getModuleRegistry();
  registry.set(name, exports);

  const exportNames = Object.keys(exports).filter((key) => /^[a-z_$][\w$]*$/i.test(key) && key !== 'default');
  const namedExports = exportNames.map((key) => `export const ${key} = __mod.${key};`).join('\n');
  return `const __mod = globalThis.${kernelModulesKey}.get('${name}');\n${namedExports}\nexport default __mod;\n`;
}

function registerJscadModules(runtime: KernelRuntime): void {
  const rawImport = jscadModeling as unknown as Record<string, unknown>;
  const exports = (rawImport['default'] ?? rawImport) as Record<string, unknown>;
  const registry = getModuleRegistry();
  registry.set('@jscad/modeling', exports);

  const rootCode = generateModuleShim('@jscad/modeling', exports);
  runtime.bundler.registerModule('@jscad/modeling', {
    code: rootCode,
    version: '2.12.6',
    globalName: 'jscadModeling',
  });

  for (const subpath of jscadSubmodules) {
    const submoduleName = `@jscad/modeling/${subpath}`;
    const submoduleExports = exports[subpath];
    if (submoduleExports && typeof submoduleExports === 'object') {
      const subRecord = submoduleExports as Record<string, unknown>;
      const subExportNames = Object.keys(subRecord).filter((key) => /^[a-z_$][\w$]*$/i.test(key));
      const subNamed = subExportNames.map((key) => `export const ${key} = __mod.${key};`).join('\n');
      const subCode = `const __mod = globalThis.${kernelModulesKey}.get('@jscad/modeling').${subpath};\n${subNamed}\nexport default __mod;\n`;
      runtime.bundler.registerModule(submoduleName, { code: subCode, version: '2.12.6' });
    }
  }
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

  const defaults = module['defaultParams'] ?? module['defaultParameters'];
  return isRecordObject(defaults) ? defaults : {};
}

async function runMain(module: JscadModuleExports, parameters: Record<string, unknown>): Promise<unknown> {
  const mainFunction = module.default ?? module.main;
  if (!mainFunction || typeof mainFunction !== 'function') {
    return undefined;
  }

  if (mainFunction.length >= 2) {
    const registry = getModuleRegistry();
    const injectedModule = registry.values().next();
    return mainFunction(injectedModule.done ? undefined : injectedModule.value, parameters);
  }

  return mainFunction(parameters);
}

function enrichIssueLocation(issues: KernelIssue[], fallbackFileName: string): KernelIssue[] {
  return issues.map((issue) => ({
    ...issue,
    location: issue.location ?? { fileName: fallbackFileName, startLineNumber: 1, startColumn: 1 },
  }));
}

/**
 * When esbuild bundles CJS code (`module.exports = {...}`) to ESM format,
 * the exports are wrapped under `default` as an object. This unwraps them
 * so that named properties like `main` and `getParameterDefinitions` are
 * directly accessible.
 */
function resolveModule(module: unknown): JscadModuleExports {
  const mod = module as JscadModuleExports;
  if (mod.default && typeof mod.default !== 'function' && isRecordObject(mod.default)) {
    return mod.default as JscadModuleExports;
  }

  return mod;
}

// =============================================================================
// Kernel module definition
// =============================================================================

export default defineKernel<JscadContext, unknown[]>({
  name: 'JscadKernel',
  version: '1.0.0',

  async initialize(_options, runtime) {
    registerJscadModules(runtime);
    runtime.logger.debug('Initialized JSCAD kernel with @jscad/modeling');
    return { modulesRegistered: true };
  },

  async canHandle({ filePath, extension }, { filesystem }) {
    if (!['ts', 'js'].includes(extension)) {
      return false;
    }

    const code = await filesystem.readFile(filePath, 'utf8');
    const hasEsmImport = /import\s+.*from\s+['"]@jscad\/modeling(\/[^'"]*)?['"]/.test(code);
    const hasRequire = /require\s*\(\s*['"]@jscad\/modeling(\/[^'"]*)?['"]\s*\)/.test(code);
    return hasEsmImport || hasRequire;
  },

  async getDependencies({ filePath }: GetDependenciesInput, runtime: KernelRuntime): Promise<string[]> {
    return runtime.bundler.resolveDependencies(filePath);
  },

  async getParameters(
    { filePath, basePath }: GetParametersInput,
    runtime: KernelRuntime,
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

      const rawModule = executeResult.value as JscadModuleExports;
      const module = resolveModule(rawModule);
      let defaultParameters: Record<string, unknown> = {};
      let jsonSchema;

      if (isRecordObject(module) && typeof module.getParameterDefinitions === 'function') {
        const definitions = (module.getParameterDefinitions as () => JscadParameterDefinition[])();
        defaultParameters = convertParameterDefinitionsToDefaults(definitions);
        jsonSchema = convertParameterDefinitionsToJsonSchema(definitions);
      } else if (isRecordObject(module) && module.defaultParams && isRecordObject(module.defaultParams)) {
        defaultParameters = module.defaultParams;
        jsonSchema = await jsonSchemaFromJson(defaultParameters);
      } else {
        defaultParameters = extractDefaultParameters(module);
        jsonSchema = await jsonSchemaFromJson(defaultParameters);
      }

      return createKernelSuccess({ defaultParameters, jsonSchema });
    } catch (error) {
      return createKernelError([
        {
          message: error instanceof Error ? error.message : 'Failed to extract parameters',
          location: { fileName: relativeFilePath, startLineNumber: 1, startColumn: 1 },
          type: 'runtime',
          severity: 'error',
        },
      ]);
    }
  },

  async createGeometry({ filePath, basePath, parameters }: CreateGeometryInput, runtime: KernelRuntime) {
    const relativeFilePath = resolveToRelative(filePath, basePath);
    const { logger } = runtime;

    const bundleResult = await runtime.bundler.bundle(filePath);
    if (!bundleResult.success) {
      throw new JscadBuildError(enrichIssueLocation(bundleResult.issues, relativeFilePath));
    }

    const executeResult = await runtime.execute(bundleResult.code);
    if (!executeResult.success) {
      throw new JscadBuildError(enrichIssueLocation(executeResult.issues, relativeFilePath));
    }

    const rawModule = executeResult.value as JscadModuleExports;
    const module = resolveModule(rawModule);

    let shapes: unknown;
    try {
      shapes = await runMain(module, parameters);
    } catch (error) {
      const stackFrames = parseStackTrace(error, {
        sourceMap: bundleResult.sourceMap,
        resolveSourcePath: (s) => resolveSourcePath(s, basePath),
      });
      const location = deriveLocationFromFrames(stackFrames, bundleResult.sourceMap, (s) =>
        resolveSourcePath(s, basePath),
      );
      throw new JscadBuildError([
        {
          message: error instanceof Error ? error.message : String(error),
          type: 'runtime' as const,
          severity: 'error' as const,
          stackFrames,
          location,
        },
      ]);
    }

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

    const shapesArray = Array.isArray(shapes) ? shapes : [shapes];
    const filteredShapes = shapesArray.filter(Boolean);

    if (filteredShapes.length === 0) {
      return { geometry: [], nativeHandle: [] };
    }

    const geometries: GeometryResponse[] = [];
    const results = await Promise.allSettled(filteredShapes.map(async (shape) => jscadToGltf(shape)));

    for (const result of results) {
      if (result.status === 'fulfilled') {
        geometries.push({ format: 'gltf', content: result.value });
      } else {
        logger.warn('Failed to convert shape to GLTF', { data: result.reason });
      }
    }

    return { geometry: geometries, nativeHandle: filteredShapes };
  },

  async exportGeometry(
    { fileType }: ExportGeometryInput,
    _runtime: KernelRuntime,
    _ctx: JscadContext,
    nativeHandle: unknown[],
  ): Promise<ExportGeometryResult> {
    if (nativeHandle.length === 0) {
      return createKernelError([{ message: 'No geometry available for export.', type: 'runtime', severity: 'error' }]);
    }

    if (fileType === 'glb' || fileType === 'gltf') {
      const gltfBlobs = await Promise.all(nativeHandle.map(async (shape) => jscadToGltf(shape)));
      const blob = gltfBlobs[0];
      if (!blob) {
        return createKernelError([
          { message: 'Failed to generate GLTF from computed geometry', type: 'runtime', severity: 'error' },
        ]);
      }

      return createKernelSuccess([
        { blob: new Blob([asBuffer(blob.buffer)]), name: fileType === 'glb' ? 'model.glb' : 'model.gltf' },
      ]);
    }

    return createKernelError([
      {
        message: `Export format '${fileType}' is not yet implemented for JSCAD. Only 'glb' and 'gltf' are supported.`,
        type: 'runtime',
        severity: 'error',
      },
    ]);
  },
});

class JscadBuildError extends Error {
  public readonly issues: KernelIssue[];
  public constructor(issues: KernelIssue[]) {
    super(issues.map((i) => i.message).join('; '));
    this.issues = issues;
  }
}
