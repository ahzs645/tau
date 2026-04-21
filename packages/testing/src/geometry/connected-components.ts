import type { Document } from '@gltf-transform/core';

type Aabb = { min: [number, number, number]; max: [number, number, number] };

const computePrimitiveAabb = (positions: Float32Array): Aabb | undefined => {
  if (positions.length < 3) {
    return undefined;
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const v = positions[i + axis]!;
      if (v < min[axis]!) {
        min[axis] = v;
      }
      if (v > max[axis]!) {
        max[axis] = v;
      }
    }
  }
  return { min, max };
};

const aabbsOverlapWithin = (a: Aabb, b: Aabb, toleranceMeters: number): boolean => {
  for (let axis = 0; axis < 3; axis++) {
    if (a.max[axis]! + toleranceMeters < b.min[axis]!) {
      return false;
    }
    if (b.max[axis]! + toleranceMeters < a.min[axis]!) {
      return false;
    }
  }
  return true;
};

/**
 * Counts spatially-disjoint chunks across all TRIANGLES primitives by
 * clustering primitives whose axis-aligned bounding boxes overlap (within the
 * provided `toleranceMm`). Operates purely on glTF positions — no kernel
 * `extras`, no scene metadata, no per-kernel cooperation. Future kernels
 * emit valid glTF and the check works.
 *
 * @param document - A glTF-Transform Document (positions are in glTF meter units)
 * @param toleranceMm - Maximum gap (mm) between two primitive AABBs that
 *   still counts as connected. Use a tight value (e.g. 0.1) to detect
 *   visibly-disjoint chunks; raise it (e.g. 50) when intentional small gaps
 *   between touching parts must collapse into one cluster.
 * @returns The number of distinct spatial clusters
 * @public
 */
export const countConnectedComponents = (document: Document, toleranceMm: number): number => {
  const toleranceMeters = toleranceMm / 1000;
  const aabbs: Aabb[] = [];

  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== 4) {
        continue;
      }
      const pos = primitive.getAttribute('POSITION');
      if (!pos) {
        continue;
      }
      const positions = pos.getArray();
      if (!positions) {
        continue;
      }
      const aabb = computePrimitiveAabb(positions as Float32Array);
      if (aabb) {
        aabbs.push(aabb);
      }
    }
  }

  if (aabbs.length === 0) {
    return 0;
  }

  // Union-Find over primitives. O(N^2) overlap test is acceptable for the
  // primitive counts we see in practice (< low hundreds); switch to a
  // sweep-line / R-tree only if profiling demands it.
  const parent = aabbs.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i]! !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent[ra] = rb;
    }
  };

  for (let i = 0; i < aabbs.length; i++) {
    for (let j = i + 1; j < aabbs.length; j++) {
      if (aabbsOverlapWithin(aabbs[i]!, aabbs[j]!, toleranceMeters)) {
        union(i, j);
      }
    }
  }

  const roots = new Set<number>();
  for (let i = 0; i < aabbs.length; i++) {
    roots.add(find(i));
  }
  return roots.size;
};
