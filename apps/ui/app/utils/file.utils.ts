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

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      const base64data = reader.result;
      if (typeof base64data === 'string') {
        const a = document.createElement('a');
        a.href = base64data;
        a.download = filename;
        document.body.append(a); // Append to body to ensure click works in all browsers
        a.click();
        a.remove(); // Clean up
      } else {
        // This case should ideally not happen if the input is a Blob and readAsDataURL is used.
        // However, it's good practice to handle potential unexpected outcomes.
        throw new TypeError('Failed to convert blob to base64 string.');
      }
    });
    reader.addEventListener('error', () => {
      // Handle FileReader errors (e.g., if the blob is unreadable)
      throw new Error('FileReader failed to read the blob.');
    });
    reader.readAsDataURL(blob);
  } finally {
    URL.revokeObjectURL(url);
  }
}
