import type { FileStat, FileStatEntry, FileSystemBackend } from '@taucad/types';
import type { FileTreeNode, MkdirOptions, MountOptions, WatchEvent, WatchRequest } from '@taucad/filesystem';

/**
 * Typed filesystem RPC surface consumed by main-thread facades such as
 * `FileContentService` and `FileTreeService`. Matches the worker `FileManager` protocol without
 * transport lifecycle hooks (`listen`, `dispose`).
 *
 * @public
 * @example <caption>Import the client type for a host adapter</caption>
 * ```typescript
 * import type { FileSystemClient } from '@taucad/fs-client/file-system-client';
 * export function exampleExists(adapter: FileSystemClient): Promise<boolean> {
 *   return adapter.exists('/');
 * }
 * ```
 */
export type FileSystemClient = {
  readFile(filepath: string, options: 'utf8' | { encoding: 'utf8' }): Promise<string>;
  readFile(filepath: string, options?: Record<string, never>): Promise<Uint8Array<ArrayBuffer>>;
  readFiles(paths: string[]): Promise<Record<string, Uint8Array<ArrayBuffer>>>;
  writeFile(filepath: string, data: Uint8Array<ArrayBuffer> | string): Promise<void>;
  writeFiles(files: Record<string, { content: Uint8Array<ArrayBuffer> }>): Promise<void>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<FileStat>;
  lstat(path: string): Promise<FileStat>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  batchExists(paths: string[]): Promise<Record<string, boolean>>;
  ensureDirectoryExists(path: string): Promise<void>;
  getDirectoryStat(path: string): Promise<FileStatEntry[]>;
  getDirectoryContents(path: string): Promise<Record<string, Uint8Array<ArrayBuffer>>>;
  duplicateFile(sourcePath: string, destinationPath: string): Promise<void>;
  copyDirectory(sourcePath: string, destinationPath: string): Promise<void>;
  getZippedDirectory(path: string): Promise<Blob>;
  mount(prefix: string, backend: FileSystemBackend, options?: MountOptions): Promise<void>;
  unmount(prefix: string): void;
  setDirectoryHandle(handle: FileSystemDirectoryHandle): void;
  readShallowDirectory(
    path: string,
    backend: FileSystemBackend,
    handle?: FileSystemDirectoryHandle,
  ): Promise<FileTreeNode[]>;

  readDirectory(path: string): Promise<FileTreeNode[]>;

  searchFiles(
    basePath: string,
    query: string,
    options?: { maxResults?: number; includeDirectories?: boolean },
  ): FileStatEntry[];

  watch(request: WatchRequest, handler: (event: WatchEvent) => void): () => void;
};
