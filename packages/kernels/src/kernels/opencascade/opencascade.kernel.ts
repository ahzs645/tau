/* oxlint-disable eslint(new-cap) -- OpenCascade API uses PascalCase method names */
/**
 * OpenCascade Kernel Module
 *
 * Direct OpenCASCADE kernel that exposes the raw opencascade.js API
 * without the Replicad abstraction layer. Users write TypeScript/JavaScript
 * that directly calls OpenCASCADE classes (gp_Pnt, BRepPrimAPI_MakeBox, etc.).
 *
 * Uses a standalone opencascade.js full WASM build for the OpenCASCADE runtime.
 */

import type { GeometryGltf } from '@taucad/types';
import { z } from 'zod';
import { jsonSchemaFromJson } from '@taucad/utils/schema';
import { createExportFile } from '@taucad/types/constants';
import { asBuffer } from '@taucad/utils/file';
import { defineKernel } from '#types/kernel-worker.types.js';
import type { KernelRuntime } from '#types/kernel-worker.types.js';
import type { KernelIssue } from '#types/kernel.types.js';
import { createKernelError, createKernelSuccess } from '#framework/kernel-helpers.js';
import { initOpenCascade, resolveCjsDefault } from '#kernels/opencascade/init-opencascade.js';
import type { OpenCascadeModuleFactory } from '#kernels/opencascade/init-opencascade.js';
import { meshShapesToGltf } from '#kernels/opencascade/opencascade-mesh.js';
// eslint-disable-next-line import-x/no-extraneous-dependencies -- internal # imports resolve to self
import type { OpenCascadeInstance, TopoDS_Shape } from '#kernels/opencascade/wasm/opencascade_full.js';

const fullWasmUrl = new URL('wasm/opencascade_full.wasm', import.meta.url).href;

// eslint-disable-next-line @typescript-eslint/naming-convention -- module-level constant
const KERNEL_MODULES_KEY = '__KERNEL_MODULES__';

// =============================================================================
// Types
// =============================================================================

type RuntimeModuleExports = {
  default?: (...args: unknown[]) => unknown;
  main?: (...args: unknown[]) => unknown;
  defaultParams?: Record<string, unknown>;
  defaultParameters?: Record<string, unknown>;
  defaultName?: string;
};

type ShapeEntry = {
  shape: TopoDS_Shape;
  name?: string;
  color?: string;
  opacity?: number;
};

// =============================================================================
// Options
// =============================================================================

/** Custom WASM binary location for the OpenCascade kernel. */
export type OpenCascadeWasmConfig = {
  wasmUrl: string;
  wasmBindingsUrl: string;
};

/** Configuration options for the OpenCascade kernel plugin. */
export type OpenCascadeOptions = {
  wasm?: 'full' | OpenCascadeWasmConfig;
};

const opencascadeOptionsSchema = z.object({
  wasm: z
    .union([z.literal('full'), z.object({ wasmUrl: z.string(), wasmBindingsUrl: z.string() })])
    .optional()
    .default('full'),
}) satisfies z.ZodType<Required<OpenCascadeOptions>>;

// =============================================================================
// WASM resolution
// =============================================================================

async function resolveWasm(wasm: 'full' | OpenCascadeWasmConfig): Promise<{
  wasmUrl: string;
  bindingsFactory: OpenCascadeModuleFactory;
}> {
  if (wasm === 'full') {
    // eslint-disable-next-line import-x/no-extraneous-dependencies -- internal # imports resolve to self
    const module_ = await import('#kernels/opencascade/wasm/opencascade_full.js');
    return {
      wasmUrl: fullWasmUrl,
      bindingsFactory: resolveCjsDefault<OpenCascadeModuleFactory>(module_.default),
    };
  }

  // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- dynamic import with variable URL
  const module_: Record<string, unknown> = await import(/* @vite-ignore */ wasm.wasmBindingsUrl);
  return {
    wasmUrl: wasm.wasmUrl,
    bindingsFactory: resolveCjsDefault(module_['default'] ?? module_) as OpenCascadeModuleFactory,
  };
}

// =============================================================================
// Helpers
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

function registerOcModule(oc: OpenCascadeInstance, runtime: KernelRuntime): void {
  const registry = getModuleRegistry();
  const ocRecord = oc as Record<string, unknown>;
  registry.set('opencascade', ocRecord);

  const exportNames = Object.keys(ocRecord).filter((key) => /^[$_a-z][\w$]*$/i.test(key));
  const namedExports = exportNames.map((key) => `export const ${key} = __mod.${key};`).join('\n');
  const code = `const __mod = globalThis.${KERNEL_MODULES_KEY}.get('opencascade');\n${namedExports}\nexport default __mod;\n`;

  runtime.bundler.registerModule('opencascade', { code, version: '2.0.0' });
  runtime.bundler.registerModule('opencascade.js', { code, version: '2.0.0' });
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractDefaultParameters(module: unknown): Record<string, unknown> {
  if (!isRecordObject(module)) {
    return {};
  }
  const params = module['defaultParams'] ?? module['defaultParameters'];
  if (isRecordObject(params)) {
    return params;
  }
  return {};
}

function resolveToRelative(absolutePath: string, basePath: string): string {
  const normalizedBase = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  if (absolutePath.startsWith(`${normalizedBase}/`)) {
    return absolutePath.slice(normalizedBase.length + 1);
  }

  return absolutePath;
}

function enrichIssueLocation(
  issues: Array<{ message: string; severity: string; location?: unknown }>,
  fallbackFileName: string,
): KernelIssue[] {
  return issues.map((issue) => ({
    ...issue,
    message: issue.message,
    type: 'runtime',
    severity: issue.severity === 'warning' ? 'warning' : 'error',
    location: (issue.location as KernelIssue['location']) ?? {
      fileName: fallbackFileName,
      startLineNumber: 1,
      startColumn: 1,
    },
  }));
}

function normalizeShapes(value: unknown): ShapeEntry[] {
  if (!value) {
    return [];
  }

  if (isOpenCascadeShape(value)) {
    return [{ shape: value }];
  }

  if (Array.isArray(value)) {
    const entries: ShapeEntry[] = [];
    for (const item of value) {
      if (isOpenCascadeShape(item)) {
        entries.push({ shape: item });
      } else if (isRecordObject(item) && 'shape' in item && isOpenCascadeShape(item['shape'])) {
        entries.push({
          shape: item['shape'],
          name: typeof item['name'] === 'string' ? item['name'] : undefined,
          color: typeof item['color'] === 'string' ? item['color'] : undefined,
          opacity: typeof item['opacity'] === 'number' ? item['opacity'] : undefined,
        });
      }
    }

    return entries;
  }

  if (isRecordObject(value) && 'shape' in value && isOpenCascadeShape(value['shape'])) {
    return [
      {
        shape: value['shape'],
        name: typeof value['name'] === 'string' ? value['name'] : undefined,
        color: typeof value['color'] === 'string' ? value['color'] : undefined,
        opacity: typeof value['opacity'] === 'number' ? value['opacity'] : undefined,
      },
    ];
  }

  return [];
}

function isOpenCascadeShape(value: unknown): value is TopoDS_Shape {
  return isRecordObject(value) && typeof value['IsNull'] === 'function' && typeof value['delete'] === 'function';
}

// =============================================================================
// Kernel definition
// =============================================================================

export default defineKernel({
  name: 'OpenCascadeKernel',
  version: '1.0.0',
  optionsSchema: opencascadeOptionsSchema,

  async initialize(options, runtime) {
    const { logger, tracer } = runtime;
    logger.debug(
      `Initializing OpenCascade kernel (wasm: ${typeof options.wasm === 'string' ? options.wasm : 'custom'})`,
    );

    const span = tracer.startSpan('opencascade.wasm-init');
    const resolved = await resolveWasm(options.wasm);
    const oc = await initOpenCascade(resolved.wasmUrl, resolved.bindingsFactory, { tracer });
    span.end();

    registerOcModule(oc, runtime);
    logger.debug('OpenCascade kernel initialized');

    return { oc };
  },

  async canHandle({ filePath, extension }, { filesystem }) {
    if (!['ts', 'js'].includes(extension)) {
      return false;
    }

    const code = await filesystem.readFile(filePath, 'utf8');
    return (
      /import.*from\s+["']opencascade(\.js)?["']/s.test(code) || /require\s*\(["']opencascade(\.js)?["']\)/.test(code)
    );
  },

  async getDependencies({ filePath }, runtime) {
    return runtime.bundler.resolveDependencies(filePath);
  },

  async getParameters({ filePath, basePath }, runtime) {
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
      return createKernelError([
        {
          message: error instanceof Error ? error.message : String(error),
          type: 'runtime',
          severity: 'error',
          location: { fileName: relativeFilePath, startLineNumber: 1, startColumn: 1 },
        },
      ]);
    }
  },

  async createGeometry({ filePath, basePath, parameters, tessellation }, runtime, context) {
    const { tracer } = runtime;
    const relativeFilePath = resolveToRelative(filePath, basePath);

    const bundleResult = await runtime.bundler.bundle(filePath);
    if (!bundleResult.success) {
      throw new OcctBuildError(enrichIssueLocation(bundleResult.issues, relativeFilePath));
    }

    const executeResult = await runtime.execute(bundleResult.code);
    if (!executeResult.success) {
      throw new OcctBuildError(enrichIssueLocation(executeResult.issues, relativeFilePath));
    }

    const module = executeResult.value as RuntimeModuleExports;
    const mainFunction = module.default ?? module.main;

    if (!mainFunction || typeof mainFunction !== 'function') {
      return {
        geometry: [],
        nativeHandle: [],
        issues: [
          {
            message: 'main() or default export function not found.',
            type: 'runtime',
            severity: 'warning',
            location: { fileName: relativeFilePath, startLineNumber: 1, startColumn: 1 },
          },
        ],
      };
    }

    const mainSpan = tracer.startSpan('opencascade.run-main', { phase: 'computingGeometry' });
    let rawResult: unknown;
    try {
      rawResult =
        mainFunction.length >= 2 ? await mainFunction(context.oc, parameters) : await mainFunction(parameters);
    } catch (error) {
      mainSpan.end();
      throw new OcctBuildError([
        {
          message: error instanceof Error ? error.message : String(error),
          type: 'runtime',
          severity: 'error',
          location: { fileName: relativeFilePath, startLineNumber: 1, startColumn: 1 },
        },
      ]);
    }
    mainSpan.end();

    const shapeEntries = normalizeShapes(rawResult);
    if (shapeEntries.length === 0) {
      return {
        geometry: [],
        nativeHandle: [],
        issues: [
          {
            message: 'main() did not return any shapes. Return a TopoDS_Shape or an array of shapes.',
            type: 'runtime',
            severity: 'warning',
            location: { fileName: relativeFilePath, startLineNumber: 1, startColumn: 1 },
          },
        ],
      };
    }

    const meshSpan = tracer.startSpan('opencascade.mesh-to-gltf', {
      shapeCount: shapeEntries.length,
      phase: 'computingGeometry',
    });

    const linearTolerance = tessellation?.linearTolerance ?? 0.1;
    const angularTolerance = tessellation?.angularTolerance ?? 30;
    const gltfData = meshShapesToGltf(context.oc, shapeEntries, {
      linearTolerance,
      angularTolerance: angularTolerance * (Math.PI / 180),
    });
    meshSpan.end();

    const geometry: GeometryGltf[] = [{ format: 'gltf', content: gltfData }];
    return { geometry, nativeHandle: shapeEntries };
  },

  async exportGeometry({ fileType, nativeHandle }, _runtime, context) {
    if (nativeHandle.length === 0) {
      return createKernelError([{ message: 'No geometry available for export', type: 'runtime', severity: 'error' }]);
    }

    if (fileType === 'glb' || fileType === 'gltf') {
      const gltfData = meshShapesToGltf(context.oc, nativeHandle, {
        linearTolerance: 0.01,
        angularTolerance: 0.5,
      });

      return createKernelSuccess([
        createExportFile(fileType, fileType === 'glb' ? 'model.glb' : 'model.gltf', asBuffer(gltfData)),
      ]);
    }

    if (fileType === 'step' || fileType === 'step-assembly') {
      const { oc } = context;
      const results = nativeHandle.map((entry) => {
        const writer = new oc.STEPControl_Writer();
        const progress = new oc.Message_ProgressRange();
        writer.Transfer(entry.shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true, progress);
        const filePath = `/tmp/export_${Date.now()}.step`;
        writer.Write(filePath);
        const rawData = oc.FS.readFile(filePath) as Uint8Array<ArrayBuffer>;
        const data = new Uint8Array(rawData);
        oc.FS.unlink(filePath);
        progress.delete();
        writer.delete();
        return createExportFile(fileType, entry.name ?? 'Geometry', data);
      });

      return createKernelSuccess(results);
    }

    if (fileType === 'stl' || fileType === 'stl-binary') {
      const { oc } = context;
      const results = nativeHandle.map((entry) => {
        const mesh = new oc.BRepMesh_IncrementalMesh(entry.shape, 0.01, false, 0.5, false);
        const filePath = `/tmp/export_${Date.now()}.stl`;
        const writer = new oc.StlAPI_Writer();
        const progress = new oc.Message_ProgressRange();
        writer.Write_1(entry.shape, filePath, progress);
        const rawData = oc.FS.readFile(filePath) as Uint8Array<ArrayBuffer>;
        const data = new Uint8Array(rawData);
        oc.FS.unlink(filePath);
        mesh.delete();
        progress.delete();
        writer.delete();
        return createExportFile(fileType, entry.name ?? 'Geometry', data);
      });

      return createKernelSuccess(results);
    }

    return createKernelError([
      { message: `Unsupported export format: ${fileType}`, type: 'runtime', severity: 'error' },
    ]);
  },
});

class OcctBuildError extends Error {
  public readonly issues: KernelIssue[];
  public constructor(issues: KernelIssue[]) {
    super(issues.map((i) => i.message).join('; '));
    this.issues = issues;
  }
}
