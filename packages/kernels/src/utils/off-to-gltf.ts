import { parseOff } from '#utils/import-off.js';
import { createGlb, createGltf } from '#utils/export-glb.js';

/**
 * Converts OFF format data to a spec-compliant glTF/GLB file (Y-up, meter units).
 *
 * @param offContent - the OFF file content as a string
 * @param format - output format: `'glb'` for binary glTF, `'gltf'` for JSON glTF
 * @returns the encoded glTF/GLB as a byte array
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
