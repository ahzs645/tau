import type {
  CreateGeometryResult,
  ExportFormat,
  ExportGeometryResult,
  GetParametersResult,
  GeometryGltf,
  KernelRuntime,
  CanHandleInput,
  GetDependenciesInput,
  CreateGeometryInput,
  ExportGeometryInput,
} from '@taucad/types';
import { importToGlb, exportFromGlb, supportedExportFormats, supportedImportFormats } from '@taucad/converter';
import type { InputFormat, OutputFormat } from '@taucad/converter';
import { exposeWorker } from '#components/geometry/kernel/utils/comlink-worker.utils.js';
import { createKernelError, createKernelSuccess } from '#components/geometry/kernel/utils/kernel-helpers.js';
import { KernelWorker } from '#components/geometry/kernel/utils/kernel-worker.js';
import { asBuffer } from '#utils/file.utils.js';
import { wrapForComlink } from '#components/geometry/kernel/utils/kernel-comlink-adapter.js';

class TauWorker extends KernelWorker {
  protected static override readonly supportedExportFormats: ExportFormat[] = supportedExportFormats as ExportFormat[];
  protected override readonly name: string = 'TauWorker';
  private glbDataMemory: Record<string, Uint8Array<ArrayBuffer>> = {};

  protected override async cleanup(): Promise<void> {
    this.glbDataMemory = {};
  }

  protected override async canHandle({ extension }: CanHandleInput, _runtime: KernelRuntime): Promise<boolean> {
    // Import supported formats from converter
    return supportedImportFormats.includes(extension as InputFormat);
  }

  protected override async getParameters(): Promise<GetParametersResult> {
    // Files don't have parameters by default
    // In the future, we may extract parameters from file metadata
    return createKernelSuccess({
      defaultParameters: {},
      jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
    });
  }

  protected override async getDependencies({ filePath }: GetDependenciesInput): Promise<string[]> {
    // TauWorker processes individual files without dependencies
    // Return absolute path
    return [filePath];
  }

  protected override getAssetUrls(): string[] {
    // TauWorker uses @taucad/converter which bundles WASM internally.
    // Cache invalidation relies on the Tau framework version.
    return [];
  }

  protected override async createGeometry(
    { filePath, basePath }: CreateGeometryInput,
    { filesystem, logger }: KernelRuntime,
  ): Promise<CreateGeometryResult> {
    const relativeFilePath = KernelWorker.resolveToRelative(filePath, basePath);
    const geometryId = 'default';
    const filename = KernelWorker.getBasename(filePath);
    try {
      // Read file as binary
      const data = await filesystem.readFile(filePath);
      const format = KernelWorker.getFileExtension(filename);
      const formattedFormat = String(format).toUpperCase();
      logger.log(`Converting ${formattedFormat} to GLB`);

      // Convert file to GLB using the converter
      const glbData = await importToGlb([{ name: filename, data }], format as InputFormat);

      // Store GLB data for export
      this.glbDataMemory[geometryId] = glbData;

      // Create geometry object
      const geometry: GeometryGltf = {
        format: 'gltf',
        content: glbData,
      };

      logger.log(`Successfully converted ${formattedFormat} to GLB`);

      return createKernelSuccess([geometry]);
    } catch (error) {
      logger.error('Error converting file', { data: error });
      const errorMessage = error instanceof Error ? error.message : 'Failed to convert file';
      return createKernelError([
        {
          message: errorMessage,
          location: { fileName: relativeFilePath, startLineNumber: 1, startColumn: 1 },
          type: 'runtime',
          severity: 'error',
        },
      ]);
    }
  }

  protected override async exportGeometry(
    { fileType }: ExportGeometryInput,
    { logger }: KernelRuntime,
  ): Promise<ExportGeometryResult> {
    try {
      const geometryId = 'default';
      const glbData = this.glbDataMemory[geometryId];
      if (!glbData) {
        // System error - no location needed
        return createKernelError([
          {
            message: `Geometry ${geometryId} not computed yet. Please build geometries before exporting.`,
            type: 'runtime',
            severity: 'error',
          },
        ]);
      }

      logger.log('Exporting geometry', { data: { format: fileType } });

      // Use converter to export from GLB
      const files = await exportFromGlb(glbData, fileType as OutputFormat);

      const results = files.map((file) => ({
        blob: new Blob([asBuffer(file.data.buffer)]),
        name: file.name,
      }));

      logger.log('Successfully exported geometry');

      return createKernelSuccess(results);
    } catch (error) {
      logger.error('Error exporting geometry', { data: error });
      const errorMessage = error instanceof Error ? error.message : 'Failed to export geometry';
      // Export error - no specific file location
      return createKernelError([
        {
          message: errorMessage,
          type: 'runtime',
          severity: 'error',
        },
      ]);
    }
  }
}

const worker = new TauWorker();
const service = wrapForComlink(worker);
exposeWorker(service);

export type TauWorkerInterface = typeof service;
