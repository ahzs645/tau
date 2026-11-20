import type { GlbManifoldTopology, GlbPrimitive } from '@taucad/geometry-core';
import { closedNativeTopology } from '#runtime/classic/topology.js';

type NativeTriangle = readonly [number, number, number];

/** Match the pinned Assimp float arithmetic, including cross-product cancellation and squared-area underflow. */
const finiteSerializedTriangle = (positions: Float32Array, offset: number): boolean => {
  const [ax = Number.NaN, ay = Number.NaN, az = Number.NaN] = positions.subarray(offset, offset + 3);
  const [bx = Number.NaN, by = Number.NaN, bz = Number.NaN] = positions.subarray(offset + 3, offset + 6);
  const [cx = Number.NaN, cy = Number.NaN, cz = Number.NaN] = positions.subarray(offset + 6, offset + 9);
  const ux = Math.fround(bx - ax);
  const uy = Math.fround(by - ay);
  const uz = Math.fround(bz - az);
  const vx = Math.fround(cx - ax);
  const vy = Math.fround(cy - ay);
  const vz = Math.fround(cz - az);
  const nx = Math.fround(Math.fround(uy * vz) - Math.fround(uz * vy));
  const ny = Math.fround(Math.fround(uz * vx) - Math.fround(ux * vz));
  const nz = Math.fround(Math.fround(ux * vy) - Math.fround(uy * vx));
  const areaSquared = Math.fround(Math.fround(Math.fround(nx * nx) + Math.fround(ny * ny)) + Math.fround(nz * nz));
  return Number.isFinite(areaSquared) && areaSquared > 0;
};

const nativeRepresentatives = (triangles: readonly NativeTriangle[]): Uint32Array<ArrayBuffer> => {
  const representatives = new Map<number, number>();
  const canonical = new Uint32Array(triangles.length * 3);
  let corner = 0;
  for (const triangle of triangles) {
    for (const nativeVertex of triangle) {
      const representative = representatives.get(nativeVertex) ?? corner;
      representatives.set(nativeVertex, representative);
      canonical[corner] = representative;
      corner += 1;
    }
  }
  return canonical;
};

/**
 * Preserve a closed native surface across face-color primitives. Shared attributes retain the exact render
 * corners and flat normals; canonical indices only identify corners that came from the same OFF vertex.
 * The public writer independently validates exact position identity, closure, winding and vertex links.
 */
export const classicCanonicalSurface = (
  surfaces: readonly GlbPrimitive[],
  triangles: readonly NativeTriangle[],
): { primitives: GlbPrimitive[]; topology: GlbManifoldTopology } | undefined => {
  if (surfaces.length < 2 || !closedNativeTopology(triangles)) {
    return undefined;
  }
  const count = surfaces.reduce((total, primitive) => total + primitive.positions.length, 0);
  if (count !== triangles.length * 9) {
    throw new Error('Classic OFF render and native triangle streams do not correspond.');
  }
  const positions = new Float32Array(count);
  const normals = new Float32Array(count);
  const primitives: GlbPrimitive[] = [];
  let offset = 0;
  for (const primitive of surfaces) {
    if (
      primitive.mode !== 4 ||
      primitive.indices !== undefined ||
      primitive.normals?.length !== primitive.positions.length
    ) {
      throw new Error('Classic OFF canonical mapping requires complete triangle corner attributes.');
    }
    positions.set(primitive.positions, offset);
    normals.set(primitive.normals, offset);
    const start = offset / 3;
    const indices = Uint32Array.from({ length: primitive.positions.length / 3 }, (_unused, index) => start + index);
    primitives.push({ ...primitive, positions, normals, indices });
    offset += primitive.positions.length;
  }
  if (!positions.every((value) => Number.isFinite(value)) || !normals.every((value) => Number.isFinite(value))) {
    return undefined;
  }
  for (let corner = 0; corner < positions.length; corner += 9) {
    if (!finiteSerializedTriangle(positions, corner)) {
      return undefined;
    }
  }
  return { primitives, topology: { indices: nativeRepresentatives(triangles) } };
};
