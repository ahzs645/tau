/**
 * Tau Kernel Module
 *
 * Converts CAD file formats (STEP, STL, OBJ, etc.) to GLTF for display.
 * Uses @taucad/converter under the hood.
 *
 * This is the reference implementation of the defineKernel pattern.
 */

import type { KernelIssue } from '@taucad/types';
import { defineKernel } from '@taucad/types';
import { importToGlb, exportFromGlb, supportedImportFormats } from '@taucad/converter';
import type { InputFormat, OutputFormat } from '@taucad/converter';
import { asBuffer } from '@taucad/utils/file';
import { createKernelError, createKernelSuccess } from '#framework/kernel-helpers.js';

type TauContext = Record<string, never>;

type TauNativeHandle = Uint8Array<ArrayBuffer>;

function getFileExtension(filename: string): string {
  const lastDotIndex = filename.lastIndexOf('.');
  if (lastDotIndex === -1 || lastDotIndex === filename.length - 1) {
    return '';
  }

  return filename.slice(lastDotIndex + 1).toLowerCase();
}

function getBasename(filename: string): string {
  const lastSlashIndex = filename.lastIndexOf('/');
  return lastSlashIndex === -1 ? filename : filename.slice(lastSlashIndex + 1);
}

function resolveToRelative(absolutePath: string, basePath: string): string {
  const normalizedBase = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  if (absolutePath.startsWith(`${normalizedBase}/`)) {
    return absolutePath.slice(normalizedBase.length + 1);
  }

  return absolutePath;
}

export default defineKernel<TauContext, TauNativeHandle>({
  name: 'TauKernel',
  version: '1.0.0',

  async initialize() {
    return {};
  },

  async canHandle({ extension }) {
    return supportedImportFormats.includes(extension as InputFormat);
  },

  async getDependencies({ filePath }) {
    return [filePath];
  },

  async getParameters() {
    return createKernelSuccess({
      defaultParameters: {},
      jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
    });
  },

  async createGeometry({ filePath, basePath }, { filesystem, logger }) {
    const relativeFilePath = resolveToRelative(filePath, basePath);
    const filename = getBasename(filePath);
    try {
      const data = await filesystem.readFile(filePath);
      const format = getFileExtension(filename);
      const formattedFormat = String(format).toUpperCase();
      logger.log(`Converting ${formattedFormat} to GLB`);

      const glbData = await importToGlb([{ name: filename, data }], format as InputFormat);

      logger.log(`Successfully converted ${formattedFormat} to GLB`);

      return {
        geometry: [{ format: 'gltf' as const, content: glbData }],
        nativeHandle: glbData,
      };
    } catch (error) {
      logger.error('Error converting file', { data: error });
      const errorMessage = error instanceof Error ? error.message : 'Failed to convert file';
      throw new TauBuildError([
        {
          message: errorMessage,
          location: { fileName: relativeFilePath, startLineNumber: 1, startColumn: 1 },
          type: 'runtime',
          severity: 'error',
        },
      ]);
    }
  },

  async exportGeometry({ fileType }, { logger }, _ctx, nativeHandle) {
    try {
      if (nativeHandle.length === 0) {
        return createKernelError([
          {
            message: 'No geometry available for export. Please build geometries before exporting.',
            type: 'runtime',
            severity: 'error',
          },
        ]);
      }

      logger.log('Exporting geometry', { data: { format: fileType } });

      const files = await exportFromGlb(nativeHandle, fileType as OutputFormat);

      const results = files.map((file) => ({
        blob: new Blob([asBuffer(file.data.buffer)]),
        name: file.name,
      }));

      logger.log('Successfully exported geometry');

      return createKernelSuccess(results);
    } catch (error) {
      logger.error('Error exporting geometry', { data: error });
      const errorMessage = error instanceof Error ? error.message : 'Failed to export geometry';
      return createKernelError([
        {
          message: errorMessage,
          type: 'runtime',
          severity: 'error',
        },
      ]);
    }
  },
});

class TauBuildError extends Error {
  public readonly issues: KernelIssue[];
  public constructor(issues: KernelIssue[]) {
    super(issues.map((i) => i.message).join('; '));
    this.issues = issues;
  }
}
