import { describe, it, expect, vi, afterEach } from 'vitest';
import UZIP from 'uzip';
import type { IndexedPolyhedron } from '#framework/common.js';
import { export3mf } from '#utils/export-3mf.js';

const triangle: IndexedPolyhedron = {
  vertices: [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ],
  faces: [[0, 1, 2]],
  colors: [[1, 0, 0, 1]],
};

const multiColorMesh: IndexedPolyhedron = {
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
  colors: [
    [1, 0, 0, 1],
    [0, 0, 1, 1],
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('export3mf', () => {
  it('should produce a valid ZIP containing Content_Types.xml and model file', () => {
    const result = export3mf(triangle);
    const parsed = UZIP.parse(result.buffer);

    expect(parsed['[Content_Types].xml']).toBeDefined();
    expect(parsed['3D/3dmodel.model']).toBeDefined();
    expect(parsed['_rels/.rels']).toBeDefined();
  });

  it('should include vertex and triangle data in the 3MF model', () => {
    const result = export3mf(triangle);
    const parsed = UZIP.parse(result.buffer);
    const modelXml = new TextDecoder().decode(parsed['3D/3dmodel.model']);

    expect(modelXml).toContain('<vertex x="0" y="0" z="0"');
    expect(modelXml).toContain('<vertex x="1" y="0" z="0"');
    expect(modelXml).toContain('<vertex x="0" y="1" z="0"');
    expect(modelXml).toContain('<triangle');
    expect(modelXml).toContain('v1="0"');
    expect(modelXml).toContain('v2="1"');
    expect(modelXml).toContain('v3="2"');
  });

  it('should throw when geometry has no faces', () => {
    const emptyMesh: IndexedPolyhedron = {
      vertices: [[0, 0, 0]],
      faces: [],
      colors: [],
    };

    expect(() => export3mf(emptyMesh)).toThrow('Empty geometry');
  });

  it('should throw when geometry has no vertices', () => {
    const noVerts: IndexedPolyhedron = {
      vertices: [],
      faces: [[0, 1, 2]],
      colors: [],
    };

    expect(() => export3mf(noVerts)).toThrow('Empty geometry');
  });

  it('should map face colors to nearest extruder color when extruderColors provided', () => {
    vi.spyOn(console, 'log').mockReturnValue();

    const extruderColors: Array<[number, number, number]> = [
      [1, 0, 0],
      [0, 0, 1],
    ];

    const result = export3mf(multiColorMesh, extruderColors);
    const parsed = UZIP.parse(result.buffer);
    const modelXml = new TextDecoder().decode(parsed['3D/3dmodel.model']);

    expect(modelXml).toContain('<triangle');
    expect(modelXml).toContain('<basematerials');
  });

  it('should include per-triangle color references in the output', () => {
    vi.spyOn(console, 'log').mockReturnValue();

    const extruderColors: Array<[number, number, number]> = [
      [1, 0, 0],
      [0, 0, 1],
    ];

    const result = export3mf(multiColorMesh, extruderColors);
    const parsed = UZIP.parse(result.buffer);
    const modelXml = new TextDecoder().decode(parsed['3D/3dmodel.model']);

    expect(modelXml).toContain('pid="2"');
  });

  it('should default to white when no colors are provided', () => {
    const noColorMesh: IndexedPolyhedron = {
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      faces: [[0, 1, 2]],
      colors: [],
    };

    const result = export3mf(noColorMesh);
    const parsed = UZIP.parse(result.buffer);
    const modelXml = new TextDecoder().decode(parsed['3D/3dmodel.model']);

    expect(modelXml).toContain('displaycolor="#ffffff"');
  });

  it('should return a Uint8Array', () => {
    const result = export3mf(triangle);
    expect(result).toBeInstanceOf(Uint8Array);
  });

  it('should skip faces with fewer than 3 vertices during triangulation', () => {
    const meshWithShortFace: IndexedPolyhedron = {
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      faces: [
        [0, 1],
        [0, 1, 2],
      ],
      colors: [
        [1, 0, 0, 1],
        [0, 1, 0, 1],
      ],
    };

    const result = export3mf(meshWithShortFace);
    const parsed = UZIP.parse(result.buffer);
    const modelXml = new TextDecoder().decode(parsed['3D/3dmodel.model']);

    const triangleMatches = modelXml.match(/<triangle /g) ?? [];
    expect(triangleMatches).toHaveLength(1);
  });

  it('should use default color mapping when face has no color', () => {
    const noColorMesh: IndexedPolyhedron = {
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      faces: [[0, 1, 2]],
      colors: [],
    };

    const result = export3mf(noColorMesh);
    const parsed = UZIP.parse(result.buffer);
    const modelXml = new TextDecoder().decode(parsed['3D/3dmodel.model']);

    expect(modelXml).toContain('displaycolor="#ffffff"');
  });
});
