import { WebAccess } from '@zenfs/dom';
import type { FileSystemProvider } from '#types.js';
import { createZenFsProvider } from '#providers/create-zenfs-provider.js';

/**
 * Create a persistent filesystem provider using the File System Access API.
 *
 * @param handle - Browser directory handle obtained from `showDirectoryPicker()`.
 * @returns Provider backed by ZenFS `WebAccess` backend.
 *
 * @example
 * ```ts
 * const handle = await window.showDirectoryPicker();
 * const provider = await createWebAccessProvider(handle);
 * ```
 */
export const createWebAccessProvider = async (handle: FileSystemDirectoryHandle): Promise<FileSystemProvider> =>
  createZenFsProvider({
    id: 'webaccess',
    capabilities: { persistent: true, writable: true, quotaBased: false },
    backendConfig: { backend: WebAccess, handle },
  });
