import { expect, it } from 'vitest';
import { verifyGalleryExports } from '#scripts/verification-exports.js';
import type { GeometrySummary } from '#scripts/measure-glb.js';
import { wavefrontTriangleFixture, triangleStepFixture } from '#scripts/export-artifacts.fixture.js';

const geometry: GeometrySummary = {
  triangles: 4,
  meshInstances: 1,
  boundsMm: { min: [0, 0, 0], max: [1, 2, 3], size: [1, 2, 3] },
  signedVolumeMm3: 1,
  surfaceAreaMm2: 8,
};

it('should retain a failed format and still attempt every subsequent declared export', async () => {
  const attempted: string[] = [];
  const result = await verifyGalleryExports({
    geometry,
    formats: ['stl', 'obj', 'step'],
    session: {
      async export(format) {
        attempted.push(format);
        if (format === 'stl') {
          throw new Error('Strict topology rejection');
        }
        return [
          {
            name: `model.${format}`,
            mimeType: 'application/octet-stream',
            bytes: format === 'obj' ? wavefrontTriangleFixture : triangleStepFixture,
          },
        ];
      },
    },
  });
  expect(attempted).toEqual(['stl', 'obj', 'step']);
  expect(result[0]?.error).toBe('Strict topology rejection');
  expect(result.slice(1).every((entry) => entry.error === undefined)).toBe(true);
});

it('should preserve returned bytes before rejecting a malformed geometry export', async () => {
  const saved: number[][] = [];
  const result = await verifyGalleryExports({
    geometry,
    formats: ['glb'],
    session: {
      async export() {
        return [{ name: 'broken.glb', mimeType: 'model/gltf-binary', bytes: new Uint8Array([1, 2, 3]) }];
      },
    },
    async saveFile({ file }) {
      saved.push([...file.bytes]);
      return 'diagnostics/broken.glb';
    },
  });
  expect(saved).toEqual([[1, 2, 3]]);
  expect(result[0]?.artifacts).toEqual(['diagnostics/broken.glb']);
  expect(result[0]?.error).toBeTypeOf('string');
});
