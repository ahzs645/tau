import JSZip from 'jszip';
import { resolveMountConfig, isDirectory } from '@zenfs/core';
import { IndexedDB, WebAccess } from '@zenfs/dom';
import type { FileSystem } from '@zenfs/core';
import type { FileStat, FilesystemBackend } from '@taucad/types';
import { fs, ensureFilesystemConfigured, reconfigureFilesystem, setWebAccessHandle } from '#filesystem/zenfs-config.js';
import { metaConfig } from '#constants/meta.constants.js';
import { asBuffer } from '#utils/file.utils.js';
import { joinPath } from '#utils/path.utils.js';

// Use ZenFS promise-based API
const fsp = fs.promises;

/**
 * Ensure filesystem is configured before performing operations.
 * This is awaited at the start of every fileManager method to guarantee
 * the ZenFS backend is initialized before any filesystem operations.
 */
async function ensureReady(): Promise<void> {
  await ensureFilesystemConfigured('indexeddb');
}

/**
 * Global write serialization queue.
 *
 * ZenFS has a known race condition (zen-fs/core#256) where concurrent
 * write operations to the same directory corrupt the directory listing
 * in IndexedDB. Each `commitNew` call reads the parent directory listing,
 * adds an entry, and writes it back -- but concurrent calls read the same
 * snapshot and the last writer wins, losing all other entries.
 *
 * This queue serializes ALL mutating filesystem operations so they execute
 * one at a time, preventing the race entirely. Read-only operations
 * (readFile, readdir, stat, exists) are not serialized and can run freely.
 */
let writeQueue: Promise<void> = Promise.resolve();

/**
 * Serialize a mutating filesystem operation through the global write queue.
 * Operations are executed one at a time in FIFO order. If a previous
 * operation failed, the next one still runs (errors don't block the queue).
 */
async function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeQueue
    // eslint-disable-next-line promise/prefer-await-to-then -- Intentional promise chaining for queue serialization
    .catch(() => {
      // Swallow previous error so the queue continues
    })
    // eslint-disable-next-line promise/prefer-await-to-then -- Intentional promise chaining for queue serialization
    .then(async () => operation());

  writeQueue = result
    // eslint-disable-next-line promise/prefer-await-to-then -- Intentional promise chaining for queue serialization
    .catch(() => {
      // No-op
    })
    // eslint-disable-next-line promise/prefer-await-to-then -- Intentional promise chaining for queue serialization
    .then(() => {
      // No-op
    });
  return result;
}

export type MkdirOptions = {
  mode?: number;
  recursive?: boolean;
};

/**
 * Node in a standalone backend file tree.
 * Used by the /files route to display all backends side-by-side.
 */
export type FileTreeNode = {
  id: string;
  name: string;
  children?: FileTreeNode[];
};

export type FileManager = {
  readFile(filepath: string, options: 'utf8' | { encoding: 'utf8' }): Promise<string>;
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- preserving original API for binary reads
  readFile(filepath: string, options?: {}): Promise<Uint8Array<ArrayBuffer>>;
  readFiles(paths: string[]): Promise<Record<string, Uint8Array<ArrayBuffer>>>;
  writeFile(filepath: string, data: Uint8Array<ArrayBuffer> | string): Promise<void>;
  writeFiles(files: Record<string, { content: Uint8Array<ArrayBuffer> }>): Promise<void>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{
    type: 'file' | 'dir';
    size: number;
    mtimeMs: number;
  }>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  batchExists(paths: string[]): Promise<Record<string, boolean>>;
  ensureDirectoryExists(path: string): Promise<void>;
  getDirectoryStat(path: string): Promise<FileStat[]>;
  getDirectoryContents(path: string): Promise<Record<string, Uint8Array<ArrayBuffer>>>;
  duplicateFile(sourcePath: string, destinationPath: string): Promise<void>;
  copyDirectory(sourcePath: string, destinationPath: string): Promise<void>;
  getZippedDirectory(path: string): Promise<Blob>;
  reconfigure(backend: FilesystemBackend): Promise<void>;
  /**
   * Set the FileSystemDirectoryHandle for the webaccess backend.
   * The handle is transferred from the main thread via Comlink's structured cloning.
   * Must be called before reconfigure('webaccess').
   */
  setDirectoryHandle(handle: FileSystemDirectoryHandle): void;
  /**
   * Read the file tree from a specific backend using a standalone FileSystem instance.
   * Does not affect the main mounted filesystem.
   * Used by the /files route grid view to show all backends in parallel.
   */
  readBackendFileTree(backend: FilesystemBackend, handle?: FileSystemDirectoryHandle): Promise<FileTreeNode[]>;
};

// Internal implementation for readFile with proper overload handling
async function readFile(filepath: string, options: 'utf8' | { encoding: 'utf8' }): Promise<string>;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- preserving original API for binary reads
async function readFile(filepath: string, options?: {}): Promise<Uint8Array<ArrayBuffer>>;
async function readFile(
  filepath: string,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- preserving original API for binary reads
  options?: 'utf8' | { encoding: 'utf8' } | {},
): Promise<string | Uint8Array<ArrayBuffer>> {
  await ensureReady();

  const encoding = options === 'utf8' || (typeof options === 'object' && 'encoding' in options) ? 'utf8' : undefined;

  if (encoding === 'utf8') {
    return fsp.readFile(filepath, 'utf8');
  }

  // Return as Uint8Array
  const buffer = await fsp.readFile(filepath);
  return new Uint8Array(asBuffer(buffer.buffer), buffer.byteOffset, buffer.byteLength);
}

async function readFiles(paths: string[]): Promise<Record<string, Uint8Array<ArrayBuffer>>> {
  await ensureReady();

  const results = await Promise.all(
    paths.map(async (filepath) => {
      const buffer = await fsp.readFile(filepath);
      const uint8Array = new Uint8Array(asBuffer(buffer.buffer), buffer.byteOffset, buffer.byteLength);
      return [filepath, uint8Array] as const;
    }),
  );

  return Object.fromEntries(results);
}

/**
 * Internal (non-serialized) version of ensureDirectoryExists.
 * Used by writeFile/writeFiles within their already-serialized context
 * to avoid deadlocking by re-entering the serialization queue.
 */
async function ensureDirectoryExistsInternal(targetPath: string): Promise<void> {
  const normalizedPath = targetPath.startsWith('/') ? targetPath : `/${targetPath}`;
  const segments = normalizedPath.split('/').filter((segment) => segment.length > 0);

  let currentPath = '';
  for (const segment of segments) {
    currentPath += `/${segment}`;
    try {
      // eslint-disable-next-line no-await-in-loop -- Need to create directories sequentially
      await fsp.mkdir(currentPath);
    } catch (error) {
      // Ignore if directory already exists
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }
}

export const fileManager: FileManager = {
  readFile,
  readFiles,

  // Check if a path exists (file or directory)
  async exists(path: string): Promise<boolean> {
    await ensureReady();
    try {
      await fsp.stat(path);
      return true;
    } catch {
      return false;
    }
  },

  // Batch check if multiple paths exist - optimized for checking many paths at once
  async batchExists(paths: string[]): Promise<Record<string, boolean>> {
    await ensureReady();
    const results = await Promise.all(
      paths.map(async (path) => ({
        path,
        exists: await this.exists(path),
      })),
    );

    const existsMap: Record<string, boolean> = {};
    for (const { path, exists } of results) {
      existsMap[path] = exists;
    }

    return existsMap;
  },

  // Ensure a directory path exists, creating all parent directories as needed
  async ensureDirectoryExists(targetPath: string): Promise<void> {
    return serialized(async () => {
      await ensureReady();
      await ensureDirectoryExistsInternal(targetPath);
    });
  },

  // Write a file from provided binary data (serialized to prevent ZenFS race conditions)
  async writeFile(path: string, content: Uint8Array<ArrayBuffer> | string): Promise<void> {
    return serialized(async () => {
      await ensureReady();
      // Ensure parent directory exists before writing
      const lastSlashIndex = path.lastIndexOf('/');
      if (lastSlashIndex > 0) {
        const directoryPath = path.slice(0, lastSlashIndex);
        await ensureDirectoryExistsInternal(directoryPath);
      }

      await fsp.writeFile(path, content);
    });
  },

  async writeFiles(files: Record<string, { content: Uint8Array<ArrayBuffer> }>): Promise<void> {
    return serialized(async () => {
      await ensureReady();
      const createdDirs = new Set<string>();

      for (const [path, file] of Object.entries(files)) {
        const lastSlashIndex = path.lastIndexOf('/');
        if (lastSlashIndex > 0) {
          const directoryPath = path.slice(0, lastSlashIndex);
          if (!createdDirs.has(directoryPath)) {
            // eslint-disable-next-line no-await-in-loop -- Sequential writes required to prevent ZenFS race condition
            await ensureDirectoryExistsInternal(directoryPath);
            createdDirs.add(directoryPath);
          }
        }

        // eslint-disable-next-line no-await-in-loop -- Sequential writes required to prevent ZenFS race condition
        await fsp.writeFile(path, file.content);
      }
    });
  },

  // Create a directory (serialized to prevent ZenFS race conditions)
  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    return serialized(async () => {
      await ensureReady();
      await fsp.mkdir(path, options);
    });
  },

  // List directory contents
  async readdir(path: string): Promise<string[]> {
    await ensureReady();
    return fsp.readdir(path);
  },

  // Get file/directory metadata
  async stat(path: string): Promise<{
    type: 'file' | 'dir';
    size: number;
    mtimeMs: number;
  }> {
    await ensureReady();
    const stats = await fsp.stat(path);
    return {
      // ZenFS uses Node.js-style isFile()/isDirectory() methods
      type: stats.isFile() ? 'file' : 'dir',
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
  },

  // Rename a file or directory (serialized to prevent ZenFS race conditions)
  async rename(oldPath: string, newPath: string): Promise<void> {
    return serialized(async () => {
      await ensureReady();
      await fsp.rename(oldPath, newPath);
    });
  },

  // Delete a file (serialized to prevent ZenFS race conditions)
  async unlink(path: string): Promise<void> {
    return serialized(async () => {
      await ensureReady();
      await fsp.unlink(path);
    });
  },

  // Delete a directory (must be empty, serialized to prevent ZenFS race conditions)
  async rmdir(path: string): Promise<void> {
    return serialized(async () => {
      await ensureReady();
      await fsp.rmdir(path);
    });
  },

  // Get all file stats in a directory recursively as an array of file stat objects
  async getDirectoryStat(path: string): Promise<FileStat[]> {
    await ensureReady();

    const fileStats: FileStat[] = [];

    const collectStatsRecursive = async (currentPath: string, basePath: string): Promise<void> => {
      const entries = await fsp.readdir(currentPath);

      for (const entry of entries) {
        const fullPath = joinPath(currentPath, entry);
        // eslint-disable-next-line no-await-in-loop -- Need to process directories sequentially
        const stats = await fsp.stat(fullPath);

        if (stats.isFile()) {
          // Store relative path from the base directory
          // Handle root path edge case: when basePath is '/', we only need to remove the leading slash
          const relativePath = basePath === '/' ? fullPath.slice(1) : fullPath.slice(basePath.length + 1);
          // Extract filename from relative path (get the last segment)
          const pathSegments = relativePath.split('/');
          const filename = pathSegments.at(-1) ?? relativePath;

          fileStats.push({
            path: relativePath,
            name: filename,
            type: 'file',
            size: stats.size,
            mtimeMs: stats.mtimeMs,
          });
        } else {
          // eslint-disable-next-line no-await-in-loop -- Need to process directories sequentially
          await collectStatsRecursive(fullPath, basePath);
        }
      }
    };

    try {
      await collectStatsRecursive(path, path);
    } catch {
      return [];
    }

    return fileStats;
  },

  // Get all files in a directory recursively as a map of relative paths to file contents
  async getDirectoryContents(path: string): Promise<Record<string, Uint8Array<ArrayBuffer>>> {
    await ensureReady();

    const directoryExists = await this.exists(path);
    if (!directoryExists) {
      return {};
    }

    const files: Record<string, Uint8Array<ArrayBuffer>> = {};

    const collectRecursive = async (currentPath: string, basePath: string): Promise<void> => {
      const entries = await fsp.readdir(currentPath);

      for (const entry of entries) {
        const fullPath = joinPath(currentPath, entry);
        // eslint-disable-next-line no-await-in-loop -- Need to process directories sequentially
        const stats = await fsp.stat(fullPath);

        if (stats.isFile()) {
          const relativePath = basePath === '/' ? fullPath.slice(1) : fullPath.slice(basePath.length + 1);
          // eslint-disable-next-line no-await-in-loop -- Need to read files sequentially
          const buffer = await fsp.readFile(fullPath);
          files[relativePath] = new Uint8Array(asBuffer(buffer.buffer), buffer.byteOffset, buffer.byteLength);
        } else {
          // eslint-disable-next-line no-await-in-loop -- Need to process directories sequentially
          await collectRecursive(fullPath, basePath);
        }
      }
    };

    await collectRecursive(path, path);
    return files;
  },

  async duplicateFile(sourcePath: string, destinationPath: string): Promise<void> {
    return serialized(async () => {
      await ensureReady();
      const buffer = await fsp.readFile(sourcePath);
      const content = new Uint8Array(asBuffer(buffer.buffer), buffer.byteOffset, buffer.byteLength);

      // Ensure parent directory exists before writing
      const lastSlashIndex = destinationPath.lastIndexOf('/');
      if (lastSlashIndex > 0) {
        const directoryPath = destinationPath.slice(0, lastSlashIndex);
        await ensureDirectoryExistsInternal(directoryPath);
      }

      await fsp.writeFile(destinationPath, content);
    });
  },

  async copyDirectory(sourcePath: string, destinationPath: string): Promise<void> {
    return serialized(async () => {
      await ensureReady();
      const files = await this.getDirectoryContents(sourcePath);

      for (const [relativePath, content] of Object.entries(files)) {
        const destinationFilePath = joinPath(destinationPath, relativePath);
        // Ensure parent directory exists before writing
        const lastSlashIndex = destinationFilePath.lastIndexOf('/');
        if (lastSlashIndex > 0) {
          const directoryPath = destinationFilePath.slice(0, lastSlashIndex);
          // eslint-disable-next-line no-await-in-loop -- Sequential writes required to prevent ZenFS race condition
          await ensureDirectoryExistsInternal(directoryPath);
        }

        // eslint-disable-next-line no-await-in-loop -- Sequential writes required to prevent ZenFS race condition
        await fsp.writeFile(destinationFilePath, content);
      }
    });
  },

  async getZippedDirectory(path: string): Promise<Blob> {
    await ensureReady();
    const zip = new JSZip();
    const files = await this.getDirectoryContents(path);

    for (const [relativePath, content] of Object.entries(files)) {
      zip.file(relativePath, content);
    }

    return zip.generateAsync({ type: 'blob' });
  },

  /**
   * Reconfigure the filesystem with a different backend.
   * This is called from the main thread via Comlink.
   */
  async reconfigure(backend: FilesystemBackend): Promise<void> {
    await reconfigureFilesystem(backend);
  },

  /**
   * Set the FileSystemDirectoryHandle for the webaccess backend.
   * Called from the main thread via Comlink before reconfigure('webaccess').
   * The handle is automatically structured-cloned by postMessage.
   */
  setDirectoryHandle(handle: FileSystemDirectoryHandle): void {
    setWebAccessHandle(handle);
  },

  /**
   * Read the file tree from a specific backend using a standalone FileSystem instance.
   * Creates a temporary, independent FileSystem that reads from the same underlying
   * storage as the main filesystem but without affecting the global mount.
   *
   * @param backend - The backend to read from
   * @param handle - Optional FileSystemDirectoryHandle for webaccess backend
   * @returns Tree of FileTreeNode objects, sorted folders-first then alphabetically
   */
  async readBackendFileTree(backend: FilesystemBackend, handle?: FileSystemDirectoryHandle): Promise<FileTreeNode[]> {
    if (backend === 'memory') {
      return [];
    }

    let standaloneFs: FileSystem;

    switch (backend) {
      case 'indexeddb': {
        const storeName = `${metaConfig.databasePrefix}fs`;
        standaloneFs = await resolveMountConfig({ backend: IndexedDB, storeName });
        break;
      }

      case 'opfs': {
        const rootHandle = await navigator.storage.getDirectory();
        standaloneFs = await resolveMountConfig({ backend: WebAccess, handle: rootHandle });
        break;
      }

      case 'webaccess': {
        if (!handle) {
          return [];
        }

        standaloneFs = await resolveMountConfig({ backend: WebAccess, handle });
        break;
      }

      default: {
        return [];
      }
    }

    // Recursively traverse the standalone filesystem instance
    const buildTree = async (currentPath: string): Promise<FileTreeNode[]> => {
      let entries: string[];
      try {
        entries = await standaloneFs.readdir(currentPath);
      } catch {
        return [];
      }

      const nodes: FileTreeNode[] = [];

      for (const entry of entries) {
        const fullPath = currentPath === '/' ? `/${entry}` : `${currentPath}/${entry}`;
        try {
          // eslint-disable-next-line no-await-in-loop -- Sequential stat required for correct tree building
          const stats = await standaloneFs.stat(fullPath);
          if (isDirectory(stats)) {
            // eslint-disable-next-line no-await-in-loop -- Sequential traversal required for correct tree building
            const children = await buildTree(fullPath);
            nodes.push({ id: fullPath, name: entry, children });
          } else {
            nodes.push({ id: fullPath, name: entry });
          }
        } catch {
          // Skip entries that can't be stat'd
        }
      }

      // Sort: folders first, then alphabetically
      return nodes.sort((a, b) => {
        const aIsFolder = a.children !== undefined;
        const bIsFolder = b.children !== undefined;
        if (aIsFolder && !bIsFolder) {
          return -1;
        }

        if (!aIsFolder && bIsFolder) {
          return 1;
        }

        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
    };

    return buildTree('/');
  },
};
