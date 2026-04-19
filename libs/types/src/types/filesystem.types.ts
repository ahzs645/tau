/**
 * File System Types
 *
 * Types for filesystem operations and state management.
 */

import type { filesystemBackends } from '#constants/filesystem.constants.js';

/**
 * Available filesystem backend types.
 */
export type FileSystemBackend = (typeof filesystemBackends)[number];

/**
 * Filesystem backend configuration.
 * Used to define backend implementations with canHandle/create pattern.
 */
export type FileSystemBackendConfig = {
  readonly name: FileSystemBackend;
  readonly label: string;
  readonly description: string;
  readonly canHandle: () => boolean;
  readonly create: () => Promise<void>;
};

/**
 * Discriminated union of filesystem change events emitted by the event bus.
 * @public
 */
export type ChangeEvent =
  | { type: 'fileWritten'; path: string; backend: FileSystemBackend }
  | { type: 'fileDeleted'; path: string; backend: FileSystemBackend }
  | { type: 'fileRenamed'; oldPath: string; newPath: string; backend: FileSystemBackend }
  | { type: 'directoryChanged'; path: string; backend: FileSystemBackend }
  | { type: 'backendChanged'; backend: FileSystemBackend };

/**
 * File Status in the filesystem
 */
export type FileStatus = 'clean' | 'modified' | 'added' | 'deleted' | 'untracked';

/**
 * File System Item
 *
 * Represents a file or directory in the virtual filesystem.
 */
export type FileSystemItem = {
  path: string;
  content: string;
  isDirectory: boolean;
  status?: FileStatus;
  lastModified?: number;
  size?: number;
};
