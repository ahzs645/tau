import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router';
import type { Project } from '@taucad/types';
import { Button } from '#components/ui/button.js';
import { Loader } from '#components/ui/loader.js';
import type { Handle } from '#types/matches.types.js';
import { FileManagerProvider, SharedWorkerGate } from '#hooks/use-file-manager.js';
import { CadPreviewProvider } from '#hooks/use-cad-preview.js';
import { useProjectManager } from '#hooks/use-project-manager.js';
import type { ProjectsWithFiles } from '#constants/project-examples.js';
import { sampleProjects } from '#constants/project-examples.js';
import { useIsMobile } from '#hooks/use-mobile.js';
import { PreviewDesktop } from '#routes/projects_.$id_.preview/preview-desktop.js';
import { PreviewMobile } from '#routes/projects_.$id_.preview/preview-mobile.js';
import { PreviewProjectContext, usePreviewProject } from '#routes/projects_.$id_.preview/preview-project-context.js';
import type { PreviewProjectContextValue } from '#routes/projects_.$id_.preview/preview-project-context.js';

function findStaticProject(projectId: string): ProjectsWithFiles | undefined {
  return sampleProjects.find((project) => project.id === projectId);
}

/**
 * Provider for static projects (from sampleProjects). Metadata is available immediately.
 */
function StaticPreviewProvider({
  children,
  projectId,
  staticProject,
}: {
  readonly children?: React.ReactNode;
  readonly projectId: string;
  readonly staticProject: ProjectsWithFiles;
}): React.JSX.Element {
  const { files, ...projectData } = staticProject;
  const mainFile = staticProject.assets.mechanical?.main;

  const noopUpdate = useCallback(() => {
    // Static projects are read-only
  }, []);

  const metadataValue = useMemo<PreviewProjectContextValue>(
    () => ({
      project: projectData,
      isStaticProject: true,
      staticProjectFiles: files,
      updateName: noopUpdate,
      updateDescription: noopUpdate,
    }),
    [projectData, files, noopUpdate],
  );

  return (
    <PreviewProjectContext.Provider value={metadataValue}>
      <CadPreviewProvider projectId={projectId} mainFile={mainFile ?? 'main.ts'} files={files}>
        {children}
      </CadPreviewProvider>
    </PreviewProjectContext.Provider>
  );
}

/**
 * Provider for dynamic projects (from storage). Loads project metadata and defers rendering
 * until the main file is known.
 */
function DynamicPreviewProvider({
  children,
  projectId,
}: {
  readonly children?: React.ReactNode;
  readonly projectId: string;
}): React.JSX.Element {
  const projectManager = useProjectManager();
  const [project, setProject] = useState<Project | undefined>();

  useEffect(() => {
    async function loadProjectMetadata(): Promise<void> {
      const loaded = await projectManager.getProject(projectId);
      setProject(loaded);
    }

    void loadProjectMetadata();
  }, [projectId, projectManager]);

  const updateName = useCallback(
    (name: string) => {
      if (!project) {
        return;
      }

      setProject((previous) => (previous ? { ...previous, name } : previous));
      void projectManager.updateProject(project.id, { ...project, name });
    },
    [project, projectManager],
  );

  const updateDescription = useCallback(
    (description: string) => {
      if (!project) {
        return;
      }

      setProject((previous) => (previous ? { ...previous, description } : previous));
      void projectManager.updateProject(project.id, { ...project, description });
    },
    [project, projectManager],
  );

  const metadataValue = useMemo<PreviewProjectContextValue>(
    () => ({
      project,
      isStaticProject: false,
      staticProjectFiles: undefined,
      updateName,
      updateDescription,
    }),
    [project, updateName, updateDescription],
  );

  const mainFile = project?.assets.mechanical?.main;

  return (
    <PreviewProjectContext.Provider value={metadataValue}>
      {mainFile ? (
        <CadPreviewProvider projectId={projectId} mainFile={mainFile}>
          {children}
        </CadPreviewProvider>
      ) : (
        <div className='flex h-full items-center justify-center'>
          <Loader className='size-16 text-primary' />
        </div>
      )}
    </PreviewProjectContext.Provider>
  );
}

function RouteProvider({ children }: { readonly children?: React.ReactNode }): React.JSX.Element {
  const { id } = useParams();
  const staticProject = findStaticProject(id!);

  return (
    <SharedWorkerGate>
      <FileManagerProvider projectId={id} rootDirectory={`/projects/${id}`}>
        {staticProject ? (
          <StaticPreviewProvider projectId={id!} staticProject={staticProject}>
            {children}
          </StaticPreviewProvider>
        ) : (
          <DynamicPreviewProvider projectId={id!}>{children}</DynamicPreviewProvider>
        )}
      </FileManagerProvider>
    </SharedWorkerGate>
  );
}

function ProjectNameBreadcrumb(): React.JSX.Element {
  const { project } = usePreviewProject();
  const { id } = useParams();
  const name = project?.name ?? 'Project';

  return (
    <Button asChild variant='ghost'>
      <Link to={`/projects/${id}/preview`}>{name}</Link>
    </Button>
  );
}

export const handle: Handle = {
  breadcrumb(match) {
    const { id } = match.params as { id: string };

    return [
      <ProjectNameBreadcrumb key={`${id}-project-name`} />,
      <span key={`${id}-preview`} className='flex h-8 items-center px-3 text-sm font-medium'>
        Preview
      </span>,
    ];
  },
  providers: () => RouteProvider,
};

function ProjectPreviewContent(): React.JSX.Element {
  const isMobile = useIsMobile();

  if (isMobile) {
    return <PreviewMobile />;
  }

  return <PreviewDesktop />;
}

export default function ProjectPreview(): React.JSX.Element {
  return <ProjectPreviewContent />;
}
