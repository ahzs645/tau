import { expect, it } from 'vitest';
import { asciiStlFixture, binaryStlFixture } from '#scripts/export-artifacts.fixture.js';
import { measureStlFiles } from '#scripts/measure-stl.js';
import { validateExportArtifact } from '#scripts/verification-artifacts.js';

const firstPart = {
  name: 'translated-binary.stl',
  mimeType: 'model/stl',
  bytes: binaryStlFixture([
    [
      [10, 20, 30],
      [16, 20, 30],
      [10, 25, 39],
    ],
  ]),
};
const secondPart = {
  name: 'translated-ascii.stl',
  mimeType: 'model/stl',
  bytes: asciiStlFixture([
    [
      [-4, 2, 1],
      [-3, 2, 1],
      [-4, 4, 5],
    ],
  ]),
};

it('should decode binary and ASCII parts and retain signed axis placement in millimetres', async () => {
  const boundsMm = { min: [-4, 1, -25], max: [16, 39, -2], size: [20, 38, 23] } as const;
  const result = await validateExportArtifact({
    format: 'stl',
    files: [firstPart, secondPart],
    reference: { boundsMm },
  });
  expect(result).toMatchObject({
    level: 'geometry',
    counts: { files: 2, triangles: 2 },
    sourceCoordinateSystem: 'z-up',
    sourceUnit: 'mm',
    boundsCoordinateSystem: 'y-up',
    boundsMm,
  });
});

it('should reject correct dimensions at an incorrect signed axis location', async () => {
  await expect(
    validateExportArtifact({
      format: 'stl',
      files: [firstPart, secondPart],
      reference: { boundsMm: { min: [-4, 1, 2], max: [16, 39, 25], size: [20, 38, 23] } },
    }),
  ).rejects.toThrow('bounds');
});

it('should reject truncated binary triangles and non-finite positions', async () => {
  await expect(measureStlFiles([{ ...firstPart, bytes: firstPart.bytes.slice(0, -1) }])).rejects.toThrow(
    /STL|encoding/u,
  );
  const nonfinite = binaryStlFixture([
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, Number.NaN, 1],
    ],
  ]);
  await expect(measureStlFiles([{ ...firstPart, bytes: nonfinite }])).rejects.toThrow('non-finite vertices');
});

it('should reject an entirely degenerate STL even when its bounds have nonzero dimensions', async () => {
  const bytes = binaryStlFixture([
    [
      [0, 0, 0],
      [1, 1, 1],
      [2, 2, 2],
    ],
  ]);
  await expect(measureStlFiles([{ ...firstPart, bytes }])).rejects.toThrow('nonempty triangle surface');
});
