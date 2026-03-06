import type { ExportFormat } from '@taucad/types';
import { parseOff } from '#utils/import-off.js';
import { createStlAscii, createStlBinary } from '#utils/export-stl.js';

/**
 * Converts OFF format data to an STL file (ASCII or binary).
 *
 * @param offContent - the OFF file content as a string
 * @param format - output format: `'stl'` for ASCII, `'stl-binary'` for binary
 * @returns the STL file as a byte array
 */
export async function convertOffToStl(
  offContent: string,
  format: Extract<ExportFormat, 'stl' | 'stl-binary'>,
): Promise<Uint8Array<ArrayBuffer>> {
  // Parse the OFF file
  const offData = parseOff(offContent);

  // Convert to the requested format
  if (format === 'stl') {
    return createStlAscii(offData);
  }

  // Default to binary STL format
  return createStlBinary(offData);
}
