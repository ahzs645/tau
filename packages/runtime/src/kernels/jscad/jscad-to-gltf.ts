import { geometries, maths } from '@jscad/modeling';
import { cadMaterialDefaults } from '@taucad/types/constants';
import { transformNormalArray, transformVertexArray } from '#framework/common.js';
import { writeGlb } from '#utils/glb-writer.js';
import type { GlbInput, GlbNode, GlbPrimitive } from '#utils/glb-writer.js';

/**
 * Type guard to check if a shape has a color property
 *
 * @param shape - the value to check for a color property
 * @returns whether the shape has a numeric color array
 */
function hasColor(shape: unknown): shape is { color: number[] } {
  return (
    typeof shape === 'object' &&
    shape !== null &&
    'color' in shape &&
    Array.isArray((shape as Record<string, unknown>)['color'])
  );
}

/**
 * Extract color from JSCAD shape, returning normalized RGBA values
 * @param shape - JSCAD geometry object that may have a color property
 * @returns RGBA array [r, g, b, a] with values 0-1, or undefined if no color
 */
function extractColorFromShape(shape: unknown): [number, number, number, number] | undefined {
  if (!hasColor(shape)) {
    return undefined;
  }

  const { color } = shape;
  if (color.length < 3) {
    return undefined;
  }

  const r = color[0] ?? 0.8;
  const g = color[1] ?? 0.8;
  const b = color[2] ?? 0.8;
  const a = color[3] ?? 1;

  return [r, g, b, a];
}

/**
 * Extract triangulated mesh data from JSCAD shapes
 *
 * Processes JSCAD geometries (geom3 objects) and converts them into WebGL-compatible
 * mesh data with vertex positions, surface normals, and triangle indices. This function
 * handles multiple shapes and performs polygon extraction and triangulation.
 *
 * Key operations:
 * 1. Extracts polygons from each JSCAD geom3 object using geometries.geom3.toPolygons()
 * 2. Calculates smooth surface normals using cross products of polygon edges
 * 3. Triangulates polygons using fan triangulation (simple and fast method)
 * 4. Flattens data into Float32Array-compatible formats for GPU rendering
 *
 * The function throws an error if any shape cannot be converted to a geom3 polygon.
 * Polygons with fewer than 3 vertices are skipped as they cannot form triangles.
 * All three vertices of each triangle share the same normal (flat shading).
 *
 * @internal
 *
 * @param shapes - Array of JSCAD geometry objects (typically geom3 type)
 * @returns Object containing flattened mesh data:
 *          - vertices: Flat array of x,y,z coordinates [x1,y1,z1,x2,y2,z2,...]
 *          - normals: Flat array of normal vectors (one per vertex) [nx1,ny1,nz1,...]
 *          - indices: Triangle indices pointing into vertex array [v0,v1,v2,v3,v4,v5,...]
 *
 * @see {@link jscadToGltf} — the public API that orchestrates these helpers
 *
 * @example <caption>Extracting flat mesh data</caption>
 * ```typescript
 * const { vertices, normals, indices } = extractMeshDataFromJscadShapes(shapes);
 * // vertices: flat XYZ coordinates [x1,y1,z1,x2,y2,z2,...]
 * // normals: normalized direction vectors per vertex
 * // indices: triangle vertex indices [0,1,2,3,4,5,...]
 * ```
 */
function extractMeshDataFromJscadShapes(shapes: unknown[]): {
  vertices: number[];
  normals: number[];
  indices: number[];
} {
  const allPolygons: Array<{ vertices: maths.vec3.Vec3[] }> = [];
  for (const [index, singleShape] of shapes.entries()) {
    try {
      const polygons = geometries.geom3.toPolygons(singleShape as geometries.geom3.Geom3);
      allPolygons.push(...polygons);
    } catch (error) {
      let shapeType: string;
      if (singleShape === null) {
        shapeType = 'null';
      } else if (singleShape === undefined) {
        shapeType = 'undefined';
      } else if (typeof singleShape === 'object') {
        const ctorName = (singleShape as Record<string, unknown>).constructor.name;
        shapeType = ctorName ? String(ctorName) : 'Object';
      } else {
        shapeType = typeof singleShape;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);

      throw new Error(
        `Failed to convert shape at index ${index} to GLTF polygon. Shape type: ${shapeType}. ${errorMessage}`,
      );
    }
  }

  const vertices: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let vertexIndex = 0;

  for (const polygon of allPolygons) {
    const polyVertices = polygon.vertices;
    if (polyVertices.length < 3) {
      continue;
    }

    const v1 = polyVertices[0];
    const v2 = polyVertices[1];
    const v3 = polyVertices[2];

    if (!v1 || !v2 || !v3) {
      continue;
    }

    const edge1 = maths.vec3.subtract(maths.vec3.create(), v2, v1);
    const edge2 = maths.vec3.subtract(maths.vec3.create(), v3, v1);

    const normal = maths.vec3.cross(maths.vec3.create(), edge1, edge2);
    maths.vec3.normalize(normal, normal);

    const firstVertex = polyVertices[0];
    if (!firstVertex) {
      continue;
    }

    for (let index = 1; index < polyVertices.length - 1; index++) {
      const vert1 = firstVertex;
      const vert2 = polyVertices[index];
      const vert3 = polyVertices[index + 1];

      if (!vert2 || !vert3) {
        continue;
      }

      vertices.push(vert1[0], vert1[1], vert1[2], vert2[0], vert2[1], vert2[2], vert3[0], vert3[1], vert3[2]);
      normals.push(normal[0], normal[1], normal[2], normal[0], normal[1], normal[2], normal[0], normal[1], normal[2]);
      indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2);
      vertexIndex += 3;
    }
  }

  return { vertices, normals, indices };
}

/**
 * Build a GlbNode from a single JSCAD shape.
 *
 * @param shape - the JSCAD geometry object
 * @param shapeIndex - index for naming
 * @returns the GlbNode, or undefined if no renderable geometry
 */
function buildNodeFromJscadShape(shape: unknown, shapeIndex: number): GlbNode | undefined {
  const color = extractColorFromShape(shape);
  const { vertices, normals, indices } = extractMeshDataFromJscadShapes([shape]);

  if (vertices.length === 0 || indices.length === 0) {
    return undefined;
  }

  const positions = transformVertexArray(vertices);
  const normalsArray = transformNormalArray(normals);
  const indicesArray = new Uint32Array(indices);

  const baseColor: [number, number, number, number] = color ?? [0.8, 0.8, 0.8, 1];

  let materialName = 'default';
  if (color) {
    materialName = `rgba(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(color[2] * 255)},${color[3].toFixed(2)})`;
  }

  const primitive: GlbPrimitive = {
    mode: 4,
    positions,
    normals: normalsArray,
    indices: indicesArray,
    material: {
      baseColorFactor: baseColor,
      metallicFactor: cadMaterialDefaults.metallicFactor,
      roughnessFactor: cadMaterialDefaults.roughnessFactor,
      doubleSided: true,
      alphaMode: baseColor[3] < 1 ? 'BLEND' : 'OPAQUE',
      name: materialName,
    },
  };

  return {
    name: `JSCAD_Shape_${shapeIndex}`,
    primitives: [primitive],
  };
}

/**
 * Convert JSCAD geometry to GLTF Blob for rendering with full color support.
 *
 * Always produces spec-compliant GLTF with:
 * - Y-up coordinate system (per glTF specification)
 * - Meter units (per glTF specification)
 *
 * Public API for converting JSCAD geometries into renderable glTF format (GLB binary).
 * This is the primary integration point between the JSCAD CAD engine and the 3D viewer.
 *
 * Conversion pipeline:
 * 1. Normalizes input to array format (single shape -> [shape])
 * 2. Creates separate mesh/node for each shape to preserve individual geometry
 * 3. Applies coordinate transformation (Z-up/mm to Y-up/meters)
 * 4. Creates glTF document with mesh data extraction, triangulation, normals, and colors
 * 5. Serializes to GLB (binary glTF) format for efficient transmission and storage
 *
 * Color support:
 * - Automatically detects and preserves colors applied via colorize() from @jscad/modeling
 * - Each shape gets its own mesh with its own material and color
 * - Supports both opaque and transparent colors (RGB and RGBA)
 * - Colors are defined as [R, G, B, A] arrays with values 0-1
 *
 * The function handles:
 * - Single shapes or arrays of shapes
 * - Colored and non-colored shapes (defaults to light gray)
 * - Empty geometry (returns valid GLB with empty scene)
 * - Throws error for invalid or unconvertible shapes
 *
 * Material properties are set to sensible defaults (matte, double-sided, low metallic)
 * suitable for preview visualization. For production export, use specialized exporters.
 *
 * @internal
 *
 * @param shape - JSCAD geometry object(s):
 *               - Single geom3/geom2 object (colored or default)
 *               - Array of geometry objects
 *               - Any shape produced by @jscad/modeling functions
 *               - Shapes created with colorize() will preserve their colors
 * @returns GLB binary (binary glTF format)
 *
 * @throws {Error} If any shape cannot be converted to GLTF polygon
 *
 * @example <caption>Converting JSCAD shapes to glTF</caption>
 * ```typescript
 * const shape = primitives.cube({ size: 10 });
 * const glb = jscadToGltf(shape);
 *
 * const redSphere = colors.colorize([1, 0, 0], primitives.sphere({ radius: 5 }));
 * const blueCube = colors.colorize([0, 0, 1, 0.5], primitives.cube({ size: 10 }));
 * const coloredGlb = jscadToGltf([redSphere, blueCube]);
 * ```
 */
export function jscadToGltf(shape: unknown): Uint8Array<ArrayBuffer> {
  const shapes = Array.isArray(shape) ? shape : [shape];

  const nodes: GlbNode[] = [];
  for (const [index, singleShape] of shapes.entries()) {
    const node = buildNodeFromJscadShape(singleShape, index);
    if (node) {
      nodes.push(node);
    }
  }

  const input: GlbInput = { nodes };
  return writeGlb(input);
}
