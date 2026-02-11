/**
 * Kernel Diagnostics Hook
 *
 * Subscribes to kernel issues from the CAD machine and pushes them as
 * Monaco markers through the MonacoMarkerService. Handles all files
 * (not just the active file) and clears stale markers when issues resolve.
 *
 * Also provides handleValidate callback for forwarding Monaco TS markers
 * to the CAD actor (Monaco-to-kernel direction).
 */

import { useCallback, useEffect, useRef } from 'react';
import { useSelector } from '@xstate/react';
import type * as Monaco from 'monaco-editor';
import type { AnyActorRef } from 'xstate';
import type { IssueSeverity } from '@taucad/types';
import type { MonacoMarkerService } from '#lib/monaco-marker-service.js';

const kernelMarkerOwner = 'kernel';

/**
 * Map IssueSeverity to Monaco MarkerSeverity.
 */
function getMarkerSeverity(monaco: typeof Monaco, severity: IssueSeverity | undefined): Monaco.MarkerSeverity {
  switch (severity) {
    case 'warning': {
      return monaco.MarkerSeverity.Warning;
    }

    case 'info': {
      return monaco.MarkerSeverity.Info;
    }

    case 'error': {
      return monaco.MarkerSeverity.Error;
    }

    default: {
      return monaco.MarkerSeverity.Error;
    }
  }
}

type UseKernelDiagnosticsOptions = {
  monaco: typeof Monaco | undefined;
  cadActor: AnyActorRef;
  markerService: MonacoMarkerService | undefined;
};

type UseKernelDiagnosticsReturn = {
  handleValidate: () => void;
};

/**
 * Hook to sync kernel diagnostics to/from Monaco markers.
 *
 * Kernel-to-Monaco: Subscribes to cadActor.context.kernelIssues for ALL files,
 * pushes markers through MarkerService.
 *
 * Monaco-to-Kernel: Reads Monaco TS markers and forwards errors to cadActor.
 */
export function useKernelDiagnostics(options: UseKernelDiagnosticsOptions): UseKernelDiagnosticsReturn {
  const { monaco, cadActor, markerService } = options;

  // Track previous set of files with issues to clear stale markers
  const previousFilesRef = useRef<Set<string>>(new Set());

  // Subscribe to ALL kernel issues (not just active file)
  const kernelIssues = useSelector(
    cadActor,
    (state) =>
      state.context.kernelIssues as Map<
        string,
        Array<{
          message: string;
          location?: {
            fileName: string;
            startLineNumber: number;
            startColumn: number;
            endLineNumber?: number;
            endColumn?: number;
          };
          severity: IssueSeverity;
        }>
      >,
  );

  // Sync kernel issues to Monaco markers via MarkerService
  useEffect(() => {
    if (!monaco || !markerService) {
      return;
    }

    const currentFiles = new Set<string>();

    // Set markers for all files with issues.
    // Issues may reference files different from the entry file (cross-file errors),
    // so we group by location.fileName to place markers on the correct file.
    for (const [filePath, issues] of kernelIssues) {
      // Group issues by their actual source file (from location.fileName),
      // falling back to the entry filePath for issues without location.
      const issuesByFile = new Map<string, Monaco.editor.IMarkerData[]>();

      for (const issue of issues) {
        if (!issue.location) {
          continue;
        }

        const targetFile = issue.location.fileName;
        if (!issuesByFile.has(targetFile)) {
          issuesByFile.set(targetFile, []);
        }

        issuesByFile.get(targetFile)!.push({
          startLineNumber: issue.location.startLineNumber,
          startColumn: issue.location.startColumn,
          endLineNumber: issue.location.endLineNumber ?? issue.location.startLineNumber,
          endColumn: issue.location.endColumn ?? issue.location.startColumn + 1,
          message: issue.message,
          severity: getMarkerSeverity(monaco, issue.severity),
        });
      }

      // Apply markers to each target file
      for (const [targetFile, markers] of issuesByFile) {
        currentFiles.add(targetFile);
        const uri = monaco.Uri.file(`/${targetFile}`).toString();
        markerService.setMarkers(uri, kernelMarkerOwner, markers);
      }

      // If no issues had location, still track the entry file to clear stale markers
      if (issuesByFile.size === 0) {
        currentFiles.add(filePath);
      }
    }

    // Clear markers for files that no longer have issues
    for (const previousFile of previousFilesRef.current) {
      if (!currentFiles.has(previousFile)) {
        const uri = monaco.Uri.file(`/${previousFile}`).toString();
        markerService.clearMarkers(uri, kernelMarkerOwner);
      }
    }

    previousFilesRef.current = currentFiles;
  }, [monaco, markerService, kernelIssues]);

  // Monaco-to-Kernel: forward TS error markers to CAD actor
  const handleValidate = useCallback(() => {
    if (!monaco) {
      return;
    }

    const errors = monaco.editor.getModelMarkers({});
    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- monaco has import issues. This is safe.
    const filteredErrors = errors.filter((error) => error.severity === 8);

    if (filteredErrors.length > 0) {
      cadActor.send({
        type: 'setCodeIssues',
        errors: filteredErrors.map((error) => ({
          startLineNumber: error.startLineNumber,
          startColumn: error.startColumn,
          message: error.message,
          severity: error.severity,
          endLineNumber: error.endLineNumber,
          endColumn: error.endColumn,
        })),
      });
    } else {
      cadActor.send({ type: 'setCodeIssues', errors: [] });
    }
  }, [monaco, cadActor]);

  return { handleValidate };
}
