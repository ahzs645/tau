import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeGlb } from '@taucad/geometry-core';
import type { GlbMaterial, GlbNode } from '@taucad/geometry-core';
import { assertSuccess, createMockKernelRuntime, glbToDocument } from '@taucad/runtime-testing';
import { resolveRuntimePluginDefinition } from '@taucad/runtime/plugin';
import type { ExportFile } from '@taucad/runtime/types';
import { createAssimp } from 'libassimp';
import type { Assimp, AssimpFile } from 'libassimp';
import { assimpTranscoder } from '#index.js';

type Point = [number, number, number];

const runtime = createMockKernelRuntime();
const definition = await resolveRuntimePluginDefinition('transcoder', assimpTranscoder());
let context: { assimp: Assimp } | undefined;

const currentContext = () => {
  if (context === undefined) {
    throw new Error('The native Assimp test context has not been initialized');
  }
  return context;
};

/** Six independently indexed, consistently oriented faces model the OCCT GLB layout. */
const splitBox = (name: string, color: Point, translation: Point = [0, 0, 0]): GlbNode => {
  const vertices = [
    [0, 0, 0],
    [0.01, 0, 0],
    [0.01, 0.02, 0],
    [0, 0.02, 0],
    [0, 0, 0.03],
    [0.01, 0, 0.03],
    [0.01, 0.02, 0.03],
    [0, 0.02, 0.03],
  ] as const;
  const faces = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 4, 7, 3],
    [1, 2, 6, 5],
    [0, 1, 5, 4],
    [3, 7, 6, 2],
  ] as const;
  const material: GlbMaterial = {
    name: `${name} material`,
    pbrMetallicRoughness: { baseColorFactor: [...color, 1] },
  };
  return {
    name,
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...translation, 1],
    primitives: faces.map((face) => ({
      mode: 4,
      positions: new Float32Array(face.flatMap((index) => vertices[index])),
      indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
      material,
    })),
  };
};

const sourceFile = (nodes: GlbNode[]): ExportFile => ({
  name: 'split-box.glb',
  mimeType: 'model/gltf-binary',
  bytes: writeGlb({ nodes }),
});

const requiredFile = (files: readonly AssimpFile[], extension: string): AssimpFile => {
  const file = files.find(({ name }) => name.endsWith(extension));
  if (file === undefined) {
    throw new Error(`Native Assimp returned no ${extension} file`);
  }
  return file;
};

const convert = async (file: ExportFile) =>
  definition.transcode(
    { from: 'glb', to: '3mf', files: [file], options: { requireManifold: true } },
    runtime,
    currentContext(),
  );

/** Read the real re-imported scene in canonical Y-up metres, including node placement. */
const sceneParts = async (file: AssimpFile) => {
  const roundTrip = await currentContext().assimp.convert(file, { to: 'glb' });
  const glb = requiredFile(roundTrip.files, '.glb');
  const document = await glbToDocument(new Uint8Array(glb.bytes));
  const parts: Array<{ colors: number[][]; triangles: number; min: Point; max: Point }> = [];
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (mesh === null) {
      continue;
    }
    const matrix = node.getWorldMatrix();
    const min: Point = [Infinity, Infinity, Infinity];
    const max: Point = [-Infinity, -Infinity, -Infinity];
    const colors: number[][] = [];
    let triangles = 0;
    for (const primitive of mesh.listPrimitives()) {
      const positions = primitive.getAttribute('POSITION');
      if (positions === null) {
        throw new Error('Re-imported part has no positions');
      }
      colors.push(primitive.getMaterial()?.getBaseColorFactor() ?? []);
      triangles += (primitive.getIndices()?.getCount() ?? positions.getCount()) / 3;
      const point: Point = [0, 0, 0];
      for (let vertex = 0; vertex < positions.getCount(); vertex++) {
        positions.getElement(vertex, point);
        const [x, y, z] = point;
        const placed: Point = [
          matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
          matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
          matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
        ];
        for (const axis of [0, 1, 2] as const) {
          min[axis] = Math.min(min[axis], placed[axis]);
          max[axis] = Math.max(max[axis], placed[axis]);
        }
      }
    }
    parts.push({ colors, triangles, min, max });
  }
  return parts;
};

beforeAll(async () => {
  context = { assimp: await createAssimp({ backend: 'native' }) };
  expect(context.assimp.backend).toBe('native');
}, 30_000);

afterAll(async () => {
  if (context !== undefined) {
    await definition.onDispose?.(context);
  }
});

describe('strict 3MF export of split face primitives', () => {
  it('should accept a closed box that the default per-primitive conversion rejects', async () => {
    const file = sourceFile([splitBox('Closed box', [1, 0, 0])]);

    await expect(
      currentContext().assimp.convert(file, { to: '3mf', exportOptions: { requireManifold: true } }),
    ).rejects.toThrow('component containing triangle 0 has zero signed volume');

    const result = await convert(file);
    assertSuccess(result, 'Split-face closed box');
    const parts = await sceneParts(requiredFile(result.data, '.3mf'));
    expect(parts).toHaveLength(1);
    expect(parts[0]?.triangles).toBe(12);
    for (const axis of [0, 1, 2] as const) {
      expect(parts[0]?.min[axis]).toBeCloseTo(0, 7);
      expect(parts[0]?.max[axis]).toBeCloseTo(([0.01, 0.02, 0.03] as const)[axis], 7);
    }
  });

  it('should retain separate colored parts and their asymmetric translated placements', async () => {
    const file = sourceFile([
      splitBox('Red part', [1, 0, 0], [0.05, 0.07, -0.02]),
      splitBox('Blue part', [0, 0, 1], [-0.04, -0.03, 0.08]),
    ]);
    const result = await convert(file);
    assertSuccess(result, 'Separated colored boxes');
    const parts = await sceneParts(requiredFile(result.data, '.3mf'));
    expect(parts).toHaveLength(2);
    const expected = [
      { color: [1, 0, 0, 1], min: [0.05, 0.07, -0.02], max: [0.06, 0.09, 0.01] },
      { color: [0, 0, 1, 1], min: [-0.04, -0.03, 0.08], max: [-0.03, -0.01, 0.11] },
    ] as const;
    for (const part of expected) {
      const actual = parts.find(({ colors }) => JSON.stringify(colors[0]) === JSON.stringify(part.color));
      expect(actual?.colors).toEqual([part.color]);
      expect(actual?.triangles).toBe(12);
      for (const axis of [0, 1, 2] as const) {
        expect(actual?.min[axis]).toBeCloseTo(part.min[axis], 7);
        expect(actual?.max[axis]).toBeCloseTo(part.max[axis], 7);
      }
    }
  });

  it('should still reject a box with a missing face under strict manifold validation', async () => {
    const openBox = splitBox('Open box', [1, 0, 0]);
    openBox.primitives.pop();
    const result = await convert(sourceFile([openBox]));

    expect(result.success).toBe(false);
    expect(
      result.issues
        .filter(({ severity }) => severity === 'error')
        .map(({ message }) => message)
        .join('; '),
    ).toMatch(/not manifold and oriented/u);
  });

  it('should reject malformed GLB bytes without producing a 3MF artifact', async () => {
    const file = sourceFile([splitBox('Malformed box', [1, 0, 0])]);
    const result = await convert({ ...file, bytes: file.bytes.slice(0, 24) });

    expect(result.success).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error' })]));
  });
});
