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
  const lifecycle: string[] = [];
  const result = await verifyGalleryExports({
    geometry,
    formats: ['stl', 'obj', 'step'],
    onStart(format) {
      lifecycle.push(`start:${format}`);
    },
    onValidationStart(format) {
      lifecycle.push(`validation:${format}`);
    },
    session: {
      async export(format) {
        attempted.push(format);
        lifecycle.push(`export:${format}`);
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
    async saveFile({ format, file }) {
      lifecycle.push(`save:${format}`);
      return `diagnostics/${file.name}`;
    },
  });
  expect(attempted).toEqual(['stl', 'obj', 'step']);
  expect(lifecycle).toEqual([
    'start:stl',
    'export:stl',
    'start:obj',
    'export:obj',
    'save:obj',
    'validation:obj',
    'start:step',
    'export:step',
    'save:step',
    'validation:step',
  ]);
  expect(result[0]?.error).toBe('Strict topology rejection');
  expect(result[0]?.fileSizes).toEqual([]);
  expect(result.slice(1).every((entry) => entry.error === undefined)).toBe(true);
  expect(result[1]?.fileSizes).toEqual([{ name: 'model.obj', byteLength: wavefrontTriangleFixture.byteLength }]);
  expect(result[2]?.fileSizes).toEqual([{ name: 'model.step', byteLength: triangleStepFixture.byteLength }]);
});

it('should preserve returned bytes before rejecting a malformed geometry export', async () => {
  const saved: number[][] = [];
  const lifecycle: string[] = [];
  const result = await verifyGalleryExports({
    geometry,
    formats: ['glb'],
    onStart(format) {
      lifecycle.push(`start:${format}`);
    },
    onValidationStart(format) {
      lifecycle.push(`validation:${format}`);
    },
    session: {
      async export() {
        lifecycle.push('export:glb');
        return [{ name: 'broken.glb', mimeType: 'model/gltf-binary', bytes: new Uint8Array([1, 2, 3]) }];
      },
    },
    async saveFile({ format, file }) {
      saved.push([...file.bytes]);
      lifecycle.push(`save:${format}`);
      return 'diagnostics/broken.glb';
    },
  });
  expect(lifecycle).toEqual(['start:glb', 'export:glb', 'save:glb', 'validation:glb']);
  expect(saved).toEqual([[1, 2, 3]]);
  expect(result[0]?.artifacts).toEqual(['diagnostics/broken.glb']);
  expect(result[0]?.fileSizes).toEqual([{ name: 'broken.glb', byteLength: 3 }]);
  expect(result[0]?.error).toBeTypeOf('string');
});
