import { InMemory } from '@zenfs/core';
import type { FileSystemProvider } from '#types.js';
import { createZenFsProvider } from '#providers/create-zenfs-provider.js';

/**
 * Create a non-persistent, in-memory filesystem provider.
 *
 * @returns Provider backed by ZenFS `InMemory` backend.
 *
 * @example
 * ```ts
 * const provider = await createMemoryProvider();
 * await provider.writeFile('/hello.txt', 'world');
 * ```
 */
export const createMemoryProvider = async (): Promise<FileSystemProvider> =>
  createZenFsProvider({
    id: 'memory',
    capabilities: { persistent: false, writable: true, quotaBased: false },
    backendConfig: { backend: InMemory },
  });
