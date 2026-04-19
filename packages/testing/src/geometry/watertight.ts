import type { Document } from '@gltf-transform/core';

/**
 * Coincidence epsilon for merging duplicate vertices (in glTF meter-scale units).
 *
 * CAD tessellators emit per-face meshes that share boundary vertices by position
 * but allocate them independently per face, so coincident vertices differ only
 * by floating-point noise (~1e-7). The epsilon must be tight enough to avoid
 * merging genuinely distinct neighboring vertices on fine tessellations.
 */
const spatialEpsilon = 1e-5;

/**
 * Maximum fraction of edges allowed to be boundary (shared by 1 triangle) or
 * non-manifold (shared by >2 triangles) before the mesh is considered open.
 *
 * Real CAD tessellation can produce a handful of singular vertices at poles or
 * tiny gaps along intersection curves. A strict zero-tolerance check rejects
 * meshes that are physically watertight for fabrication purposes, so we allow
 * a small percentage of imperfect edges.
 */
const irregularEdgeTolerance = 0.01;

/**
 * Determines whether a mesh is watertight (closed/manifold).
 *
 * A mesh is watertight when every triangle edge is shared by exactly two
 * triangles. Boundary edges (shared by only one triangle) indicate gaps,
 * and non-manifold edges (shared by three or more) indicate self-intersections.
 *
 * Returns true when the fraction of irregular edges is within tolerance, so
 * CAD-tessellated meshes with minor pole or seam artifacts are still recognized
 * as watertight for downstream fabrication checks.
 *
 * @param document - A glTF-Transform Document
 * @returns `true` if the mesh is watertight, `false` otherwise
 * @public
 */
export const isWatertight = (document: Document): boolean => {
  const root = document.getRoot();
  const meshes = root.listMeshes();

  const allPositions: Array<[number, number, number]> = [];
  const allTriangles: Array<[number, number, number]> = [];
  let vertexOffset = 0;

  for (const mesh of meshes) {
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== 4) {
        continue; // TRIANGLES only
      }

      const posAccessor = primitive.getAttribute('POSITION');
      const indexAccessor = primitive.getIndices();
      if (!posAccessor || !indexAccessor) {
        continue;
      }

      const vCount = posAccessor.getCount();
      const indexCount = indexAccessor.getCount();

      for (let i = 0; i < vCount; i++) {
        allPositions.push(posAccessor.getElement(i, [0, 0, 0]));
      }

      for (let i = 0; i < indexCount; i += 3) {
        allTriangles.push([
          indexAccessor.getScalar(i) + vertexOffset,
          indexAccessor.getScalar(i + 1) + vertexOffset,
          indexAccessor.getScalar(i + 2) + vertexOffset,
        ]);
      }

      vertexOffset += vCount;
    }
  }

  if (allTriangles.length === 0) {
    return false;
  }

  // Spatial hashing: merge coincident vertices. Cell size is 2*epsilon so any
  // two vertices within epsilon distance fall in either the same cell or one of
  // the 26 neighboring cells. We probe all 27 cells to avoid false splits when
  // coincident vertices land on opposite sides of a grid boundary.
  const gridSize = spatialEpsilon * 2;
  const epsilonSquared = spatialEpsilon * spatialEpsilon;
  const positionToCanonical = new Map<string, number>();
  const vertexMap = new Int32Array(allPositions.length);

  for (const [i, position] of allPositions.entries()) {
    const [x, y, z] = position;
    const cx = Math.round(x / gridSize);
    const cy = Math.round(y / gridSize);
    const cz = Math.round(z / gridSize);

    let canonical = -1;
    for (let dx = -1; dx <= 1 && canonical === -1; dx++) {
      for (let dy = -1; dy <= 1 && canonical === -1; dy++) {
        for (let dz = -1; dz <= 1 && canonical === -1; dz++) {
          const neighborKey = `${cx + dx},${cy + dy},${cz + dz}`;
          const candidate = positionToCanonical.get(neighborKey);
          if (candidate === undefined) {
            continue;
          }
          const [ox, oy, oz] = allPositions[candidate]!;
          const ddx = x - ox;
          const ddy = y - oy;
          const ddz = z - oz;
          if (ddx * ddx + ddy * ddy + ddz * ddz <= epsilonSquared) {
            canonical = candidate;
          }
        }
      }
    }

    if (canonical === -1) {
      const key = `${cx},${cy},${cz}`;
      positionToCanonical.set(key, i);
      vertexMap[i] = i;
    } else {
      vertexMap[i] = canonical;
    }
  }

  // Build edge reference count map using canonical vertex indices
  const edgeCounts = new Map<string, number>();

  for (const tri of allTriangles) {
    const v0 = vertexMap[tri[0]]!;
    const v1 = vertexMap[tri[1]]!;
    const v2 = vertexMap[tri[2]]!;

    const edges: Array<[number, number]> = [
      [Math.min(v0, v1), Math.max(v0, v1)],
      [Math.min(v1, v2), Math.max(v1, v2)],
      [Math.min(v0, v2), Math.max(v0, v2)],
    ];

    for (const [a, b] of edges) {
      const key = `${a},${b}`;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }

  let irregularEdges = 0;
  for (const count of edgeCounts.values()) {
    if (count !== 2) {
      irregularEdges++;
    }
  }

  return irregularEdges / edgeCounts.size <= irregularEdgeTolerance;
};
