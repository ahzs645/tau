/**
 * Framework-internal filesystem helpers.
 *
 * These higher-level operations are built from the 8 primitives on KernelFileSystem.
 * They are NOT part of the public API -- consumers implement KernelFileSystem,
 * the framework uses these internally.
 */

import type { KernelFileSystem } from '#types/kernel-worker.types.js';

/**
 * Ensure a directory exists, creating parent directories as needed.
 *
 * @param fs - Filesystem instance
 * @param path - Absolute directory path
 */
export async function ensureDirectoryExists(fs: KernelFileSystem, path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true });
}

/**
 * Batch-read multiple files as binary.
 * All messages are sent concurrently through the MessagePort; total time is
 * bounded by the longest individual read, not the sum.
 *
 * @param fs - Filesystem instance
 * @param paths - Absolute file paths
 * @returns Map of path to binary content
 */
export async function readFiles(
  fs: KernelFileSystem,
  paths: string[],
): Promise<Record<string, Uint8Array<ArrayBuffer>>> {
  const entries = await Promise.all(
    paths.map(async (path) => {
      const content = await fs.readFile(path);
      return [path, content] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<string, Uint8Array<ArrayBuffer>>;
}

/**
 * Read all file contents in a directory.
 *
 * @param fs - Filesystem instance
 * @param dirPath - Absolute directory path
 * @returns Map of filename to binary content
 */
export async function getDirectoryContents(
  fs: KernelFileSystem,
  dirPath: string,
): Promise<Record<string, Uint8Array<ArrayBuffer>>> {
  const names = await fs.readdir(dirPath);
  const entries = await Promise.all(
    names.map(async (name) => {
      const content = await fs.readFile(`${dirPath}/${name}`);
      return [name, content] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<string, Uint8Array<ArrayBuffer>>;
}

/**
 * Get stat information for all entries in a directory.
 *
 * @param fs - Filesystem instance
 * @param dirPath - Absolute directory path
 * @returns Array of stat objects with path and name
 */
export async function getDirectoryStat(
  fs: KernelFileSystem,
  dirPath: string,
): Promise<Array<{ path: string; name: string; type: 'file' | 'dir'; size: number; mtimeMs: number }>> {
  const names = await fs.readdir(dirPath);
  return Promise.all(
    names.map(async (name) => {
      const fullPath = `${dirPath}/${name}`;
      const fileStat = await fs.stat(fullPath);
      return { path: fullPath, name, ...fileStat };
    }),
  );
}

/**
 * Check existence of multiple paths concurrently.
 *
 * @param fs - Filesystem instance
 * @param paths - Absolute paths to check
 * @returns Map of path to existence boolean
 */
export async function batchExists(fs: KernelFileSystem, paths: string[]): Promise<Record<string, boolean>> {
  const entries = await Promise.all(
    paths.map(async (path) => {
      const doesExist = await fs.exists(path);
      return [path, doesExist] as const;
    }),
  );
  return Object.fromEntries(entries);
}
