/**
 * In-memory filesystem provider backed by a simple Map.
 *
 * Replaces the ZenFS `InMemory` backend for ephemeral, non-persistent
 * filesystem operations (tests, scratch spaces).
 *
 * @see docs/research/filesystem-runtime-strategy.md
 */

import type { ProviderCapabilities, ProviderFileStat } from '#types.js';
import { AbstractFileSystemProvider } from '#providers/abstract-provider.js';

/**
 * Non-persistent, in-memory filesystem provider.
 *
 * @public
 */
export class MemoryProvider extends AbstractFileSystemProvider {
  public get id(): string {
    return 'memory';
  }

  public readonly capabilities: ProviderCapabilities = {
    persistent: false,
    writable: true,
    quotaBased: false,
  };

  private readonly _files = new Map<string, Uint8Array<ArrayBuffer>>();
  private readonly _dirs = new Set<string>(['/']);
  private readonly _mtimes = new Map<string, number>();

  // ---------------------------------------------------------------------------
  // Public instance methods
  // ---------------------------------------------------------------------------

  public async writeFile(path: string, data: Uint8Array<ArrayBuffer> | string): Promise<void> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this._ensureParentDirs(path);
    this._files.set(path, bytes);
    this._mtimes.set(path, Date.now());
  }

  public async readdir(path: string): Promise<string[]> {
    const normalizedPath = path === '/' ? '/' : path;
    if (!this._dirs.has(normalizedPath) && !this._files.has(normalizedPath)) {
      throw this._enoent(path);
    }

    const prefix = normalizedPath === '/' ? '/' : `${normalizedPath}/`;
    const entries = new Set<string>();

    for (const filePath of this._files.keys()) {
      if (filePath.startsWith(prefix)) {
        const rest = filePath.slice(prefix.length);
        const firstSegment = rest.split('/')[0];
        if (firstSegment) {
          entries.add(firstSegment);
        }
      }
    }

    for (const directoryPath of this._dirs) {
      if (directoryPath !== normalizedPath && directoryPath.startsWith(prefix)) {
        const rest = directoryPath.slice(prefix.length);
        const firstSegment = rest.split('/')[0];
        if (firstSegment) {
          entries.add(firstSegment);
        }
      }
    }

    return [...entries];
  }

  public async readdirWithStats(path: string): Promise<Array<{ name: string } & ProviderFileStat>> {
    const names = await this.readdir(path);
    const prefix = path === '/' ? '/' : `${path}/`;
    const result: Array<{ name: string } & ProviderFileStat> = [];
    for (const name of names) {
      const fullPath = `${prefix}${name}`;
      if (this._dirs.has(fullPath)) {
        result.push({
          name,
          size: 0,
          mtimeMs: this._mtimes.get(fullPath) ?? Date.now(),
          isDirectory: true,
          isFile: false,
        });
      } else {
        const data = this._files.get(fullPath);
        result.push({
          name,
          size: data?.byteLength ?? 0,
          mtimeMs: this._mtimes.get(fullPath) ?? Date.now(),
          isDirectory: false,
          isFile: true,
        });
      }
    }
    return result;
  }

  public async stat(path: string): Promise<ProviderFileStat> {
    if (this._dirs.has(path)) {
      return { size: 0, mtimeMs: this._mtimes.get(path) ?? Date.now(), isDirectory: true, isFile: false };
    }
    const data = this._files.get(path);
    if (data) {
      return { size: data.byteLength, mtimeMs: this._mtimes.get(path) ?? Date.now(), isDirectory: false, isFile: true };
    }
    throw this._enoent(path);
  }

  public async unlink(path: string): Promise<void> {
    if (!this._files.has(path)) {
      throw this._enoent(path);
    }
    this._files.delete(path);
    this._mtimes.delete(path);
  }

  public async rmdir(path: string): Promise<void> {
    if (!this._dirs.has(path) || path === '/') {
      throw this._enoent(path);
    }
    const prefix = `${path}/`;
    for (const filePath of this._files.keys()) {
      if (filePath.startsWith(prefix)) {
        const error = new Error(`ENOTEMPTY: directory not empty '${path}'`);
        (error as NodeJS.ErrnoException).code = 'ENOTEMPTY';
        throw error;
      }
    }
    this._dirs.delete(path);
    this._mtimes.delete(path);
  }

  public async rename(from: string, to: string): Promise<void> {
    if (this._dirs.has(from)) {
      this._ensureParentDirs(to);
      this._dirs.add(to);
      this._dirs.delete(from);

      const prefix = `${from}/`;
      const entriesToMove: Array<[string, Uint8Array<ArrayBuffer>]> = [];
      const directoriesToMove: string[] = [];

      for (const [path, data] of this._files) {
        if (path.startsWith(prefix)) {
          entriesToMove.push([path, data]);
        }
      }
      for (const directory of this._dirs) {
        if (directory.startsWith(prefix)) {
          directoriesToMove.push(directory);
        }
      }

      for (const [oldPath, data] of entriesToMove) {
        const newPath = to + oldPath.slice(from.length);
        this._files.set(newPath, data);
        this._files.delete(oldPath);
        const mtime = this._mtimes.get(oldPath) ?? Date.now();
        this._mtimes.delete(oldPath);
        this._mtimes.set(newPath, mtime);
      }

      for (const oldDirectory of directoriesToMove) {
        const newDirectory = to + oldDirectory.slice(from.length);
        this._dirs.add(newDirectory);
        this._dirs.delete(oldDirectory);
      }

      const mtime = this._mtimes.get(from) ?? Date.now();
      this._mtimes.delete(from);
      this._mtimes.set(to, mtime);
      return;
    }

    const data = this._files.get(from);
    if (!data) {
      throw this._enoent(from);
    }
    this._ensureParentDirs(to);
    this._files.set(to, data);
    this._files.delete(from);
    const mtime = this._mtimes.get(from) ?? Date.now();
    this._mtimes.delete(from);
    this._mtimes.set(to, mtime);
  }

  // ---------------------------------------------------------------------------
  // Protected instance methods
  // ---------------------------------------------------------------------------

  protected async readFileRaw(path: string): Promise<Uint8Array<ArrayBuffer>> {
    const data = this._files.get(path);
    if (!data) {
      throw this._enoent(path);
    }
    return data;
  }

  protected async mkdirSingle(path: string): Promise<void> {
    if (this._dirs.has(path)) {
      const error = new Error(`EEXIST: directory already exists '${path}'`);
      (error as NodeJS.ErrnoException).code = 'EEXIST';
      throw error;
    }
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';
    if (parent !== '/' && !this._dirs.has(parent)) {
      throw this._enoent(parent);
    }
    this._dirs.add(path);
    this._mtimes.set(path, Date.now());
  }

  // ---------------------------------------------------------------------------
  // Private instance methods
  // ---------------------------------------------------------------------------

  private _ensureParentDirs(path: string): void {
    let directory = path.slice(0, path.lastIndexOf('/')) || '/';
    while (directory !== '/' && !this._dirs.has(directory)) {
      this._dirs.add(directory);
      directory = directory.slice(0, directory.lastIndexOf('/')) || '/';
    }
  }

  private _enoent(path: string): Error {
    const error = new Error(`ENOENT: no such file or directory '${path}'`);
    (error as NodeJS.ErrnoException).code = 'ENOENT';
    return error;
  }
}

/**
 * Create a non-persistent, in-memory filesystem provider.
 *
 * @returns Provider backed by a simple in-memory Map.
 *
 * @public
 * @example <caption>Ephemeral in-memory filesystem</caption>
 * ```typescript
 * import { createMemoryProvider } from '@taucad/filesystem/providers';
 *
 * const provider = await createMemoryProvider();
 * await provider.writeFile('/hello.txt', 'world');
 * ```
 */
export const createMemoryProvider = async (): Promise<MemoryProvider> => new MemoryProvider();
