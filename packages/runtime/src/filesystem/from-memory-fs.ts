import type { RuntimeFileSystemBase } from '#types/runtime-kernel.types.js';

function enoent(message: string): Error {
  const error = new Error(message);
  (error as NodeJS.ErrnoException).code = 'ENOENT';
  return error;
}

/**
 * Create a RuntimeFileSystem backed by an in-memory Map.
 * Useful for testing and for passing file content directly.
 *
 * @param files - Initial file contents (path -> content string)
 * @returns RuntimeFileSystem backed by an in-memory store
 *
 * @public
 *
 * @example <caption>In-memory filesystem with inline source</caption>
 * ```typescript
 * import { createRuntimeClient, fromMemoryFS } from '@taucad/runtime';
 * import { replicad } from '@taucad/runtime/kernels';
 * import { esbuild } from '@taucad/runtime/bundler';
 * import { createInProcessTransport } from '@taucad/runtime/transport';
 *
 * const client = createRuntimeClient({
 *   kernels: [replicad()],
 *   bundlers: [esbuild()],
 *   transport: createInProcessTransport(),
 *   fileSystem: fromMemoryFS({
 *     '/main.ts': 'import { draw } from "replicad";\nexport default () => draw();',
 *   }),
 * });
 * ```
 */
export function fromMemoryFS(files?: Record<string, string>): RuntimeFileSystemBase {
  const store = new Map<string, Uint8Array<ArrayBuffer> | string>();
  const directories = new Set<string>();

  if (files) {
    for (const [filePath, content] of Object.entries(files)) {
      store.set(filePath, content);
      const parts = filePath.split('/');
      for (let i = 1; i < parts.length; i++) {
        directories.add(parts.slice(0, i).join('/'));
      }
    }
  }

  directories.add('/');

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function readFile(path: string, encoding: 'utf8'): Promise<string>;
  function readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  async function readFile(filePath: string, encoding?: 'utf8'): Promise<string | Uint8Array<ArrayBuffer>> {
    const content = store.get(filePath);
    if (content === undefined) {
      throw enoent(`ENOENT: no such file: ${filePath}`);
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
        directories.add(parts.slice(0, i).join('/'));
      }
    },
    async mkdir(directoryPath) {
      directories.add(directoryPath);
      const parts = directoryPath.split('/');
      for (let i = 1; i < parts.length; i++) {
        directories.add(parts.slice(0, i).join('/'));
      }
    },
    async readdir(directoryPath) {
      const prefix = directoryPath.endsWith('/') ? directoryPath : `${directoryPath}/`;
      const entries = new Set<string>();
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const slash = rest.indexOf('/');
          entries.add(slash === -1 ? rest : rest.slice(0, slash));
        }
      }

      for (const directory of directories) {
        if (directory.startsWith(prefix)) {
          const rest = directory.slice(prefix.length);
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

      if (directories.has(filePath)) {
        return { type: 'dir', size: 0, mtimeMs: Date.now() };
      }

      throw new Error(`ENOENT: no such file or directory: ${filePath}`);
    },
    async rmdir(directoryPath) {
      directories.delete(directoryPath);
    },
    async rename(oldPath, newPath) {
      const content = store.get(oldPath);
      if (content !== undefined) {
        store.set(newPath, content);
        store.delete(oldPath);
      } else if (directories.has(oldPath)) {
        directories.delete(oldPath);
        directories.add(newPath);
      } else {
        throw enoent(`ENOENT: no such file or directory: ${oldPath}`);
      }
    },
    async lstat(filePath) {
      if (store.has(filePath)) {
        const content = store.get(filePath)!;
        const size = typeof content === 'string' ? encoder.encode(content).byteLength : content.byteLength;
        return { type: 'file', size, mtimeMs: Date.now() };
      }

      if (directories.has(filePath)) {
        return { type: 'dir', size: 0, mtimeMs: Date.now() };
      }

      throw enoent(`ENOENT: no such file or directory: ${filePath}`);
    },
    async exists(filePath) {
      return store.has(filePath) || directories.has(filePath);
    },
  };
}
