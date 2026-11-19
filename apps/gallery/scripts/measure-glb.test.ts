import { Document, NodeIO, Primitive } from '@gltf-transform/core';
import { describe, expect, it } from 'vitest';
import { assertBoundsParity, measureGlb } from '#scripts/measure-glb.js';

const linesMode = Primitive.Mode['LINES'];
if (linesMode === undefined) {
  throw new Error('glTF-Transform has no LINES mode');
}

describe('gallery geometry evidence', () => {
  it('should apply nested transforms and exclude line overlays from geometry evidence', async () => {
    const document = new Document();
    const buffer = document.createBuffer();
    const positions = document
      .createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 0.001, 0, 0, 0, 0.002, 0, 0, 0, 0.003]))
      .setBuffer(buffer);
    const indices = document
      .createAccessor()
      .setType('SCALAR')
      .setArray(new Uint16Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]))
      .setBuffer(buffer);
    const surface = document.createPrimitive().setAttribute('POSITION', positions).setIndices(indices);
    const lines = document
      .createPrimitive()
      .setMode(linesMode)
      .setAttribute(
        'POSITION',
        document
          .createAccessor()
          .setType('VEC3')
          .setArray(new Float32Array([100, 100, 100, 200, 200, 200]))
          .setBuffer(buffer),
      );
    const child = document
      .createNode()
      .setScale([2, 3, 4])
      .setMesh(document.createMesh().addPrimitive(surface).addPrimitive(lines));
    const parent = document
      .createNode()
      .setTranslation([0.01, 0.02, 0.03])
      .setRotation([0, 0, Math.SQRT1_2, Math.SQRT1_2])
      .addChild(child);
    document.createScene().addChild(parent);
    const result = await measureGlb(new Uint8Array(await new NodeIO().writeBinary(document)));
    expect(result.triangles).toBe(4);
    expect(result.meshInstances).toBe(1);
    for (const [axis, expected] of [4, 20, 30].entries()) {
      expect(result.boundsMm.min[axis]).toBeCloseTo(expected, 5);
    }
    for (const [axis, expected] of [10, 22, 42].entries()) {
      expect(result.boundsMm.max[axis]).toBeCloseTo(expected, 5);
    }
    expect(Math.abs(result.signedVolumeMm3)).toBeCloseTo(24, 4);
    expect(() => assertBoundsParity(result, { ...result, boundsMm: { ...result.boundsMm, min: [3, 20, 30] } })).toThrow(
      'Geometry bounds differ',
    );
  });

  it('should reject a lines-only artifact rather than accepting a nonempty file', async () => {
    const document = new Document();
    const buffer = document.createBuffer();
    const positions = document
      .createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 1, 1]))
      .setBuffer(buffer);
    document
      .createScene()
      .addChild(
        document
          .createNode()
          .setMesh(
            document
              .createMesh()
              .addPrimitive(document.createPrimitive().setMode(linesMode).setAttribute('POSITION', positions)),
          ),
      );
    const bytes = new Uint8Array(await new NodeIO().writeBinary(document));
    await expect(measureGlb(bytes)).rejects.toThrow('no nonempty triangle surface');
  });
});
