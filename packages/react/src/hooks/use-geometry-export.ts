import { useCallback, useState } from 'react';
import { exportFromGlb } from '@taucad/converter';
import type { SupportedExportFormat } from '@taucad/converter';
import type { Geometry } from '@taucad/types';
import { asBuffer, downloadBlob } from '@taucad/utils/file';

/**
 * Options for the {@link useGeometryExport} hook.
 *
 * @public
 */
export type UseGeometryExportOptions = {
  /** Geometries to export from. Must contain at least one `gltf` format geometry. */
  readonly geometries: Geometry[];
  /** Base filename used when no explicit filename is passed to `exportGeometry`. Defaults to `'model'`. */
  readonly defaultFilename?: string;
  /** Called when export succeeds. Receives the downloaded filename. */
  readonly onSuccess?: (filename: string) => void;
  /** Called when export fails. Receives the error. */
  readonly onError?: (error: unknown) => void;
};

/**
 * Result returned by the {@link useGeometryExport} hook.
 *
 * @public
 */
export type UseGeometryExportResult = {
  /** Trigger client-side export. Downloads the file automatically. */
  readonly exportGeometry: (format: SupportedExportFormat, filename?: string) => void;
  /** Whether an export is currently in progress. */
  readonly isExporting: boolean;
  /** Whether export is available (geometries contain a GLB/glTF source). */
  readonly canExport: boolean;
};

/**
 * Context-free, client-side geometry export hook.
 *
 * Finds a glTF geometry from the provided array, converts it to the
 * requested format via `exportFromGlb`, and triggers a browser download.
 * Reports success and error states via `onSuccess` and `onError` callbacks,
 * keeping the hook view-layer agnostic.
 *
 * Unlike `useCadExport` (which uses kernel-side export via `cadRef`),
 * this hook performs all conversion client-side using the converter package.
 *
 * @param options - Export configuration including geometries, filename, and callbacks
 * @returns Export state and trigger function
 * @public
 *
 * @example <caption>Export geometry with toast notifications</caption>
 * ```typescript
 * import { useGeometryExport } from '@taucad/react';
 * import type { Geometry } from '@taucad/types';
 *
 * const geometries: Geometry[] = [];
 *
 * const { exportGeometry, isExporting, canExport } = useGeometryExport({
 *   geometries,
 *   defaultFilename: 'my-model',
 *   onSuccess: (filename) => console.log(`Downloaded ${filename}`),
 *   onError: (err) => console.error(err instanceof Error ? err.message : 'Export failed'),
 * });
 * ```
 */
export function useGeometryExport(options: UseGeometryExportOptions): UseGeometryExportResult {
  const { geometries, defaultFilename = 'model', onSuccess, onError } = options;
  const [isExporting, setIsExporting] = useState(false);

  const canExport = geometries.some((g) => g.format === 'gltf');

  const exportGeometry = useCallback(
    (format: SupportedExportFormat, filename?: string) => {
      const gltfGeometry = geometries.find((g) => g.format === 'gltf');
      if (!gltfGeometry) {
        onError?.(new Error('No GLB geometry available. Model must be rendered first.'));
        return;
      }

      const fullFilename = `${filename ?? defaultFilename}.${format}`;

      setIsExporting(true);

      void (async () => {
        try {
          const exportedFiles = await exportFromGlb(gltfGeometry.content, format);
          const file = exportedFiles[0];
          if (!file) {
            throw new Error('No file returned from export');
          }

          const blob = new Blob([asBuffer(file.bytes.buffer)]);
          downloadBlob(blob, fullFilename);
          onSuccess?.(fullFilename);
        } catch (error: unknown) {
          onError?.(error);
        } finally {
          setIsExporting(false);
        }
      })();
    },
    [geometries, defaultFilename, onSuccess, onError],
  );

  return { exportGeometry, isExporting, canExport };
}
