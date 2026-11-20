import { Component, lazy, Suspense, useEffect, useMemo } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { KeyboardProvider } from '@taucad/ui/components/keyboard';
import { TooltipProvider } from '@taucad/ui/components/tooltip';
import { Heading } from '@taucad/ui/components/heading';
import { Button } from '@taucad/ui/components/button';
import { Skeleton } from '@taucad/ui/components/skeleton';
import { getProject, listPublicProjects } from '#catalog/catalog.js';
import { readGalleryLocation, useGalleryHref } from '#sharing/location.js';
import { GalleryList } from '#components/gallery-list.jsx';
import { GalleryThemeProvider } from '#components/theme.jsx';

const ProjectPage = lazy(async () => {
  const module = await import('#components/project-page.jsx');
  return { default: module.ProjectPage };
});

class GalleryErrorBoundary extends Component<{ readonly children: ReactNode }, { readonly error?: Error }> {
  public static getDerivedStateFromError(error: Error): { readonly error: Error } {
    return { error };
  }
  public override state: { readonly error?: Error } = {};
  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Gallery interface failed', error, info.componentStack);
  }
  public override render(): ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }
    return (
      <main className='mx-auto flex max-w-lg flex-col gap-4 p-6'>
        <Heading level={1} variant='title'>
          The gallery could not open this view
        </Heading>
        <p className='text-sm'>Reload the page to try again, or return to the gallery.</p>
        <details className='text-xs text-muted-foreground'>
          <summary>Error details</summary>
          <pre className='overflow-auto whitespace-pre-wrap'>{this.state.error.message}</pre>
        </details>
        <div className='flex gap-2'>
          <Button
            onClick={() => {
              globalThis.location.reload();
            }}
          >
            Reload
          </Button>
          <Button asChild variant='outline'>
            <a href='/'>Open gallery</a>
          </Button>
        </div>
      </main>
    );
  }
}

const GalleryRouter = (): React.JSX.Element => {
  const href = useGalleryHref();
  const route = useMemo(() => readGalleryLocation(new URL(href)), [href]);
  useEffect(() => {
    document.title = route.modelId
      ? `${getProject(route.modelId)?.title ?? 'Model not found'} · 3D gallery`
      : '3D gallery';
  }, [route.modelId]);
  if (route.isGallery) {
    return <GalleryList />;
  }
  const project = route.modelId
    ? getProject(route.modelId)
    : (listPublicProjects().find((item) => item.id === 'polygon-vase') ?? listPublicProjects()[0]);
  if (!project) {
    return (
      <main className='mx-auto flex max-w-lg flex-col gap-4 p-6'>
        <Heading level={1} variant='title'>
          Model not found
        </Heading>
        <p className='text-sm'>This link does not match a published model.</p>
        <Button asChild>
          <a href='/'>Open gallery</a>
        </Button>
      </main>
    );
  }
  return (
    <Suspense
      fallback={
        <main role='status' aria-label='Opening model' aria-busy='true' className='flex h-dvh flex-col gap-4 p-4'>
          <Skeleton aria-hidden className='h-20 w-full' />
          <Skeleton aria-hidden className='min-h-0 w-full flex-1' />
        </main>
      }
    >
      <ProjectPage key={project.id} project={project} route={route} href={href} />
    </Suspense>
  );
};

export const App = (): React.JSX.Element => (
  <GalleryErrorBoundary>
    <GalleryThemeProvider>
      <KeyboardProvider>
        <TooltipProvider>
          <GalleryRouter />
        </TooltipProvider>
      </KeyboardProvider>
    </GalleryThemeProvider>
  </GalleryErrorBoundary>
);
