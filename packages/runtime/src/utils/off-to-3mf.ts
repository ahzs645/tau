import { parseOff } from '#utils/import-off.js';
import { export3mf } from '#utils/export-3mf.js';

/**
 * Converts OFF format data to a 3MF ZIP archive.
 *
 * @param offContent - the OFF file content as a string
 * @param extruderColors - optional extruder RGB colors for multi-material printing
 * @returns the 3MF file as a byte array
 */
export async function convertOffTo3mf(
  offContent: string,
  extruderColors?: Array<[number, number, number]>,
): Promise<Uint8Array<ArrayBuffer>> {
  // Parse the OFF file
  const offData = parseOff(offContent);

  // Convert to 3MF format
  return export3mf(offData, extruderColors);
}
