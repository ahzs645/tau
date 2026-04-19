import type { SupportedImportFormat, SupportedExportFormat } from '@taucad/converter';
import { formatConfigurations, isInputFormatSupported } from '@taucad/converter';
import type { FileExtension } from '@taucad/types';
import { getFileExtension } from '#utils/filesystem.utils.js';

/**
 * Extract file format from filename extension
 */
export function getFormatFromFilename(filename: string): SupportedImportFormat {
  const extension = getFileExtension(filename);

  if (!extension) {
    throw new Error('File has no extension');
  }

  if (!isInputFormatSupported(extension)) {
    throw new Error(`Unsupported file format: .${extension}`);
  }

  return extension;
}

/**
 * Get human-readable display name for format
 */
export function formatDisplayName(format: FileExtension): string {
  return formatConfigurations[format].name;
}

/**
 * Format file size in human-readable format
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) {
    return '0 Bytes';
  }

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${Number.parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
}

/**
 * Get file extension for output format
 */
export function getExtensionForFormat(format: SupportedExportFormat): string {
  return format;
}
