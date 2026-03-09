import { describe, it, expect } from 'vitest';

const hasFileSystemAccess = 'FileSystemDirectoryHandle' in globalThis;

describe('createWebAccessProvider', () => {
  it.skipIf(!hasFileSystemAccess)('should return a provider with id "webaccess"', async () => {
    const { createWebAccessProvider } = await import('#providers/webaccess-provider.js');
    const handle = await navigator.storage.getDirectory();
    const provider = await createWebAccessProvider(handle);
    expect(provider.id).toBe('webaccess');
    expect(provider.capabilities).toEqual({
      persistent: true,
      writable: true,
      quotaBased: false,
    });
    provider.dispose();
  });

  it.skipIf(!hasFileSystemAccess)('should support write and read round-trip', async () => {
    const { createWebAccessProvider } = await import('#providers/webaccess-provider.js');
    const handle = await navigator.storage.getDirectory();
    const provider = await createWebAccessProvider(handle);
    await provider.writeFile('/wa-test.txt', 'webaccess');
    const content = await provider.readFile('/wa-test.txt', 'utf8');
    expect(content).toBe('webaccess');
    provider.dispose();
  });
});
