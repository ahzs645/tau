/**
 * Number of leading bytes inspected by `seemsBinary`. Mirrors VS Code's
 * `ZERO_BYTE_DETECTION_BUFFER_MAX_LEN` (512) which has been validated for years
 * across every binary format the editor encounters.
 */
export const headSniffByteLength = 512;

const utf8Bom = [0xef, 0xbb, 0xbf];
const utf16BeBom = [0xfe, 0xff];
const utf16LeBom = [0xff, 0xfe];
const utf32BeBom = [0x00, 0x00, 0xfe, 0xff];
const utf32LeBom = [0xff, 0xfe, 0x00, 0x00];

const startsWith = (buffer: Uint8Array<ArrayBuffer>, prefix: readonly number[]): boolean => {
  if (buffer.length < prefix.length) {
    return false;
  }
  for (const [index, byte] of prefix.entries()) {
    if (buffer[index] !== byte) {
      return false;
    }
  }
  return true;
};

/**
 * Content-driven binary heuristic mirroring VS Code's
 * `detectEncodingFromBuffer`. Inspects the first `headSniffByteLength` bytes:
 * a recognised text BOM short-circuits to text; otherwise the presence of a
 * NUL byte indicates binary.
 *
 * No filename or extension is consulted at any point.
 */
export function seemsBinary(head: Uint8Array<ArrayBuffer>): boolean {
  if (head.length === 0) {
    return false;
  }

  if (
    startsWith(head, utf32LeBom) ||
    startsWith(head, utf32BeBom) ||
    startsWith(head, utf8Bom) ||
    startsWith(head, utf16LeBom) ||
    startsWith(head, utf16BeBom)
  ) {
    return false;
  }

  const limit = Math.min(head.length, headSniffByteLength);
  for (let i = 0; i < limit; i++) {
    if (head[i] === 0) {
      return true;
    }
  }
  return false;
}
