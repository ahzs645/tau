export const downloadBytes = (file: {
  readonly name: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mimeType: string;
}): void => {
  const url = URL.createObjectURL(new Blob([file.bytes], { type: file.mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  // Downloads may not have acquired the URL when the click handler returns.
  globalThis.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
};

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
