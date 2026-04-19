/* eslint-disable @typescript-eslint/naming-convention -- file names use extensions */
// @vitest-environment node
/**
 * Cross-kernel mesh parity test.
 *
 * Verifies that the replicad and OpenCASCADE kernels produce semantically
 * identical mesh data (normals and positions) for the same underlying BRep
 * primitive. Both kernels ultimately call BRepPrimAPI_MakeCylinder — the only
 * difference is the GLTF rendering pipeline (custom ReplicadMeshExtractor +
 * JS glb-writer vs native RWGltf_CafWriter).
 *
 * Since the GLTF writers package data differently (different vertex counts,
 * primitive grouping, deduplication), we compare normals at spatially-matched
 * positions rather than doing byte-for-byte array comparison.
 *
 * Workers are created sequentially to avoid Embind type registry conflicts
 * that occur when initializing multiple WASM instances in the same process.
 */
import { describe, it, expect } from 'vitest';
import { NodeIO } from '@gltf-transform/core';
import replicadKernel from '#kernels/replicad/replicad.kernel.js';
import opencascadeKernel from '#kernels/opencascade/opencascade.kernel.js';
import { assertSuccess, createGeometryFile, createTestWorker } from '#testing/kernel-testing.utils.js';
import { extractGltfFromResult } from '#testing/kernel-geometry-testing.utils.js';
import type { CreateGeometryResult } from '#types/runtime.types.js';

type VertexNormal = {
  px: number;
  py: number;
  pz: number;
  nx: number;
  ny: number;
  nz: number;
};

async function extractAllVertexNormals(glbBytes: Uint8Array<ArrayBuffer>): Promise<VertexNormal[]> {
  const io = new NodeIO();
  const glbDocument = await io.readBinary(glbBytes);
  const vertices: VertexNormal[] = [];

  for (const mesh of glbDocument.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) {
        continue;
      }

      const posAccessor = prim.getAttribute('POSITION');
      const normAccessor = prim.getAttribute('NORMAL');
      if (!posAccessor || !normAccessor) {
        continue;
      }

      const positions = posAccessor.getArray()! as Float32Array;
      const normals = normAccessor.getArray()! as Float32Array;
      const vertexCount = positions.length / 3;

      for (let i = 0; i < vertexCount; i++) {
        vertices.push({
          px: positions[i * 3]!,
          py: positions[i * 3 + 1]!,
          pz: positions[i * 3 + 2]!,
          nx: normals[i * 3]!,
          ny: normals[i * 3 + 1]!,
          nz: normals[i * 3 + 2]!,
        });
      }
    }
  }

  return vertices;
}

function spatialKey(x: number, y: number, z: number): string {
  const scale = 1000;
  return `${Math.round(x * scale)},${Math.round(y * scale)},${Math.round(z * scale)}`;
}

function buildNormalMap(vertices: VertexNormal[]): Map<string, { nx: number; ny: number; nz: number }> {
  const accum = new Map<string, { nx: number; ny: number; nz: number; count: number }>();

  for (const v of vertices) {
    const key = spatialKey(v.px, v.py, v.pz);
    const existing = accum.get(key);
    if (existing) {
      existing.nx += v.nx;
      existing.ny += v.ny;
      existing.nz += v.nz;
      existing.count++;
    } else {
      accum.set(key, { nx: v.nx, ny: v.ny, nz: v.nz, count: 1 });
    }
  }

  const result = new Map<string, { nx: number; ny: number; nz: number }>();
  for (const [key, { nx, ny, nz }] of accum) {
    const length = Math.hypot(nx, ny, nz);
    if (length > 1e-10) {
      result.set(key, { nx: nx / length, ny: ny / length, nz: nz / length });
    } else {
      result.set(key, { nx: 0, ny: 0, nz: 0 });
    }
  }

  return result;
}

describe('Cross-kernel mesh parity', { timeout: 120_000 }, () => {
  it('should produce matching normals and positions for a cylinder', async () => {
    const geometryFile = createGeometryFile('cylinder.ts');

    // Create workers sequentially — shared global test filesystem reseeds on each call.
    // Generate geometry immediately after creating each worker, before the FS is wiped.
    const replicadWorker = await createTestWorker(replicadKernel, {
      'cylinder.ts': `
import { makeCylinder } from 'replicad';
export default function main() {
  return makeCylinder(5, 20);
}`,
    });
    const replicadResult = (await replicadWorker.createGeometry({
      file: geometryFile,
      parameters: {},
    })) as CreateGeometryResult;
    assertSuccess(replicadResult, 'replicad createGeometry');
    const replicadGlb = extractGltfFromResult(replicadResult);
    expect(replicadGlb, 'Replicad GLB data').toBeDefined();

    const occtWorker = await createTestWorker(opencascadeKernel, {
      'cylinder.ts': `
import { BRepPrimAPI_MakeCylinder } from 'opencascade.js';
export default function main() {
  return new BRepPrimAPI_MakeCylinder(5, 20).Shape();
}`,
    });
    const occtResult = (await occtWorker.createGeometry({
      file: geometryFile,
      parameters: {},
    })) as CreateGeometryResult;
    assertSuccess(occtResult, 'occt createGeometry');
    const occtGlb = extractGltfFromResult(occtResult);
    expect(occtGlb, 'OCCT GLB data').toBeDefined();

    const replicadVertices = await extractAllVertexNormals(replicadGlb!);
    const occtVertices = await extractAllVertexNormals(occtGlb!);

    expect(replicadVertices.length).toBeGreaterThan(0);
    expect(occtVertices.length).toBeGreaterThan(0);

    // --- Normal parity check ---
    const replicadNormals = buildNormalMap(replicadVertices);
    const occtNormals = buildNormalMap(occtVertices);

    let normalMatched = 0;
    let normalMismatched = 0;
    let unmatched = 0;
    const mismatches: Array<{
      key: string;
      replicad: { nx: number; ny: number; nz: number };
      occt: { nx: number; ny: number; nz: number };
      dotProduct: number;
    }> = [];

    for (const [key, rNorm] of replicadNormals) {
      const oNorm = occtNormals.get(key);
      if (!oNorm) {
        unmatched++;
        continue;
      }

      const dot = rNorm.nx * oNorm.nx + rNorm.ny * oNorm.ny + rNorm.nz * oNorm.nz;
      if (dot >= 0.999) {
        normalMatched++;
      } else {
        normalMismatched++;
        if (mismatches.length < 20) {
          mismatches.push({ key, replicad: rNorm, occt: oNorm, dotProduct: dot });
        }
      }
    }

    const normalTotal = normalMatched + normalMismatched;
    const normalMatchRate = normalTotal > 0 ? normalMatched / normalTotal : 0;

    // --- Position precision check ---
    const fineKey = (x: number, y: number, z: number): string => {
      const scale = 100_000;
      return `${Math.round(x * scale)},${Math.round(y * scale)},${Math.round(z * scale)}`;
    };

    const replicadPositions = new Set(replicadVertices.map((v) => fineKey(v.px, v.py, v.pz)));
    const occtPositions = new Set(occtVertices.map((v) => fineKey(v.px, v.py, v.pz)));

    let exactMatches = 0;
    for (const key of replicadPositions) {
      if (occtPositions.has(key)) {
        exactMatches++;
      }
    }

    const posMatchPct = replicadPositions.size > 0 ? exactMatches / replicadPositions.size : 0;

    // Assertions
    expect(unmatched, 'All replicad positions should have OCCT counterparts').toBeLessThan(replicadNormals.size * 0.05);
    expect(normalMatchRate, `${normalMismatched}/${normalTotal} normals diverged (dot < 0.999)`).toBe(1);
    expect(posMatchPct, 'Position precision should match at 0.00001 resolution').toBeGreaterThanOrEqual(0.95);
  });

  it('should produce matching material properties for a colored cylinder', async () => {
    const testColor = '#1565C0';
    const geometryFile = createGeometryFile('colored-cylinder.ts');

    const replicadWorker = await createTestWorker(replicadKernel, {
      'colored-cylinder.ts': `
import { makeCylinder } from 'replicad';
export default function main() {
  return { shape: makeCylinder(5, 20), color: '${testColor}' };
}`,
    });
    const replicadResult = (await replicadWorker.createGeometry({
      file: geometryFile,
      parameters: {},
    })) as CreateGeometryResult;
    assertSuccess(replicadResult, 'replicad createGeometry (colored)');
    const replicadGlb = extractGltfFromResult(replicadResult);
    expect(replicadGlb, 'Replicad GLB data').toBeDefined();

    const occtWorker = await createTestWorker(opencascadeKernel, {
      'colored-cylinder.ts': `
import { BRepPrimAPI_MakeCylinder } from 'opencascade.js';
export default function main() {
  return { shape: new BRepPrimAPI_MakeCylinder(5, 20).Shape(), color: '${testColor}' };
}`,
    });
    const occtResult = (await occtWorker.createGeometry({
      file: geometryFile,
      parameters: {},
    })) as CreateGeometryResult;
    assertSuccess(occtResult, 'occt createGeometry (colored)');
    const occtGlb = extractGltfFromResult(occtResult);
    expect(occtGlb, 'OCCT GLB data').toBeDefined();

    const io = new NodeIO();
    const replicadDocument = await io.readBinary(replicadGlb!);
    const occtDocument = await io.readBinary(occtGlb!);

    const replicadMaterials = replicadDocument.getRoot().listMaterials();
    const occtMaterials = occtDocument.getRoot().listMaterials();

    expect(replicadMaterials.length, 'Replicad should have at least one material').toBeGreaterThan(0);
    expect(occtMaterials.length, 'OCCT should have at least one material').toBeGreaterThan(0);

    const rMat = replicadMaterials[0]!;
    const oMat = occtMaterials[0]!;

    const rBaseColor = rMat.getBaseColorFactor();
    const oBaseColor = oMat.getBaseColorFactor();
    const rMetallic = rMat.getMetallicFactor();
    const oMetallic = oMat.getMetallicFactor();
    const rRoughness = rMat.getRoughnessFactor();
    const oRoughness = oMat.getRoughnessFactor();

    const colorTolerance = 0.02;
    for (let i = 0; i < 4; i++) {
      expect(
        Math.abs(rBaseColor[i]! - oBaseColor[i]!),
        `baseColorFactor[${i}] differs: replicad=${rBaseColor[i]!.toFixed(4)}, occt=${oBaseColor[i]!.toFixed(4)}`,
      ).toBeLessThan(colorTolerance);
    }

    expect(rMetallic, 'metallicFactor should match').toBeCloseTo(oMetallic, 2);
    expect(rRoughness, 'roughnessFactor should match').toBeCloseTo(oRoughness, 2);
  });

  it('should produce matching PBR material properties for explicit metalness/roughness', async () => {
    const testColor = '#C0C0C0';
    const testMetallic = 0.9;
    const testRoughness = 0.2;
    const geometryFile = createGeometryFile('pbr-cylinder.ts');

    const replicadWorker = await createTestWorker(replicadKernel, {
      'pbr-cylinder.ts': `
import { makeCylinder } from 'replicad';
export default function main() {
  return { shape: makeCylinder(5, 20), color: '${testColor}', metalness: ${testMetallic}, roughness: ${testRoughness} };
}`,
    });
    const replicadResult = (await replicadWorker.createGeometry({
      file: geometryFile,
      parameters: {},
    })) as CreateGeometryResult;
    assertSuccess(replicadResult, 'replicad createGeometry (PBR)');
    const replicadGlb = extractGltfFromResult(replicadResult);
    expect(replicadGlb, 'Replicad GLB data').toBeDefined();

    const occtWorker = await createTestWorker(opencascadeKernel, {
      'pbr-cylinder.ts': `
import { BRepPrimAPI_MakeCylinder } from 'opencascade.js';
export default function main() {
  return { shape: new BRepPrimAPI_MakeCylinder(5, 20).Shape(), color: '${testColor}', metalness: ${testMetallic}, roughness: ${testRoughness} };
}`,
    });
    const occtResult = (await occtWorker.createGeometry({
      file: geometryFile,
      parameters: {},
    })) as CreateGeometryResult;
    assertSuccess(occtResult, 'occt createGeometry (PBR)');
    const occtGlb = extractGltfFromResult(occtResult);
    expect(occtGlb, 'OCCT GLB data').toBeDefined();

    const io = new NodeIO();
    const replicadDocument = await io.readBinary(replicadGlb!);
    const occtDocument = await io.readBinary(occtGlb!);

    const rMat = replicadDocument.getRoot().listMaterials()[0]!;
    const oMat = occtDocument.getRoot().listMaterials()[0]!;

    expect(rMat.getMetallicFactor(), 'Replicad metallicFactor').toBeCloseTo(testMetallic, 2);
    expect(rMat.getRoughnessFactor(), 'Replicad roughnessFactor').toBeCloseTo(testRoughness, 2);
    expect(oMat.getMetallicFactor(), 'OCCT metallicFactor').toBeCloseTo(testMetallic, 2);
    expect(oMat.getRoughnessFactor(), 'OCCT roughnessFactor').toBeCloseTo(testRoughness, 2);

    expect(rMat.getMetallicFactor(), 'Cross-kernel metallicFactor').toBeCloseTo(oMat.getMetallicFactor(), 2);
    expect(rMat.getRoughnessFactor(), 'Cross-kernel roughnessFactor').toBeCloseTo(oMat.getRoughnessFactor(), 2);
  });
});
