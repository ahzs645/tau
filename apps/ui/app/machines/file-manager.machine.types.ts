/**
 * File Manager Machine Types
 *
 * Shared types for the file manager machine and its consumers.
 * This file is kept separate from the machine implementation to avoid
 * importing browser-only dependencies (Web Workers) during SSR.
 *
 * Note: `import type` is used for machine imports — this is purely
 * compile-time and produces zero runtime imports, so SSR is unaffected.
 */

import type { ActorRefFrom } from 'xstate';
import type { FileStat, FileStatEntry, FileSystemBackend } from '@taucad/types';
import type { FileManagerMachine } from '#machines/file-manager.machine.js';
import type { FileTreeNode, MkdirOptions } from '#machines/file-manager.js';

/**
 * The source of the file write operation.
 * - 'editor': Write originated from user typing in the Monaco editor (special case for recursion prevention)
 * - 'user': Write originated from user action (create file, upload, etc.)
 * - 'machine': Write originated from machine/programmatic source (e.g., chat AI)
 */
export type FileWriteSource = 'editor' | 'user' | 'machine';

/**
 * Emitted events for UI consumers (toasts, Monaco updates, etc.)
 */
export type FileManagerEmitted =
  | { type: 'fileWritten'; path: string; data: Uint8Array<ArrayBuffer>; source: FileWriteSource }
  | { type: 'fileRead'; path: string; data: Uint8Array<ArrayBuffer> }
  | { type: 'fileRenamed'; oldPath: string; newPath: string }
  | { type: 'fileDeleted'; path: string; source: FileWriteSource };

/**
 * Type-safe reference to the file manager XState actor.
 * Preserves the full XState type including literal event type unions.
 */
export type FileManagerRef = ActorRefFrom<FileManagerMachine>;

/**
 * File operations API surface used by Monaco services and UI components.
 * This is the superset of methods needed across all consumers.
 * Use `Pick<FileManagerApi, 'exists'>` etc. to narrow in component props.
 */
export type FileManagerApi = {
  readFile: (path: string) => Promise<Uint8Array<ArrayBuffer>>;
  exists: (path: string) => Promise<boolean>;
  readdir: (path: string) => Promise<string[]>;
  getDirectoryStat: (path: string) => Promise<FileStatEntry[]>;
};

/**
 * Full FileManager protocol served over MessagePort.
 * Superset of KernelFileSystem -- includes higher-level operations
 * and worker control methods (reconfigure, setDirectoryHandle).
 */
export type FileManagerProtocol = {
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
  reconfigure(backend: FileSystemBackend): Promise<void>;
  setDirectoryHandle(handle: FileSystemDirectoryHandle): void;
  readBackendFileTree(backend: FileSystemBackend, handle?: FileSystemDirectoryHandle): Promise<FileTreeNode[]>;
};

/**
 * FileManagerProtocol proxy with dispose method for cleanup.
 */
export type FileManagerProxy = FileManagerProtocol & { dispose(): void };
