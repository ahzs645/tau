/**
 * Fast non-cryptographic hash (djb2) for cache keys and checksums.
 * NOT suitable for security -- use only where collision resistance
 * across millions of keys is unnecessary.
 */

/**
 * Hash a byte array directly, avoiding UTF-8 decode overhead.
 * Returns an 8-character lowercase hex string.
 */
export function hashBytes(data: Uint8Array<ArrayBuffer>): string {
  let hash = 5381;
  for (const byte of data) {
    // oxlint-disable-next-line unicorn/prefer-math-trunc, no-bitwise -- unsigned 32-bit wraparound is intentional
    hash = (hash * 33 + byte) >>> 0;
  }

  return hash.toString(16).padStart(8, '0');
}

/**
 * Hash a string without intermediate Uint8Array allocation.
 * Returns an 8-character lowercase hex string.
 */
export function hashString(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index++) {
    // oxlint-disable-next-line unicorn/prefer-math-trunc, no-bitwise -- unsigned 32-bit wraparound is intentional
    hash = (hash * 33 + input.codePointAt(index)!) >>> 0;
  }

  return hash.toString(16).padStart(8, '0');
}
