import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeGallerySession } from '#runtime/node.js';
import { loadNodeProjectFiles, readNodeCatalog } from '#scripts/catalog-node.js';
import { readThreeMfFixture } from '#runtime/classic/testing/three-mf.fixture.js';
import type { ThreeMfPoint } from '#runtime/classic/testing/three-mf.fixture.js';

const orientedTriangle = (points: readonly ThreeMfPoint[]): string => {
  if (points.length !== 3) {
    throw new Error('Expected one complete triangle.');
  }
  const keys = points.map((point) => point.join(','));
  return (
    [keys, [...keys.slice(1), keys[0]], [keys[2], ...keys.slice(0, 2)]].map((corners) => corners.join('|')).sort()[0] ??
    ''
  );
};

const nativeStlFaces = (bytes: Uint8Array<ArrayBuffer>): string[] => {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const points: ThreeMfPoint[] = [...text.matchAll(/^\s*vertex\s+(\S+)\s+(\S+)\s+(\S+)\s*$/gmu)].map((match) => [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ]);
  expect(points.every((point) => point.every((value) => Number.isFinite(value)))).toBe(true);
  expect(points.length % 3).toBe(0);
  const faces: string[] = [];
  for (let offset = 0; offset < points.length; offset += 3) {
    faces.push(orientedTriangle(points.slice(offset, offset + 3)));
  }
  return faces;
};

describe('classic native 3MF through the public gallery session', { timeout: 120_000 }, () => {
  it('should preserve every original-artwork stamp face, precise coordinate, owner and RGBA assignment', async () => {
    const catalog = await readNodeCatalog();
    const entry = catalog.find(({ project }) => project.id === 'stamp');
    if (!entry) {
      throw new Error('Missing original stamp project.');
    }
    const variant = entry.project.variants.find(({ id }) => id === entry.project.defaultVariantId);
    if (variant?.kernel !== 'openscad') {
      throw new Error('The original stamp must use its declared classic OpenSCAD variant.');
    }
    const session = await createNodeGallerySession({
      kernel: variant.kernel,
      entryPath: variant.entry,
      files: await loadNodeProjectFiles(entry),
      parameters: entry.project.initialParameters,
    });
    try {
      const before = await session.render();
      const [archive] = await session.export('3mf');
      const [nativeStl] = await session.export('stl');
      if (!archive || !nativeStl) {
        throw new Error('Missing native stamp geometry exports.');
      }
      expect(archive.name).toBe('model.3mf');
      expect(archive.mimeType).toBe('model/3mf');
      const parsed = readThreeMfFixture(archive.bytes);
      const owner = parsed.objects[0];
      if (!owner) {
        throw new Error('Missing stamp owner.');
      }
      expect(parsed.unit).toBe('millimeter');
      expect(parsed.objects).toHaveLength(1);
      expect(owner.name).toBe('Shape 1');
      expect(owner.type).toBe('model');
      expect(owner.vertices).toHaveLength(4360);
      expect(owner.triangles).toHaveLength(8716);
      expect(parsed.colors).toEqual(['#F9D72CFF', '#9DCB51FF', '#FF00007F', '#0000FF7F']);
      const colorCounts = new Map<string, number>();
      const faces = owner.triangles.map(({ indices, material, palette }) => {
        expect(palette).toBe(parsed.paletteId);
        const color = parsed.colors[material];
        if (!color) {
          throw new Error('Unresolved stamp face color.');
        }
        colorCounts.set(color, (colorCounts.get(color) ?? 0) + 1);
        const points = indices.map((index) => {
          const point = owner.vertices[index];
          if (!point) {
            throw new Error('Unresolved stamp vertex.');
          }
          return point;
        });
        return orientedTriangle(points);
      });
      expect(Object.fromEntries(colorCounts)).toEqual({
        '#F9D72CFF': 1203,
        '#9DCB51FF': 1938,
        '#FF00007F': 5373,
        '#0000FF7F': 202,
      });
      const nativeFaces = nativeStlFaces(nativeStl.bytes);
      expect(faces).toHaveLength(nativeFaces.length);
      for (const [faceIndex, face] of faces.entries()) {
        expect(face, `Native stamp face ${faceIndex}`).toBe(nativeFaces[faceIndex]);
      }
      const nativePositions = new Set(owner.vertices.map((point) => point.join(',')));
      const previewPositions = new Set(
        owner.vertices.map(([x, y, z]) =>
          [Math.fround(x * 0.001), Math.fround(z * 0.001), Math.fround(-y * 0.001)].join(','),
        ),
      );
      expect(nativePositions.size).toBe(4360);
      expect(previewPositions.size).toBe(4316);
      const after = await session.render();
      expect(after.artifactHash).toBe(before.artifactHash);
      const saved = new Uint8Array(archive.bytes);
      archive.bytes[0] = 0;
      const repeated = await session.export('3mf');
      expect(repeated[0]?.bytes).toEqual(saved);
      const artifact = path.resolve(
        import.meta.dirname,
        '../../../../../out/artifacts/gallery/models/stamp-classic-native-3mf-proof.3mf',
      );
      await mkdir(path.dirname(artifact), { recursive: true });
      await writeFile(artifact, saved);
    } finally {
      await session.dispose();
    }
  });
});
