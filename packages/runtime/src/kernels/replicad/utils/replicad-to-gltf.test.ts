import { describe, it, expect } from 'vitest';
import { NodeIO } from '@gltf-transform/core';
import { convertReplicadGeometriesToGltf } from '#kernels/replicad/utils/replicad-to-gltf.js';
import type { GeometryReplicad } from '#kernels/replicad/replicad.types.js';

// =============================================================================
// Fixtures
// =============================================================================

function createSimpleGeometry(overrides: Partial<GeometryReplicad> = {}): GeometryReplicad {
  return {
    format: 'replicad',
    name: 'TestShape',
    faces: {
      vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      triangles: [0, 1, 2],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
      faceGroups: [],
    },
    edges: { lines: [], edgeGroups: [] },
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('convertReplicadGeometriesToGltf', () => {
  it('should convert empty geometries array to valid GLB', async () => {
    const result = convertReplicadGeometriesToGltf([], 'glb');

    expect(result).toBeInstanceOf(Uint8Array);
    const document = await new NodeIO().readBinary(result);
    expect(document.getRoot().listMeshes()).toHaveLength(0);
  });

  it('should produce a mesh with correct triangle count', async () => {
    const geometry = createSimpleGeometry({
      faces: {
        vertices: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
        triangles: [0, 1, 2, 0, 2, 3],
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
        faceGroups: [],
      },
    });

    const glb = convertReplicadGeometriesToGltf([geometry], 'glb');
    const document = await new NodeIO().readBinary(glb);
    const primitive = document.getRoot().listMeshes()[0]!.listPrimitives()[0]!;

    expect(primitive.getIndices()!.getCount()).toBe(6);
    expect(primitive.getAttribute('POSITION')!.getCount()).toBe(4);
    expect(primitive.getAttribute('NORMAL')!.getCount()).toBe(4);
  });

  it('should set node name from geometry name', async () => {
    const geometry = createSimpleGeometry({ name: 'MyCube' });
    const glb = convertReplicadGeometriesToGltf([geometry], 'glb');
    const document = await new NodeIO().readBinary(glb);

    expect(document.getRoot().listNodes()[0]!.getName()).toBe('MyCube');
  });

  it('should apply red color to material baseColorFactor', async () => {
    const geometry = createSimpleGeometry({ color: '#ff0000', opacity: 1 });
    const glb = convertReplicadGeometriesToGltf([geometry], 'glb');
    const document = await new NodeIO().readBinary(glb);
    const material = document.getRoot().listMaterials()[0]!;

    const color = material.getBaseColorFactor();
    expect(color[0]).toBeCloseTo(1, 2);
    expect(color[1]).toBeCloseTo(0, 2);
    expect(color[2]).toBeCloseTo(0, 2);
    expect(color[3]).toBeCloseTo(1, 2);
    expect(material.getAlphaMode()).toBe('OPAQUE');
  });

  it('should set BLEND alphaMode for semi-transparent geometry', async () => {
    const geometry = createSimpleGeometry({ color: '#ff0000', opacity: 0.5 });
    const glb = convertReplicadGeometriesToGltf([geometry], 'glb');
    const document = await new NodeIO().readBinary(glb);
    const material = document.getRoot().listMaterials()[0]!;

    expect(material.getAlphaMode()).toBe('BLEND');
    expect(material.getBaseColorFactor()[3]).toBeCloseTo(0.5);
  });

  it('should produce separate nodes for multiple geometries', async () => {
    const red = createSimpleGeometry({ name: 'Red', color: '#ff0000' });
    const blue = createSimpleGeometry({ name: 'Blue', color: '#0000ff' });

    const glb = convertReplicadGeometriesToGltf([red, blue], 'glb');
    const document = await new NodeIO().readBinary(glb);

    expect(document.getRoot().listNodes()).toHaveLength(2);
    expect(document.getRoot().listMaterials()).toHaveLength(2);
    expect(document.getRoot().listNodes()[0]!.getName()).toBe('Red');
    expect(document.getRoot().listNodes()[1]!.getName()).toBe('Blue');
  });

  it('should include edge line primitives when edges are provided', async () => {
    const geometry = createSimpleGeometry({
      edges: {
        lines: [0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0],
        edgeGroups: [
          { start: 0, count: 6, edgeId: 1 },
          { start: 6, count: 6, edgeId: 2 },
        ],
      },
    });

    const glb = convertReplicadGeometriesToGltf([geometry], 'glb');
    const document = await new NodeIO().readBinary(glb);
    const primitives = document.getRoot().listMeshes()[0]!.listPrimitives();

    expect(primitives).toHaveLength(2);
    expect(primitives[0]!.getMode()).toBe(4);
    expect(primitives[1]!.getMode()).toBe(1);
  });

  it('should produce valid glTF JSON output with base64 buffer', () => {
    const geometry = createSimpleGeometry();
    const gltfBytes = convertReplicadGeometriesToGltf([geometry], 'gltf');

    const json = JSON.parse(new TextDecoder().decode(gltfBytes)) as {
      asset: { version: string; generator: string };
      meshes: unknown[];
      buffers: Array<{ uri: string }>;
    };

    expect(json.asset.version).toBe('2.0');
    expect(json.asset.generator).toMatch(/^@taucad\/runtime@\d+\.\d+\.\d+/);
    expect(json.meshes).toHaveLength(1);
    expect(json.buffers[0]!.uri).toMatch(/^data:application\/octet-stream;base64,/);
  });

  it('should transform coordinates from z-up to y-up and mm to meters', async () => {
    const geometry = createSimpleGeometry({
      faces: {
        vertices: [1000, 2000, 3000, 0, 0, 0, 1000, 0, 0],
        triangles: [0, 1, 2],
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
        faceGroups: [],
      },
    });

    const glb = convertReplicadGeometriesToGltf([geometry], 'glb');
    const document = await new NodeIO().readBinary(glb);
    const positions = document.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute('POSITION')!;

    const vertex0 = positions.getElement(0, [0, 0, 0]);
    expect(vertex0[0]).toBeCloseTo(1, 4);
    expect(vertex0[1]).toBeCloseTo(3, 4);
    expect(vertex0[2]).toBeCloseTo(-2, 4);
  });

  it('should apply default gray color when no color is specified', async () => {
    const geometry = createSimpleGeometry();
    const glb = convertReplicadGeometriesToGltf([geometry], 'glb');
    const document = await new NodeIO().readBinary(glb);
    const material = document.getRoot().listMaterials()[0]!;

    const color = material.getBaseColorFactor();
    expect(color[0]).toBeCloseTo(0.7);
    expect(color[1]).toBeCloseTo(0.7);
    expect(color[2]).toBeCloseTo(0.7);
    expect(color[3]).toBeCloseTo(1);
  });

  it('should use provided metalness/roughness values when set', async () => {
    const geometry = createSimpleGeometry({ metalness: 0.9, roughness: 0.2 });
    const glb = convertReplicadGeometriesToGltf([geometry], 'glb');
    const document = await new NodeIO().readBinary(glb);
    const material = document.getRoot().listMaterials()[0]!;

    expect(material.getMetallicFactor()).toBeCloseTo(0.9, 2);
    expect(material.getRoughnessFactor()).toBeCloseTo(0.2, 2);
  });

  it('should fall back to cadMaterialDefaults when metalness/roughness are not set', async () => {
    const geometry = createSimpleGeometry();
    const glb = convertReplicadGeometriesToGltf([geometry], 'glb');
    const document = await new NodeIO().readBinary(glb);
    const material = document.getRoot().listMaterials()[0]!;

    expect(material.getMetallicFactor()).toBeCloseTo(0, 2);
    expect(material.getRoughnessFactor()).toBeCloseTo(0.35, 2);
  });
});
