import type { ReactNode, RefCallback } from 'react';
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, Download } from 'lucide-react';
import type { FileExtension, Geometry } from '@taucad/types';
import { downloadBlob } from '@taucad/utils/file';
import { toast } from '#components/ui/sonner.js';
import { StaticPreviewViewer } from '#components/cad-preview.js';
import { ModelViewer, RenderStatusOverlay } from '#components/model-viewer.js';
import { Button } from '#components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#components/ui/dropdown-menu.js';
import { FileManagerProvider, SharedWorkerGate } from '#hooks/use-file-manager.js';
import { CadPreviewProvider, useCadPreview } from '#hooks/use-cad-preview.js';
import type { CadPreviewStatus } from '#hooks/use-cad-preview.js';
import { PreviewParameters } from '#routes/projects_.$id_.preview/preview-parameters.js';
import type { PlaygroundExample, PlaygroundPreset } from '#routes/playground/playground-examples.js';
import { extractModifiedProperties } from '#utils/object.utils.js';
import { cn } from '#utils/ui.utils.js';

export type PlaygroundMobilePane = '3d' | 'params';

const orientationGizmoContainerId = 'playground-orientation-gizmo';

/**
 * Circular bottom-right host for the XYZ orientation gizmo, targeted by the
 * viewer via `graphicsOptions.gizmoContainer`. The gizmo draws into a
 * sub-viewport of the shared viewer canvas underneath this element, so the
 * element itself stays transparent and only contributes the ring chrome.
 */
function OrientationGizmoContainer(): React.JSX.Element {
  return (
    <div className='pointer-events-none absolute right-4 bottom-4 z-10'>
      <div
        id={orientationGizmoContainerId}
        className='pointer-events-auto relative size-20 shrink-0 rounded-full border shadow-sm'
      />
    </div>
  );
}

export const playgroundPreviewCapabilities = {
  parameters: true,
} as const;

type PlaygroundPreviewPaneProps = {
  readonly activeExample: PlaygroundExample;
  readonly cachedGeometries: readonly Geometry[] | undefined;
  readonly files: Record<string, { content: Uint8Array<ArrayBuffer> }>;
  readonly isInteractive: boolean;
  readonly parameters: Record<string, unknown>;
  readonly previewGeometryCacheKey: string;
  readonly previewProjectId: string;
  readonly previewRenderKey: string;
  readonly staticPreviewUrl: string | undefined;
  readonly mobilePane: PlaygroundMobilePane;
  readonly exportControlsElement: HTMLDivElement | undefined;
  readonly onGeometriesReady: (geometries: readonly Geometry[], parameters: Record<string, unknown>) => void;
  readonly onParametersChange: (parameters: Record<string, unknown>) => void;
};

type PlaygroundPreviewSnapshot = {
  readonly cacheKey: string;
  readonly error: Error | undefined;
  readonly geometries: readonly Geometry[];
  readonly status: CadPreviewStatus;
};

export function PlaygroundPreviewPane({
  activeExample,
  cachedGeometries,
  files,
  isInteractive,
  parameters,
  previewGeometryCacheKey,
  previewProjectId,
  previewRenderKey,
  staticPreviewUrl,
  mobilePane,
  exportControlsElement,
  onGeometriesReady,
  onParametersChange,
}: PlaygroundPreviewPaneProps): React.JSX.Element {
  const isEditableExample = activeExample.mode !== 'static';
  const [mobileExportControlsElement, setMobileExportControlsElement] = useState<HTMLDivElement | undefined>();
  const [previewSnapshot, setPreviewSnapshot] = useState<PlaygroundPreviewSnapshot | undefined>();
  const setMobileExportControlsRef = useCallback<RefCallback<HTMLDivElement>>((node) => {
    setMobileExportControlsElement(node ?? undefined);
  }, []);

  const isCurrentPreviewSnapshot =
    previewSnapshot !== undefined && previewSnapshot.cacheKey === previewGeometryCacheKey;
  const displayGeometries =
    isCurrentPreviewSnapshot && previewSnapshot.geometries.length > 0
      ? [...previewSnapshot.geometries]
      : cachedGeometries
        ? [...cachedGeometries]
        : [];
  const displayStatus: CadPreviewStatus = isCurrentPreviewSnapshot ? previewSnapshot.status : 'loading';
  const displayError =
    isCurrentPreviewSnapshot && previewSnapshot.status === 'error'
      ? (previewSnapshot.error ?? new Error('Failed to render preview'))
      : undefined;
  const handlePreviewStateChange = useCallback(
    ({
      error,
      geometries,
      status,
    }: {
      readonly error: Error | undefined;
      readonly geometries: readonly Geometry[];
      readonly status: CadPreviewStatus;
    }) => {
      setPreviewSnapshot({
        cacheKey: previewGeometryCacheKey,
        error,
        geometries,
        status,
      });
    },
    [previewGeometryCacheKey],
  );

  if (!isEditableExample) {
    return (
      <section className='flex min-h-0 min-w-0 flex-1 flex-col'>
        <div className='relative min-h-0 flex-1 bg-muted/30'>
          {staticPreviewUrl ? (
            <>
              <StaticPreviewViewer
                className='size-full'
                enablePan
                enableZoom
                staticPreviewUrl={staticPreviewUrl}
                stageOptions={{ zoomLevel: 1.25 }}
                graphicsOptions={{
                  enableLines: true,
                  enableGizmo: true,
                  gizmoVariant: 'axes',
                  gizmoContainer: `#${orientationGizmoContainerId}`,
                  viewerClassName: 'bg-muted/30',
                }}
              />
              <OrientationGizmoContainer />
            </>
          ) : null}
        </div>
      </section>
    );
  }

  const previewSection = (
    <section
      className={cn(
        'flex min-w-0 flex-col xl:min-h-0 xl:border-r',
        mobilePane === '3d' ? 'max-xl:flex-1' : 'max-xl:hidden',
      )}
    >
      <div className='relative min-h-0 flex-1 bg-muted/30'>
        {displayGeometries.length === 0 && !displayError && staticPreviewUrl ? (
          <StaticPreviewViewer
            className='size-full'
            enablePan
            enableZoom
            staticPreviewUrl={staticPreviewUrl}
            stageOptions={{ zoomLevel: 1.25 }}
            graphicsOptions={{
              enableLines: activeExample.showPreviewLines ?? true,
              enableGizmo: true,
              gizmoVariant: 'axes',
              gizmoContainer: `#${orientationGizmoContainerId}`,
              viewerClassName: 'bg-muted/30',
            }}
          />
        ) : (
          <ModelViewer
            geometries={displayGeometries}
            className='size-full'
            enablePan
            enableZoom
            stageOptions={{ zoomLevel: 1.25 }}
            graphicsOptions={{
              enableLines: activeExample.showPreviewLines ?? true,
              enableGizmo: true,
              gizmoVariant: 'axes',
              gizmoContainer: `#${orientationGizmoContainerId}`,
              viewerClassName: 'bg-muted/30',
            }}
            error={displayError}
          />
        )}
        <OrientationGizmoContainer />
        <RenderStatusOverlay
          status={displayStatus === 'loading' && displayGeometries.length === 0 ? 'loading' : 'idle'}
          className='absolute top-3 left-3'
        />

        {/* Mobile export: lives on the viewer instead of the crowded header,
            offset left of the orientation gizmo circle. */}
        {activeExample.exportFormats.length > 0 ? (
          <div ref={setMobileExportControlsRef} className='absolute right-28 bottom-3 z-10 xl:hidden' />
        ) : null}
      </div>
    </section>
  );

  if (!isInteractive) {
    return previewSection;
  }

  return (
    <SharedWorkerGate>
      {previewSection}

      <FileManagerProvider
        key={previewProjectId}
        projectId={previewProjectId}
        rootDirectory={`/projects/${previewProjectId}`}
        initialBackend='indexeddb'
      >
        <CadPreviewProvider
          key={previewRenderKey}
          projectId={previewProjectId}
          mainFile={activeExample.mainFile}
          files={files}
          parameters={parameters}
          renderTimeout={activeExample.renderTimeout}
          renderOptions={activeExample.renderOptions}
        >
          {exportControlsElement && activeExample.exportFormats.length > 0
            ? createPortal(
                <PlaygroundExportControls
                  exampleId={activeExample.id}
                  formats={activeExample.exportFormats}
                  buttonSize='sm'
                />,
                exportControlsElement,
              )
            : undefined}
          {mobileExportControlsElement && activeExample.exportFormats.length > 0
            ? createPortal(
                <PlaygroundExportControls
                  exampleId={activeExample.id}
                  formats={activeExample.exportFormats}
                  buttonSize='sm'
                  enableShortcut={false}
                />,
                mobileExportControlsElement,
              )
            : undefined}
          <PlaygroundPreviewStateBridge
            onGeometriesReady={onGeometriesReady}
            onPreviewStateChange={handlePreviewStateChange}
          />
          <PlaygroundParameterBridge onParametersChange={onParametersChange} />

          <section
            className={cn(
              'flex min-w-0 flex-col bg-background xl:min-h-0 xl:border-t-0',
              // Min-h-0 + overflow keep the list scrolling inside the pane instead of
              // running underneath the mobile bottom bar.
              mobilePane === 'params' ? 'max-xl:min-h-0 max-xl:flex-1 max-xl:overflow-y-auto' : 'max-xl:hidden',
            )}
          >
            <PlaygroundParameters presets={activeExample.presets ?? []} />
          </section>
        </CadPreviewProvider>
      </FileManagerProvider>
    </SharedWorkerGate>
  );
}

function PlaygroundPreviewStateBridge({
  onGeometriesReady,
  onPreviewStateChange,
}: {
  readonly onGeometriesReady: (geometries: readonly Geometry[], parameters: Record<string, unknown>) => void;
  readonly onPreviewStateChange: (snapshot: {
    readonly error: Error | undefined;
    readonly geometries: readonly Geometry[];
    readonly status: CadPreviewStatus;
  }) => void;
}): ReactNode {
  const { error, geometries, parameters, status } = useCadPreview();

  useEffect(() => {
    onPreviewStateChange({ error, geometries, status });

    if (status === 'ready' && geometries.length > 0) {
      onGeometriesReady(geometries, parameters);
    }
  }, [error, geometries, parameters, status, onGeometriesReady, onPreviewStateChange]);

  return undefined;
}

/**
 * Bridges the preview's live parameter overrides out to the header (where the Share button lives,
 * outside the provider). Renders nothing.
 */
function PlaygroundParameterBridge({
  onParametersChange,
}: {
  readonly onParametersChange: (parameters: Record<string, unknown>) => void;
}): ReactNode {
  const { parameters, defaultParameters, jsonSchema } = useCadPreview();
  // The kernel can briefly report schema defaults as if they were overrides while the
  // parameter schema is still being extracted. Strip anything equal to the reported
  // defaults so only genuine user overrides reach the session (and the shared URL).
  const liveParameters = useMemo(
    () => extractModifiedProperties(parameters, defaultParameters) as Record<string, unknown>,
    [parameters, defaultParameters],
  );

  // Surface the live overrides to the header so Share can encode them. Until the kernel
  // has produced a parameter schema its parameter context is just the initializing
  // empty record — forwarding that would wipe the restored variant session (and the
  // share URL) on every kernel remount after a variant switch.
  useEffect(() => {
    if (jsonSchema === undefined) {
      return;
    }
    onParametersChange(liveParameters);
  }, [jsonSchema, liveParameters, onParametersChange]);

  return undefined;
}

function PlaygroundParameters({ presets }: { readonly presets: readonly PlaygroundPreset[] }): React.JSX.Element {
  return (
    <div className='flex h-full min-h-0 flex-col'>
      <PreviewParameters headerActions={presets.length > 0 ? <PlaygroundPresetMenu presets={presets} /> : undefined} />
    </div>
  );
}

function PlaygroundPresetMenu({ presets }: { readonly presets: readonly PlaygroundPreset[] }): React.JSX.Element {
  const { setParameters } = useCadPreview();

  const applyPreset = useCallback(
    (preset: PlaygroundPreset) => {
      setParameters(preset.parameters);
      toast.success(`Applied ${preset.name}`);
    },
    [setParameters],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant='ghost' size='xs' className='gap-1'>
          Presets
          <ChevronDown className='size-3.5' />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end'>
        {presets.map((preset) => (
          <DropdownMenuItem
            key={preset.name}
            onSelect={() => {
              applyPreset(preset);
            }}
          >
            {preset.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type ActorSubscription = {
  readonly unsubscribe: () => void;
};

function issueMessage(errors: ReadonlyArray<{ readonly message?: unknown }>): string {
  const message = errors[0]?.message;
  return typeof message === 'string' ? message : 'Export failed';
}

function PlaygroundExportControls({
  exampleId,
  formats,
  buttonSize = 'xs',
  enableShortcut = true,
}: {
  readonly exampleId: string;
  readonly formats: readonly FileExtension[];
  readonly buttonSize?: 'xs' | 'sm';
  readonly enableShortcut?: boolean;
}): React.JSX.Element {
  const { cadRef, geometries, status } = useCadPreview();
  const [isExporting, setIsExporting] = useState(false);
  const isExportEnabled = status === 'ready' && geometries.length > 0 && !isExporting;
  const primaryFormat = formats[0];

  const exportGeometry = useCallback(
    (format: FileExtension) => {
      if (!isExportEnabled) {
        return;
      }

      setIsExporting(true);

      // oxlint-disable-next-line tau-lint/no-async-iife -- export completion is delivered through actor events.
      void (async () => {
        try {
          const blob = await new Promise<Blob>((resolve, reject) => {
            const subscriptions: ActorSubscription[] = [];

            const cleanup = () => {
              for (const subscription of subscriptions) {
                subscription.unsubscribe();
              }
            };

            subscriptions.push(
              cadRef.on('geometryExported', (event) => {
                cleanup();
                resolve(event.blob);
              }),
              cadRef.on('exportFailed', (event) => {
                cleanup();
                reject(new Error(issueMessage(event.errors)));
              }),
            );

            cadRef.send({ type: 'exportGeometry', format });
          });

          const filename = `${exampleId}.${format}`;
          downloadBlob(blob, filename);
          toast.success(`Downloaded ${filename}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Export failed';
          toast.error(`Failed to export: ${message}`);
        } finally {
          setIsExporting(false);
        }
      })();
    },
    [cadRef, isExportEnabled, exampleId],
  );

  useEffect(() => {
    if (!enableShortcut) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'F7' && primaryFormat) {
        event.preventDefault();
        exportGeometry(primaryFormat);
      }
    };

    globalThis.addEventListener('keydown', handleKeyDown);
    return () => {
      globalThis.removeEventListener('keydown', handleKeyDown);
    };
  }, [enableShortcut, exportGeometry, primaryFormat]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant='outline' size={buttonSize} disabled={!isExportEnabled} title='Export. Shortcut: F7'>
          <Download className='size-3' />
          {isExporting ? 'Exporting…' : 'Export'}
          <ChevronDown className='size-3 opacity-60' />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end'>
        {formats.map((format) => (
          <DropdownMenuItem
            key={format}
            onSelect={() => {
              exportGeometry(format);
            }}
          >
            <Download className='size-3.5' />
            {format.toUpperCase()}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
