import type { KernelFileSystemBase } from '#types/kernel-worker.types.js';

/**
 * Create a KernelFileSystem backed by an in-memory Map.
 * Useful for testing and for passing file content directly.
 *
 * @param files - Initial file contents (path -> content string)
 * @returns KernelFileSystem backed by an in-memory store
 *
 * @example
 * ```typescript
 * import { fromMemoryFS } from '@taucad/kernels';
 * const fileSystem = fromMemoryFS({
 *   'main.ts': 'import { draw } from "replicad"; ...',
 *   'lib/utils.ts': 'export function helper() { ... }',
 * });
 * await client.connect({ fileSystem });
 * ```
 */
export function fromMemoryFS(files?: Record<string, string>): KernelFileSystemBase {
  const store = new Map<string, Uint8Array<ArrayBuffer> | string>();
  const dirs = new Set<string>();

  if (files) {
    for (const [filePath, content] of Object.entries(files)) {
      store.set(filePath, content);
      const parts = filePath.split('/');
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join('/'));
      }
    }
  }

  dirs.add('/');

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function readFile(path: string, encoding: 'utf8'): Promise<string>;
  function readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  async function readFile(filePath: string, encoding?: 'utf8'): Promise<string | Uint8Array<ArrayBuffer>> {
    const content = store.get(filePath);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file: ${filePath}`);
    }

    if (encoding === 'utf8') {
      return typeof content === 'string' ? content : decoder.decode(content);
    }

    return typeof content === 'string' ? encoder.encode(content) : content;
  }

  return {
    readFile,
    async writeFile(filePath, data) {
      store.set(filePath, data);
      const parts = filePath.split('/');
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join('/'));
      }
    },
    async mkdir(dirPath) {
      dirs.add(dirPath);
      const parts = dirPath.split('/');
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join('/'));
      }
    },
    async readdir(dirPath) {
      const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
      const entries = new Set<string>();
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const slash = rest.indexOf('/');
          entries.add(slash === -1 ? rest : rest.slice(0, slash));
        }
      }

      for (const dir of dirs) {
        if (dir.startsWith(prefix)) {
          const rest = dir.slice(prefix.length);
          const slash = rest.indexOf('/');
          entries.add(slash === -1 ? rest : rest.slice(0, slash));
        }
      }

      return [...entries].filter(Boolean);
    },
    async unlink(filePath) {
      store.delete(filePath);
    },
    async stat(filePath) {
      if (store.has(filePath)) {
        const content = store.get(filePath)!;
        const size = typeof content === 'string' ? encoder.encode(content).byteLength : content.byteLength;
        return { type: 'file', size, mtimeMs: Date.now() };
      }

      if (dirs.has(filePath)) {
        return { type: 'dir', size: 0, mtimeMs: Date.now() };
      }

      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    },
    async rmdir(dirPath) {
      dirs.delete(dirPath);
    },
    async rename(oldPath, newPath) {
      const content = store.get(oldPath);
      if (content !== undefined) {
        store.set(newPath, content);
        store.delete(oldPath);
      } else if (dirs.has(oldPath)) {
        dirs.delete(oldPath);
        dirs.add(newPath);
      } else {
        throw new Error(`ENOENT: no such file or directory: ${oldPath}`);
      }
    },
    async lstat(filePath) {
      if (store.has(filePath)) {
        const content = store.get(filePath)!;
        const size = typeof content === 'string' ? encoder.encode(content).byteLength : content.byteLength;
        return { type: 'file', size, mtimeMs: Date.now() };
      }

      if (dirs.has(filePath)) {
        return { type: 'dir', size: 0, mtimeMs: Date.now() };
      }

      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    },
    async exists(filePath) {
      return store.has(filePath) || dirs.has(filePath);
    },
  };
}
