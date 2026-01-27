import { useParams, Link } from 'react-router';
import { createContext, useContext, useEffect, useRef } from 'react';
import { useSelector } from '@xstate/react';
import { fromPromise } from 'xstate';
import { Button } from '#components/ui/button.js';
import type { Handle } from '#types/matches.types.js';
import { BuildProvider, useBuild } from '#hooks/use-build.js';
import { FileManagerProvider, useFileManager } from '#hooks/use-file-manager.js';
import type { BuildWithFiles } from '#constants/build-examples.js';
import { sampleBuilds } from '#constants/build-examples.js';
import { useIsMobile } from '#hooks/use-mobile.js';
import { PreviewDesktop } from '#routes/builds_.$id_.preview/preview-desktop.js';
import { PreviewMobile } from '#routes/builds_.$id_.preview/preview-mobile.js';

/**
 * Find a static build by ID from the sample builds
 */
function findStaticBuild(buildId: string): BuildWithFiles | undefined {
  return sampleBuilds.find((build) => build.id === buildId);
}

/**
 * Context to share static build data (including files) for sample builds
 */
const StaticBuildContext = createContext<BuildWithFiles | undefined>(undefined);

/**
 * Hook to access whether the current build is a static build
 */
function useIsStaticBuild(): boolean {
  return useContext(StaticBuildContext) !== undefined;
}

/**
 * Hook to access static build files (for cloning)
 */
function useStaticBuildFiles(): Record<string, { content: Uint8Array<ArrayBuffer> }> | undefined {
  const staticBuild = useContext(StaticBuildContext);
  return staticBuild?.files;
}

/**
 * Provider that handles both static builds (from sampleBuilds) and dynamic builds (from storage).
 * For static builds, it provides the build data directly and writes files to the filesystem.
 * For dynamic builds, it uses the default loadBuildActor from buildManager.
 */
function StaticBuildProvider({
  children,
  buildId,
  staticBuild,
}: {
  readonly children?: React.ReactNode;
  readonly buildId: string;
  readonly staticBuild: BuildWithFiles;
}): React.JSX.Element {
  const { writeFiles } = useFileManager();
  const hasWrittenFilesRef = useRef(false);

  // Write files to filesystem on mount (same pattern as project-grid.tsx and hero-viewer.tsx)
  useEffect(() => {
    async function writeStaticFiles(): Promise<void> {
      if (hasWrittenFilesRef.current) {
        return;
      }

      hasWrittenFilesRef.current = true;
      const buildFiles: Record<string, { content: Uint8Array<ArrayBuffer> }> = {};
      for (const [path, file] of Object.entries(staticBuild.files)) {
        buildFiles[`/builds/${buildId}/${path}`] = file;
      }

      try {
        await writeFiles(buildFiles);
      } catch (error) {
        // Reset flag on failure to allow retry
        hasWrittenFilesRef.current = false;
        console.error('Failed to write static build files:', error);
      }
    }

    void writeStaticFiles();
  }, [buildId, staticBuild.files, writeFiles]);

  return (
    <BuildProvider
      buildId={buildId}
      provide={{
        actors: {
          loadBuildActor: fromPromise(async () => {
            // Return the static build data without the files property
            const { files, ...buildData } = staticBuild;
            return buildData;
          }),
        },
      }}
    >
      {children}
    </BuildProvider>
  );
}

/**
 * Provider for dynamic builds that loads from storage
 */
function DynamicBuildProvider({
  children,
  buildId,
}: {
  readonly children?: React.ReactNode;
  readonly buildId: string;
}): React.JSX.Element {
  return <BuildProvider buildId={buildId}>{children}</BuildProvider>;
}

// Define provider component at module level for stable reference across HMR
function RouteProvider({ children }: { readonly children?: React.ReactNode }): React.JSX.Element {
  const { id } = useParams();
  const staticBuild = findStaticBuild(id!);

  return (
    <StaticBuildContext.Provider value={staticBuild}>
      <FileManagerProvider rootDirectory={`/builds/${id}`}>
        {staticBuild ? (
          <StaticBuildProvider buildId={id!} staticBuild={staticBuild}>
            {children}
          </StaticBuildProvider>
        ) : (
          <DynamicBuildProvider buildId={id!}>{children}</DynamicBuildProvider>
        )}
      </FileManagerProvider>
    </StaticBuildContext.Provider>
  );
}

/**
 * Breadcrumb component that displays the build name as a link
 */
function BuildNameBreadcrumb(): React.JSX.Element {
  const { buildRef, buildId } = useBuild();
  const name = useSelector(buildRef, (state) => state.context.build?.name) ?? 'Build';

  return (
    <Button asChild variant="ghost">
      <Link to={`/builds/${buildId}/preview`}>{name}</Link>
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
  const isStaticBuild = useIsStaticBuild();
  const staticBuildFiles = useStaticBuildFiles();

  if (isMobile) {
    return <PreviewMobile isStaticBuild={isStaticBuild} staticBuildFiles={staticBuildFiles} />;
  }

  return <PreviewDesktop isStaticBuild={isStaticBuild} staticBuildFiles={staticBuildFiles} />;
}

export default function BuildPreview(): React.JSX.Element {
  return <BuildPreviewContent />;
}
