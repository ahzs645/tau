import type { ReactNode, RefCallback } from 'react';
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useActorRef } from '@xstate/react';
import type { ActorRefFrom } from 'xstate';
import { ChevronDown, Download, Upload, X } from 'lucide-react';
import type { FileRejection } from 'react-dropzone';
import { useDropzone } from 'react-dropzone';
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
import { FileManagerProvider, SharedWorkerGate, useFileManager } from '#hooks/use-file-manager.js';
import { CadPreviewProvider, useCadPreview } from '#hooks/use-cad-preview.js';
import { GraphicsProvider } from '#hooks/use-graphics.js';
import { graphicsMachine } from '#machines/graphics.machine.js';
import { defaultGraphicsSettings } from '#constants/editor.constants.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '#components/ui/tooltip.js';
import { Popover, PopoverContent, PopoverTrigger } from '#components/ui/popover.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#components/ui/select.js';
import { FovControl } from '#components/geometry/cad/fov-control.js';
import { GridSizeIndicator } from '#components/geometry/cad/grid-control.js';
import { MeasureControl } from '#components/geometry/cad/measure-control.js';
import { MeasureReadout, ModelSizeIndicator } from '#components/geometry/cad/measure-readout.js';
import { MeasureSnapModeControl } from '#components/geometry/cad/measure-snap-mode-control.js';
import { SectionViewControl } from '#components/geometry/cad/section-view-control.js';
import { ResetCameraControl } from '#components/geometry/cad/reset-camera-control.js';
import { ViewerSettings } from '#components/geometry/cad/viewer-settings.js';
import {
  FovOverflowControl,
  GridOverflowControl,
  SectionViewOverflowControl,
  MeasureOverflowControl,
  ResetCameraOverflowControl,
} from '#components/geometry/cad/viewer-overflow-controls.js';
import { useToolbarOverflow } from '#hooks/use-toolbar-overflow.js';
import type { ToolbarItemConfig } from '#hooks/use-toolbar-overflow.js';
import { useResizeObserver } from '#hooks/use-resize-observer.js';
import { ArButton } from '#components/cad/ar-button.js';
import type { CadPreviewStatus } from '#hooks/use-cad-preview.js';
import { PreviewParameters } from '#routes/projects_.$id_.preview/preview-parameters.js';
import type {
  PlaygroundComponents,
  PlaygroundExample,
  PlaygroundPreset,
  PlaygroundUpload,
  PlaygroundUploadedFile,
} from '#routes/playground/playground-examples.js';
import { parseUploadAccept } from '#routes/playground/projects.js';
import { extractModifiedProperties } from '#utils/object.utils.js';
import { cn } from '#utils/ui.utils.js';

export type PlaygroundMobilePane = '3d' | 'params';

const orientationGizmoContainerId = 'playground-orientation-gizmo';

type PlaygroundGraphicsRef = ActorRefFrom<typeof graphicsMachine>;

/**
 * One graphics actor shared between the preview viewer and the utilities
 * toolbar, so toolbar buttons (measure, section view, reset camera) drive the
 * same viewer the geometries render in.
 */
function usePlaygroundGraphicsRef(): PlaygroundGraphicsRef {
  return useActorRef(graphicsMachine, {
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
      graphicsBackendPreference: defaultGraphicsSettings.graphicsBackend ?? 'webgl',
    },
  });
}

/**
 * Control items ordered by "stickiness" (first = last to overflow), matching
 * the main app's viewer toolbar: FOV stays visible the longest, reset camera
 * overflows into the settings dropdown first.
 */
const toolbarItems: ToolbarItemConfig[] = [
  { id: 'fov', width: 200, compactWidth: 120 },
  { id: 'grid', width: 32 },
  { id: 'section', width: 32 },
  { id: 'measure', width: 32 },
  { id: 'reset', width: 32 },
];

/** Gap-2 = 8px, settings button (32px) + one gap (8px) = 40px reserved */
const toolbarOverflowOptions = { gap: 8, reservedWidth: 40 } as const;

/**
 * Bottom-left viewer control bar mirroring the main app's toolbar: FOV slider,
 * grid units, section view, measure, camera reset, and viewer settings.
 * Controls that don't fit the measured width collapse into the settings
 * dropdown (compact FOV labels first, then right-to-left overflow), so the
 * full toolbar stays usable on phone-width viewports. Must render inside a
 * `GraphicsProvider` bound to the same actor as the viewer.
 */
function PlaygroundViewerToolbar({ mobileExportSlot }: { readonly mobileExportSlot?: ReactNode }): React.JSX.Element {
  const measureRef = useRef<HTMLDivElement>(null);
  const { width: toolbarAvailableWidth } = useResizeObserver({ ref: measureRef });
  const { visibleIds, overflowIds, isCompact } = useToolbarOverflow(
    toolbarItems,
    toolbarAvailableWidth,
    toolbarOverflowOptions,
  );

  const overflowControls =
    overflowIds.size === 0 ? undefined : (
      <>
        {overflowIds.has('reset') && <ResetCameraOverflowControl />}
        {overflowIds.has('measure') && <MeasureOverflowControl />}
        {overflowIds.has('section') && <SectionViewOverflowControl />}
        {overflowIds.has('grid') && <GridOverflowControl />}
        {overflowIds.has('fov') && <FovOverflowControl />}
      </>
    );

  return (
    <TooltipProvider>
      {/* Content-independent width probe (left gutter to just left of the 82px
          orientation gizmo disc), so toolbar overflow can't feed back into the
          measurement and can restore when the pane widens again. */}
      <div ref={measureRef} aria-hidden className='pointer-events-none absolute right-28 bottom-0 left-3' />
      <div className='absolute bottom-3 left-3 z-10 flex flex-col items-start gap-2'>
        {mobileExportSlot}
        <MeasureReadout />
        <ModelSizeIndicator />
        <MeasureSnapModeControl className='flex-row' tooltipSide='top' />
        <div className='flex items-center gap-2'>
          {visibleIds.has('fov') && <FovControl className={isCompact ? 'w-30' : 'w-50'} isCompact={isCompact} />}
          {visibleIds.has('grid') && <GridSizeIndicator />}
          {visibleIds.has('section') && <SectionViewControl />}
          {visibleIds.has('measure') && <MeasureControl />}
          {visibleIds.has('reset') && <ResetCameraControl />}
          <ViewerSettings overflowControls={overflowControls} />
        </div>
      </div>
    </TooltipProvider>
  );
}

/**
 * Circular bottom-right host for the XYZ orientation gizmo, targeted by the
 * viewer via `graphicsOptions.gizmoContainer`. The gizmo draws into a
 * sub-viewport of the shared viewer canvas underneath this element, so the
 * element itself stays transparent and only contributes the ring chrome.
 */
function OrientationGizmoContainer(): React.JSX.Element {
  return (
    <div className='pointer-events-none absolute right-4 bottom-4 z-10'>
      {/* Fixed pixel size: the gizmo canvas is exactly 80px, so the host must be
          82px (1px border each side) and must not scale with root font-size. */}
      <div
        id={orientationGizmoContainerId}
        className='pointer-events-auto relative size-[82px] shrink-0 rounded-full border shadow-sm'
      />
    </div>
  );
}

export const playgroundPreviewCapabilities = {
  parameters: true,
} as const;

async function fetchGlbBytes(url: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const response = await fetch(url);
  if (!response.ok) {
    return undefined;
  }

  return new Uint8Array(await response.arrayBuffer());
}

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
  readonly uploads?: readonly PlaygroundUpload[];
  /** The files the project ships under each slot's `fileName`. */
  readonly shippedFiles?: Record<string, PlaygroundUploadedFile>;
  /** The files the viewer has supplied, by the name they are written under. */
  readonly uploadedFiles?: Record<string, PlaygroundUploadedFile>;
  readonly onUpload?: (upload: PlaygroundUpload, file: PlaygroundUploadedFile) => void;
  readonly onUploadReset?: (upload: PlaygroundUpload) => void;
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
  uploads,
  shippedFiles,
  uploadedFiles,
  onUpload,
  onUploadReset,
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

  const graphicsRef = usePlaygroundGraphicsRef();
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

  // AR Quick Look source: the live kernel render when available, otherwise the
  // pre-rendered static GLB. Works for every example mode — no kernel needed.
  const hasArSource = displayGeometries.some((g) => g.format === 'gltf') || staticPreviewUrl !== undefined;
  const getArGlbData = useCallback(async (): Promise<Uint8Array<ArrayBuffer> | undefined> => {
    const gltfGeometry = displayGeometries.find((g) => g.format === 'gltf');
    if (gltfGeometry?.format === 'gltf') {
      return gltfGeometry.content;
    }

    return staticPreviewUrl === undefined ? undefined : fetchGlbBytes(staticPreviewUrl);
  }, [displayGeometries, staticPreviewUrl]);

  // Mobile-only iOS Quick Look launcher; renders nothing elsewhere. Sits above
  // the orientation gizmo disc in the bottom-right corner.
  const arButton = (
    <ArButton
      geometries={displayGeometries}
      getGlbData={hasArSource ? getArGlbData : undefined}
      className='absolute right-4 bottom-28 z-10'
    />
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
                graphicsRef={graphicsRef}
                stageOptions={{ zoomLevel: 1.25 }}
                graphicsOptions={{
                  enableLines: true,
                  enableGizmo: true,
                  gizmoVariant: 'axes',
                  gizmoContainer: `#${orientationGizmoContainerId}`,
                  // Pre-rendered static GLBs are exported in glTF meters; the
                  // viewer (and its measure/size readouts) works in millimeters.
                  modelUnitScale: 1000,
                  viewerClassName: 'bg-muted/30',
                }}
              />
              <GraphicsProvider graphicsRef={graphicsRef}>
                <PlaygroundViewerToolbar />
              </GraphicsProvider>
              <OrientationGizmoContainer />
              {arButton}
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
            graphicsRef={graphicsRef}
            stageOptions={{ zoomLevel: 1.25 }}
            graphicsOptions={{
              enableLines: activeExample.showPreviewLines ?? true,
              enableGizmo: true,
              gizmoVariant: 'axes',
              gizmoContainer: `#${orientationGizmoContainerId}`,
              // Pre-rendered static GLBs are exported in glTF meters; the
              // viewer (and its measure/size readouts) works in millimeters.
              modelUnitScale: 1000,
              viewerClassName: 'bg-muted/30',
            }}
          />
        ) : (
          <ModelViewer
            geometries={displayGeometries}
            graphicsRef={graphicsRef}
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
        <GraphicsProvider graphicsRef={graphicsRef}>
          <PlaygroundViewerToolbar
            // Mobile export: lives on the viewer instead of the crowded header,
            // stacked above the control bar.
            mobileExportSlot={
              activeExample.exportFormats.length > 0 ? (
                <div ref={setMobileExportControlsRef} className='xl:hidden' />
              ) : undefined
            }
          />
        </GraphicsProvider>
        <OrientationGizmoContainer />
        {arButton}
        <RenderStatusOverlay
          status={displayStatus === 'loading' && displayGeometries.length === 0 ? 'loading' : 'idle'}
          className='absolute top-3 left-3'
        />
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
            <PlaygroundParameters
              presets={activeExample.presets ?? []}
              components={activeExample.components}
              uploads={uploads}
              shippedFiles={shippedFiles}
              uploadedFiles={uploadedFiles}
              onUpload={onUpload}
              onUploadReset={onUploadReset}
            />
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

function PlaygroundParameters({
  presets,
  components,
  uploads,
  shippedFiles,
  uploadedFiles,
  onUpload,
  onUploadReset,
}: {
  readonly presets: readonly PlaygroundPreset[];
  readonly components?: PlaygroundComponents;
  readonly uploads?: readonly PlaygroundUpload[];
  /** The files the project ships under each slot's `fileName`. */
  readonly shippedFiles?: Record<string, PlaygroundUploadedFile>;
  /** The files the viewer has supplied, by the name they are written under. */
  readonly uploadedFiles?: Record<string, PlaygroundUploadedFile>;
  readonly onUpload?: (upload: PlaygroundUpload, file: PlaygroundUploadedFile) => void;
  readonly onUploadReset?: (upload: PlaygroundUpload) => void;
}): React.JSX.Element {
  // The parameters pane is the one surface present at every breakpoint — beside
  // the viewer on desktop, behind the Params tab on mobile — so neither control
  // here needs a separate mobile treatment.
  //
  // The two sit either side of the "Parameters" header on purpose. Which model
  // you are looking at is pinned above it, because it decides what the
  // parameters below even mean; the artwork is one of those parameters — it
  // shapes the stamp the way a dimension does — so it leads the list rather
  // than floating above it.
  const uploadControls =
    onUpload && onUploadReset && uploads && uploads.length > 0 ? { uploads, onUpload, onUploadReset } : undefined;
  const headerActions = presets.length > 0 ? <PlaygroundPresetMenu presets={presets} /> : undefined;
  const beforeParameters = uploadControls ? (
    <div className='border-b py-0.5'>
      {uploadControls.uploads.map((upload) => (
        <PlaygroundUploadRow
          key={upload.fileName}
          upload={upload}
          shipped={shippedFiles?.[upload.fileName]}
          uploaded={uploadedFiles?.[upload.fileName]}
          onUpload={uploadControls.onUpload}
          onReset={uploadControls.onUploadReset}
        />
      ))}
    </div>
  ) : undefined;

  return (
    <div className='flex h-full min-h-0 flex-col'>
      {components ? (
        <div className='shrink-0 border-b py-0.5'>
          <PlaygroundComponentRow components={components} />
        </div>
      ) : null}
      <div className='min-h-0 flex-1'>
        <PreviewParameters headerActions={headerActions} beforeParameters={beforeParameters} />
      </div>
    </div>
  );
}

/**
 * The project's component switch, pinned above the parameter list. It drives a
 * model parameter the model keeps in its `[Hidden]` customizer group, so the
 * choice appears here and only here rather than twice.
 */
function PlaygroundComponentRow({ components }: { readonly components: PlaygroundComponents }): React.JSX.Element {
  const { parameters, defaultParameters, setParameters } = useCadPreview();
  const current =
    typeof parameters[components.parameter] === 'string'
      ? (parameters[components.parameter] as string)
      : typeof defaultParameters[components.parameter] === 'string'
        ? (defaultParameters[components.parameter] as string)
        : components.options[0]!.value;

  const handleChange = useCallback(
    (value: string) => {
      setParameters({ ...parameters, [components.parameter]: value });
    },
    [components.parameter, parameters, setParameters],
  );

  return (
    <div className='@container/parameter my-1.5 flex items-center gap-2 px-2.5'>
      <span className='min-w-0 shrink-0 truncate text-sm font-medium @[240px]/parameter:w-[40%]'>
        {components.label}
      </span>
      <div className='flex min-w-0 flex-1 items-center justify-end'>
        <Select value={current} onValueChange={handleChange}>
          <SelectTrigger
            aria-label={components.label}
            className='h-[var(--param-field-h,1.5rem)] w-full rounded-[var(--param-field-radius,var(--radius-md))] border-border/50 bg-muted px-1.5 text-sm shadow-none'
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {components.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/**
 * One upload slot, shaped like the parameter rows below it: a label with the
 * app's modified indicator, and a compact field naming the file in force. The
 * field is the drop target and the file picker both, so the row stays the same
 * height as every other row in the pane.
 *
 * The picked file is written into the live preview filesystem here rather than
 * being handed to the route to seed a remount. That is deliberate: the kernel
 * worker outlives a preview remount, and it invalidates its file hashes from
 * filesystem *change* events. A file replaced between two mounts is therefore
 * a file it never saw change — it re-reads its own cached hash, the dependency
 * hash comes out identical, and the geometry cache answers the upload with the
 * render it already had. Writing into the mounted filesystem is the same path
 * an editor save takes, and it invalidates and re-renders the same way.
 *
 * Reset writes the project's own file back the same way, so "put it back how it
 * was" is the same gesture here as it is for a parameter.
 */
function PlaygroundUploadRow({
  upload,
  shipped,
  uploaded,
  onUpload,
  onReset,
}: {
  readonly upload: PlaygroundUpload;
  /** The file the project ships under `fileName`, if it ships one. */
  readonly shipped?: PlaygroundUploadedFile;
  /** The file the viewer supplied, once they have. */
  readonly uploaded?: PlaygroundUploadedFile;
  readonly onUpload: (upload: PlaygroundUpload, file: PlaygroundUploadedFile) => void;
  readonly onReset: (upload: PlaygroundUpload) => void;
}): React.JSX.Element {
  const { writeFile } = useFileManager();
  const current = uploaded ?? shipped;
  const preview = useMemo(
    () => (current ? imagePreviewSource(upload.accept, current.content) : undefined),
    [current, upload.accept],
  );

  const writeArtwork = useCallback(
    async (content: string) => writeFile(upload.fileName, new TextEncoder().encode(content), { source: 'user' }),
    [upload.fileName, writeFile],
  );

  const handleDrop = useCallback(
    (accepted: File[], rejections: FileRejection[]) => {
      const rejected = rejections[0]?.errors[0]?.message;
      if (rejected) {
        toast.error(rejected);
        return;
      }

      const file = accepted[0];
      if (!file) {
        return;
      }

      // oxlint-disable-next-line tau-lint/no-async-iife -- file read is the drop's whole purpose
      void (async () => {
        try {
          const content = await file.text();
          await writeArtwork(content);
          onUpload(upload, { name: file.name, content });
          toast.success(`Loaded ${file.name}`);
        } catch {
          toast.error(`Could not read ${file.name}`);
        }
      })();
    },
    [onUpload, upload, writeArtwork],
  );

  const handleReset = useCallback(() => {
    if (!shipped) {
      return;
    }

    // oxlint-disable-next-line tau-lint/no-async-iife -- the write is the reset
    void (async () => {
      try {
        await writeArtwork(shipped.content);
        onReset(upload);
        toast.success(`Restored ${shipped.name}`);
      } catch {
        toast.error(`Could not restore ${shipped.name}`);
      }
    })();
  }, [onReset, shipped, upload, writeArtwork]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: parseUploadAccept(upload.accept),
    maxFiles: 1,
    multiple: false,
    onDrop: handleDrop,
  });

  const isReplaced = uploaded !== undefined && shipped !== undefined;

  return (
    <TooltipProvider>
      <div className='group/field @container/parameter my-1.5 flex flex-col gap-0.5 px-2.5'>
        <div className='flex items-center gap-2'>
          <div className='flex min-w-0 shrink-0 items-center gap-1.5 @[240px]/parameter:w-[40%]'>
            <span
              className={cn(
                'truncate text-sm',
                isReplaced ? 'font-medium text-foreground' : 'font-normal text-muted-foreground',
              )}
            >
              {upload.label}
            </span>
          </div>
          <div className='flex min-w-0 flex-1 items-center justify-end gap-1.5'>
            {/* The artwork itself, one tap or click away. An SVG is a picture and
                seeing it is the quickest way to know the right file went in —
                especially here, where the OpenSCAD variant's render of a stroke
                drawing looks nothing like the drawing. A popover rather than a
                hover tooltip because touch has no hover, and this pane is a phone
                surface as much as a desktop one. White tile because the artwork
                carries no background and is usually drawn in black. */}
            {preview ? (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type='button'
                    aria-label={`Preview ${current?.name ?? upload.label}`}
                    className='size-[var(--param-field-h,1.5rem)] shrink-0 overflow-hidden rounded-[var(--param-field-radius,var(--radius-md))] border border-border/50 bg-white p-px transition-colors hover:border-border'
                  >
                    <img src={preview} alt='' className='size-full object-contain' />
                  </button>
                </PopoverTrigger>
                <PopoverContent side='left' align='start' className='w-auto bg-white p-1'>
                  <img src={preview} alt={`${upload.label} preview`} className='size-40 object-contain' />
                </PopoverContent>
              </Popover>
            ) : null}
            <button
              type='button'
              aria-label={`Upload for ${upload.label}`}
              {...getRootProps()}
              className={cn(
                'flex h-[var(--param-field-h,1.5rem)] min-w-0 flex-1 items-center gap-1.5 rounded-[var(--param-field-radius,var(--radius-md))] border border-border/50 bg-muted px-1.5 text-sm transition-colors',
                'text-[var(--param-field-color,var(--color-muted-foreground))] hover:border-border hover:text-[var(--param-field-color-focus,var(--color-foreground))]',
                isDragActive && 'border-ring text-foreground ring-1 ring-ring',
              )}
            >
              <input {...getInputProps()} />
              <Upload className='size-3.5 shrink-0' />
              <span className='truncate'>{current?.name ?? 'Choose a file…'}</span>
            </button>
            {/* Clearing the viewer's file is where a file control is expected to
                offer it — at the end of the field, not as the `ModifiedIndicator`
                dot beside the label that every other row uses. The dot is the
                right vocabulary for a parameter and the wrong one here: it is
                unlabelled, and someone looking for "remove this file" looks at
                the file, so they never find it. Clearing falls back to the file
                the project ships, which is what an empty slot would mean anyway. */}
            {isReplaced ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type='button'
                    aria-label={`Clear ${uploaded.name} and restore ${shipped.name}`}
                    className='flex size-[var(--param-field-h,1.5rem)] shrink-0 items-center justify-center rounded-[var(--param-field-radius,var(--radius-md))] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
                    onClick={handleReset}
                  >
                    <X className='size-3.5' />
                  </button>
                </TooltipTrigger>
                <TooltipContent side='left'>Restore {shipped.name}</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </div>
        <div className='text-xs text-muted-foreground/70'>
          {isReplaced ? `Clear to restore ${shipped.name}` : 'Drop a file here, or click to choose one'}
        </div>
      </div>
    </TooltipProvider>
  );
}

/**
 * A `data:` source for previewing an upload, when the declaration accepts an
 * image type and the content is textual (SVG). Data rather than a blob URL so
 * there is no object-URL lifetime to manage against a component that remounts
 * whenever the preview does.
 */
function imagePreviewSource(accept: string, content: string): string | undefined {
  const imageType = Object.keys(parseUploadAccept(accept) ?? {}).find((type) => type.startsWith('image/'));
  if (!imageType?.includes('svg')) {
    return undefined;
  }

  return `data:${imageType};charset=utf-8,${encodeURIComponent(content)}`;
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
