/**
 * A 3D vertex position in Cartesian coordinates (e.g., `[1.5, -2.0, 0.0]`).
 */
export type Vertex = [number, number, number];

/**
 * A polygonal face defined by vertex indices.
 *
 * Contains an ordered list of vertex indices that form a polygon.
 * During glTF export, faces with 4+ vertices are triangulated using fan triangulation
 * (e.g., `[0, 1, 2]` for a triangle, `[0, 1, 2, 3]` for a quad split into two triangles).
 */
export type Face = number[];

/**
 * RGBA color components in normalized range [0.0, 1.0]
 * (e.g., `[1.0, 0.0, 0.0, 1.0]` for opaque red, `[0.0, 0.0, 1.0, 0.5]` for semi-transparent blue).
 */
export type Color = [number, number, number, number]; // RGBA values 0-1

/**
 * A complete 3D mesh representation using indexed geometry.
 *
 * This is the primary data structure for representing 3D geometries before
 * conversion to rendering formats like glTF. It uses an indexed approach
 * where faces reference shared vertices by index, which is memory efficient
 * and preserves topological relationships.
 */
export type IndexedPolyhedron = {
  /**
   * Array of unique 3D vertex positions.
   *
   * Each vertex is shared by multiple faces, reducing memory usage.
   * The index of each vertex in this array is used to reference it from faces.
   *
   * @example <caption>Vertex position data</caption>
   * ```text
   * // A simple pyramid with 4 vertices:
   * vertices: [
   *   [0, 0, 0],    // base vertex 0
   *   [1, 0, 0],    // base vertex 1
   *   [0.5, 1, 0],  // base vertex 2
   *   [0.5, 0.5, 1] // apex vertex 3
   * ]
   * ```
   */
  vertices: Vertex[];

  /**
   * Array of polygonal faces, each defined by vertex indices.
   *
   * Each face is a polygon defined by an ordered sequence of vertex indices.
   * The winding order determines the face normal direction (typically counter-clockwise = outward).
   * Faces can be triangles, quads, or higher-order polygons.
   *
   * During glTF export:
   * - Triangles are used directly
   * - Quads and n-gons are triangulated using fan triangulation from the first vertex
   *
   * @example <caption>Triangular face indices</caption>
   * ```text
   * // Continuing the pyramid example:
   * faces: [
   *   [0, 1, 2],    // triangular base face
   *   [0, 3, 1],    // triangular side face 1
   *   [1, 3, 2],    // triangular side face 2
   *   [2, 3, 0]     // triangular side face 3
   * ]
   * ```
   */
  faces: Face[];

  /**
   * Array of face colors, one per face.
   *
   * Each color corresponds to a face at the same index in the faces array.
   * During glTF export, face colors are replicated to all vertices of the
   * triangles created from that face during triangulation.
   *
   * @example <caption>Per-face color assignment</caption>
   * ```text
   * // Continuing the pyramid example (4 faces = 4 colors):
   * colors: [
   *   [0.8, 0.8, 0.8], // gray base
   *   [1.0, 0.0, 0.0], // red side 1
   *   [0.0, 1.0, 0.0], // green side 2
   *   [0.0, 0.0, 1.0]  // blue side 3
   * ]
   * ```
   */
  colors: Color[];

  /**
   * Optional line data for edges and wireframe display.
   *
   * Contains geometric line segments that represent edges, wireframes,
   * or other linear features. This data is preserved separately from
   * the face geometry and can be rendered as line segments in 3D viewers.
   */
  lines?: {
    /**
     * Flattened array of line endpoint positions.
     *
     * Format: [x1, y1, z1, x2, y2, z2, x3, y3, z3, ...]
     * - Every 6 consecutive numbers define one line segment
     * - Line segment from (x1,y1,z1) to (x2,y2,z2)
     * - Next line segment from (x3,y3,z3) to (x4,y4,z4), etc.
     *
     * @example <caption>Flattened line segment pairs</caption>
     * ```text
     * // Two line segments:
     * // Line 1: from (0,0,0) to (1,0,0)
     * // Line 2: from (1,0,0) to (1,1,0)
     * positions: [0,0,0, 1,0,0, 1,0,0, 1,1,0]
     * ```
     */
    positions: number[];

    /**
     * Optional grouping information for line segments.
     *
     * Allows logical grouping of line segments that belong to the same
     * geometric edge or feature. Useful for preserving original CAD
     * edge information during export/import cycles.
     */
    edgeGroups?: Array<{
      /**
       * Starting index in the positions array, in groups of 6 values per line segment
       * (e.g., `0` for the first line segment).
       */
      start: number;

      /**
       * Number of line segments in this group (e.g., `3` for three line segments).
       */
      count: number;

      /**
       * Unique identifier for the original geometric edge.
       * Used to maintain edge identity across format conversions.
       */
      edgeId: number;
    }>;
  };
};

/**
 * Transform vertex coordinates from z-up to y-up coordinate system and convert units.
 * Z-up to Y-up transformation: x' = x, y' = z, z' = -y
 * Unit conversion: millimeters to meters (divide by 1000)
 *
 * This is used when creating glTF format, which uses y-up coordinates
 * and meter units, from source geometry that uses z-up coordinates and millimeter units.
 *
 * @param vertex - xyz position in z-up millimeter space
 * @returns xyz position in y-up meter space
 */
export function transformVerticesGltf(vertex: readonly [number, number, number]): [number, number, number] {
  const x = vertex[0] / 1000;
  const y = vertex[2] / 1000;
  const z = -vertex[1] / 1000;

  // Normalize -0 to 0 to avoid JavaScript signed zero quirks
  return [x === 0 ? 0 : x, y === 0 ? 0 : y, z === 0 ? 0 : z];
}

/**
 * Convert vertex units from millimeters to meters without coordinate system transformation.
 * Used when the output coordinate system matches the source (z-up → z-up).
 *
 * @param vertex - xyz position in millimeter space
 * @returns xyz position in meter space
 */
export function transformVerticesZup(vertex: readonly [number, number, number]): [number, number, number] {
  const x = vertex[0] / 1000;
  const y = vertex[1] / 1000;
  const z = vertex[2] / 1000;

  return [x === 0 ? 0 : x, y === 0 ? 0 : y, z === 0 ? 0 : z];
}

/** Vertex transform function signature for coordinate system selection. */
export type VertexTransformFunction = (vertex: readonly [number, number, number]) => [number, number, number];

/**
 * Transform a flat array of vertex positions from z-up to y-up coordinate system and convert units.
 *
 * Processes a flat array of vertex coordinates in groups of 3, applying both coordinate
 * system transformation (z-up to y-up) and unit conversion (mm to meters).
 *
 * This is a convenience wrapper around transformVerticesGltf for processing multiple vertices
 * in a flat array format commonly used in mesh data.
 *
 * @param vertices - Flat array of vertex positions [x1, y1, z1, x2, y2, z2, ...]
 * @returns Float32Array with transformed positions
 */
export function transformVertexArray(vertices: number[]): Float32Array<ArrayBuffer> {
  const transformedVertices = new Float32Array(vertices.length);

  for (let index = 0; index < vertices.length; index += 3) {
    const x = vertices[index];
    const y = vertices[index + 1];
    const z = vertices[index + 2];

    if (x === undefined || y === undefined || z === undefined) {
      continue;
    }

    const vertex: [number, number, number] = [x, y, z];
    const transformed = transformVerticesGltf(vertex);

    transformedVertices[index] = transformed[0];
    transformedVertices[index + 1] = transformed[1];
    transformedVertices[index + 2] = transformed[2];
  }

  return transformedVertices;
}

/**
 * Transform normal vectors from z-up to y-up coordinate system.
 * Unlike vertices, normals are direction vectors so no unit conversion is needed.
 * Z-up to Y-up transformation: x' = x, y' = z, z' = -y
 *
 * @param normals - Flat array of normal components [x1, y1, z1, x2, y2, z2, ...]
 * @returns Float32Array with transformed normals
 */
export function transformNormalArray(normals: number[]): Float32Array<ArrayBuffer> {
  const transformedNormals = new Float32Array(normals.length);

  for (let index = 0; index < normals.length; index += 3) {
    const x = normals[index] ?? 0;
    const y = normals[index + 1] ?? 0;
    const z = normals[index + 2] ?? 0;

    // Apply rotation only (no scaling for direction vectors)
    // Z-up to Y-up: x' = x, y' = z, z' = -y
    transformedNormals[index] = x;
    transformedNormals[index + 1] = z;
    transformedNormals[index + 2] = -y;
  }

  return transformedNormals;
}
