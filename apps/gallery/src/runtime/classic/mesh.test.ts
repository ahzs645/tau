import { NodeIO } from '@gltf-transform/core';
import type { Document, Primitive } from '@gltf-transform/core';
import { allExtensions } from '@taucad/geometry-core';
import { describe, expect, it } from 'vitest';
import { classicMeshToGlb, parseClassicOff } from '#runtime/classic/mesh.js';

const translatedTriangle = `OFF 3 1 0
10 20 30
16 20 30
10 25 39
3 0 1 2
`;
const coloredSquare = `OFF
# Native byte RGBA and explicit normalized RGBA may coexist across faces.
4 2 0
0 0 0
10 0 0
10 20 0
0 20 0
3 0 1 2 255 128 0 128
3 0 2 3 0.5 0.25 0.0 0.75
`;
const io = (): NodeIO => new NodeIO().registerExtensions(allExtensions);
const firstSurface = (document: Document): Primitive => {
  const primitive = document
    .getRoot()
    .listMeshes()[0]
    ?.listPrimitives()
    .find((candidate) => candidate.getMode() === 4);
  if (!primitive) {
    throw new Error('Expected a decoded triangle surface.');
  }
  return primitive;
};

describe('classic OFF parsing', () => {
  it('should support both header layouts and preserve native coordinates and per-face color', () => {
    const inline = parseClassicOff(translatedTriangle);
    const separate = parseClassicOff(translatedTriangle.replace('OFF 3 1 0', 'OFF\n3 1 0'));
    expect(inline).toEqual(separate);
    expect(inline.vertices).toEqual([
      [10, 20, 30],
      [16, 20, 30],
      [10, 25, 39],
    ]);
    expect(inline.triangles).toEqual([{ indices: [0, 1, 2], color: [1, 1, 1, 1] }]);
    expect(parseClassicOff(coloredSquare).triangles.map((triangle) => triangle.color)).toEqual([
      [1, 128 / 255, 0, 128 / 255],
      [0.5, 0.25, 0, 0.75],
    ]);
  });

  it('should preserve the legacy byte interpretation of ambiguous integer colors', () => {
    const withColor = (color: string) =>
      parseClassicOff(translatedTriangle.replace('3 0 1 2', `3 0 1 2 ${color}`)).triangles[0]?.color;
    expect(withColor('1 0 0 1')).toEqual([1 / 255, 0, 0, 1 / 255]);
    expect(withColor('1.0 0.0 0.0 1.0')).toEqual([1, 0, 0, 1]);
    expect(withColor('255 0 128')).toEqual([1, 0, 128 / 255, 1]);
  });

  it('should fan-triangulate a convex planar face while retaining its winding and color', () => {
    const mesh = parseClassicOff(`OFF 4 1 0
0 0 2
10 0 2
10 20 2
0 20 2
4 0 1 2 3 0 255 0
`);
    expect(mesh.triangles).toEqual([
      { indices: [0, 1, 2], color: [0, 1, 0, 1] },
      { indices: [0, 2, 3], color: [0, 1, 0, 1] },
    ]);
  });

  it.each([
    { name: 'missing header', text: translatedTriangle.replace('OFF ', ''), error: 'header' },
    { name: 'negative counts', text: translatedTriangle.replace('3 1 0', '-3 1 0'), error: 'nonnegative' },
    { name: 'truncated records', text: translatedTriangle.replace('3 0 1 2\n', ''), error: 'declared counts' },
    { name: 'trailing records', text: `${translatedTriangle}0 0 0\n`, error: 'declared counts' },
    { name: 'nonfinite positions', text: translatedTriangle.replace('10 20 30', 'Infinity 20 30'), error: 'finite' },
    { name: 'missing vertex', text: translatedTriangle.replace('3 0 1 2', '3 0 1 3'), error: 'indices' },
    { name: 'repeated vertex', text: translatedTriangle.replace('3 0 1 2', '3 0 0 2'), error: 'indices' },
    { name: 'partial color', text: translatedTriangle.replace('3 0 1 2', '3 0 1 2 255 0'), error: 'RGB or RGBA' },
    { name: 'invalid color', text: translatedTriangle.replace('3 0 1 2', '3 0 1 2 256 0 0'), error: 'face color' },
    {
      name: 'mixed color scales',
      text: translatedTriangle.replace('3 0 1 2', '3 0 1 2 0.5 128 0'),
      error: 'face color',
    },
    { name: 'zero area', text: 'OFF 3 1 0\n0 0 0\n1 1 1\n2 2 2\n3 0 1 2', error: 'nonzero area' },
    { name: 'nonplanar polygon', text: 'OFF 4 1 0\n0 0 0\n2 0 0\n2 2 0\n0 2 1\n4 0 1 2 3', error: 'planar' },
    { name: 'concave polygon', text: 'OFF 5 1 0\n0 0 0\n2 0 0\n1 0.5 0\n2 2 0\n0 2 0\n5 0 1 2 3 4', error: 'convex' },
  ])('should reject $name without silently repairing output', ({ text, error }) => {
    expect(() => parseClassicOff(text)).toThrow(error);
  });
});

describe('classic OFF GLB mapping', () => {
  it.each([
    {
      coordinateSystem: 'y-up',
      unit: 'meter',
      positions: [
        [0.01, 0.03, -0.02],
        [0.016, 0.03, -0.02],
        [0.01, 0.039, -0.025],
      ],
      normal: [0, 5 / Math.sqrt(106), 9 / Math.sqrt(106)],
    },
    {
      coordinateSystem: 'y-up',
      unit: 'millimeter',
      positions: [
        [10, 30, -20],
        [16, 30, -20],
        [10, 39, -25],
      ],
      normal: [0, 5 / Math.sqrt(106), 9 / Math.sqrt(106)],
    },
    {
      coordinateSystem: 'z-up',
      unit: 'meter',
      positions: [
        [0.01, 0.02, 0.03],
        [0.016, 0.02, 0.03],
        [0.01, 0.025, 0.039],
      ],
      normal: [0, -9 / Math.sqrt(106), 5 / Math.sqrt(106)],
    },
    {
      coordinateSystem: 'z-up',
      unit: 'millimeter',
      positions: [
        [10, 20, 30],
        [16, 20, 30],
        [10, 25, 39],
      ],
      normal: [0, -9 / Math.sqrt(106), 5 / Math.sqrt(106)],
    },
  ] as const)(
    'should map positions and normals exactly once for $coordinateSystem/$unit',
    async ({ coordinateSystem, unit, positions, normal }) => {
      const source = parseClassicOff(translatedTriangle);
      const bytes = classicMeshToGlb(source, { coordinateSystem, unit });
      const document = await io().readBinary(bytes);
      const surface = firstSurface(document);
      expect(bytes.byteOffset).toBe(0);
      expect(bytes.byteLength).toBe(bytes.buffer.byteLength);
      expect(surface.getAttribute('POSITION')?.getCount()).toBe(3);
      expect(surface.getAttribute('NORMAL')?.getCount()).toBe(3);
      for (const [index, point] of positions.entries()) {
        const actual = surface.getAttribute('POSITION')?.getElement(index, []) ?? [];
        const actualNormal = surface.getAttribute('NORMAL')?.getElement(index, []) ?? [];
        for (const axis of [0, 1, 2] as const) {
          expect(actual[axis]).toBeCloseTo(point[axis], 6);
          expect(actualNormal[axis]).toBeCloseTo(normal[axis], 6);
        }
      }
      expect(source).toEqual(parseClassicOff(translatedTriangle));
    },
  );

  it('should default to canonical Y-up metres without adding a second node transform', async () => {
    const bytes = classicMeshToGlb(parseClassicOff(translatedTriangle));
    const document = await io().readBinary(bytes);
    expect(firstSurface(document).getAttribute('POSITION')?.getElement(0, [])).toEqual([
      expect.closeTo(0.01, 7),
      expect.closeTo(0.03, 7),
      expect.closeTo(-0.02, 7),
    ]);
    expect(document.getRoot().listNodes()[0]?.getMatrix()).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it('should encode face colors in linear RGB while preserving alpha and leaving materials unnamed', async () => {
    const document = await io().readBinary(classicMeshToGlb(parseClassicOff(coloredSquare)));
    const surfaces = document.getRoot().listMeshes()[0]?.listPrimitives() ?? [];
    expect(
      document
        .getRoot()
        .listNodes()
        .map((node) => node.getName()),
    ).toEqual(['Shape 1']);
    expect(surfaces).toHaveLength(2);
    expect(surfaces[0]?.getMaterial()?.getBaseColorFactor()).toEqual([
      1,
      expect.closeTo(0.2158605001, 8),
      0,
      128 / 255,
    ]);
    expect(surfaces[1]?.getMaterial()?.getBaseColorFactor()).toEqual([
      expect.closeTo(0.2140411405, 8),
      expect.closeTo(0.0508760882, 8),
      0,
      0.75,
    ]);
    for (const surface of surfaces) {
      expect(surface.getMaterial()?.getAlphaMode()).toBe('BLEND');
      expect(surface.getMaterial()?.getName()).toBe('');
      expect(surface.getMaterial()?.getMetallicFactor()).toBe(0);
      expect(surface.getMaterial()?.getRoughnessFactor()).toBe(0.35);
    }
  });

  it('should keep coincident but index-disconnected bodies separate without inventing topology ownership', async () => {
    const bytes = classicMeshToGlb(
      parseClassicOff(`OFF 6 2 0
0 0 0
10 0 0
0 20 0
0 0 0
10 0 0
0 20 0
3 0 1 2 255 0 0
3 3 4 5 0 0 255
`),
      { includeEdges: true },
    );
    const document = await io().readBinary(bytes);
    expect(
      document
        .getRoot()
        .listNodes()
        .map((node) => node.getName()),
    ).toEqual(['Shape 1', 'Shape 2']);
    expect(
      document
        .getRoot()
        .listMeshes()
        .map((mesh) => mesh.getName()),
    ).toEqual(['Shape 1', 'Shape 2']);
    for (const mesh of document.getRoot().listMeshes()) {
      expect(mesh.listPrimitives().map((primitive) => primitive.getMode())).toEqual([4, 1]);
      expect(mesh.listPrimitives()[1]?.getAttribute('POSITION')?.getCount()).toBe(6);
    }
    const { json } = await io().binaryToJSON(bytes);
    expect(json.extensionsUsed ?? []).not.toContain('EXT_mesh_manifold');
    expect(json.extensionsUsed ?? []).not.toContain('TAU_cad_topology');
  });

  it('should emit only owner-local boundary and feature edges, with the shared unlit overlay material', async () => {
    const mesh = parseClassicOff(coloredSquare);
    const bytes = classicMeshToGlb(mesh, { includeEdges: true });
    const document = await io().readBinary(bytes);
    const lines = document
      .getRoot()
      .listMeshes()[0]
      ?.listPrimitives()
      .find((primitive) => primitive.getMode() === 1);
    // Four perimeter edges: neither the color seam nor the coplanar triangulation diagonal creates an edge.
    expect(lines?.getAttribute('POSITION')?.getCount()).toBe(8);
    expect(lines?.getMaterial()?.getBaseColorFactor()).toEqual([0, 0, 0, 1]);
    expect(lines?.getMaterial()?.getMetallicFactor()).toBe(0);
    expect(lines?.getMaterial()?.getRoughnessFactor()).toBe(1);
    expect(lines?.getMaterial()?.getAlphaMode()).toBe('OPAQUE');
    expect(lines?.getMaterial()?.getName()).toBe('');
    const { json } = await io().binaryToJSON(bytes);
    expect(json.extensionsUsed).toContain('KHR_materials_unlit');
    expect(json.extensionsRequired ?? []).not.toContain('KHR_materials_unlit');
    const withoutEdges = await io().readBinary(classicMeshToGlb(mesh, { includeEdges: false }));
    expect(
      withoutEdges
        .getRoot()
        .listMeshes()[0]
        ?.listPrimitives()
        .map((primitive) => primitive.getMode()),
    ).toEqual([4, 4]);
  });

  it('should preserve sharp flat normals across a shared edge without changing triangle winding', async () => {
    const document = await io().readBinary(
      classicMeshToGlb(
        parseClassicOff(`OFF 4 2 0
0 0 0
10 0 0
0 20 0
0 0 30
3 0 1 2
3 1 0 3
`),
      ),
    );
    const surface = firstSurface(document);
    const normals = surface.getAttribute('NORMAL');
    expect(normals?.getCount()).toBe(6);
    for (const index of [0, 1, 2]) {
      expect(normals?.getElement(index, [])).toEqual([0, 1, 0]);
      expect(normals?.getElement(index + 3, [])).toEqual([0, 0, -1]);
    }
  });

  it('should preserve an explicitly empty result without manufacturing a fallback mesh', async () => {
    const document = await io().readBinary(classicMeshToGlb(parseClassicOff('OFF\n0 0 0\n')));
    expect(document.getRoot().listNodes()).toHaveLength(0);
    expect(document.getRoot().listMeshes()).toHaveLength(0);
  });
});
