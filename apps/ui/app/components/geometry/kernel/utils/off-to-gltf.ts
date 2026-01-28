import { parseOff } from '#components/geometry/kernel/utils/import-off.js';
import { createGlb, createGltf } from '#components/geometry/kernel/utils/export-glb.js';

/**
 * Convert OFF format data to GLTF/GLB blob.
 *
 * Always produces spec-compliant GLTF with:
 * - Y-up coordinate system (per glTF specification)
 * - Meter units (per glTF specification)
 *
 * @param offContent - The OFF file content as string
 * @param format - The output format: 'glb' for binary GLTF, 'gltf' for JSON GLTF
 */
export async function convertOffToGltf(
  offContent: string,
  format: 'glb' | 'gltf' = 'glb',
): Promise<Uint8Array<ArrayBuffer>> {
  // Parse the OFF file
  const offData = parseOff(offContent);

  // Convert to the requested format
  if (format === 'gltf') {
    return createGltf(offData);
  }

  // Default to GLB format
  return createGlb(offData);
}
