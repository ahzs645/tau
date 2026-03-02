import { toFileStat } from '@taucad/types/constants';
import type { KernelFileSystemBase } from '#types/kernel-worker.types.js';

/**
 * Create a KernelFileSystem from Node.js `fs.promises`.
 * Wraps the standard Node.js filesystem API in ~10 lines.
 *
 * @param basePath - Root path for all filesystem operations
 * @returns KernelFileSystemBase backed by Node.js fs
 *
 * @example
 * ```typescript
 * import { fromNodeFS } from '@taucad/kernels';
 * const fileSystem = fromNodeFS('/path/to/project');
 * await client.connect({ fileSystem });
 * ```
 */
export function fromNodeFS(basePath: string): KernelFileSystemBase {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, unicorn/prefer-module, @typescript-eslint/consistent-type-imports -- dynamic require avoids bundling Node.js builtins in browser builds
  const fs = require('node:fs/promises') as typeof import('node:fs/promises');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, unicorn/prefer-module, @typescript-eslint/consistent-type-imports -- dynamic require avoids bundling Node.js builtins in browser builds
  const path = require('node:path') as typeof import('node:path');

  const resolve = (p: string): string => path.resolve(basePath, p);

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
    async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void> {
      await fs.mkdir(resolve(dirPath), options);
    },
    async readdir(dirPath: string): Promise<string[]> {
      return fs.readdir(resolve(dirPath));
    },
    async unlink(filePath: string): Promise<void> {
      await fs.unlink(resolve(filePath));
    },
    async stat(filePath: string) {
      const stats = await fs.stat(resolve(filePath));
      return toFileStat(stats);
    },
    async rmdir(dirPath: string): Promise<void> {
      await fs.rmdir(resolve(dirPath));
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
