import { memo, useCallback, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Download, FileCode, Eye, Code, ChevronDown, SlidersHorizontal } from 'lucide-react';
import { Loader } from '#components/ui/loader.js';
import { Button } from '#components/ui/button.js';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '#components/ui/tabs.js';
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
import { cn } from '#utils/ui.utils.js';
import { useFileManager } from '#hooks/use-file-manager.js';
import { useBuildManager } from '#hooks/use-build-manager.js';
import { useCadPreview } from '#hooks/use-cad-preview.js';
import { useCadExport } from '#hooks/use-cad-export.js';
import { CadPreviewViewer, CadPreviewStatus } from '#components/cad-preview.js';
import { usePreviewBuild } from '#routes/builds_.$id_.preview/preview-build-context.js';
import { PreviewDetails } from '#routes/builds_.$id_.preview/preview-details.js';
import { PreviewFiles } from '#routes/builds_.$id_.preview/preview-files.js';
import { PreviewParameters } from '#routes/builds_.$id_.preview/preview-parameters.js';
import { usePreviewFileList } from '#routes/builds_.$id_.preview/use-preview-file-list.js';

export const PreviewDesktop = memo(function (): React.JSX.Element {
  const navigate = useNavigate();
  const { id } = useParams();
  const { build, isStaticBuild, staticBuildFiles } = usePreviewBuild();
  const { geometries, jsonSchema } = useCadPreview();
  const { exportGeometry } = useCadExport(build?.name ?? 'file');
  const fileManager = useFileManager();
  const buildManager = useBuildManager();
  const files = usePreviewFileList();

  const hasParameters = Boolean(jsonSchema);

  const [isCloning, setIsCloning] = useState(false);
  const [activeTab, setActiveTab] = useState('3d');
  const [showParameters, setShowParameters] = useState(true);

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
    if (!isStaticBuild || !staticBuildFiles || !build) {
      void navigate(`/builds/${id}`);
      return;
    }

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
                  {/* 3D Viewer */}
                  <div className="relative min-w-0 flex-1">
                    <CadPreviewStatus />
                    <CadPreviewViewer enableZoom enablePan className="h-full" />
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
              <PreviewDetails build={build} geometriesCount={geometries.length} onExport={exportGeometry} />
              <Separator />
              <div className="hidden p-6">
                <h3 className="mb-3 text-sm font-semibold">Version Control</h3>
              </div>
            </div>
          </div>
        </Tabs>
      </div>
    </div>
  );
});
