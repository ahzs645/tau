import { NodeIO } from '@gltf-transform/core';
import { allExtensions } from '@taucad/geometry-core';
import { describe, expect, it } from 'vitest';
import { classicMeshToGlb, parseClassicOff } from '#runtime/classic/mesh.js';

const coloredTetrahedron = `OFF 4 4 0
0 0 0
10 0 0
0 20 0
0 0 30
3 0 2 1 255 0 0
3 0 1 3 255 0 0
3 0 3 2 0 255 0
3 1 2 3 0 255 0
`;
// These distinct serialized points reproduce the measured rack triangle's float32 cross-product cancellation.
const cancellationTetrahedron = `OFF 4 4 0
-6.850899662822485 55.204372853040695 14.700000174343586
-7.310080341994762 56.4151294529438 14.700000174343586
-7.512315642088652 56.948378682136536 14.700000174343586
-6.850899662822485 55.204372853040695 15.700000174343586
3 0 2 1 255 0 0
3 0 1 3 255 0 0
3 0 3 2 0 255 0
3 1 2 3 0 255 0
`;
const io = (): NodeIO => new NodeIO().registerExtensions(allExtensions);

describe('classic OFF canonical topology provenance', () => {
  it('should preserve a closed colored body as one canonical surface without losing render seams', async () => {
    const source = parseClassicOff(coloredTetrahedron);
    const bytes = classicMeshToGlb(source);
    const { json } = await io().binaryToJSON(bytes);
    const mesh = json.meshes?.[0];
    const primitives = mesh?.primitives ?? [];
    expect(json.nodes).toHaveLength(1);
    expect(primitives).toHaveLength(2);
    const positions = primitives[0]?.attributes['POSITION'];
    const normals = primitives[0]?.attributes['NORMAL'];
    expect(primitives[1]?.attributes['POSITION']).toBe(positions);
    expect(primitives[1]?.attributes['NORMAL']).toBe(normals);
    expect(mesh?.extensions?.['EXT_mesh_manifold']).toMatchObject({
      manifoldPrimitive: { attributes: { POSITION: positions }, mode: 4 },
    });
    const document = await io().readBinary(bytes);
    const surfaces = document.getRoot().listMeshes()[0]?.listPrimitives() ?? [];
    expect(surfaces.map((surface) => surface.getIndices()?.getCount())).toEqual([6, 6]);
    expect(surfaces.map((surface) => surface.getMaterial()?.getBaseColorFactor())).toEqual([
      [1, 0, 0, 1],
      [0, 1, 0, 1],
    ]);
    expect(surfaces[0]?.getAttribute('NORMAL')?.getCount()).toBe(12);
    expect(source).toEqual(parseClassicOff(coloredTetrahedron));
    expect(json.extensionsUsed ?? []).not.toContain('TAU_cad_topology');
  });

  it.each([
    {
      name: 'open surface',
      source: coloredTetrahedron.replace('OFF 4 4 0', 'OFF 4 3 0').replace('3 1 2 3 0 255 0\n', ''),
    },
    {
      name: 'inconsistent winding',
      source: coloredTetrahedron.replace('3 0 2 1 255 0 0', '3 0 1 2 255 0 0'),
    },
    {
      name: 'Float32 position collapse',
      source: coloredTetrahedron
        .replace('\n0 0 0\n', '\n1000000000000 0 0\n')
        .replace('\n10 0 0\n', '\n1000000000010 0 0\n')
        .replace('\n0 20 0\n', '\n1000000000000 20 0\n')
        .replace('\n0 0 30\n', '\n1000000000000 0 30\n'),
    },
    {
      name: 'disconnected vertex link',
      source: `OFF 7 8 0
0 0 0
10 0 0
0 20 0
0 0 30
-10 0 0
0 -20 0
0 0 -30
3 0 2 1 255 0 0
3 0 1 3 255 0 0
3 0 3 2 0 255 0
3 1 2 3 0 255 0
3 0 5 4 255 0 0
3 0 4 6 255 0 0
3 0 6 5 0 255 0
3 4 5 6 0 255 0
`,
    },
  ])('should make no canonical claim for $name', async ({ source }) => {
    const bytes = classicMeshToGlb(parseClassicOff(source));
    const { json } = await io().binaryToJSON(bytes);
    expect(json.extensionsUsed ?? []).not.toContain('EXT_mesh_manifold');
    expect(json.meshes).toHaveLength(1);
    expect(json.meshes?.[0]?.primitives).toHaveLength(2);
  });

  it('should withhold canonical metadata when distinct Float32 points cancel to zero cross-product area', async () => {
    const source = parseClassicOff(cancellationTetrahedron);
    const bytes = classicMeshToGlb(source);
    const document = await io().readBinary(bytes);
    const positions = document.getRoot().listMeshes()[0]?.listPrimitives()[0]?.getAttribute('POSITION');
    const corners = [0, 1, 2].map((index) => positions?.getElement(index, []) ?? []);
    expect(new Set(corners.map((point) => point.join(','))).size).toBe(3);
    const { json } = await io().binaryToJSON(bytes);
    expect(json.extensionsUsed ?? []).not.toContain('EXT_mesh_manifold');
  });

  it('should keep owner-local overlay lines outside canonical surface metadata', async () => {
    const bytes = classicMeshToGlb(parseClassicOff(coloredTetrahedron), { includeEdges: true });
    const { json } = await io().binaryToJSON(bytes);
    expect(json.nodes).toHaveLength(1);
    expect(json.meshes?.[0]?.primitives.map(({ mode }) => mode)).toEqual([4, 4, 1]);
    expect(json.extensionsUsed ?? []).not.toContain('EXT_mesh_manifold');
  });
});
