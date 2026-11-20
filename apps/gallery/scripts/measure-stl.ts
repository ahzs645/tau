import assert from 'node:assert/strict';
import type { GalleryExportFile } from '#runtime/types.js';
import type { GeometrySummary } from '#scripts/measure-glb.js';

type StlSummary = Pick<GeometrySummary, 'boundsMm'> & { readonly triangles: number; readonly files: number };

const declaredTriangles = (bytes: Uint8Array<ArrayBuffer>): number => {
  if (bytes.byteLength >= 84) {
    const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
    if (bytes.byteLength === 84 + count * 50) {
      return count;
    }
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  assert.ok(
    /^\s*solid\b/u.test(text) && /\bendsolid(?:[^\r\n]*)\s*$/u.test(text),
    'STL is neither a complete binary file nor a complete ASCII solid',
  );
  const facets = [...text.matchAll(/\bfacet\s+normal\b/gu)].length;
  assert.equal([...text.matchAll(/\bendfacet\b/gu)].length, facets, 'STL ASCII facets are incomplete');
  return facets;
};

type Point = readonly [number, number, number];

const triangleArea = (a: Point, b: Point, c: Point): number => {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
  return Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]) / 2;
};

/** Decode all printable part files and map the declared STL Z-up millimetres into GLB Y-up millimetres. */
export const measureStlFiles = async (files: readonly GalleryExportFile[]): Promise<StlSummary> => {
  const stlModule = await import('three/examples/jsm/loaders/STLLoader.js');
  const loader = new stlModule.STLLoader();
  const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
  const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  assert.ok(files.length > 0, 'STL export contains no part files');
  for (const file of files) {
    let surfaceArea = 0;
    const expected = declaredTriangles(file.bytes);
    assert.ok(expected > 0, `STL ${file.name} contains no triangles`);
    const geometry = loader.parse(new Uint8Array(file.bytes).buffer);
    try {
      const positions = geometry.getAttribute('position');
      assert.ok(
        positions.itemSize === 3 && positions.count === expected * 3,
        `STL ${file.name} has incomplete triangle vertices`,
      );
      const positionAt = (index: number): Point => {
        // Public STL export convention is Z-up/mm; the preview GLB is Y-up/metres.
        // This signed mapping preserves placement as well as dimensions.
        const point = [positions.getX(index), positions.getZ(index), -positions.getY(index)] as const;
        assert.ok(
          point.every((value) => Number.isFinite(value)),
          `STL ${file.name} contains non-finite vertices`,
        );
        for (const axis of [0, 1, 2] as const) {
          minimum[axis] = Math.min(minimum[axis], point[axis]);
          maximum[axis] = Math.max(maximum[axis], point[axis]);
        }
        return point;
      };
      for (let index = 0; index < positions.count; index += 3) {
        surfaceArea += triangleArea(positionAt(index), positionAt(index + 1), positionAt(index + 2));
      }
      assert.ok(
        surfaceArea > 0 && Number.isFinite(surfaceArea),
        `STL ${file.name} contains no finite nonempty triangle surface`,
      );
      triangles += expected;
    } finally {
      geometry.dispose();
    }
  }
  return {
    files: files.length,
    triangles,
    boundsMm: {
      min: minimum,
      max: maximum,
      size: [maximum[0] - minimum[0], maximum[1] - minimum[1], maximum[2] - minimum[2]],
    },
  };
};
