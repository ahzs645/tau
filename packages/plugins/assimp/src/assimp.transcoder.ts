import { defineTranscoder } from '@taucad/runtime/transcoder';
import { lookupMimeType } from '@taucad/runtime/types';
import { AssimpError, conversionEdges, createAssimp, defaultPostProcess } from 'libassimp';
import type { Assimp, ConversionEdge, ExportFormat, ExportOptionsFor } from 'libassimp';
import { z } from 'zod';
import { assimpEdgeSchemas, pointCloudExportOptions, tauSetExportOptions } from '#assimp-export-options.js';

type TauAssimpRoute = Extract<ConversionEdge, { from: 'glb' | 'gltf'; to: Exclude<ExportFormat, 'assjson'> }>;

type AssimpTranscoderContext = { assimp: Assimp };

type TauAssimpEdge<Edge extends TauAssimpRoute = TauAssimpRoute> = Edge extends TauAssimpRoute
  ? Readonly<{
      from: Edge['from'];
      to: Edge['to'];
      optionsSchema: (typeof assimpEdgeSchemas)[Edge['to']];
      sourceOptions: typeof specNativeGltfSource;
    }>
  : never;

const isTauAssimpRoute = (edge: ConversionEdge): edge is TauAssimpRoute =>
  (edge.from === 'glb' || edge.from === 'gltf') && edge.to !== 'assjson';

const specNativeGltfSource = {
  coordinateSystem: 'y-up',
  unit: { length: 'meter' },
} as const;

const toTauEdge = <Edge extends TauAssimpRoute>(edge: Edge): TauAssimpEdge<Edge> =>
  ({
    ...edge,
    optionsSchema: assimpEdgeSchemas[edge.to],
    sourceOptions: specNativeGltfSource,
  }) as unknown as TauAssimpEdge<Edge>;

const edges: readonly TauAssimpEdge[] = conversionEdges
  .filter((edge) => isTauAssimpRoute(edge))
  .map((edge) => toTauEdge(edge));

const assimpTranscoderOptionsSchema = z
  .object({ backend: z.enum(['auto', 'native', 'wasm']).default('auto') })
  .strict();

type InputFile = Readonly<{ name: string; bytes: Uint8Array<ArrayBuffer> }>;

const gltfPointsMode = 0;
const gltfSurfaceModes: ReadonlySet<unknown> = new Set([4, 5, 6]);
const gltfPointAndLineModes: ReadonlySet<unknown> = new Set([0, 1, 2, 3]);
const glbMagic = 0x46_54_6c_67;
const glbJsonChunk = 0x4e_4f_53_4a;
const threeMfPostProcess = [...defaultPostProcess, 'optimizeMeshes'] as const;
// Public ImportOptions uses aiPrimitiveType flags POINT (1) + LINE (2), not glTF mode values.
const assimpPointAndLineTypes = 3;

/**
 * Read the glTF JSON of a `.gltf` file or a GLB's first chunk.
 * @param file - Name and bytes of one input artifact.
 * @returns The parsed document, or `undefined` when the bytes are neither format.
 */
const gltfJson = ({ name, bytes }: InputFile): unknown => {
  try {
    if (name.toLowerCase().endsWith('.gltf')) {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 20 || view.getUint32(0, true) !== glbMagic || view.getUint32(16, true) !== glbJsonChunk) {
      return undefined;
    }
    return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true)))) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * Identify models that contain only point primitives.
 * @param files - The complete input artifact set.
 * @returns Whether primitives exist and every primitive draws points.
 */
const isPointCloud = (files: readonly InputFile[]): boolean => {
  const document = files.map((file) => gltfJson(file)).find((json) => json !== undefined) as
    | { meshes?: Array<{ primitives?: Array<{ mode?: number }> }> }
    | undefined;
  const primitives = document?.meshes?.flatMap((mesh) => mesh.primitives ?? []) ?? [];
  return primitives.length > 0 && primitives.every((primitive) => primitive.mode === gltfPointsMode);
};

/**
 * Keep canonical topology and its primitive-run provenance out of mesh optimization.
 * @param files - The complete input artifact set.
 * @returns Whether a document declares or carries canonical manifold topology.
 */
const hasManifoldTopology = (files: readonly InputFile[]): boolean =>
  files.some((file) => {
    const document = gltfJson(file);
    if (document === null || typeof document !== 'object') {
      return false;
    }
    const declarations = [
      'extensionsUsed' in document ? document.extensionsUsed : undefined,
      'extensionsRequired' in document ? document.extensionsRequired : undefined,
    ];
    if (declarations.some((value) => Array.isArray(value) && value.includes('EXT_mesh_manifold'))) {
      return true;
    }
    if (!('meshes' in document) || !Array.isArray(document.meshes)) {
      return false;
    }
    return document.meshes.some(
      (mesh: unknown) =>
        mesh !== null &&
        typeof mesh === 'object' &&
        'extensions' in mesh &&
        mesh.extensions !== null &&
        typeof mesh.extensions === 'object' &&
        'EXT_mesh_manifold' in mesh.extensions,
    );
  });

/**
 * Identify surface models that also contain zero- or one-dimensional primitives.
 * @param files - The complete input artifact set.
 * @returns Whether valid glTF primitive modes include both surfaces and points or lines.
 */
const hasMixedSurfacePrimitives = (files: readonly InputFile[]): boolean => {
  let hasSurface = false;
  let hasPointsOrLines = false;
  for (const file of files) {
    const document = gltfJson(file);
    if (
      document === null ||
      typeof document !== 'object' ||
      !('meshes' in document) ||
      !Array.isArray(document.meshes)
    ) {
      continue;
    }
    const meshes: unknown[] = document.meshes;
    for (const mesh of meshes) {
      if (mesh === null || typeof mesh !== 'object' || !('primitives' in mesh) || !Array.isArray(mesh.primitives)) {
        continue;
      }
      const primitives: unknown[] = mesh.primitives;
      for (const primitive of primitives) {
        if (primitive === null || typeof primitive !== 'object') {
          continue;
        }
        const mode = 'mode' in primitive ? primitive.mode : 4;
        hasSurface ||= gltfSurfaceModes.has(mode);
        hasPointsOrLines ||= gltfPointAndLineModes.has(mode);
      }
    }
  }
  return hasSurface && hasPointsOrLines;
};

/**
 * Combine form options with the hidden options Tau chooses for this model.
 * @param to - The requested export format.
 * @param formOptions - User-selected export options.
 * @param files - The complete input artifact set.
 * @returns The native export options for the selected format and model.
 */
const exportOptionsFor = (
  to: ExportFormat,
  formOptions: unknown,
  files: readonly InputFile[],
): ExportOptionsFor<typeof to> => {
  const options: Record<string, unknown> = {
    ...tauSetExportOptions[to],
    ...(formOptions as Record<string, unknown>),
    ...(isPointCloud(files) ? pointCloudExportOptions : {}),
  };
  return options as ExportOptionsFor<typeof to>;
};

/**
 * Explain native errors that arise from a setting or size limit.
 * @param error - The conversion failure.
 * @returns The native message with any applicable action for the user.
 */
const failureMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : 'Transcoding failed';
  if (error instanceof AssimpError && error.code === 'LIMIT_EXCEEDED') {
    return `${message} The model is too large to export here. Try a coarser tessellation.`;
  }
  if (/is not manifold and oriented/u.test(message)) {
    return `${message} The model has open or inconsistently oriented surfaces. Turn off Require manifold to export it anyway.`;
  }
  return message;
};

/** Assimp-backed glTF/GLB mesh export transcoder. @public */
export const assimpTranscoder = defineTranscoder({
  id: 'assimp',
  name: 'AssimpTranscoder',
  version: '0.1.4',
  edges,
  optionsSchema: assimpTranscoderOptionsSchema,

  async initialize({ backend }, services) {
    const assimp = await createAssimp({
      backend,
      onLog: ({ cause, level, message }) => {
        services.logger.custom(level === 'warning' ? 'warn' : level, message, { data: cause });
      },
    });
    services.logger.log(`libassimp backend=${assimp.backend} addon=${assimp.buildIdentity ?? 'none'}`);
    return { assimp };
  },

  async transcode(input, services, context: AssimpTranscoderContext) {
    if (input.files.length === 0) {
      return {
        success: false,
        issues: [
          { message: 'No input files provided for transcoding', code: 'RUNTIME', type: 'runtime', severity: 'error' },
        ],
      };
    }

    try {
      services.logger.log(`Transcoding ${input.from} -> ${input.to}`);
      // The declared TauAssimpRoute edges accept only GLB/glTF inputs.
      const optimizeFacePrimitives = input.to === '3mf' && !hasManifoldTopology(input.files);
      const surfaceOnly = optimizeFacePrimitives && hasMixedSurfacePrimitives(input.files);
      const options = {
        to: input.to,
        exportOptions: exportOptionsFor(input.to, input.options, input.files),
        signal: services.signal,
        // OCCT faces are separate glTF primitives, imported as separate aiMeshes. Join only
        // compatible meshes within their original node before 3MF's strict whole-part check.
        // The native step preserves materials, placements and instancing; it does not repair
        // topology. Canonical EXT_mesh_manifold inputs already carry their whole-part indices.
        ...(optimizeFacePrimitives ? { postProcess: threeMfPostProcess } : {}),
        // A valid BRep can contain free vertices alongside its closed surface. A surface
        // 3MF exports only its triangles; keep point-only inputs and canonical owners intact.
        ...(surfaceOnly ? { importOptions: { ppSbpRemove: assimpPointAndLineTypes } } : {}),
      };
      const { files } = await context.assimp.convert(
        input.files.map(({ name, bytes }) => ({ name, bytes })),
        options,
      );
      const output = files.map(({ name, bytes }) => ({
        name,
        bytes: new Uint8Array(bytes),
        mimeType: lookupMimeType(name.split('.').pop() ?? ''),
      }));
      services.logger.log(`Successfully transcoded to ${input.to}`);
      return { success: true, data: output, issues: [] };
    } catch (error) {
      return {
        success: false,
        issues: [{ message: failureMessage(error), code: 'RUNTIME', type: 'runtime', severity: 'error' }],
      };
    }
  },

  async onDispose(context) {
    await context.assimp.dispose();
  },
});
