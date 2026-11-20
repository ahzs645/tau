import { describe, expect, it } from 'vitest';
import { restoreClassicOffPrecision } from '#runtime/classic/precision.js';
import { classicMeshToGlb, parseClassicOff } from '#runtime/classic/mesh.js';

type Point = readonly [number, number, number];
type Face = readonly number[];

const at = <Item>(items: readonly Item[], index: number): Item => {
  const item = items[index];
  if (item === undefined) {
    throw new RangeError('Incomplete precision fixture.');
  }
  return item;
};

const offFile = (vertices: readonly Point[], faces: readonly Face[]): string =>
  [
    `OFF ${vertices.length} ${faces.length} 0`,
    ...vertices.map((vertex) => vertex.map((value) => Number(value.toPrecision(6))).join(' ')),
    ...faces.map(
      (face, index) => `${face.length} ${face.join(' ')} ${index % 2 === 0 ? '255 0 0 255' : '0 255 0 127'}`,
    ),
  ].join('\n');

const asciiFile = (vertices: readonly Point[], faces: readonly Face[]): string => {
  const facets = faces.map((face) => {
    const [a, b, c] = face.map((index) => at(vertices, index));
    if (!a || !b || !c || face.length !== 3) {
      throw new RangeError('STL fixture requires three corners.');
    }
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const normal = [
      at(u, 1) * at(v, 2) - at(u, 2) * at(v, 1),
      at(u, 2) * at(v, 0) - at(u, 0) * at(v, 2),
      at(u, 0) * at(v, 1) - at(u, 1) * at(v, 0),
    ];
    const length = Math.hypot(...normal);
    return [
      `facet normal ${normal.map((value) => value / length).join(' ')}`,
      'outer loop',
      ...[a, b, c].map((vertex) => `vertex ${vertex.join(' ')}`),
      'endloop',
      'endfacet',
    ].join('\n');
  });
  return ['solid fixture', ...facets, 'endsolid fixture'].join('\n');
};

// First collapsed keyguard edge, recovered from the same-evaluation native ASCII STL.
const preciseVertices: readonly Point[] = [
  [-96.17997282862663, -72.34180319476127, 1.298],
  [-96.17997282559323, -72.34180319172788, 1.298],
  [-96.29246849685907, -72.0487419681549, 1.298],
  [-96.1, -72.1, 2.298],
];
const tetrahedron: readonly Face[] = [
  [0, 2, 1],
  [0, 1, 3],
  [1, 2, 3],
  [2, 0, 3],
];

describe('paired native OFF/ASCII STL precision', () => {
  it('should recover native halfway coordinates using the observed C++ rounding rather than JS rounding', () => {
    const vertices: readonly Point[] = [
      [100.0625, 0, 0],
      [-100.1875, 2.123456789, 0],
      [0, 0, 3],
    ];
    const off = 'OFF 3 1 0\n100.062 0 0\n-100.188 2.12346 0\n0 0 3\n3 0 1 2 255 0 0 255';
    const restored = restoreClassicOffPrecision(off, asciiFile(vertices, [[0, 1, 2]]));
    expect(parseClassicOff(restored).vertices).toEqual(vertices);
    expect(restored.trim().split('\n').at(-1)).toBe('3 0 1 2 255 0 0 255');
    expect(() =>
      restoreClassicOffPrecision(off.replace('100.062 ', '100.063 '), asciiFile(vertices, [[0, 1, 2]])),
    ).toThrow('inconsistent');
  });

  it('should recover native doubles while retaining every original indexed face and color', () => {
    const off = offFile(preciseVertices, tetrahedron);
    expect(() => parseClassicOff(off)).toThrow('nonzero area');
    const restored = restoreClassicOffPrecision(off, asciiFile(preciseVertices, tetrahedron));
    const mesh = parseClassicOff(restored);
    expect(mesh.vertices).toEqual(preciseVertices);
    expect(mesh.triangles.map(({ indices }) => indices)).toEqual(tetrahedron);
    expect(mesh.triangles.map(({ color }) => color)).toEqual([
      [1, 0, 0, 1],
      [0, 1, 0, 127 / 255],
      [1, 0, 0, 1],
      [0, 1, 0, 127 / 255],
    ]);
    expect(restored.trim().split('\n').slice(5)).toEqual(off.split('\n').slice(5));
    const glb = classicMeshToGlb(mesh);
    const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    const document: unknown = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + view.getUint32(12, true))));
    // The native double surface is valid, but this edge still collapses at glTF Float32 precision.
    expect(JSON.stringify(document)).not.toContain('EXT_mesh_manifold');
  });

  it('should accept cyclic starting corners without reversing winding or replacing shared native identities', () => {
    const rotations = tetrahedron.map((face) => [at(face, 1), at(face, 2), at(face, 0)]);
    const mesh = parseClassicOff(
      restoreClassicOffPrecision(offFile(preciseVertices, tetrahedron), asciiFile(preciseVertices, rotations)),
    );
    expect(mesh.vertices).toEqual(preciseVertices);
    expect(mesh.triangles.map(({ indices }) => indices)).toEqual(tetrahedron);
  });

  it('should reject reversed winding', () => {
    const reversed = tetrahedron.map((face) => [at(face, 0), at(face, 2), at(face, 1)]);
    expect(() =>
      restoreClassicOffPrecision(offFile(preciseVertices, tetrahedron), asciiFile(preciseVertices, reversed)),
    ).toThrow();
  });

  it('should reject inconsistent full-precision coordinates for the same original vertex', () => {
    const text = asciiFile(preciseVertices, tetrahedron);
    const changed = text.replace(
      `vertex ${at(preciseVertices, 0).join(' ')}`,
      'vertex -96.17997282 -72.34180319476127 1.298',
    );
    expect(() => restoreClassicOffPrecision(offFile(preciseVertices, tetrahedron), changed)).toThrow('inconsistent');
  });

  it('should reject unresolved correspondence when every rounded corner is ambiguous', () => {
    const tiny: readonly Point[] = [
      [100.00000001, 100, 100],
      [100, 100.00000001, 100],
      [100, 100, 100.00000001],
    ];
    expect(() => restoreClassicOffPrecision(offFile(tiny, [[0, 1, 2]]), asciiFile(tiny, [[0, 1, 2]]))).toThrow(
      'ambiguous',
    );
  });

  it('should preserve a native polygon when STL uses another valid diagonal', () => {
    const vertices: readonly Point[] = [
      [0, 0, 0],
      [10.123456789, 0, 0],
      [10.123456789, 2, 0],
      [0, 2, 0],
    ];
    const off = offFile(vertices, [[0, 1, 2, 3]]);
    const restored = restoreClassicOffPrecision(
      off,
      asciiFile(vertices, [
        [0, 1, 3],
        [1, 2, 3],
      ]),
    );
    expect(restored.trim().split('\n').at(-1)).toBe(off.split('\n').at(-1));
    expect(parseClassicOff(restored).vertices).toEqual(vertices);
    expect(parseClassicOff(restored).triangles.map(({ indices }) => indices)).toEqual([
      [0, 1, 2],
      [0, 2, 3],
    ]);
  });

  it('should reject incomplete or overlapping polygon triangulations with the right triangle count', () => {
    const vertices: readonly Point[] = [
      [0, 0, 0],
      [2, 0, 0],
      [2, 2, 0],
      [0, 2, 0],
    ];
    const off = offFile(vertices, [[0, 1, 2, 3]]);
    expect(() =>
      restoreClassicOffPrecision(
        off,
        asciiFile(vertices, [
          [0, 1, 2],
          [0, 1, 3],
        ]),
      ),
    ).toThrow('boundary');
    expect(() => restoreClassicOffPrecision(off, asciiFile(vertices, [[0, 1, 2]]))).toThrow('completely triangulate');
  });

  it('should reject unmatched or extra faces rather than dropping them', () => {
    const off = offFile(preciseVertices, tetrahedron);
    expect(() => restoreClassicOffPrecision(off, asciiFile(preciseVertices, tetrahedron.slice(1)))).toThrow(
      'counts disagree',
    );
    expect(() =>
      restoreClassicOffPrecision(off, asciiFile(preciseVertices, [...tetrahedron, at(tetrahedron, 0)])),
    ).toThrow('counts disagree');
  });

  it('should reject vertices absent from the paired native surface', () => {
    const vertices: readonly Point[] = [...preciseVertices, [0, 0, 0]];
    expect(() => restoreClassicOffPrecision(offFile(vertices, tetrahedron), asciiFile(vertices, tetrahedron))).toThrow(
      'every original OFF vertex',
    );
  });

  it('should reject malformed, nonfinite or truncated precision records', () => {
    const off = offFile(preciseVertices, tetrahedron);
    const text = asciiFile(preciseVertices, tetrahedron);
    expect(() => restoreClassicOffPrecision(off, text.replace('endsolid fixture', ''))).toThrow('complete ASCII STL');
    expect(() => restoreClassicOffPrecision(off, text.replace('outer loop', 'outer shell'))).toThrow('facet record');
    expect(() => restoreClassicOffPrecision(off, text.replace('vertex -96.17997282862663', 'vertex NaN'))).toThrow(
      'decimal',
    );
  });

  it('should retain an empty native surface without inventing vertices or faces', () => {
    expect(parseClassicOff(restoreClassicOffPrecision('OFF 0 0 0', 'solid empty\nendsolid empty'))).toEqual({
      vertices: [],
      triangles: [],
    });
  });
});
