import { toFileStat } from '@taucad/types/constants';
import type { RuntimeFileSystemBase } from '#types/runtime-kernel.types.js';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Create a RuntimeFileSystem from Node.js `fs.promises`.
 * Wraps the standard Node.js filesystem API in ~10 lines.
 *
 * @param basePath - Root path for all filesystem operations
 * @returns RuntimeFileSystemBase backed by Node.js fs
 *
 * @public
 *
 * @example <caption>Server-side Node.js filesystem</caption>
 * ```typescript
 * import { createRuntimeClient } from '@taucad/runtime';
 * import { fromNodeFS } from '@taucad/runtime/filesystem/node';
 * import { replicad } from '@taucad/runtime/kernels';
 * import { esbuild } from '@taucad/runtime/bundler';
 * import { createInProcessTransport } from '@taucad/runtime/transport';
 *
 * const client = createRuntimeClient({
 *   kernels: [replicad()],
 *   bundlers: [esbuild()],
 *   transport: createInProcessTransport(),
 *   fileSystem: fromNodeFS('/path/to/project'),
 * });
 * ```
 */
export function fromNodeFS(basePath: string): RuntimeFileSystemBase {
  const resolve = (p: string): string => path.join(basePath, p);

  function readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  function readFile(filePath: string): Promise<Uint8Array<ArrayBuffer>>;
  async function readFile(filePath: string, encoding?: 'utf8'): Promise<string | Uint8Array<ArrayBuffer>> {
    if (encoding) {
      return fs.readFile(resolve(filePath), encoding);
    }

    const buf = await fs.readFile(resolve(filePath));
    return new Uint8Array(buf);
  }

  return {
    readFile,
    async writeFile(filePath: string, data: Uint8Array<ArrayBuffer> | string): Promise<void> {
      await fs.writeFile(resolve(filePath), data);
    },
    async mkdir(directoryPath: string, options?: { recursive?: boolean }): Promise<void> {
      await fs.mkdir(resolve(directoryPath), options);
    },
    async readdir(directoryPath: string): Promise<string[]> {
      return fs.readdir(resolve(directoryPath));
    },
    async unlink(filePath: string): Promise<void> {
      await fs.unlink(resolve(filePath));
    },
    async stat(filePath: string) {
      const stats = await fs.stat(resolve(filePath));
      return toFileStat(stats);
    },
    async rmdir(directoryPath: string): Promise<void> {
      await fs.rmdir(resolve(directoryPath));
    },
    async rename(oldPath: string, newPath: string): Promise<void> {
      await fs.rename(resolve(oldPath), resolve(newPath));
    },
    async lstat(filePath: string) {
      const stats = await fs.lstat(resolve(filePath));
      return toFileStat(stats);
    },
    async exists(filePath: string): Promise<boolean> {
      try {
        await fs.access(resolve(filePath));
        return true;
      } catch {
        return false;
      }
    },
  };
}
