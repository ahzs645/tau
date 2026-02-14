import { memo, useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useActorRef, useSelector } from '@xstate/react';
import { Download, FileCode, Eye, Code, ChevronDown, SlidersHorizontal } from 'lucide-react';
import type { ExportFormat } from '@taucad/types';
import { fileExtensionFromExportFormat } from '@taucad/types/constants';
import { Loader } from '#components/ui/loader.js';
import { Button } from '#components/ui/button.js';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '#components/ui/tabs.js';
import { CadViewer } from '#components/geometry/cad/cad-viewer.js';
import { Avatar, AvatarImage, AvatarFallback } from '#components/ui/avatar.js';
import { Separator } from '#components/ui/separator.js';
import { BuildSettingsDialog } from '#routes/builds_.$id_.preview/build-settings-dialog.js';
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
import { GraphicsProvider } from '#hooks/use-graphics.js';
import { useFileManager } from '#hooks/use-file-manager.js';
import { useBuildManager } from '#hooks/use-build-manager.js';
import { PreviewDetails } from '#routes/builds_.$id_.preview/preview-details.js';
import { PreviewFiles } from '#routes/builds_.$id_.preview/preview-files.js';
import { PreviewParameters } from '#routes/builds_.$id_.preview/preview-parameters.js';

type PreviewDesktopProps = {
  readonly isStaticBuild: boolean;
  readonly staticBuildFiles?: Record<string, { content: Uint8Array<ArrayBuffer> }>;
};

function ViewerStatus({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactNode {
  const { compilationUnits, mainEntryFile } = useBuild();
  const cadActor = compilationUnits.get(mainEntryFile);
  const state = useSelector(cadActor, (snapshot) => snapshot?.value);

  return state && ['buffering', 'rendering', 'booting', 'initializing'].includes(state) ? (
    <div
      {...props}
      className={cn(
        'absolute top-4 right-4 z-10 flex items-center gap-2 rounded-md border bg-background/70 px-2 py-1 backdrop-blur-sm',
        className,
      )}
    >
      <span className="font-mono text-sm text-muted-foreground capitalize">{state}...</span>
      <Loader className="size-4" />
    </div>
  ) : null;
}

export const PreviewDesktop = memo(function ({
  isStaticBuild,
  staticBuildFiles,
}: PreviewDesktopProps): React.JSX.Element {
  const navigate = useNavigate();
  const { id } = useParams();
  const { buildRef, compilationUnits, mainEntryFile, viewGraphics } = useBuild();
  const cadActor = compilationUnits.get(mainEntryFile);
  const build = useSelector(buildRef, (state) => state.context.build);
  const geometries = useSelector(cadActor, (snapshot) => snapshot?.context.geometries ?? []);
  const hasParameters = useSelector(cadActor, (snapshot) => Boolean(snapshot?.context.jsonSchema));
  const fileManager = useFileManager();
  const buildManager = useBuildManager();

  const previewViewId = 'preview-main';

  useEffect(() => {
    buildRef.send({ type: 'createViewGraphics', viewId: previewViewId });
    return () => {
      buildRef.send({ type: 'destroyViewGraphics', viewId: previewViewId });
    };
  }, [buildRef]);

  const graphicsRef = viewGraphics.get(previewViewId);

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

  const [activeTab, setActiveTab] = useState('3d');
  const [showParameters, setShowParameters] = useState(true);

  // Create export geometry machine instance
  const exportActorRef = useActorRef(exportGeometryMachine, {
    input: { cadRef: cadActor },
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

  const handleEditOnline = useCallback(async () => {
    // For dynamic builds, navigate directly
    if (!isStaticBuild || !staticBuildFiles || !build) {
      void navigate(`/builds/${id}`);
      return;
    }

    // For static builds, clone the build first
    if (isCloning) {
      return;
    }

    setIsCloning(true);

    try {
      const createdBuild = await buildManager.createBuild({
        build: {
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
        },
        files: staticBuildFiles,
      });

      // Navigate to the new build
      await navigate(`/builds/${createdBuild.id}`);
    } catch (error: unknown) {
      console.error('Failed to remix build:', error);
      toast.error('Failed to remix build');
      setIsCloning(false);
    }
  }, [isStaticBuild, staticBuildFiles, build, isCloning, id, buildManager, navigate]);

  const toggleParameters = useCallback(() => {
    setShowParameters((previous) => !previous);
  }, []);

  if (!build) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">Loading build...</p>
      </div>
    );
  }

  return (
    <div className="-ml-2 hidden h-full flex-col md:flex">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-4">
          <Avatar className="size-10">
            <AvatarImage src={build.author.avatar} alt={build.author.name} />
            <AvatarFallback>{build.author.name[0]?.toUpperCase()}</AvatarFallback>
          </Avatar>
          <div>
            <h1 className="text-xl font-semibold">
              {build.author.name} / {build.name}
            </h1>
            <p className="text-sm text-muted-foreground">{build.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="default">
                <Code className="mr-2 size-4" />
                Code
                <ChevronDown className="ml-2 size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={isCloning} onClick={handleEditOnline}>
                {isCloning ? <Loader /> : <FileCode />}
                {isCloning ? 'Remixing...' : 'Remix'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleDownloadZip}>
                <Download />
                Download ZIP
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {isStaticBuild ? null : <BuildSettingsDialog />}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <Tabs value={activeTab} className="flex flex-1 flex-col gap-0 overflow-hidden" onValueChange={setActiveTab}>
          <div className="flex items-center justify-between border-b px-6">
            <TabsList
              className="border-none bg-transparent p-0 [&_[data-slot='tabs-trigger']]:min-h-8"
              activeClassName="shadow-none border-b-2 rounded-none border-b-primary"
            >
              <TabsTrigger value="files">
                <FileCode className="mr-2 size-4" />
                Files
              </TabsTrigger>
              <TabsTrigger value="3d">
                <Eye className="mr-2 size-4" />
                3D View
              </TabsTrigger>
            </TabsList>
            {activeTab === '3d' && hasParameters ? (
              <Button
                variant="ghost"
                size="sm"
                className={cn('gap-2', showParameters && 'text-primary')}
                onClick={toggleParameters}
              >
                <SlidersHorizontal className="size-4" />
                Parameters
              </Button>
            ) : null}
          </div>

          <div className="flex flex-1 overflow-hidden">
            {/* Main Content */}
            <div className="flex-1 overflow-hidden">
              <TabsContent
                enableAnimation={false}
                value="files"
                className="h-full overflow-auto p-6 data-[state=inactive]:hidden"
              >
                <PreviewFiles files={files} />
              </TabsContent>

              <TabsContent enableAnimation={false} value="3d" className="h-full data-[state=inactive]:hidden">
                <div className="flex h-full">
                  {/* 3D Viewer - min-w-0 is required for proper flex shrinking when Canvas is present */}
                  <div className="relative min-w-0 flex-1">
                    <ViewerStatus />
                    {geometries.length > 0 && graphicsRef ? (
                      <GraphicsProvider graphicsRef={graphicsRef}>
                        <CadViewer enableZoom enablePan geometries={geometries} />
                      </GraphicsProvider>
                    ) : (
                      <div className="flex h-full items-center justify-center">
                        <Loader className="size-16 text-primary" />
                      </div>
                    )}
                  </div>
                  {/* Parameters Panel */}
                  {hasParameters && showParameters ? (
                    <div className="h-full w-80 border-l bg-background">
                      <PreviewParameters />
                    </div>
                  ) : null}
                </div>
              </TabsContent>
            </div>

            {/* Sidebar - About Section */}
            <div className="w-80 border-l bg-sidebar">
              <PreviewDetails build={build} geometriesCount={geometries.length} onExport={handleExport} />
              <Separator />
              {/* Git Integration - disabled until Git integration is implemented */}
              <div className="hidden p-6">
                <h3 className="mb-3 text-sm font-semibold">Version Control</h3>
                {/* GitConnector would go here */}
              </div>
            </div>
          </div>
        </Tabs>
      </div>
    </div>
  );
});
