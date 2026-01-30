import type { Document, Primitive } from '@gltf-transform/core';
import { NodeIO } from '@gltf-transform/core';
import { KHRMaterialsUnlit } from '@gltf-transform/extensions';
import type { GeometryGltf } from '@taucad/types';
import { isKernelSuccess } from '@taucad/types/guards';
import { detectEdges } from '#components/geometry/kernel/utils/edge-detection.js';
import { createKernelMiddleware } from '#components/geometry/kernel/utils/kernel-middleware.js';

/**
 * Default edge detection threshold in degrees.
 * Edges with dihedral angle greater than this value are considered sharp.
 */
const defaultEdgeThresholdDegrees = 30;

/**
 * Edge color in RGBA format (normalized 0-1).
 * Default: black
 */
const edgeColor: [number, number, number, number] = [0, 0, 0, 1];

/**
 * Primitive mode for triangles in glTF.
 */
const primitiveModeTriangles = 4;

/**
 * Primitive mode for lines in glTF.
 */
const primitiveModeLines = 1;

/**
 * Create edge primitives for all triangle meshes in a glTF document.
 *
 * For each mesh containing TRIANGULAR primitives:
 * 1. Run edge detection to find sharp edges
 * 2. Create a new LINES primitive with the edge geometry
 * 3. Apply an unlit material with edge color
 *
 * @param document - The glTF document to process
 */
function addEdgePrimitivesToDocument(document: Document): void {
  // Create unlit extension for edge materials
  const unlitExtension = document.createExtension(KHRMaterialsUnlit);
  const unlit = unlitExtension.createUnlit();

  // Create shared edge material
  const edgeMaterial = document
    .createMaterial('tau-edge-material')
    .setBaseColorFactor(edgeColor)
    .setMetallicFactor(0)
    .setRoughnessFactor(1)
    .setDoubleSided(true)
    .setExtension('KHR_materials_unlit', unlit);

  // Process each mesh
  for (const mesh of document.getRoot().listMeshes()) {
    const primitivesToAdd: Primitive[] = [];

    for (const primitive of mesh.listPrimitives()) {
      // Only process triangle primitives
      if (primitive.getMode() !== primitiveModeTriangles) {
        continue;
      }

      // Get position accessor
      const positionAccessor = primitive.getAttribute('POSITION');
      if (!positionAccessor) {
        continue;
      }

      const positions = positionAccessor.getArray();
      if (!(positions instanceof Float32Array)) {
        continue;
      }

      // Get index accessor (optional)
      const indexAccessor = primitive.getIndices();
      let indices: Uint32Array | Uint16Array | undefined;
      if (indexAccessor) {
        const indexArray = indexAccessor.getArray();
        if (indexArray instanceof Uint32Array || indexArray instanceof Uint16Array) {
          indices = indexArray;
        }
      }

      // Run edge detection
      const edgeResult = detectEdges(positions, indices, defaultEdgeThresholdDegrees);

      // Skip if no edges detected
      if (edgeResult.positions.length === 0) {
        continue;
      }

      // Create edge primitive
      const edgePrimitive = document
        .createPrimitive()
        .setMode(primitiveModeLines)
        .setMaterial(edgeMaterial)
        .setAttribute(
          'POSITION',
          document.createAccessor('edge-positions').setType('VEC3').setArray(edgeResult.positions),
        )
        .setIndices(document.createAccessor('edge-indices').setType('SCALAR').setArray(edgeResult.indices));

      primitivesToAdd.push(edgePrimitive);
    }

    // Add edge primitives to mesh
    for (const edgePrimitive of primitivesToAdd) {
      mesh.addPrimitive(edgePrimitive);
    }
  }
}

/**
 * Add edge primitives to a GLTF geometry.
 *
 * @param geometry - The GLTF geometry to process
 * @returns The geometry with edge primitives added
 */
async function addEdgePrimitivesToGltf(geometry: GeometryGltf): Promise<GeometryGltf> {
  const io = new NodeIO().registerExtensions([KHRMaterialsUnlit]);

  // Read the GLTF document from the binary data
  const document = await io.readBinary(geometry.content);

  // Add edge primitives
  addEdgePrimitivesToDocument(document);

  // Write back to binary format
  const transformedContent = await io.writeBinary(document);

  return {
    format: 'gltf',
    content: transformedContent,
  };
}

/**
 * Middleware that adds edge detection primitives to GLTF geometries.
 *
 * This middleware runs edge detection on all triangle meshes and adds LINES primitives
 * for sharp edges. The edge detection uses a dihedral angle threshold to identify
 * edges that should be rendered.
 *
 * Uses wrap-style hook - calls handler() then transforms on the "return journey".
 * This ensures the edge detection runs after geometry computation and before caching.
 *
 * The browser-side renderer identifies primitives by Three.js object type:
 * - Mesh objects are surfaces (matcap applied, visibility toggleable)
 * - LineSegments objects are edges (converted to LineSegments2 for fat line rendering)
 */
export const gltfEdgeDetectionMiddleware = createKernelMiddleware({
  name: 'GltfEdgeDetection',

  async wrapCreateGeometry(input, handler, { logger }) {
    // Execute downstream (no pre-processing needed)
    const result = await handler(input);

    // Add edges on the way back up (onion model "return journey")
    if (!isKernelSuccess(result) || result.data.length === 0) {
      return result;
    }

    logger.trace('Adding edge primitives to GLTF geometries');

    // Process all GLTF geometries
    const processedGeometries = await Promise.all(
      result.data.map(async (geometry) => {
        // Only process GLTF format geometries
        if (geometry.format === 'gltf') {
          return addEdgePrimitivesToGltf(geometry);
        }

        // Return other formats unchanged (e.g., SVG)
        return geometry;
      }),
    );

    return {
      ...result,
      data: processedGeometries,
    };
  },
});
