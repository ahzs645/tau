import type { IndexedPolyhedron } from '#framework/common.js';

/**
 * Calculate the normal vector for a triangle
 *
 * @param v1 - first vertex of the triangle
 * @param v2 - second vertex of the triangle
 * @param v3 - third vertex of the triangle
 * @returns the normalized normal vector, or [0, 0, 1] for degenerate triangles
 */
function calculateNormal(v1: number[], v2: number[], v3: number[]): number[] {
  // Validate vertices have at least 3 components
  if (v1.length < 3 || v2.length < 3 || v3.length < 3) {
    return [0, 0, 1]; // Default normal
  }

  // Calculate two edge vectors with safe access
  const edge1 = [v2[0]! - v1[0]!, v2[1]! - v1[1]!, v2[2]! - v1[2]!];
  const edge2 = [v3[0]! - v1[0]!, v3[1]! - v1[1]!, v3[2]! - v1[2]!];

  // Calculate cross product (normal)
  const normal = [
    edge1[1]! * edge2[2]! - edge1[2]! * edge2[1]!,
    edge1[2]! * edge2[0]! - edge1[0]! * edge2[2]!,
    edge1[0]! * edge2[1]! - edge1[1]! * edge2[0]!,
  ];

  // Normalize the vector
  const length = Math.hypot(normal[0]!, normal[1]!, normal[2]!);

  if (length > 0) {
    return [normal[0]! / length, normal[1]! / length, normal[2]! / length];
  }

  return [0, 0, 1]; // Default normal if calculation fails
}

/**
 * Creates an ASCII-format STL file from mesh data using fan triangulation.
 *
 * @param meshData - the polyhedron geometry (vertices and faces) to export
 * @returns the STL content as a UTF-8-encoded byte array
 */
export function createStlAscii(meshData: IndexedPolyhedron): Uint8Array<ArrayBuffer> {
  const { vertices, faces } = meshData;
  let stlContent = 'solid model\n';

  // Process each face
  for (const face of faces) {
    if (face.length < 3) {
      continue; // Skip invalid faces
    }

    // Triangulate face using fan triangulation
    for (let index = 1; index < face.length - 1; index++) {
      const index1 = face[0];
      const index2 = face[index];
      const index3 = face[index + 1];

      if (index1 === undefined || index2 === undefined || index3 === undefined) {
        continue;
      }

      const v1 = vertices[index1];
      const v2 = vertices[index2];
      const v3 = vertices[index3];

      if (!v1 || !v2 || !v3) {
        continue;
      }

      // Calculate normal
      const normal = calculateNormal(v1, v2, v3);

      // Write triangle to STL
      stlContent += `  facet normal ${normal[0]!} ${normal[1]!} ${normal[2]!}\n`;
      stlContent += '    outer loop\n';
      stlContent += `      vertex ${v1[0]} ${v1[1]} ${v1[2]}\n`;
      stlContent += `      vertex ${v2[0]} ${v2[1]} ${v2[2]}\n`;
      stlContent += `      vertex ${v3[0]} ${v3[1]} ${v3[2]}\n`;
      stlContent += '    endloop\n';
      stlContent += '  endfacet\n';
    }
  }

  stlContent += 'endsolid model\n';

  return new TextEncoder().encode(stlContent);
}

/**
 * Creates a binary-format STL file from mesh data using fan triangulation.
 *
 * @param meshData - the polyhedron geometry (vertices and faces) to export
 * @returns the STL binary as a byte array
 */
export function createStlBinary(meshData: IndexedPolyhedron): Uint8Array<ArrayBuffer> {
  const { vertices, faces } = meshData;

  // Calculate total number of triangles
  let totalTriangles = 0;
  for (const face of faces) {
    if (face.length >= 3) {
      totalTriangles += face.length - 2; // Fan triangulation
    }
  }

  // Binary STL format:
  // 80-byte header + 4-byte triangle count + (50 bytes per triangle)
  const headerSize = 80;
  const triangleCountSize = 4;
  const triangleSize = 50; // 12 bytes normal + 36 bytes vertices + 2 bytes attribute
  const totalSize = headerSize + triangleCountSize + totalTriangles * triangleSize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  // Write header (80 bytes, can be anything)
  const headerText = 'Binary STL exported from OpenSCAD';
  const headerBytes = new TextEncoder().encode(headerText);
  for (let index = 0; index < Math.min(headerBytes.length, headerSize); index++) {
    view.setUint8(index, headerBytes[index]!);
  }

  // Write triangle count
  view.setUint32(headerSize, totalTriangles, true); // Little-endian

  let offset = headerSize + triangleCountSize;

  // Process each face
  for (const face of faces) {
    if (face.length < 3) {
      continue; // Skip invalid faces
    }

    // Triangulate face using fan triangulation
    for (let index = 1; index < face.length - 1; index++) {
      const index1 = face[0];
      const index2 = face[index];
      const index3 = face[index + 1];

      if (index1 === undefined || index2 === undefined || index3 === undefined) {
        continue;
      }

      const v1 = vertices[index1];
      const v2 = vertices[index2];
      const v3 = vertices[index3];

      if (!v1 || !v2 || !v3) {
        continue;
      }

      // Calculate normal
      const normal = calculateNormal(v1, v2, v3);

      // Write normal (12 bytes)
      view.setFloat32(offset, normal[0]!, true);
      view.setFloat32(offset + 4, normal[1]!, true);
      view.setFloat32(offset + 8, normal[2]!, true);
      offset += 12;

      // Write vertices (36 bytes total)
      // Vertex 1
      view.setFloat32(offset, v1[0], true);
      view.setFloat32(offset + 4, v1[1], true);
      view.setFloat32(offset + 8, v1[2], true);
      offset += 12;

      // Vertex 2
      view.setFloat32(offset, v2[0], true);
      view.setFloat32(offset + 4, v2[1], true);
      view.setFloat32(offset + 8, v2[2], true);
      offset += 12;

      // Vertex 3
      view.setFloat32(offset, v3[0], true);
      view.setFloat32(offset + 4, v3[1], true);
      view.setFloat32(offset + 8, v3[2], true);
      offset += 12;

      // Write attribute byte count (2 bytes, usually 0)
      view.setUint16(offset, 0, true);
      offset += 2;
    }
  }

  return new Uint8Array(buffer);
}
