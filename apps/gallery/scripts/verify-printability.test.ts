import { Document, NodeIO } from '@gltf-transform/core';
import { expect, it } from 'vitest';
import { verifyPrintability } from '#scripts/verify-printability.js';

const tetrahedron = async (input: { open?: boolean; copies?: number } = {}): Promise<Uint8Array<ArrayBuffer>> => {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = document
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 0.001, 0, 0, 0, 0.002, 0, 0, 0, 0.003]))
    .setBuffer(buffer);
  const triangles = input.open ? [0, 2, 1, 0, 1, 3, 0, 3, 2] : [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
  const indices = document.createAccessor().setType('SCALAR').setArray(new Uint16Array(triangles)).setBuffer(buffer);
  const mesh = document
    .createMesh('Tetrahedron')
    .addPrimitive(document.createPrimitive().setAttribute('POSITION', positions).setIndices(indices));
  const scene = document.createScene();
  for (let index = 0; index < (input.copies ?? 1); index += 1) {
    scene.addChild(
      document
        .createNode(`Part ${index}`)
        .setTranslation([index * 0.02, 0, 0])
        .setMesh(mesh),
    );
  }
  return new Uint8Array(await new NodeIO().writeBinary(document));
};

it('should retain native watertight and separated-component evidence with explicit metre input', async () => {
  const evidence = await verifyPrintability(await tetrahedron({ copies: 2 }), 2);
  expect(evidence.sourceCoordinateSystem).toBe('y-up');
  expect(evidence.admittedCoordinateSystem).toBe('z-up');
  expect(evidence.admittedSha256).not.toBe(evidence.sourceSha256);
  expect(evidence.sourceUnit).toBe('m');
  expect(evidence.toleranceMm).toBe(0.001);
  expect(evidence.claims.map((claim) => claim.status)).toEqual(['passed', 'passed']);
  expect(
    evidence.claims.every(
      (claim) => claim.canonicalClaim.length > 0 && claim.canonicalPlan.length > 0 && claim.canonicalResult.length > 0,
    ),
  ).toBe(true);
});

it('should retain failures for a missing face and a wrong piece count rather than passing nonempty geometry', async () => {
  const open = await verifyPrintability(await tetrahedron({ open: true }), 1);
  expect(open.claims.find((claim) => claim.matcher === 'toBeWatertight')?.status).toBe('failed');
  const connected = await verifyPrintability(await tetrahedron(), 2);
  expect(connected.claims.find((claim) => claim.matcher === 'toHaveConnectedComponents')?.status).toBe('failed');
});
