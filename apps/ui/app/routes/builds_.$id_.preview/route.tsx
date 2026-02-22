import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router';
import type { Build } from '@taucad/types';
import { Button } from '#components/ui/button.js';
import { Loader } from '#components/ui/loader.js';
import type { Handle } from '#types/matches.types.js';
import { FileManagerProvider } from '#hooks/use-file-manager.js';
import { CadPreviewProvider } from '#hooks/use-cad-preview.js';
import { useBuildManager } from '#hooks/use-build-manager.js';
import type { BuildWithFiles } from '#constants/build-examples.js';
import { sampleBuilds } from '#constants/build-examples.js';
import { useIsMobile } from '#hooks/use-mobile.js';
import { PreviewDesktop } from '#routes/builds_.$id_.preview/preview-desktop.js';
import { PreviewMobile } from '#routes/builds_.$id_.preview/preview-mobile.js';
import { PreviewBuildContext, usePreviewBuild } from '#routes/builds_.$id_.preview/preview-build-context.js';
import type { PreviewBuildContextValue } from '#routes/builds_.$id_.preview/preview-build-context.js';

function findStaticBuild(buildId: string): BuildWithFiles | undefined {
  return sampleBuilds.find((build) => build.id === buildId);
}

/**
 * Provider for static builds (from sampleBuilds). Metadata is available immediately.
 */
function StaticPreviewProvider({
  children,
  buildId,
  staticBuild,
}: {
  readonly children?: React.ReactNode;
  readonly buildId: string;
  readonly staticBuild: BuildWithFiles;
}): React.JSX.Element {
  const { files, ...buildData } = staticBuild;
  const mainFile = staticBuild.assets.mechanical?.main;

  const noopUpdate = useCallback(() => {
    // Static builds are read-only
  }, []);

  const metadataValue = useMemo<PreviewBuildContextValue>(
    () => ({
      build: buildData,
      isStaticBuild: true,
      staticBuildFiles: files,
      updateName: noopUpdate,
      updateDescription: noopUpdate,
    }),
    [buildData, files, noopUpdate],
  );

  return (
    <PreviewBuildContext.Provider value={metadataValue}>
      <CadPreviewProvider buildId={buildId} mainFile={mainFile ?? 'main.ts'} files={files}>
        {children}
      </CadPreviewProvider>
    </PreviewBuildContext.Provider>
  );
}

/**
 * Provider for dynamic builds (from storage). Loads build metadata and defers rendering
 * until the main file is known.
 */
function DynamicPreviewProvider({
  children,
  buildId,
}: {
  readonly children?: React.ReactNode;
  readonly buildId: string;
}): React.JSX.Element {
  const buildManager = useBuildManager();
  const [build, setBuild] = useState<Build | undefined>();

  useEffect(() => {
    async function loadBuildMetadata(): Promise<void> {
      const loaded = await buildManager.getBuild(buildId);
      setBuild(loaded);
    }

    void loadBuildMetadata();
  }, [buildId, buildManager]);

  const updateName = useCallback(
    (name: string) => {
      if (!build) {
        return;
      }

      setBuild((previous) => (previous ? { ...previous, name } : previous));
      void buildManager.updateBuild(build.id, { ...build, name });
    },
    [build, buildManager],
  );

  const updateDescription = useCallback(
    (description: string) => {
      if (!build) {
        return;
      }

      setBuild((previous) => (previous ? { ...previous, description } : previous));
      void buildManager.updateBuild(build.id, { ...build, description });
    },
    [build, buildManager],
  );

  const metadataValue = useMemo<PreviewBuildContextValue>(
    () => ({
      build,
      isStaticBuild: false,
      staticBuildFiles: undefined,
      updateName,
      updateDescription,
    }),
    [build, updateName, updateDescription],
  );

  const mainFile = build?.assets.mechanical?.main;

  return (
    <PreviewBuildContext.Provider value={metadataValue}>
      {mainFile ? (
        <CadPreviewProvider buildId={buildId} mainFile={mainFile}>
          {children}
        </CadPreviewProvider>
      ) : (
        <div className="flex h-full items-center justify-center">
          <Loader className="size-16 text-primary" />
        </div>
      )}
    </PreviewBuildContext.Provider>
  );
}

function RouteProvider({ children }: { readonly children?: React.ReactNode }): React.JSX.Element {
  const { id } = useParams();
  const staticBuild = findStaticBuild(id!);

  return (
    <FileManagerProvider buildId={id} rootDirectory={`/builds/${id}`}>
      {staticBuild ? (
        <StaticPreviewProvider buildId={id!} staticBuild={staticBuild}>
          {children}
        </StaticPreviewProvider>
      ) : (
        <DynamicPreviewProvider buildId={id!}>{children}</DynamicPreviewProvider>
      )}
    </FileManagerProvider>
  );
}

function BuildNameBreadcrumb(): React.JSX.Element {
  const { build } = usePreviewBuild();
  const { id } = useParams();
  const name = build?.name ?? 'Build';

  return (
    <Button asChild variant="ghost">
      <Link to={`/builds/${id}/preview`}>{name}</Link>
    </Button>
  );
}

export const handle: Handle = {
  breadcrumb(match) {
    const { id } = match.params as { id: string };

    return [
      <BuildNameBreadcrumb key={`${id}-build-name`} />,
      <span key={`${id}-preview`} className="flex h-8 items-center px-3 text-sm font-medium">
        Preview
      </span>,
    ];
  },
  providers: () => RouteProvider,
};

function BuildPreviewContent(): React.JSX.Element {
  const isMobile = useIsMobile();

  if (isMobile) {
    return <PreviewMobile />;
  }

  return <PreviewDesktop />;
}

export default function BuildPreview(): React.JSX.Element {
  return <BuildPreviewContent />;
}
