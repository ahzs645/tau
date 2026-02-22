import { Eye, ArrowRight } from 'lucide-react';
import { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { kernelConfigurations } from '@taucad/types/constants';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';
import { Button } from '#components/ui/button.js';
import { Avatar, AvatarFallback, AvatarImage } from '#components/ui/avatar.js';
import { Card, CardHeader, CardTitle, CardDescription, CardFooter } from '#components/ui/card.js';
import { SvgIcon } from '#components/icons/svg-icon.js';
import { Loader } from '#components/ui/loader.js';
import { useBuildManager } from '#hooks/use-build-manager.js';
import { CadPreviewProvider } from '#hooks/use-cad-preview.js';
import { CadPreviewViewer } from '#components/cad-preview.js';
import type { BuildWithFiles } from '#constants/build-examples.js';

type CommunityBuildCardProperties = BuildWithFiles;

export type CommunityBuildGridProperties = {
  readonly builds: BuildWithFiles[];
  readonly hasMore?: boolean;
  readonly onLoadMore?: () => void;
  readonly limit?: number;
};

export function CommunityBuildGrid({
  builds,
  hasMore,
  onLoadMore,
  limit,
}: CommunityBuildGridProperties): React.JSX.Element {
  const displayedBuilds = limit ? builds.slice(0, limit) : builds;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:gap-6 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {displayedBuilds.map((build) => (
          <ProjectCard key={build.id} {...build} />
        ))}
      </div>

      {hasMore ? (
        <div className="mt-8 text-center">
          <Button variant="outline" onClick={onLoadMore}>
            Load More Projects
          </Button>
        </div>
      ) : null}
    </>
  );
}

function ProjectCard({
  id,
  name,
  description,
  thumbnail,
  author,
  tags,
  assets,
  files,
}: CommunityBuildCardProperties): React.JSX.Element {
  const [showPreview, setShowPreview] = useState(false);
  const [isForking, setIsForking] = useState(false);
  const buildManager = useBuildManager();
  const navigate = useNavigate();

  const kernels = useMemo(() => [], []);

  const mainFile = assets.mechanical?.main ?? 'main.ts';

  const handleFork = useCallback(
    async (event: React.MouseEvent) => {
      event.stopPropagation();

      if (isForking) {
        return;
      }

      setIsForking(true);

      try {
        const createdBuild = await buildManager.createBuild({
          build: {
            name: `${name} (Remixed)`,
            description,
            thumbnail,
            author,
            tags,
            assets,
            forkedFrom: id,
          },
          files,
        });

        await navigate(`/builds/${createdBuild.id}`);
      } catch (error: unknown) {
        console.error('Failed to remix project:', error);
        setIsForking(false);
      }
    },
    [isForking, name, description, thumbnail, author, tags, assets, id, buildManager, files, navigate],
  );

  const handlePreviewToggle = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      setShowPreview(!showPreview);
    },
    [showPreview],
  );

  const handleCardClick = useCallback(() => {
    void navigate(`/builds/${id}/preview`);
  }, [navigate, id]);

  return (
    <Card className="group relative flex flex-col overflow-hidden py-0">
      <div className="flex flex-1 cursor-pointer flex-col" onClick={handleCardClick}>
        <div className="inset-0 aspect-video h-fit w-full overflow-hidden bg-muted group-hover:bg-accent/70 sm:aspect-video">
          {!showPreview && (
            <img src={thumbnail || '/placeholder.svg'} alt={name} className="size-full object-cover" loading="lazy" />
          )}
          {showPreview ? (
            <div className="size-full object-cover">
              <CadPreviewProvider buildId={id} mainFile={mainFile} files={files}>
                <div
                  className="size-full"
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                >
                  <CadPreviewViewer
                    enablePan={false}
                    stageOptions={{ zoomLevel: 1.5 }}
                    graphicsOptions={{ enableLines: false, viewerClassName: 'bg-muted' }}
                  />
                </div>
              </CadPreviewProvider>
            </div>
          ) : null}
          <Button
            variant="overlay"
            size="icon"
            className="absolute top-1 right-1 z-10 size-7 sm:top-2 sm:right-2 sm:size-9"
            onClick={handlePreviewToggle}
          >
            <Eye className={showPreview ? 'size-3.5 text-primary sm:size-4' : 'size-3.5 sm:size-4'} />
          </Button>
        </div>
        <div className="flex flex-1 flex-col sm:pt-4">
          <CardHeader className="max-md:p-2">
            <div className="flex items-center justify-between">
              <CardTitle className="line-clamp-1 text-sm sm:text-base">{name}</CardTitle>
              <div className="hidden flex-wrap gap-1 sm:flex">
                {kernels.map((kernel) => {
                  const kernelConfiguration = kernelConfigurations.find((k) => k.id === kernel);
                  if (!kernelConfiguration) {
                    return null;
                  }

                  const kernelName = kernelConfiguration.name;
                  return (
                    <Tooltip key={kernel}>
                      <TooltipTrigger>
                        <Avatar className="h-5 w-5">
                          <AvatarFallback>
                            <SvgIcon id={kernel} className="size-3" />
                          </AvatarFallback>
                        </Avatar>
                      </TooltipTrigger>
                      <TooltipContent>{kernelName}</TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            </div>
            <CardDescription className="line-clamp-1 text-xs sm:line-clamp-2 sm:text-sm">{description}</CardDescription>
          </CardHeader>
          <CardFooter className="mt-auto flex items-center justify-between gap-1.5 p-2 pt-1 sm:gap-2 sm:p-4 sm:pt-2">
            <div className="hidden items-center gap-2 sm:flex">
              <Avatar className="size-6">
                <AvatarImage src={author.avatar} alt={author.name} />
                <AvatarFallback className="text-xs">{author.name.charAt(0)}</AvatarFallback>
              </Avatar>
              <span className="line-clamp-1 text-sm text-muted-foreground">{author.name}</span>
            </div>
            <div className="flex w-full items-center justify-between gap-1.5 sm:w-auto sm:justify-end sm:gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex h-7 items-center gap-1 px-2 text-xs text-muted-foreground hover:text-primary sm:h-8 sm:px-3 sm:text-sm"
                    disabled={isForking}
                    onClick={handleFork}
                  >
                    <span className="text-xs sm:text-sm">Remix</span>
                    {isForking ? (
                      <Loader className="size-3.5 sm:size-4" />
                    ) : (
                      <ArrowRight className="size-3.5 sm:size-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{isForking ? 'Remixing project...' : 'Remix this project'}</TooltipContent>
              </Tooltip>
            </div>
          </CardFooter>
        </div>
      </div>
    </Card>
  );
}
