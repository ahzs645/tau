import { memo, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSelector } from '@xstate/react';
import type { DockviewApi, DockviewPanelApi, IDockviewPanelHeaderProps } from 'dockview-react';
import { FileX, FolderOpen } from 'lucide-react';
import type { FileEntry } from '@taucad/types';
import { CadViewer } from '#components/geometry/cad/cad-viewer.js';
import { FileSelector } from '#components/files/file-selector.js';
import { useBuild } from '#hooks/use-build.js';
import { useFileManager } from '#hooks/use-file-manager.js';
import { defaultGraphicsSettings } from '#constants/editor.constants.js';
import { CadProvider, useCad, useCadSelector } from '#hooks/use-cad.js';
import { GraphicsProvider, useGraphics, useGraphicsSelector } from '#hooks/use-graphics.js';
import { useViewSettingsSync } from '#hooks/use-view-settings-sync.js';
import { ChatStackTrace } from '#routes/builds_.$id/chat-stack-trace.js';
import { ChatViewerStatus } from '#routes/builds_.$id/chat-viewer-status.js';
import { ChatViewerControls } from '#routes/builds_.$id/chat-viewer-controls.js';
import { ChatInterfaceGraphics } from '#routes/builds_.$id/chat-interface-graphics.js';
import { ChatInterfaceStatus } from '#routes/builds_.$id/chat-interface-status.js';
import { useIsTopRightPanel } from '#components/panes/use-is-top-right-group.js';
import { useIsMobile } from '#hooks/use-mobile.js';
import { cn } from '#utils/ui.utils.js';

type ChatViewerProps = {
  /** Unique Dockview panel ID for this viewer instance */
  readonly viewId: string;
  /** File path being rendered in this viewer (undefined = empty state) */
  readonly entryFile: string | undefined;
  /** Dockview panel API for updating title, etc. */
  readonly panelApi: IDockviewPanelHeaderProps['api'];
  /** Dockview container API for layout-aware positioning */
  readonly containerApi: DockviewApi;
};

export const ChatViewer = memo(function ({
  viewId,
  entryFile,
  panelApi,
  containerApi,
}: ChatViewerProps): React.JSX.Element {
  const { buildRef, editorRef, viewGraphics, compilationUnits } = useBuild();
  const fileManager = useFileManager();

  // Get the per-view graphics machine
  const graphicsActor = viewGraphics.get(viewId);

  // Get the compilation unit for this view's entry file
  const cadActor = entryFile ? compilationUnits.get(entryFile) : undefined;

  // Get file list for the FileSelector
  const fileTree = useSelector(fileManager.fileManagerRef, (state) => state.context.fileTree);
  const files = useMemo(
    () =>
      [...fileTree.values()]
        .filter((entry: FileEntry) => entry.type === 'file')
        .map((entry: FileEntry) => ({ path: entry.path, size: entry.size })),
    [fileTree],
  );

  // Detect if the entry file is a directory.
  // The fileTree only stores file entries (not directories), so we check
  // whether entryFile is a prefix of any file path in the tree.
  const isDirectory = useMemo(() => {
    if (!entryFile) {
      return false;
    }

    const entry = fileTree.get(entryFile);
    if (entry) {
      return entry.type === 'dir';
    }

    const dirPrefix = `${entryFile}/`;
    for (const key of fileTree.keys()) {
      if (key.startsWith(dirPrefix)) {
        return true;
      }
    }

    return false;
  }, [entryFile, fileTree]);

  // Detect if the entry file is missing from the file tree.
  // Only report missing once the tree is populated (size > 0) to avoid
  // false positives during initial file system loading.
  const isMissing = useMemo(() => {
    if (!entryFile || fileTree.size === 0) {
      return false;
    }

    // Present in the tree -- not missing
    if (fileTree.has(entryFile)) {
      return false;
    }

    // If it's a directory prefix, it's not missing (handled by isDirectory)
    const dirPrefix = `${entryFile}/`;
    for (const key of fileTree.keys()) {
      if (key.startsWith(dirPrefix)) {
        return false;
      }
    }

    return true;
  }, [entryFile, fileTree]);

  // Get the current view settings from editor state for this panel
  const viewSettings = useSelector(editorRef, (state) => state.context.viewSettings);

  // Handle file selection in the viewport FileSelector
  const handleFileSelect = useCallback(
    (path: string) => {
      // Ensure compilation unit exists for the selected file
      if (!compilationUnits.has(path)) {
        buildRef.send({ type: 'createCompilationUnit', entryFile: path });
      }

      // Preserve existing view settings (FOV, visibility, environment preset, etc.)
      // But clear geometry-dependent state (camera pose, measurements) on file switch
      const existingGraphics = viewSettings[viewId]?.graphicsSettings;

      editorRef.send({
        type: 'setViewSettings',
        viewId,
        viewState: {
          entryFile: path,
          graphicsSettings: {
            ...(existingGraphics ?? defaultGraphicsSettings),
            // Clear geometry-dependent state on file switch
            pinnedMeasurements: undefined,
          },
        },
      });

      // Update Dockview panel params so the component re-renders with new entryFile
      panelApi.updateParameters({ entryFile: path });

      // Update the Dockview panel title
      const fileName = path.split('/').pop() ?? path;
      panelApi.setTitle(fileName);
    },
    [buildRef, editorRef, compilationUnits, viewId, panelApi, viewSettings],
  );

  // If no graphics actor yet, render a placeholder
  if (!graphicsActor) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <span className="text-sm">Initializing viewer...</span>
      </div>
    );
  }

  // If no file selected, render empty state with file selector
  if (!entryFile) {
    return (
      <GraphicsProvider graphicsRef={graphicsActor}>
        <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
          <span className="text-sm">No file selected</span>
          <FileSelector
            files={files}
            selectedFile={undefined}
            placeholder="Select file to render..."
            className="h-8 w-[200px]"
            title="Viewport File"
            description="Choose which file to render in the viewport"
            searchPlaceholder="Search files..."
            emptyMessage="No files found."
            onSelect={handleFileSelect}
          />
        </div>
      </GraphicsProvider>
    );
  }

  // If the entry file is a directory, show a friendly screen with a file selector
  if (isDirectory) {
    return (
      <GraphicsProvider graphicsRef={graphicsActor}>
        <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
          <FolderOpen className="size-12 stroke-1" />
          <p className="text-sm">The viewer cannot display a directory.</p>
          <FileSelector
            files={files}
            selectedFile={undefined}
            initialPath={entryFile}
            placeholder="Select a file to render..."
            className="h-8 w-[200px]"
            title="Viewport File"
            description="Choose a file to render in the viewport"
            searchPlaceholder="Search files..."
            emptyMessage="No files found."
            onSelect={handleFileSelect}
          />
        </div>
      </GraphicsProvider>
    );
  }

  // If the entry file doesn't exist in the file tree, show a friendly "not found" screen
  if (isMissing) {
    return (
      <GraphicsProvider graphicsRef={graphicsActor}>
        <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
          <FileX className="size-12 stroke-1" />
          <div className="flex flex-col items-center gap-1">
            <p className="text-sm font-medium">File not found</p>
            <p className="max-w-60 truncate text-xs">{entryFile}</p>
          </div>
          <FileSelector
            files={files}
            selectedFile={undefined}
            placeholder="Select a file to render..."
            className="h-8 w-[200px]"
            title="Viewport File"
            description="Choose a file to render in the viewport"
            searchPlaceholder="Search files..."
            emptyMessage="No files found."
            onSelect={handleFileSelect}
          />
        </div>
      </GraphicsProvider>
    );
  }

  return (
    <CadProvider cadRef={cadActor}>
      <GraphicsProvider graphicsRef={graphicsActor}>
        <ViewerContent viewId={viewId} entryFile={entryFile} panelApi={panelApi} containerApi={containerApi} />
      </GraphicsProvider>
    </CadProvider>
  );
});

/**
 * Inner content of a viewer panel with an active file.
 * Separated to avoid conditional hook usage in the parent.
 * CadProvider + GraphicsProvider are wrapped above this -- all descendants use
 * useCad()/useCadSelector() and useGraphics()/useGraphicsSelector().
 */
const ViewerContent = memo(function ({
  viewId,
  entryFile,
  panelApi,
  containerApi,
}: {
  readonly viewId: string;
  readonly entryFile: string;
  readonly panelApi: DockviewPanelApi;
  readonly containerApi: DockviewApi;
}): React.JSX.Element {
  const { editorRef } = useBuild();
  const geometries = useCadSelector((state) => state.context.geometries, []);
  const units = useCadSelector((state) => state.context.units, undefined);

  // Bridge geometry data from the headless CadMachine to the per-view GraphicsMachine
  const graphicsActor = useGraphics();
  const cadActorRef = useCad();
  useEffect(() => {
    if (units) {
      graphicsActor.send({
        type: 'updateGeometries',
        geometries,
        units,
      });
    }
  }, [graphicsActor, geometries, units]);

  // Sync graphics settings back to editor state for persistence
  useViewSettingsSync(viewId, graphicsActor, editorRef, cadActorRef);

  // Restore persisted render timeout to the shared CadMachine on mount
  const persistedViewSettings = useSelector(editorRef, (state) => state.context.viewSettings[viewId]);
  const hasRestoredTimeoutRef = useRef(false);
  useEffect(() => {
    if (hasRestoredTimeoutRef.current) {
      return;
    }

    const savedTimeout = persistedViewSettings?.graphicsSettings.renderTimeout;
    if (savedTimeout !== undefined && cadActorRef) {
      // RenderTimeout in GraphicsViewSettings is in seconds, CadMachine expects milliseconds
      cadActorRef.send({ type: 'setRenderTimeout', timeout: savedTimeout * 1000 });
      hasRestoredTimeoutRef.current = true;
    }
  }, [cadActorRef, persistedViewSettings]);

  // Select individual primitive values so that useSelector's reference equality
  // check works correctly. An object-returning selector creates a new reference
  // on every emission, causing unnecessary re-renders.
  const enableSurfaces = useGraphicsSelector((state) => state.context.enableSurfaces);
  const enableLines = useGraphicsSelector((state) => state.context.enableLines);
  const enableGizmo = useGraphicsSelector((state) => state.context.enableGizmo);
  const enableGrid = useGraphicsSelector((state) => state.context.enableGrid);
  const enableAxes = useGraphicsSelector((state) => state.context.enableAxes);
  const enableMatcap = useGraphicsSelector((state) => state.context.enableMatcap);
  const upDirection = useGraphicsSelector((state) => state.context.upDirection);

  // Shift the gizmo left when this panel's group is at the top-right corner
  // of the dockview grid, so it doesn't overlap with the floating-panel
  // trigger buttons positioned in the center pane.  On mobile the trigger
  // buttons don't exist, so the shift is skipped.
  const isMobile = useIsMobile();
  const isTopRight = useIsTopRightPanel(panelApi, containerApi);
  const shiftGizmo = isTopRight && !isMobile;

  return (
    <div className="group/viewer relative flex h-full flex-col">
      {/* Status overlays */}
      <div className="absolute top-[10%] right-2 left-2 z-10 mx-auto flex w-fit max-w-full flex-col gap-2">
        <ChatInterfaceStatus />
        <ChatViewerStatus />
      </div>

      {/* Gizmo Container */}
      <div
        id={`viewport-gizmo-container-${viewId}`}
        className={cn(
          'absolute top-[calc(var(--header-height)+var(--spacing)*12)] z-10',
          shiftGizmo ? 'right-10' : 'right-0',
        )}
      />

      {/* Geometry canvas */}
      <div className="min-h-0 flex-1">
        <CadViewer
          enableZoom
          enablePan
          enableGizmo={enableGizmo}
          enableGrid={enableGrid}
          enableAxes={enableAxes}
          enableSurfaces={enableSurfaces}
          enableLines={enableLines}
          enableMatcap={enableMatcap}
          upDirection={upDirection}
          geometries={geometries}
          gizmoContainer={`#viewport-gizmo-container-${viewId}`}
        />
      </div>

      {/* Bottom controls */}
      <div className="absolute right-2 bottom-2 left-2 z-10 flex shrink-0 flex-col gap-2">
        <ChatInterfaceGraphics />
        <ChatStackTrace entryFile={entryFile} side="bottom" />
        <ChatViewerControls />
      </div>
    </div>
  );
});
