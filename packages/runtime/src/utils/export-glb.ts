import type { Primitive } from '@gltf-transform/core';
import { Document, NodeIO } from '@gltf-transform/core';
import { cadMaterialDefaults } from '@taucad/types/constants';
import type { Color, IndexedPolyhedron } from '#framework/common.js';
import { transformVerticesGltf } from '#framework/common.js';

/**
 * Geometry data for a single color group, optimized for glTF primitive creation.
 *
 * Each color group becomes a separate primitive with its own material.
 * This approach (like Replicad) ensures proper rendering of opaque vs transparent geometry.
 */
type ColorGroupGeometry = {
  /** The RGBA color for this group's material */
  color: Color;
  /** Flattened vertex positions [x1,y1,z1, x2,y2,z2, ...] */
  positions: Float32Array<ArrayBuffer>;
  /** Triangle indices [i1,i2,i3, ...] */
  indices: Uint32Array<ArrayBuffer>;
  /** Per-vertex normals [nx1,ny1,nz1, ...] */
  normals: Float32Array<ArrayBuffer>;
};

/**
 * Convert RGBA color to a unique string key for grouping.
 * Uses fixed precision to handle floating point variations.
 *
 * @param color - the RGBA color tuple
 * @returns a comma-separated string key for the color
 */
function colorToKey(color: Color): string {
  return `${color[0].toFixed(4)},${color[1].toFixed(4)},${color[2].toFixed(4)},${color[3].toFixed(4)}`;
}

/**
 * Calculate the normal vector for a triangle using cross product.
 * The normal points in the direction determined by the right-hand rule
 * when traversing vertices v1 -> v2 -> v3 counter-clockwise.
 *
 * @param v1 - First vertex of the triangle
 * @param v2 - Second vertex of the triangle
 * @param v3 - Third vertex of the triangle
 * @returns Normalized normal vector [nx, ny, nz]
 */
function calculateTriangleNormal(
  v1: readonly [number, number, number],
  v2: readonly [number, number, number],
  v3: readonly [number, number, number],
): [number, number, number] {
  // Calculate two edge vectors
  const edge1X = v2[0] - v1[0];
  const edge1Y = v2[1] - v1[1];
  const edge1Z = v2[2] - v1[2];

  const edge2X = v3[0] - v1[0];
  const edge2Y = v3[1] - v1[1];
  const edge2Z = v3[2] - v1[2];

  // Calculate cross product: edge1 × edge2
  const normalX = edge1Y * edge2Z - edge1Z * edge2Y;
  const normalY = edge1Z * edge2X - edge1X * edge2Z;
  const normalZ = edge1X * edge2Y - edge1Y * edge2X;

  // Normalize the vector
  const length = Math.hypot(normalX, normalY, normalZ);

  if (length === 0) {
    // Degenerate triangle, return arbitrary normal
    return [0, 0, 1];
  }

  return [normalX / length, normalY / length, normalZ / length];
}

/**
 * Create a primitive from color group geometry data.
 * Each color group gets its own material with the correct alphaMode.
 *
 * @param document - the glTF document to create the primitive in
 * @param geometry - the color group geometry with positions, indices, normals, and color
 * @returns the constructed glTF primitive
 */
function createPrimitiveFromColorGroup(document: Document, geometry: ColorGroupGeometry): Primitive {
  const { color, positions, indices, normals } = geometry;

  // Set alpha mode based on whether THIS color has transparency
  const alphaMode = color[3] < 1 ? 'BLEND' : 'OPAQUE';

  const material = document
    .createMaterial()
    .setDoubleSided(true)
    .setAlphaMode(alphaMode)
    .setMetallicFactor(cadMaterialDefaults.metallicFactor)
    .setRoughnessFactor(cadMaterialDefaults.roughnessFactor)
    .setBaseColorFactor(color);

  // Name the material for debugging
  const colorString = `rgba(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(color[2] * 255)},${color[3].toFixed(2)})`;
  material.setName(colorString);

  const primitive = document
    .createPrimitive()
    .setMode(4) // TRIANGLES mode
    .setMaterial(material)
    .setAttribute('POSITION', document.createAccessor().setType('VEC3').setArray(positions))
    .setAttribute('NORMAL', document.createAccessor().setType('VEC3').setArray(normals))
    .setIndices(document.createAccessor().setType('SCALAR').setArray(indices));

  return primitive;
}

/**
 * Triangle data collected during face processing.
 */
type TriangleData = {
  v1: [number, number, number];
  v2: [number, number, number];
  v3: [number, number, number];
  normal: [number, number, number];
};

/**
 * Group faces by their unique color and convert to geometry arrays.
 * Each unique color becomes a separate ColorGroupGeometry.
 *
 * Always transforms vertices from Z-up/mm to Y-up/meters for spec-compliant GLTF.
 *
 * This approach (like Replicad) ensures:
 * - Opaque colors get OPAQUE materials
 * - Transparent colors get BLEND materials
 * - No vertex color issues with transparency
 *
 * @param meshData - the indexed polyhedron with vertices, faces, and colors
 * @returns array of color group geometries ready for primitive creation
 */
function groupFacesByColor(meshData: IndexedPolyhedron): ColorGroupGeometry[] {
  const { vertices, faces, colors } = meshData;

  // First pass: group triangles by color
  const colorGroups = new Map<string, { color: Color; triangles: TriangleData[] }>();

  for (const [faceIndex, face] of faces.entries()) {
    const faceColor: Color = colors[faceIndex] ?? [1, 1, 1, 1]; // Default to opaque white

    if (face.length < 3) {
      continue; // Skip invalid faces
    }

    const colorKey = colorToKey(faceColor);

    if (!colorGroups.has(colorKey)) {
      colorGroups.set(colorKey, { color: faceColor, triangles: [] });
    }

    const group = colorGroups.get(colorKey)!;

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

      // Transform vertices from z-up to y-up coordinate system and convert units (mm to m)
      const transformedV1 = transformVerticesGltf(v1);
      const transformedV2 = transformVerticesGltf(v2);
      const transformedV3 = transformVerticesGltf(v3);

      // Calculate normal for this triangle (after transformation)
      const normal = calculateTriangleNormal(transformedV1, transformedV2, transformedV3);

      group.triangles.push({
        v1: transformedV1,
        v2: transformedV2,
        v3: transformedV3,
        normal,
      });
    }
  }

  // Second pass: convert each color group to geometry arrays
  const geometries: ColorGroupGeometry[] = [];

  for (const { color, triangles } of colorGroups.values()) {
    if (triangles.length === 0) {
      continue;
    }

    const numberTriangles = triangles.length;
    const positions = new Float32Array(numberTriangles * 3 * 3);
    const normals = new Float32Array(numberTriangles * 3 * 3);
    const indices = new Uint32Array(numberTriangles * 3);

    let positionIndex = 0;
    let normalIndex = 0;

    for (let triIndex = 0; triIndex < numberTriangles; triIndex++) {
      const tri = triangles[triIndex]!;

      // Add positions
      positions[positionIndex++] = tri.v1[0];
      positions[positionIndex++] = tri.v1[1];
      positions[positionIndex++] = tri.v1[2];

      positions[positionIndex++] = tri.v2[0];
      positions[positionIndex++] = tri.v2[1];
      positions[positionIndex++] = tri.v2[2];

      positions[positionIndex++] = tri.v3[0];
      positions[positionIndex++] = tri.v3[1];
      positions[positionIndex++] = tri.v3[2];

      // Add normals (same normal for all vertices of this triangle - flat shading)
      normals[normalIndex++] = tri.normal[0];
      normals[normalIndex++] = tri.normal[1];
      normals[normalIndex++] = tri.normal[2];

      normals[normalIndex++] = tri.normal[0];
      normals[normalIndex++] = tri.normal[1];
      normals[normalIndex++] = tri.normal[2];

      normals[normalIndex++] = tri.normal[0];
      normals[normalIndex++] = tri.normal[1];
      normals[normalIndex++] = tri.normal[2];

      // Add triangle indices (non-indexed, each triangle uses its own vertices)
      indices[triIndex * 3] = triIndex * 3;
      indices[triIndex * 3 + 1] = triIndex * 3 + 1;
      indices[triIndex * 3 + 2] = triIndex * 3 + 2;
    }

    geometries.push({
      color,
      positions,
      normals,
      indices,
    });
  }

  return geometries;
}

/**
 * Create a GLTF document from mesh data (shared between GLB and GLTF exports).
 *
 * Always produces spec-compliant GLTF with Y-up coordinates and meter units.
 *
 * Uses the Replicad approach: each unique color gets its own primitive with its own material.
 * This ensures opaque geometry uses OPAQUE mode and transparent geometry uses BLEND mode.
 *
 * @param meshData - the indexed polyhedron to convert
 * @returns the constructed glTF document
 */
function createGltfDocument(meshData: IndexedPolyhedron): Document {
  const document = new Document();
  document.createBuffer();

  const scene = document.createScene();
  const mesh = document.createMesh();

  // Group faces by color and create geometry for each group
  const colorGroups = groupFacesByColor(meshData);

  if (colorGroups.length === 0) {
    // Create a simple point if no geometry
    const emptyGeometry: ColorGroupGeometry = {
      color: [1, 1, 1, 1],
      positions: new Float32Array([0, 0, 0]),
      normals: new Float32Array([0, 0, 1]),
      indices: new Uint32Array([0]),
    };
    const primitive = createPrimitiveFromColorGroup(document, emptyGeometry);
    mesh.addPrimitive(primitive);
  } else {
    // Create a primitive for each color group
    for (const colorGroup of colorGroups) {
      const primitive = createPrimitiveFromColorGroup(document, colorGroup);
      mesh.addPrimitive(primitive);
    }
  }

  const node = document.createNode().setMesh(mesh);
  scene.addChild(node);

  // Add lines as a separate mesh if available
  if (meshData.lines?.positions.length) {
    const linesMesh = document.createMesh();

    // Create line geometry - convert flat positions to Float32Array and transform coordinates
    const originalLinePositions = meshData.lines.positions;
    const linePositions = new Float32Array(originalLinePositions.length);

    // Transform line positions from z-up to y-up coordinate system and convert units (mm to m)
    for (let index = 0; index < originalLinePositions.length; index += 3) {
      const x = originalLinePositions[index];
      const y = originalLinePositions[index + 1];
      const z = originalLinePositions[index + 2];

      if (x === undefined || y === undefined || z === undefined) {
        continue;
      }

      const vertex: [number, number, number] = [x, y, z];
      const transformed = transformVerticesGltf(vertex);
      linePositions[index] = transformed[0];
      linePositions[index + 1] = transformed[1];
      linePositions[index + 2] = transformed[2];
    }

    // Create line indices - each pair of positions forms a line
    const lineIndices = new Uint32Array(linePositions.length / 3);
    for (let index = 0; index < lineIndices.length; index++) {
      lineIndices[index] = index;
    }

    const lineMaterial = document
      .createMaterial()
      .setDoubleSided(true)
      .setAlphaMode('OPAQUE')
      .setMetallicFactor(0)
      .setRoughnessFactor(1)
      .setBaseColorFactor([0.141, 0.259, 0.141, 1]); // #244224 color

    const linePrimitive = document
      .createPrimitive()
      .setMode(1) // LINES mode
      .setMaterial(lineMaterial)
      .setAttribute('POSITION', document.createAccessor().setType('VEC3').setArray(linePositions))
      .setIndices(document.createAccessor().setType('SCALAR').setArray(lineIndices));

    linesMesh.addPrimitive(linePrimitive);

    // Add lines mesh to scene with a special name for identification
    const linesNode = document.createNode().setMesh(linesMesh);
    scene.addChild(linesNode);
  }

  return document;
}

/**
 * Creates a GLB (binary glTF) byte array from mesh data with per-face colors.
 *
 * Always produces spec-compliant glTF with Y-up coordinates and meter units.
 *
 * @param meshData - the polyhedron geometry to encode
 * @returns the GLB binary as a byte array
 */
export async function createGlb(meshData: IndexedPolyhedron): Promise<Uint8Array<ArrayBuffer>> {
  const document = createGltfDocument(meshData);
  const glbBuffer = await new NodeIO().writeBinary(document);
  return glbBuffer;
}

/**
 * Creates a self-contained glTF JSON file from mesh data with per-face colors.
 *
 * Binary data is base64-encoded inline so the result needs no separate `.bin` files.
 *
 * @param meshData - the polyhedron geometry to encode
 * @returns the glTF JSON as a UTF-8-encoded byte array
 */
export async function createGltf(meshData: IndexedPolyhedron): Promise<Uint8Array<ArrayBuffer>> {
  const document = createGltfDocument(meshData);

  // Use writeJSON which returns both the JSON and binary data
  const gltfData = await new NodeIO().writeJSON(document);

  // For a self-contained GLTF file, we need to embed the binary data as base64
  // This creates a single .gltf file that doesn't require separate .bin files
  const gltfJson = gltfData.json;

  // If there are resources, embed them as data URIs
  const { resources } = gltfData;
  const buffers = gltfJson.buffers ?? [];

  for (const [resourceKey, resourceData] of Object.entries(resources)) {
    // Find the buffer that references this resource
    const bufferIndex = buffers.findIndex((buffer) => buffer.uri === resourceKey);
    const buffer = buffers[bufferIndex];
    if (buffer) {
      // Convert binary data to base64 using browser-compatible method
      const uint8Array = resourceData;
      let binaryString = '';
      for (const byte of uint8Array) {
        binaryString += String.fromCodePoint(byte);
      }

      // oxlint-disable-next-line no-restricted-globals -- btoa is available in browsers
      const base64Data = btoa(binaryString);

      buffer.uri = `data:application/octet-stream;base64,${base64Data}`;
    }
  }

  // Convert to pretty-printed JSON string
  const gltfEmbeddedData = new TextEncoder().encode(JSON.stringify(gltfJson, undefined, 2));

  return gltfEmbeddedData;
}
