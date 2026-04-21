import { cadMaterialDefaults } from '@taucad/types/constants';
import { normalizeColor } from '#kernels/replicad/utils/normalize-color.js';
import { transformNormalArray, transformVertexArray } from '#framework/common.js';
import type { GeometryReplicad } from '#kernels/replicad/replicad.types.js';
import { srgbHexToLinearTuple } from '#utils/color-space.js';
import { writeGlb, writeGltfJson } from '#utils/glb-writer.js';
import type { GlbInput, GlbNode, GlbPrimitive } from '#utils/glb-writer.js';

/**
 * Build a GlbNode from a single replicad geometry (surface + optional edge lines).
 *
 * @param geometry - the replicad geometry with face, edge, and color data
 * @param geometryIndex - fallback index for unnamed geometries
 * @returns the GlbNode, or undefined if the geometry has no renderable data
 */
function buildNodeFromReplicadGeometry(geometry: GeometryReplicad, geometryIndex: number): GlbNode | undefined {
  const primitives: GlbPrimitive[] = [];
  const { faces, edges } = geometry;

  if (faces.vertices.length > 0 && faces.triangles.length > 0) {
    const positions = transformVertexArray(faces.vertices);
    const normals = transformNormalArray(faces.normals);
    const indices = new Uint32Array(faces.triangles);

    let baseColor: [number, number, number, number] = [...cadMaterialDefaults.baseColorFactor];
    if (geometry.color) {
      try {
        const normalizedColor = normalizeColor(geometry.color);
        const alpha = geometry.opacity ?? normalizedColor.alpha;
        baseColor = srgbHexToLinearTuple(normalizedColor.color, alpha);
      } catch (error) {
        console.warn('Failed to parse color:', geometry.color, error);
        throw new Error('Failed to parse color', { cause: error });
      }
    }

    primitives.push({
      mode: 4,
      positions,
      normals,
      indices,
      material: {
        baseColorFactor: baseColor,
        metallicFactor: geometry.metalness ?? cadMaterialDefaults.metalnessFactor,
        roughnessFactor: geometry.roughness ?? cadMaterialDefaults.roughnessFactor,
        doubleSided: true,
        alphaMode: baseColor[3] < 1 ? 'BLEND' : 'OPAQUE',
        name: geometry.color ?? 'default',
      },
    });
  }

  if (edges.lines.length > 0) {
    const linePositions = transformVertexArray(edges.lines);
    const lineIndices = new Uint32Array(linePositions.length / 3);
    for (let index = 0; index < lineIndices.length; index++) {
      lineIndices[index] = index;
    }

    const nodeName = geometry.name || `Shape_${geometryIndex}`;
    primitives.push({
      mode: 1,
      positions: linePositions,
      indices: lineIndices,
      material: {
        baseColorFactor: [0.141, 0.259, 0.141, 1],
        metallicFactor: 0,
        roughnessFactor: 1,
        doubleSided: true,
        alphaMode: 'OPAQUE',
        name: `outline-${nodeName}`,
      },
    });
  }

  if (primitives.length === 0) {
    return undefined;
  }

  return {
    name: geometry.name || `Shape_${geometryIndex}`,
    primitives,
  };
}

/**
 * Convert replicad geometries to GLTF blob format.
 *
 * Always produces spec-compliant GLTF with:
 * - Y-up coordinate system (per glTF specification)
 * - Meter units (per glTF specification)
 *
 * This function preserves the original triangulation from replicad without re-triangulating,
 * resulting in better rendering quality and performance.
 *
 * @param geometries - Array of Shape3D objects from replicad
 * @param format - Output format: 'glb' for binary, 'gltf' for JSON
 * @returns GLTF blob
 */
export function convertReplicadGeometriesToGltf(
  geometries: GeometryReplicad[],
  format: 'glb' | 'gltf' = 'glb',
): Uint8Array<ArrayBuffer> {
  const nodes: GlbNode[] = [];

  for (const [index, geometry] of geometries.entries()) {
    const node = buildNodeFromReplicadGeometry(geometry, index);
    if (node) {
      nodes.push(node);
    }
  }

  const input: GlbInput = { nodes };

  if (format === 'gltf') {
    return writeGltfJson(input);
  }

  return writeGlb(input);
}
