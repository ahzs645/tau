import type { Document } from '@gltf-transform/core';

/** Epsilon for merging coincident vertices (in glTF meter-scale units). */
const spatialEpsilon = 0.001;

/**
 * Counts topologically disconnected pieces across all TRIANGLES primitives.
 * Uses spatial hashing to merge coincident vertices, then Union-Find to
 * determine how many connected components the triangle mesh contains.
 *
 * @param document - A glTF-Transform Document
 * @returns The number of connected components
 * @public
 */
export const countConnectedComponents = (document: Document): number => {
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
    return 0;
  }

  const gridSize = spatialEpsilon * 2;
  const positionToCanonical = new Map<string, number>();
  const vertexMap = new Int32Array(allPositions.length);

  for (const [i, position] of allPositions.entries()) {
    const [x, y, z] = position;
    const key = `${Math.round(x / gridSize)},${Math.round(y / gridSize)},${Math.round(z / gridSize)}`;

    const existing = positionToCanonical.get(key);
    if (existing === undefined) {
      positionToCanonical.set(key, i);
      vertexMap[i] = i;
    } else {
      vertexMap[i] = existing;
    }
  }

  const parent = new Int32Array(allTriangles.length);
  const rank = new Int32Array(allTriangles.length);
  for (let i = 0; i < allTriangles.length; i++) {
    parent[i] = i;
  }

  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };

  const union = (a: number, b: number): void => {
    a = find(a);
    b = find(b);
    if (a === b) {
      return;
    }
    if (rank[a]! < rank[b]!) {
      [a, b] = [b, a];
    }
    parent[b] = a;
    if (rank[a] === rank[b]) {
      rank[a]!++;
    }
  };

  const vertexToTriangles = new Map<number, number[]>();
  for (const [t, triangle] of allTriangles.entries()) {
    for (let j = 0; j < 3; j++) {
      const cv = vertexMap[triangle[j]!]!;
      let tris = vertexToTriangles.get(cv);
      if (!tris) {
        tris = [];
        vertexToTriangles.set(cv, tris);
      }
      tris.push(t);
    }
  }

  for (const tris of vertexToTriangles.values()) {
    for (let i = 1; i < tris.length; i++) {
      union(tris[0]!, tris[i]!);
    }
  }

  const roots = new Set<number>();
  for (let i = 0; i < allTriangles.length; i++) {
    roots.add(find(i));
  }

  return roots.size;
};
