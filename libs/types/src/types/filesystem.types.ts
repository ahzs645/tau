/**
 * File System Types
 *
 * Types for filesystem operations and state management.
 */

import type { filesystemBackends } from '#constants/filesystem.constants.js';

/**
 * Available filesystem backend types.
 */
export type FilesystemBackend = (typeof filesystemBackends)[number];

/**
 * Filesystem backend configuration.
 * Used to define backend implementations with canHandle/create pattern.
 */
export type FilesystemBackendConfig = {
  readonly name: FilesystemBackend;
  readonly label: string;
  readonly description: string;
  readonly canHandle: () => boolean;
  readonly create: () => Promise<void>;
};

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
