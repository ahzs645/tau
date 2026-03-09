import { describe, it, expect } from 'vitest';
import { createIndexedDbProvider } from '#providers/indexeddb-provider.js';

const hasIndexedDb = 'indexedDB' in globalThis;

describe('createIndexedDbProvider', () => {
  it.skipIf(!hasIndexedDb)('should return a provider with id "indexeddb"', async () => {
    const provider = await createIndexedDbProvider('test');
    expect(provider.id).toBe('indexeddb');
    expect(provider.capabilities).toEqual({
      persistent: true,
      writable: true,
      quotaBased: true,
    });
    provider.dispose();
  });

  it.skipIf(!hasIndexedDb)('should support write and read round-trip', async () => {
    const provider = await createIndexedDbProvider('test');
    await provider.writeFile('/idb-test.txt', 'indexed');
    const content = await provider.readFile('/idb-test.txt', 'utf8');
    expect(content).toBe('indexed');
    provider.dispose();
  });
});
