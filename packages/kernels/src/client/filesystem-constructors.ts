/**
 * Convenience constructors for KernelFileSystem implementations.
 */

import type { KernelFileSystem } from '#types/kernel-worker.types.js';

/**
 * Create a KernelFileSystem from Node.js `fs.promises`.
 * Wraps the standard Node.js filesystem API in ~10 lines.
 *
 * @param basePath - Root path for all filesystem operations
 * @returns KernelFileSystem backed by Node.js fs
 *
 * @example
 * ```typescript
 * import { fromNodeFS } from '@taucad/kernels';
 * const fileSystem = fromNodeFS('/path/to/project');
 * await client.connect({ fileSystem });
 * ```
 */
// eslint-disable-next-line @typescript-eslint/naming-convention -- public API uses filesystem naming convention
export function fromNodeFS(basePath: string): KernelFileSystem {
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
    async stat(filePath: string): Promise<{ type: 'file' | 'dir'; size: number; mtimeMs: number }> {
      const stats = await fs.stat(resolve(filePath));
      return {
        type: stats.isDirectory() ? 'dir' : 'file',
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      };
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
// eslint-disable-next-line @typescript-eslint/naming-convention -- public API uses filesystem naming convention
export function fromMemoryFS(files?: Record<string, string>): KernelFileSystem {
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
    async writeFile(filePath: string, data: Uint8Array<ArrayBuffer> | string): Promise<void> {
      store.set(filePath, data);
      const parts = filePath.split('/');
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join('/'));
      }
    },
    async mkdir(dirPath: string): Promise<void> {
      dirs.add(dirPath);
    },
    async readdir(dirPath: string): Promise<string[]> {
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
    async unlink(filePath: string): Promise<void> {
      store.delete(filePath);
    },
    async stat(filePath: string): Promise<{ type: 'file' | 'dir'; size: number; mtimeMs: number }> {
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
    async exists(filePath: string): Promise<boolean> {
      return store.has(filePath) || dirs.has(filePath);
    },
  };
}
