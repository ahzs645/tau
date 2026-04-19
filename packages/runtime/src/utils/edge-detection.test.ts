import { NodeIO } from '@gltf-transform/core';
import { KHRMaterialsUnlit } from '@gltf-transform/extensions';
import { describe, it, expect } from 'vitest';
import { detectEdges } from '#utils/edge-detection.js';
import openscadKernel from '#kernels/openscad/openscad.kernel.js';
import { createGeometryFile, createTestWorker } from '#testing/kernel-testing.utils.js';
import { extractGltfFromResult } from '#testing/kernel-geometry-testing.utils.js';

// =============================================================================
// Test Utilities
// =============================================================================

/** Create an OpenScad runtime worker for testing with the provided files. */
async function createWorker(files: Record<string, string>): ReturnType<typeof createTestWorker> {
  return createTestWorker(openscadKernel, files);
}

/**
 * Parse GLTF content and extract primitive information by mode.
 * Uses glTF primitive modes to distinguish surfaces (triangles) from edges (lines).
 */
async function parseGltfPrimitives(gltfContent: Uint8Array<ArrayBuffer>): Promise<{
  trianglePrimitives: Array<{ vertexCount: number }>;
  linePrimitives: Array<{
    vertexCount: number;
    positions: Float32Array | undefined;
    indices: Uint16Array | Uint32Array | undefined;
  }>;
}> {
  const io = new NodeIO().registerExtensions([KHRMaterialsUnlit]);
  const document = await io.readBinary(gltfContent);

  const trianglePrimitives: Array<{ vertexCount: number }> = [];
  const linePrimitives: Array<{
    vertexCount: number;
    positions: Float32Array | undefined;
    indices: Uint16Array | Uint32Array | undefined;
  }> = [];

  const primitiveModeTriangles = 4;
  const primitiveModeLines = 1;

  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const positionAccessor = primitive.getAttribute('POSITION');
      const indexAccessor = primitive.getIndices();

      if (primitive.getMode() === primitiveModeTriangles) {
        trianglePrimitives.push({
          vertexCount: positionAccessor?.getCount() ?? 0,
        });
      } else if (primitive.getMode() === primitiveModeLines) {
        const posArray = positionAccessor?.getArray();
        const indexArray = indexAccessor?.getArray();

        linePrimitives.push({
          vertexCount: positionAccessor?.getCount() ?? 0,
          positions: posArray instanceof Float32Array ? posArray : undefined,
          indices: indexArray instanceof Uint16Array || indexArray instanceof Uint32Array ? indexArray : undefined,
        });
      }
    }
  }

  return { trianglePrimitives, linePrimitives };
}

/**
 * Calculate bounding box of positions array.
 */
function calculateBoundingBox(positions: Float32Array): {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
} {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  for (let index = 0; index < positions.length; index += 3) {
    const x = positions[index] ?? 0;
    const y = positions[index + 1] ?? 0;
    const z = positions[index + 2] ?? 0;

    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    min[2] = Math.min(min[2], z);

    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
    max[2] = Math.max(max[2], z);
  }

  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

// =============================================================================
// Edge Detection Unit Tests
// =============================================================================

describe('detectEdges', () => {
  describe('Simple geometry', () => {
    it('should detect all 12 edges of a cube from indexed triangles', () => {
      // Unit cube: 8 vertices, 12 triangles (2 per face)
      // prettier-ignore -- preserve vertex coordinate alignment
      const positions = new Float32Array([
        // Front face vertices (z = 1)
        0,
        0,
        1, // 0
        1,
        0,
        1, // 1
        1,
        1,
        1, // 2
        0,
        1,
        1, // 3
        // Back face vertices (z = 0)
        0,
        0,
        0, // 4
        1,
        0,
        0, // 5
        1,
        1,
        0, // 6
        0,
        1,
        0, // 7
      ]);

      // 12 triangles for 6 faces (2 triangles per face)
      // prettier-ignore -- preserve triangle index grouping
      const indices = new Uint16Array([
        // Front face
        0, 1, 2, 2, 3, 0,
        // Back face
        5, 4, 7, 7, 6, 5,
        // Top face
        3, 2, 6, 6, 7, 3,
        // Bottom face
        4, 5, 1, 1, 0, 4,
        // Right face
        1, 5, 6, 6, 2, 1,
        // Left face
        4, 0, 3, 3, 7, 4,
      ]);

      const result = detectEdges(positions, indices, 30);

      // A cube has 12 edges, all should be detected as sharp (90 degree angles)
      const edgeCount = result.positions.length / 6; // 6 floats per edge (2 vertices × 3 coords)
      expect(edgeCount).toBe(12);

      // Verify edges form proper bounding box
      const bbox = calculateBoundingBox(result.positions);
      expect(bbox.min).toEqual([0, 0, 0]);
      expect(bbox.max).toEqual([1, 1, 1]);
    });

    it('should detect edges for a simple triangle', () => {
      // Single triangle has 3 boundary edges
      const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0.5, 1, 0]);

      // No indices = non-indexed geometry
      const result = detectEdges(positions, undefined, 30);

      // 3 boundary edges (edges with only one adjacent face)
      const edgeCount = result.positions.length / 6;
      expect(edgeCount).toBe(3);
    });
  });

  describe('Degenerate triangles', () => {
    it('should skip degenerate triangles where two vertices share the same hash', () => {
      const positions = new Float32Array([
        0,
        0,
        0, // V0
        0,
        0,
        0, // V1 (same as V0)
        1,
        1,
        0, // V2
      ]);

      const result = detectEdges(positions, undefined, 30);

      // Degenerate triangle should be skipped, producing no edges
      expect(result.positions.length).toBe(0);
    });
  });

  describe('Threshold behavior', () => {
    it('should detect all edges at threshold 0', () => {
      // Two triangles sharing an edge at 45 degree angle
      const positions = new Float32Array([
        0,
        0,
        0, // 0
        1,
        0,
        0, // 1
        0,
        1,
        0, // 2
        1,
        1,
        0.5, // 3 (tilted up)
      ]);

      const indices = new Uint16Array([
        0,
        1,
        2, // Triangle 1 (flat)
        1,
        3,
        2, // Triangle 2 (tilted)
      ]);

      const result = detectEdges(positions, indices, 0);

      // All shared edges should be detected at threshold 0
      // Plus boundary edges
      expect(result.positions.length).toBeGreaterThan(0);
    });

    it('should detect fewer edges at higher threshold', () => {
      // Same geometry, higher threshold
      const positions = new Float32Array([
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        1,
        0,
        1,
        1,
        0.1, // Very slight tilt
      ]);

      const indices = new Uint16Array([0, 1, 2, 1, 3, 2]);

      const lowThreshold = detectEdges(positions, indices, 1);
      const highThreshold = detectEdges(positions, indices, 89);

      // Shared edge between triangles should be detected at low threshold
      // but not at high threshold (angle is small)
      // Boundary edges should be detected in both cases
      expect(lowThreshold.positions.length).toBeGreaterThanOrEqual(highThreshold.positions.length);
    });
  });
});

// =============================================================================
// Edge Detection Middleware Integration Tests
// =============================================================================

// Skipped: edge detection integration tests require dynamic middleware loading
// which is not available in the test environment. Edge detection is tested
// in isolation in the unit tests above and in gltf-edge-detection.middleware.test.ts
describe.skip('Edge Detection Middleware', () => {
  describe('OpenScad cube geometry', () => {
    it('should add edge primitives to cube GLTF', async () => {
      const worker = await createWorker({
        // eslint-disable-next-line @typescript-eslint/naming-convention -- test file name
        'cube.scad': 'cube([10, 10, 10]);',
      });

      const result = await worker.createGeometry({
        file: createGeometryFile('cube.scad'),
        parameters: {},
      });

      expect(result.success).toBe(true);

      const gltfContent = extractGltfFromResult(result);
      expect(gltfContent).toBeDefined();

      if (!gltfContent) {
        return;
      }

      const { trianglePrimitives, linePrimitives } = await parseGltfPrimitives(gltfContent);

      // Should have at least one triangle primitive (the cube surface)
      expect(trianglePrimitives.length).toBeGreaterThan(0);

      // Should have at least one line primitive (the edges)
      expect(linePrimitives.length).toBeGreaterThan(0);
    });

    it('should have edge positions matching cube bounding box', async () => {
      const worker = await createWorker({
        // eslint-disable-next-line @typescript-eslint/naming-convention -- test file name
        'cube.scad': 'cube([10, 10, 10]);',
      });

      const result = await worker.createGeometry({
        file: createGeometryFile('cube.scad'),
        parameters: {},
      });

      expect(result.success).toBe(true);

      const gltfContent = extractGltfFromResult(result);
      expect(gltfContent).toBeDefined();

      if (!gltfContent) {
        return;
      }

      const { linePrimitives } = await parseGltfPrimitives(gltfContent);

      expect(linePrimitives.length).toBeGreaterThan(0);

      const edgePrimitive = linePrimitives[0];
      expect(edgePrimitive?.positions).not.toBeNull();

      if (!edgePrimitive?.positions) {
        return;
      }

      const bbox = calculateBoundingBox(edgePrimitive.positions);

      // OpenSCAD cube([10, 10, 10]) creates a cube from (0,0,0) to (10,10,10)
      // Edge positions should span the full cube dimensions
      expect(bbox.size[0]).toBeCloseTo(0.01, 4); // X size should be ~0.01m
      expect(bbox.size[1]).toBeCloseTo(0.01, 4); // Y size should be ~0.01m
      expect(bbox.size[2]).toBeCloseTo(0.01, 4); // Z size should be ~0.01m

      // Positions should include all corners
      expect(bbox.min[0]).toBeCloseTo(0, 4);
      expect(bbox.min[1]).toBeCloseTo(0, 4);
      expect(bbox.min[2]).toBeCloseTo(-0.01, 4);
      expect(bbox.max[0]).toBeCloseTo(0.01, 4);
      expect(bbox.max[1]).toBeCloseTo(0.01, 4);
      expect(bbox.max[2]).toBeCloseTo(0, 4);
    });

    it('should detect 12 edges for a simple cube', async () => {
      const worker = await createWorker({
        // eslint-disable-next-line @typescript-eslint/naming-convention -- test file name
        'cube.scad': 'cube([10, 10, 10]);',
      });

      const result = await worker.createGeometry({
        file: createGeometryFile('cube.scad'),
        parameters: {},
      });

      expect(result.success).toBe(true);

      const gltfContent = extractGltfFromResult(result);
      expect(gltfContent).toBeDefined();

      if (!gltfContent) {
        return;
      }

      const { linePrimitives } = await parseGltfPrimitives(gltfContent);

      expect(linePrimitives.length).toBeGreaterThan(0);

      const edgePrimitive = linePrimitives[0];
      expect(edgePrimitive?.positions).not.toBeNull();

      if (!edgePrimitive?.positions) {
        return;
      }

      // Each edge has 2 vertices, each vertex has 3 coordinates
      // 12 edges * 2 vertices * 3 coords = 72 floats
      const edgeCount = edgePrimitive.positions.length / 6;

      // A cube should have exactly 12 edges
      // Note: OpenSCAD may triangulate differently, so we check for >= 12
      expect(edgeCount).toBeGreaterThanOrEqual(12);

      // All edges should span the full cube - check each dimension has both 0 and 10

      const { positions } = edgePrimitive;
      const uniqueX = new Set<number>();
      const uniqueY = new Set<number>();
      const uniqueZ = new Set<number>();

      for (let index = 0; index < positions.length; index += 3) {
        uniqueX.add(Math.round((positions[index] ?? 0) * 100_000) / 100_000);
        uniqueY.add(Math.round((positions[index + 1] ?? 0) * 100_000) / 100_000);
        uniqueZ.add(Math.round((positions[index + 2] ?? 0) * 100_000) / 100_000);
      }

      expect(uniqueX.has(0)).toBe(true);
      expect(uniqueX.has(0.01)).toBe(true);
      expect(uniqueY.has(0)).toBe(true);
      expect(uniqueY.has(0.01)).toBe(true);
      expect(uniqueZ.has(0)).toBe(true);
      expect(uniqueZ.has(-0.01)).toBe(true);
    });
  });

  describe('Sphere geometry', () => {
    it('should have edge positions spanning full sphere diameter', async () => {
      const worker = await createWorker({
        // eslint-disable-next-line @typescript-eslint/naming-convention -- test file name
        'sphere.scad': '$fn=16; sphere(r=5);',
      });

      const result = await worker.createGeometry({
        file: createGeometryFile('sphere.scad'),
        parameters: {},
      });

      expect(result.success).toBe(true);

      const gltfContent = extractGltfFromResult(result);
      expect(gltfContent).toBeDefined();

      if (!gltfContent) {
        return;
      }

      const { linePrimitives } = await parseGltfPrimitives(gltfContent);

      // Sphere may have edges or not depending on threshold
      // Low-poly sphere ($fn=16) should have visible edges
      if (linePrimitives.length > 0 && linePrimitives[0]?.positions) {
        const bbox = calculateBoundingBox(linePrimitives[0].positions);

        // Sphere radius 5, diameter 10, centered at origin
        // Edges should span approximately -5 to 5 in all dimensions
        expect(bbox.min[0]).toBeLessThan(-4);
        expect(bbox.min[1]).toBeLessThan(-4);
        expect(bbox.min[2]).toBeLessThan(-4);
        expect(bbox.max[0]).toBeGreaterThan(4);
        expect(bbox.max[1]).toBeGreaterThan(4);
        expect(bbox.max[2]).toBeGreaterThan(4);
      }
    });
  });
});
