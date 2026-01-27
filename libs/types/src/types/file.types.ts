import type { exportFormats } from '#constants/file.constants.js';

export type ExportFormat = (typeof exportFormats)[number];

export type GeometryFile = {
  path: string;
  filename: string;
};

/**
 * Base file tree entry type for API transfer and serialization.
 * Used to represent files and directories in the file tree.
 */
export type FileTreeEntry = {
  path: string;
  name: string;
  type: 'file' | 'dir';
  size: number;
};

/**
 * Represents a file or directory entry in the filesystem.
 * Extends FileTreeEntry with client-side state.
 * Used for file tree representations and filesystem operations.
 */
export type FileEntry = FileTreeEntry & {
  isLoaded: boolean;
};

export type FileStat = {
  path: string;
  name: string;
  type: 'file' | 'dir';
  size: number;
  mtimeMs: number;
};
