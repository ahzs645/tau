import { useCallback } from 'react';
import { useActorRef, useSelector } from '@xstate/react';
import type { ExportFormat } from '@taucad/types';
import { fileExtensionFromExportFormat } from '@taucad/types/constants';
import { exportGeometryMachine } from '#machines/export-geometry.machine.js';
import { downloadBlob } from '#utils/file.utils.js';
import { toast } from '#components/ui/sonner.js';
import { useCadPreview } from '#hooks/use-cad-preview.js';

/**
 * Result returned by the useCadExport hook.
 */
export type UseCadExportResult = {
  /** Trigger a geometry export in the given format. Downloads the file automatically. */
  readonly exportGeometry: (format: ExportFormat, filename?: string) => void;
  /** Whether an export is currently in progress. */
  readonly isExporting: boolean;
};

/**
 * Companion hook for CadPreviewProvider that provides geometry export functionality.
 *
 * Wraps the exportGeometryMachine, reads cadRef from CadPreviewProvider context,
 * and handles toast notifications + file download automatically.
 *
 * @param defaultFilename - Base filename used when no explicit filename is passed to exportGeometry.
 *                          Defaults to 'model'.
 *
 * @example
 * ```tsx
 * function ExportButton() {
 *   const { exportGeometry, isExporting } = useCadExport('my-model');
 *   return <button disabled={isExporting} onClick={() => exportGeometry('stl')}>Export STL</button>;
 * }
 * ```
 */
export function useCadExport(defaultFilename = 'model'): UseCadExportResult {
  const { cadRef } = useCadPreview();

  const exportActorRef = useActorRef(exportGeometryMachine, {
    input: { cadRef },
  });

  const isExporting = useSelector(exportActorRef, (s) => s.value === 'exporting');

  const exportGeometry = useCallback(
    (format: ExportFormat, filename?: string) => {
      const fileExtension = fileExtensionFromExportFormat[format];
      const fullFilename = `${filename ?? defaultFilename}.${fileExtension}`;

      toast.promise(
        new Promise<Blob>((resolve, reject) => {
          exportActorRef.send({
            type: 'requestExport',
            format,
            onSuccess(blob) {
              downloadBlob(blob, fullFilename);
              resolve(blob);
            },
            onError(error) {
              reject(new Error(error));
            },
          });
        }),
        {
          loading: `Downloading ${fullFilename}...`,
          success: `Downloaded ${fullFilename}`,
          error(error) {
            let message = `Failed to download ${fullFilename}`;
            if (error instanceof Error) {
              message = `${message}: ${error.message}`;
            }

            return message;
          },
        },
      );
    },
    [exportActorRef, defaultFilename],
  );

  return { exportGeometry, isExporting };
}
