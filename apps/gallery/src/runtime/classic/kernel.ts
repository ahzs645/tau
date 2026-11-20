import { z } from 'zod';
import { createExportFile } from '@taucad/runtime/types';
import {
  createKernelParameterDeclaration,
  createKernelSuccess,
  defineKernel,
  gltfExportConventionSchema,
} from '@taucad/runtime/kernel';
import type { KernelIssue, KernelServices } from '@taucad/runtime/kernel';
import { describeClassicSources } from '#runtime/classic/describe.js';
import { runClassicOpenScad } from '#runtime/classic/engine.js';
import { loadClassicFonts } from '#runtime/classic/fonts.js';
import type { ClassicFonts } from '#runtime/classic/fonts.js';
import { classicMeshToGlb, parseClassicOff } from '#runtime/classic/mesh.js';
import type { ClassicMesh } from '#runtime/classic/mesh.js';
import { restoreClassicOffPrecision } from '#runtime/classic/precision.js';
import { classicParameterDeclaration } from '#runtime/classic/parameters.js';
import { listClassicSourcePaths, readClassicSources } from '#runtime/classic/sources.js';
import type { ClassicSources } from '#runtime/classic/sources.js';
import { classicRenderSchema, classicResolution } from '#runtime/classic/tessellation.js';
import type { ClassicTessellation } from '#runtime/classic/tessellation.js';

type ClassicContext = { fonts: ClassicFonts };
type ClassicMeshResult = {
  mesh: ClassicMesh;
  issues: readonly KernelIssue[];
  resolution: Record<string, number>;
  key: string;
  stlBytes: Uint8Array<ArrayBuffer>;
};
type ClassicHandle = {
  sources: ClassicSources;
  parameters: Readonly<Record<string, unknown>>;
  latestMesh?: ClassicMeshResult;
};

const meshAt = async (
  handle: ClassicHandle,
  requested: ClassicTessellation,
  runtime: { services: Pick<KernelServices, 'signal' | 'logger'>; context: ClassicContext },
): Promise<ClassicMeshResult> => {
  const { services, context } = runtime;
  const resolution = requested === undefined ? (handle.latestMesh?.resolution ?? {}) : classicResolution(requested);
  const key = JSON.stringify(resolution);
  if (handle.latestMesh?.key === key) {
    services.signal.throwIfAborted();
    return handle.latestMesh;
  }
  const output = await runClassicOpenScad({
    sources: handle.sources,
    fonts: context.fonts,
    parameters: handle.parameters,
    resolution,
    format: 'off',
    signal: services.signal,
    logger: services.logger,
  });
  if (!output.precisionBytes) {
    throw new Error('OpenSCAD did not return the paired native ASCII STL precision output.');
  }
  const preciseOff = restoreClassicOffPrecision(
    new TextDecoder().decode(output.bytes),
    new TextDecoder().decode(output.precisionBytes),
  );
  const mesh = parseClassicOff(preciseOff);
  const result = { mesh, issues: output.issues, resolution, key, stlBytes: output.precisionBytes };
  handle.latestMesh = result;
  return result;
};

/** Explicit compatibility engine for the preserved authored OpenSCAD catalogue; never an error fallback. */
export const classicOpenScad = defineKernel({
  id: 'openscad',
  extensions: ['scad'],
  name: 'ClassicOpenScadGalleryKernel',
  version: '1.2.0+gallery.5',
  evaluateOptionsSchema: z.object({}),
  views: {
    model: {
      title: 'Model',
      mimeType: 'model/gltf-binary',
      optionsSchema: classicRenderSchema,
      content: ['includeEdges'],
    },
  },
  exports: {
    glb: {
      title: 'glTF binary',
      mimeType: 'model/gltf-binary',
      extension: 'glb',
      optionsSchema: classicRenderSchema.extend(gltfExportConventionSchema.shape),
      content: ['includeEdges'],
    },
    stl: {
      title: 'STL',
      mimeType: 'model/stl',
      extension: 'stl',
      optionsSchema: classicRenderSchema,
    },
  },

  async initialize(): Promise<ClassicContext> {
    return { fonts: await loadClassicFonts() };
  },
  async resolve(_input, { filesystem }) {
    return { resolved: await listClassicSourcePaths(filesystem), unresolved: [] };
  },
  async describe({ entryPath }, services, context) {
    const sources = await readClassicSources(entryPath, services.filesystem);
    const described = await describeClassicSources(sources, context.fonts, services);
    const { defaultParameters, jsonSchema } = classicParameterDeclaration(described.parameters);
    return createKernelSuccess(
      {
        parameters: createKernelParameterDeclaration(defaultParameters, jsonSchema, {
          id: 'urn:taucad:gallery:classic-openscad:parameters',
          name: 'ClassicOpenScadParameters',
        }),
      },
      described.issues,
    );
  },
  async evaluate({ entryPath, parameters }, { filesystem }) {
    const handle: ClassicHandle = { sources: await readClassicSources(entryPath, filesystem), parameters };
    return { handle };
  },
  async render({ handle, options, content }, services, context) {
    const result = await meshAt(handle, options.tessellation, { services, context });
    return {
      content: classicMeshToGlb(result.mesh, { includeEdges: content?.includeEdges === true }),
      issues: result.issues,
    };
  },
  async export(input, services, context) {
    const { handle, exportId, options } = input;
    if (exportId === 'glb') {
      const result = await meshAt(handle, input.options.tessellation, { services, context });
      const bytes = classicMeshToGlb(result.mesh, {
        includeEdges: input.content?.includeEdges === true,
        coordinateSystem: input.options.coordinateSystem,
        unit: input.options.unit.length,
      });
      return { files: [createExportFile('glb', 'model.glb', bytes)] as const, issues: result.issues };
    }
    const result = await meshAt(handle, options.tessellation, { services, context });
    // Return a transfer-safe copy of the exact native output paired with this mesh, without re-evaluating the model.
    return {
      files: [createExportFile('stl', 'model.stl', new Uint8Array(result.stlBytes))] as const,
      issues: result.issues,
    };
  },
  async onDispose(context) {
    context.fonts = [];
  },
});
