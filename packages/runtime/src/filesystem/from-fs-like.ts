/**
 * Create a RuntimeFileSystem from any fs-compatible object (BrowserFS, memfs, polyfills).
 * Wraps an `fs.promises`-style API for same-thread usage (testing, Node.js, worker-side serving).
 */

import type { NativeStats } from '@taucad/types';
import { toFileStat } from '@taucad/types/constants';
import type { RuntimeFileSystemBase } from '#types/runtime-kernel.types.js';

/* oxlint-disable @protontech/enforce-uint8array-arraybuffer/enforce-uint8array-arraybuffer -- BrowserFS/memfs returns Buffer<ArrayBufferLike>, we must accept the wider type */
/**
 * Minimal interface for any fs-compatible object with a `promises` namespace.
 * Matches the shape of `fs` from BrowserFS, memfs, and similar
 * libraries without importing them directly.
 * Uses `ArrayBufferLike` to accept both `ArrayBuffer` and `SharedArrayBuffer`
 * (BrowserFS returns `Buffer<ArrayBufferLike>`).
 * @public
 */
export type FsLike = {
  promises: {
    readFile(path: string, encoding: 'utf8'): Promise<string>;
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array | string): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined | void>;
    readdir(path: string): Promise<string[]>;
    unlink(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    stat(path: string): Promise<NativeStats>;
    lstat(path: string): Promise<NativeStats>;
  };
};
/* oxlint-enable @protontech/enforce-uint8array-arraybuffer/enforce-uint8array-arraybuffer -- re-enable after FsLike type */

/**
 * Create a RuntimeFileSystem from any fs-compatible object.
 * Wraps an `fs.promises`-style API for same-thread usage (testing, Node.js, worker-side serving).
 *
 * @param fsLike - An fs-compatible object with a `promises` namespace (e.g., BrowserFS, memfs)
 * @param rootPath - Optional root path prefix for all operations (default: '/')
 * @returns RuntimeFileSystemBase backed by the provided fs-compatible object
 *
 * @public
 *
 * @example <caption>fs-like object adapter</caption>
 * ```typescript
 * import { fromFsLike } from '@taucad/runtime/filesystem';
 *
 * declare const fsLikeObject: { promises: typeof import('fs').promises };
 * const fileSystem = fromFsLike(fsLikeObject);
 * ```
 */
export function fromFsLike(fsLike: FsLike, rootPath = '/'): RuntimeFileSystemBase {
  const resolve = (p: string): string => {
    if (rootPath === '/') {
      return p;
    }

    return p.startsWith('/') ? `${rootPath}${p}` : `${rootPath}/${p}`;
  };

  function readFile(path: string, encoding: 'utf8'): Promise<string>;
  function readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  async function readFile(filePath: string, encoding?: 'utf8'): Promise<string | Uint8Array<ArrayBuffer>> {
    if (encoding) {
      return fsLike.promises.readFile(resolve(filePath), encoding);
    }

    const buf = await fsLike.promises.readFile(resolve(filePath));
    return new Uint8Array(buf);
  }

  return {
    readFile,
    async writeFile(filePath: string, data: Uint8Array<ArrayBuffer> | string): Promise<void> {
      await fsLike.promises.writeFile(resolve(filePath), data);
    },
    async mkdir(directoryPath: string, options?: { recursive?: boolean }): Promise<void> {
      await fsLike.promises.mkdir(resolve(directoryPath), options);
    },
    async readdir(directoryPath: string): Promise<string[]> {
      return fsLike.promises.readdir(resolve(directoryPath));
    },
    async unlink(filePath: string): Promise<void> {
      await fsLike.promises.unlink(resolve(filePath));
    },
    async stat(filePath: string) {
      const stats = await fsLike.promises.stat(resolve(filePath));
      return toFileStat(stats);
    },
    async rmdir(directoryPath: string): Promise<void> {
      await fsLike.promises.rmdir(resolve(directoryPath));
    },
    async rename(oldPath: string, newPath: string): Promise<void> {
      await fsLike.promises.rename(resolve(oldPath), resolve(newPath));
    },
    async lstat(filePath: string) {
      const stats = await fsLike.promises.lstat(resolve(filePath));
      return toFileStat(stats);
    },
    async exists(filePath: string): Promise<boolean> {
      try {
        await fsLike.promises.stat(resolve(filePath));
        return true;
      } catch {
        return false;
      }
    },
  };
}
