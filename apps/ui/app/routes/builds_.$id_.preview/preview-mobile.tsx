import { memo, useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import { useActorRef, useSelector } from '@xstate/react';
import { Code, ChevronDown, Download, FileCode } from 'lucide-react';
import type { ExportFormat } from '@taucad/types';
import { fileExtensionFromExportFormat } from '@taucad/types/constants';
import { Loader } from '#components/ui/loader.js';
import { Button } from '#components/ui/button.js';
import { CadViewer } from '#components/geometry/cad/cad-viewer.js';
import { Tabs, TabsContent } from '#components/ui/tabs.js';
import { Drawer, DrawerContent, DrawerTitle, DrawerDescription } from '#components/ui/drawer.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#components/ui/dropdown-menu.js';
import { downloadBlob } from '#utils/file.utils.js';
import { toast } from '#components/ui/sonner.js';
import { exportGeometryMachine } from '#machines/export-geometry.machine.js';
import { cn } from '#utils/ui.utils.js';
import { useBuild } from '#hooks/use-build.js';
import { useFileManager } from '#hooks/use-file-manager.js';
import { useBuildManager } from '#hooks/use-build-manager.js';
import { useChatManager } from '#hooks/use-chat-manager.js';
import { usePreviewState } from '#routes/builds_.$id_.preview/use-preview-state.js';
import { PreviewNav } from '#routes/builds_.$id_.preview/preview-nav.js';
import { PreviewDetails } from '#routes/builds_.$id_.preview/preview-details.js';
import { PreviewFiles } from '#routes/builds_.$id_.preview/preview-files.js';
import { PreviewParameters } from '#routes/builds_.$id_.preview/preview-parameters.js';

type PreviewMobileProps = {
  readonly isStaticBuild: boolean;
  readonly staticBuildFiles?: Record<string, { content: Uint8Array<ArrayBuffer> }>;
};

export const PreviewMobile = memo(function ({
  isStaticBuild,
  staticBuildFiles,
}: PreviewMobileProps): React.JSX.Element {
  const navigate = useNavigate();
  const { buildRef, cadRef } = useBuild();
  const build = useSelector(buildRef, (state) => state.context.build);
  const geometries = useSelector(cadRef, (state) => state.context.geometries);
  const cadState = useSelector(cadRef, (state) => state.value);
  const fileManager = useFileManager();
  const buildManager = useBuildManager();
  const chatManager = useChatManager();

  const [isCloning, setIsCloning] = useState(false);

  // Get files from file manager
  const files = useSelector(fileManager.fileManagerRef, (state) => {
    const fileTreeMap = state.context.fileTree;
    if (fileTreeMap.size === 0) {
      return [];
    }

    return [...fileTreeMap.values()].map((entry) => ({
      path: entry.path,
      name: entry.name,
      size: entry.size,
    }));
  });

  const { activeTab, drawerOpen, activeSnapPoint, snapPoints, handleTabChange, handleDrawerChange, handleSnapChange } =
    usePreviewState();

  const isModelTab = activeTab === 'model';

  // Create export geometry machine instance
  const exportActorRef = useActorRef(exportGeometryMachine, {
    input: { cadRef },
  });

  const handleExport = useCallback(
    (format: ExportFormat) => {
      const fileExtension = fileExtensionFromExportFormat[format];
      const filename = `${build?.name ?? 'file'}.${fileExtension}`;
      toast.promise(
        new Promise<Blob>((resolve, reject) => {
          exportActorRef.send({
            type: 'requestExport',
            format,
            onSuccess(blob) {
              downloadBlob(blob, filename);
              resolve(blob);
            },
            onError(error) {
              reject(new Error(error));
            },
          });
        }),
        {
          loading: `Downloading ${filename}...`,
          success: `Downloaded ${filename}`,
          error(error) {
            let message = `Failed to download ${filename}`;
            if (error instanceof Error) {
              message = `${message}: ${error.message}`;
            }

            return message;
          },
        },
      );
    },
    [exportActorRef, build?.name],
  );

  const handleDownloadZip = useCallback(async (): Promise<void> => {
    if (!build) {
      return;
    }

    toast.promise(
      async () => {
        const zipBlob = await fileManager.getZippedDirectory(`/builds/${build.id}`);
        return zipBlob;
      },
      {
        loading: 'Creating ZIP archive...',
        success(blob) {
          downloadBlob(blob, `${build.name}.zip`);
          return 'ZIP downloaded successfully';
        },
        error: 'Failed to create ZIP archive',
      },
    );
  }, [build, fileManager]);

  const handleRemix = useCallback(async () => {
    // For dynamic builds, navigate directly
    if (!isStaticBuild || !staticBuildFiles || !build) {
      void navigate(`/builds/${build?.id}`);
      return;
    }

    // For static builds, clone the build first
    if (isCloning) {
      return;
    }

    setIsCloning(true);

    try {
      // Create a new build with remixed data
      const newBuild = {
        name: `${build.name} (Remixed)`,
        description: build.description,
        thumbnail: build.thumbnail,
        author: {
          name: 'You',
          avatar: '/avatar-sample.png',
        },
        tags: build.tags,
        assets: build.assets,
        forkedFrom: build.id,
      };

      // Create the build with the files
      const createdBuild = await buildManager.createBuild(newBuild, staticBuildFiles);

      // Create the chat and get its ID
      const createdChat = await chatManager.createChat(createdBuild.id, {
        name: 'Initial chat',
        messages: [],
      });

      // Update the build with the correct lastChatId
      await buildManager.updateBuild(createdBuild.id, { lastChatId: createdChat.id });

      // Navigate to the new build
      await navigate(`/builds/${createdBuild.id}`);
    } catch (error: unknown) {
      console.error('Failed to remix build:', error);
      toast.error('Failed to remix build');
      setIsCloning(false);
    }
  }, [isStaticBuild, staticBuildFiles, build, isCloning, buildManager, chatManager, navigate]);

  const isLoading = ['buffering', 'rendering', 'booting', 'initializing'].includes(cadState);

  if (!build) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader className="size-16 text-primary" />
      </div>
    );
  }

  return (
    <div className={cn('absolute inset-0 size-full', '[--nav-height:calc(var(--spacing)*10)]', 'md:hidden')}>
      {/* Main viewer - always visible */}
      <div
        className="relative h-full transition-all duration-200 ease-linear"
        style={{
          paddingBottom: isModelTab ? '0' : `calc(${Number(activeSnapPoint) - 0.07} * 100dvh)`,
        }}
      >
        {/* 3D Viewer */}
        <div className="relative h-full">
          {geometries.length > 0 ? (
            <CadViewer geometries={geometries} />
          ) : (
            <div className="flex h-full items-center justify-center">
              <Loader className="size-16 text-primary" />
            </div>
          )}
        </div>

        {/* Status Overlay - positioned below the header */}
        {isLoading ? (
          <div className="absolute top-[calc(var(--header-height)+var(--spacing)*4)] left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-md border bg-background/70 px-3 py-1.5 backdrop-blur-sm">
            <span className="font-mono text-sm text-muted-foreground capitalize">{cadState}...</span>
            <Loader className="size-4" />
          </div>
        ) : null}

        {/* Floating Action Button - Code dropdown, positioned above the nav */}
        <div
          className={cn(
            'absolute right-4 bottom-[calc(var(--nav-height)+var(--spacing)*4)] z-10',
            !isModelTab && 'hidden',
          )}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="default" size="lg" className="shadow-lg rounded-full">
                <Code className="mr-2 size-4" />
                Code
                <ChevronDown className="ml-2 size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={isCloning} onClick={handleRemix}>
                {isCloning ? <Loader className="mr-2 size-4" /> : <FileCode className="mr-2 size-4" />}
                {isCloning ? 'Remixing...' : 'Remix'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleDownloadZip}>
                <Download className="mr-2 size-4" />
                Download ZIP
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <Drawer
        handleOnly
        open={drawerOpen}
        snapPoints={snapPoints}
        activeSnapPoint={activeSnapPoint}
        setActiveSnapPoint={handleSnapChange}
        modal={false}
        onOpenChange={handleDrawerChange}
      >
        <DrawerTitle className="sr-only" id="drawer-title">
          Preview Content
        </DrawerTitle>
        <DrawerDescription className="sr-only" id="drawer-description">
          Preview content - use navigation tabs to switch between panels
        </DrawerDescription>

        {/* Drawer for content panels */}
        <DrawerContent
          aria-labelledby="drawer-title"
          aria-describedby="drawer-description"
          className={cn(
            'flex-1 rounded-t-lg border-t bg-sidebar',
            'z-40',
            'data-[vaul-drawer-direction=bottom]:max-h-[100dvh]',
            'data-[vaul-drawer-direction=bottom]:mt-0',
            '[&_[data-slot=drawer-handle-indicator]]:bg-sidebar-primary/15',
          )}
          style={{
            height: '100%',
          }}
        >
          {/* Tab contents */}
          <Tabs
            value={activeTab}
            className="flex h-full flex-col p-0"
            style={{
              height: isModelTab ? '100dvh' : `calc(${Number(activeSnapPoint)} * 100dvh - var(--spacing)*12)`,
            }}
            onValueChange={handleTabChange}
          >
            <TabsContent enableAnimation={false} value="files" className="flex h-full flex-col overflow-hidden p-4">
              <PreviewFiles files={files} />
            </TabsContent>
            <TabsContent enableAnimation={false} value="parameters" className="flex h-full flex-col overflow-hidden">
              <PreviewParameters />
            </TabsContent>
            <TabsContent enableAnimation={false} value="model" className="flex h-full flex-col" />
            <TabsContent enableAnimation={false} value="details" className="flex h-full flex-col overflow-y-auto">
              <PreviewDetails build={build} geometriesCount={geometries.length} onExport={handleExport} />
            </TabsContent>
          </Tabs>
        </DrawerContent>
      </Drawer>

      {/* Navigation tabs - Always visible and sticky to bottom */}
      <div className={cn('pointer-events-auto fixed right-0 bottom-0 left-0 z-50')}>
        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <PreviewNav className="h-(--nav-height)" />
        </Tabs>
      </div>
    </div>
  );
});
