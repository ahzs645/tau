/**
 * File reading utilities for processing files, folders, and directory entries
 * from the browser File API and FileSystem API.
 */

import { joinPath } from '#utils/path.utils.js';

export type FileData = {
  filename: string;
  content: Uint8Array<ArrayBuffer>;
};

export type FileMap = Map<string, FileData>;

/**
 * Read a FileSystemFileEntry and return a File object.
 */
async function getFileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

/**
 * Read all entries from a FileSystemDirectoryReader.
 * Handles the case where readEntries() returns entries in batches.
 */
async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const entries: FileSystemEntry[] = [];

  const readBatch = async (): Promise<FileSystemEntry[]> =>
    new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });

  // ReadEntries returns entries in batches, need to call until empty
  let batch = await readBatch();
  while (batch.length > 0) {
    entries.push(...batch);
    // eslint-disable-next-line no-await-in-loop -- need to read batches sequentially
    batch = await readBatch();
  }

  return entries;
}

type ProgressCallback = (processed: number, total: number) => void;
type ProgressStats = { processed: number; total: number };

/**
 * Recursively read a FileSystemEntry (file or directory) and add to files map.
 */
async function readEntry(
  entry: FileSystemEntry,
  basePath: string,
  files: FileMap,
  progressInfo?: { onProgress?: ProgressCallback; stats?: ProgressStats },
): Promise<void> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await getFileFromEntry(fileEntry);
    const path = basePath ? joinPath(basePath, entry.name) : entry.name;
    const arrayBuffer = await file.arrayBuffer();
    files.set(path, {
      filename: path,
      content: new Uint8Array(arrayBuffer),
    });

    if (progressInfo?.stats && progressInfo.onProgress) {
      progressInfo.stats.processed++;
      progressInfo.onProgress(progressInfo.stats.processed, progressInfo.stats.total);
    }
  } else if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry;
    const reader = dirEntry.createReader();
    const entries = await readAllEntries(reader);
    const newBase = basePath ? joinPath(basePath, entry.name) : entry.name;

    // Update total count
    if (progressInfo?.stats) {
      progressInfo.stats.total += entries.filter((entryItem) => entryItem.isFile).length;
    }

    for (const child of entries) {
      // eslint-disable-next-line no-await-in-loop -- need to read sequentially for progress
      await readEntry(child, newBase, files, progressInfo);
    }
  }
}

/**
 * Read files from a DataTransferItemList (drag-and-drop).
 * Handles both files and folders via the FileSystemEntry API.
 */
export async function readFromDataTransfer(
  items: DataTransferItemList,
  onProgress?: ProgressCallback,
): Promise<FileMap> {
  const files: FileMap = new Map();
  const entries: FileSystemEntry[] = [];

  // Collect all entries first
  for (const item of items) {
    if (item.kind === 'file') {
      const entry = item.webkitGetAsEntry();
      if (entry) {
        entries.push(entry);
      }
    }
  }

  // Count initial files (not directories, they'll be counted during traversal)
  const stats: ProgressStats = {
    processed: 0,
    total: entries.filter((entryItem) => entryItem.isFile).length,
  };

  // Process all entries
  for (const entry of entries) {
    // eslint-disable-next-line no-await-in-loop -- need to read sequentially for progress
    await readEntry(entry, '', files, { onProgress, stats });
  }

  return normalizeFilePaths(files);
}

/**
 * Read files from a FileList (file input or webkitdirectory input).
 * Preserves relative paths from webkitRelativePath if available.
 */
export async function readFromFileList(fileList: FileList | File[], onProgress?: ProgressCallback): Promise<FileMap> {
  const files: FileMap = new Map();
  const fileArray = [...fileList];
  const total = fileArray.length;

  for (const [index, file] of fileArray.entries()) {
    // Use webkitRelativePath if available (folder upload), otherwise just filename
    const path = file.webkitRelativePath || file.name;

    // eslint-disable-next-line no-await-in-loop -- need to read sequentially for progress
    const arrayBuffer = await file.arrayBuffer();
    files.set(path, {
      filename: path,
      content: new Uint8Array(arrayBuffer),
    });

    onProgress?.(index + 1, total);
  }

  return normalizeFilePaths(files);
}

/**
 * Check if a file is a ZIP archive based on extension or MIME type.
 */
export function isZipFile(file: File): boolean {
  const extension = file.name.split('.').pop()?.toLowerCase();

  return extension === 'zip' || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
}

/**
 * Normalize file paths by stripping common root directory if all files share one.
 * This handles the case where a folder is uploaded and all files are under that folder.
 */
export function normalizeFilePaths(files: FileMap): FileMap {
  const paths = [...files.keys()];

  if (paths.length === 0) {
    return files;
  }

  // Split all paths into segments
  const segments = paths.map((p) => p.split('/'));

  // Find the minimum segment count (excluding the filename itself)
  const minDepth = Math.min(...segments.map((s) => s.length));

  if (minDepth <= 1) {
    // No common prefix possible
    return files;
  }

  // Find common prefix (full directory segments only, not including the file itself)
  const commonDepth = findCommonDepth(segments, minDepth);

  if (commonDepth === 0) {
    return files;
  }

  // Strip common prefix
  const normalized: FileMap = new Map();
  for (const [path, data] of files) {
    const newPath = path.split('/').slice(commonDepth).join('/');
    if (newPath) {
      normalized.set(newPath, { ...data, filename: newPath });
    }
  }

  return normalized;
}

/**
 * Find the common directory depth shared by all path segments.
 */
function findCommonDepth(segments: string[][], minDepth: number): number {
  let commonDepth = 0;

  for (let i = 0; i < minDepth - 1; i++) {
    const segment = segments[0]?.[i];
    if (!segment) {
      break;
    }

    const allMatch = segments.every((segs) => segs[i] === segment);
    if (!allMatch) {
      break;
    }

    commonDepth = i + 1;
  }

  return commonDepth;
}

/**
 * Get the name to use for a disk import based on the files.
 * Uses the common root directory name if one exists, otherwise uses the first file's name.
 */
export function getImportName(files: FileMap, originalName?: string): string {
  if (originalName) {
    // Strip .zip extension if present
    return originalName.replace(/\.zip$/i, '');
  }

  const paths = [...files.keys()];
  if (paths.length === 0) {
    return 'Untitled Import';
  }

  // If there's only one file, use its name without extension
  if (paths.length === 1) {
    const fileName = paths[0]?.split('/').pop() ?? 'Untitled';

    return fileName.replace(/\.[^.]+$/, '');
  }

  // Try to find a common root
  const segments = paths.map((p) => p.split('/'));
  const firstRoot = segments[0]?.[0];

  if (firstRoot && segments.every((s) => s[0] === firstRoot)) {
    return firstRoot;
  }

  return 'Uploaded Files';
}
