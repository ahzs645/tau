/**
 * Edge detection algorithm for triangle meshes.
 *
 * This module ports the Three.js EdgesGeometry algorithm to work with raw typed arrays,
 * enabling edge detection to run in web workers without Three.js dependencies.
 *
 * The algorithm uses dihedral angle thresholding to identify sharp edges:
 * - For each edge shared by two triangles, compute the angle between face normals
 * - If the angle exceeds the threshold, the edge is considered "sharp" and rendered
 * - Boundary edges (edges with only one adjacent face) are always included
 */

/**
 * Coincidence tolerance for matching tessellated CAD vertices, in glTF meters.
 *
 * Kernel exporters often duplicate vertices at face boundaries. Those vertices
 * should still classify as one shared edge for preview outlines when they are
 * coincident within normal CAD tessellation noise.
 */
const vertexWeldTolerance = 1e-5;

/**
 * Degrees to radians conversion factor.
 */
const degreesToRadians = Math.PI / 180;

/**
 * Result of edge detection containing the edge geometry data.
 */
export type EdgeDetectionResult = {
  /**
   * Flat array of edge vertex positions [x1, y1, z1, x2, y2, z2, ...].
   * Each pair of vertices defines one edge.
   */
  positions: Float32Array<ArrayBuffer>;
  /**
   * Index array where each consecutive pair of indices defines an edge.
   * For LINES mode: [0, 1, 2, 3, ...] where (0,1) is first edge, (2,3) is second, etc.
   */
  indices: Uint32Array<ArrayBuffer>;
};

/**
 * Data stored for each edge during detection.
 */
type EdgeData = {
  /** Index of first vertex in the edge */
  index0: number;
  /** Index of second vertex in the edge */
  index1: number;
  /** Normal of the first face that encountered this edge [nx, ny, nz] */
  normal: Vertex3;
};

type TriangleEdge = {
  hash: string;
  reverseHash: string;
  index0: number;
  index1: number;
};

type EdgeProcessingState = {
  edgeData: Map<string, EdgeData | undefined>;
  edgeVertices: number[];
  thresholdCos: number;
  vertices: readonly Vertex3[];
};

/**
 * A 3D vertex as [x, y, z] tuple.
 */
type Vertex3 = [number, number, number];
type GridCell = [number, number, number];

function gridCell(position: Vertex3, gridSize: number): GridCell {
  const [x, y, z] = position;
  return [Math.round(x / gridSize), Math.round(y / gridSize), Math.round(z / gridSize)];
}

function cellKey(cell: GridCell): string {
  return `${cell[0]},${cell[1]},${cell[2]}`;
}

type WeldedVertexContext = {
  positions: readonly Vertex3[];
  positionToCanonical: Map<string, number>;
  toleranceSquared: number;
  gridSize: number;
};

function findCanonicalVertex(position: Vertex3, context: WeldedVertexContext): number {
  const [x, y, z] = position;
  const [cx, cy, cz] = gridCell(position, context.gridSize);

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const candidate = context.positionToCanonical.get(`${cx + dx},${cy + dy},${cz + dz}`);
        if (candidate === undefined) {
          continue;
        }

        const other = context.positions[candidate];
        if (!other) {
          continue;
        }

        const ox = x - other[0];
        const oy = y - other[1];
        const oz = z - other[2];
        if (ox * ox + oy * oy + oz * oz <= context.toleranceSquared) {
          return candidate;
        }
      }
    }
  }

  return -1;
}

function weldVertices(positions: Float32Array): { vertices: Vertex3[]; vertexMap: Int32Array } {
  const vertexCount = Math.floor(positions.length / 3);
  const vertices: Vertex3[] = [];
  const vertexMap = new Int32Array(vertexCount);
  const context: WeldedVertexContext = {
    positions: vertices,
    positionToCanonical: new Map(),
    toleranceSquared: vertexWeldTolerance * vertexWeldTolerance,
    gridSize: vertexWeldTolerance * 2,
  };

  for (let index = 0; index < vertexCount; index += 1) {
    const offset = index * 3;
    const vertex: Vertex3 = [positions[offset] ?? 0, positions[offset + 1] ?? 0, positions[offset + 2] ?? 0];
    vertices.push(vertex);

    const canonical = findCanonicalVertex(vertex, context);
    if (canonical === -1) {
      context.positionToCanonical.set(cellKey(gridCell(vertex, context.gridSize)), index);
      vertexMap[index] = index;
      continue;
    }

    vertexMap[index] = canonical;
  }

  return { vertices, vertexMap };
}

/**
 * Compute the normal of a triangle defined by three vertices.
 * Uses cross product of two edge vectors.
 *
 * @param vertices - Object containing three vertices of the triangle
 * @param vertices.a - First vertex of the triangle
 * @param vertices.b - Second vertex of the triangle
 * @param vertices.c - Third vertex of the triangle
 * @returns Normalized normal vector [nx, ny, nz]
 */
function computeNormal(vertices: { a: Vertex3; b: Vertex3; c: Vertex3 }): Vertex3 {
  const { a, b, c } = vertices;

  // Edge vectors: CB and AB
  const cbx = c[0] - b[0];
  const cby = c[1] - b[1];
  const cbz = c[2] - b[2];

  const abx = a[0] - b[0];
  const aby = a[1] - b[1];
  const abz = a[2] - b[2];

  // Cross product: CB × AB
  let nx = cby * abz - cbz * aby;
  let ny = cbz * abx - cbx * abz;
  let nz = cbx * aby - cby * abx;

  // Normalize
  const length = Math.hypot(nx, ny, nz);
  if (length > 0) {
    nx /= length;
    ny /= length;
    nz /= length;
  }

  return [nx, ny, nz];
}

/**
 * Compute dot product of two 3D vectors.
 *
 * @param a - first 3D vector
 * @param b - second 3D vector
 * @returns the dot product of the two vectors
 */
function dot(a: Vertex3, b: Vertex3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function getVertex(state: Pick<EdgeProcessingState, 'vertices'>, index: number): Vertex3 {
  return state.vertices[index] ?? [0, 0, 0];
}

function pushEdgeVertices(state: EdgeProcessingState, index0: number, index1: number): void {
  const [x0, y0, z0] = getVertex(state, index0);
  const [x1, y1, z1] = getVertex(state, index1);
  state.edgeVertices.push(x0, y0, z0, x1, y1, z1);
}

function processTriangleEdge(edge: TriangleEdge, normal: Vertex3, state: EdgeProcessingState): void {
  const existingEdge = state.edgeData.get(edge.reverseHash);

  if (existingEdge !== undefined) {
    const dotProduct = dot(normal, existingEdge.normal);
    if (dotProduct <= state.thresholdCos) {
      pushEdgeVertices(state, existingEdge.index0, existingEdge.index1);
    }

    // Mark the edge as processed by setting to undefined (not deleting), matching Three.js EdgesGeometry.
    state.edgeData.set(edge.reverseHash, undefined);
    return;
  }

  if (state.edgeData.has(edge.hash)) {
    return;
  }

  state.edgeData.set(edge.hash, {
    index0: edge.index0,
    index1: edge.index1,
    normal,
  });
}

function addBoundaryEdges(state: EdgeProcessingState): void {
  for (const edge of state.edgeData.values()) {
    if (edge !== undefined) {
      pushEdgeVertices(state, edge.index0, edge.index1);
    }
  }
}

/**
 * Detect edges in a triangle mesh using dihedral angle thresholding.
 *
 * This algorithm identifies "sharp" edges where the angle between adjacent face normals
 * exceeds the specified threshold. Boundary edges (with only one adjacent face) are
 * always included.
 *
 * The algorithm runs in O(n) time where n is the number of triangles, using hash-based
 * edge matching for efficient lookup.
 *
 * @internal
 *
 * @param positions - Flat array of vertex positions [x1, y1, z1, x2, y2, z2, ...]
 * @param indices - Optional index array. If undefined, vertices are processed sequentially as triangles.
 * @param thresholdDegrees - Angle threshold in degrees. Edges with dihedral angle greater than
 *   this value are considered sharp. Default is 30 degrees.
 * @returns Edge geometry data with positions and indices for LINES primitive mode
 *
 * @example <caption>Sharp edges from indexed mesh</caption>
 * ```typescript
 * const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
 * const indices = new Uint32Array([0, 1, 2]);
 * const edges = detectEdges(positions, indices, 30);
 * ```
 */
export function detectEdges(
  positions: Float32Array,
  indices: Uint32Array | Uint16Array | undefined,
  thresholdDegrees = 30,
): EdgeDetectionResult {
  // Convert threshold to cosine for dot product comparison
  const thresholdCos = Math.cos(thresholdDegrees * degreesToRadians);

  const { vertices, vertexMap } = weldVertices(positions);
  const state: EdgeProcessingState = {
    edgeData: new Map(),
    edgeVertices: [],
    thresholdCos,
    vertices,
  };

  // Determine number of triangles
  const indexCount = indices ? indices.length : positions.length / 3;
  const triangleCount = Math.floor(indexCount / 3);

  // Process each triangle
  for (let t = 0; t < triangleCount; t++) {
    // Get vertex indices for this triangle
    const index0 = indices ? (indices[t * 3] ?? 0) : t * 3;
    const i1 = indices ? (indices[t * 3 + 1] ?? 0) : t * 3 + 1;
    const i2 = indices ? (indices[t * 3 + 2] ?? 0) : t * 3 + 2;

    // Get vertex positions
    const a = getVertex(state, index0);
    const b = getVertex(state, i1);
    const c = getVertex(state, i2);

    // Compute face normal
    const normal = computeNormal({ a, b, c });

    // Welded vertex ids classify duplicated face-boundary vertices as shared.
    const vertexA = vertexMap[index0] ?? index0;
    const vertexB = vertexMap[i1] ?? i1;
    const vertexC = vertexMap[i2] ?? i2;

    // Skip degenerate triangles (where any two vertices weld to the same point)
    // This is critical for complex geometry like text where degenerate triangles
    // can create spurious edges between letters
    if (vertexA === vertexB || vertexB === vertexC || vertexC === vertexA) {
      continue;
    }

    // Process three edges of the triangle
    const edges: TriangleEdge[] = [
      {
        hash: `${vertexA}_${vertexB}`,
        reverseHash: `${vertexB}_${vertexA}`,
        index0,
        index1: i1,
      },
      {
        hash: `${vertexB}_${vertexC}`,
        reverseHash: `${vertexC}_${vertexB}`,
        index0: i1,
        index1: i2,
      },
      {
        hash: `${vertexC}_${vertexA}`,
        reverseHash: `${vertexA}_${vertexC}`,
        index0: i2,
        index1: index0,
      },
    ];

    for (const edge of edges) {
      processTriangleEdge(edge, normal, state);
    }
  }

  // Add remaining edges as boundary edges (edges with only one adjacent face)
  // Skip processed edges (those set to undefined after matching)
  addBoundaryEdges(state);

  // Create output arrays
  const edgeCount = state.edgeVertices.length / 6; // 6 floats per edge (2 vertices × 3 coords)
  const outputPositions = new Float32Array(state.edgeVertices);
  const outputIndices = new Uint32Array(edgeCount * 2);

  // Generate sequential indices for LINES mode
  for (let index = 0; index < edgeCount * 2; index++) {
    outputIndices[index] = index;
  }

  return {
    positions: outputPositions,
    indices: outputIndices,
  };
}
