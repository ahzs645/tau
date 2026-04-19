import { describe, it, expect } from 'vitest';
import type { IndexedPolyhedron } from '#framework/common.js';
import { createStlAscii, createStlBinary } from '#utils/export-stl.js';

const triangle: IndexedPolyhedron = {
  vertices: [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ],
  faces: [[0, 1, 2]],
  colors: [],
};

const quad: IndexedPolyhedron = {
  vertices: [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ],
  faces: [[0, 1, 2, 3]],
  colors: [],
};

const multiface: IndexedPolyhedron = {
  vertices: [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  faces: [
    [0, 1, 2],
    [0, 1, 3],
  ],
  colors: [],
};

describe('createStlAscii', () => {
  it('should produce valid ASCII STL with correct normal and vertex coordinates', () => {
    const result = createStlAscii(triangle);
    const text = new TextDecoder().decode(result);

    expect(text).toContain('solid model');
    expect(text).toContain('endsolid model');
    expect(text).toContain('facet normal');
    expect(text).toContain('vertex 0 0 0');
    expect(text).toContain('vertex 1 0 0');
    expect(text).toContain('vertex 0 1 0');
  });

  it('should fan-triangulate quad faces into two triangles', () => {
    const result = createStlAscii(quad);
    const text = new TextDecoder().decode(result);

    const facetCount = (text.match(/facet normal/g) ?? []).length;
    expect(facetCount).toBe(2);
  });

  it('should handle meshes with multiple faces', () => {
    const result = createStlAscii(multiface);
    const text = new TextDecoder().decode(result);

    const facetCount = (text.match(/facet normal/g) ?? []).length;
    expect(facetCount).toBe(2);
  });

  it('should skip faces with fewer than 3 vertices', () => {
    const mesh: IndexedPolyhedron = {
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      faces: [
        [0, 1],
        [0, 1, 2],
      ],
      colors: [],
    };
    const result = createStlAscii(mesh);
    const text = new TextDecoder().decode(result);

    const facetCount = (text.match(/facet normal/g) ?? []).length;
    expect(facetCount).toBe(1);
  });

  it('should return a Uint8Array', () => {
    const result = createStlAscii(triangle);
    expect(result).toBeInstanceOf(Uint8Array);
  });
});

describe('createStlBinary', () => {
  it('should produce valid binary STL with 80-byte header and correct triangle count', () => {
    const result = createStlBinary(triangle);

    expect(result).toBeInstanceOf(Uint8Array);

    const view = new DataView(result.buffer);
    const triangleCount = view.getUint32(80, true);
    expect(triangleCount).toBe(1);

    const expectedSize = 80 + 4 + 1 * 50;
    expect(result.byteLength).toBe(expectedSize);
  });

  it('should fan-triangulate quad faces into two triangles', () => {
    const result = createStlBinary(quad);
    const view = new DataView(result.buffer);
    const triangleCount = view.getUint32(80, true);
    expect(triangleCount).toBe(2);
  });

  it('should handle meshes with multiple faces', () => {
    const result = createStlBinary(multiface);
    const view = new DataView(result.buffer);
    const triangleCount = view.getUint32(80, true);
    expect(triangleCount).toBe(2);
  });

  it('should produce matching triangle counts from ASCII and binary for the same input', () => {
    const ascii = createStlAscii(quad);
    const asciiText = new TextDecoder().decode(ascii);
    const asciiFacetCount = (asciiText.match(/facet normal/g) ?? []).length;

    const binary = createStlBinary(quad);
    const view = new DataView(binary.buffer);
    const binaryTriangleCount = view.getUint32(80, true);

    expect(asciiFacetCount).toBe(binaryTriangleCount);
  });

  it('should write vertex coordinates as little-endian floats', () => {
    const result = createStlBinary(triangle);
    const view = new DataView(result.buffer);

    const dataOffset = 80 + 4 + 12;
    const v1x = view.getFloat32(dataOffset, true);
    const v1y = view.getFloat32(dataOffset + 4, true);
    const v1z = view.getFloat32(dataOffset + 8, true);

    expect(v1x).toBe(0);
    expect(v1y).toBe(0);
    expect(v1z).toBe(0);
  });

  it('should skip faces with invalid vertex indices in binary output', () => {
    const mesh: IndexedPolyhedron = {
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      faces: [
        [0, 1],
        [0, 1, 2],
      ],
      colors: [],
    };
    const result = createStlBinary(mesh);
    const view = new DataView(result.buffer);
    const triangleCount = view.getUint32(80, true);
    expect(triangleCount).toBe(1);
  });
});

describe('degenerate normal', () => {
  it('should return [0, 0, 1] normal for degenerate (zero-area) triangle', () => {
    const degenerate: IndexedPolyhedron = {
      vertices: [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
      faces: [[0, 1, 2]],
      colors: [],
    };
    const result = createStlAscii(degenerate);
    const text = new TextDecoder().decode(result);
    expect(text).toContain('facet normal 0 0 1');
  });
});
