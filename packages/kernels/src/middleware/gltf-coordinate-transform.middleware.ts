import type { Document } from '@gltf-transform/core';
import { NodeIO } from '@gltf-transform/core';
import type { GeometryGltf } from '@taucad/types';
import { isKernelSuccess } from '@taucad/types/guards';
import { createKernelMiddleware } from '#middleware/kernel-middleware.js';

/**
 * Scale factor for converting meters to millimeters.
 */
const metersToMillimeters = 1000;

/**
 * Apply the inverse GLTF coordinate transformation to a position accessor.
 * Transforms from Y-up/meters (standard GLTF) to Z-up/millimeters (UI rendering).
 *
 * Y-up to Z-up transformation: x = x', y = -z', z = y'
 * Unit conversion: meters to millimeters (multiply by 1000)
 *
 * @param positions - Float32Array of positions [x, y, z, x, y, z, ...]
 */
function transformPositionsInPlace(positions: Float32Array): void {
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] ?? 0;
    const y = positions[i + 1] ?? 0;
    const z = positions[i + 2] ?? 0;

    // Apply inverse transformation: Y-up meters -> Z-up mm
    // x' = x * 1000
    // y' = -z * 1000
    // z' = y * 1000
    positions[i] = x * metersToMillimeters;
    positions[i + 1] = -z * metersToMillimeters;
    positions[i + 2] = y * metersToMillimeters;
  }
}

/**
 * Apply the inverse GLTF coordinate transformation to a normal accessor.
 * Only rotates the normals (no scaling since they are direction vectors).
 *
 * Y-up to Z-up transformation: x = x', y = -z', z = y'
 *
 * @param normals - Float32Array of normals [nx, ny, nz, nx, ny, nz, ...]
 */
function transformNormalsInPlace(normals: Float32Array): void {
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i] ?? 0;
    const y = normals[i + 1] ?? 0;
    const z = normals[i + 2] ?? 0;

    // Apply inverse rotation only (no scaling for direction vectors)
    normals[i] = x;
    normals[i + 1] = -z;
    normals[i + 2] = y;
  }
}

/**
 * Transform a GLTF document from Y-up/meters to Z-up/millimeters.
 * Modifies position and normal attributes in place for all meshes.
 *
 * @param document - The gltf-transform Document to transform
 */
function transformDocumentToZupMm(document: Document): void {
  // Process all meshes in the document
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      // Transform positions
      const positionAccessor = primitive.getAttribute('POSITION');
      if (positionAccessor) {
        const positions = positionAccessor.getArray();
        if (positions instanceof Float32Array) {
          transformPositionsInPlace(positions);
          positionAccessor.setArray(positions);
        }
      }

      // Transform normals (rotation only, no scaling)
      const normalAccessor = primitive.getAttribute('NORMAL');
      if (normalAccessor) {
        const normals = normalAccessor.getArray();
        if (normals instanceof Float32Array) {
          transformNormalsInPlace(normals);
          normalAccessor.setArray(normals);
        }
      }
    }
  }
}

/**
 * Transform a single GLTF geometry from Y-up/meters to Z-up/millimeters.
 *
 * @param geometry - The GLTF geometry to transform
 * @returns The transformed geometry
 */
async function transformGltfGeometry(geometry: GeometryGltf): Promise<GeometryGltf> {
  const io = new NodeIO();

  // Read the GLTF document from the binary data
  const document = await io.readBinary(geometry.content);

  // Apply the coordinate transformation
  transformDocumentToZupMm(document);

  // Write back to binary format
  const transformedContent = await io.writeBinary(document);

  return {
    format: 'gltf',
    content: transformedContent,
  };
}

/**
 * Middleware that transforms GLTF geometries from Y-up/meters to Z-up/millimeters.
 *
 * All kernel workers produce valid GLTF files with Y-up coordinates and meter units
 * (per the glTF specification). This middleware transforms the output for UI rendering,
 * which expects Z-up coordinates and millimeter units.
 *
 * Uses wrap-style hook - calls handler() then transforms on the "return journey".
 * This ensures cached results from upstream middleware are also transformed.
 *
 * This creates a clean contract:
 * - Workers produce spec-compliant GLTF (Y-up, meters)
 * - Middleware handles UI-specific transformations
 * - Exports bypass the middleware and return valid GLTF files
 */
export const gltfCoordinateTransformMiddleware = createKernelMiddleware({
  name: 'GltfCoordinateTransform',

  async wrapCreateGeometry(input, handler, { logger }) {
    // Execute downstream (no pre-processing needed)
    const result = await handler(input);

    // Transform on the way back up (onion model "return journey")
    // This runs for both computed and cached results
    if (!isKernelSuccess(result) || result.data.length === 0) {
      return result;
    }

    logger.trace('Transforming GLTF geometries to Z-up/mm');

    // Transform all GLTF geometries
    const transformedGeometries = await Promise.all(
      result.data.map(async (geometry) => {
        // Only transform GLTF format geometries
        if (geometry.format === 'gltf') {
          return transformGltfGeometry(geometry);
        }

        // Return other formats unchanged (e.g., SVG)
        return geometry;
      }),
    );

    return {
      ...result,
      data: transformedGeometries,
    };
  },
});
