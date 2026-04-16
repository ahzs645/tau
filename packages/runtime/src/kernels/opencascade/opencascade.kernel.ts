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
import { defineKernel } from '#types/runtime-kernel.types.js';
import type { KernelRuntime } from '#types/runtime-kernel.types.js';
import type { KernelIssue } from '#types/runtime.types.js';
import { createKernelError, createKernelSuccess } from '#kernels/kernel-helpers.js';
import { initOpenCascade } from '#kernels/opencascade/init-opencascade.js';
import type { OpenCascadeModule } from '#kernels/opencascade/init-opencascade.js';
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

/**
 * Custom WASM binary location for the OpenCascade kernel.
 * @public
 */
export type OpenCascadeWasmConfig = {
  wasmUrl: string;
  wasmBindingsUrl: string;
};

/**
 * Configuration options for the OpenCascade kernel plugin.
 * @public
 */
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
  moduleExports: OpenCascadeModule;
}> {
  if (wasm === 'full') {
    // eslint-disable-next-line import-x/no-extraneous-dependencies -- internal # imports resolve to self
    const moduleExports = await import('#kernels/opencascade/wasm/opencascade_full.js');
    return { wasmUrl: fullWasmUrl, moduleExports };
  }

  // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- dynamic import with variable URL
  const moduleExports: Record<string, unknown> = await import(/* @vite-ignore */ wasm.wasmBindingsUrl);
  return {
    wasmUrl: wasm.wasmUrl,
    moduleExports: moduleExports as unknown as OpenCascadeModule,
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
  registry.set('opencascade.js', ocRecord);

  const exportNames = Object.keys(ocRecord).filter((key) => /^[$_a-z][\w$]*$/i.test(key));
  const namedExports = exportNames.map((key) => `export const ${key} = __mod.${key};`).join('\n');
  const code = `const __mod = globalThis.${KERNEL_MODULES_KEY}.get('opencascade.js');\n${namedExports}\nexport default function init() {}\n`;

  runtime.bundler.registerModule('opencascade.js', { code, version: '3.0.0' });
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
          metalness: typeof item['metalness'] === 'number' ? item['metalness'] : undefined,
          roughness: typeof item['roughness'] === 'number' ? item['roughness'] : undefined,
          density: typeof item['density'] === 'number' ? item['density'] : undefined,
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
        metalness: typeof value['metalness'] === 'number' ? value['metalness'] : undefined,
        roughness: typeof value['roughness'] === 'number' ? value['roughness'] : undefined,
        density: typeof value['density'] === 'number' ? value['density'] : undefined,
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

/** @public */
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
    const oc = (await initOpenCascade(resolved.wasmUrl, resolved.moduleExports, { tracer })) as OpenCascadeInstance;
    span.end();
    registerOcModule(oc, runtime);
    logger.debug('OpenCascade kernel initialized');

    return { oc };
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

  async exportGeometry({ fileType, tessellation, nativeHandle }, _runtime, context) {
    if (nativeHandle.length === 0) {
      return createKernelError([{ message: 'No geometry available for export', type: 'runtime', severity: 'error' }]);
    }

    switch (format) {
      case 'glb':
      case 'gltf': {
        const { linearTolerance, angularTolerance } = options.tessellation;
        const { coordinateSystem } = options;

        const gltfData = meshShapesToGltf(context.oc, nativeHandle, {
          linearTolerance,
          angularTolerance: angularTolerance * (Math.PI / 180),
          coordinateSystem,
        });

        return createKernelSuccess([
          createExportFile(format, format === 'glb' ? 'model.glb' : 'model.gltf', asBuffer(gltfData)),
        ]);
      }

      case 'step': {
        const { oc } = context;
        const documentName = new oc.TCollection_ExtendedString();
        const document = new oc.TDocStd_Document(documentName);
        const mainLabel = document.Main();
        const shapeTool = oc.XCAFDoc_DocumentTool.ShapeTool(mainLabel);
        const colorTool = oc.XCAFDoc_DocumentTool.ColorTool(mainLabel);

        for (const entry of nativeHandle) {
          if (entry.shape.IsNull()) {
            continue;
          }

          const label = shapeTool.NewShape();
          shapeTool.SetShape(label, entry.shape);

          if (entry.name) {
            const entryName = new oc.TCollection_ExtendedString(entry.name, true);
            oc.TDataStd_Name.Set(label, entryName);
            entryName.delete();
          }

          if (entry.color) {
            const [r, g, b] = parseHexColor(entry.color);
            const color = new oc.Quantity_Color(r, g, b, oc.Quantity_TypeOfColor.Quantity_TOC_sRGB);
            colorTool.SetColor(label, color, oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf);
            color.delete();
          }

          if (entry.metalness !== undefined || entry.roughness !== undefined) {
            const visTool = oc.XCAFDoc_DocumentTool.VisMaterialTool(mainLabel);
            const pbrMat = new oc.XCAFDoc_VisMaterialPBR();
            if (entry.color) {
              const [r, g, b] = parseHexColor(entry.color);
              const baseColor = new oc.Quantity_ColorRGBA(r, g, b, entry.opacity ?? 1);
              pbrMat.BaseColor = baseColor;
              baseColor.delete();
            }
            pbrMat.Metallic = entry.metalness ?? cadMaterialDefaults.metalnessFactor;
            pbrMat.Roughness = entry.roughness ?? cadMaterialDefaults.roughnessFactor;
            pbrMat.IsDefined = true;
            const visMat = new oc.XCAFDoc_VisMaterial();
            visMat.SetPbrMaterial(pbrMat);
            const matName = new oc.TCollection_AsciiString(entry.name ?? 'material');
            const visMatLabel = visTool.AddMaterial(visMat, matName);
            visTool.SetShapeMaterial(label, visMatLabel);
            matName.delete();
            visMatLabel.delete();
            visMat.delete();
            pbrMat.delete();
            visTool.delete();
          }

          if (entry.density !== undefined) {
            const matTool = oc.XCAFDoc_DocumentTool.MaterialTool(mainLabel);
            const materialName = new oc.TCollection_HAsciiString(entry.name ?? 'material');
            const description = new oc.TCollection_HAsciiString('');
            const densityName = new oc.TCollection_HAsciiString('g/cm3');
            const densityValueType = new oc.TCollection_HAsciiString('POSITIVE_RATIO_MEASURE');
            matTool.SetMaterial(label, materialName, description, entry.density, densityName, densityValueType);
            densityValueType.delete();
            densityName.delete();
            description.delete();
            materialName.delete();
            matTool.delete();
          }

          label.delete();
        }

        shapeTool.UpdateAssemblies();

        const session = new oc.XSControl_WorkSession();
        const writer = new oc.STEPCAFControl_Writer(session, false);
        writer.SetColorMode(true);
        writer.SetNameMode(true);
        writer.SetMaterialMode(true);
        oc.Interface_Static.SetIVal('write.surfacecurve.mode', 1);
        oc.Interface_Static.SetIVal('write.step.assembly', 2);
        oc.Interface_Static.SetIVal('write.step.schema', 5);

        const progress = new oc.Message_ProgressRange();
        writer.Transfer(document, oc.STEPControl_StepModelType.STEPControl_AsIs, '', progress);

        const filePath = `/tmp/export_${Date.now()}.step`;
        writer.Write(filePath);
        const rawData = oc.FS.readFile(filePath) as Uint8Array<ArrayBuffer>;
        const data = new Uint8Array(rawData);
        oc.FS.unlink(filePath);

        progress.delete();
        writer.delete();
        session.delete();
        colorTool.delete();
        shapeTool.delete();
        mainLabel.delete();
        documentName.delete();
        document.delete();

        return createKernelSuccess([createExportFile('step', 'assembly', data)]);
      }

      case 'stl': {
        const { oc } = context;
        const { linearTolerance, angularTolerance } = options.tessellation;
        const angularToleranceRad = angularTolerance * (Math.PI / 180);
        const { coordinateSystem } = options;

        const results = nativeHandle.map((entry) => {
          let exportShape = entry.shape;

          if (coordinateSystem === 'y-up') {
            const origin = new oc.gp_Pnt(0, 0, 0);
            const direction = new oc.gp_Dir(1, 0, 0);
            const axis = new oc.gp_Ax1(origin, direction);
            const trsf = new oc.gp_Trsf();
            trsf.SetRotation(axis, Math.PI / 2);
            const transform = new oc.BRepBuilderAPI_Transform(entry.shape, trsf, true, false);
            exportShape = transform.Shape();
            origin.delete();
            direction.delete();
            axis.delete();
            trsf.delete();
            transform.delete();
          }

          oc.BRepTools.Clean(exportShape, false);
          const mesh = new oc.BRepMesh_IncrementalMesh(exportShape, linearTolerance, false, angularToleranceRad, false);
          const filePath = `/tmp/export_${Date.now()}.stl`;
          const writer = new oc.StlAPI_Writer();
          const progress = new oc.Message_ProgressRange();
          writer.Write(exportShape, filePath, progress);
          const rawData = oc.FS.readFile(filePath) as Uint8Array<ArrayBuffer>;
          const data = new Uint8Array(rawData);
          oc.FS.unlink(filePath);
          mesh.delete();
          progress.delete();
          writer.delete();
          return createExportFile('stl', entry.name ?? 'Geometry', data);
        });

        return createKernelSuccess(results);
      }

      default: {
        const _exhaustive: never = format;
        return createKernelError([
          { message: `Unsupported export format: ${_exhaustive as string}`, type: 'runtime', severity: 'error' },
        ]);
      }
    }
  },
});

class OcctBuildError extends Error {
  public readonly issues: KernelIssue[];
  public constructor(issues: KernelIssue[]) {
    super(issues.map((i) => i.message).join('; '));
    this.issues = issues;
  }
}
