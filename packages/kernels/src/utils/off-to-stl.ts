import type { ExportFormat } from '@taucad/types';
import { parseOff } from '#utils/import-off.js';
import { createStlAscii, createStlBinary } from '#utils/export-stl.js';

/**
 * Convert OFF format data to STL
 * @param offContent - The OFF file content as string
 * @param format - The output format: 'stl' for ASCII STL, 'stl-binary' for binary STL
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
