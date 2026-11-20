import { NodeIO, Primitive } from '@gltf-transform/core';

export type GeometrySummary = {
  readonly triangles: number;
  readonly meshInstances: number;
  readonly boundsMm: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
    readonly size: readonly [number, number, number];
  };
  /** Signed tetrahedron sum; meaningful as enclosed volume only for a closed surface. */
  readonly signedVolumeMm3: number;
  readonly surfaceAreaMm2: number;
};

type Point = readonly [number, number, number];

const triangleIndices = (mode: number, indices: readonly number[]): Array<readonly [number, number, number]> => {
  const triangles: Array<readonly [number, number, number]> = [];
  switch (mode) {
    case Primitive.Mode['TRIANGLES']: {
      if (indices.length % 3 !== 0) {
        throw new Error('GLB triangle index count is not divisible by three');
      }
      for (let index = 0; index < indices.length; index += 3) {
        triangles.push([indices[index]!, indices[index + 1]!, indices[index + 2]!]);
      }

      break;
    }
    case Primitive.Mode['TRIANGLE_STRIP']: {
      for (let index = 2; index < indices.length; index += 1) {
        triangles.push(
          index % 2 === 0
            ? [indices[index - 2]!, indices[index - 1]!, indices[index]!]
            : [indices[index - 1]!, indices[index - 2]!, indices[index]!],
        );
      }

      break;
    }
    case Primitive.Mode['TRIANGLE_FAN']: {
      for (let index = 2; index < indices.length; index += 1) {
        triangles.push([indices[0]!, indices[index - 1]!, indices[index]!]);
      }

      break;
    }
    // No default
  }
  return triangles;
};

/** Measure actual scene triangles in metres, including hierarchy and mesh instances. */
export const measureGlb = async (bytes: Uint8Array<ArrayBuffer>): Promise<GeometrySummary> => {
  const document = await new NodeIO().readBinary(bytes);
  const root = document.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) {
    throw new Error('GLB has no renderable scene');
  }
  const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
  const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  let meshInstances = 0;
  let signedVolume = 0;
  let surfaceArea = 0;
  scene.traverse((node) => {
    const mesh = node.getMesh();
    if (!mesh) {
      return;
    }
    let hasSurface = false;
    const matrix = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const mode = primitive.getMode();
      if (
        mode !== Primitive.Mode['TRIANGLES'] &&
        mode !== Primitive.Mode['TRIANGLE_STRIP'] &&
        mode !== Primitive.Mode['TRIANGLE_FAN']
      ) {
        continue;
      }
      const positions = primitive.getAttribute('POSITION');
      if (positions?.getElementSize() !== 3) {
        throw new Error('GLB triangle primitive is missing VEC3 positions');
      }
      const indexAccessor = primitive.getIndices();
      const indices = Array.from(
        { length: indexAccessor?.getCount() ?? positions.getCount() },
        (_, index) => indexAccessor?.getScalar(index) ?? index,
      );
      const world = new Map<number, Point>();
      const positionAt = (index: number): Point => {
        const previous = world.get(index);
        if (previous) {
          return previous;
        }
        if (!Number.isInteger(index) || index < 0 || index >= positions.getCount()) {
          throw new Error('GLB contains an invalid vertex index');
        }
        const point = positions.getElement(index, []);
        const [x = Number.NaN, y = Number.NaN, z = Number.NaN] = point;
        const transformed: Point = [
          matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
          matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
          matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
        ];
        if (!transformed.every((value) => Number.isFinite(value))) {
          throw new Error('GLB contains non-finite scene positions');
        }
        world.set(index, transformed);
        return transformed;
      };
      for (const [ia, ib, ic] of triangleIndices(primitive.getMode(), indices)) {
        const a = positionAt(ia);
        const b = positionAt(ib);
        const c = positionAt(ic);
        const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
        const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
        const cross = [
          ab[1] * ac[2] - ab[2] * ac[1],
          ab[2] * ac[0] - ab[0] * ac[2],
          ab[0] * ac[1] - ab[1] * ac[0],
        ] as const;
        surfaceArea += Math.hypot(...cross) / 2;
        signedVolume +=
          (a[0] * (b[1] * c[2] - b[2] * c[1]) +
            a[1] * (b[2] * c[0] - b[0] * c[2]) +
            a[2] * (b[0] * c[1] - b[1] * c[0])) /
          6;
        for (const vertex of [a, b, c]) {
          for (const axis of [0, 1, 2] as const) {
            minimum[axis] = Math.min(minimum[axis], vertex[axis]);
            maximum[axis] = Math.max(maximum[axis], vertex[axis]);
          }
        }
        triangles += 1;
        hasSurface = true;
      }
    }
    if (hasSurface) {
      meshInstances += 1;
    }
  });
  if (triangles === 0 || surfaceArea <= 0) {
    throw new Error('GLB contains no nonempty triangle surface');
  }
  const min: Point = [minimum[0] * 1000, minimum[1] * 1000, minimum[2] * 1000];
  const max: Point = [maximum[0] * 1000, maximum[1] * 1000, maximum[2] * 1000];
  const size: Point = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return {
    triangles,
    meshInstances,
    boundsMm: { min, max, size },
    signedVolumeMm3: signedVolume * 1e9,
    surfaceAreaMm2: surfaceArea * 1e6,
  };
};

/** Compare world-space envelopes; disagreement is an assertion, never a log-only cross. */
export const assertBoundsParity = (
  reference: Pick<GeometrySummary, 'boundsMm'>,
  actual: Pick<GeometrySummary, 'boundsMm'>,
  toleranceMm = 0.5,
): void => {
  const differences = reference.boundsMm.min.map((value, axis) => Math.abs(value - actual.boundsMm.min[axis]!));
  differences.push(...reference.boundsMm.max.map((value, axis) => Math.abs(value - actual.boundsMm.max[axis]!)));
  const delta = Math.max(...differences);
  if (!Number.isFinite(delta) || delta > toleranceMm) {
    throw new Error(
      `Geometry bounds differ by ${delta.toFixed(3)} mm (limit ${toleranceMm} mm): expected ${JSON.stringify(reference.boundsMm)}, received ${JSON.stringify(actual.boundsMm)}`,
    );
  }
};
