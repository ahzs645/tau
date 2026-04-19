import { parseOff } from '#utils/import-off.js';
import { createGlb, createGltf } from '#utils/export-glb.js';
import { transformVerticesGltf, transformVerticesZup } from '#framework/common.js';

/**
 * Converts OFF format data to a glTF/GLB file with configurable coordinate system.
 *
 * @param offContent - the OFF file content as a string
 * @param format - output format: `'glb'` for binary glTF, `'gltf'` for JSON glTF
 * @param coordinateSystem - output coordinate convention: `'y-up'` (glTF spec default) or `'z-up'`
 * @returns the encoded glTF/GLB as a byte array
 */
export async function convertOffToGltf(
  offContent: string,
  format: 'glb' | 'gltf' = 'glb',
  coordinateSystem: 'y-up' | 'z-up' = 'z-up',
): Promise<Uint8Array<ArrayBuffer>> {
  const offData = parseOff(offContent);
  const transform = coordinateSystem === 'y-up' ? transformVerticesGltf : transformVerticesZup;

  if (format === 'gltf') {
    return createGltf(offData, transform);
  }

  return createGlb(offData, transform);
}
