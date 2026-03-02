import type { exportFormats } from '#constants/file.constants.js';
import type { MimeType } from '#types/mime-types.types.js';

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

/**
 * Stat result returned by filesystem `stat`/`lstat` operations.
 * Matches the shape of Node.js `fs.Stats` reduced to the fields
 * relevant for virtual filesystem operations.
 */
export type FileStat = {
  type: 'file' | 'dir';
  size: number;
  mtimeMs: number;
};

/**
 * Stat result enriched with path and name for directory listing operations.
 * Returned by `readdirStat` and similar directory enumeration APIs.
 */
export type FileStatEntry = FileStat & {
  path: string;
  name: string;
};

/** Named binary file used as input to conversion/import operations. */
export type FileInput = {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
};

/**
 * A named binary file produced by an export operation.
 * Shared across @taucad/kernels (ExportGeometryResult) and @taucad/converter output.
 */
export type ExportFile = {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: MimeType;
};
