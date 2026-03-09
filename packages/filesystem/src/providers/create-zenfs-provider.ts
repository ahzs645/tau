/**
 * Factory for ZenFS-backed FileSystemProvider instances.
 *
 * All providers (memory, indexeddb, webaccess) share the same 11-method
 * implementation wrapping a ZenFS FileSystem. Only the backend config,
 * provider id, and capabilities differ.
 *
 * @see docs/policy/filesystem-policy.md Rule 12
 */

import { resolveMountConfig, isFile, isDirectory, vfs } from '@zenfs/core';
import type { Backend, BackendConfiguration } from '@zenfs/core';
import { O_RDONLY, O_WRONLY, O_CREAT } from '@zenfs/core/constants.js';
import { defaultContext } from '@zenfs/core/internal/contexts.js';
import type { FileSystemProvider, ProviderCapabilities, ProviderFileStat } from '#types.js';

/** Options for creating a ZenFS-backed filesystem provider. */
export type ZenFsProviderOptions<T extends Backend = Backend> = {
  id: string;
  capabilities: ProviderCapabilities;
  backendConfig: BackendConfiguration<T>;
};

function toProviderStat(stats: { size: number; mtimeMs: number; mode: number }): ProviderFileStat {
  return {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    isDirectory: isDirectory(stats),
    isFile: isFile(stats),
  };
}

/**
 * Create a {@link FileSystemProvider} backed by a ZenFS filesystem.
 *
 * @param options - Provider id, capability flags, and ZenFS backend config.
 * @returns Initialized provider ready for use.
 *
 * @example
 * ```ts
 * const provider = await createZenFsProvider({
 *   id: 'memory',
 *   capabilities: { persistent: false, writable: true, quotaBased: false },
 *   backendConfig: { backend: InMemory },
 * });
 * ```
 */
export const createZenFsProvider = async <T extends Backend>(
  options: ZenFsProviderOptions<T>,
): Promise<FileSystemProvider> => {
  const fileSystem = await resolveMountConfig(options.backendConfig);

  // Declared as a function statement so TypeScript applies loose overload
  // implementation checking (see docs/research/typescript-overloads.md §4).
  // Arrow functions in object literals require strict checking, which
  // cannot satisfy overloaded signatures without a type assertion.
  function readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  function readFile(path: string, encoding: 'utf8'): Promise<string>;
  async function readFile(path: string, encoding?: 'utf8'): Promise<Uint8Array<ArrayBuffer> | string> {
    const inode = await fileSystem.stat(path);
    await using handle = new vfs.Handle(defaultContext, path, fileSystem, path, O_RDONLY, inode);

    const size = Number(inode.size);
    const buffer = new Uint8Array(size);
    if (size > 0) {
      await handle.read(buffer);
    }

    return encoding === 'utf8' ? new TextDecoder().decode(buffer) : buffer;
  }

  return {
    id: options.id,
    capabilities: options.capabilities,

    readFile,

    async writeFile(path: string, data: Uint8Array<ArrayBuffer> | string): Promise<void> {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      const exists = await fileSystem.exists(path);

      const inode = exists
        ? await fileSystem.stat(path)
        : await fileSystem.createFile(path, { uid: 0, gid: 0, mode: 0o644 });

      // oxlint-disable-next-line no-bitwise -- POSIX file flags require bitwise OR
      const writeFlags = O_WRONLY | O_CREAT;
      await using handle = new vfs.Handle(defaultContext, path, fileSystem, path, writeFlags, inode);

      if (exists) {
        await handle.truncate(0);
      }
      if (bytes.byteLength > 0) {
        await handle.write(bytes);
      }
    },

    async readdir(path: string): Promise<string[]> {
      return fileSystem.readdir(path);
    },

    async stat(path: string): Promise<ProviderFileStat> {
      return toProviderStat(await fileSystem.stat(path));
    },

    async mkdir(path: string, options_?: { recursive?: boolean }): Promise<void> {
      if (!options_?.recursive) {
        await fileSystem.mkdir(path, { uid: 0, gid: 0, mode: 0o755 });
        return;
      }
      const segments = path.split('/').filter(Boolean);
      let current = '';
      for (const segment of segments) {
        current += `/${segment}`;
        try {
          // oxlint-disable-next-line no-await-in-loop -- Sequential mkdir required for recursive creation
          await fileSystem.mkdir(current, { uid: 0, gid: 0, mode: 0o755 });
        } catch (error) {
          if ((error as { code?: string }).code !== 'EEXIST') {
            throw error;
          }
        }
      }
    },

    async unlink(path: string): Promise<void> {
      await fileSystem.unlink(path);
    },

    async rmdir(path: string): Promise<void> {
      await fileSystem.rmdir(path);
    },

    async rename(from: string, to: string): Promise<void> {
      await fileSystem.rename(from, to);
    },

    async exists(path: string): Promise<boolean> {
      try {
        await fileSystem.stat(path);
        return true;
      } catch {
        return false;
      }
    },

    async lstat(path: string): Promise<ProviderFileStat> {
      return toProviderStat(await fileSystem.stat(path));
    },

    // oxlint-disable-next-line no-empty-function -- ZenFS resolved mount configs don't need cleanup
    dispose() {},
  };
};
