import { useEffect, useRef, useCallback, useMemo } from 'react';
import { useActorRef, useSelector } from '@xstate/react';
import type { Geometry, GeometryFile } from '@taucad/types';
import { cadMachine } from '#machines/cad.machine.js';
import { useFileManager } from '#hooks/use-file-manager.js';
import { joinPath } from '#utils/path.utils.js';

/**
 * Options for the useCadFiles hook.
 */
export type UseCadFilesOptions = {
  /** Unique identifier for this build (used for file path namespacing) */
  readonly buildId: string;
  /** Main entry file name (e.g., 'main.js') */
  readonly mainFile: string;
  /** Map of file paths to file contents */
  readonly files: Record<string, { content: Uint8Array<ArrayBuffer> }>;
  /** Optional parameters to pass to the CAD kernel */
  readonly parameters?: Record<string, unknown>;
  /** Whether the build should be triggered (default: true) */
  readonly enabled?: boolean;
};

/**
 * Status of the CAD build.
 */
export type CadFilesStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Result returned by the useCadFiles hook.
 */
export type UseCadFilesResult = {
  /** Array of geometries produced by the CAD kernel */
  readonly geometries: Geometry[];
  /** Current status of the build */
  readonly status: CadFilesStatus;
  /** Error if status is 'error' */
  readonly error: Error | undefined;
};

/**
 * Derives the status from the cad machine state value.
 */
function deriveStatus(cadState: string): CadFilesStatus {
  switch (cadState) {
    case 'ready': {
      return 'ready';
    }

    case 'rendering':
    case 'initializing':
    case 'bufferingFile':
    case 'bufferingParameters': {
      return 'loading';
    }

    case 'error': {
      return 'error';
    }

    default: {
      return 'idle';
    }
  }
}

/**
 * A lightweight hook for loading CAD files and obtaining geometries.
 *
 * Uses `cadMachine` directly without the heavyweight BuildProvider,
 * making it suitable for scenarios where you only need geometry output
 * without the full build management infrastructure.
 *
 * @example
 * ```tsx
 * const { geometries, status } = useCadFiles({
 *   buildId: 'my-build',
 *   mainFile: 'main.js',
 *   files: { 'main.js': { content: fileContent } },
 *   parameters: { mode: 'assembly' },
 *   enabled: true,
 * });
 * ```
 */
export function useCadFiles(options: UseCadFilesOptions): UseCadFilesResult {
  const { buildId, mainFile, files, parameters, enabled = true } = options;

  const { writeFiles, fileManagerRef } = useFileManager();

  // Track whether we've initialized the build
  const hasInitializedRef = useRef(false);

  // Create cadMachine directly - lightweight, no build machine overhead
  const cadRef = useActorRef(cadMachine, {
    input: {
      shouldInitializeKernelOnStart: false,
      fileManagerRef,
      // No graphicsRef or logRef - we just want geometries
    },
  });

  // Subscribe to state
  const geometries = useSelector(cadRef, (s) => s.context.geometries);
  const cadStateValue = useSelector(cadRef, (s) => s.value);
  const kernelIssues = useSelector(cadRef, (s) => s.context.kernelIssues);

  // Derive status from state
  const status = deriveStatus(typeof cadStateValue === 'string' ? cadStateValue : 'idle');

  // Extract first error from kernel issues if any
  const error = useMemo(() => {
    if (status !== 'error') {
      return undefined;
    }

    const firstIssue = [...kernelIssues.values()].flat()[0];
    if (firstIssue) {
      return new Error(firstIssue.message);
    }

    return new Error('Unknown CAD error');
  }, [status, kernelIssues]);

  // Stable reference to parameters for dependency tracking
  const parametersRef = useRef(parameters);
  parametersRef.current = parameters;

  // Write files and trigger build
  const runBuild = useCallback(async () => {
    // Write files to virtual filesystem
    const buildFiles: Record<string, { content: Uint8Array<ArrayBuffer> }> = {};
    for (const [path, file] of Object.entries(files)) {
      buildFiles[joinPath('/builds', buildId, path)] = file;
    }

    await writeFiles(buildFiles);

    // Initialize model - triggers kernel init + geometry computation
    const file: GeometryFile = {
      path: `/builds/${buildId}`,
      filename: mainFile,
    };
    cadRef.send({
      type: 'initializeModel',
      file,
      parameters: parametersRef.current ?? {},
    });
  }, [buildId, mainFile, files, writeFiles, cadRef]);

  // Trigger build when enabled
  useEffect(() => {
    if (!enabled || hasInitializedRef.current) {
      return;
    }

    hasInitializedRef.current = true;
    void runBuild();
  }, [enabled, runBuild]);

  return {
    geometries,
    status,
    error,
  };
}
