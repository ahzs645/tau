import { createRuntimeClient } from '@taucad/runtime';
import { createInProcessTransport } from '@taucad/runtime/transport';
import { openscad } from '@taucad/runtime/kernels';
import { gltfCoordinateTransform } from '@taucad/runtime/middleware';
import type { RuntimeClient } from '@taucad/runtime';
import type { MeasurementTestRequirement } from '@taucad/testing';
import { analyzeGlb, evaluateRequirement } from '@taucad/testing/geometry';
import type { GeometryStats } from '@taucad/testing/geometry';
import type { GraderCheck } from '#benchmarks/model-benchmark-suite.js';

// =============================================================================
// Types
// =============================================================================

export type BenchmarkGeometryExpectation = {
  boundingBox?: {
    size?: { x?: number; y?: number; z?: number };
    center?: { x?: number; y?: number; z?: number };
  };
  meshCount?: number;
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

export function createGeometryRenderer(): RuntimeClient {
  return createRuntimeClient({
    kernels: [openscad()],
    middleware: [gltfCoordinateTransform()],
    transport: createInProcessTransport(),
  });
}

export async function renderCodeToGlb(
  client: RuntimeClient,
  files: Record<string, string>,
  mainFile: string,
): Promise<GeometryRenderResult> {
  try {
    const result = await client.render({ code: files, file: mainFile });

    if (!result.success) {
      const messages = result.issues.map((i) => i.message).join('; ');
      return { success: false, error: `Render failed: ${messages}` };
    }

    const gltf = result.data.find((g) => g.format === 'gltf');
    if (!gltf) {
      return { success: false, error: 'No GLTF geometry in render result' };
    }

    return { success: true, glb: gltf.content };
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

  if (expectations.meshCount !== undefined) {
    requirements.push({
      type: 'measurement',
      id: 'geometry_mesh_count',
      description: `Mesh count should be ${expectations.meshCount}`,
      check: 'meshCount',
      expected: { count: expectations.meshCount },
    });
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
  client: RuntimeClient;
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
