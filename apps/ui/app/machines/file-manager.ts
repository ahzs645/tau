import JSZip from 'jszip';
import type { FileStat } from '@taucad/types';
import { fs, ensureFilesystemConfigured } from '#filesystem/zenfs-config.js';
import { asBuffer } from '#utils/file.utils.js';
import { joinPath } from '#utils/path.utils.js';

// Use ZenFS promise-based API
const fsp = fs.promises;

/**
 * Ensure filesystem is configured before performing operations.
 * This is awaited at the start of every fileManager method to guarantee
 * the ZenFS backend is initialized before any filesystem operations.
 */
const ensureReady = async (): Promise<void> => ensureFilesystemConfigured('indexeddb');

export type MkdirOptions = {
  mode?: number;
  recursive?: boolean;
};

export type FileManager = {
  readFile(filepath: string, options: 'utf8' | { encoding: 'utf8' }): Promise<string>;
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- preserving original API for binary reads
  readFile(filepath: string, options?: {}): Promise<Uint8Array<ArrayBuffer>>;
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
  copyDirectory(sourcePath: string, destinationPath: string): Promise<void>;
  getZippedDirectory(path: string): Promise<Blob>;
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

export const fileManager: FileManager = {
  readFile,

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
    await ensureReady();
    const normalizedPath = targetPath.startsWith('/') ? targetPath : `/${targetPath}`;
    const segments = normalizedPath.split('/').filter((segment) => segment.length > 0);

    // Build all directory paths that need to be created
    const directoryPaths: string[] = [];
    let currentPath = '';

    for (const segment of segments) {
      currentPath += `/${segment}`;
      directoryPaths.push(currentPath);
    }

    // Batch check which directories already exist
    const existsMap = await this.batchExists(directoryPaths);

    // Create only the directories that don't exist (in order)
    for (const directoryPath of directoryPaths) {
      if (!existsMap[directoryPath]) {
        try {
          // eslint-disable-next-line no-await-in-loop -- Need to create directories sequentially
          await fsp.mkdir(directoryPath);
        } catch (error: unknown) {
          // Ignore error if directory was created by another concurrent operation
          if (error instanceof Error && !error.message.includes('EEXIST')) {
            throw error;
          }
        }
      }
    }
  },

  // Write a file from provided binary data
  async writeFile(path: string, content: Uint8Array<ArrayBuffer> | string): Promise<void> {
    await ensureReady();
    // Ensure parent directory exists before writing
    const lastSlashIndex = path.lastIndexOf('/');
    if (lastSlashIndex > 0) {
      const directoryPath = path.slice(0, lastSlashIndex);
      await this.ensureDirectoryExists(directoryPath);
    }

    await fsp.writeFile(path, content);
  },

  async writeFiles(files: Record<string, { content: Uint8Array<ArrayBuffer> }>): Promise<void> {
    await ensureReady();
    await Promise.all(
      Object.entries(files).map(async ([path, file]) => {
        await this.writeFile(path, file.content);
      }),
    );
  },

  // Create a directory (recursive: true creates parent directories if needed)
  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await ensureReady();
    await fsp.mkdir(path, options);
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

  // Rename a file or directory
  async rename(oldPath: string, newPath: string): Promise<void> {
    await ensureReady();
    await fsp.rename(oldPath, newPath);
  },

  // Delete a file
  async unlink(path: string): Promise<void> {
    await ensureReady();
    await fsp.unlink(path);
  },

  // Delete a directory (must be empty)
  async rmdir(path: string): Promise<void> {
    await ensureReady();
    await fsp.rmdir(path);
  },

  // Get all file stats in a directory recursively as an array of file stat objects
  async getDirectoryStat(path: string): Promise<FileStat[]> {
    await ensureReady();
    // Check if directory exists first - return empty array if it doesn't
    const directoryExists = await this.exists(path);
    if (!directoryExists) {
      return [];
    }

    const fileStats: FileStat[] = [];

    const collectStatsRecursive = async (currentPath: string, basePath: string): Promise<void> => {
      const entries = await fsp.readdir(currentPath);

      for (const entry of entries) {
        const fullPath = joinPath(currentPath, entry);
        // eslint-disable-next-line no-await-in-loop -- Need to process directories sequentially
        const stats = await fsp.stat(fullPath);

        if (stats.isFile()) {
          // Store relative path from the base directory
          const relativePath = fullPath.slice(basePath.length + 1);
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

    await collectStatsRecursive(path, path);
    return fileStats;
  },

  // Get all files in a directory recursively as a map of relative paths to file contents
  async getDirectoryContents(path: string): Promise<Record<string, Uint8Array<ArrayBuffer>>> {
    await ensureReady();
    const fileStats = await this.getDirectoryStat(path);

    const fileContents = await Promise.all(
      fileStats.map(async (fileStat) => {
        const fullPath = joinPath(path, fileStat.path);
        const buffer = await fsp.readFile(fullPath);
        const content = new Uint8Array(asBuffer(buffer.buffer), buffer.byteOffset, buffer.byteLength);
        return { path: fileStat.path, content };
      }),
    );

    const files: Record<string, Uint8Array<ArrayBuffer>> = {};
    for (const { path: filePath, content } of fileContents) {
      files[filePath] = content;
    }

    return files;
  },

  async copyDirectory(sourcePath: string, destinationPath: string): Promise<void> {
    await ensureReady();
    const files = await this.getDirectoryContents(sourcePath);
    const destinationFiles: Record<string, { content: Uint8Array<ArrayBuffer> }> = {};

    for (const [relativePath, content] of Object.entries(files)) {
      destinationFiles[joinPath(destinationPath, relativePath)] = { content };
    }

    await this.writeFiles(destinationFiles);
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
};
