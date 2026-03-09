import { IndexedDB } from '@zenfs/dom';
import type { FileSystemProvider } from '#types.js';
import { createZenFsProvider } from '#providers/create-zenfs-provider.js';

/**
 * Create a persistent filesystem provider backed by IndexedDB.
 *
 * @param databasePrefix - Prefix for the IndexedDB store name (e.g. `"tau"` → `"taufs"`).
 * @returns Provider backed by ZenFS `IndexedDB` backend.
 *
 * @example
 * ```ts
 * const provider = await createIndexedDbProvider('tau');
 * ```
 */
export const createIndexedDbProvider = async (databasePrefix: string): Promise<FileSystemProvider> =>
  createZenFsProvider({
    id: 'indexeddb',
    capabilities: { persistent: true, writable: true, quotaBased: true },
    backendConfig: { backend: IndexedDB, storeName: `${databasePrefix}fs` },
  });
