/**
 * Creates a Blob from a Uint8Array.
 *
 * This utility handles the TypeScript type incompatibility between
 * Uint8Array<ArrayBufferLike> and BlobPart that occurs with stricter
 * type checkers (like tsgo). The runtime behavior is correct - browsers
 * accept Uint8Array in Blob constructors.
 *
 * @param data - The Uint8Array data to convert to a Blob
 * @param options - Optional BlobPropertyBag for specifying MIME type etc.
 * @returns A new Blob containing the data
 */
export function createBlob(data: Uint8Array, options?: BlobPropertyBag): Blob {
  // Type assertion needed because Uint8Array<ArrayBufferLike> includes
  // SharedArrayBuffer which lacks some ArrayBuffer properties in TS definitions
  return new Blob([data as BlobPart], options);
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
