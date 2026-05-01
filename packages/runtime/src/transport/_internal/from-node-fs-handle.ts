/**
 * Transport-internal Node.js filesystem handle factory.
 *
 * Produces the discriminated `inline`-arm {@link RuntimeFileSystemHandle}
 * backing the public {@link fromNodeFs} factory in
 * `filesystem/from-node-fs.ts`. Lives under `transport/_internal/` so the
 * public `@taucad/runtime/filesystem` surface exposes only the opaque
 * `RuntimeFileSystem` value, never the underlying handle shape.
 *
 * @internal
 */

import { toFileStat } from '@taucad/types/constants';
import type { RuntimeFileSystemBase } from '#types/runtime-kernel.types.js';
import type { RuntimeFileSystemHandle } from '#transport/_internal/runtime-filesystem-handle.js';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Internal: produce the discriminated `inline`-arm handle backing
 * {@link fromNodeFs}. Kept inside `transport/_internal/` so transports
 * can resolve an opaque {@link RuntimeFileSystem} produced by the public
 * factory back to its underlying `RuntimeFileSystemBase` instance
 * without leaking the discriminated handle shape onto the public
 * filesystem barrel.
 *
 * @internal
 * @param basePath - Host directory mapped to VFS `/` — kernel paths beginning
 * with `/` resolve under here (POSIX `path.join` would ignore `basePath`
 * otherwise).
 * @returns Discriminated handle whose `inline.fs` proxies `basePath`.
 */
export function _fromNodeFsHandle(basePath: string): RuntimeFileSystemHandle {
  /* Kernel VFS paths are POSIX-absolute from the project root (e.g.
   * `/main.scad`). Plain `path.join(base, '/x')` ignores `base` on POSIX and
   * resolves to `/x` on the host — map VFS root explicitly under `basePath`. */
  const resolveVirtualToHostPath = (virtualPath: string): string => {
    const stripped = virtualPath.replace(/^\/+/, '');
    if (stripped.length === 0) {
      return basePath;
    }
    return path.join(basePath, stripped);
  };
  const resolve = resolveVirtualToHostPath;

  function readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  function readFile(filePath: string): Promise<Uint8Array<ArrayBuffer>>;
  async function readFile(filePath: string, encoding?: 'utf8'): Promise<string | Uint8Array<ArrayBuffer>> {
    if (encoding) {
      return fs.readFile(resolve(filePath), encoding);
    }

    const buf = await fs.readFile(resolve(filePath));
    return new Uint8Array(buf);
  }

  const runtimeFs: RuntimeFileSystemBase = {
    id: 'runtime:node-fs',
    capabilities: { persistent: true, writable: true, quotaBased: false, caseSensitive: true },
    dispose() {
      /* The Node.js fs module has no per-instance lifecycle to tear down. */
    },
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

  return { kind: 'inline', fs: runtimeFs };
}
