import { describe, expect, it } from 'vitest';
import { parseClassicOff } from '#runtime/classic/mesh.js';
import type { ClassicMesh } from '#runtime/classic/mesh.js';
import { classicMeshToThreeMf } from '#runtime/classic/three-mf.js';
import { readThreeMfFixture } from '#runtime/classic/testing/three-mf.fixture.js';

const tetrahedron = (): ClassicMesh =>
  parseClassicOff(`OFF 4 4 0
100.0625 -100.1875 2.123456789
110.0625 -100.1875 2.123456789
100.0625 -80.1875 2.123456789
100.0625 -100.1875 32.123456789
3 0 2 1 249 215 44 255
3 0 1 3 157 203 81 255
3 0 3 2 255 0 0 127
3 1 2 3 0 0 255 127
`);

const reverseFaces = (mesh: ClassicMesh): ClassicMesh => ({
  ...mesh,
  triangles: mesh.triangles.map((triangle) => ({
    ...triangle,
    indices: [triangle.indices[0], triangle.indices[2], triangle.indices[1]],
  })),
});

const twoOwners = (): ClassicMesh => {
  const first = tetrahedron();
  const second = first.vertices.map(([x, y, z]): ClassicMesh['vertices'][number] => [x + 50, y, z]);
  const secondFaces = first.triangles.map((triangle): ClassicMesh['triangles'][number] => ({
    ...triangle,
    indices: [triangle.indices[0] + 4, triangle.indices[1] + 4, triangle.indices[2] + 4],
  }));
  return { vertices: [...first.vertices, ...second], triangles: [...secondFaces, ...first.triangles] };
};

describe('classic native-mesh 3MF', () => {
  it('should retain exact Float64 vertices, oriented faces and per-face sRGB alpha in a standard package', () => {
    const source = tetrahedron();
    const snapshot = structuredClone(source);
    const bytes = classicMeshToThreeMf(source);
    const result = readThreeMfFixture(bytes);
    expect(result.entries).toEqual(['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']);
    expect(result.namespace).toBe('http://schemas.microsoft.com/3dmanufacturing/core/2015/02');
    expect(result.unit).toBe('millimeter');
    expect(result.modelTarget).toBe('/3D/3dmodel.model');
    expect(result.modelRelationship).toBe('http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel');
    expect(result.contentTypes).toEqual({
      rels: 'application/vnd.openxmlformats-package.relationships+xml',
      model: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
    });
    expect(result.colors).toEqual(['#F9D72CFF', '#9DCB51FF', '#FF00007F', '#0000FF7F']);
    expect(result.paletteId).toBe(1);
    expect(result.build).toEqual([2]);
    expect(result.objects).toEqual([
      {
        id: 2,
        name: 'Shape 1',
        type: 'model',
        vertices: source.vertices,
        triangles: source.triangles.map(({ indices }, material) => ({ indices, material, palette: 1 })),
      },
    ]);
    expect(source).toEqual(snapshot);
    expect(bytes.byteOffset).toBe(0);
    expect(bytes.byteLength).toBe(bytes.buffer.byteLength);
    expect(classicMeshToThreeMf(source)).toEqual(bytes);
  });

  it('should keep the existing first-face owner order and every original local incidence without merging bodies', () => {
    const source = twoOwners();
    const result = readThreeMfFixture(classicMeshToThreeMf(source));
    expect(result.objects.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 2, name: 'Shape 1' },
      { id: 3, name: 'Shape 2' },
    ]);
    expect(result.build).toEqual([2, 3]);
    expect(result.objects[0]?.vertices).toEqual(source.vertices.slice(4));
    expect(result.objects[1]?.vertices).toEqual(source.vertices.slice(0, 4));
    expect(result.objects.map(({ triangles }) => triangles.map(({ indices }) => indices))).toEqual([
      tetrahedron().triangles.map(({ indices }) => indices),
      tetrahedron().triangles.map(({ indices }) => indices),
    ]);
  });

  it('should preserve tiny native edges and every face even when Float32 would collapse their endpoints', () => {
    const source = tetrahedron();
    const precise: ClassicMesh = {
      ...source,
      vertices: [
        [10, 20, 30],
        [10.000000001, 20, 30],
        [10, 40, 30],
        [10, 20, 60],
      ],
    };
    expect(Math.fround(precise.vertices[0]?.[0] ?? 0)).toBe(Math.fround(precise.vertices[1]?.[0] ?? 0));
    const result = readThreeMfFixture(classicMeshToThreeMf(precise));
    expect(result.objects[0]?.vertices).toEqual(precise.vertices);
    expect(result.objects[0]?.triangles.map(({ indices }) => indices)).toEqual(
      precise.triangles.map(({ indices }) => indices),
    );
    expect(result.objects[0]?.vertices[0]).not.toEqual(result.objects[0]?.vertices[1]);
  });

  it('should preserve signed zero and exponent-form coordinates without decimal truncation', () => {
    const source: ClassicMesh = {
      ...tetrahedron(),
      vertices: [
        [-0, 0, 1e-7],
        [10, 0, 1e-7],
        [-0, 20, 1e-7],
        [-0, 0, 30],
      ],
    };
    const result = readThreeMfFixture(classicMeshToThreeMf(source));
    expect(result.objects[0]?.vertices).toEqual(source.vertices);
    expect(Object.is(result.objects[0]?.vertices[0]?.[0], -0)).toBe(true);
  });

  it.each([
    { name: 'empty mesh', mesh: (): ClassicMesh => ({ vertices: [], triangles: [] }), message: 'empty' },
    {
      name: 'open surface',
      mesh: (): ClassicMesh => ({ ...tetrahedron(), triangles: tetrahedron().triangles.slice(0, 3) }),
      message: 'closed, consistently oriented',
    },
    {
      name: 'inconsistent winding',
      mesh: (): ClassicMesh => ({
        ...tetrahedron(),
        triangles: [reverseFaces(tetrahedron()).triangles[0]!, ...tetrahedron().triangles.slice(1)],
      }),
      message: 'closed, consistently oriented',
    },
    { name: 'inward owner', mesh: (): ClassicMesh => reverseFaces(tetrahedron()), message: 'positive native volume' },
    {
      name: 'nonfinite coordinate',
      mesh: (): ClassicMesh => ({
        ...tetrahedron(),
        vertices: [[Number.NaN, 0, 0], ...tetrahedron().vertices.slice(1)],
      }),
      message: 'must be finite',
    },
    {
      name: 'invalid vertex reference',
      mesh: (): ClassicMesh => ({
        ...tetrahedron(),
        triangles: tetrahedron().triangles.map((triangle) => ({
          ...triangle,
          indices: [-1, triangle.indices[1], triangle.indices[2]],
        })),
      }),
      message: 'invalid native vertex index',
    },
    {
      name: 'coincident distinct vertex IDs',
      mesh: (): ClassicMesh => ({
        ...tetrahedron(),
        vertices: [
          [0, 0, 0],
          [0, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
      }),
      message: 'nonzero area',
    },
    {
      name: 'unowned vertex',
      mesh: (): ClassicMesh => ({ ...tetrahedron(), vertices: [...tetrahedron().vertices, [1, 2, 3]] }),
      message: 'no surface owner',
    },
    {
      name: 'unrepresentable RGBA',
      mesh: (): ClassicMesh => ({
        ...tetrahedron(),
        triangles: tetrahedron().triangles.map((triangle) => ({ ...triangle, color: [0.5, 0, 0, 1] })),
      }),
      message: 'exact sRGB RGBA byte tuple',
    },
    {
      name: 'extra coincident face',
      mesh: (): ClassicMesh => ({
        ...tetrahedron(),
        triangles: [...tetrahedron().triangles, tetrahedron().triangles[0]!],
      }),
      message: 'closed, consistently oriented',
    },
  ])('should reject $name without repairing the source', ({ mesh, message }) => {
    const source = mesh();
    const snapshot = structuredClone(source);
    expect(() => classicMeshToThreeMf(source)).toThrow(RangeError);
    expect(() => classicMeshToThreeMf(source)).toThrow(message);
    expect(source).toEqual(snapshot);
  });

  it('should reject a vertex-pinched pair even when every native edge has two opposite faces', () => {
    const source = parseClassicOff(`OFF 7 8 0
0 0 0
10 0 0
0 20 0
0 0 30
-10 0 0
0 -20 0
0 0 -30
3 0 2 1
3 0 1 3
3 0 3 2
3 1 2 3
3 0 5 4
3 0 4 6
3 0 6 5
3 4 5 6
`);
    expect(() => classicMeshToThreeMf(source)).toThrow('closed, consistently oriented');
  });

  it('should reject an inward cavity owner instead of filling, flipping, or silently regrouping it', () => {
    const outer = tetrahedron();
    const cavity = reverseFaces(outer);
    const reference = outer.vertices[0]!;
    const inner = outer.vertices.map((point): ClassicMesh['vertices'][number] => [
      reference[0] + (point[0] - reference[0]) * 0.1 + 1,
      reference[1] + (point[1] - reference[1]) * 0.1 + 1,
      reference[2] + (point[2] - reference[2]) * 0.1 + 1,
    ]);
    const source: ClassicMesh = {
      vertices: [...outer.vertices, ...inner],
      triangles: [
        ...outer.triangles,
        ...cavity.triangles.map((triangle): ClassicMesh['triangles'][number] => ({
          ...triangle,
          indices: [triangle.indices[0] + 4, triangle.indices[1] + 4, triangle.indices[2] + 4],
        })),
      ],
    };
    expect(() => classicMeshToThreeMf(source)).toThrow('Shape 2 must have finite positive native volume');
  });
});
