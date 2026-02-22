/**
 * Converts a Uint8Array or ArrayBuffer to a type compatible with BlobPart.
 *
 * This utility handles the TypeScript type incompatibility between
 * Uint8Array<ArrayBufferLike> and BlobPart that occurs with stricter
 * type checkers (like tsgo). The runtime behavior is unchanged - this
 * is purely a type-level fix.
 *
 * @param data - The Uint8Array or ArrayBuffer to convert
 * @returns The same data with a compatible type for Blob constructor
 */
export function asBuffer(data: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
export function asBuffer(data: ArrayBufferLike): ArrayBuffer;
export function asBuffer(data: Uint8Array<ArrayBuffer> | ArrayBufferLike): Uint8Array<ArrayBuffer> | ArrayBuffer {
  if (data instanceof Uint8Array) {
    return data;
  }

  return data as ArrayBuffer;
}
