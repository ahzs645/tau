import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useMemo, useCallback } from 'react';
import { useActorRef, useSelector } from '@xstate/react';
import { fromPromise } from 'xstate';
import type { ActorRefFrom } from 'xstate';
import type { Geometry, KernelConfig, BundlerConfig, MiddlewareConfig } from '@taucad/types';
import type { JSONSchema7 } from 'json-schema';
import { cadMachine } from '#machines/cad.machine.js';
import { cadPreviewMachine } from '#machines/cad-preview.machine.js';
import type { PrepareFilesInput } from '#machines/cad-preview.machine.js';
import { graphicsMachine } from '#machines/graphics.machine.js';
import { useFileManager } from '#hooks/use-file-manager.js';
import { joinPath } from '#utils/path.utils.js';
import {
  defaultKernelConfig,
  defaultMiddlewareConfig,
  defaultBundlerConfig,
} from '#constants/kernel-worker.constants.js';
import { defaultGraphicsSettings } from '#constants/editor.constants.js';

/**
 * Status of the CAD preview.
 */
export type CadPreviewStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Context value exposed by CadPreviewProvider via the useCadPreview() hook.
 */
export type CadPreviewContextValue = {
  readonly geometries: Geometry[];
  readonly status: CadPreviewStatus;
  readonly error: Error | undefined;
  readonly cadRef: ActorRefFrom<typeof cadMachine>;
  readonly graphicsRef: ActorRefFrom<typeof graphicsMachine>;
  readonly defaultParameters: Record<string, unknown>;
  readonly jsonSchema: JSONSchema7 | undefined;
  readonly setParameters: (parameters: Record<string, unknown>) => void;
};

const CadPreviewContext = createContext<CadPreviewContextValue | undefined>(undefined);

/**
 * Props for CadPreviewProvider.
 */
export type CadPreviewProviderProps = {
  readonly buildId: string;
  readonly mainFile: string;
  /** When provided, files are written to ZenFS before kernel init. Omit for dynamic builds where files already exist. */
  readonly files?: Record<string, { content: Uint8Array<ArrayBuffer> }>;
  readonly parameters?: Record<string, unknown>;
  /** Whether the build should be triggered (default: true) */
  readonly isEnabled?: boolean;
  readonly kernelConfig?: KernelConfig;
  readonly middlewareConfig?: MiddlewareConfig;
  readonly bundlerConfig?: BundlerConfig;
  readonly children: ReactNode;
};

function deriveStatus(cadState: string): CadPreviewStatus {
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
 * Provider that creates a lightweight CAD rendering pipeline (cadMachine + graphicsMachine),
 * optionally writes files to ZenFS, and exposes all rendering state via the useCadPreview() hook.
 *
 * Replaces the heavyweight BuildProvider for preview-only contexts.
 * Uses cadPreviewMachine to orchestrate file preparation and kernel initialization,
 * following the same invoke+fromPromise pattern as buildMachine.
 *
 * @example Simple thumbnail
 * ```tsx
 * <CadPreviewProvider buildId="my-build" mainFile="main.ts" files={files}>
 *   <CadPreviewViewer className="size-full" />
 * </CadPreviewProvider>
 * ```
 *
 * @example Dynamic build (files already in ZenFS)
 * ```tsx
 * <CadPreviewProvider buildId={existingBuildId} mainFile="main.ts">
 *   <CadPreviewViewer enablePan enableZoom />
 * </CadPreviewProvider>
 * ```
 */
export function CadPreviewProvider({
  buildId,
  mainFile,
  files,
  parameters,
  isEnabled = true,
  kernelConfig,
  middlewareConfig,
  bundlerConfig,
  children,
}: CadPreviewProviderProps): React.JSX.Element {
  const { writeFiles, exists, fileManagerRef } = useFileManager();

  const cadRef = useActorRef(cadMachine, {
    input: {
      shouldInitializeKernelOnStart: false,
      fileManagerRef,
      kernelConfig: kernelConfig ?? defaultKernelConfig,
      middlewareConfig: middlewareConfig ?? defaultMiddlewareConfig,
      bundlerConfig: bundlerConfig ?? defaultBundlerConfig,
    },
  });

  const graphicsRef = useActorRef(graphicsMachine, {
    input: {
      defaultCameraFovAngle: defaultGraphicsSettings.cameraFovAngle,
      measureSnapDistance: 40,
      enableSurfaces: defaultGraphicsSettings.enableSurfaces,
      enableLines: defaultGraphicsSettings.enableLines,
      enableGizmo: defaultGraphicsSettings.enableGizmo,
      enableGrid: defaultGraphicsSettings.enableGrid,
      enableAxes: defaultGraphicsSettings.enableAxes,
      enableMatcap: defaultGraphicsSettings.enableMatcap,
      enablePostProcessing: defaultGraphicsSettings.enablePostProcessing,
      upDirection: defaultGraphicsSettings.upDirection,
      environmentPreset: defaultGraphicsSettings.environmentPreset,
    },
  });

  // Orchestration machine -- file preparation + cadRef initialization.
  // prepareFiles actor is injected via .provide(), capturing writeFiles/exists
  // from useFileManager() in the closure (same pattern as buildMachine's loadBuildActor).
  const previewRef = useActorRef(
    cadPreviewMachine.provide({
      actors: {
        prepareFiles: fromPromise<void, PrepareFilesInput>(async ({ input }) => {
          if (input.files) {
            const firstFilePath = Object.keys(input.files)[0];
            const alreadyExists = firstFilePath && (await exists(joinPath('/builds', input.buildId, firstFilePath)));

            if (!alreadyExists) {
              const buildFiles: Record<string, { content: Uint8Array<ArrayBuffer> }> = {};
              for (const [path, file] of Object.entries(input.files)) {
                buildFiles[joinPath('/builds', input.buildId, path)] = file;
              }

              await writeFiles(buildFiles);
            }
          }
        }),
      },
    }),
    {
      input: {
        cadRef,
        buildId,
        mainFile,
        files,
        parameters,
      },
    },
  );

  // Send 'start' when enabled -- the machine handles the rest
  useEffect(() => {
    if (isEnabled) {
      previewRef.send({ type: 'start' });
    }
  }, [isEnabled, previewRef]);

  // Selectors on cadRef for reactive state
  const geometries = useSelector(cadRef, (s) => s.context.geometries);
  const cadStateValue = useSelector(cadRef, (s) => s.value);
  const kernelIssues = useSelector(cadRef, (s) => s.context.kernelIssues);
  const defaultParameters = useSelector(cadRef, (s) => s.context.defaultParameters);
  const jsonSchema = useSelector(cadRef, (s) => s.context.jsonSchema);
  const cadUnits = useSelector(cadRef, (s) => s.context.units);

  // Initialization error from the preview machine
  const initError = useSelector(previewRef, (s) => s.context.initError);

  const status = deriveStatus(typeof cadStateValue === 'string' ? cadStateValue : 'idle');

  const error = useMemo(() => {
    if (initError) {
      return initError;
    }

    if (status !== 'error') {
      return undefined;
    }

    const firstIssue = [...kernelIssues.values()].flat()[0];
    if (firstIssue) {
      return new Error(firstIssue.message);
    }

    return new Error('Unknown CAD error');
  }, [status, kernelIssues, initError]);

  // Forward geometries to graphics machine
  useEffect(() => {
    if (geometries.length > 0) {
      graphicsRef.send({
        type: 'updateGeometries',
        geometries,
        units: cadUnits,
      });
    }
  }, [geometries, cadUnits, graphicsRef]);

  const setParameters = useCallback(
    (newParameters: Record<string, unknown>) => {
      previewRef.send({ type: 'setParameters', parameters: newParameters });
    },
    [previewRef],
  );

  const value = useMemo<CadPreviewContextValue>(
    () => ({
      geometries,
      status,
      error,
      cadRef,
      graphicsRef,
      defaultParameters,
      jsonSchema,
      setParameters,
    }),
    [geometries, status, error, cadRef, graphicsRef, defaultParameters, jsonSchema, setParameters],
  );

  return <CadPreviewContext.Provider value={value}>{children}</CadPreviewContext.Provider>;
}

/**
 * Access the CAD preview context from the nearest CadPreviewProvider.
 *
 * @example
 * ```tsx
 * const { geometries, status, setParameters } = useCadPreview();
 * ```
 */
export function useCadPreview(): CadPreviewContextValue;
export function useCadPreview(options: { readonly optional: true }): CadPreviewContextValue | undefined;
export function useCadPreview(options?: { readonly optional?: boolean }): CadPreviewContextValue | undefined {
  const context = useContext(CadPreviewContext);
  if (context === undefined && !options?.optional) {
    throw new Error('useCadPreview must be used within a CadPreviewProvider');
  }

  return context;
}
