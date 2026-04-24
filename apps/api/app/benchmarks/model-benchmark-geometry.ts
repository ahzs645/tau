import { createRuntimeClient, fromMemoryFS } from '@taucad/runtime';
import type { HashedGeometryResult } from '@taucad/runtime';
import { createInProcessTransport } from '@taucad/runtime/transport';
import { openscad } from '@taucad/openscad';
import { gltfCoordinateTransform } from '@taucad/runtime/middleware';
import type { MeasurementTestRequirement } from '@taucad/testing';
import { analyzeGlb, evaluateRequirement } from '@taucad/testing/geometry';
import type { GeometryStats } from '@taucad/testing/geometry';
import type { GraderCheck } from '#benchmarks/model-benchmark-suite.js';
import type { ApiRuntimeClient } from '#types/runtime-client.alias.js';

// =============================================================================
// Types
// =============================================================================

export type BenchmarkGeometryExpectation = {
  boundingBox?: {
    size?: { x?: number; y?: number; z?: number };
    center?: { x?: number; y?: number; z?: number };
  };
  connectedComponents?: number;
  watertight?: boolean;
  tolerance?: number;
};

export type GeometryRenderResult = { success: true; glb: Uint8Array<ArrayBuffer> } | { success: false; error: string };

export type GeometryValidationResult = {
  rendered: boolean;
  renderSuccess: boolean;
  renderError?: string;
  checks: GraderCheck[];
  stats?: GeometryStats;
  glb?: Uint8Array<ArrayBuffer>;
};

// =============================================================================
// Renderer
// =============================================================================

const defaultGeometryTolerance = 1;

const benchmarkFileSystems = new WeakMap<ApiRuntimeClient, ReturnType<typeof fromMemoryFS>>();

export function createGeometryRenderer(): ApiRuntimeClient {
  const fileSystem = fromMemoryFS();
  const client = createRuntimeClient({
    kernels: [openscad()],
    middleware: [gltfCoordinateTransform()],
    transport: createInProcessTransport(),
    fileSystem,
  });
  benchmarkFileSystems.set(client, fileSystem);
  return client;
}

/**
 * Eagerly connect a benchmark renderer so its first `openFile` call does not
 * throw `RuntimeNotConnectedError`. `connect()` is a hard precondition for
 * `openFile`/`updateParameters`/`setOptions`.
 *
 * Reuses the in-memory filesystem registered in `createGeometryRenderer` so
 * file writes flow through the same FS that the worker mounts.
 */
export async function ensureGeometryRendererConnected(client: ApiRuntimeClient): Promise<void> {
  if (client.lifecycleState === 'connected') {
    return;
  }
  const fileSystem = benchmarkFileSystems.get(client);
  if (!fileSystem) {
    throw new Error('createGeometryRenderer must be used to construct benchmark RuntimeClients');
  }
  await client.connect({ fileSystem });
}

export async function renderCodeToGlb(
  client: ApiRuntimeClient,
  files: Record<string, string>,
  mainFile: string,
): Promise<GeometryRenderResult> {
  try {
    // Subscribe to the geometry event before kicking off the render, so we can
    // observe the (possibly superseded) settled result. `openFile()` returns a
    // `RenderOutcome` whose
    // `geometry` field carries the latest hashed result; we defensively also
    // listen on `'geometry'` in case the settlement was superseded by a fresh
    // call (which is unlikely here since this is a one-shot helper).
    let lastGeometry: HashedGeometryResult | undefined;
    const off = client.on('geometry', (result) => {
      lastGeometry = result;
    });

    try {
      await ensureGeometryRendererConnected(client);

      // Pre-write inline files into the same memory FS the worker mounts so
      // openFile() reads them without race / FS-mismatch concerns.
      const fileSystem = benchmarkFileSystems.get(client);
      if (!fileSystem) {
        return { success: false, error: 'Renderer is missing its memory filesystem registration' };
      }
      await Promise.all(
        Object.entries(files).map(async ([filename, content]) => {
          const absolutePath = filename.startsWith('/') ? filename : `/${filename}`;
          await fileSystem.writeFile(absolutePath, content);
        }),
      );
      const resolvedMainFile = mainFile.startsWith('/') ? mainFile : `/${mainFile}`;

      const settlement = await client.openFile({ file: resolvedMainFile });
      const result: HashedGeometryResult | undefined = settlement.superseded ? lastGeometry : settlement.geometry;

      if (!result) {
        return { success: false, error: 'Render produced no geometry result' };
      }

      if (!result.success) {
        const messages = result.issues.map((issue) => issue.message).join('; ');
        return { success: false, error: `Render failed: ${messages}` };
      }

      const gltf = result.data.find((geometry) => geometry.format === 'gltf');
      if (!gltf) {
        return { success: false, error: 'No GLTF geometry in render result' };
      }

      return { success: true, glb: gltf.content };
    } finally {
      off();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Render error: ${message}` };
  }
}

// =============================================================================
// Grading
// =============================================================================

function expectationToRequirements(expectations: BenchmarkGeometryExpectation): MeasurementTestRequirement[] {
  const requirements: MeasurementTestRequirement[] = [];
  const tolerance = expectations.tolerance ?? defaultGeometryTolerance;

  if (expectations.boundingBox) {
    const expected: Record<string, unknown> = {};

    // oxlint-disable-next-line unicorn/explicit-length-check -- false positive, checking object existence not Set.size
    if (expectations.boundingBox.size) {
      expected['size'] = expectations.boundingBox.size;
    }
    if (expectations.boundingBox.center) {
      expected['center'] = expectations.boundingBox.center;
    }

    if (Object.keys(expected).length > 0) {
      requirements.push({
        type: 'measurement',
        id: 'geometry_bbox',
        description: 'Bounding box dimensions match expected values',
        check: 'boundingBox',
        expected,
        tolerance,
      });
    }
  }

  if (expectations.connectedComponents !== undefined) {
    requirements.push({
      type: 'measurement',
      id: 'geometry_connected_components',
      description: `Connected components should be ${expectations.connectedComponents}`,
      check: 'connectedComponents',
      expected: { count: expectations.connectedComponents },
    });
  }

  if (expectations.watertight) {
    requirements.push({
      type: 'measurement',
      id: 'geometry_watertight',
      description: 'Mesh should be watertight (closed manifold)',
      check: 'watertight',
    });
  }

  return requirements;
}

export async function gradeGeometry(
  glb: Uint8Array<ArrayBuffer>,
  expectations: BenchmarkGeometryExpectation,
): Promise<{ checks: GraderCheck[]; stats?: GeometryStats }> {
  const requirements = expectationToRequirements(expectations);
  if (requirements.length === 0) {
    return { checks: [] };
  }

  const stats = await analyzeGlb(glb);
  const checks: GraderCheck[] = requirements.map((requirement) => {
    const result = evaluateRequirement(requirement, stats);
    return { name: requirement.id, passed: result.passed, detail: result.passed ? undefined : result.reason };
  });

  return { checks, stats };
}

// =============================================================================
// Orchestration
// =============================================================================

export type ValidateGeometryOptions = {
  client: ApiRuntimeClient;
  files: Record<string, string>;
  mainFile: string;
  expectations: BenchmarkGeometryExpectation;
};

export async function validateGeometry({
  client,
  files,
  mainFile,
  expectations,
}: ValidateGeometryOptions): Promise<GeometryValidationResult> {
  const renderResult = await renderCodeToGlb(client, files, mainFile);

  if (!renderResult.success) {
    return {
      rendered: true,
      renderSuccess: false,
      renderError: renderResult.error,
      checks: [{ name: 'geometry_render', passed: false, detail: renderResult.error }],
    };
  }

  const renderCheck: GraderCheck = { name: 'geometry_render', passed: true };
  const { checks: geometryChecks, stats } = await gradeGeometry(renderResult.glb, expectations);

  return {
    rendered: true,
    renderSuccess: true,
    checks: [renderCheck, ...geometryChecks],
    stats,
    glb: renderResult.glb,
  };
}
